import { Elysia } from 'elysia'
import type { AppContext } from '../../context'
import { AppError } from '../../core/errors'
import { clientIp } from '../../core/http'
import { loadRouteGroupConfigs } from '../../core/route-groups'
import type { createSessionPlugin } from '../../plugins/session'
import { routeGroupCreateBody, routeGroupPatchBody } from './model'
import {
  createRouteGroup,
  deleteRouteGroup,
  listRouteGroupRows,
  routeGroupConfigOf,
  routeGroupConnection,
  routeGroupRowOf,
  rotateRouteGroup,
  updateRouteGroup,
} from './service'

type SessionPlugin = ReturnType<typeof createSessionPlugin>

/**
 * 路由组模块（/api/route-groups）。
 *
 * 组是网关的又一个「用户名」：成员按国家正则动态圈定，接入密码挂在组上。
 * 每次配置变更后把内存注册表从 DB 重载，网关下一条新连接立即按新规则选节点。
 */
export function routeGroupsModule(ctx: AppContext, session: SessionPlugin) {
  const { db, events, auth, settings, gatewayInfo } = ctx

  const reload = () => ctx.routeGroups.replaceConfigs(loadRouteGroupConfigs(db))

  const view = (row: NonNullable<ReturnType<typeof routeGroupRowOf>>) => {
    const config = routeGroupConfigOf(row)
    const members = ctx.routeGroups.describe(row.id)
    return {
      ...config,
      memberCount: members.length,
      members,
      updatedAt: row.updated_at,
    }
  }

  return new Elysia({ name: 'api/route-groups', prefix: '/api' })
    .use(session)
    .get('/route-groups', () => {
      const items = listRouteGroupRows(db)
        .map((row) => view(row))
        .sort((a, b) => a.id.localeCompare(b.id))
      return { items, updatedAt: Date.now() }
    }, { requireSession: true })
    .get('/route-groups/:id', ({ params }) => {
      const row = routeGroupRowOf(db, params.id)
      if (!row) throw new AppError('not_found', '路由组不存在', 404)
      return view(row)
    }, { requireSession: true })
    .post(
      '/route-groups',
      ({ body, request }) => {
        const created = createRouteGroup(db, body)
        reload()
        auth.audit('panel', 'admin', 'route_group.create', created.config.id, clientIp(request), {
          countryRegex: created.config.countryRegex,
          balanceMode: created.config.balanceMode,
        })
        events.info('route_group.created', '路由组 ' + created.config.id + ' 已创建（' + created.config.balanceMode + '）', {
          detail: { groupId: created.config.id },
        })
        return { ok: true, group: view(routeGroupRowOf(db, created.config.id)!), password: created.password }
      },
      { body: routeGroupCreateBody, requireSession: true },
    )
    .patch(
      '/route-groups/:id',
      ({ params, body, request }) => {
        const config = updateRouteGroup(db, params.id, body)
        reload()
        auth.audit('panel', 'admin', 'route_group.update', params.id, clientIp(request), body)
        events.info('route_group.updated', '路由组 ' + params.id + ' 已更新', { detail: { groupId: params.id } })
        return { ok: true, group: view(routeGroupRowOf(db, config.id)!) }
      },
      { body: routeGroupPatchBody, requireSession: true },
    )
    .delete('/route-groups/:id', ({ params, request }) => {
      const existed = deleteRouteGroup(db, params.id)
      if (!existed) throw new AppError('not_found', '路由组不存在', 404)
      reload()
      const closed = ctx.kick({ username: params.id })
      auth.audit('panel', 'admin', 'route_group.delete', params.id, clientIp(request), { closed })
      events.warn('route_group.deleted', '路由组 ' + params.id + ' 已删除' + (closed ? '（断开 ' + closed + ' 条连接）' : ''), {
        detail: { groupId: params.id },
      })
      return { ok: true, closed }
    }, { requireSession: true })
    .post('/route-groups/:id/rotate', ({ params }) => {
      const cred = rotateRouteGroup(db, params.id)
      auth.audit('panel', 'admin', 'route_group.rotate', params.id, null, null)
      return { ok: true, username: cred.username, password: cred.password, effectiveImmediately: true }
    }, { requireSession: true })
    .get('/route-groups/:id/connection', ({ params }) => {
      const gw = gatewayInfo()
      const baseUrl = settings.get().panel.baseUrl || '127.0.0.1'
      return routeGroupConnection(db, params.id, baseUrl, gw.port)
    }, { requireSession: true })
}
