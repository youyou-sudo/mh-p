import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MihomoApiError, MihomoClient, type MihomoProxyInfo } from '../src/mihomo/client'
import { classifyDelayError, observationOf, probeOne, sampleProxies } from '../src/detect/mihomo'

const proxy = (over: Partial<MihomoProxyInfo> & { name: string }): MihomoProxyInfo => ({
  type: 'Direct',
  ...over,
})

const hist = (...delays: number[]) => delays.map((delay, i) => ({ time: '2026-10-29T00:00:0' + i + '+08:00', delay }))

describe('observationOf：/proxies 的 alive + history 映射', () => {
  test('proxy 不存在 → null（无数据，调用方不得判死）', () => {
    // 为什么重要：数据面刚重载/节点名还没同步时 /proxies 里没有这个 proxy，
    // 把它当「死」会让整批节点在发布后瞬间被隔离。
    expect(observationOf(undefined)).toBeNull()
  })

  test('history 为空 → null，即使 alive=true（真机：从未测过的 proxy 就是 alive:true + history:[]）', () => {
    // 为什么重要：Mihomo 的 alive 初值是 true（adapter.NewProxy），从未探测的节点也是 alive=true。
    // 只信 alive 会把「从未验证」当成「健康」，这类节点会被直接发布上线。
    expect(observationOf(proxy({ name: 'p', alive: true, history: [] }))).toBeNull()
    expect(observationOf(proxy({ name: 'p', alive: true }))).toBeNull()
  })

  test('alive=false → ok=false，delayMs=null（有数据说它坏，与「无数据」区分）', () => {
    const out = observationOf(proxy({ name: 'p', alive: false, history: hist(0) }))
    expect(out).not.toBeNull()
    expect(out!.ok).toBe(false)
    expect(out!.alive).toBe(false)
    expect(out!.delayMs).toBeNull()
    expect(out!.lastDelay).toBe(0)
    expect(out!.samples).toBe(1)
  })

  test('alive=true 且最后一条 delay>0 → ok=true，delayMs 取该值（成功值最小 1）', () => {
    const out = observationOf(proxy({ name: 'p', alive: true, history: hist(1, 87) }))
    expect(out).toEqual({ ok: true, delayMs: 87, alive: true, lastDelay: 87, samples: 2 })
  })

  test('最后一条 delay=0 是「失败样本」而不是 0ms 延迟 → ok=false', () => {
    // 为什么重要：Mihomo 的 URLTest 在失败时把 history 写成 delay=0（真机确认：
    // dead-socks 一次连接拒绝后 history 的最后一条就是 {delay:0}），成功时 <1ms 会被抬到 1。
    // 所以 0 只能解读为失败；当成「0ms 延迟」会把死节点判活。
    const out = observationOf(proxy({ name: 'p', alive: true, history: hist(42, 0) }))
    expect(out).not.toBeNull()
    expect(out!.ok).toBe(false)
    expect(out!.lastDelay).toBe(0)
    expect(out!.delayMs).toBeNull()
    expect(out!.samples).toBe(2)
  })

  test('取最后一条而不是第一条：早期失败不影响最近一次成功', () => {
    const out = observationOf(proxy({ name: 'p', alive: true, history: hist(0, 0, 55) }))
    expect(out!.ok).toBe(true)
    expect(out!.delayMs).toBe(55)
  })

  test('alive 缺字段时只看 history（/proxies 实际总会带 alive，这里只做防御）', () => {
    expect(observationOf(proxy({ name: 'p', history: hist(33) }))!.ok).toBe(true)
    expect(observationOf(proxy({ name: 'p', history: hist(0) }))!.ok).toBe(false)
  })
})

describe('classifyDelayError：delay 端点的 HTTP 状态映射', () => {
  test('状态码 → errorKind 表（值来自 Mihomo hub/route/proxies.go + 客户端约定）', () => {
    const table: [number, string][] = [
      [0, 'engine_unavailable'], // fetch 层失败（引擎没起来/端口不通），不等于节点坏
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [404, 'proxy_not_found'], // 节点名与数据面不一致
      [400, 'delay_rejected'], // timeout/expected 参数不合法
      [408, 'timeout'],
      [504, 'timeout'], // context deadline exceeded
      [503, 'delay_failed'], // 探测失败（连不上目标），真机最常见
      [500, 'delay_failed'],
      [418, 'delay_rejected'],
      [599, 'delay_failed'],
    ]
    for (const [status, kind] of table) expect([status, classifyDelayError(status)]).toEqual([status, kind])
  })
})

describe('sampleProxies：一次读 /proxies 批量映射', () => {
  const targets = [
    { nodeId: 'n1', proxyName: 'p1' },
    { nodeId: 'n2', proxyName: 'p2' },
    { nodeId: 'n3', proxyName: 'missing' },
  ]

  test('按 nodeId 映射；不存在的 proxy 与空 history 直接缺席（不是 false）', async () => {
    const out = await sampleProxies({
      read: async () => ({
        proxies: {
          p1: proxy({ name: 'p1', alive: true, history: hist(12) }),
          p2: proxy({ name: 'p2', alive: false, history: hist(0) }),
          // p3 有 proxy 但从没测过
          p3: proxy({ name: 'p3', alive: true, history: [] }),
        },
      }),
      targets: [...targets, { nodeId: 'n4', proxyName: 'p3' }],
    })
    expect([...out.keys()].sort()).toEqual(['n1', 'n2'])
    expect(out.get('n1')!.ok).toBe(true)
    expect(out.get('n2')!.ok).toBe(false)
  })

  test('读 /proxies 失败 → 空 Map（不抛、不伪造失败）', async () => {
    // 为什么重要：读不到 /proxies 是「引擎/控制面通道坏了」，此时把节点判死会整池误隔离；
    // 正确做法是本轮跳过，由调用方决定降级/发事件。
    const out = await sampleProxies({
      read: async () => {
        throw new MihomoApiError('boom', 0, '/proxies')
      },
      targets,
    })
    expect(out.size).toBe(0)
  })

  test('targets 为空时不发起读取（省一次引擎往返）', async () => {
    let called = 0
    const out = await sampleProxies({
      read: async () => {
        called++
        return { proxies: {} }
      },
      targets: [],
    })
    expect(out.size).toBe(0)
    expect(called).toBe(0)
  })
})

describe('probeOne：触发式测速映射', () => {
  test('成功：透传 name/url/timeout，返回 ok + delayMs', async () => {
    const seen: unknown[] = []
    const out = await probeOne({
      delay: async (name, url, timeoutMs) => {
        seen.push([name, url, timeoutMs])
        return 23
      },
      proxyName: 'p1',
      url: 'https://example.com/generate_204',
      timeoutMs: 3000,
    })
    expect(out).toEqual({ ok: true, delayMs: 23 })
    expect(seen).toEqual([['p1', 'https://example.com/generate_204', 3000]])
  })

  test('504（超时）→ errorKind=timeout', async () => {
    const out = await probeOne({
      delay: async () => {
        throw new MihomoApiError('timeout', 504, '/proxies/p1/delay')
      },
      proxyName: 'p1',
      url: 'u',
      timeoutMs: 3000,
    })
    expect(out).toEqual({ ok: false, errorKind: 'timeout' })
  })

  test('status=0（连不上引擎）→ errorKind=engine_unavailable', async () => {
    const out = await probeOne({
      delay: async () => {
        throw new MihomoApiError('refused', 0, '/proxies/p1/delay')
      },
      proxyName: 'p1',
      url: 'u',
      timeoutMs: 3000,
    })
    expect(out).toEqual({ ok: false, errorKind: 'engine_unavailable' })
  })

  test('503（探测失败）→ errorKind=delay_failed', async () => {
    const out = await probeOne({
      delay: async () => {
        throw new MihomoApiError('probe failed', 503, '/proxies/p1/delay')
      },
      proxyName: 'p1',
      url: 'u',
      timeoutMs: 3000,
    })
    expect(out).toEqual({ ok: false, errorKind: 'delay_failed' })
  })

  test('非 MihomoApiError 的异常也归类成 engine_unavailable（不向上抛）', async () => {
    const out = await probeOne({
      delay: async () => {
        throw new Error('socket closed')
      },
      proxyName: 'p1',
      url: 'u',
      timeoutMs: 3000,
    })
    expect(out).toEqual({ ok: false, errorKind: 'engine_unavailable' })
  })

  test('返回 0/负数（异常响应）→ 仍按失败处理（Mihomo 成功值最小 1）', async () => {
    for (const bad of [0, -5]) {
      const out = await probeOne({ delay: async () => bad, proxyName: 'p1', url: 'u', timeoutMs: 3000 })
      expect(out).toEqual({ ok: false, errorKind: 'delay_failed' })
    }
  })
})

// ---------------------------------------------------------------------------
// 真机验证（有 Mihomo 二进制才跑）：把上面几条「为什么」用真实引擎钉住
// ---------------------------------------------------------------------------

const MIHOMO_BIN = process.env.MIHOMO_BIN || 'D:/tmp/research2/bin/mihomo.exe'
const HAS_MIHOMO = existsSync(MIHOMO_BIN)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** 最后一条 history（仓库 tsconfig 的 lib 不含 ES2022 的 Array.prototype.at） */
const lastOf = (arr: { time: string; delay: number }[]) => arr[arr.length - 1]!

const freePort = (): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })

test.skipIf(!HAS_MIHOMO)(
  '真机（Mihomo）：失败样本 delay=0、alive 一次失败即翻、history 上限 10、503/504 状态码',
  async () => {
    // 实测结论（v1.19.33，2026-10-29）：
    //  ① 失败样本的 history.delay 就是 0；成功样本最小是 1（<1ms 被抬到 1）；
    //  ② alive 在 1 次失败后立即变 false（无连续次数确认，阈值必须由面板状态机兜）；
    //  ③ history 最多 10 条（写满后 FIFO）；
    //  ④ 探测失败（连接拒绝/目标不可达）→ HTTP 503；测试超时 → HTTP 504。
    const dir = mkdtempSync(join(tmpdir(), 'xcp-mihomo-detect-'))
    const probeServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(null, { status: 204 }) })
    const probeUrl = 'http://127.0.0.1:' + probeServer.port + '/generate_204'
    // 接受 TCP 但永不应答的“挂死”目标：用来复现 delay 端点的 504（超时）
    const hangSockets: unknown[] = []
    const hangServer = createServer((sock) => {
      hangSockets.push(sock)
    })
    await new Promise<void>((r) => hangServer.listen(0, '127.0.0.1', () => r()))
    const hangAddr = hangServer.address()
    const hangPort = typeof hangAddr === 'object' && hangAddr ? hangAddr.port : 0
    const ctlPort = await freePort()
    const mixedPort = await freePort()
    const secret = 'xcp-detect-test'
    writeFileSync(
      join(dir, 'config.yaml'),
      [
        'mixed-port: ' + mixedPort,
        'allow-lan: false',
        'mode: rule',
        'log-level: warning',
        'ipv6: false',
        'dns:',
        '  enable: false',
        'external-controller: 127.0.0.1:' + ctlPort,
        'secret: "' + secret + '"',
        'proxies:',
        '  - {name: ok-direct, type: direct}',
        '  - {name: dead-socks, type: socks5, server: 127.0.0.1, port: 1}',
        '  - {name: hang-socks, type: socks5, server: 127.0.0.1, port: ' + hangPort + '}',
        '  - {name: never-tested, type: direct}',
        'rules:',
        '  - MATCH,DIRECT',
        '',
      ].join('\n'),
      'utf8',
    )
    const proc = Bun.spawn([MIHOMO_BIN, '-d', dir, '-f', join(dir, 'config.yaml')], {
      stdout: 'ignore',
      stderr: 'pipe',
      cwd: dir,
    })
    const client = new MihomoClient({
      baseUrl: () => 'http://127.0.0.1:' + ctlPort,
      secret: () => secret,
      timeoutMs: () => 3000,
    })
    try {
      const deadline = Date.now() + 20_000
      for (;;) {
        try {
          await client.version()
          break
        } catch (e) {
          if (Date.now() > deadline) throw e
          await sleep(150)
        }
      }

      // 从未测过的 proxy：alive=true 但 history=[] → 我们的映射必须是 null（不是 ok）
      const before = (await client.proxies()).proxies['never-tested']!
      expect(before.alive).toBe(true)
      expect(before.history ?? []).toHaveLength(0)
      expect(observationOf(before)).toBeNull()

      // 成功：direct 出站到本地 204
      const okDelay = await client.proxyDelay('ok-direct', probeUrl, 2000)
      expect(okDelay).toBeGreaterThan(0) // 实测 = 1（<1ms 被抬到 1）

      // 失败：socks5 → 127.0.0.1:1（连接被拒）→ 端点 503
      let deadStatus = -1
      try {
        await client.proxyDelay('dead-socks', probeUrl, 1500)
      } catch (e) {
        expect(e).toBeInstanceOf(MihomoApiError)
        deadStatus = (e as MihomoApiError).status
      }
      expect(deadStatus).toBe(503)
      expect(classifyDelayError(deadStatus)).toBe('delay_failed')

      // 超时：socks5 → 只 accept 不应答的监听器 → 端点 504
      let hangStatus = -1
      try {
        await client.proxyDelay('hang-socks', probeUrl, 600)
      } catch (e) {
        expect(e).toBeInstanceOf(MihomoApiError)
        hangStatus = (e as MihomoApiError).status
      }
      expect(hangStatus).toBe(504)
      expect(classifyDelayError(hangStatus)).toBe('timeout')

      const after = (await client.proxies()).proxies
      // 实测：失败样本 delay=0、alive 一次失败即 false
      expect(after['dead-socks']!.alive).toBe(false)
      expect(lastOf(after['dead-socks']!.history!).delay).toBe(0)
      expect(after['ok-direct']!.alive).toBe(true)
      expect(lastOf(after['ok-direct']!.history!).delay).toBeGreaterThan(0)

      // 我们的映射在真实报文上成立
      expect(observationOf(after['ok-direct'])).toEqual({
        ok: true,
        delayMs: lastOf(after['ok-direct']!.history!).delay,
        alive: true,
        lastDelay: lastOf(after['ok-direct']!.history!).delay,
        samples: 1,
      })
      expect(observationOf(after['dead-socks'])).toEqual({
        ok: false,
        delayMs: null,
        alive: false,
        lastDelay: 0,
        samples: 1,
      })

      // 实测：history 最多 10 条（写满后 FIFO）
      for (let i = 0; i < 12; i++) await client.proxyDelay('ok-direct', probeUrl, 2000)
      const filled = (await client.proxies()).proxies['ok-direct']!
      expect(filled.history).toHaveLength(10)
      expect(filled.history!.every((h) => h.delay > 0)).toBe(true)
      expect(observationOf(filled)!.samples).toBe(10)
    } finally {
      proc.kill()
      probeServer.stop(true)
      try {
        await proc.exited
      } catch {
        /* ignore */
      }
      for (const s of hangSockets) {
        try {
          ;(s as { destroy: () => void }).destroy()
        } catch {
          /* ignore */
        }
      }
      hangServer.close()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* Windows 上 cache.db 可能还没释放，留给 tmp 清理 */
      }
    }
  },
  60_000,
)
