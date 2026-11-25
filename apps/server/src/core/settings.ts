import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from './db'
import { validationFailed } from './errors'
import { settings as settingsTable } from './schema'

/** PANEL.md §6.7 settings 默认形态（面板可视化编辑，唯一配置入口，D8） */
export interface Settings {
  panel: { baseUrl: string; language: string; sessionTtlHours: number }
  gateway: {
    enabled: boolean
    listen: string
    authMode: 'strict' | 'username-only'
    tls: { enabled: boolean; certFile: string; keyFile: string }
    maxConcurrentPerUser: number
    maxConcurrentPerIp: number
    idleTimeoutSec: number
    dialTimeoutMs: number
    authFailBanCount: number
    authFailBanSec: number
    protocols: { http: boolean; socks5: boolean }
  }
  /**
   * Mihomo 数据面的设置（新链路读写这一组）。
   * 过渡期与下面的 xray 并存：旧引擎代码还在读 xray.*，cutover 时统一删除。
   */
  engine: {
    mode: 'managed' | 'external'
    /** Mihomo 二进制（路径或 PATH 里的名字）；迁移后强制 'mihomo' */
    binary: string
    /** external-controller 监听地址，如 127.0.0.1:19090 */
    apiAddress: string
    /** REST secret；空则首启动生成随机串并落库（生成逻辑在 SettingsStore，不在默认值里） */
    secret: string
    /** REST 请求超时（毫秒） */
    apiTimeoutMs: number
    logLevel: string
    /** 槽位容量（= listener 数 = 节点数上限），1..2000 */
    slotCapacity: number
    /** 槽位端口区间（portStart + slot） */
    inboundPortStart: number
    inboundPortEnd: number
    portCooldownSec: number
    maintenanceWindow: string
  }
  direct: { enabled: boolean; listen: string; socksListen: string }
  subsync: {
    defaultIntervalSec: number
    timeoutMs: number
    retries: number
    retryBackoffMs: number
    concurrency: number
    autoPublishAfterSync: boolean
    historyKeep: number
    maxBytes: number
    userAgent: string
  }
  detect: {
    enabled: boolean
    /** 采样周期（秒）：provider 健康历史 → node_status 的落库节流也用它 */
    intervalSec: number
    concurrency: number
    /** 经槽位 listener 的真实请求总超时（毫秒） */
    totalTimeoutMs: number
    testUrl: string
    ipEchoUrls: string[]
    quarantineAfter: number
    recoverAfter: number
    historyKeep: number
    checkOnPublish: boolean
    /** 按需 full 探测（取出口 IP）的节流间隔（秒）：每个节点至少这么久才做一次 full */
    fullIntervalSec: number
    /** Mihomo 的 GET /proxies/:name/delay?timeout= 超时（毫秒） */
    delayTimeoutMs: number
  }
  publish: {
    scheduleCron: string
    policy: 'healthy_only' | 'all_enabled'
    maxRemovalRatio: number
    maxUnsupportedRatio: number
    requireMinNodes: number
    keepRevisions: number
    staleRetentionDays: number
    namingTemplate: string
    autoRemoveStale: boolean
  }
  credentials: { mode: 'encrypted' | 'hash-only' }
  metrics: { enabled: boolean }
}

export type SettingsPatch = { [K in keyof Settings]?: Partial<Settings[K]> }

export const DEFAULT_SETTINGS: Settings = {
  panel: { baseUrl: '', language: 'zh-CN', sessionTtlHours: 72 },
  gateway: {
    enabled: true,
    listen: '0.0.0.0:7890',
    authMode: 'strict',
    tls: { enabled: false, certFile: '', keyFile: '' },
    maxConcurrentPerUser: 64,
    maxConcurrentPerIp: 256,
    idleTimeoutSec: 300,
    dialTimeoutMs: 3000,
    authFailBanCount: 20,
    authFailBanSec: 300,
    protocols: { http: true, socks5: true },
  },
  engine: {
    mode: 'managed',
    binary: 'mihomo',
    apiAddress: '127.0.0.1:19090',
    // 空 = 首启动由 SettingsStore 生成随机串（不能把固定密钥写进默认值/仓库）
    secret: '',
    apiTimeoutMs: 10000,
    logLevel: 'warning',
    slotCapacity: 256,
    inboundPortStart: 24000,
    inboundPortEnd: 28999,
    portCooldownSec: 300,
    maintenanceWindow: '04:00',
  },
  direct: { enabled: false, listen: '0.0.0.0:7891', socksListen: '0.0.0.0:7892' },
  subsync: {
    defaultIntervalSec: 21600,
    timeoutMs: 20000,
    retries: 2,
    retryBackoffMs: 1500,
    concurrency: 3,
    autoPublishAfterSync: false,
    historyKeep: 200,
    maxBytes: 8 * 1024 * 1024,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  },
  detect: {
    enabled: true,
    intervalSec: 900,
    concurrency: 8,
    totalTimeoutMs: 12000,
    testUrl: 'https://www.gstatic.com/generate_204',
    ipEchoUrls: ['https://api.ip.sb/geoip', 'https://ipinfo.io/json'],
    quarantineAfter: 3,
    recoverAfter: 2,
    historyKeep: 50,
    checkOnPublish: true,
    fullIntervalSec: 21600,
    delayTimeoutMs: 5000,
  },
  publish: {
    scheduleCron: '',
    policy: 'healthy_only',
    maxRemovalRatio: 0.3,
    maxUnsupportedRatio: 0.5,
    requireMinNodes: 1,
    keepRevisions: 20,
    staleRetentionDays: 7,
    namingTemplate: '{region}{seq}',
    autoRemoveStale: true,
  },
  credentials: { mode: 'encrypted' },
  metrics: { enabled: true },
}

type LeafRule = { type: 'number' | 'string' | 'boolean' | 'enum' | 'stringArray'; min?: number; max?: number; values?: string[] }

/** 面板可视化编辑时的校验表（§11.1 GET/PATCH /api/settings） */
const RULES: Record<string, LeafRule> = {
  'panel.baseUrl': { type: 'string' },
  'panel.language': { type: 'string' },
  'panel.sessionTtlHours': { type: 'number', min: 1, max: 8760 },
  'gateway.enabled': { type: 'boolean' },
  'gateway.listen': { type: 'string' },
  'gateway.authMode': { type: 'enum', values: ['strict', 'username-only'] },
  'gateway.tls.enabled': { type: 'boolean' },
  'gateway.tls.certFile': { type: 'string' },
  'gateway.tls.keyFile': { type: 'string' },
  'gateway.maxConcurrentPerUser': { type: 'number', min: 1, max: 100000 },
  'gateway.maxConcurrentPerIp': { type: 'number', min: 1, max: 100000 },
  'gateway.idleTimeoutSec': { type: 'number', min: 5, max: 86400 },
  'gateway.dialTimeoutMs': { type: 'number', min: 100, max: 120000 },
  'gateway.authFailBanCount': { type: 'number', min: 0, max: 100000 },
  'gateway.authFailBanSec': { type: 'number', min: 0, max: 86400 },
  'gateway.protocols.http': { type: 'boolean' },
  'gateway.protocols.socks5': { type: 'boolean' },
  'engine.mode': { type: 'enum', values: ['managed', 'external'] },
  'engine.binary': { type: 'string' },
  'engine.apiAddress': { type: 'string' },
  'engine.secret': { type: 'string' },
  'engine.apiTimeoutMs': { type: 'number', min: 1000, max: 300000 },
  'engine.logLevel': { type: 'enum', values: ['debug', 'info', 'warning', 'error', 'none'] },
  'engine.slotCapacity': { type: 'number', min: 1, max: 2000 },
  'engine.inboundPortStart': { type: 'number', min: 1024, max: 65535 },
  'engine.inboundPortEnd': { type: 'number', min: 1024, max: 65535 },
  'engine.portCooldownSec': { type: 'number', min: 0, max: 86400 },
  'engine.maintenanceWindow': { type: 'string' },
  'direct.enabled': { type: 'boolean' },
  'direct.listen': { type: 'string' },
  'direct.socksListen': { type: 'string' },
  'subsync.defaultIntervalSec': { type: 'number', min: 30, max: 2592000 },
  'subsync.timeoutMs': { type: 'number', min: 1000, max: 300000 },
  'subsync.retries': { type: 'number', min: 0, max: 10 },
  'subsync.retryBackoffMs': { type: 'number', min: 0, max: 60000 },
  'subsync.concurrency': { type: 'number', min: 1, max: 64 },
  'subsync.autoPublishAfterSync': { type: 'boolean' },
  'subsync.historyKeep': { type: 'number', min: 10, max: 10000 },
  'subsync.maxBytes': { type: 'number', min: 1024, max: 256 * 1024 * 1024 },
  'subsync.userAgent': { type: 'string' },
  'detect.enabled': { type: 'boolean' },
  'detect.intervalSec': { type: 'number', min: 30, max: 2592000 },
  'detect.concurrency': { type: 'number', min: 1, max: 64 },
  'detect.totalTimeoutMs': { type: 'number', min: 500, max: 300000 },
  'detect.testUrl': { type: 'string' },
  'detect.ipEchoUrls': { type: 'stringArray' },
  'detect.quarantineAfter': { type: 'number', min: 1, max: 100 },
  'detect.recoverAfter': { type: 'number', min: 1, max: 100 },
  'detect.historyKeep': { type: 'number', min: 5, max: 10000 },
  'detect.checkOnPublish': { type: 'boolean' },
  'detect.delayTimeoutMs': { type: 'number', min: 100, max: 120000 },
  'detect.fullIntervalSec': { type: 'number', min: 60, max: 2592000 },
  'publish.scheduleCron': { type: 'string' },
  'publish.policy': { type: 'enum', values: ['healthy_only', 'all_enabled'] },
  'publish.maxRemovalRatio': { type: 'number', min: 0, max: 1 },
  'publish.maxUnsupportedRatio': { type: 'number', min: 0, max: 1 },
  'publish.requireMinNodes': { type: 'number', min: 0, max: 100000 },
  'publish.keepRevisions': { type: 'number', min: 1, max: 1000 },
  'publish.staleRetentionDays': { type: 'number', min: 0, max: 3650 },
  'publish.namingTemplate': { type: 'string' },
  'publish.autoRemoveStale': { type: 'boolean' },
  'credentials.mode': { type: 'enum', values: ['encrypted', 'hash-only'] },
  'metrics.enabled': { type: 'boolean' },
}

export class SettingsStore {
  private cache: Settings

  constructor(private db: Db) {
    this.cache = this.load()
  }

  private load(): Settings {
    const row = this.db
      .select({ value_json: settingsTable.value_json })
      .from(settingsTable)
      .where(eq(settingsTable.key, 'root'))
      .get()
    let stored: Partial<Settings> = {}
    if (row) {
      try {
        stored = JSON.parse(row.value_json) as Partial<Settings>
      } catch {
        stored = {}
      }
    }
    // 顺序很重要：合并默认值 → 丢掉旧 xray 组 → 旧库迁移 → 生成 secret → 校验。
    // 旧库没有 engine 组，若先校验，用户自定义的端口区间/日志级别会被默认值静默顶掉。
    let base = mergeSettings(DEFAULT_SETTINGS, stored)
    // xray 组已随引擎退役删除：合并会把老库里的 xray 键带回来，必须显式剥掉，
    // 否则每次 persist 都会再写回一份没人读的死配置（且新面板会让它"看起来还在生效"）。
    const droppedLegacyXray = 'xray' in (base as unknown as Record<string, unknown>)
    if (droppedLegacyXray) {
      const copy = { ...(base as unknown as Record<string, unknown>) }
      delete copy.xray
      base = copy as unknown as Settings
    }
    const migrated = migrateLegacyEngineSettings(base, stored)
    base = migrated.settings
    // REST secret 不能有默认值：首启动生成随机串并落库（固定默认密钥等于没有鉴权）。
    const generatedSecret = !base.engine.secret
    if (generatedSecret) base = { ...base, engine: { ...base.engine, secret: randomBytes(24).toString('hex') } }

    const merged = this.applyEnvOverlay(base)
    this.validateFull(merged)
    // 首次建库 / 旧库迁移 / 生成 secret / 丢弃旧 xray 组 都要立即落库一次：
    // 迁移是数据耦合，重启后不能再猜。
    if (!row || migrated.changed || generatedSecret || droppedLegacyXray) this.persist(base)
    return merged
  }

  private persist(value: Settings): void {
    const now = Date.now()
    const json = JSON.stringify(value)
    this.db
      .insert(settingsTable)
      .values({ key: 'root', value_json: json, updated_at: now })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value_json: json, updated_at: now } })
      .run()
  }

  get(): Settings {
    return this.cache
  }

  /**
   * 引导参数覆盖（D8 的例外，仅用于开发/测试与容器内固定二进制路径）：
   *   MIHOMO_BINARY 覆盖 settings.engine.binary，不写入数据库。
   */
  private applyEnvOverlay(s: Settings): Settings {
    let out = s
    const bin = process.env.MIHOMO_BINARY
    if (bin && out.engine.binary === DEFAULT_SETTINGS.engine.binary) {
      out = { ...out, engine: { ...out.engine, binary: bin } }
    }
    // MHP_BOOTSTRAP_SETTINGS：JSON 深合并（不落库）。用于测试夹具与容器引导，见 README。
    const raw = process.env.MHP_BOOTSTRAP_SETTINGS
    if (raw) {
      try {
        out = mergeSettings(out, JSON.parse(raw) as Record<string, unknown>)
      } catch {
        /* 无效的引导 JSON 忽略 */
      }
    }
    return out
  }

  /** 部分更新（深合并）；校验失败抛 422 */
  update(patch: SettingsPatch): Settings {
    const flat = flatten(patch)
    for (const [key, value] of Object.entries(flat)) {
      const rule = RULES[key]
      if (!rule) throw validationFailed(`未知设置项: ${key}`)
      checkRule(key, value, rule)
    }
    // 注意：这里**不能**再叠加 MHP_BOOTSTRAP_SETTINGS/XRAY_BINARY——否则面板里改过的值
    // 会在下一次 update 时被引导值覆盖回去（引导只用于首次装载）。
    const next = mergeSettings(this.cache, patch as Partial<Settings>)
    this.validateFull(next)
    this.persist(next)
    this.cache = next
    return next
  }

  private validateFull(s: Settings): void {
    const flat = flatten(s)
    for (const [key, value] of Object.entries(flat)) {
      const rule = RULES[key]
      if (rule) checkRule(key, value, rule)
    }
    if (!s.engine.apiAddress.trim()) throw validationFailed('engine.apiAddress 不能为空')
    if (s.engine.inboundPortEnd <= s.engine.inboundPortStart) {
      throw validationFailed('engine.inboundPortEnd 必须大于 engine.inboundPortStart')
    }
    // 槽位端口 = inboundPortStart + slot（slot 从 0 开始）：区间必须容得下 slotCapacity 个槽位，
    // 否则最后一批准入节点会绑到区间外的端口，表现为「发布成功但端口不可用」。
    if (s.engine.inboundPortStart + s.engine.slotCapacity - 1 > s.engine.inboundPortEnd) {
      throw validationFailed(
        'engine 端口区间容不下 ' + s.engine.slotCapacity + ' 个槽位（' +
          s.engine.inboundPortStart + '..' + s.engine.inboundPortEnd + '）',
      )
    }
    if (/^\d{1,2}:\d{2}$/.test(s.engine.maintenanceWindow) === false && s.engine.maintenanceWindow !== '') {
      throw validationFailed('engine.maintenanceWindow 需形如 04:00')
    }
  }
}

/**
 * 旧库兼容（数据耦合，grep 不出来）：xray 时代的设置存在 settings.xray.*。
 *
 * 一次性映射：把能对应的键复制到 engine.*，之后 xray 组由 load() 丢弃并落库，
 * 面板上再也看不到它（引擎换了，旧键全部失效，留着只会误导）。
 * engine.binary 强制 'mihomo'——旧库里是 'xray'，会覆盖 MIHOMO_BINARY 并让面板继续找
 * xray 二进制启动失败。
 *
 * 只在「stored 有 xray 且没有 engine」时执行；判定必须读 **raw stored**，不能读合并后的
 * 结构（默认值里已经有 engine，读合并结果永远判定为"已迁移"）。
 */
function migrateLegacyEngineSettings(
  s: Settings,
  stored: Partial<Settings>,
): { settings: Settings; changed: boolean } {
  const storedObj = stored as unknown as Record<string, unknown>
  if (isPlainObject(storedObj.engine)) return { settings: s, changed: false }
  const raw = storedObj.xray
  if (!isPlainObject(raw)) return { settings: s, changed: false }
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.length > 0 ? v : fallback
  return {
    settings: {
      ...s,
      engine: {
        ...s.engine,
        mode: raw.mode === 'external' ? 'external' : 'managed',
        binary: DEFAULT_SETTINGS.engine.binary,
        apiAddress: str(raw.apiAddress, s.engine.apiAddress),
        // 单位不同：xray.apiTimeoutSec 是秒，engine.apiTimeoutMs 是毫秒
        apiTimeoutMs: Math.max(1000, Math.round(num(raw.apiTimeoutSec, s.engine.apiTimeoutMs / 1000) * 1000)),
        logLevel: str(raw.logLevel, s.engine.logLevel),
        inboundPortStart: num(raw.inboundPortStart, s.engine.inboundPortStart),
        inboundPortEnd: num(raw.inboundPortEnd, s.engine.inboundPortEnd),
        portCooldownSec: num(raw.portCooldownSec, s.engine.portCooldownSec),
        maintenanceWindow: str(raw.maintenanceWindow, s.engine.maintenanceWindow),
        // slotCapacity 是 Mihomo 新概念，旧库没有，保留默认值
      },
    },
    changed: true,
  }
}

function checkRule(key: string, value: unknown, rule: LeafRule): void {
  switch (rule.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw validationFailed(`${key} 必须是数字`)
      if (rule.min !== undefined && value < rule.min) throw validationFailed(`${key} 不能小于 ${rule.min}`)
      if (rule.max !== undefined && value > rule.max) throw validationFailed(`${key} 不能大于 ${rule.max}`)
      break
    }
    case 'string':
      if (typeof value !== 'string') throw validationFailed(`${key} 必须是字符串`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') throw validationFailed(`${key} 必须是布尔值`)
      break
    case 'enum':
      if (typeof value !== 'string' || !rule.values!.includes(value)) {
        throw validationFailed(`${key} 必须是 ${rule.values!.join('|')}`)
      }
      break
    case 'stringArray':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw validationFailed(`${key} 必须是字符串数组`)
      }
      break
  }
}

export function flatten(obj: unknown, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v, key))
      else out[key] = v
    }
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function mergeSettings<T>(base: T, patch: Partial<T> | Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue
    const cur = out[k]
    if (isPlainObject(cur) && isPlainObject(v)) out[k] = mergeSettings(cur, v)
    else out[k] = v
  }
  return out as T
}
