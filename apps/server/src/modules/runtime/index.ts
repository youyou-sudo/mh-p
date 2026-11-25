import { Elysia } from 'elysia'
import { desc, eq } from 'drizzle-orm'
import { runtimeRevisions } from '../../core/schema'
import type { AppContext } from '../../context'
import { AppError } from '../../core/errors'
import { digestOf } from '../../core/ids'
import { parseBool, parsePaging } from '../../core/http'
import { APPLY_QUEUE } from '../../jobs/queue'
import type { createSessionPlugin } from '../../plugins/session'
import { runtimePublishBody, runtimeReconcileBody, runtimeRollbackBody } from './model'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/**
 * 运行配置模块（/api/runtime）：发布、对账、重启与单节点重建。
 *
 * Mihomo 时代没有"增量 apply plan"：发布 = 结构同步（必要时 reload）+ 槽位热切换，
 * 而且是**幂等**的——对账就是"再发布一次"，结构没变就只补槽位 PUT。
 * 响应保留旧的 key（revision/dataplane/diff/ports…）让前端平滑过渡，
 * 新增的 engine/slots/reloadNeeded 才是面板应该转而使用的字段。
 */
export function runtimeModule(ctx: AppContext, session: SessionPlugin) {
  const { db, settings, jobs, auth, publisher, slots, scheduler } = ctx
  return new Elysia({ name: 'api/runtime', prefix: '/api' })
    .use(session)
    .get('/runtime/status', async () => {
      const st = ctx.process.status()
      const planned = await publisher.plan()
      const current = publisher.currentStatus()
      const latest = db.select().from(runtimeRevisions).orderBy(desc(runtimeRevisions.created_at)).limit(1).get()
      const e = settings.get().engine
      const slotRows = slots.load()
      const used = slotRows.filter((a) => a.nodeId).length
      const fresh = planned.desired.filter((d) => d.slot === null).map((d) => d.nodeId)
      const kept = planned.desired.filter((d) => d.slot !== null).map((d) => d.nodeId)

      return {
        // ---- 新语义（面板应优先用这些） ----
        engine: {
          mode: e.mode,
          status: st.status,
          pid: st.pid,
          version: st.version,
          startedAt: st.startedAt,
          restarts: st.restarts,
          uptimeSec: Math.floor((Date.now() - (st.startedAt ?? Date.now())) / 1000),
        },
        slots: {
          capacity: e.slotCapacity,
          used,
          free: e.slotCapacity - used,
          portStart: e.inboundPortStart,
          portEnd: e.inboundPortEnd,
        },
        reloadNeeded: planned.configChanged,
        desired: {
          count: planned.desired.length,
          providers: planned.providers,
          overflow: planned.overflow,
          skipped: planned.skipped,
          ok: planned.ok,
          checks: planned.checks,
        },
        lastPublish: current,
        // ---- 兼容旧前端字段 ----
        revision: latest
          ? {
              id: latest.id,
              status: latest.status,
              reason: latest.reason,
              createdAt: latest.created_at,
              appliedAt: latest.applied_at,
              nodeCount: latest.node_count,
              digest: latest.plan_digest ?? undefined,
            }
          : null,
        dataplane: {
          // outbounds ≈ 引擎里实际可用的出口（= 已发布节点数），inbounds = listener 数 = 槽位数
          outbounds: planned.desired.length,
          inbounds: slotRows.length,
          ruleCount: 1,
          rulesSupported: true,
          digest: digestOf(planned.configText),
          // 从未发布过就是 undefined（前端类型是 at?: number，不能塞 null）
          at: current.lastPublishAt ?? undefined,
        },
        diff: {
          add: fresh,
          change: [],
          remove: [],
          keep: kept,
          drift: { outboundTags: [], inboundTags: [], ruleTags: [] },
        },
        // 退休队列在槽位模型里不存在（换节点 = 改槽位选中项，旧连接自然走完）
        pendingRetire: [],
        hotOpsTotal: 0,
        hotOpsThreshold: 0,
        ports: { pool: e.slotCapacity, used, cooling: 0 },
        lastRevision: latest ? { id: latest.id, status: latest.status, error: latest.error } : null,
        scheduler: scheduler.list(),
      }
    }, { requireSession: true })
    .get('/runtime/revisions', ({ query }) => {
      const p = parsePaging(query)
      const rows = db
        .select()
        .from(runtimeRevisions)
        .orderBy(desc(runtimeRevisions.created_at))
        .limit(p.limit)
        .offset(p.offset)
        .all()
      return {
        items: rows.map((r) => {
          const plan = r.plan_json
            ? (JSON.parse(r.plan_json) as { desired?: { nodeId: string; proxyName: string; username: string; slot: number | null; port: number | null }[] })
            : null
          return {
            id: r.id,
            status: r.status,
            reason: r.reason,
            createdAt: r.created_at,
            appliedAt: r.applied_at,
            nodeCount: r.node_count,
            added: r.added_count,
            removed: r.removed_count,
            changed: r.changed_count,
            skipped: r.skipped_count,
            plan: plan,
            validation: r.validation_json ? JSON.parse(r.validation_json) : null,
            error: r.error,
            // 槽位模型下没有 revision_nodes 表数据：从 plan_json 还原，字段名保持前端可用的旧形状
            nodes: (plan?.desired ?? []).slice(0, 500).map((d) => ({
              node_id: d.nodeId,
              username: d.username,
              outbound_tag: d.proxyName,
              inbound_tag: 'in-slot-' + String(d.slot ?? -1),
              inbound_port: d.port,
            })),
          }
        }),
      }
    }, { requireSession: true })
    .post(
      '/runtime/publish',
      ({ body }) => {
        const dryRun = parseBool(body?.dryRun, false)
        const jobId = jobs.enqueue(APPLY_QUEUE, 'publish', { dryRun }, 'panel', async (_id, jctx) => {
          jctx.setProgress(0, 1, dryRun ? '试运行（只算不写）' : '结构同步 + 槽位指派')
          const r = await ctx.publish({ reason: 'manual', dryRun })
          if (!dryRun) auth.audit('panel', 'admin', 'runtime.publish', r.revisionId, null, {
            reloaded: r.reloaded,
            assigned: r.assigned,
            released: r.released,
          })
          return {
            revisionId: r.revisionId,
            ok: r.ok,
            reloaded: r.reloaded,
            assigned: r.assigned,
            released: r.released,
            overflow: r.overflow,
            checks: r.checks,
            error: r.error,
          }
        })
        return { jobId }
      },
      { body: runtimePublishBody, requireSession: true },
    )
    .post(
      '/runtime/rollback',
      ({ body }) => {
        const revisionId = String(body?.revisionId ?? '')
        if (!revisionId) throw new AppError('validation_failed', 'revisionId 必填', 422)
        // Mihomo 链路的发布是"从当前期望状态收敛"的幂等操作，没有可回放的 plan 快照：
        // 真正的回滚 = 把节点改成当时的样子再发布。这里明确报错，而不是假装成功。
        const jobId = jobs.enqueue(APPLY_QUEUE, 'rollback', { revisionId }, 'panel', async () => ({
          ok: false,
          revisionId,
          error:
            '不支持直接回滚到历史 revision：Mihomo 的发布是从当前期望状态收敛（幂等）。' +
            '要回到某个版本的状态，请先把节点/订阅改回当时的样子，再点「发布」。',
        }))
        return { jobId }
      },
      { body: runtimeRollbackBody, requireSession: true },
    )
    .post(
      '/runtime/reconcile',
      ({ body }) => {
        const dryRun = parseBool(body?.dryRun, false)
        const jobId = jobs.enqueue(APPLY_QUEUE, 'reconcile', { dryRun }, 'panel', async (_id, jctx) => {
          jctx.setProgress(0, 1, '对账（发布幂等重跑）')
          const r = await ctx.publish({ reason: 'reconcile', dryRun })
          return {
            // consistent 的语义变成"本轮发布没有需要修复的差异且全部成功"
            consistent: r.ok,
            applied: !dryRun && r.ok,
            reloaded: r.reloaded,
            assigned: r.assigned,
            released: r.released,
            overflow: r.overflow,
            checks: r.checks,
            revisionId: r.revisionId,
            error: r.error,
          }
        })
        return { jobId }
      },
      { body: runtimeReconcileBody, requireSession: true },
    )
    .post('/runtime/restart', () => {
      const activeConns = ctx.conns.count()
      const jobId = jobs.enqueue(APPLY_QUEUE, 'restart', { activeConns }, 'panel', async () => {
        auth.audit('panel', 'admin', 'runtime.restart', null, null, { activeConns })
        const r = await ctx.restartDataplane()
        return { ...r, disconnected: activeConns }
      })
      return { jobId, activeConns }
    }, { requireSession: true })
    .post('/runtime/node/:id/rebuild', ({ params }) => {
      const node = db.select({ id: runtimeRevisions.id }).from(runtimeRevisions).where(eq(runtimeRevisions.id, params.id)).get()
      // 占位：节点存在性用 nodes 表判断（下面 publisher 会给答案）
      void node
      const jobId = jobs.enqueue(APPLY_QUEUE, 'publish', { nodeId: params.id }, 'panel', async () => {
        // 槽位模型下"重建单节点"没有独立路径：节点参数变了 → proxy 名不变 → provider 热更新即可，
        // 需要做的只是重新发布（必要时 reload + 槽位 PUT）。
        const r = await ctx.publish({ reason: 'manual' })
        const got = r.checks.find((c) => c.id === 'slotSwitch')
        return {
          ok: r.ok,
          reloaded: r.reloaded,
          assigned: r.assigned,
          error: r.error,
          detail: got?.detail ?? '',
        }
      })
      return { jobId }
    }, { requireSession: true })
}
