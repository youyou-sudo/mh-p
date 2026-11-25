import { and, avg, count, eq, isNotNull, sql } from 'drizzle-orm'
import type { AppContext } from '../../context'
import { engineOps, nodeStatus, nodes as nodesT, runtimeRevisions, subscriptionRuns, subscriptions } from '../../core/schema'

/**
 * Prometheus 文本格式指标（/api/metrics）。
 *
 * 只读本地状态（DB + 进程态），不在这里发 REST 调用：抓取可能每 15s 一次，
 * 不能让一次抓取因为引擎慢而拖住事件循环。
 */
export function prometheus(ctx: AppContext): string {
  const { db } = ctx
  const lines: string[] = []
  const states = db
    .select({ state: sql<string>`COALESCE(${nodeStatus.state}, 'unknown')`, n: count() })
    .from(nodesT)
    .leftJoin(nodeStatus, eq(nodeStatus.node_id, nodesT.id))
    .groupBy(sql`COALESCE(${nodeStatus.state}, 'unknown')`)
    .all()
  lines.push('# HELP mhp_nodes_total 节点按状态计数')
  lines.push('# TYPE mhp_nodes_total gauge')
  for (const s of states) lines.push('mhp_nodes_total{state="' + s.state + '"} ' + s.n)

  const lat = db
    .select({ node_id: nodeStatus.node_id, delay_ms: nodeStatus.delay_ms })
    .from(nodeStatus)
    .where(isNotNull(nodeStatus.delay_ms))
    .all()
  lines.push('# HELP mhp_node_latency_ms 节点延迟（来自 Mihomo provider 健康历史 / 按需探测）')
  lines.push('# TYPE mhp_node_latency_ms gauge')
  for (const l of lat) lines.push('mhp_node_latency_ms{node="' + l.node_id + '"} ' + l.delay_ms)

  const syncDur = db
    .select({ d: avg(subscriptionRuns.duration_ms) })
    .from(subscriptionRuns)
    .where(isNotNull(subscriptionRuns.duration_ms))
    .get()
  lines.push('# HELP mhp_sync_duration_seconds 同步平均耗时')
  lines.push('# TYPE mhp_sync_duration_seconds gauge')
  lines.push('mhp_sync_duration_seconds ' + (Number(syncDur?.d ?? 0) / 1000).toFixed(3))

  const pubs = db
    .select({ status: runtimeRevisions.status, n: count() })
    .from(runtimeRevisions)
    .groupBy(runtimeRevisions.status)
    .all()
  lines.push('# HELP mhp_publish_total 发布结果计数')
  lines.push('# TYPE mhp_publish_total counter')
  for (const p of pubs) lines.push('mhp_publish_total{result="' + p.status + '"} ' + p.n)

  // 引擎操作审计：op 例如 reload / assign / test_config；ok=0 是失败次数
  const ops = db
    .select({ op: engineOps.op, ok: engineOps.ok, n: count() })
    .from(engineOps)
    .groupBy(engineOps.op, engineOps.ok)
    .all()
  lines.push('# HELP mhp_engine_ops_total 引擎操作计数（按 op 与结果）')
  lines.push('# TYPE mhp_engine_ops_total counter')
  for (const o of ops) lines.push('mhp_engine_ops_total{op="' + o.op + '",ok="' + o.ok + '"} ' + o.n)

  const slotRows = ctx.slots.load()
  const used = slotRows.filter((a) => a.nodeId).length
  lines.push('# HELP mhp_engine_slots_used 已占用槽位')
  lines.push('# TYPE mhp_engine_slots_used gauge')
  lines.push('mhp_engine_slots_used ' + used)
  lines.push('# HELP mhp_engine_slots_total 槽位容量（= listener 数 = 节点上限）')
  lines.push('# TYPE mhp_engine_slots_total gauge')
  lines.push('mhp_engine_slots_total ' + slotRows.length)

  const st = ctx.process.status()
  const up = ctx.settings.get().engine.mode === 'external' ? 1 : st.status === 'running' ? 1 : 0
  lines.push('# HELP mhp_engine_up 数据面进程是否运行')
  lines.push('# TYPE mhp_engine_up gauge')
  lines.push('mhp_engine_up ' + up)
  lines.push('# HELP mhp_engine_restarts 数据面重启次数')
  lines.push('# TYPE mhp_engine_restarts counter')
  lines.push('mhp_engine_restarts ' + st.restarts)

  const subCount = db.select({ n: count() }).from(subscriptions).where(eq(subscriptions.enabled, 1)).get()
  lines.push('# HELP mhp_engine_providers 已启用的订阅 provider 数')
  lines.push('# TYPE mhp_engine_providers gauge')
  lines.push('mhp_engine_providers ' + (subCount?.n ?? 0))

  lines.push('# HELP mhp_gateway_conns 网关活跃连接数')
  lines.push('# TYPE mhp_gateway_conns gauge')
  const byNode = ctx.conns.byNode()
  for (const [node, n] of Object.entries(byNode)) lines.push('mhp_gateway_conns{node="' + node + '"} ' + n)
  if (Object.keys(byNode).length === 0) lines.push('mhp_gateway_conns{node=""} 0')

  const authFail = ctx.gateway ? ctx.gateway.stats().authFailures5m : 0
  lines.push('# HELP mhp_gateway_auth_failures_total 认证失败次数')
  lines.push('# TYPE mhp_gateway_auth_failures_total counter')
  lines.push('mhp_gateway_auth_failures_total ' + authFail)

  lines.push('# HELP mhp_engine_failed_ops_total 失败的引擎操作次数（需要排障的量）')
  lines.push('# TYPE mhp_engine_failed_ops_total counter')
  const failed = db.select({ n: count() }).from(engineOps).where(and(eq(engineOps.ok, 0))).get()
  lines.push('mhp_engine_failed_ops_total ' + (failed?.n ?? 0))
  return lines.join('\n') + '\n'
}
