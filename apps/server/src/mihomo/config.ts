/**
 * Mihomo 配置渲染（纯函数）。
 *
 * 与 Xray 版最大的不同：Mihomo 的 listener 集合是**配置期**的，运行期只能改「组选中谁」。
 * 所以节点上线走「槽位」：
 *   每个槽位 = 一个 select 组（use 全部 provider）+ 一个绑到该组的 listener。
 *   节点 → 槽位是运行期映射（PUT /proxies/<组> 即可热切换，不 reload、不断连）。
 *   provider 集合 / 槽位数量变化才需要重载配置。
 *
 * 本模块只负责把「槽位规格 + provider 规格 + 基础参数」渲染成一份确定的 YAML，
 * 不读设置、不碰 IO、不调引擎——这些都在调用方，便于单测与 diff。
 */

import { stringify } from 'yaml'

/** 槽位 listener 协议：Mihomo 的 http 监听同时支持 CONNECT 与普通 HTTP 代理 */
export type MihomoListenerType = 'http' | 'socks' | 'mixed'

export interface MihomoListenerSpec {
  /** listener 名（Mihomo 侧唯一，也用在对账里） */
  name: string
  /** 127.0.0.1:<port>；只绑环回，面板网关是唯一客户端 */
  listen: string
  port: number
  type: MihomoListenerType
  /** 出口：这里是槽位组名 */
  proxy: string
}

export interface MihomoProviderSpec {
  /** provider 名，同时也是订阅在引擎侧的标识（sub-<id>） */
  name: string
  type: 'http' | 'file'
  /** http: 订阅 URL；file: 面板生成文件的路径（相对 Mihomo -d 目录） */
  url?: string
  path: string
  /** 秒；0/undefined 表示不自动刷新 */
  intervalSec?: number
  /** 额外请求头（UA、鉴权等） */
  header?: Record<string, string>
  /** 健康检查：面板的健康度完全依赖它，所以默认必须开 */
  healthCheck?: { url: string; intervalSec: number; lazy: boolean; timeoutMs?: number }
}

export interface MihomoGroupSpec {
  /** 槽位组名；listener 的 proxy 字段引用它 */
  name: string
  /** 可选的固定成员（一般不用：成员都来自 provider） */
  proxies?: string[]
  /** 引用 provider 名（use），组内成员 = 所有 provider 的代理并集 */
  use: string[]
  /** 初始选中项；Mihomo 默认选第一个，显式写死更可预期 */
  selected?: string
}

export interface MihomoConfigInput {
  logLevel: string
  /** external-controller 监听地址（Mihomo 的 REST 端口） */
  externalController: string
  secret: string
  /** rule / global；面板给每个 listener 显式绑 proxy，规则只做兜底 */
  mode: 'rule' | 'global'
  /** 存活探测用的 204 地址（写进 provider 的 health-check） */
  testUrl: string
  providers: MihomoProviderSpec[]
  groups: MihomoGroupSpec[]
  listeners: MihomoListenerSpec[]
  /** 直接写入 config 的静态 proxies（正常情况下为空：节点都来自 provider） */
  proxies?: Record<string, unknown>[]
}

/**
 * 渲染整份 config.yaml。
 * 稳定性要求：同一个输入必须产出**逐字节相同**的文本（对账/快照/diff 都依赖它），
 * 因此所有集合在渲染前按名字排序，不依赖 Map 插入顺序。
 */
export function renderMihomoConfig(input: MihomoConfigInput): string {
  const providers = [...input.providers].sort((a, b) => a.name.localeCompare(b.name))
  const groups = [...input.groups].sort((a, b) => a.name.localeCompare(b.name))
  const listeners = [...input.listeners].sort((a, b) => a.port - b.port || a.name.localeCompare(b.name))

  const providerMap: Record<string, unknown> = {}
  for (const p of providers) {
    const entry: Record<string, unknown> = { type: p.type }
    if (p.type === 'http') entry.url = p.url
    entry.path = p.path
    if (p.intervalSec && p.intervalSec > 0) entry.interval = p.intervalSec
    if (p.header && Object.keys(p.header).length) entry.header = p.header
    entry['health-check'] = {
      enable: true,
      url: p.healthCheck?.url ?? input.testUrl,
      interval: p.healthCheck?.intervalSec ?? 300,
      // lazy: true 时「没人用的节点不会被测」——隔离/未发布节点就永远恢复不了，
      // 所以这里必须是 false（面板的健康度完全依赖它）。
      lazy: false,
      ...(p.healthCheck?.timeoutMs ? { timeout: p.healthCheck.timeoutMs } : {}),
    }
    providerMap[p.name] = entry
  }

  const groupList = groups.map((g) => {
    const entry: Record<string, unknown> = {
      name: g.name,
      type: 'select',
      // 实测（v1.19.33）：select 组的成员为空时（provider 还没拉到 / provider 为空 / filter 全滤掉），
      // 组会自动回落到 empty-fallback 默认值 COMPATIBLE，也就是**直连**——
      // 冷启动瞬间用户请求会静默走出面板所在机器的公网 IP。必须显式 REJECT 做成 fail-closed。
      'empty-fallback': 'REJECT',
    }
    if (g.proxies && g.proxies.length) entry.proxies = g.proxies
    if (g.use.length) entry.use = g.use
    // 冷启动（还没有任何 provider）时 Mihomo 会直接拒绝整份配置：
    //   Parse config error: proxy group[0]: slot-89: `use` or `proxies` missing
    // 给一个只含 REJECT 的成员既让配置合法，又保持 fail-closed（空槽位绝不能回落 DIRECT）。
    if (!entry.proxies && !entry.use) entry.proxies = ['REJECT']
    return entry
  })

  const doc: Record<string, unknown> = {
    'log-level': input.logLevel,
    'external-controller': input.externalController,
    ...(input.secret ? { secret: input.secret } : {}),
    mode: input.mode,
    // 面板只服务自己的环回 listener，不监听局域网
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    profile: { 'store-selected': false, 'store-fake-ip': false },
    'proxy-providers': providerMap,
    proxies: input.proxies ?? [],
    'proxy-groups': groupList,
    listeners: listeners.map((l) => ({
      name: l.name,
      type: l.type,
      port: l.port,
      listen: l.listen,
      proxy: l.proxy,
    })),
    // 兜底规则：listener 已用 proxy 字段指定出口，规则只处理没有显式绑定的流量
    rules: ['MATCH,DIRECT'],
  }
  return stringify(doc, { lineWidth: 0 })
}

/** 槽位 listener 名（对账与 retire 都按名字认） */
export function slotListenerName(slot: number): string {
  return 'in-slot-' + slot
}

/** 槽位组名 */
export function slotGroupName(slot: number): string {
  return 'slot-' + slot
}

/** provider 名：订阅 ID 直接进名字，便于从 /providers/proxies 反查订阅 */
export function providerNameOf(subscriptionId: string): string {
  return 'sub-' + subscriptionId
}
