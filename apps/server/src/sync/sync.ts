import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { and, asc, count, desc, eq, gte, isNull, lte, ne, notInArray, sql } from 'drizzle-orm'
import { stringify } from 'yaml'
import { paths } from '../config'
import type { Db } from '../core/db'
import {
  nodeCredentials,
  nodeSources,
  nodes as nodesT,
  subscriptionRunErrors,
  subscriptionRuns,
  subscriptions,
} from '../core/schema'
import type { EventBus } from '../core/events'
import type { SettingsStore } from '../core/settings'
import { decryptSecret, encryptSecret, generateNodePassword, passwordLookupHash, sha1Hex } from '../core/crypto'
import { randomId, stableStringify } from '../core/ids'
import { logger } from '../core/log'
import type { MihomoClient, MihomoProviderInfo, MihomoProxyInfo } from '../mihomo/client'
import { providerNameOf } from '../mihomo/config'
import { providerFilePath } from '../mihomo/provider'
import { parseSubscription } from '../sub/formats'
import { normalizeNode } from '../sub/normalize'
import { allocateNodeId, regionKey } from '../sub/naming'
import { toClashProxy } from '../sub/to-clash'
import type { NormalizedNode, SubFormatHint } from '../sub/types'

export interface SubscriptionRow {
  id: string
  name: string
  url: string
  format_hint: SubFormatHint
  enabled: number
  interval_sec: number | null
  cron: string | null
  timeout_ms: number
  retries: number
  retry_backoff_ms: number
  headers_json: string | null
  user_agent: string | null
  sub_id_override: string | null
  last_sync_at: number | null
  last_status: string
  last_error: string | null
  last_error_kind: string | null
  etag: string | null
  last_modified: string | null
  consecutive_failures: number
}

export interface SyncResult {
  subscriptionId: string
  status: 'ok' | 'failed' | 'not-modified'
  httpStatus?: number
  bytes?: number
  durationMs: number
  totalFound: number
  added: number
  changed: number
  removed: number
  restored: number
  unsupported: number
  parseErrors: number
  errorKind?: string
  errorMsg?: string
  format?: string
}

export interface SyncDeps {
  db: Db
  settings: SettingsStore
  events: EventBus
  /**
   * Mihomo 控制面客户端（懒取值：index.ts 里 client 的构造晚于 SyncService）。
   * 未注入 = 引擎还没切过来：runSync 必须 loud 失败，绝不能把节点静默标成不可发布——
   * 那等于安静地停掉整池发布。preview 不依赖它（预览在引擎没起来时也要能用）。
   */
  client?: () => MihomoClient
  /**
   * Mihomo 的 -d 目录（provider 文件落在 <engineDir>/providers/<subId>.yaml）。
   * 缺省用 DATA_DIR/runtime/mihomo，与数据面 -d 的约定一致。
   */
  engineDir?: () => string
  /**
   * 「把这个 provider 段加载进引擎」的回调（index 注入 publisher.syncStructure）。
   *
   * 为什么需要：首次接入一个订阅时，provider 还不在 config 里，
   * `PUT /providers/proxies/<name>` 会直接 404；而 PUBLISH 的常规路径带 requireMinNodes 安全阀
   * （此刻库里通常还没有可发布节点）会拒绝执行，于是永远加载不进来。
   * 这里留给调用方一个「只同步结构」的入口，sync 负责在 404 时调用它并重试一次。
   */
  ensureProvider?: (provider: string) => Promise<void>
}

/** 解析预览结果（HTTP 响应形状保持不变） */
export interface PreviewResult {
  format: string
  total: number
  supported: number
  unsupported: number
  nodes: NormalizedNode[]
  errors: { lineNo: number; rawSnippet: string; errorKind: string; errorMsg: string }[]
}

/**
 * 一个订阅节点在本次同步里的最终形态：节点 ID + 稳定的 provider proxy 名 + 转换结果。
 *
 * proxy 名 = 'n-' + nodeId，**不随改名/改参数变化**：Mihomo 的 provider 是「同名替换」语义，
 * 名字稳定才能让「订阅里改了节点参数」变成一次热更新，而不是换一个节点。
 * UI 上展示的名字仍然走 nodes.display_name（proxy 名不承载展示语义）。
 */
interface ResolvedNode {
  node: NormalizedNode
  nodeId: string
  proxyName: string
  /** 能进 provider 的 Clash proxy；映射失败为 null（节点仍要入库并标不可发布） */
  clashProxy: Record<string, unknown> | null
  /** 映射失败原因 */
  reason?: string
}

/**
 * SyncJob（PANEL.md §7）。只写期望状态，**永不碰数据面**。
 * 失败时绝不改动 nodes（§7.6 硬性要求）。
 */
export class SyncService {
  constructor(private deps: SyncDeps) {}

  listSubscriptions(enabledOnly = false): SubscriptionRow[] {
    const base = this.deps.db.select().from(subscriptions)
    return (enabledOnly ? base.where(eq(subscriptions.enabled, 1)) : base)
      .orderBy(asc(subscriptions.created_at))
      .all() as SubscriptionRow[]
  }

  /** 取回订阅正文：超时/重试/ETag/大小上限（§7.1） */
  async fetchBody(sub: SubscriptionRow, opts: { force?: boolean } = {}): Promise<{ notModified: boolean; body: string; httpStatus: number; bytes: number }> {
    const s = this.deps.settings.get().subsync
    // 内联文本订阅（面板直接粘贴）：不发任何 HTTP 请求
    if (sub.url.startsWith('inline://')) {
      const row = this.deps.db
        .select({ content_text: subscriptions.content_text })
        .from(subscriptions)
        .where(eq(subscriptions.id, sub.id))
        .get()
      const text = row?.content_text ?? ''
      if (!text.trim()) throw Object.assign(new Error('内联订阅内容为空'), { kind: 'empty_result' })
      if (text.length > s.maxBytes) throw Object.assign(new Error('内联订阅内容超过大小上限'), { kind: 'too_large' })
      return { notModified: false, body: text, httpStatus: 200, bytes: text.length }
    }
    const headers: Record<string, string> = {
      'user-agent': sub.user_agent || s.userAgent,
      accept: '*/*',
    }
    if (sub.headers_json) {
      try {
        Object.assign(headers, JSON.parse(sub.headers_json) as Record<string, string>)
      } catch {
        /* 无效 headers 忽略 */
      }
    }
    if (!opts.force && sub.etag) headers['if-none-match'] = sub.etag
    if (!opts.force && sub.last_modified) headers['if-modified-since'] = sub.last_modified

    const retries = Math.max(0, sub.retries)
    let lastErr: { kind: string; msg: string } = { kind: 'internal', msg: 'unknown' }
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), sub.timeout_ms || s.timeoutMs)
      try {
        const res = await fetch(sub.url, { headers, signal: ctrl.signal, redirect: 'follow' })
        clearTimeout(timer)
        if (res.status === 304) return { notModified: true, body: '', httpStatus: 304, bytes: 0 }
        if (res.status >= 400 && res.status < 500) {
          const text = await res.text().catch(() => '')
          throw Object.assign(new Error('HTTP ' + res.status + ' ' + text.slice(0, 120)), { noRetry: true, kind: 'http_' + res.status })
        }
        if (!res.ok) {
          lastErr = { kind: 'http_' + res.status, msg: 'HTTP ' + res.status }
          throw new Error('HTTP ' + res.status)
        }
        const maxBytes = s.maxBytes
        const buf = await res.arrayBuffer()
        if (buf.byteLength > maxBytes) {
          throw Object.assign(new Error('订阅内容超过大小上限 ' + maxBytes + ' 字节'), { noRetry: true, kind: 'too_large' })
        }
        const body = new TextDecoder('utf-8').decode(buf)
        // 记录 ETag / Last-Modified
        const etag = res.headers.get('etag')
        const lm = res.headers.get('last-modified')
        this.deps.db
          .update(subscriptions)
          .set({
            etag: sql`COALESCE(${etag}, ${subscriptions.etag})`,
            last_modified: sql`COALESCE(${lm}, ${subscriptions.last_modified})`,
            updated_at: Date.now(),
          })
          .where(eq(subscriptions.id, sub.id))
          .run()
        return { notModified: false, body, httpStatus: res.status, bytes: buf.byteLength }
      } catch (e) {
        clearTimeout(timer)
        const err = e as Error & { noRetry?: boolean; kind?: string }
        const kind = err.kind ?? classifyFetchError(err.message)
        lastErr = { kind, msg: err.message }
        if (err.noRetry || attempt === retries) break
        const backoff = (sub.retry_backoff_ms || s.retryBackoffMs) * Math.pow(2, attempt) + Math.floor(Math.random() * 200)
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
    throw Object.assign(new Error(lastErr.msg), { kind: lastErr.kind })
  }

  /**
   * 解析预览（不落库，§11.1 /api/subscriptions/preview）。
   *
   * 刻意**不依赖 Mihomo 引擎**：引擎没起来/还没切过来时，粘贴一段订阅也必须能预览。
   * 「是否可发布」用纯函数 toClashProxy 判定——与 runSync 写 provider 用的是同一套翻译，
   * 所以预览说能发布、同步后却进不了 provider 的情况只会来自引擎侧（回读会再校正一次）。
   *
   * 同一订阅内 fingerprint 重复只保留首条：Mihomo 的 provider 不允许同名条目，
   * 去重口径与 normalizeNodes 一致（先到先得）。
   */
  async preview(body: string, hint: SubFormatHint = 'auto', sourceSubscriptionId = 'preview'): Promise<PreviewResult> {
    const parsed = parseSubscription(body, hint, sourceSubscriptionId)
    const nodes: NormalizedNode[] = []
    const seen = new Set<string>()
    for (const input of parsed.nodes) {
      try {
        const node = normalizeNode(input)
        if (seen.has(node.fingerprint)) continue
        seen.add(node.fingerprint)
        nodes.push({ ...node, protocolSupported: toClashProxy(node).ok })
      } catch (e) {
        parsed.errors.push({ lineNo: 0, rawSnippet: input.raw.slice(0, 200), errorKind: 'normalize_failed', errorMsg: (e as Error).message })
      }
    }
    const supported = nodes.filter((n) => n.protocolSupported).length
    return {
      format: parsed.format,
      total: nodes.length,
      supported,
      unsupported: nodes.length - supported,
      nodes,
      errors: parsed.errors,
    }
  }

  /** 执行一次同步（SyncJob 主体） */
  async runSync(subscriptionId: string, trigger: 'manual' | 'cron' | 'api', opts: { force?: boolean } = {}): Promise<SyncResult> {
    const sub = this.deps.db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId)).get() as SubscriptionRow | undefined
    if (!sub) throw new Error('订阅不存在: ' + subscriptionId)
    const started = Date.now()
    const runId = randomId('run_')
    this.deps.db
      .insert(subscriptionRuns)
      .values({ id: runId, subscription_id: subscriptionId, trigger, started_at: started, status: 'running' })
      .run()

    let fetchInfo: { notModified: boolean; body: string; httpStatus: number; bytes: number }
    try {
      fetchInfo = await this.fetchBody(sub, opts)
    } catch (e) {
      const err = e as Error & { kind?: string }
      const kind = err.kind ?? 'network_error'
      this.failRun(runId, sub, kind, err.message, started)
      this.deps.events.warn('sync.failed', '订阅「' + sub.name + '」同步失败：' + err.message, { subscriptionId })
      return {
        subscriptionId,
        status: 'failed',
        durationMs: Date.now() - started,
        totalFound: 0,
        added: 0,
        changed: 0,
        removed: 0,
        restored: 0,
        unsupported: 0,
        parseErrors: 0,
        errorKind: kind,
        errorMsg: err.message,
      }
    }

    if (fetchInfo.notModified) {
      this.deps.db
        .update(subscriptionRuns)
        .set({ status: 'ok', finished_at: Date.now(), http_status: 304, bytes: 0, duration_ms: Date.now() - started, error_kind: 'not_modified' })
        .where(eq(subscriptionRuns.id, runId))
        .run()
      this.deps.db
        .update(subscriptions)
        .set({ last_sync_at: Date.now(), last_status: 'ok', consecutive_failures: 0, updated_at: Date.now() })
        .where(eq(subscriptions.id, sub.id))
        .run()
      this.deps.events.info('sync.not_modified', '订阅「' + sub.name + '」未变更（304）', { subscriptionId })
      return {
        subscriptionId,
        status: 'not-modified',
        httpStatus: 304,
        durationMs: Date.now() - started,
        totalFound: 0,
        added: 0,
        changed: 0,
        removed: 0,
        restored: 0,
        unsupported: 0,
        parseErrors: 0,
      }
    }

    const parsed = await this.preview(fetchInfo.body, sub.format_hint, sub.id)

    // §7.6：解析出 0 个节点视为失败，不落库
    if (parsed.nodes.length === 0) {
      this.failRun(runId, sub, parsed.format === 'unknown' ? 'format_unknown' : 'empty_result', '解析出 0 个节点（格式=' + parsed.format + '）', started, fetchInfo)
      if (parsed.errors.length) this.insertRunErrors(runId, parsed.errors)
      this.deps.events.warn('sync.empty', '订阅「' + sub.name + '」解析出 0 个节点，期望状态保持不变', { subscriptionId })
      return {
        subscriptionId,
        status: 'failed',
        httpStatus: fetchInfo.httpStatus,
        bytes: fetchInfo.bytes,
        durationMs: Date.now() - started,
        totalFound: 0,
        added: 0,
        changed: 0,
        removed: 0,
        restored: 0,
        unsupported: 0,
        parseErrors: parsed.errors.length,
        errorKind: 'empty_result',
        errorMsg: '解析出 0 个节点',
        format: parsed.format,
      }
    }

    // ---------- Mihomo 接线：文件 provider → PUT 热加载 → 回读实际加载结果 ----------
    // 顺序刻意是「先确认引擎可用，再动文件/DB」：引擎没接好时本轮必须整体 loud 失败，
    // 绝不能把 parsed.nodes 全标成不可发布（那会让整池节点静默消失）。
    const client = this.deps.client?.()
    if (!client) {
      const kind = 'engine_unavailable'
      const msg = 'Mihomo 控制面未接入（SyncDeps.client 未注入），本次不落库、期望状态保持不变'
      this.failRun(runId, sub, kind, msg, started, fetchInfo)
      this.deps.events.error('sync.engine_unavailable', '订阅「' + sub.name + '」同步未执行：' + msg, { subscriptionId })
      return {
        subscriptionId,
        status: 'failed',
        httpStatus: fetchInfo.httpStatus,
        bytes: fetchInfo.bytes,
        durationMs: Date.now() - started,
        totalFound: parsed.total,
        added: 0,
        changed: 0,
        removed: 0,
        restored: 0,
        unsupported: 0,
        parseErrors: parsed.errors.length,
        errorKind: kind,
        errorMsg: msg,
        format: parsed.format,
      }
    }

    const engineDir = this.deps.engineDir?.() ?? join(paths.runtime, 'mihomo')
    const provider = providerNameOf(sub.id)
    const resolved = this.resolveNodes(parsed.nodes)
    // 映射失败不是「解析错误」，而是「引擎表达不了」：单独一类错误样本，节点仍要入库并标 0
    const mapErrors = resolved
      .filter((r) => !r.clashProxy)
      .map((r) => ({
        lineNo: 0,
        rawSnippet: r.node.raw.slice(0, 200),
        errorKind: 'unsupported_by_engine',
        errorMsg: r.reason ?? '无法转换为 Mihomo proxy',
      }))

    let loaded: Map<string, MihomoProxyInfo>
    try {
      await this.writeProviderFile(engineDir, sub.id, resolved)
      loaded = await this.reloadProvider(client, provider)
    } catch (e) {
      // 刷新失败（控制面不可用、provider 路径不对、PUT 503…）不能把节点全标 0：
      // 保持 DB 原值，本轮记 failed + 错误样本，让用户看到「引擎出问题了」，而不是「所有节点坏了」。
      const err = e instanceof Error ? e : new Error(String(e))
      const kind = 'provider_refresh_failed'
      this.failRun(runId, sub, kind, 'Mihomo provider 刷新失败：' + err.message, started, fetchInfo)
      this.insertRunErrors(runId, [{ lineNo: 0, rawSnippet: '', errorKind: kind, errorMsg: err.message.slice(0, 300) }, ...mapErrors])
      this.deps.events.error('sync.provider_refresh_failed', '订阅「' + sub.name + '」provider 刷新失败，节点清单保持原值：' + err.message, { subscriptionId })
      return {
        subscriptionId,
        status: 'failed',
        httpStatus: fetchInfo.httpStatus,
        bytes: fetchInfo.bytes,
        durationMs: Date.now() - started,
        totalFound: parsed.total,
        added: 0,
        changed: 0,
        removed: 0,
        restored: 0,
        unsupported: resolved.filter((r) => !r.clashProxy).length,
        parseErrors: parsed.errors.length,
        errorKind: kind,
        errorMsg: err.message,
        format: parsed.format,
      }
    }

    // PUT 成功 ≠ 文件里每条 proxy 都真进了 provider；被引擎拒绝/文件未生效的只能从回读里发现
    const missing = resolved
      .filter((r) => r.clashProxy && !loaded.has(r.proxyName))
      .map((r) => ({
        lineNo: 0,
        rawSnippet: r.node.raw.slice(0, 200),
        errorKind: 'proxy_missing_after_reload',
        errorMsg: 'provider 刷新后未加载 proxy ' + r.proxyName + '（字段被引擎拒绝或文件未生效）',
      }))

    const counts = this.applyNodes(sub, resolved, loaded, provider)
    const durationMs = Date.now() - started
    this.deps.db
      .update(subscriptionRuns)
      .set({
        status: 'ok',
        finished_at: Date.now(),
        http_status: fetchInfo.httpStatus,
        bytes: fetchInfo.bytes,
        duration_ms: durationMs,
        total_found: parsed.total,
        added: counts.added,
        changed: counts.changed,
        removed: counts.removed,
        restored: counts.restored,
        unsupported: counts.unsupported,
        parse_errors: parsed.errors.length,
        result_digest: sha1Hex(stableStringify(parsed.nodes.map((n) => n.fingerprint).sort())),
      })
      .where(eq(subscriptionRuns.id, runId))
      .run()
    // 解析错误（逐行容错）与引擎侧错误（表达不了/回读缺失）一起留档
    const engineErrors = [...mapErrors, ...missing]
    if (parsed.errors.length || engineErrors.length) this.insertRunErrors(runId, [...parsed.errors, ...engineErrors])
    this.deps.db
      .update(subscriptions)
      .set({
        last_sync_at: Date.now(),
        last_status: 'ok',
        last_error: null,
        last_error_kind: null,
        consecutive_failures: 0,
        updated_at: Date.now(),
      })
      .where(eq(subscriptions.id, sub.id))
      .run()
    this.trimRuns(sub.id)
    this.deps.events.info(
      'sync.done',
      '订阅「' + sub.name + '」同步完成：新增 ' + counts.added + '，修改 ' + counts.changed + '，消失 ' + counts.removed + '，恢复 ' + counts.restored + '，不可发布 ' + counts.unsupported,
      { subscriptionId },
    )
    return {
      subscriptionId,
      status: 'ok',
      httpStatus: fetchInfo.httpStatus,
      bytes: fetchInfo.bytes,
      durationMs,
      totalFound: parsed.total,
      ...counts,
      parseErrors: parsed.errors.length,
      format: parsed.format,
    }
  }

  /**
   * 节点 → (稳定 ID, 稳定 proxy 名, Clash proxy)。
   *
   * ID 解析必须在写 provider 文件之前完成：proxy 名由节点 ID 派生，而文件名/DB 行都依赖它。
   * 已有 fingerprint 一律复用旧 ID（改名/改参数都不换 ID → Mihomo 侧是「同名替换」而非换节点）；
   * 新节点按 region 顺序分配，分配过程中把「本次已分配的 ID」也放进已用集合，避免同批撞号。
   */
  private resolveNodes(nodes: NormalizedNode[]): ResolvedNode[] {
    const existing = new Map(
      this.deps.db
        .select({ id: nodesT.id, fingerprint: nodesT.fingerprint })
        .from(nodesT)
        .all()
        .map((r) => [r.fingerprint, r.id] as const),
    )
    const taken = new Set([...existing.values()].map((id) => id.toLowerCase()))
    const out: ResolvedNode[] = []
    for (const node of nodes) {
      let nodeId = existing.get(node.fingerprint)
      if (!nodeId) {
        nodeId = this.allocateUniqueId(node.name, taken)
        taken.add(nodeId.toLowerCase())
      }
      const proxyName = 'n-' + nodeId
      const clash = toClashProxy(node)
      out.push({
        node,
        nodeId,
        proxyName,
        clashProxy: clash.ok ? { ...clash.proxy, name: proxyName } : null,
        reason: clash.ok ? undefined : clash.reason,
      })
    }
    return out
  }

  /** 在「数据库已用 ID + 本次已分配 ID」里找一个不冲突的节点 ID */
  private allocateUniqueId(name: string, taken: Set<string>): string {
    const region = regionKey(name)
    for (let seq = 1; seq <= 9999; seq++) {
      const id = allocateNodeId(region, taken, seq)
      if (!taken.has(id.toLowerCase())) return id
    }
    throw new Error('节点 ID 分配失败')
  }

  /**
   * 原子写 provider 文件：<engineDir>/providers/<subId>.yaml。
   *
   * 先写临时文件再 rename：Mihomo 的 file provider 是按需读文件的，读到半个文件会让整份
   * provider 解析失败；rename 在 Windows 上同样是原子替换（Node 用 MOVEFILE_REPLACE_EXISTING）。
   * 内容按 proxy 名排序，保证同一输入逐字节相同（对账/测试都依赖确定性）。
   */
  private async writeProviderFile(engineDir: string, subscriptionId: string, resolved: ResolvedNode[]): Promise<void> {
    const proxies = resolved
      .map((r) => r.clashProxy)
      .filter((p): p is Record<string, unknown> => p !== null)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    const file = join(engineDir, providerFilePath(subscriptionId))
    await mkdir(dirname(file), { recursive: true })
    const body = stringify({ proxies }, { lineWidth: 0 })
    const tmp = file + '.' + randomId('tmp_') + '.tmp'
    try {
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, file)
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw e
    }
  }

  /**
   * PUT 热加载 provider 后回读实际加载的 proxy。
   *
   * 为什么必须回读：PUT 只表示「引擎接受了一次刷新」，文件里哪些条目真被吃进去、名字是否与
   * 预期一致，只有 GET /providers/proxies/<name> 能证明；protocol_supported 以它为准。
   * 刷新失败直接抛，由调用方 loud 失败——绝不在失败时把节点标 0。
   */
  private async reloadProvider(client: MihomoClient, provider: string): Promise<Map<string, MihomoProxyInfo>> {
    try {
      await this.putProvider(client, provider)
    } catch (e) {
      // 首次接入该订阅：provider 段还不在 config 里 → PUT 404/unknown。
      // 先请求调用方「只同步结构」（config 里出现该 provider）再重试一次；
      // 其它错误（503 / 控制面不可用）不重试，直接把失败抛上去让人看见。
      if (!this.isUnknownProvider(e) || !this.deps.ensureProvider) throw e
      await this.deps.ensureProvider(provider)
      await this.putProvider(client, provider)
    }
    const info: MihomoProviderInfo = await client.provider(provider)
    const loaded = new Map<string, MihomoProxyInfo>()
    for (const proxy of info?.proxies ?? []) {
      if (proxy && typeof proxy.name === 'string') loaded.set(proxy.name, proxy)
    }
    return loaded
  }

  private async putProvider(client: MihomoClient, provider: string): Promise<void> {
    await client.request('/providers/proxies/' + encodeURIComponent(provider), { method: 'PUT' })
  }

  /** 404（provider 不存在）或 400 + 「not exist / unknown」才算「需要先把 provider 加载进来」 */
  private isUnknownProvider(e: unknown): boolean {
    const err = e as { status?: number; message?: string }
    if (err?.status === 404) return true
    return err?.status === 400 && /nots*exist|unknown|nots*found/i.test(String(err?.message ?? ''))
  }
  /**
   * 事务内写 nodes / node_sources / node_credentials（§7.5 去重与消失/恢复语义）。
   *
   * `loaded` 是 provider 刷新后**回读**到的 proxy 集合：它才是「引擎实际接受了什么」的事实，
   * protocol_supported 以它为准。映射成功但回读里没有的节点同样算不可发布（原因已写进 run errors）。
   *
   * 消失的节点除了打 missing_since，还要清掉 proxy_name/proxy_source/proxy_json：
   * provider 文件里已经没有它了，留着旧名会让发布链路指向一个不存在的 proxy。
   */
  private applyNodes(
    sub: SubscriptionRow,
    resolved: ResolvedNode[],
    loaded: Map<string, MihomoProxyInfo>,
    provider: string,
  ): {
    added: number
    changed: number
    removed: number
    restored: number
    unsupported: number
  } {
    const settings = this.deps.settings.get()
    const now = Date.now()
    const staleUntil = now + settings.publish.staleRetentionDays * 86400_000
    let added = 0
    let changed = 0
    let restored = 0
    let unsupported = 0

    const seenFingerprints = new Set<string>()

    this.deps.db.transaction(
      () => {
      for (const r of resolved) {
        const n = r.node
        seenFingerprints.add(n.fingerprint)
        const info = r.clashProxy ? loaded.get(r.proxyName) : undefined
        const supported = !!info
        if (!supported) unsupported++
        const proxyJson = info ? JSON.stringify(info) : null
        const existing = this.deps.db.select().from(nodesT).where(eq(nodesT.fingerprint, n.fingerprint)).get()
        if (!existing) {
          this.deps.db
            .insert(nodesT)
            .values({
              id: r.nodeId,
              display_name: n.name,
              country_code: supported ? (regionKey(n.name)?.toUpperCase() ?? null) : null,
              region: typeof n.params.region === 'string' ? n.params.region : null,
              protocol: n.protocol,
              fingerprint: n.fingerprint,
              params_hash: n.paramsHash,
              outbound_json: JSON.stringify(n.outbound),
              protocol_supported: supported ? 1 : 0,
              proxy_name: supported ? r.proxyName : null,
              proxy_source: supported ? provider : null,
              proxy_json: proxyJson,
              enabled: 1,
              is_virtual: 0,
              first_seen_at: now,
              last_seen_at: now,
              created_at: now,
              updated_at: now,
            })
            .run()
          this.ensureCredential(r.nodeId)
          added++
        } else {
          const paramsChanged = existing.params_hash !== n.paramsHash || existing.display_name !== n.name
          this.deps.db
            .update(nodesT)
            .set({
              // 改名/改参数才动展示列；三列 proxy_* 每次同步都按引擎回读刷新（它们描述数据面事实）
              ...(paramsChanged
                ? {
                    display_name: n.name,
                    protocol: n.protocol,
                    params_hash: n.paramsHash,
                    outbound_json: JSON.stringify(n.outbound),
                  }
                : {}),
              protocol_supported: supported ? 1 : 0,
              proxy_name: supported ? r.proxyName : null,
              proxy_source: supported ? provider : null,
              proxy_json: proxyJson,
              last_seen_at: now,
              updated_at: now,
            })
            .where(eq(nodesT.id, existing.id))
            .run()
          if (paramsChanged) changed++
          if (existing.missing_since !== null) {
            this.deps.db
              .update(nodesT)
              .set({ missing_since: null, stale_until: null, enabled: 1, updated_at: now })
              .where(eq(nodesT.id, existing.id))
              .run()
            restored++
          }
          this.ensureCredential(existing.id)
        }
      }

      // 本订阅不再提供的节点 → missing_since（不删凭据、不立即动数据面，§7.5）
      const owned = this.deps.db
        .select({ node_id: nodeSources.node_id, fingerprint: nodesT.fingerprint })
        .from(nodeSources)
        .innerJoin(nodesT, eq(nodesT.id, nodeSources.node_id))
        .where(eq(nodeSources.subscription_id, sub.id))
        .all()
      for (const o of owned) {
        if (seenFingerprints.has(o.fingerprint)) continue
        const otherSources = this.deps.db
          .select({ n: count() })
          .from(nodeSources)
          .where(and(eq(nodeSources.node_id, o.node_id), ne(nodeSources.subscription_id, sub.id), gte(nodeSources.last_seen_at, now - 1000)))
          .get()
        if ((otherSources?.n ?? 0) > 0) continue
        this.deps.db
          .update(nodesT)
          .set({
            missing_since: sql`COALESCE(${nodesT.missing_since}, ${now})`,
            stale_until: sql`COALESCE(${nodesT.stale_until}, ${staleUntil})`,
            // provider 文件里已经没有它了：旧 proxy 名必须清掉，否则发布链路会指向不存在的 proxy
            protocol_supported: 0,
            proxy_name: null,
            proxy_source: null,
            proxy_json: null,
            updated_at: now,
          })
          .where(eq(nodesT.id, o.node_id))
          .run()
      }

      // 写 node_sources（不可发布/引擎表达不了的节点也算「订阅提供过」，否则 UI 会凭空少节点）
      const byFingerprint = new Map(resolved.map((r) => [r.node.fingerprint, r.node]))
      for (const r of resolved) {
        const n = r.node
        const nodeRow = this.deps.db.select({ id: nodesT.id }).from(nodesT).where(eq(nodesT.fingerprint, n.fingerprint)).get()
        if (!nodeRow) continue
        this.deps.db
          .insert(nodeSources)
          .values({
            node_id: nodeRow.id,
            subscription_id: sub.id,
            name_in_sub: byFingerprint.get(n.fingerprint)?.name ?? n.name,
            first_seen_at: now,
            last_seen_at: now,
          })
          .onConflictDoUpdate({
            target: [nodeSources.node_id, nodeSources.subscription_id],
            set: { name_in_sub: sql`excluded.name_in_sub`, last_seen_at: sql`excluded.last_seen_at` },
          })
          .run()
      }
      },
      { behavior: 'immediate' }
    )

    const removed = this.deps.db
      .select({ n: count() })
      .from(nodeSources)
      .where(eq(nodeSources.subscription_id, sub.id))
      .get()
    void removed
    const missingNow =
      this.deps.db
        .select({ n: count() })
        .from(nodesT)
        .where(and(gte(nodesT.missing_since, now - 50), lte(nodesT.missing_since, now + 50)))
        .get()?.n ?? 0
    return { added, changed, removed: missingNow, restored, unsupported }
  }

  private ensureCredential(nodeId: string): void {
    const existing = this.deps.db
      .select({ node_id: nodeCredentials.node_id })
      .from(nodeCredentials)
      .where(eq(nodeCredentials.node_id, nodeId))
      .get()
    if (existing) return
    const password = generateNodePassword()
    this.deps.db
      .insert(nodeCredentials)
      .values({
        node_id: nodeId,
        username: nodeId,
        password_enc: encryptSecret(password),
        password_lookup_hash: passwordLookupHash(password),
        created_at: Date.now(),
      })
      .run()
  }


  private failRun(
    runId: string,
    sub: SubscriptionRow,
    errorKind: string,
    errorMsg: string,
    started: number,
    fetchInfo?: { httpStatus: number; bytes: number },
  ): void {
    this.deps.db
      .update(subscriptionRuns)
      .set({
        status: 'failed',
        finished_at: Date.now(),
        http_status: fetchInfo?.httpStatus ?? null,
        bytes: fetchInfo?.bytes ?? null,
        duration_ms: Date.now() - started,
        error_kind: errorKind,
        error_msg: errorMsg.slice(0, 500),
      })
      .where(eq(subscriptionRuns.id, runId))
      .run()
    this.deps.db
      .update(subscriptions)
      .set({
        last_status: 'failed',
        last_error: errorMsg.slice(0, 500),
        last_error_kind: errorKind,
        consecutive_failures: sql`${subscriptions.consecutive_failures} + 1`,
        updated_at: Date.now(),
      })
      .where(eq(subscriptions.id, sub.id))
      .run()
    if (sub.consecutive_failures + 1 >= 3) {
      this.deps.events.warn('sync.repeated_failure', '订阅「' + sub.name + '」连续失败 ' + (sub.consecutive_failures + 1) + ' 次', { subscriptionId: sub.id })
    }
  }

  private insertRunErrors(runId: string, errors: { lineNo: number; rawSnippet: string; errorKind: string; errorMsg: string }[]): void {
    for (const e of errors.slice(0, 100)) {
      this.deps.db
        .insert(subscriptionRunErrors)
        .values({
          run_id: runId,
          line_no: e.lineNo,
          raw_snippet: (e.rawSnippet ?? '').slice(0, 300),
          error_kind: e.errorKind,
          error_msg: (e.errorMsg ?? '').slice(0, 300),
        })
        .run()
    }
  }

  private trimRuns(subscriptionId: string): void {
    const keep = this.deps.settings.get().subsync.historyKeep
    // drizzle 只写 OFFSET 不写 LIMIT，SQLite 会语法错；这里是单条语句，用 raw 保留 LIMIT -1 OFFSET 语义
    const rows = this.deps.db.all<{ id: string }>(
      sql`SELECT id FROM subscription_runs WHERE subscription_id = ${subscriptionId} ORDER BY started_at DESC LIMIT -1 OFFSET ${keep}`
    )
    for (const r of rows) {
      this.deps.db.delete(subscriptionRunErrors).where(eq(subscriptionRunErrors.run_id, r.id)).run()
      this.deps.db.delete(subscriptionRuns).where(eq(subscriptionRuns.id, r.id)).run()
    }
  }

  /** 密码明文（供面板展示与网关校验） */
  credentialOf(nodeId: string): { username: string; password: string } | null {
    const row = this.deps.db
      .select({ username: nodeCredentials.username, password_enc: nodeCredentials.password_enc })
      .from(nodeCredentials)
      .where(eq(nodeCredentials.node_id, nodeId))
      .get()
    if (!row) return null
    try {
      return { username: row.username, password: decryptSecret(row.password_enc) }
    } catch (e) {
      logger.error('credential decrypt failed', { nodeId, msg: (e as Error).message })
      return null
    }
  }

  /** 轮换密码：网关立即生效（D4） */
  rotate(nodeId: string): { username: string; password: string } {
    const password = generateNodePassword()
    const existing = this.deps.db
      .select({ node_id: nodeCredentials.node_id })
      .from(nodeCredentials)
      .where(eq(nodeCredentials.node_id, nodeId))
      .get()
    if (!existing) {
      this.deps.db
        .insert(nodeCredentials)
        .values({
          node_id: nodeId,
          username: nodeId,
          password_enc: encryptSecret(password),
          password_lookup_hash: passwordLookupHash(password),
          created_at: Date.now(),
          rotated_at: Date.now(),
        })
        .run()
    } else {
      this.deps.db
        .update(nodeCredentials)
        .set({
          password_enc: encryptSecret(password),
          password_lookup_hash: passwordLookupHash(password),
          rotated_at: Date.now(),
        })
        .where(eq(nodeCredentials.node_id, nodeId))
        .run()
    }
    this.deps.events.info('credential.rotated', '节点 ' + nodeId + ' 凭据已轮换（网关立即生效）', { nodeId })
    return { username: nodeId, password }
  }
}

function classifyFetchError(msg: string): string {
  const m = msg.toLowerCase()
  if (m.includes('abort')) return 'timeout'
  if (m.includes('enotfound') || m.includes('getaddrinfo')) return 'dns_failed'
  if (m.includes('refused')) return 'tcp_refused'
  if (m.includes('too large')) return 'too_large'
  if (m.includes('certificate')) return 'tls_error'
  return 'network_error'
}
 
