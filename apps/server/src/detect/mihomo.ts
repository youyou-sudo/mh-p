/**
 * Mihomo 检测层：把「引擎侧的健康事实」映射成检测结果（纯映射，不碰 DB、不自己发网络请求）。
 *
 * 数据面从 Xray 换成 Mihomo 后，健康度只剩两个事实来源：
 *  ① GET /proxies：每个 proxy 带 alive + history[{time, delay}]（Mihomo 最多保留 10 条）；
 *  ② GET /proxies/:name/delay：主动触发一次测速（同步阻塞），成功 200 {delay}，失败 4xx/5xx。
 * 这里只负责语义映射；调度、落库、状态机由调用方负责（本文件零副作用，便于单测）。
 *
 * 与 Xray observatory 的关键差异（来自 Mihomo v1.19.33 源码，真机已复核，见测试里的 skipIf 用例）：
 *  - Mihomo 的 history 在**失败时写 delay=0**，成功时写实测 ms 且 <1ms 会被抬到 1
 *    （adapter/adapter.go 的 URLTest defer：if !satisfied { record.Delay = 0 }；t==0 时 t=1）。
 *    所以 0 是「失败样本」而不是「0ms 延迟」——这和 Xray 的 delay 语义相反，不能照搬。
 *  - Mihomo 是「1 次失败即 alive=false、1 次成功即 true」，没有连续次数确认；判死/恢复阈值
 *    必须由面板状态机自己兜（本层只如实转述 alive / 最后一条样本）。
 *  - 拿不到失败原因（只有 /logs），所以 errorKind 只能来自触发式测速的 HTTP 状态码。
 */
import { MihomoApiError, type MihomoProxiesResponse, type MihomoProxyInfo } from '../mihomo/client'

/** 面板节点 ↔ 数据面代理名的映射（节点名与 Mihomo proxy name 不一定相同） */
export interface SampledProxy {
  nodeId: string
  proxyName: string
}

/** 一次「被动观测」的结论 */
export interface ObservationResult {
  /** 是否健康：alive && 最后一条样本不是失败样本 */
  ok: boolean
  /** 成功时的延迟（ms）；失败或无数据为 null。注意 0 永远不会出现在这里（0 是失败样本） */
  delayMs: number | null
  /** 引擎侧 alive（缺字段时按「未知」处理，只看 history） */
  alive: boolean
  /** history 最后一条的原始 delay 值（失败样本是 0），便于排查/审计 */
  lastDelay: number | null
  /** history 条数（Mihomo 上限 10） */
  samples: number
}

/**
 * 把 /proxies 里的单个 proxy 映射成观测结论。
 *
 * 返回 null = **没有数据**（proxy 不存在，或从来没有被测过），调用方必须跳过、绝不能判死：
 * 引擎刚启动、provider 还没跑完第一轮健康检查时都是这个状态，当成「死」会整池雪崩。
 *
 * 返回 ok=false 才是「有数据且数据说它坏了」：
 *  - alive=false（Mihomo 1 次失败就会翻成 false）；
 *  - 或者最后一条样本 delay===0（失败样本），即使 alive 还没来得及翻（并发窗口）。
 */
export function observationOf(proxy: MihomoProxyInfo | undefined): ObservationResult | null {
  if (!proxy) return null
  const history = proxy.history ?? []
  if (history.length === 0) return null
  const last = history[history.length - 1]!
  const lastDelay = typeof last.delay === 'number' && Number.isFinite(last.delay) ? last.delay : 0
  // /proxies 对普通代理与 provider 代理都带 alive（真机复核）；缺字段时只信 history
  const alive = proxy.alive !== false
  const ok = alive && lastDelay > 0
  return { ok, delayMs: ok ? lastDelay : null, alive, lastDelay, samples: history.length }
}

/**
 * GET /proxies/:name/delay 的 HTTP 状态 → errorKind。
 *
 * 状态码来自 Mihomo 源码（hub/route/proxies.go getProxyDelay）：
 *   200       成功（返回 {delay}；成功值 ≥1，见模块头注释）
 *   400       timeout/expected 查询参数不合法
 *   401/403   鉴权失败（secret 不对）
 *   404       该 proxy 不存在（节点名与数据面不一致，通常意味着发布/重载没同步）
 *   504       测试超时（context deadline exceeded）
 *   503       探测失败（连不上目标 / 状态码不符合 expected），最常见的一种
 *   其他      未识别
 * status=0 是我们自己的 MihomoApiError 约定（fetch 层失败：引擎没起来/端口不通），
 * 它不等于「节点坏」，调用方应把它当引擎不可用处理。
 */
export function classifyDelayError(status: number): string {
  if (status === 0) return 'engine_unavailable'
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'proxy_not_found'
  if (status === 408 || status === 504) return 'timeout'
  if (status >= 500) return 'delay_failed'
  if (status >= 400) return 'delay_rejected'
  return 'delay_failed'
}

/**
 * 一次读 /proxies，批量映射成 nodeId → 观测结论。
 *
 * 读取失败整批返回空 Map，**不抛也不伪造失败**：读不到 /proxies 说明引擎/控制面通道有问题，
 * 这时把节点判死是错的（会把整池节点误隔离），正确做法是本轮跳过、由调用方决定降级/事件。
 */
export async function sampleProxies(deps: {
  read: () => Promise<MihomoProxiesResponse>
  targets: SampledProxy[]
}): Promise<Map<string, ObservationResult>> {
  const out = new Map<string, ObservationResult>()
  if (deps.targets.length === 0) return out
  let res: MihomoProxiesResponse
  try {
    res = await deps.read()
  } catch {
    return out
  }
  const proxies = res?.proxies ?? {}
  for (const t of deps.targets) {
    const obs = observationOf(proxies[t.proxyName])
    if (obs) out.set(t.nodeId, obs)
  }
  return out
}

/**
 * 触发式测速：给采不到 /proxies 观测的节点（从未发布 / 未被任何组的健康检查覆盖）用。
 *
 * 成功只认「返回了 >0 的延迟」：Mihomo 成功时最小是 1ms，返回 0/负数都按失败处理。
 * 任何异常都按 HTTP 状态归类成 errorKind——不向上抛，否则一个节点的探测失败会中断整批。
 */
export async function probeOne(deps: {
  delay: (name: string, url: string, timeoutMs: number) => Promise<number>
  proxyName: string
  url: string
  timeoutMs: number
}): Promise<{ ok: boolean; delayMs?: number; errorKind?: string }> {
  let delayMs: number
  try {
    delayMs = await deps.delay(deps.proxyName, deps.url, deps.timeoutMs)
  } catch (e) {
    const status = e instanceof MihomoApiError ? e.status : 0
    return { ok: false, errorKind: classifyDelayError(status) }
  }
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs <= 0) {
    // Mihomo 的成功值 ≥1；0/非法值只可能来自异常响应或引擎 bug
    return { ok: false, errorKind: 'delay_failed' }
  }
  return { ok: true, delayMs }
}
