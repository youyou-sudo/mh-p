/**
 * Mihomo 控制面客户端（Clash 兼容 REST）。
 *
 * 数据面从 Xray 换成 Mihomo 后，面板与引擎之间只剩一个通道：external-controller 的 HTTP API。
 * 这里只封装面板需要的那一小撮端点，刻意不追求覆盖全 API——多一个方法就多一份需要维护的语义。
 *
 * 鉴权：单一 secret，请求头 Authorization: Bearer <secret>；secret 为空时不带头。
 * 错误约定：HTTP 非 2xx 或网络错误一律 throw MihomoApiError（带 status 与响应片段），
 * 由调用方决定是「引擎不可用」还是「单个操作失败」——这两者的降级语义完全不同。
 */

export interface MihomoClientOptions {
  /** 形如 http://127.0.0.1:9090（不含尾斜杠） */
  baseUrl: () => string
  secret: () => string
  timeoutMs?: () => number
}

export class MihomoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
    readonly body: string = '',
  ) {
    super(message)
    this.name = 'MihomoApiError'
  }
}

/** GET /version */
export interface MihomoVersionInfo {
  version?: string
  meta?: boolean
}

/** GET /proxies 里单个代理的形状（只取面板用到的字段） */
export interface MihomoProxyInfo {
  name: string
  type: string
  /** provider 来源；Mihomo 对 provider 内代理会填 provider-name */
  provider?: string
  /** 多把「尺子」时的分项结果（provider 与组用不同 testUrl 时出现） */
  extra?: Record<string, { alive?: boolean; history?: { time: string; delay: number }[] }>
  /** provider 的名字（/proxies 返回里叫 provider-name） */
  providerName?: string
  udp?: boolean
  /** 组才有：可选成员 */
  all?: string[]
  /** 组才有：当前选中项 */
  now?: string
  /** 是否有健康检查结果（组/provider 代理才会持续更新） */
  alive?: boolean
  /** 最近若干次延迟测试（毫秒）；失败记为 0 */
  history?: { time: string; delay: number }[]
}

export interface MihomoProxiesResponse {
  proxies: Record<string, MihomoProxyInfo>
}

export interface MihomoProviderInfo {
  name: string
  type: string
  vehicleType?: string
  proxies?: MihomoProxyInfo[]
  updatedAt?: string
  subscriptionInfo?: Record<string, unknown>
}

export interface MihomoProvidersResponse {
  providers: Record<string, MihomoProviderInfo>
}

export interface MihomoTrafficInfo {
  up: number
  down: number
  upTotal?: number
  downTotal?: number
}

export interface MihomoConnectionMeta {
  network?: string
  type?: string
  sourceIP?: string
  destinationIP?: string
  destinationPort?: string
  inboundPort?: string
  host?: string
  process?: string
}

export interface MihomoConnection {
  id: string
  metadata: MihomoConnectionMeta
  upload: number
  download: number
  start: string
  chains: string[]
  rule?: string
  rulePayload?: string
}

export interface MihomoConnectionsResponse {
  downloadTotal: number
  uploadTotal: number
  connections: MihomoConnection[]
}

export const MIHOMO_DELAY_TIMEOUT_MS = 5000

export class MihomoClient {
  constructor(private opts: MihomoClientOptions) {}

  private get timeoutMs(): number {
    return this.opts.timeoutMs?.() ?? 5000
  }

  /** 底层请求：统一鉴权、超时、错误归一；返回解析后的 JSON（空响应返回 undefined） */
  async request<T = unknown>(path: string, init: RequestInit = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const base = this.opts.baseUrl().replace(/\/+$/, '')
    const secret = this.opts.secret()
    const headers: Record<string, string> = {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    }
    if (secret) headers['authorization'] = 'Bearer ' + secret

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(base + path, { ...init, headers, signal: ctrl.signal })
    } catch (e) {
      clearTimeout(timer)
      const msg = e instanceof Error ? e.message : String(e)
      throw new MihomoApiError('mihomo 请求失败（' + path + '）：' + msg, 0, path)
    }
    clearTimeout(timer)

    const text = await res.text().catch(() => '')
    if (!res.ok) {
      throw new MihomoApiError(
        'mihomo ' + path + ' -> HTTP ' + res.status + (text ? '：' + text.slice(0, 200) : ''),
        res.status,
        path,
        text,
      )
    }
    if (!text.trim()) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new MihomoApiError('mihomo ' + path + ' 返回非 JSON', res.status, path, text.slice(0, 200))
    }
  }

  async version(): Promise<MihomoVersionInfo> {
    return this.request<MihomoVersionInfo>('/version', {}, 1000)
  }

  /** GET /configs：返回当前生效配置的摘要（含 port/mode/…，不含 proxies） */
  async configs(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/configs')
  }

  /**
   * PUT /configs：整份配置重载。
   * payload 形态：Mihomo 接受 { path: '<绝对路径>' } 或 { payload: '<yaml/plain 文本>' }。
   * 面板走 path（配置文件本来就落在 DATA_DIR 里，避免把整份配置塞进 HTTP body）。
   */
  async reloadFromPath(path: string): Promise<void> {
    await this.request('/configs', {
      method: 'PUT',
      body: JSON.stringify({ path, force: true }),
    }, Math.max(this.timeoutMs, 15000))
  }

  async reloadFromPayload(configText: string): Promise<void> {
    await this.request('/configs', {
      method: 'PUT',
      body: JSON.stringify({ payload: configText, force: true }),
    }, Math.max(this.timeoutMs, 15000))
  }

  /** GET /proxies：所有代理与组（含 provider 内代理） */
  async proxies(): Promise<MihomoProxiesResponse> {
    return this.request<MihomoProxiesResponse>('/proxies', {}, Math.max(this.timeoutMs, 10000))
  }

  async proxy(name: string): Promise<MihomoProxyInfo> {
    return this.request<MihomoProxyInfo>('/proxies/' + encodeURIComponent(name))
  }

  /**
   * GET /proxies/:name/delay：主动触发一次延迟测试（同步阻塞）。
   * 成功返回毫秒数；失败在 Mihomo 侧是 4xx/5xx（503/504 常见），这里统一抛 MihomoApiError，
   * 调用方把「抛错」当作本次探测失败即可（错误码可用于区分超时与拒绝）。
   */
  async proxyDelay(name: string, url: string, timeoutMs = MIHOMO_DELAY_TIMEOUT_MS): Promise<number> {
    const qs = '?url=' + encodeURIComponent(url) + '&timeout=' + Math.max(1000, Math.trunc(timeoutMs))
    const res = await this.request<{ delay: number }>(
      '/proxies/' + encodeURIComponent(name) + '/delay' + qs,
      {},
      Math.max(timeoutMs + 2000, this.timeoutMs),
    )
    if (!res || typeof res.delay !== 'number') {
      throw new MihomoApiError('mihomo delay 返回缺少 delay 字段', 200, '/proxies/' + name + '/delay')
    }
    return res.delay
  }

  /** GET /providers/proxies：所有 proxy-provider 及其代理列表 */
  async providers(): Promise<MihomoProvidersResponse> {
    return this.request<MihomoProvidersResponse>('/providers/proxies', {}, Math.max(this.timeoutMs, 10000))
  }

  async provider(name: string): Promise<MihomoProviderInfo> {
    return this.request<MihomoProviderInfo>('/providers/proxies/' + encodeURIComponent(name), {}, Math.max(this.timeoutMs, 10000))
  }

  /**
   * 触发某个 provider 的**全量**即时健康检查（GET /providers/proxies/:name/healthcheck → 204，异步）。
   * 注意：是 GET 不是 POST（POST 该路径 404）；返回 204 时结果还没写完，要等一拍再读 /providers/proxies。
   */
  async providerHealthCheck(name: string): Promise<void> {
    await this.request('/providers/proxies/' + encodeURIComponent(name) + '/healthcheck', {}, Math.max(this.timeoutMs, 30000))
  }

  /**
   * 单个 provider 内 proxy 的状态：GET /providers/proxies/:provider/:proxy。
   * provider 内 proxy **不一定**出现在 /proxies 顶层（实测 v1.19.33 不出现在顶层），
   * 所以健康数据必须以这里为准。
   */
  async providerProxy(provider: string, proxy: string): Promise<MihomoProxyInfo> {
    return this.request<MihomoProxyInfo>(
      '/providers/proxies/' + encodeURIComponent(provider) + '/' + encodeURIComponent(proxy),
      {},
      Math.max(this.timeoutMs, 10000),
    )
  }

  /**
   * 对单个 provider 内 proxy 触发一次延迟测试：GET /providers/proxies/:p/:proxy/healthcheck。
   * 这是 Clash API 里唯一能「指定单个 provider proxy 测速」的端点（/proxies/:name/delay 不认 provider proxy）。
   * 实测语义：写回该 proxy 的 history/alive，返回 204；失败可能直接 4xx/5xx 或只体现在 history 上，
   * 因此调用方要「触发后重读状态」，不要指望返回值里的延迟。
   */
  async providerProxyHealthCheck(provider: string, proxy: string, timeoutMs = 10000): Promise<void> {
    await this.request(
      '/providers/proxies/' + encodeURIComponent(provider) + '/' + encodeURIComponent(proxy) + '/healthcheck',
      {},
      Math.max(timeoutMs, this.timeoutMs),
    )
  }

  /** GET /connections：当前连接（用于网关/指标观测） */
  async connections(): Promise<MihomoConnectionsResponse> {
    return this.request<MihomoConnectionsResponse>('/connections', {}, Math.max(this.timeoutMs, 10000))
  }

  /** DELETE /connections：关闭全部连接（重启数据面/维护时用） */
  async closeAllConnections(): Promise<void> {
    await this.request('/connections', { method: 'DELETE' })
  }

  /** GET /traffic：全局瞬时速率（面板只能做全局，不按节点） */
  async traffic(): Promise<MihomoTrafficInfo> {
    return this.request<MihomoTrafficInfo>('/traffic', {}, 2000)
  }
}
