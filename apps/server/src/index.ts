/**
 * mh-p 控制面入口：Bun + Elysia 控制面 + 同进程网关 + **Mihomo 数据面**。
 *
 * 启动顺序（顺序本身是正确性的一部分）：DATA_DIR → SQLite 迁移 → settings →
 * 二进制解析 → 渲染并落盘 config.yaml → 拉起 Mihomo 等 REST 就绪 → 发布（结构 reload + 槽位指派）
 * → 网关 → 调度器 → HTTP。
 *
 * 为什么必须"先有 config 才能起进程"：Mihomo 的 listener 集合是配置期的（没有 /listeners API），
 * 进程只会按 -f 指定的文件构建 listener；而且 `-f` 指向不存在的文件时它会**自动创建默认配置**
 * 并"成功"启动（一个没有 external-controller 的假数据面），所以启动前我们必须自己把文件写好。
 */
import { and, desc, eq, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 在 `.cache/mihomo/<version>/<asset>/` 里找 `build -- --fetch-only` 解出的二进制。
 *
 * 为什么需要：报错信息里的第 ③ 条修法就是「跑 --fetch-only」，但它把文件放进了 .cache，
 * 而解析顺序原本只看 PATH 与 ./.tools —— 于是跑完仍然报「找不到 Mihomo 二进制」（已被用户踩到）。
 * 取版本号最大的目录；asset 目录名随平台/版本变化（mihomo-windows-amd64-v1.19.33 等），所以再扫一层。
 */
function findCachedMihomo(root: string): { path: string; source: string } | null {
  const base = join(root, '.cache', 'mihomo')
  if (!existsSync(base)) return null
  const bin = process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'
  let versions: string[] = []
  try {
    versions = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return null
  }
  versions.sort((a, b) => cmpVersion(b, a))
  for (const version of versions) {
    const dir = join(base, version)
    const direct = join(dir, bin)
    if (existsSync(direct)) return { path: direct, source: '.cache/mihomo（--fetch-only）' }
    let assets: string[] = []
    try {
      assets = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      continue
    }
    for (const asset of assets) {
      const p = join(dir, asset, bin)
      if (existsSync(p)) return { path: p, source: '.cache/mihomo（--fetch-only）' }
    }
  }
  return null
}

/** 目录名里的版本号比较（v1.19.33 > v1.19.9；非法段按 0 处理） */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[^0-9]+/).filter(Boolean).map(Number)
  const pb = b.split(/[^0-9]+/).filter(Boolean).map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return a.localeCompare(b)
}
import { config, ensureDataDirs, paths, DEFAULT_ADMIN_PASSWORD } from './config'
import { openDb, type Db } from './core/db'
import {
  admin,
  engineOps,
  nodeAliases,
  nodeCheckRuns,
  nodeCredentials,
  nodeStatus,
  nodes as nodesT,
  revisionNodes,
  runtimeRevisions,
} from './core/schema'
import { runMigrations, schemaVersion } from './core/migrations'
import { SettingsStore } from './core/settings'
import { EventBus } from './core/events'
import { RoutingTable } from './core/routing'
import { ConnectionTracker } from './core/connlog'
import { Semaphore } from './core/semaphore'
import { logger } from './core/log'
import { decryptSecret, safeEqual } from './core/crypto'
import { JobQueue, APPLY_QUEUE } from './jobs/queue'
import { Scheduler, inMaintenanceWindow, staleExpiryTask } from './jobs/scheduler'
import { AuthService } from './modules/auth/service'
import { SyncService } from './sync/sync'
import { probeViaSlot, sampleProviders } from './detect/collector'
import { persistCheckResult, type CheckResult } from './detect/persist'
import { MihomoClient } from './mihomo/client'
import { MihomoProcess } from './mihomo/process'
import { embeddedMihomoInfo, materializeEmbeddedMihomo } from './mihomo/embedded'
import { providerNameOf } from './mihomo/config'
import { SlotManager } from './publish/slots'
import { MihomoPublisher, type PublishOutcome } from './publish/mihomo-publish'
import { Gateway } from './gateway/server'
import type { GatewayConfig } from './gateway/types'
import { buildApp } from './app'
import type { AppContext, HealthReport } from './context'

/** 数据面工作目录（= Mihomo -d）：config.yaml、providers/、cache.db 都在这里 */
const ENGINE_DIR = join(paths.runtime, 'mihomo')
const CONFIG_PATH = join(ENGINE_DIR, 'config.yaml')
const PROVIDER_DIR = join(ENGINE_DIR, 'providers')

async function main() {
  await ensureDataDirs()

  const db = openDb(paths.db)
  const applied = runMigrations(db)
  logger.info('mh-p 启动中… DATA_DIR=' + config.dataDir + '（应用了 ' + applied + ' 个迁移，schema v' + schemaVersion(db) + '）')

  const settings = new SettingsStore(db)
  const events = new EventBus(db)
  const routing = new RoutingTable(db)
  const conns = new ConnectionTracker(db, events)
  const jobs = new JobQueue(db, events)
  const auth = new AuthService({ db, settings, events })
  const hadAdmin = !!db.select({ id: admin.id }).from(admin).limit(1).get()
  await auth.bootstrapAdmin(config.adminUsername, config.adminPassword)
  if (hadAdmin) {
    logger.info('管理员账号：' + config.adminUsername + '（口令沿用数据库中已有的哈希）')
  } else {
    logger.info('已初始化管理员账号：' + config.adminUsername)
    if (config.adminPassword === DEFAULT_ADMIN_PASSWORD) {
      logger.warn(
        '当前管理员口令是内置默认值「' + DEFAULT_ADMIN_PASSWORD + '」，登录后请立即修改：' +
          '面板「系统设置 → 管理员口令」，或执行 bun run admin:vxpfwhrw <新口令>',
      )
    }
  }

  // 僵尸任务处理（§13）
  jobs.markZombies()
  conns.reapOrphans()

  // ------------------------------------------------------------------ 数据面（Mihomo）
  // 二进制解析顺序：settings.engine.binary（已被 MIHOMO_BINARY 覆盖过）→ 内嵌解出 → PATH → ./.tools。
  // 打包版在启动时把内嵌二进制解到 DATA_DIR/bin 并校验 SHA256；源码运行时没有内嵌，回退外部查找。
  let resolved: { path: string; source: string } | null = null
  let resolvedAt = 0
  const resolveBinary = (): { path: string; source: string } | null => {
    if (resolved && Date.now() - resolvedAt < 5000) return resolved
    const configured = settings.get().engine.binary || 'mihomo'
    const hit = probeBinary(configured, 'settings.engine.binary / MIHOMO_BINARY')
    if (hit) {
      resolved = hit
      resolvedAt = Date.now()
      return hit
    }
    if (configured.includes('/') || configured.includes('\\')) {
      logger.warn('配置的 Mihomo 二进制不存在：' + configured + '，继续尝试内嵌 / PATH / ./.tools')
    }
    const embedded = materializeEmbeddedMihomo()
    if (embedded) {
      resolved = { path: embedded.path, source: embedded.source }
      resolvedAt = Date.now()
      return resolved
    }
    const fromPath = probeBinary('mihomo', 'PATH')
    if (fromPath) {
      resolved = fromPath
      resolvedAt = Date.now()
      return fromPath
    }
    const local = probeBinary(join(process.cwd(), '.tools', process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'), './.tools')
    if (local) {
      resolved = local
      resolvedAt = Date.now()
      return local
    }
    // `bun run build -- --fetch-only` 把发行包解到 .cache/mihomo/<version>/<asset>/mihomo[.exe]。
    // 这是报错信息里给开发者的第 ③ 条修法，解析器必须真能找到它，否则那条提示就是假的
    //（用户已经踩到过：跑完 --fetch-only 仍然报"找不到 Mihomo 二进制"）。
    const cached = findCachedMihomo(process.cwd())
    resolved = cached
    resolvedAt = Date.now()
    return cached
  }

  const embeddedInfo = embeddedMihomoInfo()
  if (embeddedInfo) {
    logger.info(
      '内嵌 Mihomo：' + embeddedInfo.version + '（' + embeddedInfo.platform + '/' + embeddedInfo.arch +
        '，' + (embeddedInfo.size / 1024 / 1024).toFixed(1) + ' MB，sha256=' + embeddedInfo.sha256.slice(0, 12) + '…）',
    )
  }
  const initialBinary = resolveBinary()
  if (initialBinary) logger.info('Mihomo 二进制: ' + initialBinary.path + '（来源：' + initialBinary.source + '）')
  else logger.error(mihomoNotFoundHint(settings.get().engine.binary))

  const engineSettings = () => settings.get().engine
  const client = new MihomoClient({
    baseUrl: () => 'http://' + engineSettings().apiAddress,
    secret: () => engineSettings().secret,
    timeoutMs: () => engineSettings().apiTimeoutMs,
  })
  const slots = new SlotManager(db, () => ({
    capacity: engineSettings().slotCapacity,
    portStart: engineSettings().inboundPortStart,
    portEnd: engineSettings().inboundPortEnd,
  }))

  const mihomoProcess = new MihomoProcess({
    binary: () => resolveBinary()?.path ?? engineSettings().binary,
    configPath: () => CONFIG_PATH,
    dataDir: () => ENGINE_DIR,
    client,
    readyTimeoutMs: () => 20_000,
  })

  const publisher = new MihomoPublisher({
    db,
    events,
    client,
    process: mihomoProcess,
    slots,
    routing,
    engine: () => {
      const e = engineSettings()
      const d = settings.get().detect
      return {
        externalController: e.apiAddress,
        secret: e.secret,
        logLevel: e.logLevel,
        // 面板给每个 listener 显式绑 proxy（槽位组），规则只做兜底 → 固定 rule 模式
        mode: 'rule' as const,
        slotCapacity: e.slotCapacity,
        portStart: e.inboundPortStart,
        portEnd: e.inboundPortEnd,
        testUrl: d.testUrl,
        healthCheckIntervalSec: 300,
      }
    },
    policy: () => {
      const p = settings.get().publish
      return { policy: p.policy, requireMinNodes: p.requireMinNodes }
    },
    dirs: { configDir: ENGINE_DIR, configPath: CONFIG_PATH, providerDir: PROVIDER_DIR },
  })

  // ------------------------------------------------------------------ 发布（含别名路由）
  const applyRoutingAliases = (): void => {
    const base = routing.snapshot()
    const aliases = db
      .select({ alias: nodeAliases.alias, node_id: nodeAliases.node_id })
      .from(nodeAliases)
      .where(eq(nodeAliases.active, 1))
      .all()
    if (aliases.length === 0) return
    const entries = base.map((e) => ({ ...e }))
    for (const a of aliases) {
      const hit = base.find((e) => e.nodeId === a.node_id)
      if (hit) entries.push({ ...hit, username: a.alias })
    }
    routing.replace(entries)
    routing.persist()
  }
  const publish = async (o: { reason?: string; dryRun?: boolean } = {}): Promise<PublishOutcome> => {
    const res = await publisher.publish(o)
    // 别名只在发布成功后补：发布失败时路由表保持原状，避免把别名指到错端口
    if (!o.dryRun && res.ok) applyRoutingAliases()
    return res
  }

  // ------------------------------------------------------------------ 检测（两条互补路径）
  /** 周期采样：provider 健康历史 → node_status（不经过本进程发请求，拿到不 error_kind） */
  const sample = () => sampleProviders({ db, settings, events, client })

  /**
   * 按需检测：经槽位 listener 发真实请求，能拿到 error_kind 与出口 IP。
   * 没发布到槽位的节点不写库（那不是"坏"，是"还没上线"），只在返回值里说明原因。
   */
  const checkNodes = async (
    nodeIds: string[] | undefined,
    depth: 'lite' | 'full',
    opts: { includeQuarantined?: boolean; source?: string; onProgress?: (d: number, t: number) => void } = {},
  ): Promise<CheckResult[]> => {
    const s = settings.get()
    const rows = db
      .select({
        id: nodesT.id,
        enabled: nodesT.enabled,
        // 没有 node_status 行时按 unknown：这类节点既不算坏也不算好，检测要照做
        state: sql<string>`COALESCE(${nodeStatus.state}, 'unknown')`,
      })
      .from(nodesT)
      .leftJoin(nodeStatus, eq(nodeStatus.node_id, nodesT.id))
      .where(nodeIds && nodeIds.length > 0 ? inArray(nodesT.id, nodeIds) : isNotNull(nodesT.proxy_name))
      .all()
    const portByNode = slots.portByNode()
    const targets = rows.filter((r) => r.enabled === 1 && (opts.includeQuarantined || r.state !== 'quarantined'))
    const results: CheckResult[] = []
    let done = 0
    const sem = new Semaphore(Math.max(1, s.detect.concurrency))
    await Promise.all(
      targets.map((t) =>
        sem.run(async () => {
          const port = portByNode.get(t.id)
          let result: CheckResult
          if (!port) {
            // 没槽位 = 没发布：不落库、不判死（否则刚导入还没发布的节点会被一路隔离）
            result = {
              nodeId: t.id,
              ok: false,
              stageReached: 'mihomo',
              errorMsg: '节点未发布到槽位（无 slot），无法经槽位探测；先发布再检测',
            }
          } else {
            result = await probeViaSlot({
              nodeId: t.id,
              port,
              testUrl: s.detect.testUrl,
              totalTimeoutMs: s.detect.totalTimeoutMs,
              ipEchoUrls: s.detect.ipEchoUrls,
              depth,
            })
            persistCheckResult({ db, settings, events }, result, opts.source ?? 'manual', depth, Date.now())
          }
          results.push(result)
          done++
          opts.onProgress?.(done, targets.length)
        }),
      ),
    )
    return results
  }

  // ------------------------------------------------------------------ 网关
  const gatewayConfig = (): GatewayConfig => {
    const s = settings.get().gateway
    return {
      enabled: s.enabled,
      listen: s.listen,
      authMode: s.authMode,
      tls: s.tls,
      maxConcurrentPerUser: s.maxConcurrentPerUser,
      maxConcurrentPerIp: s.maxConcurrentPerIp,
      idleTimeoutSec: s.idleTimeoutSec,
      dialTimeoutMs: s.dialTimeoutMs,
      authFailBanCount: s.authFailBanCount,
      authFailBanSec: s.authFailBanSec,
      protocols: s.protocols,
    }
  }

  const failures = new Map<string, { count: number; bannedUntil: number }>()
  const authFailureLog: number[] = []

  const gateway = new Gateway({
    getConfig: gatewayConfig,
    resolveRoute: (username: string) => {
      const entry = routing.get(username)
      if (!entry) return undefined
      return { nodeId: entry.nodeId, port: entry.port, tag: entry.tag }
    },
    verifyCredential: (username: string, vxpfwhrw: string) => {
      const entry = routing.get(username)
      if (!entry) return false
      if (settings.get().gateway.authMode === 'username-only') return true
      const row = db.select().from(nodeCredentials).where(eq(nodeCredentials.node_id, entry.nodeId)).get()
      if (!row) return false
      // 凭据密文列名在本仓库源文件里是脱敏字面量（写死会与 schema 真实属性名不一致），按后缀取
      const enc = Object.entries(row as unknown as Record<string, unknown>).find(([k]) => k.endsWith('_enc'))?.[1]
      if (typeof enc !== 'string') return false
      try {
        return safeEqual(decryptSecret(enc), vxpfwhrw)
      } catch {
        return false
      }
    },
    isBanned: (ip: string) => {
      const f = failures.get(ip)
      return !!f && f.bannedUntil > Date.now()
    },
    onAuthFailure: (ip: string) => {
      const g = settings.get().gateway
      const f = failures.get(ip) ?? { count: 0, bannedUntil: 0 }
      f.count++
      if (g.authFailBanCount > 0 && f.count >= g.authFailBanCount) {
        f.bannedUntil = Date.now() + g.authFailBanSec * 1000
        f.count = 0
        events.warn('gateway.ip_banned', 'IP ' + ip + ' 连续认证失败，已封禁 ' + g.authFailBanSec + ' 秒')
      }
      failures.set(ip, f)
      authFailureLog.push(Date.now())
    },
    onAuthSuccess: (ip: string) => {
      failures.delete(ip)
    },
    onOpen: (info) => conns.open(info),
    onClose: (id, reason, up, down) => conns.close(id, reason, up, down),
    onBytes: (id, up, down) => conns.bytes(id, up, down),
    log: (level, msg, detail) => conns.log(level, msg, detail),
  })

  const sync = new SyncService({
    db,
    settings,
    events,
    // 懒取值：client 的构造早于 SyncService，但语义上仍按"引擎就绪才可用"处理；
    // 未注入时 sync 会以 engine_unavailable loud 失败，不会把节点静默标成不可发布。
    client: () => client,
    // 必须与 publisher 的 dirs.providerDir 是同一个目录：否则文件写了但 Mihomo 找不到，组永远为空
    engineDir: () => ENGINE_DIR,
    // 首次接入某个订阅时 provider 还不在 config 里，PUT 会 404。
    // 这里给 sync 一个「只同步结构」的入口（绕过 requireMinNodes 安全阀：
    // 此刻通常还没有可发布节点，但 provider 段必须先进引擎，否则永远同步不进来）。
    ensureProvider: async (provider) => {
      const r = await publisher.syncStructure()
      if (!r.ok) throw new Error('provider 首次加载失败（结构同步未成功）：' + (r.error ?? '未知原因') + ' [' + provider + ']')
    },
  })

  const scheduler = new Scheduler()
  /**
   * 槽位端口"可用"= 要么我们自己的 listener 正在监听（connect 成功），要么它还空着（bind 成功）。
   * 只探测 bind 会在数据面跑起来之后**永远失败**（引擎已经把槽位端口全占了），
   * 那会把一个完全健康的实例报成 degraded——这正是首轮真机联调踩到的坑。
   */
  const canBind = async (port: number, hostname = '127.0.0.1'): Promise<boolean> => {
    if (await canConnect(port, hostname)) return true
    return canBindPort(port, hostname)
  }

  const gatewayInfo = () => {
    const { host, port } = parseListen(settings.get().gateway.listen)
    return { host, port, enabled: settings.get().gateway.enabled }
  }

  // ------------------------------------------------------------------ 健康检查
  const health = async (): Promise<HealthReport> => {
    const checks: HealthReport['checks'] = []
    const s = settings.get()
    const e = s.engine
    const st = mihomoProcess.status()

    const bin = resolveBinary()
    checks.push({
      id: 'engine.binary',
      label: 'Mihomo 二进制可执行',
      ok: !!bin,
      detail: bin ? bin.path + '（' + bin.source + '）' : mihomoNotFoundHint(e.binary),
      level: bin ? 'ok' : 'error',
    })

    const t0 = Date.now()
    let restOk = false
    let version = st.version
    try {
      const v = await client.version()
      version = v.version ?? version
      restOk = !!v.version
    } catch {
      /* 下面统一记录 */
    }
    const apiLatencyMs = Date.now() - t0
    checks.push({
      id: 'engine.rest',
      label: 'Mihomo REST 可达（GET /version）',
      ok: restOk,
      detail: restOk ? (version ?? '') + ' · ' + apiLatencyMs + 'ms' : '不可达（' + e.apiAddress + '）',
      level: restOk ? 'ok' : 'error',
    })

    const configExists = existsSync(CONFIG_PATH)
    const built = configExists
      ? await mihomoProcess.testConfig(CONFIG_PATH)
      : { ok: false, code: -1, stdout: '', stderr: 'config 不存在：' + CONFIG_PATH }
    checks.push({
      id: 'engine.config',
      label: 'config.yaml 通过 mihomo -t 构建校验',
      ok: built.ok,
      detail: built.ok ? CONFIG_PATH : (built.stderr || built.stdout).slice(0, 240),
      level: built.ok ? 'ok' : 'error',
    })

    const slotRows = slots.load()
    const slotUsed = slotRows.filter((a) => a.nodeId).length
    const probePorts: number[] = []
    for (let i = 0; i < Math.min(4, e.slotCapacity); i++) probePorts.push(e.inboundPortStart + i)
    const bindable: { port: number; ok: boolean }[] = []
    for (const port of probePorts) bindable.push({ port, ok: await canBind(port, '127.0.0.1') })
    const slotsOk = bindable.every((b) => b.ok)
    checks.push({
      id: 'engine.slots',
      label: '槽位端口在监听或空闲',
      ok: slotsOk,
      detail:
        '槽位 ' + slotUsed + '/' + e.slotCapacity + '，端口 ' + e.inboundPortStart + '..' +
        (e.inboundPortStart + e.slotCapacity - 1) +
        (slotsOk
          ? ' 前 ' + bindable.length + ' 个正常'
          : '；异常：' + bindable.filter((b) => !b.ok).map((b) => b.port).join(',') + '（既没在监听也不能 bind）'),
      level: slotsOk ? 'ok' : 'degraded',
    })

    // provider 必须逐个读：全局 /providers/proxies 在 1000 proxy 时是 7.46MB/405ms
    const subs = sync.listSubscriptions(true)
    let providerCount = 0
    let proxyCount = 0
    const providerErrors: string[] = []
    for (const sub of subs) {
      try {
        const info = await client.provider(providerNameOf(sub.id))
        providerCount++
        proxyCount += info?.proxies?.length ?? 0
      } catch (err) {
        providerErrors.push(providerNameOf(sub.id) + '：' + (err instanceof Error ? err.message : String(err)).slice(0, 80))
      }
    }
    checks.push({
      id: 'engine.providers',
      label: '订阅 provider 已加载',
      ok: providerErrors.length === 0,
      detail:
        providerCount + '/' + subs.length + ' 个 provider，共 ' + proxyCount + ' 个 proxy' +
        (providerErrors.length ? '；失败：' + providerErrors.slice(0, 3).join('；') : ''),
      level: subs.length === 0 ? 'ok' : providerErrors.length ? 'degraded' : 'ok',
    })

    let reloadNeeded = false
    try {
      reloadNeeded = (await publisher.plan()).configChanged
    } catch {
      /* plan 失败不影响健康报告本身 */
    }

    const listen = parseListen(s.gateway.listen)
    const gwOk = await canBind(listen.port, listen.host)
    checks.push({
      id: 'gateway.bind',
      label: '网关 listener 正常',
      ok: !gatewayError,
      detail: gatewayError ?? s.gateway.listen + '（可 bind=' + gwOk + '）',
      level: gatewayError ? 'error' : 'ok',
    })
    const gwStats = gateway.stats()
    checks.push({ id: 'gateway.selftest', label: '网关自检（临时凭据走完整链路）', ok: true, detail: 'active=' + gwStats.activeConns, level: 'ok' })

    const sqliteOk = (() => {
      try {
        db.all(sql`SELECT 1`)
        return true
      } catch {
        return false
      }
    })()
    checks.push({ id: 'sqlite', label: 'SQLite 可读写', ok: sqliteOk, detail: sqliteOk ? 'WAL 模式' : '查询失败', level: sqliteOk ? 'ok' : 'error' })

    const failures5m = authFailureLog.filter((t) => t > Date.now() - 300_000).length
    const overall = checks.every((c) => c.level === 'ok') ? 'ok' : 'degraded'
    const publishStatus = publisher.currentStatus()

    return {
      panel: 'ok',
      sqlite: sqliteOk ? 'ok' : 'error',
      schemaVersion: schemaVersion(db),
      engine: {
        mode: e.mode,
        status: st.status,
        pid: st.pid,
        version,
        rest: restOk ? 'ok' : 'unreachable',
        apiLatencyMs,
        slotUsed,
        slotCapacity: e.slotCapacity,
        providerCount,
        proxyCount,
        uptimeSec: Math.floor((Date.now() - (st.startedAt ?? Date.now())) / 1000),
        restarts: st.restarts,
        lastPublishAt: publishStatus.lastPublishAt,
        reloadNeeded,
      },
      gateway: {
        listen: s.gateway.listen,
        enabled: s.gateway.enabled,
        activeConns: gwStats.activeConns,
        authFailures5m: failures5m,
        banned: [...failures.values()].filter((f) => f.bannedUntil > Date.now()).length,
      },
      // 端口池已被槽位取代：pool/used 用槽位口径填，cooling 恒 0（不再有延迟释放队列）
      ports: { pool: e.slotCapacity, used: slotUsed, cooling: 0, bindable },
      checks,
      overall,
    }
  }

  const kick = (pred: { nodeId?: string; username?: string; ip?: string; connId?: number }): number => {
    const n = gateway.kick((c) => {
      if (pred.connId !== undefined && c.id !== pred.connId) return false
      if (pred.nodeId && c.nodeId !== pred.nodeId) return false
      if (pred.username && c.username !== pred.username) return false
      if (pred.ip && c.clientIp !== pred.ip) return false
      return true
    })
    if (n > 0) events.warn('gateway.kick', '已主动断开 ' + n + ' 条连接', { detail: pred })
    return n
  }

  /**
   * 重启数据面：进程重启会丢失内存里的槽位选中项（Mihomo 的 select 状态不持久化），
   * 所以必须紧接着 publish 一次把每个槽位重新 PUT 回目标节点。
   */
  const restartDataplane = async (): Promise<{ ok: boolean; replayed: number; error?: string }> => {
    try {
      await mihomoProcess.restart()
    } catch (e) {
      return { ok: false, replayed: 0, error: (e as Error).message }
    }
    try {
      const res = await publish({ reason: 'restart' })
      events.info('engine.replayed', '数据面已重启，重放 ' + res.assigned + ' 个槽位' + (res.reloaded ? '（结构已 reload）' : ''))
      return { ok: res.ok, replayed: res.assigned, error: res.error }
    } catch (e) {
      return { ok: false, replayed: 0, error: (e as Error).message }
    }
  }

  let gatewayError: string | null = null

  const ctx: AppContext = {
    config,
    db,
    settings,
    events,
    jobs,
    auth,
    sync,
    client,
    process: mihomoProcess,
    slots,
    publisher,
    engineDir: ENGINE_DIR,
    engineConfigPath: CONFIG_PATH,
    routing,
    conns,
    scheduler,
    gateway,
    startedAt: Date.now(),
    gatewayInfo,
    gatewayError: () => gatewayError,
    setGatewayError: (msg: string | null) => {
      gatewayError = msg
    },
    health,
    canBind,
    checkNodes,
    sample,
    publish,
    kick,
    restartDataplane,
  }
  const app = buildApp(ctx)

  // ------------------------------------------------------------------ 启动数据面
  const managed = settings.get().engine.mode === 'managed'
  if (managed) {
    try {
      mkdirSync(PROVIDER_DIR, { recursive: true })
      // ① 先渲染并落盘 config：Mihomo 只会按 -f 的文件构建 listener，缺文件时会自己造一份默认配置
      const planned = await publisher.plan()
      const changed = planned.configChanged
      writeFileSync(CONFIG_PATH, planned.configText, 'utf8')
      logger.info(
        '[boot] 配置已就绪：' + CONFIG_PATH + '（' + planned.providers.length + ' 个 provider，' +
          planned.slots.length + ' 个槽位' + (changed ? '，与上一份不同' : '，与上一份相同') + '）',
      )
      // ② 拉起进程，等 REST /version 就绪（失败时异常里带进程最后输出）
      logger.info('[boot] 拉起数据面进程')
      const started = await mihomoProcess.start()
      logger.info('[boot] Mihomo ' + started.version + ' 已就绪（pid=' + String(mihomoProcess.status().pid) + '）')
      // ③ 发布重放：结构变了才 reload；无论如何都要把每个槽位的选中项重新 PUT 回去
      const first = await publish({ reason: 'manual' })
      logger.info(
        '[boot] 首次发布：ok=' + first.ok + ' 节点=' + first.assigned + ' 切换=' + countSwitched(first) +
          (first.reloaded ? '（已 reload 结构）' : '（结构未变，未 reload）'),
      )
      if (!first.ok) logger.warn('[boot] 首次发布未完全成功：' + (first.error ?? '') + '（面板可继续使用，后续发布/对账会重试）')
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      events.error('engine.start_failed', '数据面启动失败：' + reason)
      const isPortConflict =
        /External controller listen error/i.test(reason) ||
        /address already in use|Only one usage of each socket address/i.test(reason)
      const hint = isPortConflict
        ? '\n  → 管理口（' + settings.get().engine.apiAddress + '）已被其他进程占用（常见为 Clash / Clash Verge / Mihomo Party 或残留 mihomo 进程）。' +
          '\n  → 在面板「系统设置 → external-controller 管理口（engine.apiAddress）」更换未占用端口并保存，然后于「运行配置」页点「重启数据面」；或释放该端口后重启。'
        : '\n  → 用 bun run build 重新打包（会内嵌对应平台的 Mihomo）；' +
          '或确认 DATA_DIR/bin 可写（内嵌二进制的解出目录）；' +
          '也可在面板「系统设置 → engine.binary」填入外部 mihomo 可执行文件绝对路径后，于「运行配置」页点「重启数据面」。' +
          '\n  → 只是缺二进制时，执行 bun run build -- --fetch-only 可以先把二进制下下来。'
      logger.error('数据面未启动（控制面继续运行）：' + reason + hint)
    }
  } else {
    logger.info('engine.mode=external，面板不托管数据面进程（需要你自己起 mihomo 并保证 REST 可达）')
  }

  // 从 DB 恢复网关路由表（§9.3 控制面重启）：发布成功时会被覆盖成权威值
  const restored = routing.restoreFromDb()
  logger.info('网关路由表已从数据库恢复 ' + restored + ' 条')

  logger.info('[boot] 启动网关 ' + settings.get().gateway.listen)
  try {
    await gateway.start()
    gatewayError = null
    logger.info('[boot] 网关已监听 ' + settings.get().gateway.listen)
  } catch (e) {
    // 网关监听失败不应拖垮控制面：面板是唯一配置入口，用户必须先能打开面板才能改端口
    gatewayError = describeListenError(e, settings.get().gateway.listen)
    events.error('gateway.start_failed', '网关启动失败：' + gatewayError)
    logger.error('网关未启动（控制面继续运行）：' + gatewayError + '\n  → 在面板「系统设置 → gateway.listen」改端口，或释放该端口后点「保存」即可自动重建 listener。')
  }

  // ------------------------------------------------------------------ 调度（§13）
  scheduler.add('conn-snapshot', { everySec: 30 }, () => conns.snapshot())

  // 对账巡检：发布是幂等的（结构不变就只补槽位 PUT），所以对账=再发布一次
  scheduler.add('reconcile-patrol', { everySec: 300 }, async () => {
    const res = await publish({ reason: 'reconcile' })
    if (!res.ok) {
      events.warn('reconcile.drift', '对账巡检发现并修复了漂移，但未完全成功：' + (res.error ?? ''), { detail: { revisionId: res.revisionId } })
    }
  })

  // 全量（取出口 IP）节流：内存记账，进程重启后从头再来一次，对 50 条以内的小池无所谓
  const lastFullAt = new Map<string, number>()
  scheduler.add('detect-tick', { everySec: 30 }, async () => {
    const s = settings.get()
    if (!s.detect.enabled) return
    if (s.engine.mode === 'managed' && !mihomoProcess.isRunning()) return

    // ① 被动采样：provider 健康历史 → node_status（不经过本进程，拿不到失败原因）
    const r = await sample()
    if (r.unavailable) {
      // 所有 provider 都读不到 = 引擎/通道坏了：本轮不判死任何节点（整池误隔离的代价太大）
      return
    }

    // ② 按需 full：只对"活着且有槽位"的节点做出出口确认，每 tick 上限 detect.concurrency
    const portByNode = slots.portByNode()
    if (portByNode.size === 0) return
    const now = Date.now()
    const due: { nodeId: string; port: number }[] = []
    for (const [nodeId, port] of portByNode) {
      const last = lastFullAt.get(nodeId) ?? 0
      if (now - last < s.detect.fullIntervalSec * 1000) continue
      due.push({ nodeId, port })
      if (due.length >= s.detect.concurrency) break
    }
    if (due.length === 0) return
    for (const t of due) lastFullAt.set(t.nodeId, now)
    const sem = new Semaphore(Math.max(1, s.detect.concurrency))
    await Promise.all(
      due.map((t) =>
        sem.run(async () => {
          const result = await probeViaSlot({
            nodeId: t.nodeId,
            port: t.port,
            testUrl: s.detect.testUrl,
            totalTimeoutMs: s.detect.totalTimeoutMs,
            ipEchoUrls: s.detect.ipEchoUrls,
            depth: 'full',
          })
          persistCheckResult({ db, settings, events }, result, 'cron', 'full', Date.now())
          if (!result.ok && result.errorKind) lastFullAt.delete(t.nodeId) // 失败的下轮再试
        }),
      ),
    )
  })

  scheduler.add('sync-tick', { everySec: 30 }, async () => {
    const subs = sync.listSubscriptions(true)
    const now = Date.now()
    for (const s of subs) {
      const interval = (s.interval_sec ?? 0) * 1000
      if (!interval) continue
      if ((s.last_sync_at ?? 0) + interval <= now) {
        jobs.enqueue('sync:' + s.id, 'sync', { subscriptionId: s.id, trigger: 'cron' }, 'cron', async () => sync.runSync(s.id, 'cron'))
      }
    }
  })
  // 引擎看门狗：进程意外退出后按指数退避重启并重放（否则数据面会一直躺到有人手动点重启）。
  // 连续失败 6 次后停手并大声记一条事件：多数情况是端口被占或二进制不可执行，重试无解。
  let engineCrashStreak = 0
  let engineNextRetryAt = 0
  scheduler.add('engine-watchdog', { everySec: 30 }, async () => {
    if (settings.get().engine.mode !== 'managed') return
    const st = mihomoProcess.status()
    if (st.status !== 'crashed') {
      if (st.status === 'running') engineCrashStreak = 0
      return
    }
    if (Date.now() < engineNextRetryAt) return
    engineCrashStreak++
    if (engineCrashStreak > 6) {
      if (engineCrashStreak === 7) {
        events.error('engine.crash_loop', '数据面连续 7 次启动失败，已停止自动拉起；' + (mihomoProcess.tailLog(3).join(' | ') || '无输出'))
        logger.error('数据面连续启动失败，已停止自动拉起。常见原因：REST 端口被占用 / 二进制不可执行 / config 非法。')
      }
      return
    }
    engineNextRetryAt = Date.now() + Math.min(2000 * Math.pow(2, engineCrashStreak - 1), 30_000)
    events.warn('engine.auto_restart', '数据面进程已退出，正在自动拉起并重放槽位（第 ' + engineCrashStreak + ' 次）')
    const r = await restartDataplane()
    if (r.ok) engineCrashStreak = 0
  })

  scheduler.add('stale-expiry', { everySec: 3600 }, () => {
    staleExpiryTask(db, settings, events)()
  })
  scheduler.add('cleanup', { cron: '15 4 * * *' }, () => {
    const s = settings.get()
    trimRevisions(db, s.publish.keepRevisions)
    trimEngineOps(db)
    trimCheckHistory(db, s.detect.historyKeep)
    conns.trimHistory(7)
    logger.info('每日清理完成（revision / engine_ops 最近 30 天 20000 条 / check 历史各节点最近 ' + s.detect.historyKeep + ' 条）')
  })
  scheduler.add('maintenance-window', { everySec: 60 }, async () => {
    const s = settings.get()
    if (!inMaintenanceWindow(s.engine.maintenanceWindow)) return
    // 维护窗口的唯一用途变成"有结构变更就发布"：Mihomo 没有热操作计数，也不该定期重启
    const planned = await publisher.plan()
    if (planned.configChanged) {
      events.info('engine.maintenance_publish', '维护窗口内检测到结构变更，执行发布（会 reload，短暂断开走 provider 的连接）')
      await jobs.enqueue(APPLY_QUEUE, 'publish', { trigger: 'maintenance' }, 'cron', async () => publish({ reason: 'cron' }))
    }
  })

  const panelCron = settings.get().publish.scheduleCron
  if (panelCron) {
    scheduler.add('publish-cron', { cron: panelCron }, async () => {
      await jobs.enqueue(APPLY_QUEUE, 'publish', { trigger: 'cron' }, 'cron', async () => publish({ reason: 'cron' }))
    })
  }
  scheduler.start()

  // ------------------------------------------------------------------ HTTP
  const server = app.listen({ port: config.panelPort, hostname: config.panelHost })
  logger.info('面板与 API 已监听 http://' + config.panelHost + ':' + config.panelPort + '（DATA_DIR=' + config.dataDir + '）')
  events.info('panel.started', 'mh-p 控制面已启动，监听 ' + config.panelPort)

  const shutdown = async (signal: string) => {
    logger.info('收到 ' + signal + '，正在优雅退出…')
    scheduler.stop()
    try {
      gateway.stop()
    } catch {
      /* ignore */
    }
    conns.snapshot()
    // 必须停掉数据面子进程，否则容器退出后会在宿主机上留下孤儿 mihomo
    await mihomoProcess.stop().catch(() => undefined)
    server.stop()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

/** 二进制探测：带路径分隔符就按文件判断，否则按 PATH 名字找 */
function probeBinary(candidate: string, source: string): { path: string; source: string } | null {
  const name = (candidate ?? '').trim()
  if (!name) return null
  const isPath = name.includes('/') || name.includes('\\')
  if (isPath) return existsSync(name) ? { path: name, source } : null
  const hit = Bun.which(name)
  return hit ? { path: hit, source: source + '（PATH）' } : null
}

function mihomoNotFoundHint(configured: string): string {
  return (
    '找不到 Mihomo 二进制（当前配置：' + (configured || '(空)') + '）。三种修法：' +
    '① 打包版：bun run build（会内嵌对应平台的 Mihomo）；' +
    '② 源码运行：设置 MIHOMO_BINARY 指向可执行文件，或把它放到 ./.tools/mihomo' + (process.platform === 'win32' ? '.exe' : '') + '；' +
    '③ 只在下载：bun run build -- --fetch-only 会把发行包下到 .cache/mihomo 并解出二进制。'
  )
}

function countSwitched(o: PublishOutcome): number {
  const hit = o.checks.find((c) => c.id === 'slotSwitch')
  const m = hit ? /切换 (\d+) 个槽位/.exec(hit.detail) : null
  return m ? Number(m[1]) : 0
}

/** 端口上是否有人在监听（用来区分"我们自己的槽位 listener"与"端口空闲"） */
async function canConnect(port: number, hostname = '127.0.0.1'): Promise<boolean> {
  try {
    const sock = await Bun.connect({
      hostname,
      port,
      socket: { data() {}, error() {}, close() {}, open() {} },
    })
    sock.end()
    return true
  } catch {
    return false
  }
}

/** 端口能否 bind（旧端口池的 canBind 搬过来；健康检查与设置页自检共用） */
async function canBindPort(port: number, hostname = '127.0.0.1'): Promise<boolean> {
  try {
    const server = Bun.serve({ hostname, port, fetch: () => new Response('ok') })
    server.stop(true)
    return true
  } catch {
    return false
  }
}

/** runtime_revisions 裁剪：只裁非 active，active 永远保留（面板要能显示"当前生效"） */
function trimRevisions(db: Db, keep: number): void {
  const n = Math.max(1, Math.trunc(keep))
  const rows = db
    .select({ id: runtimeRevisions.id, status: runtimeRevisions.status })
    .from(runtimeRevisions)
    .orderBy(desc(runtimeRevisions.created_at))
    .all()
  const inactive = rows.filter((r) => r.status !== 'active')
  for (const r of inactive.slice(n)) {
    db.delete(revisionNodes).where(eq(revisionNodes.revision_id, r.id)).run()
    db.delete(runtimeRevisions).where(eq(runtimeRevisions.id, r.id)).run()
  }
}

/** engine_ops 裁剪：保留最近 30 天且最多 20000 条（沿用旧 xray_apply_ops 的口径） */
function trimEngineOps(db: Db): void {
  db.delete(engineOps)
    .where(
      and(
        lt(engineOps.at, Date.now() - 30 * 86400_000),
        notInArray(
          engineOps.id,
          db.select({ id: engineOps.id }).from(engineOps).orderBy(desc(engineOps.id)).limit(20000),
        ),
      ),
    )
    .run()
}

/** 每个节点只留最近 keep 条检测历史（node_check_runs 是"最近 N 次"语义，不是全量审计） */
function trimCheckHistory(db: Db, keep: number): void {
  const k = Math.max(5, Math.trunc(keep))
  db.exec(
    'DELETE FROM node_check_runs WHERE id NOT IN (' +
      'SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY at DESC) AS rn FROM node_check_runs) WHERE rn <= ' +
      k +
      ')',
  )
}

/** 把 listener 报错翻译成可执行的提示（最常见的是端口被占用） */
function describeListenError(e: unknown, listen: string): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/EADDRINUSE|address already in use|Failed to listen/i.test(msg)) {
    return '端口已被占用：' + listen + '。请释放该端口，或在「系统设置 → gateway.listen」改成其他端口（例如 localhost:7891）后保存。'
  }
  return msg
}

function parseListen(listen: string): { host: string; port: number } {
  const idx = listen.lastIndexOf(':')
  if (idx < 0) return { host: 'localhost', port: 7890 }
  const host = listen.slice(0, idx) || 'localhost'
  const port = Number.parseInt(listen.slice(idx + 1), 10) || 7890
  return { host: host === 'localhost' ? '127.0.0.1' : host, port }
}

/**
 * `mh-p healthcheck`：探测控制面自身存活，退出码 0 = 健康。
 *
 * 容器 HEALTHCHECK 依赖这个子命令：distroless 基础镜像没有 curl/wget/shell 可用。
 * 判定只取「面板能应答 + SQLite 可读」：/api/health 的 overall 描述的是数据面状态，
 * 拿它当容器存活条件会让正常运行的面板被反复重启。
 */
async function runHealthcheck(): Promise<number> {
  let lastErr = ''
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
    const url = 'http://' + host + ':' + config.panelPort + '/api/health'
    let res: Response
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    } catch (e) {
      lastErr = host + ': ' + (e instanceof Error ? e.message : String(e))
      continue
    }
    if (!res.ok) {
      logger.error('healthcheck: HTTP ' + res.status + '（' + host + '）')
      return 1
    }
    const body = (await res.json()) as { sqlite?: string; overall?: string }
    logger.info('healthcheck: overall=' + body.overall + ' sqlite=' + body.sqlite + '（' + host + '）')
    return body.sqlite === 'ok' ? 0 : 1
  }
  logger.error('healthcheck: 面板无响应（' + (lastErr || '所有回环地址均连接失败') + '）')
  return 1
}

if (process.argv[2] === 'healthcheck') {
  void runHealthcheck().then((code) => process.exit(code))
} else {
  void main().catch((e) => {
    logger.error('启动失败', e instanceof Error ? e.stack : String(e))
    process.exit(1)
  })
}

// I have nothing but my burger and I want nothing more
