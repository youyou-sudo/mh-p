/**
 * 检测结果落库（node_status + node_check_runs + 事件）。
 *
 * 从 detect/detect.ts 原样搬出，供两条检测路径共用：
 *  - Detector.persist()（按需探测：经槽位 listener / 网关发真实请求，能拿到 error_kind 与 exit_ip）；
 *  - detect/collector.ts（Mihomo provider 健康检查的被动观测：只有 ok + 延迟，没有失败原因）。
 *
 * 行为与搬出前保持一致（状态机、退避/抖动、的事件、exit_* 的 ?? 回填都不变）；
 * 唯一新增是 CheckResult.stageReached 允许 'mihomo'（观测数据来自数据面，不是本进程发出的请求）。
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../core/db'
import { nodeCheckRuns, nodeStatus } from '../core/schema'
import type { EventBus } from '../core/events'
import type { SettingsStore } from '../core/settings'
import type { ErrorKind, ExitInfo } from './probe'
import { backoffMs, nextState, withJitter, type NodeState } from './state'

export interface CheckResult {
  nodeId: string
  ok: boolean
  /** 'mihomo' = 结果来自数据面（provider health-check 历史），而不是本进程发出的请求 */
  stageReached: 'xray' | 'gateway' | 'handshake' | 'http' | 'exit_ip' | 'mihomo'
  connectMs?: number
  handshakeMs?: number
  totalMs?: number
  delayMs?: number
  httpStatus?: number
  exit?: ExitInfo
  errorKind?: ErrorKind
  errorMsg?: string
}

export interface PersistDeps {
  db: Db
  settings: SettingsStore
  events: EventBus
}

/**
 * 写 node_status + node_check_runs（§6.4 / §8.2）。
 *
 * now 可注入只为测试固定时间；生产调用不要传（默认取当前时间）。
 */
export function persistCheckResult(
  deps: PersistDeps,
  r: CheckResult,
  source: string,
  depth: 'lite' | 'full',
  now = Date.now(),
): void {
  const s = deps.settings.get()
  const prev = deps.db.select().from(nodeStatus).where(eq(nodeStatus.node_id, r.nodeId)).get()
  const prevState: NodeState = (prev?.state as NodeState) ?? 'unknown'
  const out = nextState({
    prev: prevState,
    ok: r.ok,
    failStreak: prev?.fail_streak ?? 0,
    successStreak: prev?.success_streak ?? 0,
    recoverAfter: s.detect.recoverAfter,
    quarantineAfter: s.detect.quarantineAfter,
  })

  const total = (prev?.checks_total ?? 0) + 1
  const okCount = (prev?.checks_ok ?? 0) + (r.ok ? 1 : 0)
  const uptime = total > 0 ? okCount / total : 0

  // 抖动（jitterMs）已随 detect 设置项退役：Mihomo 的探测节奏由 provider health-check 决定，
  // 这里的 next_check_at 只是"同一结果不要每轮都写库"的节流，加抖动反而让节流不确定。
  const next = r.ok ? s.detect.intervalSec * 1000 : backoffMs(s.detect.intervalSec, out.failStreak)

  const row = {
    node_id: r.nodeId,
    state: out.state,
    last_check_at: now,
    last_ok_at: r.ok ? now : (prev?.last_ok_at ?? null),
    last_fail_at: r.ok ? (prev?.last_fail_at ?? null) : now,
    recovered_at: out.recovered ? now : (prev?.recovered_at ?? null),
    connect_ms: r.connectMs ?? null,
    handshake_ms: r.handshakeMs ?? null,
    total_ms: r.totalMs ?? null,
    delay_ms: r.delayMs ?? null,
    // 失败结果不得清掉上一次成功拿到的出口信息（被动观测永远没有 exit_*）
    exit_ip: r.exit?.ip ?? prev?.exit_ip ?? null,
    exit_country: r.exit?.country ?? prev?.exit_country ?? null,
    exit_region: r.exit?.region ?? prev?.exit_region ?? null,
    exit_asn: r.exit?.asn ?? prev?.exit_asn ?? null,
    exit_isp: r.exit?.isp ?? prev?.exit_isp ?? null,
    error_kind: r.ok ? null : (r.errorKind ?? 'internal'),
    error_msg: r.ok ? null : (r.errorMsg ?? '').slice(0, 200),
    fail_streak: out.failStreak,
    success_streak: out.successStreak,
    next_check_at: now + next,
    checks_total: total,
    checks_ok: okCount,
    uptime_24h: uptime,
    updated_at: now,
  }

  const { node_id: _nodeId, ...statusSet } = row
  deps.db
    .insert(nodeStatus)
    .values(row)
    .onConflictDoUpdate({ target: nodeStatus.node_id, set: statusSet })
    .run()

  deps.db
    .insert(nodeCheckRuns)
    .values({
      node_id: r.nodeId,
      at: now,
      source,
      ok: r.ok ? 1 : 0,
      stage_reached: r.stageReached,
      connect_ms: r.connectMs ?? null,
      handshake_ms: r.handshakeMs ?? null,
      total_ms: r.totalMs ?? null,
      delay_ms: r.delayMs ?? null,
      http_status: r.httpStatus ?? null,
      exit_ip: r.exit?.ip ?? null,
      exit_country: r.exit?.country ?? null,
      error_kind: r.ok ? null : (r.errorKind ?? 'internal'),
      error_msg: r.ok ? null : (r.errorMsg ?? '').slice(0, 200),
      detail_json: JSON.stringify({ depth, exit: r.exit ?? null }),
    })
    .run()

  if (prevState !== out.state) {
    if (out.state === 'quarantined') {
      deps.events.warn('node.quarantined', '节点 ' + r.nodeId + ' 连续失败 ' + out.failStreak + ' 次，已隔离', { nodeId: r.nodeId })
    } else if (out.recovered) {
      deps.events.info('node.recovered', '节点 ' + r.nodeId + ' 已恢复（recovered_at 已记录）', { nodeId: r.nodeId })
    }
  }

  // 协议不可发布提示（D9）
  void depth
}
