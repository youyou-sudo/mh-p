import { Elysia } from 'elysia'
import type { AppContext } from '../../context'
import type { SettingsPatch } from '../../core/settings'
import { APPLY_QUEUE } from '../../jobs/queue'
import type { createSessionPlugin } from '../../plugins/session'
import type { SubscriptionsService } from '../subscriptions/service'
import { settingsTestBody } from './model'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/** 系统设置模块（/api/settings）。PATCH 接受任意部分更新，由 SettingsStore 做深合并与校验。 */
export function settingsModule(ctx: AppContext, session: SessionPlugin, subscriptions: SubscriptionsService) {
  const { settings, events, auth, jobs } = ctx
  return new Elysia({ name: 'api/settings', prefix: '/api' })
    .use(session)
    .get('/settings', () => ({ settings: settings.get() }), { requireSession: true })
    .patch('/settings', ({ body }) => {
      const beforeEngine = settings.get().engine
      const next = settings.update(body as SettingsPatch)
      auth.audit('panel', 'admin', 'settings.update', null, null, body)
      events.info('settings.updated', '系统设置已更新（立即生效）')
      if (ctx.gateway) {
        try {
          ctx.gateway.reconfigure(next.gateway)
          ctx.setGatewayError(null)
          events.info('gateway.reconfigured', '网关已按新配置重建 listener（' + next.gateway.listen + '）')
        } catch (e) {
          const msg = (e as Error).message
          ctx.setGatewayError(msg)
          events.error('gateway.reconfigure_failed', '网关重配置失败：' + msg)
        }
      }
      // engine.* 是**配置期**参数（listener 数 = 槽位容量、端口区间、REST 地址/secret、日志级别）：
      // 改完必须重新发布才会生效，而且可能触发整份 reload（会短暂断开走 provider 的在途连接）。
      // 这里主动排一次发布，并在事件里把代价讲清楚——不能让用户在不知情的情况下断掉连接。
      if (JSON.stringify(beforeEngine) !== JSON.stringify(next.engine)) {
        events.warn(
          'engine.settings_changed',
          '数据面设置已变更，正在重新发布：槽位容量/端口区间/REST 地址/日志级别属于配置期参数，' +
            '需要 reload 配置（会短暂断开经 provider 转发的在途连接）',
        )
        jobs.enqueue(APPLY_QUEUE, 'publish', { trigger: 'settings' }, 'panel', async () => ctx.publish({ reason: 'manual' }))
      }
      subscriptions.setConcurrency(next.subsync.concurrency)
      return { settings: next }
    }, { requireSession: true })
    .post('/settings/test', async ({ body }) => {
      const what = body?.what
      const results: { id: string; label: string; ok: boolean; detail: string }[] = []
      // 'xray' 保留为兼容别名（旧前端/脚本还会传），语义已经是 engine
      if (!what || what === 'engine' || what === 'xray') {
        const t0 = Date.now()
        try {
          const v = await ctx.client.version()
          results.push({
            id: 'engine.rest',
            label: '数据面 REST 可达（GET /version）',
            ok: !!v.version,
            detail: (v.version ?? '(无 version 字段)') + ' · ' + (Date.now() - t0) + 'ms',
          })
        } catch (e) {
          results.push({
            id: 'engine.rest',
            label: '数据面 REST 可达（GET /version）',
            ok: false,
            detail: (e as Error).message.slice(0, 240),
          })
        }
        const built = await ctx.process.testConfig(ctx.engineConfigPath)
        results.push({
          id: 'engine.config',
          label: 'config.yaml 通过 mihomo -t',
          ok: built.ok,
          detail: built.ok ? ctx.engineConfigPath : (built.stderr || built.stdout).slice(0, 240),
        })
        const st = ctx.process.status()
        results.push({
          id: 'engine.binary',
          label: '当前数据面进程与版本',
          ok: !!st.version,
          detail:
            'status=' + st.status + ' pid=' + String(st.pid ?? '-') + ' version=' + (st.version ?? '(未知)') +
            (body?.binary ? '（换二进制需保存后重启数据面）' : ''),
        })
      }
      if (!what || what === 'ports') {
        const e = settings.get().engine
        const ports: { port: number; ok: boolean }[] = []
        for (let i = 0; i < Math.min(8, e.slotCapacity); i++) {
          const port = e.inboundPortStart + i
          ports.push({ port, ok: await ctx.canBind(port, '127.0.0.1') })
        }
        results.push({
          id: 'engine.slots',
          label: '槽位端口前 8 个在监听或空闲',
          ok: ports.every((x) => x.ok),
          detail: ports.map((x) => x.port + ':' + (x.ok ? 'ok' : 'fail')).join(' '),
        })
      }
      if (!what || what === 'ipecho') {
        for (const url of settings.get().detect.ipEchoUrls) {
          try {
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 6000)
            const res = await fetch(url, { signal: ctrl.signal })
            clearTimeout(timer)
            results.push({ id: 'ipecho.' + url, label: 'IP 查询源 ' + url, ok: res.ok, detail: 'HTTP ' + res.status })
          } catch (e) {
            results.push({ id: 'ipecho.' + url, label: 'IP 查询源 ' + url, ok: false, detail: (e as Error).message })
          }
        }
      }
      return { results }
    }, { body: settingsTestBody, requireSession: true })
}
