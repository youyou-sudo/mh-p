import type { AppContext } from '../../context'
import { APPLY_QUEUE } from '../../jobs/queue'

/**
 * 入队一次对账任务：Mihomo 的发布是幂等的，对账 = 再发布一次
 * （结构没变就只补槽位 PUT，结构变了才 reload）。
 * 节点删除/批量清理之后调用它，把数据面收敛到新的期望状态。
 */
export function enqueueReconcileJob(ctx: AppContext, detail: Record<string, unknown>): string {
  return ctx.jobs.enqueue(APPLY_QUEUE, 'reconcile', detail, 'panel', async () => {
    const r = await ctx.publish({ reason: 'reconcile' })
    return {
      consistent: r.ok,
      applied: r.ok,
      reloaded: r.reloaded,
      assigned: r.assigned,
      released: r.released,
      revisionId: r.revisionId,
      error: r.error,
    }
  })
}
