/**
 * MihomoProcess 的真机测试：起一个真的 mihomo 子进程，验证启动/就绪/停止/崩溃检测。
 *
 * 为什么必须真机而不是 mock：这里要复现三条只有真二进制才暴露的行为——
 *   ① 就绪判据是 REST GET /version（进程活着 ≠ 控制面可用）；
 *   ② mihomo -t 在 -f 指向缺失文件时会**自动创建默认配置**并返回成功（陷阱）；
 *   ③ 退出码语义：配置合法 0 / 非法 1。
 *
 * 找不到二进制时整组 skip（describe.skipIf），不把「没装 mihomo」变成红灯。
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MihomoClient } from '../src/mihomo/client'
import { MihomoProcess } from '../src/mihomo/process'

const ROOT = join(import.meta.dir, '../../..')

function whichMihomo(): string {
  return Bun.which('mihomo') ?? ''
}

function findMihomo(): string | undefined {
  const exe = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'
  const candidates = [
    process.env['MIHOMO_BIN'] ?? '',
    join(ROOT, '.tools', exe),
    // 本机调研/开发时用的固定落点（.env.example 里写明了）
    process.platform === 'win32' ? 'D:/tmp/research2/bin/mihomo.exe' : '',
    whichMihomo(),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return undefined
}

const MIHOMO = findMihomo()
const SECRET = 'test-secret-' + Date.now().toString(36)

/** 让 OS 分配一个空闲端口（避免和并行测试/调研进程抢端口）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => {
        if (port) resolve(port)
        else reject(new Error('未能分配端口'))
      })
    })
  })
}

function configYaml(controllerPort: number, listenerPort: number): string {
  return [
    'log-level: warning',
    'external-controller: 127.0.0.1:' + String(controllerPort),
    'secret: ' + SECRET,
    'mode: rule',
    'listeners:',
    '  - name: in-slot-0',
    '    type: mixed',
    '    port: ' + String(listenerPort),
    '    listen: 127.0.0.1',
    '    proxy: DIRECT',
    'rules:',
    '  - MATCH,DIRECT',
    '',
  ].join('\n')
}

interface Fixture {
  dir: string
  configPath: string
  proc: MihomoProcess
  client: MihomoClient
  controllerPort: number
}

async function setup(opts: { readyTimeoutMs?: () => number } = {}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'xcp-mihomo-'))
  const controllerPort = await freePort()
  const listenerPort = await freePort()
  const configPath = join(dir, 'config.yaml')
  const client = new MihomoClient({
    baseUrl: () => 'http://127.0.0.1:' + String(controllerPort),
    secret: () => SECRET,
    timeoutMs: () => 1500,
  })
  const proc = new MihomoProcess({
    binary: () => MIHOMO!,
    configPath: () => configPath,
    dataDir: () => dir,
    client,
    extraArgs: () => [],
    readyTimeoutMs: opts.readyTimeoutMs ?? (() => 20_000),
  })
  writeFileSync(configPath, configYaml(controllerPort, listenerPort), 'utf8')
  return { dir, configPath, proc, client, controllerPort }
}

async function teardown(f: Fixture): Promise<void> {
  await f.proc.stop().catch(() => undefined)
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(f.dir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

/** 进程是否还活着。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 5000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return pred()
}

describe.skipIf(!MIHOMO)('MihomoProcess（真机）', () => {
  test('start() 等到 REST 就绪才返回版本，status 变 running', async () => {
    const f = await setup()
    try {
      const { version } = await f.proc.start()
      expect(version).toMatch(/^v?\d+\.\d+\.\d+$/)
      expect(version).toBe('v1.19.33')

      const st = f.proc.status()
      expect(st.status).toBe('running')
      expect(st.version).toBe(version)
      expect(st.pid).toBeGreaterThan(0)
      expect(st.startedAt).toBeGreaterThan(0)
      expect(st.restarts).toBe(0)
      expect(f.proc.isRunning()).toBe(true)

      // 进程确实活着，且控制面带鉴权可用
      expect(alive(st.pid ?? 0)).toBe(true)
      const info = await f.client.version()
      expect(info.version).toBe(version)

      // stdout/stderr 都接进了环形缓冲
      expect(f.proc.tailLog(50).length).toBeGreaterThan(0)
      expect(f.proc.tailLog(0)).toEqual([])
    } finally {
      await teardown(f)
    }
  }, 60_000)

  test('testConfig：合法配置 exit 0，非法配置 exit 1 且原因可读', async () => {
    const f = await setup()
    try {
      const good = await f.proc.testConfig(f.configPath)
      expect(good.code).toBe(0)
      expect(good.ok).toBe(true)
      expect(good.stdout + good.stderr).toContain('test is successful')

      const badPath = join(f.dir, 'bad.yaml')
      writeFileSync(
        badPath,
        'log-level: warning\nlisteners:\n  - name: x\n    type: no-such-listener-type\n    port: 27899\n    listen: 127.0.0.1\n    proxy: DIRECT\n',
      )
      const bad = await f.proc.testConfig(badPath)
      expect(bad.code).toBe(1)
      expect(bad.ok).toBe(false)
      const text = bad.stdout + bad.stderr
      expect(text).toContain('test failed')
      expect(text).toContain('unsupport proxy type')
    } finally {
      await teardown(f)
    }
  }, 60_000)

  test('testConfig 对缺失文件直接失败，并且不会让 mihomo 造出默认配置（-t 的坑）', async () => {
    const f = await setup()
    try {
      const missing = join(f.dir, 'missing.yaml')
      expect(existsSync(missing)).toBe(false)

      const r = await f.proc.testConfig(missing)
      expect(r.ok).toBe(false)
      expect(r.code).toBe(-1)
      expect(r.stderr).toContain('配置文件不存在')

      // 关键断言：mihomo -t 本身在文件缺失时会写出默认配置并返回成功，
      // 我们的护栏必须让这个文件始终不存在。
      expect(existsSync(missing)).toBe(false)
    } finally {
      await teardown(f)
    }
  }, 60_000)

  test('start() 拒绝在配置缺失时启动（否则会拿默认配置跑一个假数据面）', async () => {
    const f = await setup()
    try {
      rmSync(f.configPath)
      await expect(f.proc.start()).rejects.toThrow(/配置不存在/)
      expect(f.proc.status().status).toBe('crashed')
      expect(f.proc.status().lastExitReason).toBe('start-failed')
      expect(f.proc.status().pid).toBeNull()
    } finally {
      await teardown(f)
    }
  }, 60_000)

  test('stop() 之后进程消失、状态 stopped、退出原因 stopped', async () => {
    const f = await setup()
    try {
      await f.proc.start()
      const pid = f.proc.status().pid ?? 0
      expect(alive(pid)).toBe(true)

      await f.proc.stop()

      const st = f.proc.status()
      expect(st.status).toBe('stopped')
      expect(st.pid).toBeNull()
      expect(st.lastExitReason).toBe('stopped')
      expect(st.lastExitAt).toBeGreaterThan(0)
      expect(f.proc.isRunning()).toBe(false)
      // 真进程必须真的没了
      expect(await waitFor(() => !alive(pid), 5000)).toBe(true)
    } finally {
      await teardown(f)
    }
  }, 60_000)

  test('就绪超时：收掉半死的子进程、归类 start-failed、不留下孤儿', async () => {
    // readyTimeoutMs=1ms → 一定超时；断言超时路径确实会 kill 掉子进程并复位状态
    const f = await setup({ readyTimeoutMs: () => 1 })
    try {
      await expect(f.proc.start()).rejects.toThrow(/超时/)

      const st = f.proc.status()
      expect(st.status).toBe('crashed')
      expect(st.lastExitReason).toBe('start-failed')
      expect(st.pid).toBeNull()
      expect(f.proc.isRunning()).toBe(false)

      // 已经收尾过，stop() 必须幂等且不抛
      await f.proc.stop()
      expect(f.proc.status().status).toBe('stopped')
      expect(f.proc.status().lastExitReason).toBe('stopped')
    } finally {
      await teardown(f)
    }
  }, 60_000)

  test('崩溃检测：外部杀掉进程 -> crashed、记录原因与时间、不自动重启', async () => {
    const f = await setup()
    try {
      await f.proc.start()
      const pid = f.proc.status().pid ?? 0
      const restartsBefore = f.proc.status().restarts

      // 模拟「面板之外的意外」：直接对 OS 进程发终止信号
      process.kill(pid, 'SIGTERM')

      expect(await waitFor(() => f.proc.status().status === 'crashed', 10_000)).toBe(true)
      const st = f.proc.status()
      expect(st.lastExitReason).toBe('crash')
      expect(st.lastExitAt).toBeGreaterThan(0)
      expect(st.pid).toBeNull()
      expect(f.proc.isRunning()).toBe(false)
      // 不自动重启：restarts 不该被崩溃自己推高
      expect(st.restarts).toBe(restartsBefore)
      expect(await waitFor(() => !alive(pid), 5000)).toBe(true)

      // 外层调度可以显式重启，restarts 这时才 +1
      const { version } = await f.proc.restart()
      expect(version).toMatch(/^v?\d+\.\d+\.\d+$/)
      expect(f.proc.status().restarts).toBe(1)
      expect(f.proc.status().status).toBe('running')
    } finally {
      await teardown(f)
    }
  }, 90_000)
})

describe('MihomoProcess（无二进制时的降级）', () => {
  test('二进制路径不存在时 start() 立刻失败并归类 start-failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xcp-mihomo-none-'))
    const configPath = join(dir, 'config.yaml')
    writeFileSync(configPath, 'log-level: warning\n')
    const client = new MihomoClient({ baseUrl: () => 'http://127.0.0.1:1', secret: () => '' })
    const proc = new MihomoProcess({
      binary: () => join(dir, 'no-such-mihomo'),
      configPath: () => configPath,
      dataDir: () => dir,
      client,
    })
    try {
      await expect(proc.start()).rejects.toThrow(/二进制不存在/)
      expect(proc.status().status).toBe('crashed')
      expect(proc.status().lastExitReason).toBe('start-failed')
    } finally {
      await proc.stop().catch(() => undefined)
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
