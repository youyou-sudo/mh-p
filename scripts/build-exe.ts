/**
 * 打包单文件可执行（bun build --compile），并把对应平台的 Mihomo 一起嵌进去。
 *
 * 流程：
 *   1. 解析目标平台（--target=bun-windows-x64 / bun-linux-x64 / bun-linux-arm64 / bun-darwin-arm64 …，
 *      省略时用当前构建机）；
 *   2. 构建 Furin 前端并嵌入控制面（--skip-web 可跳过）；
 *   3. 从 MetaCubeX/mihomo 下载该平台发行包（默认 v1.19.33，--mihomo-version 可换）：
 *      windows 是 zip（包内 mihomo-windows-amd64.exe），linux/darwin 是**裸 gzip**（解压即二进制）；
 *      校验用的 SHA256 来自 GitHub Release API 的 asset.digest 字段（Mihomo 不发布 .dgst），
 *      取不到元数据时降级为「只记录压缩包哈希」并显式警告；
 *   4. 生成 apps/server/src/mihomo/embedded.generated.ts（`with { type: "file" }`）；
 *   5. `bun build --compile` 打单文件；最后把生成文件恢复为占位版本（源码运行无内嵌二进制）。
 *
 * 运行时 apps/server/src/mihomo/embedded.ts 会把内嵌的 mihomo 解出到 DATA_DIR/bin，
 * 校验 SHA256 后再交给 MihomoProcess 执行。
 *
 * 用法：
 *   bun run build:exe                                    # 当前平台
 *   bun run build:exe -- --target=bun-linux-x64          # 交叉编译
 *   bun run build:exe -- --mihomo-version=v1.19.33 --mirror=https://ghfast.top/
 *   MIHOMO_DOWNLOAD_MIRROR=https://ghfast.top/ bun run build:exe
 *   bun run build:exe -- --fetch-only                    # 只下载/解出 Mihomo，不编译
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  DEFAULT_MIHOMO_VERSION,
  extractBinaryFromArchive,
  mihomoReleaseAsset,
  parseBuilderTarget,
  parseReleaseDigests,
  versionBody,
  type MihomoBuildTarget,
} from '../apps/server/src/mihomo/release'

const root = resolve(import.meta.dir, '..')
const generatedPath = join(root, 'apps', 'server', 'src', 'mihomo', 'embedded.generated.ts')

// ------------------------------------------------------------------ 参数
const argv = process.argv.slice(2)

function arg(name: string): string | undefined {
  const prefix = '--' + name + '='
  const inline = argv.find((a) => a.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const i = argv.indexOf('--' + name)
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1]
  return undefined
}

function flag(name: string): boolean {
  return argv.includes('--' + name)
}

function positionalTarget(): string | undefined {
  const withValue = new Set(['--mihomo-version', '--mirror', '--outfile', '--target'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      if (withValue.has(a)) i++
      continue
    }
    return a
  }
  return undefined
}

const targetArg = arg('target') ?? process.env.MHP_BUILD_TARGET ?? positionalTarget()
const mihomoVersion = arg('mihomo-version') ?? process.env.MIHOMO_VERSION ?? DEFAULT_MIHOMO_VERSION
const mirror = arg('mirror') ?? process.env.MIHOMO_DOWNLOAD_MIRROR
const offline = flag('offline')
const skipWeb = flag('skip-web')
const fetchOnly = flag('fetch-only')
/** 跳过「官方摘要」校验（离线/API 不可用时仍能产出，但会在日志里大声警告） */
const noDigest = flag('no-digest')

// ------------------------------------------------------------------ 工具
function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

function log(msg: string): void {
  console.log('[build] ' + msg)
}

async function run(cmd: string[], cwd = root): Promise<void> {
  log('$ ' + cmd.join(' '))
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' })
  const code = await proc.exited
  if (code !== 0) throw new Error('命令失败（exit ' + code + '）：' + cmd.join(' '))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 镜像前缀：https://ghfast.top/ 或模板 https://mirror/{url}。 */
function mirrorUrl(githubUrl: string): string {
  if (!mirror) return githubUrl
  return mirror.includes('{url}')
    ? mirror.replace('{url}', githubUrl)
    : mirror.replace(/\/+$/, '') + '/' + githubUrl
}

async function fetchOk(url: string, label: string, attempts = 3): Promise<Response> {
  let last: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(300_000),
        headers: { 'user-agent': 'mh-p-build', accept: 'application/vnd.github+json, */*' },
      })
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
      return res
    } catch (e) {
      last = e
      if (i < attempts) {
        console.warn('[build] ' + label + ' 获取失败（第 ' + i + '/' + attempts + ' 次）：' + (e instanceof Error ? e.message : String(e)))
        await sleep(1000 * i)
      }
    }
  }
  throw new Error(label + ' 获取失败：' + (last instanceof Error ? last.message : String(last)))
}

function releaseBase(): string {
  return 'https://github.com/MetaCubeX/mihomo/releases/download/' + mihomoVersion + '/'
}

/**
 * 取本版本的「资产名 → sha256」。
 *
 * Mihomo **不发布 .dgst**（Xray 才有），官方摘要只在 GitHub Release API 里：
 * 每个 asset 带 `digest: "sha256:<hex>"`（v1.19.33 实测每个资产都有）。API 不可达
 * （离线/限流/内网）时返回空表，由调用方降级处理。元数据缓存到 .cache 里，离线可复用。
 */
async function releaseDigests(cacheDir: string): Promise<Record<string, string>> {
  mkdirSync(cacheDir, { recursive: true })
  const metaPath = join(cacheDir, 'release.json')
  let text: string | null = existsSync(metaPath) ? readFileSync(metaPath, 'utf8') : null
  if (!text && !offline) {
    try {
      const url = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/' + mihomoVersion
      const headers: Record<string, string> = { 'user-agent': 'mh-p-build', accept: 'application/vnd.github+json' }
      const token = process.env.GITHUB_TOKEN
      if (token) headers.authorization = 'Bearer ' + token
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText)
      text = await res.text()
      writeFileSync(metaPath, text)
    } catch (e) {
      console.warn('[build] 未能取到 release 元数据（官方 sha256 不可用）：' + (e instanceof Error ? e.message : String(e)))
      return {}
    }
  }
  if (!text) return {}
  try {
    return parseReleaseDigests(JSON.parse(text))
  } catch {
    console.warn('[build] release.json 解析失败，忽略官方摘要')
    return {}
  }
}

/** 下载（或复用缓存）发行包，并用官方 sha256 校验；返回压缩包字节与解出二进制。 */
async function ensureArchive(
  assetName: string,
  expected: string | null,
  cacheDir: string,
): Promise<Uint8Array> {
  const path = join(cacheDir, assetName)
  mkdirSync(cacheDir, { recursive: true })

  let bytes: Uint8Array | null = existsSync(path) ? new Uint8Array(readFileSync(path)) : null
  if (bytes && expected && sha256Hex(bytes) !== expected) {
    console.warn('[build] 缓存压缩包校验失败，重新下载：' + path)
    bytes = null
  }
  if (!bytes) {
    if (offline) throw new Error('离线模式下缺少缓存：' + path)
    const url = mirrorUrl(releaseBase() + assetName)
    log('下载 ' + assetName + ' ← ' + url)
    const res = await fetchOk(url, assetName)
    bytes = new Uint8Array(await res.arrayBuffer())
    const actual = sha256Hex(bytes)
    if (expected && actual !== expected) {
      throw new Error('Mihomo 发行包 SHA256 校验失败：' + actual + ' != ' + expected)
    }
    writeFileSync(path + '.part', bytes)
    renameSync(path + '.part', path)
    log('已缓存 ' + path + '（' + mb(bytes.byteLength) + '）')
  } else {
    log('使用缓存 ' + path + '（' + mb(bytes.byteLength) + '）')
  }

  if (expected) log('官方 SHA256 校验通过：' + expected)
  else log('⚠ 无官方摘要可比对，本次只记录解出二进制的 sha256（运行时按记录值校验）')
  return bytes
}

/** 解出引擎二进制并缓存到 .cache/mihomo/<version>/<asset 基名>/mihomo[.exe]。 */
function extractBinary(
  archive: Uint8Array,
  asset: { assetName: string; archive: 'zip' | 'gz'; binaryName: 'mihomo' | 'mihomo.exe' },
  cacheDir: string,
): { path: string; bytes: Uint8Array } {
  const data = extractBinaryFromArchive(archive, asset.archive)
  if (data.byteLength < 1024 * 1024) {
    throw new Error('解出的 ' + asset.binaryName + ' 只有 ' + data.byteLength + ' 字节，疑似损坏')
  }
  const dir = join(cacheDir, asset.assetName.replace(/\.(zip|gz)$/, ''))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, asset.binaryName)
  writeFileSync(path, data)
  if (process.platform !== 'win32') chmodSync(path, 0o755)
  return { path, bytes: data }
}

/** 生成 embedded.generated.ts 的临时内容（编译后由调用方恢复占位版本）。 */
function generatedModule(info: {
  path: string
  version: string
  platform: string
  arch: string
  filename: string
  sha256: string
  size: number
}): string {
  let rel = relative(dirname(generatedPath), info.path).split(sep).join('/')
  if (!rel.startsWith('.')) rel = './' + rel
  return [
    '// @ts-nocheck',
    '// 由 scripts/build-exe.ts 于 ' + new Date().toISOString() + ' 生成；编译结束后会恢复占位版本，请勿提交。',
    'import mihomoBinary from ' + JSON.stringify(rel) + ' with { type: "file" }',
    '',
    'export interface EmbeddedMihomoInfo {',
    '  file: string',
    '  version: string',
    "  platform: 'win32' | 'linux' | 'darwin'",
    "  arch: 'x64' | 'arm64' | 'arm'",
    "  filename: 'mihomo' | 'mihomo.exe'",
    '  sha256: string',
    '  size: number',
    '}',
    '',
    'export const EMBEDDED_MIHOMO: EmbeddedMihomoInfo = {',
    '  file: mihomoBinary as unknown as string,',
    '  version: ' + JSON.stringify(info.version) + ',',
    '  platform: ' + JSON.stringify(info.platform) + ' as EmbeddedMihomoInfo["platform"],',
    '  arch: ' + JSON.stringify(info.arch) + ' as EmbeddedMihomoInfo["arch"],',
    '  filename: ' + JSON.stringify(info.filename) + ' as EmbeddedMihomoInfo["filename"],',
    '  sha256: ' + JSON.stringify(info.sha256) + ',',
    '  size: ' + String(info.size) + ',',
    '}',
    '',
  ].join('\n')
}

function outputBase(target: MihomoBuildTarget): string {
  const explicit = arg('outfile')
  if (explicit) return explicit
  if (target.native) return 'dist/mh-p'
  const os = target.platform === 'win32' ? 'windows' : target.platform
  return 'dist/mh-p-' + os + '-' + target.arch
}

function statOutput(outBase: string): string | null {
  const abs = resolve(root, outBase)
  for (const candidate of [abs, abs + '.exe']) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

// ------------------------------------------------------------------ 主流程
async function main(): Promise<void> {
  const target = parseBuilderTarget(targetArg)
  log(
    '目标平台：' + target.platform + '/' + target.arch +
      (target.native ? '（当前构建机）' : '（交叉编译 ' + target.bunTarget + '）') +
      ' · Mihomo ' + mihomoVersion,
  )
  const asset = mihomoReleaseAsset(target, mihomoVersion)
  const cacheDir = join(root, '.cache', 'mihomo', versionBody(mihomoVersion))

  if (!skipWeb && !fetchOnly) {
    log('构建前端并嵌入控制面')
    await run(['bun', 'run', 'web:build'])
  }

  const digests = noDigest ? {} : await releaseDigests(cacheDir)
  const expected = digests[asset.assetName] ?? null
  if (!noDigest && !expected) {
    console.warn('[build] ⚠ release 元数据里没有 ' + asset.assetName + ' 的 sha256，本次不做官方摘要校验')
  }

  const archive = await ensureArchive(asset.assetName, expected, cacheDir)
  const binary = extractBinary(archive, asset, cacheDir)
  const sha256 = sha256Hex(binary.bytes)
  log('Mihomo 二进制：' + binary.path + '（' + mb(binary.bytes.byteLength) + '，sha256=' + sha256.slice(0, 12) + '…）')

  if (fetchOnly) {
    log('--fetch-only：跳过编译')
    return
  }

  const stub = readFileSync(generatedPath, 'utf8')
  const module_ = generatedModule({
    path: binary.path,
    version: mihomoVersion,
    platform: target.platform,
    arch: target.arch,
    filename: asset.binaryName,
    sha256,
    size: binary.bytes.byteLength,
  })
  writeFileSync(generatedPath, module_)
  try {
    const outBase = outputBase(target)
    mkdirSync(dirname(resolve(root, outBase)), { recursive: true })
    await run([
      'bun',
      'build',
      '--compile',
      '--minify',
      '--target=' + target.bunTarget,
      '--outfile',
      outBase,
      join('apps', 'server', 'src', 'index.ts'),
    ])
    const out = statOutput(outBase)
    if (!out) throw new Error('编译结束但未找到产物：' + outBase)
    log('完成：' + out + '（' + mb(statSync(out).size) + '，含内嵌 Mihomo ' + mihomoVersion + '）')
  } finally {
    writeFileSync(generatedPath, stub)
    log('已恢复 embedded.generated.ts 占位版本')
  }
}

await main().catch((e) => {
  console.error('[build] 失败：' + (e instanceof Error ? (e.stack ?? e.message) : String(e)))
  process.exit(1)
})

// I have nothing but my burger and I want nothing more
