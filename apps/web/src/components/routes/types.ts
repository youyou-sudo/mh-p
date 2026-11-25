/** 路由组页用到的响应形状（GET /api/route-groups、/:id、/:id/connection）。 */

export type RouteBalanceMode = "balanced" | "sticky"

export interface RouteGroupMember {
  nodeId: string
  country: string | null
  port: number
  /** 冷却截止时间（毫秒）；未冷却为 null */
  coolingUntil: number | null
  /** sticky 模式下当前选中的节点 */
  current: boolean
}

export interface RouteGroup {
  id: string
  name: string
  countryRegex: string
  balanceMode: RouteBalanceMode
  enabled: boolean
  memberCount: number
  members: RouteGroupMember[]
  updatedAt: number
}

export interface RouteGroupListResponse {
  items: RouteGroup[]
  updatedAt?: number
}

export interface RouteGroupConnection {
  groupId: string
  http: string
  socks5: string
  curl: string
  docker: string[]
  env: string
  clash: string
}

export function balanceModeLabel(mode: RouteBalanceMode): string {
  return mode === "sticky" ? "固定一个直到失败" : "均衡平均"
}
