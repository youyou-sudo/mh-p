/**
 * Mihomo 检测链路接线（迁移第 2 阶段）。
 *
 * 两条互补的路径（对应 MIGRATION.md §2 的引擎事实）：
 *  ① 周期观测 = 只读引擎：provider health-check 由 Mihomo 自己按 interval 跑（lazy=false），
 *     结果只有 alive + history[10]；history 末条 delay=0 是失败样本，成功恒 ≥1ms。
 *     **拿不到失败原因**，所以这条路径只能给 up/down + 延迟，不能产出 error_kind。
 *     provider 内 proxy 不在 /proxies 顶层、也不能轮询 /providers/proxies（1000 proxy 时 7.46MB），
 *     所以按订阅逐个读 /providers/proxies/<sub-id>。
 *  ② 按需探测 = 经槽位 listener（http://127.0.0.1:<port>）发真实请求：
 *     这是唯一能拿到 error_kind 与出口 IP 的路径（手动检查 / 发布前门禁 / 出口确认都走它）。
 *
 * 隔离节点为什么不需要额外兜底：Mihomo 的 provider health-check 对所有 proxy 持续探测
 * （不依赖槽位、不依赖流量），被隔离的节点仍然在 provider 里、仍然每轮产生 history，
 * 所以连续成功达到 recoverAfter 后自然会回到 up。旧的 unobservedDueTargets 兜底在 Mihomo 下是多余的。
 */
import { eq, isNotNull, sql } from 'drizzle-orm'
import type { Db } from '../core/db'
import type { EventBus } from '../core/events'
import type { SettingsStore } from '../core/settings'
import { nodeStatus, nodes as nodesT, subscriptions } from '../core/schema'
import type { MihomoClient, MihomoProxyInfo } from '../mihomo/client'
import { providerNameOf } from '../mihomo/config'
import { sampleProxies } from './mihomo'
import type { CheckResult } from './persist'
import { persistCheckResult } from './persist'
import { fetchViaProxy, parseExitInfo, type ErrorKind, type ExitInfo } from './probe'
import { nextState, type NodeState } from './state'

export interface SampleProvidersDeps {
  db: Db
  settings: SettingsStore
  events: EventBus
  client: MihomoClient
  /** 可注入时钟（测试固定时间等）；生产不传 */
  now?: () => number
}

export interface SampleProvidersResult {
  /** 本轮写入的节点数（到期或有状态跃迁） */
  sampled: number
  /** 有 proxy_name 但本轮没写库的节点数（无观测数据 / 未到期且无跃迁） */
  skipped: number
  /** 所有 provider 都读不到（引擎/控制面不可用）：本轮不应改任何节点状态 */
  unavailable: boolean
}

/** 见 probeViaSlot：阻止 Bun 复用上一条经旧槽位选择的隧道连接 */
const PROBE_HEADERS: Record<string, string> = { connection: 'close' }

/** provider 读失败的事件节流：同一个 provider 10 分钟只报一次，避免每轮刷屏 */
const PROVIDER_WARN_INTERVAL_MS = 10 * 60_000
const lastProviderWarnAt = new Map<string, number>()

function warnProviderUnavailable(events: EventBus, provider: string, e: unknown, now: number): void {
  const last = lastProviderWarnAt.get(provider) ?? 0
  if (now - last < PROVIDER_WARN_INTERVAL_MS) return
  lastProviderWarnAt.set(provider, now)
  const msg = e instanceof Error ? e.message : String(e)
  events.warn('detect.provider_unavailable', 'Mihomo provider 读取失败，本轮跳过其节点（' + provider + '）', {
    detail: { provider, error: msg.slice(0, 300) },
  })
}

/**
 * 周期观测：按订阅逐个读 provider 的 proxy 健康历史，驱动状态机并落库。
 *
 * 落库节流与旧的 Detector 采样一致：仅当 next_check_at 到期、或本次结果会造成状态跃迁时才写，
 * 否则 30s 一轮会把 node_check_runs 的 historyKeep 窗口冲光。失败时**不写 delay/exit**
 * （Mihomo 的失败样本 delay=0 不是 0ms；出口信息只在按需探测里有）。
 */
export async function sampleProviders(deps: SampleProvidersDeps): Promise<SampleProvidersResult> {
  const now = deps.now?.() ?? Date.now()
  const subs = deps.db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.enabled, 1)).all()

  // 逐个 provider 读：单个失败只影响它自己的节点；全部失败才判定「引擎不可用」。
  const proxyMap: Record<string, MihomoProxyInfo> = {}
  let providersOk = 0
  for (const sub of subs) {
    const provider = providerNameOf(sub.id)
    try {
      const info = await deps.client.provider(provider)
      providersOk++
      for (const p of info?.proxies ?? []) {
        if (p && typeof p.name === 'string' && p.name) proxyMap[p.name] = p
      }
    } catch (e) {
      // 单个失败只影响它自己的节点：它的节点在 proxyMap 里缺席 → 走「无观测数据」分支，
      // 不会被判死。全部失败才升级成 unavailable（见下）。
      warnProviderUnavailable(deps.events, provider, e, now)
    }
  }

  // 有订阅但一个都读不到 = 引擎/控制面通道坏了：把节点判死会整池误隔离，本轮直接放弃。
  if (subs.length > 0 && providersOk === 0) {
    return { sampled: 0, skipped: 0, unavailable: true }
  }

  const rows = deps.db
    .select({
      id: nodesT.id,
      proxy_name: nodesT.proxy_name,
      state: sql<string>`COALESCE(${nodeStatus.state}, 'unknown')`,
      fail_streak: sql<number>`COALESCE(${nodeStatus.fail_streak}, 0)`,
      success_streak: sql<number>`COALESCE(${nodeStatus.success_streak}, 0)`,
      next_check_at: nodeStatus.next_check_at,
    })
    .from(nodesT)
    .leftJoin(nodeStatus, eq(nodeStatus.node_id, nodesT.id))
    .where(isNotNull(nodesT.proxy_name))
    .all()

  const targets = rows.map((r) => ({ nodeId: r.id, proxyName: r.proxy_name! }))
  // 复用 detect/mihomo.ts 的映射（history 末条 delay=0 = 失败、空 history = 无数据）
  const observations = await sampleProxies({ read: async () => ({ proxies: proxyMap }), targets })
  const s = deps.settings.get()
  let sampled = 0
  let skipped = 0
  for (const row of rows) {
    const obs = observations.get(row.id)
    if (!obs) {
      skipped++
      continue
    }
    const prevState = row.state as NodeState
    const due = row.next_check_at == null || row.next_check_at <= now
    // 先跑一遍纯状态机：只有到期或会跃迁才落库（与旧 Detector.sample 同一口径）
    const projected = nextState({
      prev: prevState,
      ok: obs.ok,
      failStreak: row.fail_streak,
      successStreak: row.success_streak,
      recoverAfter: s.detect.recoverAfter,
      quarantineAfter: s.detect.quarantineAfter,
    })
    if (!due && projected.state === prevState) {
      skipped++
      continue
    }

    const result: CheckResult = { nodeId: row.id, ok: obs.ok, stageReached: 'mihomo' }
    if (obs.ok) {
      result.delayMs = obs.delayMs ?? undefined
    } else {
      // 被动观测没有失败原因：用专门的 errorKind 说明「引擎判定失败」，不要伪造成 internal
      result.errorKind = 'mihomo_unhealthy'
      result.errorMsg = 'Mihomo provider 健康检查判定失败（API 不提供失败原因，可用按需探测确认）'
    }
    persistCheckResult(deps, result, 'cron', 'lite', now)
    sampled++
  }
  return { sampled, skipped, unavailable: false }
}

export interface SlotProbeDeps {
  /** 节点 ID；给了就产出可直接落库的 CheckResult，不给则由调用方补（probeViaSlot 本身不知道节点身份） */
  nodeId?: string
  /** 槽位 listener 的环回端口（portStart + slot） */
  port: number
  testUrl: string
  totalTimeoutMs: number
  /** depth='full' 时用于出口 IP；lite 完全不发这些请求 */
  ipEchoUrls?: string[]
  depth: 'lite' | 'full'
}

/**
 * 经槽位 listener 按需探测一个节点（真实请求，走 Mihomo 的 proxy → 目标）。
 *
 * 这是 Mihomo 链路里唯一能产出 error_kind 与出口 IP 的路径：被动观测只有 ok/延迟。
 * 与旧的 checkOne 不同，这里不需要 ensureNode/端口分配——节点必须已发布到某个槽位，
 * 没有槽位就是「没发布」，调用方应跳过（而不是把节点判死）。
 */
export async function probeViaSlot(deps: SlotProbeDeps): Promise<CheckResult> {
  const started = Date.now()
  const proxyUrl = 'http://127.0.0.1:' + deps.port
  const result: CheckResult = { nodeId: deps.nodeId ?? '', ok: false, stageReached: 'mihomo' }

  // S2：经槽位 listener 请求 testUrl（listener 的 proxy 字段已选中该节点的槽位组）。
  // **必须带 Connection: close**：Bun 的 fetch(proxy:) 会为「同一 origin」建一条隧道并复用，
  // 复用时请求直接走上次选中的节点，绕过 Mihomo 的当前槽位选择（真机实测：把槽位切到死节点后
  // 第二次探测仍返回 204；加 Connection: close 后立刻变成 502）。按需探测的价值就是「此刻」，
  // 不能吃缓存连接。
  const s2 = await fetchViaProxy(deps.testUrl, proxyUrl, deps.totalTimeoutMs, { headers: PROBE_HEADERS })
  result.handshakeMs = s2.ms
  result.httpStatus = s2.status
  if (!s2.ok) {
    return {
      ...result,
      totalMs: Date.now() - started,
      errorKind: slotErrorKind(s2.errorKind),
      errorMsg: s2.errorMsg ?? '经槽位 listener 请求失败',
    }
  }
  result.stageReached = 'http'

  // lite：S2 成功即可（与旧 checkOne 的口径一致，省掉出口查询）
  if (deps.depth === 'lite') {
    result.totalMs = Date.now() - started
    result.ok = true
    return result
  }

  // S3：出口确认（只有 full 才做）
  let exit: ExitInfo | undefined
  let lastErr: { kind?: ErrorKind; msg?: string } = {}
  for (const echo of deps.ipEchoUrls ?? []) {
    const s3 = await fetchViaProxy(echo, proxyUrl, deps.totalTimeoutMs, { headers: PROBE_HEADERS })
    if (s3.ok && s3.body) {
      const info = parseExitInfo(s3.body)
      if (info.ip) {
        exit = info
        break
      }
      lastErr = { kind: 'ip_echo_failed', msg: 'IP 回显缺少 IP 字段' }
    } else {
      lastErr = { kind: s3.errorKind ?? 'ip_echo_failed', msg: s3.errorMsg ?? 'IP 回显失败' }
    }
  }
  result.totalMs = Date.now() - started
  if (!exit) {
    return { ...result, errorKind: lastErr.kind ?? 'ip_echo_failed', errorMsg: lastErr.msg ?? '未取到出口 IP' }
  }
  result.exit = exit
  result.delayMs = result.handshakeMs
  result.stageReached = 'exit_ip'
  result.ok = true
  return result
}

/**
 * fetchViaProxy 的 proxyErrorKind 把「连不上代理」标成 gateway_unreachable（历史命名，
 * 那是 Xray 网关时代的叫法）。在 Mihomo 链路里这条连接的对端是槽位 listener，
 * 所以改写成 mihomo_down，排障时不会把人引到网关设置上。
 */
function slotErrorKind(kind: ErrorKind | undefined): ErrorKind {
  if (kind === 'gateway_unreachable') return 'mihomo_down'
  return kind ?? 'empty_reply'
}

/** 供测试重置 provider 告警节流（模块级状态，避免用例互相干扰） */
export function resetProviderWarnThrottle(): void {
  lastProviderWarnAt.clear()
}
