import type { Db } from './db'
import { routeGroups } from './schema'

/**
 * 路由组：把「按国家字段正则圈定的一批节点」聚合成一个可接入的路由端点。
 *
 * - 客户端用组 ID 作为用户名连接网关，密码来自 route_groups（组凭据，独立于节点凭据）；
 * - balance_mode = 'balanced'：在匹配到且已上线的节点间轮询（均衡平均）；
 * - balance_mode = 'sticky'：一直用同一个节点，直到拨号失败，才切换到下一个，
 *   并把失败的节点放进 10 分钟冷却，冷却期内不再被选中。
 *
 * 本模块是纯内存状态机：配置由 DB 装载（replaceConfigs），节点目录由发布/节点变更时刷新
 * （setCatalog）。选择结果只读内存，不进 DB，控制面重启后从冷启动状态重新开始。
 */

export type BalanceMode = 'balanced' | 'sticky'

/** 拨号失败后的冷却时长（需求：失效 10 分钟） */
export const ROUTE_GROUP_COOLDOWN_MS = 10 * 60 * 1000

export interface RouteGroupConfig {
  id: string
  name: string
  countryRegex: string
  balanceMode: BalanceMode
  enabled: boolean
}

/** 目录里的一个候选节点：国家码 + 已发布到的槽位端口 */
export interface RouteGroupNode {
  nodeId: string
  country: string | null
  port: number
}

export interface RouteSelection {
  nodeId: string
  port: number
}

export interface RouteGroupMemberView {
  nodeId: string
  country: string | null
  port: number
  /** 冷却截止时间（毫秒）；未冷却为 null */
  coolingUntil: number | null
  /** sticky 模式下当前选中的节点 */
  current: boolean
}

export function normalizeBalanceMode(v: unknown): BalanceMode {
  return v === 'sticky' ? 'sticky' : 'balanced'
}

/** 国家正则统一按大小写不敏感编译；非法正则返回 null（配置校验会提前拦下）。 */
export function compileCountryRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

export class RouteGroupRegistry {
  private configs = new Map<string, RouteGroupConfig>()
  private catalog: RouteGroupNode[] = []
  /** balanced 轮询指针 */
  private rr = new Map<string, number>()
  /** sticky 当前节点 */
  private current = new Map<string, string>()
  /** groupId -> nodeId -> 冷却截止时间 */
  private cooldown = new Map<string, Map<string, number>>()

  constructor(private readonly cooldownMs: number = ROUTE_GROUP_COOLDOWN_MS) {}

  /** 从 DB 装载的配置替换内存配置（保留仍存在的组的轮询/粘滞/冷却状态）。 */
  replaceConfigs(configs: RouteGroupConfig[]): void {
    const next = new Map<string, RouteGroupConfig>()
    for (const c of configs) next.set(c.id, c)
    for (const id of [...this.rr.keys()]) if (!next.has(id)) this.rr.delete(id)
    for (const id of [...this.current.keys()]) if (!next.has(id)) this.current.delete(id)
    for (const id of [...this.cooldown.keys()]) if (!next.has(id)) this.cooldown.delete(id)
    this.configs = next
  }

  /** 刷新节点目录（enabled + 协议可发布 + 已分配到槽位端口的节点）。 */
  setCatalog(nodes: RouteGroupNode[]): void {
    this.catalog = nodes.map((n) => ({ ...n }))
  }

  isGroup(id: string): boolean {
    return this.configs.has(id)
  }

  getConfig(id: string): RouteGroupConfig | undefined {
    return this.configs.get(id)
  }

  listConfigs(): RouteGroupConfig[] {
    return [...this.configs.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** 组内匹配到正则的全部节点（是否冷却/是否当前另算）。 */
  members(groupId: string): RouteGroupNode[] {
    const group = this.configs.get(groupId)
    if (!group) return []
    const re = compileCountryRegex(group.countryRegex)
    if (!re) return []
    return this.catalog
      .filter((n) => n.country != null && re.test(String(n.country)))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
  }

  /** 供面板展示：成员列表 + 冷却状态 + sticky 当前项。 */
  describe(groupId: string, now = Date.now()): RouteGroupMemberView[] {
    const cur = this.current.get(groupId)
    return this.members(groupId).map((n) => ({
      nodeId: n.nodeId,
      country: n.country,
      port: n.port,
      coolingUntil: this.coolingUntil(groupId, n.nodeId, now) ?? null,
      current: cur === n.nodeId,
    }))
  }

  /** 为一个新连接选择出口节点；无匹配、组停用或未配置时返回 undefined。 */
  resolve(groupId: string, now = Date.now()): RouteSelection | undefined {
    const group = this.configs.get(groupId)
    if (!group || !group.enabled) return undefined
    const matched = this.members(groupId)
    if (matched.length === 0) return undefined
    const live = matched.filter((n) => this.coolingUntil(groupId, n.nodeId, now) === undefined)
    // 全组都在冷却时仍给出最早恢复的那个，避免整组完全不可用（此时本就连不上，给一次尝试更合理）。
    const pool = live.length > 0 ? live : matched
    const node = group.balanceMode === 'sticky' ? this.pickSticky(groupId, pool) : this.pickBalanced(groupId, pool)
    return node ? { nodeId: node.nodeId, port: node.port } : undefined
  }

  /** 网关拨号失败回执：标记节点失效并冷却，sticky 当前项立即失效以便下次换节点。 */
  reportFailure(groupId: string, nodeId: string, now = Date.now()): void {
    let m = this.cooldown.get(groupId)
    if (!m) {
      m = new Map()
      this.cooldown.set(groupId, m)
    }
    m.set(nodeId, now + this.cooldownMs)
    if (this.current.get(groupId) === nodeId) this.current.delete(groupId)
  }

  private pickBalanced(groupId: string, pool: RouteGroupNode[]): RouteGroupNode | undefined {
    if (pool.length === 0) return undefined
    const idx = this.rr.get(groupId) ?? 0
    const node = pool[idx % pool.length]
    this.rr.set(groupId, (idx + 1) % pool.length)
    return node
  }

  private pickSticky(groupId: string, pool: RouteGroupNode[]): RouteGroupNode | undefined {
    if (pool.length === 0) return undefined
    const cur = this.current.get(groupId)
    if (cur) {
      const hit = pool.find((n) => n.nodeId === cur)
      if (hit) return hit
    }
    const node = pool[0]
    if (node) this.current.set(groupId, node.nodeId)
    return node
  }

  private coolingUntil(groupId: string, nodeId: string, now: number): number | undefined {
    const m = this.cooldown.get(groupId)
    if (!m) return undefined
    const until = m.get(nodeId)
    if (until === undefined) return undefined
    if (until <= now) {
      m.delete(nodeId)
      return undefined
    }
    return until
  }
}

/** 从 DB 读取路由组配置（供启动与 CRUD 后重载）。 */
export function loadRouteGroupConfigs(db: Db): RouteGroupConfig[] {
  return db
    .select()
    .from(routeGroups)
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      countryRegex: r.country_regex,
      balanceMode: normalizeBalanceMode(r.balance_mode),
      enabled: !!r.enabled,
    }))
}

// I have nothing but my burger and I want nothing more
