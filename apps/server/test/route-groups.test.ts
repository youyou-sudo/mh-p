/**
 * 路由组核心逻辑（core/route-groups.ts）：
 * 国家正则匹配、均衡平均轮询、sticky 失败切换与 10 分钟冷却。
 */
import { describe, expect, test } from 'bun:test'
import { RouteGroupRegistry, ROUTE_GROUP_COOLDOWN_MS, type RouteGroupConfig } from '../src/core/route-groups'

function cfg(over: Partial<RouteGroupConfig> = {}): RouteGroupConfig {
  return { id: 'hk', name: '香港组', countryRegex: '^HK$', balanceMode: 'balanced', enabled: true, ...over }
}

const CATALOG = [
  { nodeId: 'hk1', country: 'HK', port: 30001 },
  { nodeId: 'hk2', country: 'hk', port: 30002 },
  { nodeId: 'jp1', country: 'JP', port: 30003 },
]

describe('路由组：国家正则与成员', () => {
  test('大小写不敏感地匹配国家码，只收进组内的节点', () => {
    const r = new RouteGroupRegistry()
    r.replaceConfigs([cfg()])
    r.setCatalog(CATALOG)
    expect(r.members('hk').map((n) => n.nodeId)).toEqual(['hk1', 'hk2'])
    expect(r.members('nope')).toEqual([])
  })

  test('非法正则不匹配任何节点（不抛异常）', () => {
    const r = new RouteGroupRegistry()
    r.replaceConfigs([cfg({ countryRegex: '([' })])
    r.setCatalog(CATALOG)
    expect(r.members('hk')).toEqual([])
    expect(r.resolve('hk')).toBeUndefined()
  })

  test('停用的组不解析', () => {
    const r = new RouteGroupRegistry()
    r.replaceConfigs([cfg({ enabled: false })])
    r.setCatalog(CATALOG)
    expect(r.resolve('hk')).toBeUndefined()
  })
})

describe('路由组：均衡平均', () => {
  test('在成员间轮询，用尽后回到第一个', () => {
    const r = new RouteGroupRegistry()
    r.replaceConfigs([cfg({ balanceMode: 'balanced' })])
    r.setCatalog(CATALOG)
    const picks = [0, 1, 2, 3].map(() => r.resolve('hk')!.nodeId)
    expect(picks).toEqual(['hk1', 'hk2', 'hk1', 'hk2'])
  })
})

describe('路由组：固定一个直到失败', () => {
  test('一直选中同一个，拨号失败后切换到另一个', () => {
    const r = new RouteGroupRegistry()
    r.replaceConfigs([cfg({ balanceMode: 'sticky' })])
    r.setCatalog(CATALOG)
    expect(r.resolve('hk')!.nodeId).toBe('hk1')
    expect(r.resolve('hk')!.nodeId).toBe('hk1')
    // 模拟网关回执：hk1 拨号失败
    r.reportFailure('hk', 'hk1')
    expect(r.resolve('hk')!.nodeId).toBe('hk2')
    expect(r.resolve('hk')!.nodeId).toBe('hk2')
  })

  test('失败节点冷却 10 分钟，冷却结束后重新可选', () => {
    const r = new RouteGroupRegistry()
    r.replaceConfigs([cfg({ balanceMode: 'sticky' })])
    r.setCatalog(CATALOG)
    const t0 = 1_000_000
    r.resolve('hk', t0) // 选中 hk1
    r.reportFailure('hk', 'hk1', t0)
    // 冷却期内：hk1 被跳过
    const mid = r.describe('hk', t0 + 60_000)
    expect(mid.find((m) => m.nodeId === 'hk1')!.coolingUntil).toBe(t0 + ROUTE_GROUP_COOLDOWN_MS)
    expect(r.resolve('hk', t0 + 60_000)!.nodeId).toBe('hk2')
    // 冷却结束后：hk1 的 coolingUntil 归零，重新进入候选
    const later = r.describe('hk', t0 + ROUTE_GROUP_COOLDOWN_MS + 1)
    expect(later.find((m) => m.nodeId === 'hk1')!.coolingUntil).toBeNull()
  })

  test('全部成员都在冷却时仍给出一个（避免整组不可用）', () => {
    const r = new RouteGroupRegistry()
    r.replaceConfigs([cfg({ countryRegex: '^HK$', balanceMode: 'sticky' })])
    r.setCatalog([{ nodeId: 'hk1', country: 'HK', port: 1 }])
    const t0 = 5_000
    r.reportFailure('hk', 'hk1', t0)
    expect(r.resolve('hk', t0 + 1)!.nodeId).toBe('hk1')
  })
})
