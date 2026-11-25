/**
 * 订阅 → Mihomo file provider → PUT 热加载 的接线测试（task-17）。
 *
 * 用假 client + 临时 engine 目录，覆盖真实链路里最容易坏、且以后改代码必须能红的地方：
 *  1) provider YAML 是确定性的（同输入逐字节相同）且按 proxy 名排序；
 *  2) 每轮同步只 PUT 一次 provider，然后 GET 回读（protocol_supported 以回读为准）；
 *  3) 节点行写入 proxy_name/proxy_source/proxy_json，且 proxy 名 = 'n-' + nodeId 稳定不随改名变化；
 *  4) toClashProxy 表达不了的节点写 run_errors(unsupported_by_engine) 且不进 YAML；
 *  5) provider 刷新失败（503）时保持原 protocol_supported、run 标 failed（不能把节点全标 0）；
 *  6) preview 不依赖引擎（没有 client 也能给出 supported/unsupported）。
 *
 * 这里不联网：inline:// 订阅直接读 subscriptions.content_text；假 client 在 PUT 时读面板刚写的
 * YAML 模拟「引擎实际加载了哪些 proxy」，因此断言的是文件与 DB 的一致性，而不是 mock 的返回值。
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { parse as parseYaml, stringify } from 'yaml'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// crypto 的 keyfile 落在 DATA_DIR；必须在本文件 import 配置模块之前指到临时目录
const dataDir = mkdtempSync(join(tmpdir(), 'xcp-mihomo-sync-'))
process.env.DATA_DIR = dataDir

const { desc, eq } = await import('drizzle-orm')
const { openDb } = await import('../src/core/db')
const { runMigrations } = await import('../src/core/migrations')
const { SettingsStore } = await import('../src/core/settings')
const { EventBus } = await import('../src/core/events')
const { SyncService } = await import('../src/sync/sync')
const { MihomoApiError } = await import('../src/mihomo/client')
const { providerNameOf } = await import('../src/mihomo/config')
const { nodes, nodeSources, subscriptionRunErrors, subscriptionRuns, subscriptions } = await import('../src/core/schema')
type MihomoClient = import('../src/mihomo/client').MihomoClient
type MihomoProxyInfo = import('../src/mihomo/client').MihomoProxyInfo

const FIXTURES = join(import.meta.dir, 'fixtures', 'sub')
const readFixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const resources: { dir: string; engineDir: string; db: ReturnType<typeof openDb> }[] = []
afterEach(() => {
  for (const item of resources.splice(0)) {
    try {
      item.db.raw.close()
    } catch {
      /* 断言失败时测试体里的 close 不会执行，这里兜底 */
    }
    for (const dir of [item.dir, item.engineDir]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* Windows 上 WAL 句柄可能晚一拍释放 */
      }
    }
  }
})
afterAll(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** 假引擎：PUT 时读取面板刚写的 provider 文件，把它当作「实际加载的 proxy」 */
class FakeMihomo {
  requests: { method: string; path: string }[] = []
  providerCalls = 0
  failRefresh = false
  loaded: MihomoProxyInfo[] = []
  constructor(private file: () => string) {}

  async request(path: string, init?: RequestInit): Promise<unknown> {
    const method = (init?.method ?? 'GET').toUpperCase()
    this.requests.push({ method, path })
    if (method !== 'PUT') return undefined
    if (this.failRefresh) throw new MihomoApiError('mihomo reload -> HTTP 503：provider reload failed', 503, path, '')
    // 引擎视角：file provider 读的就是这份 YAML；名字/类型什么都在里面
    const doc = parseYaml(readFileSync(this.file(), 'utf8')) as { proxies?: Record<string, unknown>[] }
    this.loaded = (doc.proxies ?? []).map((p) => ({
      name: String(p.name),
      type: String(p.type),
      alive: true,
      history: [{ time: new Date().toISOString(), delay: 12 }],
    }))
    return undefined
  }

  async provider(name: string): Promise<unknown> {
    this.providerCalls++
    return { name, type: 'Proxy', vehicleType: 'File', proxies: this.loaded }
  }

  putCount(): number {
    return this.requests.filter((r) => r.method === 'PUT').length
  }
}

interface Harness {
  db: ReturnType<typeof openDb>
  sync: InstanceType<typeof SyncService>
  fake: FakeMihomo
  engineDir: string
  subId: string
  file: string
}

function setup(content: string, opts: { withClient?: boolean } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'xcp-sync-db-'))
  const engineDir = mkdtempSync(join(tmpdir(), 'xcp-sync-engine-'))
  const db = openDb(':memory:')
  resources.push({ dir, engineDir, db })
  runMigrations(db)
  const settings = new SettingsStore(db)
  const events = new EventBus(db)
  const subId = 'sub_test_' + Math.random().toString(36).slice(2, 8)
  const now = Date.now()
  db.insert(subscriptions)
    .values({
      id: subId,
      name: 'inline-test',
      url: 'inline://' + subId,
      format_hint: 'auto',
      enabled: 1,
      interval_sec: null,
      cron: null,
      timeout_ms: 5000,
      retries: 0,
      retry_backoff_ms: 500,
      headers_json: null,
      user_agent: null,
      content_text: content,
      created_at: now,
      updated_at: now,
    })
    .run()
  const provider = providerNameOf(subId)
  const file = join(engineDir, 'providers', subId + '.yaml')
  const fake = new FakeMihomo(() => file)
  const sync = new SyncService({
    db,
    settings,
    events,
    engineDir: () => engineDir,
    ...(opts.withClient === false ? {} : { client: () => fake as unknown as MihomoClient }),
  })
  return { db, sync, fake, engineDir, subId, file }
}

/**
 * 最新一次 run。不能只按 started_at 排：快速连续两次同步可能落在同一毫秒，
 * 这里用 finished_at ?? started_at 在 JS 里排，避免拿错 run 断言。
 */
function latestRun(db: ReturnType<typeof openDb>, subId: string) {
  const rows = db.select().from(subscriptionRuns).where(eq(subscriptionRuns.subscription_id, subId)).all()
  rows.sort((a, b) => (b.finished_at ?? b.started_at) - (a.finished_at ?? a.started_at))
  return rows[0]!
}

function nodeRows(db: ReturnType<typeof openDb>) {
  return db.select().from(nodes).all()
}

function yamlProxies(file: string): Record<string, unknown>[] {
  const doc = parseYaml(readFileSync(file, 'utf8')) as { proxies?: Record<string, unknown>[] }
  return doc.proxies ?? []
}

describe('sync → Mihomo file provider', () => {
  test('写 provider 文件、PUT 一次、回读后落库 proxy_name/proxy_source/proxy_json', async () => {
    const h = setup(readFixture('xray-outbounds.json'))
    const result = await h.sync.runSync(h.subId, 'manual')

    expect(result.status).toBe('ok')
    expect(result.added).toBeGreaterThan(5)
    // 引擎侧只认「每轮一次 PUT + 一次回读」，不能退化成轮询 /providers/proxies
    expect(h.fake.requests.filter((r) => r.method === 'PUT').map((r) => r.path)).toEqual([
      '/providers/proxies/' + encodeURIComponent(providerNameOf(h.subId)),
    ])
    expect(h.fake.providerCalls).toBe(1)

    // 文件：按 proxy 名排序、名字都是 n-<nodeId>
    expect(existsSync(h.file)).toBe(true)
    const proxies = yamlProxies(h.file)
    const names = proxies.map((p) => String(p.name))
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    for (const name of names) expect(name).toMatch(/^n-[a-z0-9-]+$/)

    // DB：可发布节点带三列；表达不了的节点（xray grpc multiMode）标 0 且不进 YAML
    const rows = nodeRows(h.db)
    const supported = rows.filter((r) => r.protocol_supported === 1)
    expect(supported.length).toBe(names.length)
    for (const row of supported) {
      expect(row.proxy_name).toMatch(/^n-/)
      expect(row.proxy_source).toBe(providerNameOf(h.subId))
      expect(row.proxy_json).toBeTruthy()
      expect(JSON.parse(row.proxy_json!).name).toBe(row.proxy_name)
      expect(names).toContain(row.proxy_name!)
    }
    const unsupported = rows.find((r) => r.display_name === 'de-vl-01')
    expect(unsupported).toBeDefined()
    expect(unsupported!.protocol_supported).toBe(0)
    expect(unsupported!.proxy_name).toBeNull()

    // node_sources：不可发布节点也算「订阅提供过」，否则 UI 会凭空少节点
    const sources = h.db.select().from(nodeSources).where(eq(nodeSources.subscription_id, h.subId)).all()
    expect(sources.length).toBe(rows.length)

    // run errors：unsupported_by_engine + 原因（不是静默丢弃）
    const errs = h.db.select().from(subscriptionRunErrors).where(eq(subscriptionRunErrors.run_id, latestRun(h.db, h.subId).id)).all()
    const engineErr = errs.find((e) => e.error_kind === 'unsupported_by_engine')
    expect(engineErr).toBeDefined()
    expect(engineErr!.error_msg ?? '').toContain('multiMode')
  })

  test('同样输入两次同步：YAML 逐字节相同，节点不重复新增/修改', async () => {
    const h = setup(readFixture('xray-outbounds.json'))
    await h.sync.runSync(h.subId, 'manual')
    const first = readFileSync(h.file, 'utf8')
    const firstRows = nodeRows(h.db).map((r) => r.id).sort()

    const second = await h.sync.runSync(h.subId, 'manual')
    expect(second.status).toBe('ok')
    expect(second.added).toBe(0)
    expect(second.changed).toBe(0)
    expect(readFileSync(h.file, 'utf8')).toBe(first)
    expect(nodeRows(h.db).map((r) => r.id).sort()).toEqual(firstRows)
    expect(h.fake.putCount()).toBe(2) // 每轮一次，仍然不是轮询
  })

  test('改名不换 proxy 名（Mihomo 同名替换语义），但 display_name 会更新', async () => {
    // 只改 name、server/port/credential 不变 → fingerprint 不变 → 必须是同一个节点、同一个 proxy 名
    const mk = (name: string) =>
      'proxies:\n  - {name: ' + name + ', type: socks5, server: 1.2.3.4, port: 1080}\n'
    const h = setup(mk('HK-01'))

    await h.sync.runSync(h.subId, 'manual')
    const before = nodeRows(h.db)
    expect(before).toHaveLength(1)
    const id = before[0]!.id
    expect(before[0]!.proxy_name).toBe('n-' + id)

    const second = await h.sync.runSync(h.subId, 'manual')
    const after = nodeRows(h.db)
    expect(second.changed).toBe(0) // 订阅内容还没变
    expect(after[0]!.proxy_name).toBe('n-' + id)

    h.db.update(subscriptions).set({ content_text: mk('HK-01-RENAMED') }).where(eq(subscriptions.id, h.subId)).run()
    const third = await h.sync.runSync(h.subId, 'manual')
    const final = nodeRows(h.db)
    expect(third.changed).toBe(1)
    expect(final[0]!.display_name).toBe('HK-01-RENAMED')
    expect(final[0]!.proxy_name).toBe('n-' + id)
  })

  test('provider 刷新失败：保持原 protocol_supported，run 标 failed 并留错误样本', async () => {
    const h = setup(readFixture('xray-outbounds.json'))
    await h.sync.runSync(h.subId, 'manual')
    const before = new Map(nodeRows(h.db).map((r) => [r.id, r.protocol_supported]))

    h.fake.failRefresh = true
    const result = await h.sync.runSync(h.subId, 'manual')
    expect(result.status).toBe('failed')
    expect(result.errorKind).toBe('provider_refresh_failed')
    // 刷新失败不能把节点标 0：所有 protocol_supported 保持原值（尤其不能整批变 0）
    const after = new Map(nodeRows(h.db).map((r) => [r.id, r.protocol_supported]))
    expect([...after.entries()]).toEqual([...before.entries()])
    expect([...after.values()].some((v) => v === 1)).toBe(true)

    const sub = h.db.select().from(subscriptions).where(eq(subscriptions.id, h.subId)).get()!
    expect(sub.last_status).toBe('failed')
    expect(sub.last_error_kind).toBe('provider_refresh_failed')
    const errs = h.db.select().from(subscriptionRunErrors).where(eq(subscriptionRunErrors.run_id, latestRun(h.db, h.subId).id)).all()
    expect(errs.some((e) => e.error_kind === 'provider_refresh_failed')).toBe(true)
  })

  test('未注入 client：runSync loud 失败（engine_unavailable），不写 DB、不写文件', async () => {
    const h = setup(readFixture('xray-outbounds.json'), { withClient: false })
    const result = await h.sync.runSync(h.subId, 'manual')
    expect(result.status).toBe('failed')
    expect(result.errorKind).toBe('engine_unavailable')
    expect(nodeRows(h.db)).toHaveLength(0)
    expect(existsSync(h.file)).toBe(false)
    expect(latestRun(h.db, h.subId).status).toBe('failed')
    expect(latestRun(h.db, h.subId).error_kind).toBe('engine_unavailable')
  })

  test('preview 不依赖引擎，supported 由 toClashProxy 判定', async () => {
    const h = setup('', { withClient: false })
    const preview = await h.sync.preview(readFixture('xray-outbounds.json'), 'auto', 'sub-preview')
    expect(preview.format).toBe('xray')
    expect(preview.total).toBeGreaterThan(5)
    expect(preview.supported + preview.unsupported).toBe(preview.total)
    const deVl = preview.nodes.find((n) => n.name === 'de-vl-01')
    expect(deVl).toBeDefined()
    expect(deVl!.protocolSupported).toBe(false)
    expect(preview.unsupported).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(preview.errors)).toBe(true)
  })
})

/* ==================================================== 真机：provider 文件能被 Mihomo 加载 */

function findMihomo(): string | undefined {
  const exe = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'
  const candidates = [
    process.env['MIHOMO_BIN'] ?? '',
    join(import.meta.dir, '../../../.tools', exe),
    process.platform === 'win32' ? 'D:/tmp/research2/bin/mihomo.exe' : '',
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return undefined
}

const MIHOMO = findMihomo()

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('未能分配端口'))))
    })
  })
}

describe.skipIf(!MIHOMO)('真机 mihomo：panel 生成的 provider 文件能被加载', () => {
  test('启动后 GET /providers/proxies/<name> 的 proxy 名与 DB proxy_name 完全一致', async () => {
    const h = setup(readFixture('xray-outbounds.json'))
    await h.sync.runSync(h.subId, 'manual')
    const expected = nodeRows(h.db)
      .filter((r) => r.protocol_supported === 1)
      .map((r) => r.proxy_name!)
      .sort()
    expect(expected.length).toBeGreaterThan(5)

    const controllerPort = await freePort()
    const listenerPort = await freePort()
    const secret = 'sync-test-' + Date.now().toString(36)
    const providerName = providerNameOf(h.subId)
    // 只声明 provider + 槽位组 + listener：与 publish 最终渲染的形状一致（文件已由 sync 写好）
    const config = {
      'log-level': 'warning',
      'external-controller': '127.0.0.1:' + String(controllerPort),
      secret,
      mode: 'rule',
      'proxy-providers': {
        [providerName]: {
          type: 'file',
          path: 'providers/' + h.subId + '.yaml',
          'health-check': { enable: false, url: 'http://127.0.0.1:1/', interval: 300, lazy: false },
        },
      },
      proxies: [],
      'proxy-groups': [{ name: 'slot-0', type: 'select', use: [providerName], 'empty-fallback': 'REJECT' }],
      listeners: [{ name: 'in-slot-0', type: 'mixed', listen: '127.0.0.1', port: listenerPort, proxy: 'slot-0' }],
      rules: ['MATCH,DIRECT'],
    }
    // engine 目录就是 mihomo 的 -d：provider 文件已经落在 providers/ 下
    writeFileSync(join(h.engineDir, 'config.yaml'), stringify(config), 'utf8')
    const proc = Bun.spawn([MIHOMO!, '-d', h.engineDir, '-f', join(h.engineDir, 'config.yaml')], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    try {
      const { MihomoClient } = await import('../src/mihomo/client')
      const client = new MihomoClient({ baseUrl: () => 'http://127.0.0.1:' + String(controllerPort), secret: () => secret })
      let ready = false
      for (let i = 0; i < 80; i++) {
        try {
          await client.version()
          ready = true
          break
        } catch {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      expect(ready).toBe(true)
      const info = await client.provider(providerName)
      const loaded = (info.proxies ?? []).map((p) => p.name).sort()
      expect(loaded).toEqual(expected)
    } finally {
      proc.kill()
      await proc.exited.catch(() => undefined)
    }
  }, 30_000)
})
