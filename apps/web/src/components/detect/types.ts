/** 检测页的数据契约（GET /api/settings · /api/nodes · /api/jobs · /api/events）。 */

export interface DetectSettings {
  enabled: boolean
  /** 采样周期（秒）：provider 健康历史 → node_status 的落库节流 */
  intervalSec: number
  concurrency: number
  totalTimeoutMs: number
  testUrl: string
  ipEchoUrls: string[]
  quarantineAfter: number
  recoverAfter: number
  historyKeep: number
  checkOnPublish: boolean
  /** 按需 full（取出口 IP）的节流间隔（秒） */
  fullIntervalSec: number
  /** Mihomo 延迟测试（GET /proxies/:name/delay?timeout=）的超时，毫秒 */
  delayTimeoutMs: number
}

export interface DetectNode {
  id: string
  displayName?: string
  protocol: string
  protocolSupported: boolean
  enabled: boolean
  state: string
  lastCheckAt?: number | null
  delayMs?: number | null
  totalMs?: number | null
  errorKind?: string | null
  errorMsg?: string | null
  failStreak?: number
  checksTotal?: number
  checksOk?: number
}

export interface DetectJob {
  id: string
  kind: string
  status: string
  priority?: number
  payload_json?: string | null
  progress: number
  total: number
  message: string | null
  started_at: number | null
  finished_at: number | null
  result: any
  error: string | null
  created_by: string | null
  created_at: number
}

export interface DetectEvent {
  id: number
  at: number
  level: string
  kind: string
  node_id: string | null
  message: string
  detail?: unknown
}

export const DETECT_DEPTHS = [
  { value: "full", label: "全量 full（S1 + S2 + S3）" },
  { value: "lite", label: "轻量 lite（S1 + S2）" },
] as const

export const DETECT_SCOPES = [
  { value: "all", label: "全部可检测节点" },
  { value: "unknown", label: "仅未检测节点" },
  { value: "abnormal", label: "仅异常节点" },
] as const
