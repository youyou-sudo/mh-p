import type { AppConfig } from './config'
import type { Db } from './core/db'
import type { EventBus } from './core/events'
import type { SettingsStore } from './core/settings'
import type { RoutingTable } from './core/routing'
import type { RouteGroupRegistry } from './core/route-groups'
import type { ConnectionTracker } from './core/connlog'
import type { AuthService } from './modules/auth/service'
import type { JobQueue } from './jobs/queue'
import type { Scheduler } from './jobs/scheduler'
import type { SyncService } from './sync/sync'
import type { MihomoClient } from './mihomo/client'
import type { MihomoProcess } from './mihomo/process'
import type { SlotManager } from './publish/slots'
import type { MihomoPublisher, PublishOutcome } from './publish/mihomo-publish'
import type { CheckResult } from './detect/persist'
import type { Gateway } from './gateway/server'

/** 数据面（Mihomo）健康摘要：/api/health 与面板顶部状态用 */
export interface EngineHealth {
  mode: string
  status: string
  pid: number | null
  version: string | null
  /** REST /version 是否可达 */
  rest: 'ok' | 'unreachable'
  apiLatencyMs: number
  slotUsed: number
  slotCapacity: number
  /** provider 个数与它们在引擎里实际加载到的 proxy 总数 */
  providerCount: number
  proxyCount: number
  uptimeSec: number
  restarts: number
  lastPublishAt: number | null
  /** 期望结构与磁盘 config 不一致（下一次 publish 会 reload） */
  reloadNeeded: boolean
}

export interface HealthReport {
  panel: 'ok'
  sqlite: 'ok' | 'error'
  schemaVersion: number
  engine: EngineHealth
  gateway: { listen: string; enabled: boolean; activeConns: number; authFailures5m: number; banned: number }
  /** 槽位端口占用情况（端口池已被槽位取代） */
  ports: { pool: number; used: number; cooling: number; bindable: { port: number; ok: boolean }[] }
  checks: { id: string; label: string; ok: boolean; detail: string; level: 'ok' | 'degraded' | 'error' }[]
  overall: 'ok' | 'degraded'
}

export interface CheckNodesOptions {
  /** 是否包含隔离节点（手动检查要能测隔离节点，否则它永远恢复不了） */
  includeQuarantined?: boolean
  /** 事件/审计来源标记 */
  source?: string
  onProgress?: (done: number, total: number) => void
}

export interface AppContext {
  config: AppConfig
  db: Db
  settings: SettingsStore
  events: EventBus
  jobs: JobQueue
  auth: AuthService
  sync: SyncService
  /** Mihomo REST 客户端（唯一的数据面通道） */
  client: MihomoClient
  /** 数据面进程（面板托管时有效） */
  process: MihomoProcess
  /** 槽位表（listener ↔ 端口 ↔ 节点） */
  slots: SlotManager
  /** 发布引擎：结构 reload + 槽位热切换 */
  publisher: MihomoPublisher
  /** 数据面工作目录（= Mihomo -d）与它的 config.yaml：健康检查/设置页自检要读它 */
  engineDir: string
  engineConfigPath: string
  /**
   * 发布（带别名路由回填）。面板/订阅/对账都走它，不要直接调 publisher.publish：
   * 别名（node_aliases）不在槽位模型里，漏了它等于把用别名接线的用户踢下线。
   */
  publish: (o?: { reason?: string; dryRun?: boolean }) => Promise<PublishOutcome>
  routing: RoutingTable
  /** 路由组内存注册表：成员来自国家正则，选择/冷却状态在内存 */
  routeGroups: RouteGroupRegistry
  /** 刷新路由组节点目录（发布成功、节点国家/启用状态变更后调用） */
  refreshRouteGroups: () => void
  conns: ConnectionTracker
  scheduler: Scheduler
  gateway: Gateway | null
  startedAt: number
  gatewayInfo: () => { host: string; port: number; enabled: boolean }
  /** 网关 listener 的当前错误（null = 正常）；面板改配置后会重试并更新 */
  gatewayError: () => string | null
  setGatewayError: (msg: string | null) => void
  health: () => Promise<HealthReport>
  /** 端口能否 bind（健康检查与设置页自检共用；不再有端口池） */
  canBind: (port: number, hostname?: string) => Promise<boolean>
  /**
   * 按需检测：经槽位 listener 发真实请求，拿 error_kind / 出口 IP。
   * 手动检查、/v1/detect/run 共用；没发布到槽位的节点会返回 ok=false + 可读原因（不是判死）。
   */
  checkNodes: (nodeIds: string[] | undefined, depth: 'lite' | 'full', opts?: CheckNodesOptions) => Promise<CheckResult[]>
  /** 周期采样：读 provider 健康历史驱动状态机（不经过本进程发请求） */
  sample: () => Promise<{ sampled: number; skipped: number; unavailable: boolean }>
  /** 断开指定节点/用户/IP/连接的全部连接（网关能力，§10.1） */
  kick: (pred: { nodeId?: string; username?: string; ip?: string; connId?: number }) => number
  /** 立即重启数据面 + 重放（槽位重新指派） */
  restartDataplane: () => Promise<{ ok: boolean; replayed: number; error?: string }>
}
