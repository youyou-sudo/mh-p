/**
 * MihomoPublisher：结构同步 + 槽位热指派的单元测试。
 *
 * 全部用假 client / 假 process / 内存 DB（真 FS 用临时目录），不起引擎：
 * 这里要断的是**决策与顺序**（何时写文件、何时 reload、失败怎么还原、哪些槽位要 PUT），
 * 真实引擎行为已由 MIGRATION §6 与 mihomo-process.test.ts 覆盖。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/core/db'
import { EventBus } from '../src/core/events'
import { runMigrations } from '../src/core/migrations'
import { RoutingTable } from '../src/core/routing'
import {
  engineOps,
  engineSlots,
  gatewayRoutes,
  nodeCredentials,
  nodeStatus,
  nodes as nodesT,
  runtimeRevisions,
  subscriptions,
} from '../src/core/schema'
import type { MihomoClient } from '../src/mihomo/client'
import { MihomoPublisher, type MihomoEngineParams } from '../src/publish/mihomo-publish'
import { SlotManager } from '../src/publish/slots'

const PORT_START = 25000
const PORT_END = 25999

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn()
    } catch {
      /* ignore */
    }
  }
})

interface FakeClient {
  trace: string[]
  puts: string[]
  putAttempts: string[]
  gets: string[]
  putFails: Set<string>
  reloads: number
  now: Map<string, string>
  request<T>(path: string, init?: { method?: string; body?: string }): Promise<T>
  reloadFromPath(path: string): Promise<void>
}

// trace 必须与假 process 共用同一个数组，否则断言不了「校验 → reload」的先后顺序
function makeClient(trace: string[]): FakeClient {
  const c: FakeClient = {
    trace,
    puts: [],
    putAttempts: [],
    gets: [],
    putFails: new Set<string>(),
    reloads: 0,
    now: new Map<string, string>(),
    async request<T>(path: string, init: { method?: string; body?: string } = {}): Promise<T> {
      const group = decodeURIComponent(path.replace(/^\/proxies\//, ''))
      if ((init.method ?? 'GET') === 'PUT') {
        const name = String((JSON.parse(init.body ?? '{}') as { name?: unknown }).name ?? '')
        c.putAttempts.push(group + '=' + name)
        if (c.putFails.has(group)) {
          // 真机实测的错误形状（组里还没有这个 proxy 时）
          throw new Error('mihomo /proxies/' + group + ' -> HTTP 400：{"message":"Selector update error: proxy not exist"}')
        }
        c.now.set(group, name)
        c.puts.push(group + '=' + name)
        return undefined as T
      }
      c.gets.push(group)
      return { type: 'Selector', name: group, now: c.now.get(group), all: [] } as T
    },
    async reloadFromPath() {
      c.reloads++
      c.trace.push('reload')
      // 真机实测：整份 reload 会把所有 select 组的选中项重置回组默认值。
      // 假 client 也照此清空，才能测出「reload 之后必须重新对齐槽位」这条。
      c.now.clear()
    },
  }
  return c
}

interface FakeProcess {
  calls: string[]
  fail: { stderr: string; code: number } | null
  testConfig(file: string): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>
}

function makeProcess(trace: string[]): FakeProcess {
  const p: FakeProcess = {
    calls: [],
    fail: null,
    async testConfig(file: string) {
      p.calls.push(file)
      trace.push('test')
      if (p.fail) return { ok: false, code: p.fail.code, stdout: '', stderr: p.fail.stderr }
      return { ok: true, code: 0, stdout: 'configuration file ' + file + ' test is successful', stderr: '' }
    },
  }
  return p
}

interface Harness {
  dir: string
  configDir: string
  configPath: string
  db: Db
  client: FakeClient
  proc: FakeProcess
  routing: RoutingTable
  publisher: MihomoPublisher
}

interface HarnessOpts {
  capacity?: number
  requireMinNodes?: number
  policy?: 'healthy_only' | 'all_enabled'
}

function makeHarness(o: HarnessOpts = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'xcp-pub-'))
  const configDir = join(dir, 'config')
  const configPath = join(configDir, 'config.yaml')
  const db = openDb(join(dir, 't.db'))
  runMigrations(db)
  cleanups.push(() => {
    try {
      db.close()
    } catch {
      /* already closed */
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  const capacity = o.capacity ?? 4
  const trace: string[] = []
  const client = makeClient(trace)
  const proc = makeProcess(trace)
  const slots = new SlotManager(db, () => ({ capacity, portStart: PORT_START, portEnd: PORT_END }))
  const routing = new RoutingTable(db)
  const engine = (): MihomoEngineParams => ({
    externalController: '127.0.0.1:9090',
    secret: 's3cret',
    logLevel: 'warning',
    mode: 'rule',
    slotCapacity: capacity,
    portStart: PORT_START,
    portEnd: PORT_END,
    testUrl: 'http://cp.cloudflare.com/generate_204',
    healthCheckIntervalSec: 300,
  })
  const publisher = new MihomoPublisher({
    db,
    events: new EventBus(db),
    client: client as unknown as MihomoClient,
    process: proc,
    slots,
    routing,
    engine,
    policy: () => ({ policy: o.policy ?? 'healthy_only', requireMinNodes: o.requireMinNodes ?? 0 }),
    dirs: { configDir, configPath, providerDir: join(configDir, 'providers') },
  })
  return { dir, configDir, configPath, db, client, proc, routing, publisher }
}

let seq = 0

/**
 * node_credentials 的密文列名在本仓库的源文件里是被脱敏的字面量，
 * 硬编码写进测试会与 schema 的真实属性名对不上（drizzle 会静默丢掉未知键 → NOT NULL 报错）。
 * 所以从 schema 对象取真实键名，只按后缀认列。
 */
const CRED_KEYS = Object.keys(nodeCredentials)
function credColumn(suffix: string): string {
  const key = CRED_KEYS.find((k) => k.endsWith(suffix))
  if (!key) throw new Error('node_credentials 缺少以 ' + suffix + ' 结尾的列')
  return key
}

function seedNode(
  db: Db,
  o: {
    proxyName?: string
    state?: string
    enabled?: number
    protocol_supported?: number
    is_virtual?: number
    staleUntil?: number | null
    username?: string | null
    policyOverride?: string | null
  } = {},
): string {
  const id = 'n' + String(++seq)
  const at = Date.now()
  db.insert(nodesT)
    .values({
      id,
      display_name: 'node ' + id,
      protocol: 'socks',
      fingerprint: 'fp-' + id,
      params_hash: 'ph-' + id,
      outbound_json: '{}',
      protocol_supported: o.protocol_supported ?? 1,
      enabled: o.enabled ?? 1,
      is_virtual: o.is_virtual ?? 0,
      proxy_name: o.proxyName ?? 'proxy-' + id,
      proxy_source: 'sub-s1',
      publish_policy_override: o.policyOverride ?? null,
      stale_until: o.staleUntil ?? null,
      first_seen_at: at,
      last_seen_at: at,
      created_at: at,
      updated_at: at,
    })
    .run()
  const username = o.username === undefined ? 'u-' + id : o.username
  if (username !== null) {
    const values: Record<string, unknown> = { node_id: id, username, created_at: at }
    values[credColumn('_enc')] = 'enc'
    values[credColumn('_lookup_hash')] = 'h-' + id
    db.insert(nodeCredentials).values(values as never).run()
  }
  if (o.state !== undefined) {
    db.insert(nodeStatus).values({ node_id: id, state: o.state, updated_at: at }).run()
  }
  return id
}

function seedSubscription(db: Db): void {
  const at = Date.now()
  db.insert(subscriptions)
    .values({
      id: 's1',
      name: 'sub one',
      url: 'https://example.com/sub',
      format_hint: 'clash',
      enabled: 1,
      interval_sec: 3600,
      created_at: at,
      updated_at: at,
    })
    .run()
}

const revisions = (db: Db) => db.select().from(runtimeRevisions).all()
const ops = (db: Db) => db.select().from(engineOps).all()
const slotRows = (db: Db) => db.select().from(engineSlots).all()
const routeRows = (db: Db) => db.select().from(gatewayRoutes).all()

describe('MihomoPublisher：结构未变就不碰文件', () => {
  test('config 文本与磁盘逐字节相同 → 不写文件、不跑 -t、不 reload', async () => {
    const h = makeHarness()
    seedNode(h.db, { proxyName: 'node-a' })
    seedSubscription(h.db)

    // 先用 plan() 拿到「正确的文本」，铺到磁盘上（模拟上一轮已经发布过）
    const planned = await h.publisher.plan()
    expect(planned.ok).toBe(true)
    mkdirSync(h.configDir, { recursive: true })
    writeFileSync(h.configPath, planned.configText, 'utf8')
    h.proc.calls.length = 0
    h.client.trace.length = 0

    const out = await h.publisher.publish()

    expect(out.ok).toBe(true)
    expect(out.reloaded).toBe(false)
    expect(h.proc.calls).toEqual([])
    expect(h.client.reloads).toBe(0)
    expect(readFileSync(h.configPath, 'utf8')).toBe(planned.configText)
  }, 30_000)

  test('dryRun 只算不写：不建文件、不调 API、不写库', async () => {
    const h = makeHarness()
    seedNode(h.db, { proxyName: 'node-a' })
    seedSubscription(h.db)

    const out = await h.publisher.publish({ dryRun: true })

    expect(out.ok).toBe(true)
    expect(out.reloaded).toBe(false)
    expect(existsSync(h.configPath)).toBe(false)
    expect(h.proc.calls).toEqual([])
    expect(h.client.reloads).toBe(0)
    expect(h.client.putAttempts).toEqual([])
    expect(revisions(h.db)).toEqual([])
    expect(ops(h.db)).toEqual([])
  }, 30_000)
})

describe('MihomoPublisher：结构变更的顺序与回滚', () => {
  test('结构变了 → 先 write+(-t) 再 reload（顺序不能反）', async () => {
    const h = makeHarness()
    seedNode(h.db, { proxyName: 'node-a' })
    seedSubscription(h.db)

    const out = await h.publisher.publish()

    expect(out.ok).toBe(true)
    expect(out.reloaded).toBe(true)
    // 顺序断言：校验在前、reload 在后（reload 一个没校验过的配置 = 让引擎变砖）
    expect(h.client.trace).toEqual(['test', 'reload'])
    expect(existsSync(h.configPath)).toBe(true)
    const text = readFileSync(h.configPath, 'utf8')
    expect(text).toContain('proxy-providers')
    expect(text).toContain('sub-s1')
    // reload 会重置组的选中项 → 之后必须重新 PUT 一次，否则节点虽然"发布了"却仍走组默认出口
    expect(h.client.putAttempts).toEqual(['slot-0=node-a'])
  }, 30_000)

  test('-t 失败 → 还原上一份 config、不 reload、ok=false', async () => {
    const h = makeHarness()
    seedNode(h.db, { proxyName: 'node-a' })
    seedSubscription(h.db)
    mkdirSync(h.configDir, { recursive: true })
    const previous = 'log-level: error\n# 上一份可用配置\n'
    writeFileSync(h.configPath, previous, 'utf8')
    h.proc.fail = { stderr: 'level=error msg="listener 0: unsupport proxy type: nope"', code: 1 }

    const out = await h.publisher.publish()

    expect(out.ok).toBe(false)
    expect(out.reloaded).toBe(false)
    expect(h.client.reloads).toBe(0)
    expect(h.client.trace).toEqual(['test'])
    expect(readFileSync(h.configPath, 'utf8')).toBe(previous)
    expect(out.error ?? '').toContain('unsupport proxy type')
    // 失败也要留痕，否则面板只能看到「没生效」而不知道为什么
    expect(revisions(h.db)[0]?.status).toBe('failed')
  }, 30_000)
})

describe('MihomoPublisher：槽位热指派', () => {
  test('新节点占空槽并 PUT；已经是目标出口的槽位不重复 PUT', async () => {
    const h = makeHarness({ capacity: 4 })
    const a = seedNode(h.db, { proxyName: 'node-a' })
    const b = seedNode(h.db, { proxyName: 'node-b' })
    seedSubscription(h.db)
    // 结构不变（文本已经铺好）→ 不 reload，于是引擎里的选中项不会被重置，
    // 这时「已经是目标出口」的槽位才真的不该再 PUT。
    const planned = await h.publisher.plan()
    mkdirSync(h.configDir, { recursive: true })
    writeFileSync(h.configPath, planned.configText, 'utf8')
    h.db.insert(engineSlots).values({ slot: 0, node_id: a, port: PORT_START, updated_at: Date.now() }).run()
    h.client.now.set('slot-0', 'node-a')

    const out = await h.publisher.publish()

    expect(out.ok).toBe(true)
    expect(out.reloaded).toBe(false)
    expect(out.assigned).toBe(1) // 只有 b 是净新增
    expect(h.client.puts).toEqual(['slot-1=node-b'])
    expect(h.client.putAttempts).toEqual(['slot-1=node-b'])
    void b
  }, 30_000)

  test('单个槽位 PUT 失败 → 其余照常完成、ok=false、失败节点不进路由', async () => {
    const h = makeHarness({ capacity: 2 })
    seedNode(h.db, { proxyName: 'node-a' })
    seedNode(h.db, { proxyName: 'node-b' })
    seedSubscription(h.db)
    h.client.putFails.add('slot-0')

    const out = await h.publisher.publish()

    expect(out.ok).toBe(false)
    expect(out.error ?? '').toContain('slot-0')
    expect(h.client.puts).toEqual(['slot-1=node-b'])
    // 切换失败的节点不能进路由：那个端口此刻的出口还是旧的，写进去会把用户流量打到别人的出口
    expect(h.routing.size()).toBe(1)
    expect(revisions(h.db)[0]?.status).toBe('failed')
    // 失败明细要能被面板查到
    expect(ops(h.db).filter((o) => o.op === 'assign' && o.ok === 0).length).toBeGreaterThan(0)
  }, 30_000)
})

describe('MihomoPublisher：安全阀', () => {
  test('容量不足 → 拒绝且不写任何东西（文件/槽位/审计/revision）', async () => {
    const h = makeHarness({ capacity: 1 })
    seedNode(h.db, { proxyName: 'node-a' })
    seedNode(h.db, { proxyName: 'node-b' })
    seedSubscription(h.db)

    const out = await h.publisher.publish()

    expect(out.ok).toBe(false)
    expect(out.overflow.length).toBe(1)
    expect(out.error ?? '').toContain('没有槽位')
    expect(existsSync(h.configPath)).toBe(false)
    expect(slotRows(h.db)).toEqual([])
    expect(ops(h.db)).toEqual([])
    expect(revisions(h.db)).toEqual([])
    expect(routeRows(h.db)).toEqual([])
    expect(h.client.reloads).toBe(0)
  }, 30_000)

  test('节点数低于 requireMinNodes → 拒绝且不写任何东西', async () => {
    const h = makeHarness({ capacity: 4, requireMinNodes: 3 })
    seedNode(h.db, { proxyName: 'node-a' })
    seedSubscription(h.db)

    const out = await h.publisher.publish()

    expect(out.ok).toBe(false)
    expect(out.error ?? '').toContain('requireMinNodes')
    expect(existsSync(h.configPath)).toBe(false)
    expect(slotRows(h.db)).toEqual([])
    expect(revisions(h.db)).toEqual([])
  }, 30_000)

  test('过期（stale_until 已到）与隔离节点不参与发布', async () => {
    const h = makeHarness({ capacity: 4, policy: 'healthy_only' })
    seedNode(h.db, { proxyName: 'node-alive' })
    seedNode(h.db, { proxyName: 'node-quarantined', state: 'quarantined' })
    seedNode(h.db, { proxyName: 'node-expired', staleUntil: Date.now() - 1000 })
    seedSubscription(h.db)

    const out = await h.publisher.publish()

    expect(out.ok).toBe(true)
    // 只有 1 个节点上线：隔离的与过期的都被排除
    expect(h.routing.size()).toBe(1)
    expect(h.client.puts).toEqual(['slot-0=node-alive'])
  }, 30_000)
})

describe('MihomoPublisher：currentStatus', () => {
  test('发布成功后 currentStatus 指向这条 revision', async () => {
    const h = makeHarness()
    seedNode(h.db, { proxyName: 'node-a' })
    seedSubscription(h.db)

    expect(h.publisher.currentStatus()).toEqual({ revisionId: null, lastPublishAt: null })
    const out = await h.publisher.publish()
    const st = h.publisher.currentStatus()

    expect(st.revisionId).toBe(out.revisionId)
    expect(st.lastPublishAt).toBeGreaterThan(0)
    expect(revisions(h.db).filter((r) => r.status === 'active').length).toBe(1)
  }, 30_000)
})
