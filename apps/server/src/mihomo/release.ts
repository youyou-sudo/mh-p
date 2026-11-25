/**
 * Mihomo 发行包与 Bun 交叉编译目标的映射工具。
 *
 * 与 Xray 版（apps/server/src/xray/release.ts）的关系：**同一职责的整体替换**，但资产约定
 * 完全不同——这些差异是实测出来的，不是照抄改名，改之前请先读下面每一行注释：
 *
 * 1. 资产名带平台/架构，且**每个平台的后缀不同**（实测 v1.19.33 的 release 资产列表）：
 *      win32     → mihomo-windows-amd64-v1.19.33.zip        （包内文件名是 mihomo-windows-amd64.exe）
 *      linux     → mihomo-linux-amd64-v1.19.33.gz           （**裸 gzip**，不是 tar.gz；解压即二进制）
 *      darwin    → mihomo-darwin-amd64-v1.19.33.gz
 *    同一平台还有 -compatible / -v1 / -v2 / -v3 / -go120 / -go123 变体与 .deb/.rpm/.pkg.tar.zst，
 *    本模块只取**默认**资产（名字正好是 `mihomo-<os>-<arch>-v<ver>.<ext>` 的那个）。
 *
 * 2. Mihomo **不发布 .dgst 文件**（Xray 有），所以没有可下载的摘要文本。实测可用的替代：
 *    GitHub Release API 的每个 asset 都带 `digest: "sha256:<hex>"` 字段（v1.19.33 实测每个
 *    资产都有，且与下载到的文件逐字节一致）。因此校验策略是：
 *      · 构建期：读 release 元数据拿官方 sha256 → 校验压缩包 → 再把**解出二进制**的 sha256
 *        记进 apps/server/src/mihomo/embedded.generated.ts；
 *      · 运行期：解内嵌二进制时比对该记录值（apps/server/src/mihomo/embedded.ts）。
 *    拿不到元数据（离线/API 限流）时退回为「只记录 zip 的 sha256」，并在构建日志里显式警告。
 *
 * 3. linux/arm（32 位）对应的是 `armv7` 资产；win32/arm 没有发行包，构造时直接抛错。
 */
import { gunzipSync, inflateRawSync } from 'node:zlib'

/** 默认内嵌的 Mihomo 发行版本；可用 --mihomo-version / MIHOMO_VERSION 覆盖。 */
export const DEFAULT_MIHOMO_VERSION = 'v1.19.33'

/** Mihomo 官方发行包覆盖的平台（与 Bun --compile 的可用目标取交集）。 */
export type MihomoPlatform = 'win32' | 'linux' | 'darwin'
export type MihomoArch = 'x64' | 'arm64' | 'arm'

/** 压缩包形态：zip（windows）或裸 gzip（linux/darwin）。 */
export type MihomoArchiveKind = 'zip' | 'gz'

export interface MihomoBuildTarget {
  /** 传给 `bun build --compile` 的 target；`bun` 表示当前构建机。 */
  bunTarget: string
  platform: MihomoPlatform
  arch: MihomoArch
  /** 目标平台与构建机一致 */
  native: boolean
}

export interface MihomoReleaseAsset {
  /** 资产文件名，例如 mihomo-windows-amd64-v1.19.33.zip */
  assetName: string
  /** 资产形态，决定解压方式 */
  archive: MihomoArchiveKind
  /**
   * 解出后写入 DATA_DIR/bin 时使用的**本地**文件名。
   * 注意不是压缩包内的文件名（windows 包里是 mihomo-windows-amd64.exe，名字随资产变）。
   */
  binaryName: 'mihomo' | 'mihomo.exe'
}

const OS_ALIASES: Record<string, MihomoPlatform> = {
  windows: 'win32',
  win: 'win32',
  win32: 'win32',
  linux: 'linux',
  darwin: 'darwin',
  macos: 'darwin',
  mac: 'darwin',
  osx: 'darwin',
}

const ARCH_ALIASES: Record<string, MihomoArch> = {
  x64: 'x64',
  x86_64: 'x64',
  amd64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
  arm: 'arm',
  armv7: 'arm',
  armv7a: 'arm',
  armhf: 'arm',
}

/**
 * 目标 → 资产的三段：**os 段与 arch 段都是 Mihomo 自己的叫法**，与 Bun 不是一套词
 * （Bun 的 win32 / x64 在资产名里分别是 windows / amd64）。
 */
const ASSET_ARCH: Record<string, { os: string; arch: string; ext: MihomoArchiveKind }> = {
  'win32-x64': { os: 'windows', arch: 'amd64', ext: 'zip' },
  'win32-arm64': { os: 'windows', arch: 'arm64', ext: 'zip' },
  'linux-x64': { os: 'linux', arch: 'amd64', ext: 'gz' },
  'linux-arm64': { os: 'linux', arch: 'arm64', ext: 'gz' },
  'linux-arm': { os: 'linux', arch: 'armv7', ext: 'gz' },
  'darwin-x64': { os: 'darwin', arch: 'amd64', ext: 'gz' },
  'darwin-arm64': { os: 'darwin', arch: 'arm64', ext: 'gz' },
}

function hostPlatform(): MihomoPlatform {
  const p = process.platform
  if (p === 'win32' || p === 'linux' || p === 'darwin') return p
  throw new Error('当前构建平台 ' + p + ' 不受支持（Bun --compile 仅支持 win32 / linux / darwin）')
}

function hostArch(): MihomoArch {
  const a = process.arch
  if (a === 'x64' || a === 'arm64' || a === 'arm') return a
  throw new Error('当前构建架构 ' + a + ' 不受支持（仅支持 x64 / arm64 / arm）')
}

/**
 * 解析打包目标（与 Xray 版的 parseBuildTarget 同语义，函数名按本模块契约叫 parseBuilderTarget）：
 * - 省略 / `bun` / `host`：当前平台；
 * - `bun-linux-x64`、`bun-windows-x64-baseline`、`linux-arm64`、`darwin-arm64` 等。
 *
 * 未知后缀（baseline / modern / musl）原样交给 bun，只取前两段做资产映射。
 */
export function parseBuilderTarget(input?: string): MihomoBuildTarget {
  const raw = (input ?? '').trim()
  if (!raw || raw === 'bun' || raw === 'host' || raw === 'native') {
    return { bunTarget: 'bun', platform: hostPlatform(), arch: hostArch(), native: true }
  }
  const normalized = raw.startsWith('bun-') ? raw : 'bun-' + raw
  const parts = normalized.slice('bun-'.length).split('-')
  const os = OS_ALIASES[parts[0] ?? '']
  const arch = ARCH_ALIASES[parts[1] ?? '']
  if (!os || !arch) {
    throw new Error(
      '无法识别打包目标「' + raw + '」。示例：bun-windows-x64、bun-linux-x64、bun-linux-arm64、bun-darwin-arm64',
    )
  }
  return {
    bunTarget: normalized,
    platform: os,
    arch,
    native: os === hostPlatform() && arch === hostArch(),
  }
}

/**
 * 目标平台对应的 Mihomo 发行包名、压缩形态与本地二进制文件名。
 *
 * 版本可以带或不带前导 v：'1.19.33' 与 'v1.19.33' 等价，资产名里只出现一次 v。
 * 省略版本时用 DEFAULT_MIHOMO_VERSION（构建脚本 --mihomo-version 覆盖时传第二个参数）。
 */
export function mihomoReleaseAsset(
  target: Pick<MihomoBuildTarget, 'platform' | 'arch'>,
  version: string = DEFAULT_MIHOMO_VERSION,
): MihomoReleaseAsset {
  const spec = ASSET_ARCH[target.platform + '-' + target.arch]
  if (!spec) {
    throw new Error(
      'Mihomo 官方没有 ' + target.platform + '/' + target.arch + ' 的发行包，无法内嵌；可选：' +
        Object.keys(ASSET_ARCH).join('、'),
    )
  }
  return {
    assetName: 'mihomo-' + spec.os + '-' + spec.arch + '-v' + versionBody(version) + '.' + spec.ext,
    archive: spec.ext,
    binaryName: target.platform === 'win32' ? 'mihomo.exe' : 'mihomo',
  }
}

/** 'v1.19.33' / '1.19.33' → '1.19.33'（资产名里 v 只出现一次） */
export function versionBody(version: string): string {
  return version.trim().replace(/^v/i, '')
}

/**
 * 从 GitHub Release API 的响应里取出「资产名 → sha256」。
 *
 * 输入形如 `{ assets: [{ name, digest: "sha256:<hex>" }, ...] }`（实测 v1.19.33 每个资产都带
 * digest）；也接受已经剥掉外层的 `assets` 数组。digest 缺失或格式不对的资产被跳过，
 * 让调用方自己决定「缺摘要」时是警告还是中止。
 */
export function parseReleaseDigests(releaseJson: unknown): Record<string, string> {
  const root = releaseJson as { assets?: unknown } | null
  const list = Array.isArray(root) ? root : Array.isArray(root?.assets) ? root!.assets : []
  const out: Record<string, string> = {}
  for (const item of list as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const name = (item as { name?: unknown }).name
    const digest = (item as { digest?: unknown }).digest
    if (typeof name !== 'string' || !name || typeof digest !== 'string') continue
    const m = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim())
    if (m) out[name] = m[1]!.toLowerCase()
  }
  return out
}

function crc32(data: Uint8Array): number {
  let table = CRC_TABLE
  if (!table) {
    table = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[i] = c >>> 0
    }
    CRC_TABLE = table
  }
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = table[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

let CRC_TABLE: Uint32Array | null = null

interface ZipEntry {
  name: string
  data: Uint8Array
}

/**
 * 读出 zip 里的所有**文件**条目（跳过目录），按中央目录顺序。
 * 支持 store(0) / deflate(8)，并按中央目录校验长度与 CRC32。
 * 之所以不用现成的库：Bun.Archive 只支持 tar，而 Mihomo 的 windows 包是 zip。
 */
export function readZipEntries(zip: Uint8Array): ZipEntry[] {
  if (zip.byteLength < 22) throw new Error('zip 文件过小，无法解析')
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const u16 = (o: number) => dv.getUint16(o, true)
  const u32 = (o: number) => dv.getUint32(o, true)

  // End of central directory：从尾部向前找（可能带 comment）
  let eocd = -1
  const budget = Math.min(zip.byteLength - 22, 65557)
  for (let i = 0; i <= budget; i++) {
    const at = zip.byteLength - 22 - i
    if (u32(at) !== 0x06054b50) continue
    if (at + 22 + u16(at + 20) === zip.byteLength) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（缺少 EOCD）')

  const total = u16(eocd + 10)
  let off = u32(eocd + 16)
  const entries: ZipEntry[] = []

  for (let i = 0; i < total; i++) {
    if (u32(off) !== 0x02014b50) throw new Error('zip 中央目录损坏（偏移 ' + off + '）')
    const flags = u16(off + 8)
    const method = u16(off + 10)
    const expectedCrc = u32(off + 16)
    const compressedSize = u32(off + 20)
    const uncompressedSize = u32(off + 24)
    const nameLen = u16(off + 28)
    const extraLen = u16(off + 30)
    const commentLen = u16(off + 32)
    const localOffset = u32(off + 42)
    const name = new TextDecoder().decode(zip.subarray(off + 46, off + 46 + nameLen))
    off += 46 + nameLen + extraLen + commentLen

    // 目录条目：名字以 / 结尾，没有数据
    if (name.endsWith('/')) continue
    if (flags & 1) throw new Error('zip 内 ' + name + ' 已加密，无法提取')
    if (uncompressedSize > 256 * 1024 * 1024) throw new Error('zip 内 ' + name + ' 解压后过大，已拒绝')
    if (u32(localOffset) !== 0x04034b50) throw new Error('zip 内 ' + name + ' 的本地头损坏')
    const localNameLen = u16(localOffset + 26)
    const localExtraLen = u16(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compressedSize > zip.byteLength) throw new Error('zip 数据越界')
    const raw = zip.subarray(dataStart, dataStart + compressedSize)
    let data: Uint8Array
    if (method === 0) data = raw.slice()
    else if (method === 8) data = new Uint8Array(inflateRawSync(raw))
    else throw new Error('不支持的 zip 压缩方式 ' + method + '（仅支持 store/deflate）')
    if (data.byteLength !== uncompressedSize) {
      throw new Error('zip 内 ' + name + ' 长度不符：' + data.byteLength + ' != ' + uncompressedSize)
    }
    if (crc32(data) !== expectedCrc) throw new Error('zip 内 ' + name + ' CRC32 校验失败')
    entries.push({ name, data })
  }
  if (entries.length === 0) throw new Error('zip 内没有任何文件')
  return entries
}

/**
 * 从发行包里取出引擎二进制。
 *
 * - `zip`：包内**只有一个**可执行文件（实测 mihomo-windows-amd64-v1.19.33.zip 内是
 *   mihomo-windows-amd64.exe）。这里按「唯一的文件条目」取，不写死文件名，因为文件名
 *   随平台/arch 变化；万一有多个条目，优先取 .exe 结尾的那个，再不行报错并把候选列出来。
 * - `gz`：裸 gzip，解压出来就是 ELF/Mach-O 二进制（无内部文件名）。
 */
export function extractBinaryFromArchive(archive: Uint8Array, kind: MihomoArchiveKind): Uint8Array {
  if (kind === 'gz') {
    if (archive.byteLength < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
      throw new Error('不是有效的 gzip（魔数不符）')
    }
    return new Uint8Array(gunzipSync(archive))
  }
  const entries = readZipEntries(archive)
  if (entries.length === 1) return entries[0]!.data
  const exe = entries.filter((e) => /\.exe$/i.test(e.name))
  if (exe.length === 1) return exe[0]!.data
  throw new Error(
    '发行包内有多个文件，无法确定引擎二进制：' + entries.map((e) => e.name).join('、'),
  )
}
