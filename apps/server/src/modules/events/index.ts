import { Elysia } from 'elysia'
import { and, desc, eq, like } from 'drizzle-orm'
import { auditLog, engineOps, events as eventsTable } from '../../core/schema'
import type { AppContext } from '../../context'
import { parsePaging, requestId } from '../../core/http'
import { sessionOf, type createSessionPlugin } from '../../plugins/session'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/** 事件 / 审计 / 应用操作模块（/api/events、/api/audit、/api/apply-ops、/api/stream）。 */
export function eventsModule(ctx: AppContext, session: SessionPlugin) {
  const { db, events, conns, auth } = ctx
  // 审计数据源：Mihomo 时代的 engine_ops（reload / assign / test_config …）；xray_apply_ops 只留历史
  const listApplyOps = (limit: number, offset: number) => ({
    items: db
      .select()
      .from(engineOps)
      .orderBy(desc(engineOps.at))
      .limit(limit)
      .offset(offset)
      .all(),
  })
  return new Elysia({ name: 'api/events', prefix: '/api' })
    .use(session)
    .get('/events', ({ query }) => {
      const q = query
      const p = parsePaging(q)
      const conds = []
      if (q.level) conds.push(eq(eventsTable.level, q.level))
      if (q.kind) conds.push(like(eventsTable.kind, q.kind + '%'))
      if (q.nodeId) conds.push(eq(eventsTable.node_id, q.nodeId))
      const items = db
        .select()
        .from(eventsTable)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(eventsTable.at))
        .limit(p.limit)
        .offset(p.offset)
        .all()
      return { items: items.map((e) => ({ ...e, detail: e.detail_json ? JSON.parse(e.detail_json) : null })) }
    }, { requireSession: true })
    /** 审计明细（/events 页的「xray_apply_ops 审计」标签页）；kind=xray_apply_ops 时等价于 /api/apply-ops */
    .get('/audit', ({ query }) => {
      const q = query
      const p = parsePaging(q)
      // 注意：审计日志与引擎操作是两种形状，不能在这个端点里二选一返回——
      // 那会让 Eden 推导出联合类型，前端每一处调用都要跟着做窄化。
      // 引擎操作走 /api/apply-ops（下方），这里只返回 audit_log。
      const items = db
        .select()
        .from(auditLog)
        .orderBy(desc(auditLog.at))
        .limit(p.limit)
        .offset(p.offset)
        .all()
      return { items: items.map((a) => ({ ...a, detail: a.detail_json ? JSON.parse(a.detail_json) : null })) }
    }, { requireSession: true })
    .get('/apply-ops', ({ query }) => {
      const p = parsePaging(query)
      return listApplyOps(p.limit, p.offset)
    }, { requireSession: true })
    // SSE：未登录时返回 401 JSON（不能用 macro，因为这里要返回自定义 Response）
    .get('/stream', ({ cookie, request }) => {
      if (!sessionOf(auth, cookie as Record<string, { value?: unknown } | undefined>)) {
        return new Response(JSON.stringify({ error: { code: 'unauthorized', message: '未登录' } }), { status: 401 })
      }
      const encoder = new TextEncoder()
      let unsubscribe: (() => void) | null = null
      const stream = new ReadableStream({
        start(controller) {
          const send = (event: string, data: unknown) => {
            try {
              controller.enqueue(encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'))
            } catch {
              /* 客户端已断开 */
            }
          }
          send('hello', { at: Date.now(), gateway: conns.count() })
          unsubscribe = events.subscribe((e) => send('event', e))
          const timer = setInterval(() => send('gateway', { activeConns: conns.count(), byNode: conns.byNode() }), 5000)
          request.signal.addEventListener('abort', () => {
            clearInterval(timer)
            unsubscribe?.()
            try {
              controller.close()
            } catch {
              /* ignore */
            }
          })
        },
        cancel() {
          unsubscribe?.()
        },
      })
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-request-id': requestId() },
      })
    })
}
