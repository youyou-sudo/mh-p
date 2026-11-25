import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Db } from '../src/core/db'
import { openDb } from '../src/core/db'
import { runMigrations } from '../src/core/migrations'
import { SettingsStore } from '../src/core/settings'
import { EventBus } from '../src/core/events'
import { events as eventsT, nodeCheckRuns, nodeStatus, nodes, subscriptions } from '../src/core/schema'
import { MihomoApiError, MihomoClient, type MihomoProxyInfo } from '../src/mihomo/client'
import { providerNameOf } from '../src/mihomo/config'
import { probeViaSlot, resetProviderWarnThrottle, sampleProviders } from '../src/detect/collector'
import { persistCheckResult } from '../src/detect/persist'

// ---------------------------------------------------------------------------
// 测试台：真实 SQLite（迁移到 v4）+ 假 MihomoClient（provider 端点）
// 不联网：client.provider 是注入的；probeViaSlot 用本地 Bun HTTP 服务模拟槽位 listener。
// ---------------------------------------------------------------------------

const resources: { dir: string; db: Db }[] = []

afterEach(() => {
  for (const item of resources.splice(0)) {
    try {
      item.db.raw.close()
    } catch {
      /* already closed */
    }
    try {
      rmSync(item.dir, { recursive: true, force: true })
    } catch {
      /* Windows 上 WAL 句柄可能晚一拍释放 */
    }
  }
  // 告警节流是模块级状态：不清会串用例
  resetProviderWarnThrottle()
})

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'xcp-mihomo-collector-'))
  const db = openDb(join(dir, 'sb.db'))
  resources.push({ dir, db })
  runMigrations(db)
  const settings = new SettingsStore(db)
  const events = new EventBus(db)
  return { db, settings, events }
}

const NOW = 1_700_000_000_000

function addSub(db: Db, id: string, enabled = 1): void {
  db.insert(subscriptions)
    .values({
      id,
      name: id,
      url: 'inline://' + id,
      enabled,
      format_hint: 'clash',
      created_at: 1,
      updated_at: 1,
    })
    .run()
}

function addNode(
  db: Db,
  id: string,
  opts: { proxyName: string | null; proxySource?: string | null; protocolSupported?: number },
): void {
  db.insert(nodes)
    .values({
      id,
      display_name: id,
      protocol: 'vmess',
      fingerprint: 'fp-' + id,
      params_hash: 'ph-' + id,
      outbound_json: '{}',
      protocol_supported: opts.protocolSupported ?? 1,
      proxy_name: opts.proxyName,
      proxy_source: opts.proxySource ?? null,
      first_seen_at: 1,
      last_seen_at: 1,
      created_at: 1,
      updated_at: 1,
    })
    .run()
}

function addStatus(
  db: Db,
  nodeId: string,
  over: Partial<typeof nodeStatus.$inferInsert> = {},
): void {
  db.insert(nodeStatus)
    .values({ node_id: nodeId, state: 'up', fail_streak: 0, success_streak: 0, updated_at: 1, ...over })
    .run()
}

/** 构造 /providers/proxies/<name> 里的一个 proxy 条目（history 末条 delay=0 = 失败样本） */
function proxyInfo(name: string, opts: { alive: boolean; delays: number[] }): MihomoProxyInfo {
  return {
    name,
    type: 'Socks5',
    alive: opts.alive,
    history: opts.delays.map((delay, i) => ({ time: '2026-10-29T00:00:0' + i + '+08:00', delay })),
  }
}

function fakeClient(providers: Record<string, MihomoProxyInfo[] | Error>, calls?: string[]): MihomoClient {
  return {
    provider: async (name: string) => {
      calls?.push(name)
      const fixture = providers[name]
      if (fixture instanceof Error) throw fixture
      return { name, type: 'file', proxies: fixture ?? [] }
    },
  } as unknown as MihomoClient
}

const stat = (db: Db, nodeId: string) => db.select().from(nodeStatus).where(eq(nodeStatus.node_id, nodeId)).get()
const runs = (db: Db, nodeId: string) =>
  db.select().from(nodeCheckRuns).where(eq(nodeCheckRuns.node_id, nodeId)).all()
const age = (db: Db, nodeId: string) => db.update(nodeStatus).set({ next_check_at: 0 }).where(eq(nodeStatus.node_id, nodeId)).run()

const errOf = (nodeId: string) => new MihomoApiError('engine down', 0, '/providers/proxies/' + nodeId)

describe('sampleProviders：provider 健康历史 → 状态机 → 落库', () => {
  test('history 为空（从未被测）= 无数据：不写库、不判死', async () => {
    // 为什么重要：Mihomo 的 proxy 初始 alive=true 且 history=[]（真机确认）。
    // 把「从未测过」当健康或当失败都是错的：前者会把未验证节点发布上线，后者会整池误隔离。
    const h = makeHarness()
    addSub(h.db, 's1')
    addNode(h.db, 'n1', { proxyName: 'p1' })
    const client = fakeClient({ [providerNameOf('s1')]: [proxyInfo('p1', { alive: true, delays: [] })] })

    const r = await sampleProviders({ ...h, client, now: () => NOW })

    expect(r).toEqual({ sampled: 0, skipped: 1, unavailable: false })
    expect(stat(h.db, 'n1')).toBeUndefined()
    expect(runs(h.db, 'n1')).toHaveLength(0)
  })

  test('history 末条 delay=0（失败样本）→ 失败落库，error_kind=mihomo_unhealthy、不写 delay', async () => {
    // 为什么重要：Mihomo 失败样本写 delay=0（成功恒 ≥1ms，真机确认），它是「失败」不是 0ms。
    // 另外被动观测拿不到失败原因，必须用专门的 errorKind 说明，而不是伪装成 internal。
    const h = makeHarness()
    addSub(h.db, 's1')
    addNode(h.db, 'n1', { proxyName: 'p1' })
    const client = fakeClient({ [providerNameOf('s1')]: [proxyInfo('p1', { alive: true, delays: [120, 0] })] })

    const r = await sampleProviders({ ...h, client, now: () => NOW })

    expect(r).toEqual({ sampled: 1, skipped: 0, unavailable: false })
    const st = stat(h.db, 'n1')!
    expect(st.state).toBe('down') // unknown + 首次失败
    expect(st.fail_streak).toBe(1)
    expect(st.delay_ms).toBeNull()
    expect(st.error_kind).toBe('mihomo_unhealthy')
    const run = runs(h.db, 'n1')
    expect(run).toHaveLength(1)
    expect(run[0]!.stage_reached).toBe('mihomo')
    expect(run[0]!.ok).toBe(0)
  })

  test('alive=false → 失败（即使 history 里还有旧的成功样本）', async () => {
    // 为什么重要：alive 是 Mihomo 的权威结论（1 次失败就翻 false）。只看历史末条会漏掉
    // 「失败样本还没写进 history 的并发窗口」这种状态。
    const h = makeHarness()
    addSub(h.db, 's1')
    addNode(h.db, 'n1', { proxyName: 'p1' })
    const client = fakeClient({ [providerNameOf('s1')]: [proxyInfo('p1', { alive: false, delays: [42, 0] })] })

    await sampleProviders({ ...h, client, now: () => NOW })

    const st = stat(h.db, 'n1')!
    expect(st.fail_streak).toBe(1)
    expect(st.error_kind).toBe('mihomo_unhealthy')
    expect(st.delay_ms).toBeNull()
  })

  test('到期/跃迁节流：未到期且无跃迁时不重复写 check_runs', async () => {
    // 为什么重要：采样每 30s 一轮，每次写一行会把 historyKeep=50 的窗口几分钟冲光、DB 无限增长。
    const h = makeHarness()
    addSub(h.db, 's1')
    addNode(h.db, 'n1', { proxyName: 'p1' })
    const client = fakeClient({ [providerNameOf('s1')]: [proxyInfo('p1', { alive: true, delays: [55] })] })

    expect(await sampleProviders({ ...h, client, now: () => NOW })).toEqual({ sampled: 1, skipped: 0, unavailable: false })
    expect(runs(h.db, 'n1')).toHaveLength(1)
    const first = stat(h.db, 'n1')!

    // 第二轮：next_check_at 在未来、状态也没变 → 不写
    expect(await sampleProviders({ ...h, client, now: () => NOW })).toEqual({ sampled: 0, skipped: 1, unavailable: false })
    expect(runs(h.db, 'n1')).toHaveLength(1)
    expect(stat(h.db, 'n1')!.checks_total).toBe(first.checks_total)

    // 时间流逝到下一次到期 → 再写一行
    age(h.db, 'n1')
    expect(await sampleProviders({ ...h, client, now: () => NOW })).toEqual({ sampled: 1, skipped: 0, unavailable: false })
    expect(runs(h.db, 'n1')).toHaveLength(2)
  })

  test('被动失败不覆盖已有 exit_ip / exit_country', async () => {
    // 为什么重要：provider health-check 只回答活没活，永远不带出口信息。
    // 一次失败如果清掉 exit_ip，面板上的国家/ASN 会整片消失。
    const h = makeHarness()
    addSub(h.db, 's1')
    addNode(h.db, 'n1', { proxyName: 'p1' })
    addStatus(h.db, 'n1', {
      state: 'up',
      exit_ip: '203.0.113.7',
      exit_country: 'JP',
      next_check_at: 0,
      updated_at: 1,
    })
    const client = fakeClient({ [providerNameOf('s1')]: [proxyInfo('p1', { alive: false, delays: [0] })] })

    await sampleProviders({ ...h, client, now: () => NOW })

    const st = stat(h.db, 'n1')!
    expect(st.exit_ip).toBe('203.0.113.7')
    expect(st.exit_country).toBe('JP')
    expect(st.delay_ms).toBeNull()
    expect(st.error_kind).toBe('mihomo_unhealthy')
  })

  test('单个 provider 读取失败：跳过其节点、不判死，事件 10 分钟节流', async () => {
    // 为什么重要：一个订阅的 provider 拉取失败（临时网络问题）不能连带把它的节点判死；
    // 也不能每个 tick 都刷一条事件。
    const h = makeHarness()
    addSub(h.db, 's1')
    addSub(h.db, 's2')
    addNode(h.db, 'n1', { proxyName: 'p1', proxySource: providerNameOf('s1') })
    addNode(h.db, 'n2', { proxyName: 'p2', proxySource: providerNameOf('s2') })
    const calls: string[] = []
    const client = fakeClient(
      {
        [providerNameOf('s1')]: [proxyInfo('p1', { alive: true, delays: [30] })],
        [providerNameOf('s2')]: new Error('provider fetch failed'),
      },
      calls,
    )

    const first = await sampleProviders({ ...h, client, now: () => NOW })
    expect(first).toEqual({ sampled: 1, skipped: 1, unavailable: false })
    expect(stat(h.db, 'n1')!.state).toBe('up')
    expect(stat(h.db, 'n2')).toBeUndefined() // 读不到 ≠ 死
    expect(calls.sort()).toEqual([providerNameOf('s1'), providerNameOf('s2')])

    const warned = h.db.select().from(eventsT).all().filter((e) => e.kind === 'detect.provider_unavailable')
    expect(warned).toHaveLength(1)
    expect(warned[0]!.level).toBe('warn')

    // 第二轮仍失败：节流期内不再重复发事件
    await sampleProviders({ ...h, client, now: () => NOW + 60_000 })
    expect(h.db.select().from(eventsT).all().filter((e) => e.kind === 'detect.provider_unavailable')).toHaveLength(1)
  })

  test('全部 provider 读取失败 → unavailable=true 且不改任何节点状态', async () => {
    // 为什么重要：读不到任何 provider 说明引擎/控制面通道坏了。此时若把节点判死，
    // 一次引擎抖动就会把整池节点隔离掉。正确做法是本轮整体放弃，交给调用方降级/告警。
    const h = makeHarness()
    addSub(h.db, 's-all')
    addNode(h.db, 'n1', { proxyName: 'p1' })
    addStatus(h.db, 'n1', { state: 'up', checks_total: 7, checks_ok: 7, next_check_at: 0, updated_at: 1 })
    const client = fakeClient({ [providerNameOf('s-all')]: new MihomoApiError('boom', 0, '/providers/proxies/sub-s-all') })

    const r = await sampleProviders({ ...h, client, now: () => NOW })

    expect(r).toEqual({ sampled: 0, skipped: 0, unavailable: true })
    const st = stat(h.db, 'n1')!
    expect(st.state).toBe('up')
    expect(st.checks_total).toBe(7)
    expect(st.fail_streak).toBe(0)
    expect(runs(h.db, 'n1')).toHaveLength(0)
    expect(h.db.select().from(eventsT).all().some((e) => e.kind === 'detect.provider_unavailable')).toBe(true)
  })

  test('quarantined 节点仍被 provider 健康检查观测：连续成功达到 recoverAfter 后恢复', async () => {
    // 为什么重要：Mihomo 的 provider health-check 对 provider 内**所有** proxy 持续探测
    // （lazy=false），不依赖槽位/流量；被隔离的节点仍然在 provider 里、仍然产生 history。
    // 所以 Mihomo 链路不需要旧的 unobservedDueTargets 兜底，隔离不会变成死刑。
    const h = makeHarness()
    addSub(h.db, 's1')
    addNode(h.db, 'n1', { proxyName: 'p1' })
    addStatus(h.db, 'n1', { state: 'quarantined', fail_streak: 5, success_streak: 0, next_check_at: null, updated_at: 1 })
    const client = fakeClient({ [providerNameOf('s1')]: [proxyInfo('p1', { alive: true, delays: [80] })] })
    const recoverAfter = h.settings.get().detect.recoverAfter

    // 第 1 次成功：success_streak=1，仍 quarantined（需要 recoverAfter 次确认）
    expect(await sampleProviders({ ...h, client, now: () => NOW })).toEqual({ sampled: 1, skipped: 0, unavailable: false })
    let st = stat(h.db, 'n1')!
    expect(st.state).toBe('quarantined')
    expect(st.success_streak).toBe(1)

    // 时间流逝，再成功若干次 → up + recovered_at + 事件
    for (let i = 1; i < recoverAfter; i++) {
      age(h.db, 'n1')
      await sampleProviders({ ...h, client, now: () => NOW + i * 1000 })
    }
    st = stat(h.db, 'n1')!
    expect(st.state).toBe('up')
    expect(st.success_streak).toBe(recoverAfter)
    expect(st.fail_streak).toBe(0)
    expect(st.recovered_at).not.toBeNull()
    expect(h.db.select().from(eventsT).all().some((e) => e.kind === 'node.recovered')).toBe(true)
  })

  test('没有 proxy_name 的节点不参与 health 采样（它们不在 Mihomo provider 里）', async () => {
    const h = makeHarness()
    addSub(h.db, 's1')
    addNode(h.db, 'n-static', { proxyName: null })
    const client = fakeClient({ [providerNameOf('s1')]: [] })

    const r = await sampleProviders({ ...h, client, now: () => NOW })

    expect(r).toEqual({ sampled: 0, skipped: 0, unavailable: false })
    expect(stat(h.db, 'n-static')).toBeUndefined()
  })
})

describe('probeViaSlot：经槽位 listener 的按需探测', () => {
  test('lite 成功：204 → ok=true，delay 来自实测，只发一次请求', async () => {
    // 为什么重要：这是 Mihomo 链路唯一能拿到 error_kind / 出口 IP 的路径。
    // lite 与旧 checkOne 口径一致：S2 成功即 ok，不发出口查询。
    const hits: string[] = []
    const connections: (string | null)[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        hits.push(new URL(req.url).pathname)
        connections.push(req.headers.get('connection'))
        return new Response(null, { status: 204 })
      },
    })
    try {
      const port = server.port!
      const url = 'http://127.0.0.1:' + port + '/generate_204'
      const r = await probeViaSlot({
        nodeId: 'n1',
        port,
        testUrl: url,
        totalTimeoutMs: 2000,
        depth: 'lite',
      })
      expect(r.nodeId).toBe('n1')
      expect(r.ok).toBe(true)
      expect(r.stageReached).toBe('http')
      expect(r.httpStatus).toBe(204)
      expect(r.handshakeMs).toBeGreaterThanOrEqual(0)
      expect(hits).toEqual(['/generate_204'])
      // Connection: close 是必须的：否则 Bun 会复用上一条经旧槽位选择的隧道（真机实测）
      expect(connections).toEqual(['close'])
    } finally {
      server.stop(true)
    }
  })

  test('full 成功：再查出口 IP → stageReached=exit_ip、exit 有值、delayMs=实测', async () => {
    const hits: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const path = new URL(req.url).pathname
        hits.push(path)
        if (path === '/geoip') return Response.json({ ip: '203.0.113.9', country: 'JP', asn: 'AS64500' })
        return new Response(null, { status: 204 })
      },
    })
    try {
      const port = server.port!
      const base = 'http://127.0.0.1:' + port
      const r = await probeViaSlot({
        nodeId: 'n1',
        port,
        testUrl: base + '/generate_204',
        totalTimeoutMs: 2000,
        ipEchoUrls: [base + '/geoip'],
        depth: 'full',
      })
      expect(r.ok).toBe(true)
      expect(r.stageReached).toBe('exit_ip')
      expect(r.exit?.ip).toBe('203.0.113.9')
      expect(r.exit?.country).toBe('JP')
      expect(r.delayMs).toBe(r.handshakeMs)
      expect(hits).toContain('/geoip')
    } finally {
      server.stop(true)
    }
  })

  test('槽位 listener 拒绝连接 → ok=false、errorKind=mihomo_down（不伪造 gateway 错误）', async () => {
    // 为什么重要：fetchViaProxy 把「连不上代理」标成历史命名 gateway_unreachable；
    // Mihomo 链路里对端是槽位 listener，沿用旧名会把排障引到网关设置上。
    const port = await new Promise<number>((resolve) => {
      const srv = createServer()
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const p = typeof addr === 'object' && addr ? addr.port : 0
        srv.close(() => resolve(p))
      })
    })
    const r = await probeViaSlot({
      nodeId: 'n1',
      port,
      testUrl: 'http://127.0.0.1:1/generate_204',
      totalTimeoutMs: 1500,
      depth: 'lite',
    })
    expect(r.ok).toBe(false)
    expect(r.nodeId).toBe('n1')
    expect(r.stageReached).toBe('mihomo')
    expect(r.errorKind).toBe('mihomo_down')
    expect(r.errorMsg).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 真机端到端（有 Mihomo 二进制才跑）：把「provider 端点带 alive/history」与「槽位 listener 可用」
// 两个外部假设用真实引擎钉住——它们是 collector 正确性的前提，单测的假 client 证明不了。
// ---------------------------------------------------------------------------

const MIHOMO_BIN = process.env.MIHOMO_BIN || 'D:/tmp/research2/bin/mihomo.exe'
const HAS_MIHOMO = existsSync(MIHOMO_BIN)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

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

async function waitUntil(fn: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await sleep(150)
  }
}

test.skipIf(!HAS_MIHOMO)(
  '真机端到端：provider health-check → node_status，槽位 listener → exit_ip / mihomo_down',
  async () => {
    // 实测（v1.19.33）：GET /providers/proxies/<name> 的 proxies[] **带 alive + history**
    // （provider 内 proxy 不在 /proxies 顶层）；health-check lazy=false 时按 interval 持续探测，
    // 失败样本 history.delay=0、alive 一次失败即 false；listeners 里的 http listener 可当代理直连。
    const h = makeHarness()
    const probeServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        if (new URL(req.url).pathname === '/geoip') return Response.json({ ip: '203.0.113.9', country: 'JP' })
        return new Response(null, { status: 204 })
      },
    })
    const base = 'http://127.0.0.1:' + probeServer.port!
    const home = mkdtempSync(join(tmpdir(), 'xcp-mihomo-collector-home-'))
    mkdirSync(join(home, 'providers'), { recursive: true })
    const ctlPort = await freePort()
    const mixedPort = await freePort()
    const slotPort = await freePort()
    writeFileSync(
      join(home, 'providers', 'sub-s1.yaml'),
      [
        'proxies:',
        '  - {name: ok-direct, type: direct}',
        '  - {name: dead-socks, type: socks5, server: 127.0.0.1, port: 1}',
        '',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'mixed-port: ' + mixedPort,
        'mode: rule',
        'log-level: warning',
        'dns:',
        '  enable: false',
        'external-controller: 127.0.0.1:' + ctlPort,
        'secret: "xcp-collector-test"',
        'proxy-providers:',
        '  sub-s1:',
        '    type: file',
        '    path: providers/sub-s1.yaml',
        '    health-check: {enable: true, url: "' + base + '/generate_204", interval: 2, lazy: false}',
        'proxy-groups:',
        '  - {name: slot-0, type: select, use: [sub-s1], empty-fallback: REJECT}',
        'listeners:',
        '  - {name: in-slot-0, type: http, port: ' + slotPort + ', listen: 127.0.0.1, proxy: slot-0}',
        'rules:',
        '  - MATCH,DIRECT',
        '',
      ].join('\n'),
      'utf8',
    )
    const proc = Bun.spawn([MIHOMO_BIN, '-d', home, '-f', join(home, 'config.yaml')], {
      stdout: 'ignore',
      stderr: 'pipe',
      cwd: home,
    })
    const client = new MihomoClient({
      baseUrl: () => 'http://127.0.0.1:' + ctlPort,
      secret: () => 'xcp-collector-test',
      timeoutMs: () => 3000,
    })
    try {
      const ready = await waitUntil(async () => {
        try {
          await client.version()
          return true
        } catch {
          return false
        }
      }, 20_000)
      expect(ready).toBe(true)

      addSub(h.db, 's1')
      addNode(h.db, 'n-ok', { proxyName: 'ok-direct', proxySource: providerNameOf('s1') })
      addNode(h.db, 'n-dead', { proxyName: 'dead-socks', proxySource: providerNameOf('s1') })

      // 等 provider health-check 至少跑完一轮（history 非空）
      const probed = await waitUntil(async () => {
        const info = await client.provider(providerNameOf('s1'))
        const list = info.proxies ?? []
        return list.length === 2 && list.every((p) => (p.history?.length ?? 0) > 0)
      }, 20_000)
      expect(probed).toBe(true)

      const r = await sampleProviders({ ...h, client })
      expect(r.unavailable).toBe(false)
      expect(r.sampled).toBe(2) // 两个节点都从未有过状态（到期）
      const okStat = stat(h.db, 'n-ok')!
      const deadStat = stat(h.db, 'n-dead')!
      expect(okStat.state).toBe('up')
      expect(okStat.delay_ms!).toBeGreaterThan(0)
      expect(deadStat.state).toBe('down')
      expect(deadStat.error_kind).toBe('mihomo_unhealthy')
      expect(deadStat.delay_ms).toBeNull()

      // 槽位 listener 真实可用：选中 ok-direct → 经它拿 204 与出口 IP
      await client.request('/proxies/slot-0', { method: 'PUT', body: JSON.stringify({ name: 'ok-direct' }) })
      const okProbe = await probeViaSlot({
        nodeId: 'n-ok',
        port: slotPort,
        testUrl: base + '/generate_204',
        totalTimeoutMs: 3000,
        ipEchoUrls: [base + '/geoip'],
        depth: 'full',
      })
      expect(okProbe.ok).toBe(true)
      expect(okProbe.stageReached).toBe('exit_ip')
      expect(okProbe.exit?.ip).toBe('203.0.113.9')
      expect(okProbe.httpStatus).toBe(204)

      // 选中死节点 → 探测失败（拿得到 error_kind，这正是被动观测给不了的）
      await client.request('/proxies/slot-0', { method: 'PUT', body: JSON.stringify({ name: 'dead-socks' }) })
      const deadProbe = await probeViaSlot({
        nodeId: 'n-dead',
        port: slotPort,
        testUrl: base + '/generate_204',
        totalTimeoutMs: 2000,
        depth: 'lite',
      })
      expect(deadProbe.ok).toBe(false)
      expect(deadProbe.errorKind).toBeTruthy()
    } finally {
      proc.kill()
      probeServer.stop(true)
      try {
        await proc.exited
      } catch {
        /* ignore */
      }
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        /* Windows 上 cache.db 可能还没释放，留给 tmp 清理 */
      }
    }
  },
  60_000,
)

describe('persistCheckResult：两条检测路径共用的落库语义', () => {
  test('写 node_status + node_check_runs（source/stage/延迟都照旧）', () => {
    // 为什么重要：collector（被动采样）与按需探测（probeViaSlot）都落这一条路径，
    // 状态机/退避/事件语义一旦漂移，手动检查、v1 API、采样三处的判定就会互相矛盾。
    const h = makeHarness()
    addNode(h.db, 'n1', { proxyName: 'p1' })
    persistCheckResult(
      { db: h.db, settings: h.settings, events: h.events },
      { nodeId: 'n1', ok: true, stageReached: 'http', delayMs: 12, handshakeMs: 12, totalMs: 30 },
      'manual',
      'lite',
    )

    const st = stat(h.db, 'n1')!
    expect(st.state).toBe('up')
    expect(st.delay_ms).toBe(12)
    expect(st.fail_streak).toBe(0)
    const runs = h.db.select().from(nodeCheckRuns).all()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.source).toBe('manual')
    expect(runs[0]!.stage_reached).toBe('http')
  })
})

