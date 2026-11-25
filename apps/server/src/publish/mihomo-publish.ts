/**
 * Mihomo 发布引擎：结构同步（必要时整份 reload）+ 槽位热指派（PUT /proxies/slot-i）。
 *
 * 为什么是这两个动作，而不是「每次发布都 reload」：
 *   实测（MIGRATION §6#2）**整份 `PUT /configs` 会掐断所有走 provider proxy 的在途连接**
 *   （5/5 断），而 `PUT /proxies/<组>` 是热切换（p50 0.22ms、不断连）。所以：
 *     · 节点增删/改参 → **只**改槽位指派，绝不 reload；
 *     · 只有 provider 集合、槽位容量、基础参数（external-controller/secret/log-level/mode/端口区间）
 *       变了才写 config + reload——这些都在配置期，运行期没有对应 API。
 *
 * 发布顺序（顺序本身是正确性的一部分，别调换）：
 *   ① 算期望节点（只读）→ ② 安全阀 → ③ `slots.assign`（事务落库）→ ④ 渲染 + 与磁盘逐字节比对
 *   → ⑤ 变了才：备份 → 写文件 → `mihomo -t` 校验 → 失败还原（不 reload）→ 成功 reload
 *   → ⑥ 逐槽位比对 `GET /proxies/<组>.now`，不同才 PUT → ⑦ 路由表 replace+persist
 *   → ⑧ runtime_revisions + engine_ops。
 *
 * 两个容易忽略但必须处理的事实：
 *   · **reload 会把所有槽位组的选中项重置回默认（实测：reload 后 slot-0 从 node-b 回到 node-a）**，
 *     所以第 ⑥ 步必须在第 ⑤ 步之后、且对**每个**有节点的槽位都比对——只对「新节点」PUT 会漏掉
 *     被 reload 打回默认的老节点。
 *   · 槽位组的成员来自 provider；provider 还没被 sync 灌进来时组是空的，`now` 是 `REJECT`，
 *     此时 PUT 一个还不存在的 proxy 会得到 400 `Selector update error: proxy not exist`。
 *     这是「sync 必须先于 publish」的硬约束，不是重试能解决的，所以单槽失败要 loud 记录而不是死循环。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { and, asc, desc, eq, isNotNull, ne } from 'drizzle-orm'
import type { Db } from '../core/db'
import type { EventBus } from '../core/events'
import { digestOf, revisionId as newRevisionId } from '../core/ids'
import type { RoutingTable } from '../core/routing'
import { engineOps, nodeCredentials, nodeStatus, nodes as nodesT, runtimeRevisions, subscriptions } from '../core/schema'
import type { MihomoClient } from '../mihomo/client'
import { providerNameOf, renderMihomoConfig, slotGroupName, slotListenerName } from '../mihomo/config'
import { providerFilePath, renderProviderSpecs } from '../mihomo/provider'
import { checkCapacity, type SlotAssignment, type SlotManager } from './slots'

export interface MihomoEngineParams {
  externalController: string
  secret: string
  logLevel: string
  mode: 'rule' | 'global'
  slotCapacity: number
  portStart: number
  portEnd: number
  testUrl: string
  healthCheckIntervalSec: number
}

export interface MihomoPublishDeps {
  db: Db
  events: EventBus
  client: MihomoClient
  /** 只需要 testConfig：MihomoProcess 满足它，测试里可以给假的 */
  process: { testConfig(file: string): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> }
  slots: SlotManager
  routing: RoutingTable
  engine: () => MihomoEngineParams
  policy: () => { policy: 'healthy_only' | 'all_enabled'; requireMinNodes: number }
  dirs: { configDir: string; configPath: string; providerDir: string }
  now?: () => number
}

export interface PublishCheck {
  id: string
  label: string
  ok: boolean
  detail: string
}

export interface PublishOutcome {
  ok: boolean
  revisionId: string
  /** 本次是否真的写了 config 并 reload（结构没变 → false，且不碰文件） */
  reloaded: boolean
  /** 槽位净新增（SlotPlan.added） */
  assigned: number
  /** 槽位净释放（SlotPlan.removed） */
  released: number
  overflow: string[]
  checks: PublishCheck[]
  error?: string
}

/** 期望节点（已解析出引擎侧 proxy 名与槽位预览） */
export interface MihomoDesiredNode {
  nodeId: string
  /** 引擎侧 proxy 名（nodes.proxy_name，provider 内唯一） */
  proxyName: string
  /** 来源 provider 名（sub-<订阅ID>；静态/内置节点为空） */
  proxySource: string | null
  /** 网关用户名（node_credentials.username，缺失回落 nodeId） */
  username: string
  /** 槽位预览（publish 时以 SlotManager.assign 的结果为准） */
  slot: number | null
  port: number | null
}

export interface MihomoPublishPlan {
  desired: MihomoDesiredNode[]
  /** 当前（未落库前）的槽位表 */
  slots: SlotAssignment[]
  /** 期望节点里没有槽位可用的（容量不足） */
  overflow: string[]
  providers: string[]
  /** 渲染出来的配置文本（dryRun 也可以拿它做 diff 展示） */
  configText: string
  /** 与磁盘现有 config 是否不同（逐字节比较；文件不存在算不同） */
  configChanged: boolean
  checks: PublishCheck[]
  /** 安全阀全过为 true */
  ok: boolean
  skipped: { quarantined: number; expired: number }
}

const POSIX = (p: string) => p.replace(/\\/g, '/')

export class MihomoPublisher {
  constructor(private deps: MihomoPublishDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * 期望节点：enabled=1 且已有 proxy_name（sync 落库）且协议可发布且非虚拟。
   * healthy_only 时排除 quarantined；stale_until 已过期的排除（消失节点的宽限期到了）。
   * 逐节点 publish_policy_override 仍然生效（旧表就有的列，不能让它在迁移后变成死字段）。
   */
  private desiredNodes(now: number): { desired: MihomoDesiredNode[]; quarantined: number; expired: number } {
    const globalPolicy = this.deps.policy().policy
    const rows = this.deps.db
      .select({
        id: nodesT.id,
        proxy_name: nodesT.proxy_name,
        proxy_source: nodesT.proxy_source,
        publish_policy_override: nodesT.publish_policy_override,
        stale_until: nodesT.stale_until,
        state: nodeStatus.state,
        username: nodeCredentials.username,
      })
      .from(nodesT)
      .leftJoin(nodeStatus, eq(nodeStatus.node_id, nodesT.id))
      .leftJoin(nodeCredentials, eq(nodeCredentials.node_id, nodesT.id))
      .where(
        and(
          eq(nodesT.enabled, 1),
          isNotNull(nodesT.proxy_name),
          eq(nodesT.protocol_supported, 1),
          eq(nodesT.is_virtual, 0),
        ),
      )
      .orderBy(asc(nodesT.id))
      .all()

    const desired: MihomoDesiredNode[] = []
    let quarantined = 0
    let expired = 0
    for (const row of rows) {
      const proxyName = (row.proxy_name ?? '').trim()
      if (!proxyName) continue
      if (row.stale_until !== null && row.stale_until <= now) {
        expired++
        continue
      }
      const effective =
        row.publish_policy_override === 'healthy_only' || row.publish_policy_override === 'all_enabled'
          ? row.publish_policy_override
          : globalPolicy
      if (effective === 'healthy_only' && row.state === 'quarantined') {
        quarantined++
        continue
      }
      desired.push({
        nodeId: row.id,
        proxyName,
        proxySource: row.proxy_source ?? null,
        username: row.username ?? row.id,
        slot: null,
        port: null,
      })
    }
    return { desired, quarantined, expired }
  }

  /** provider 目录相对 Mihomo -d（configDir）的路径；Mihomo 对 provider.path 按 -d 解析 */
  private relativeProviderDir(): string {
    const { configDir, providerDir } = this.deps.dirs
    const rel = POSIX(relative(resolve(configDir), resolve(providerDir)))
    return rel === '' ? '.' : rel
  }

  private providerSpecs(engine: MihomoEngineParams) {
    const subs = this.deps.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.enabled, 1))
      .orderBy(asc(subscriptions.id))
      .all()
    return renderProviderSpecs(subs, {
      providerDir: this.relativeProviderDir(),
      healthCheckUrl: engine.testUrl,
      healthCheckIntervalSec: engine.healthCheckIntervalSec,
    })
  }

  private renderConfig(engine: MihomoEngineParams, providerNames: string[]): string {
    return renderMihomoConfig({
      logLevel: engine.logLevel,
      externalController: engine.externalController,
      secret: engine.secret,
      mode: engine.mode,
      testUrl: engine.testUrl,
      providers: this.providerSpecs(engine),
      // 组与 listener 覆盖**全部**槽位（不只是有节点的）：listener 集合是配置期的，
      // 少写一个槽位就意味着扩容要 reload；多写一个空槽位的成本只是一个空闲组。
      groups: Array.from({ length: engine.slotCapacity }, (_, i) => ({ name: slotGroupName(i), use: providerNames })),
      listeners: Array.from({ length: engine.slotCapacity }, (_, i) => ({
        name: slotListenerName(i),
        listen: '127.0.0.1',
        port: engine.portStart + i,
        type: 'mixed' as const,
        proxy: slotGroupName(i),
      })),
    })
  }

  private readConfigText(): string | null {
    const p = this.deps.dirs.configPath
    try {
      return existsSync(p) ? readFileSync(p, 'utf8') : null
    } catch {
      return null
    }
  }

  /** 只算不写：dryRun / UI 预览 / publish 的前半段都用它 */
  async plan(): Promise<MihomoPublishPlan> {
    const now = this.now()
    const engine = this.deps.engine()
    const policy = this.deps.policy()
    const { desired, quarantined, expired } = this.desiredNodes(now)
    const checks: PublishCheck[] = []

    // 安全阀 1：槽位容量与端口区间
    const capErr = checkCapacity({ capacity: engine.slotCapacity, portStart: engine.portStart, portEnd: engine.portEnd })
    checks.push({
      id: 'slotCapacity',
      label: '槽位容量与入站端口区间自洽',
      ok: capErr === null,
      detail: capErr ?? '槽位 ' + engine.slotCapacity + '，端口 ' + engine.portStart + '..' + engine.portEnd,
    })

    // 安全阀 2：最少节点数（防止一次误操作把数据面清空）
    const minOk = desired.length >= policy.requireMinNodes
    checks.push({
      id: 'requireMinNodes',
      label: '可发布节点数不小于 requireMinNodes',
      ok: minOk,
      detail: '期望 ' + desired.length + ' / 要求 >= ' + policy.requireMinNodes,
    })

    // provider.path 相对 -d 解析；目录跑出 -d 之外会让 Mihomo 读不到（甚至写到别处）
    const relProviderDir = this.relativeProviderDir()
    const dirOk = !(relProviderDir === '..' || relProviderDir.startsWith('../'))
    checks.push({
      id: 'providerDir',
      label: 'provider 目录位于数据面工作目录内',
      ok: dirOk,
      detail: dirOk
        ? 'providers 相对 -d：' + relProviderDir
        : 'provider 目录跑出数据面工作目录（相对路径 ' + relProviderDir + '），Mihomo 会找不到 provider 文件',
    })

    // 槽位预览（纯计算）：与 SlotManager.assign 同一策略——已有的映射不动，新节点占编号最小的空槽
    const { assignments, overflow } = previewAssignments(
      this.deps.slots.load(),
      desired.map((d) => d.nodeId),
      engine.slotCapacity,
      engine.portStart,
    )
    const slotOf = new Map(assignments.filter((a) => a.nodeId).map((a) => [a.nodeId!, a.slot]))
    for (const d of desired) {
      d.slot = slotOf.get(d.nodeId) ?? null
      // 槽位端口是 portStart + slot（不做动态分配，见 slots.ts 文件头）
      d.port = d.slot === null ? null : engine.portStart + d.slot
    }
    checks.push({
      id: 'slotOverflow',
      label: '期望节点全部有槽位可用',
      ok: overflow.length === 0,
      detail:
        overflow.length === 0
          ? desired.length + ' 个节点占用 ' + slotOf.size + ' 个槽位（容量 ' + engine.slotCapacity + '）'
          : '容量不足：' + overflow.length + ' 个节点没有槽位（' + overflow.slice(0, 5).join('、') + '）；导入会失败，请调大 engine.slotCapacity（注意：扩容需要 reload，会断掉在途连接）',
    })

    const providers = this.providerSpecs(engine)
    const providerNames = providers.map((p) => p.name)
    const configText = this.renderConfig(engine, providerNames)
    const configChanged = this.readConfigText() !== configText

    // 提示性检查（不拦发布）：file provider 的目标文件由 sync 生成；缺失时 Mihomo 仍能 -t 通过
    // （实测 exit=0），但那个 provider 会是空的，组里就没成员可切。
    if (providers.some((p) => p.type === 'file')) {
      const missing = providers
        .filter((p) => p.type === 'file')
        .filter((p) => !existsSync(resolve(this.deps.dirs.configDir, p.path)))
        .map((p) => p.path)
      checks.push({
        id: 'providerFiles',
        label: 'file provider 的目标文件已生成',
        ok: true,
        detail:
          missing.length === 0
            ? '全部 file provider 文件存在'
            : missing.length + ' 个 file provider 文件尚未生成（sync 会先写）：' + missing.slice(0, 3).join('、') + '；这些 provider 此刻是空的，槽位切换会失败',
      })
    }

    return {
      desired,
      slots: assignments,
      overflow,
      providers: providerNames,
      configText,
      configChanged,
      checks,
      ok: checks.every((c) => c.ok),
      skipped: { quarantined, expired },
    }
  }

  /**
   * 只同步「结构」（provider 段 / 槽位组 / listener / 基础参数），不做槽位指派、不跑安全阀。
   *
   * 用途只有一个：**首次接入某个订阅**时，sync 必须先把 provider 段加载进引擎，
   * 否则 `PUT /providers/proxies/<name>` 会 404（provider 还不在配置里）。
   * 此时库里可能一个可发布节点都没有（requireMinNodes 会拦），但结构同步必须照常发生；
   * 所以这里刻意绕过安全阀——它不写槽位表、不动路由表、不碰节点状态，副作用只有 config 文件与 reload。
   */
  async syncStructure(): Promise<{ ok: boolean; reloaded: boolean; error?: string }> {
    const p = await this.plan()
    const revId = newRevisionId(this.now())
    if (!p.configChanged) return { ok: true, reloaded: false }
    const applied = await this.applyConfig(p.configText, revId)
    if (!applied.ok) return { ok: false, reloaded: false, error: applied.error }
    return { ok: true, reloaded: true }
  }

  async publish(opts: { reason?: string; dryRun?: boolean } = {}): Promise<PublishOutcome> {
    const dryRun = opts.dryRun ?? false
    const reason = opts.reason ?? 'manual'
    const p = await this.plan()
    const revId = newRevisionId(this.now())

    if (dryRun) {
      return {
        ok: p.ok,
        revisionId: revId,
        reloaded: false,
        assigned: 0,
        released: 0,
        overflow: p.overflow,
        checks: p.checks,
        error: p.ok ? undefined : summarizeFailures(p.checks),
      }
    }

    // 安全阀拦下 → 什么都不写（不落 revision、不碰文件、不调 API）
    if (!p.ok) {
      const error = summarizeFailures(p.checks)
      this.deps.events.error('publish.rejected', '发布被安全阀拦下，数据面未做任何改动：' + error, { revisionId: revId })
      return { ok: false, revisionId: revId, reloaded: false, assigned: 0, released: 0, overflow: p.overflow, checks: p.checks, error }
    }

    const checks = [...p.checks]
    const t0 = this.now()

    // ③ 槽位落库（事务）。注意：这一步之后即使后续失败，槽位表也已经变了——
    // 这是 spec 规定的顺序（先分配再动引擎）；失败时路由表不动，所以不会有流量打到错端口。
    const slotPlan = this.deps.slots.assign(p.desired.map((d) => d.nodeId), this.now())
    const portOfSlot = new Map<number, number>()
    const slotOfNode = new Map<string, number>()
    for (const a of slotPlan.assignments) {
      portOfSlot.set(a.slot, a.port)
      if (a.nodeId) slotOfNode.set(a.nodeId, a.slot)
    }
    for (const d of p.desired) {
      const slot = slotOfNode.get(d.nodeId) ?? null
      d.slot = slot
      d.port = slot === null ? null : (portOfSlot.get(slot) ?? null)
    }

    // ④⑤ 结构同步：只有文本变了才动文件与 reload
    let reloaded = false
    if (p.configChanged) {
      const applied = await this.applyConfig(p.configText, revId)
      checks.push(applied.check)
      if (!applied.ok) {
        this.recordRevision(
          revId,
          'failed',
          reason,
          p,
          { assigned: slotPlan.added.length, released: slotPlan.removed.length, reloaded: false, switched: 0 },
          applied.error,
        )
        this.deps.events.error('publish.failed', '结构同步失败（已还原上一份 config，未 reload）：' + applied.error, { revisionId: revId })
        return {
          ok: false,
          revisionId: revId,
          reloaded: false,
          assigned: slotPlan.added.length,
          released: slotPlan.removed.length,
          overflow: slotPlan.overflow,
          checks,
          error: applied.error,
        }
      }
      reloaded = true
    }

    // ⑥ 槽位热切换：必须覆盖**所有**有节点的槽位（reload 会把选中项重置回组默认）
    const sw = await this.switchSlots(p.desired, revId)
    checks.push(sw.check)

    // ⑦ 网关路由表：username → 槽位端口
    const routed = this.updateRouting(p.desired, sw.failedNodeIds)
    checks.push({
      id: 'routing',
      label: '网关路由表已更新',
      ok: true,
      detail:
        routed + ' 条路由（username → 槽位端口）' +
        (sw.failedNodeIds.size > 0 ? '；' + sw.failedNodeIds.size + ' 个切换失败的节点未写入（避免打到错误出口）' : ''),
    })

    const ok = sw.ok
    this.recordRevision(
      revId,
      ok ? 'active' : 'failed',
      reason,
      p,
      { assigned: slotPlan.added.length, released: slotPlan.removed.length, reloaded, switched: sw.switched },
      ok ? undefined : sw.error,
    )
    this.recordEngineOp(revId, 'assign', null, ok, this.now() - t0, {
      assigned: slotPlan.added.length,
      released: slotPlan.removed.length,
      switched: sw.switched,
      failed: sw.failed,
    })
    if (ok) {
      this.deps.events.info(
        'publish.done',
        '发布完成：节点 ' + p.desired.length + '，槽位 +' + slotPlan.added.length + '/-' + slotPlan.removed.length +
          '，切换 ' + sw.switched + '，' + (reloaded ? '结构已 reload' : '结构未变（未 reload）'),
        { revisionId: revId },
      )
    } else {
      this.deps.events.error('publish.slot_failed', '槽位切换有 ' + sw.failed + ' 个失败：' + (sw.error ?? ''), { revisionId: revId })
    }

    return {
      ok,
      revisionId: revId,
      reloaded,
      assigned: slotPlan.added.length,
      released: slotPlan.removed.length,
      overflow: slotPlan.overflow,
      checks,
      error: ok ? undefined : sw.error,
    }
  }

  /**
   * 写 config → `-t` → reload，任一步失败都还原成上一份并（若已 reload 过）reload 回去。
   * 返回的 check 用于告诉调用方失败在哪一步、错误原文是什么。
   */
  private async applyConfig(
    configText: string,
    revId: string,
  ): Promise<{ ok: boolean; check: PublishCheck; error?: string }> {
    const { configPath, configDir } = this.deps.dirs
    const backupPath = configPath + '.bak'
    const hadConfig = existsSync(configPath)
    const t0 = this.now()
    try {
      mkdirSync(configDir, { recursive: true })
      if (hadConfig) copyFileSync(configPath, backupPath)
      writeFileSync(configPath, configText, 'utf8')
    } catch (e) {
      return {
        ok: false,
        check: { id: 'configWrite', label: '写入 config.yaml', ok: false, detail: msgOf(e) },
        error: '写 config 失败：' + msgOf(e),
      }
    }

    const tested = await this.deps.process.testConfig(configPath)
    this.recordEngineOp(revId, 'test_config', configPath, tested.ok, this.now() - t0, {
      code: tested.code,
      stderr: tested.stderr.slice(0, 500),
    })
    if (!tested.ok) {
      this.restoreConfig(hadConfig, backupPath, configPath)
      const detail = (tested.stderr || tested.stdout).trim().slice(0, 500)
      return {
        ok: false,
        check: {
          id: 'configBuild',
          label: 'config.yaml 通过 mihomo -t 构建校验',
          ok: false,
          detail: 'mihomo -t exit=' + tested.code + '：' + detail,
        },
        error: 'config 未通过 -t 校验（已还原上一份，未 reload）：' + detail,
      }
    }

    const rt0 = this.now()
    try {
      await this.deps.client.reloadFromPath(configPath)
    } catch (e) {
      this.restoreConfig(hadConfig, backupPath, configPath)
      // 还原之后必须把引擎也拉回旧配置，否则引擎里跑的是新配置、磁盘是旧的
      let reloadBack = 'ok'
      try {
        if (hadConfig) await this.deps.client.reloadFromPath(configPath)
      } catch (e2) {
        reloadBack = '失败：' + msgOf(e2)
      }
      this.recordEngineOp(revId, 'reload', configPath, false, this.now() - rt0, {
        error: msgOf(e).slice(0, 500),
        reloadBack,
      })
      return {
        ok: false,
        check: {
          id: 'configReload',
          label: 'PUT /configs 重载',
          ok: false,
          detail: msgOf(e).slice(0, 300) + '（已还原 config 并重载回旧配置：' + reloadBack + '）',
        },
        error: 'reload 失败（已还原并重载回旧配置）：' + msgOf(e),
      }
    }
    this.recordEngineOp(revId, 'reload', configPath, true, this.now() - rt0, {})
    return {
      ok: true,
      check: { id: 'configReload', label: 'PUT /configs 重载', ok: true, detail: '已 reload（' + (this.now() - rt0) + 'ms）' },
    }
  }

  private restoreConfig(hadConfig: boolean, backupPath: string, configPath: string): void {
    try {
      if (hadConfig && existsSync(backupPath)) copyFileSync(backupPath, configPath)
      else rmSync(configPath, { force: true })
    } catch {
      /* 还原失败没有更多手段；引擎侧已由调用方决定是否 reload 回去 */
    }
  }

  /**
   * 逐槽位对齐 `now`。单槽失败不中断整批（能切多少切多少），但最终 ok=false + 失败明细，
   * 让 UI 能一眼看到「哪几个槽位没切过去」而不是整批回滚。
   */
  private async switchSlots(
    desired: MihomoDesiredNode[],
    revId: string,
  ): Promise<{
    ok: boolean
    check: PublishCheck
    switched: number
    failed: number
    failedNodeIds: Set<string>
    error?: string
  }> {
    const targets = desired.filter((d) => d.slot !== null)
    let switched = 0
    const failures: string[] = []
    const failedNodeIds = new Set<string>()
    for (const d of targets) {
      const group = slotGroupName(d.slot!)
      try {
        const info = await this.deps.client.request<{ now?: string }>('/proxies/' + encodeURIComponent(group))
        if (info?.now === d.proxyName) continue
        await this.deps.client.request('/proxies/' + encodeURIComponent(group), {
          method: 'PUT',
          body: JSON.stringify({ name: d.proxyName }),
        })
        switched++
      } catch (e) {
        failures.push(group + '→' + d.proxyName + '：' + msgOf(e).slice(0, 120))
        failedNodeIds.add(d.nodeId)
        this.recordEngineOp(revId, 'assign', group, false, null, { proxy: d.proxyName, error: msgOf(e).slice(0, 300) })
      }
    }
    const ok = failures.length === 0
    return {
      ok,
      switched,
      failedNodeIds,
      failed: failures.length,
      check: {
        id: 'slotSwitch',
        label: '槽位热切换（PUT /proxies/slot-i）',
        ok,
        detail: ok
          ? '切换 ' + switched + ' 个槽位（共 ' + targets.length + ' 个有节点的槽位）'
          : failures.length + ' 个槽位切换失败（其余已生效）：' + failures.slice(0, 3).join('；'),
      },
      error: ok ? undefined : failures.length + ' 个槽位切换失败：' + failures.slice(0, 3).join('；'),
    }
  }

  /**
   * 路由表：username（缺凭据回落 nodeId）→ 槽位端口。端口来自槽位，不是动态端口池。
   *
   * 槽位切换失败的节点**不写入**：那个端口此刻的出口还是组里的旧选中项，写进去等于把用户
   * 流量打到别人的出口（比"查不到用户"严重得多）。漏掉的路由由下一次成功发布补上。
   */
  private updateRouting(desired: MihomoDesiredNode[], skip: Set<string>): number {
    const entries = desired
      .filter((d) => d.port !== null && !skip.has(d.nodeId))
      .map((d) => ({ nodeId: d.nodeId, port: d.port!, username: d.username }))
    this.deps.routing.replace(entries)
    this.deps.routing.persist()
    return entries.length
  }

  private recordEngineOp(
    revId: string | null,
    op: string,
    target: string | null,
    ok: boolean,
    durationMs: number | null,
    detail: unknown,
  ): void {
    try {
      this.deps.db
        .insert(engineOps)
        .values({
          revision_id: revId,
          at: this.now(),
          op,
          target,
          ok: ok ? 1 : 0,
          duration_ms: durationMs,
          detail: JSON.stringify(detail),
        })
        .run()
    } catch {
      /* 审计失败不阻断发布 */
    }
  }

  private recordRevision(
    revId: string,
    status: 'active' | 'failed',
    reason: string,
    p: MihomoPublishPlan,
    counters: { assigned: number; released: number; reloaded: boolean; switched: number },
    error?: string,
  ): void {
    const at = this.now()
    try {
      this.deps.db
        .insert(runtimeRevisions)
        .values({
          id: revId,
          status,
          reason,
          created_at: at,
          applied_at: at,
          node_count: p.desired.length,
          added_count: counters.assigned,
          removed_count: counters.released,
          // changed_count 记「实际改了出口的槽位数」：reload 不是节点改动，不能算在这里
          changed_count: counters.switched,
          skipped_count: p.skipped.quarantined + p.skipped.expired,
          plan_digest: digestOf(p.configText),
          plan_json: JSON.stringify({
            desired: p.desired,
            providers: p.providers,
            overflow: p.overflow,
            configChanged: p.configChanged,
            reloaded: counters.reloaded,
            skipped: p.skipped,
          }),
          validation_json: JSON.stringify(p.checks),
          error: error ?? null,
        })
        .run()
      if (status === 'active') {
        // 上一份 active 退位，currentStatus 才有「当前生效」的语义
        this.deps.db
          .update(runtimeRevisions)
          .set({ status: 'retired', retired_at: at })
          .where(and(eq(runtimeRevisions.status, 'active'), ne(runtimeRevisions.id, revId)))
          .run()
      }
    } catch {
      /* 落库失败不改变已经生效的数据面；错误由调用方的 ok 表达 */
    }
  }

  currentStatus(): { revisionId: string | null; lastPublishAt: number | null } {
    const row = this.deps.db
      .select({ id: runtimeRevisions.id, created_at: runtimeRevisions.created_at, applied_at: runtimeRevisions.applied_at })
      .from(runtimeRevisions)
      .where(eq(runtimeRevisions.status, 'active'))
      .orderBy(desc(runtimeRevisions.created_at))
      .limit(1)
      .get()
    return row ? { revisionId: row.id, lastPublishAt: row.applied_at ?? row.created_at } : { revisionId: null, lastPublishAt: null }
  }
}

/**
 * 槽位预览（纯函数）：与 SlotManager.assign 的策略一致——已有映射保留，新节点占编号最小的空槽。
 * 为什么这里要重算一遍而不用 assign()：plan()/dryRun 不允许写库（assign 会落盘）。
 * publish() 仍以 assign() 的结果为准；两者若将来分叉，以 assign 为准，这里只服务预览。
 */
export function previewAssignments(
  current: SlotAssignment[],
  desiredNodeIds: string[],
  capacity: number,
  portStart: number,
): { assignments: SlotAssignment[]; overflow: string[] } {
  const desired = new Set(desiredNodeIds)
  const assigned = new Map<number, string>()
  for (const a of current) {
    if (a.nodeId && desired.has(a.nodeId) && a.slot < capacity) assigned.set(a.slot, a.nodeId)
  }
  const used = new Set(assigned.keys())
  const alreadyAssigned = new Set(assigned.values())
  const pending = desiredNodeIds.filter((id) => !alreadyAssigned.has(id))
  const overflow: string[] = []
  for (const nodeId of pending) {
    let free = -1
    for (let slot = 0; slot < capacity; slot++) {
      if (!used.has(slot)) {
        free = slot
        break
      }
    }
    if (free < 0) {
      overflow.push(nodeId)
      continue
    }
    used.add(free)
    assigned.set(free, nodeId)
  }
  const assignments: SlotAssignment[] = []
  for (let slot = 0; slot < capacity; slot++) {
    assignments.push({ slot, nodeId: assigned.get(slot) ?? null, port: portStart + slot })
  }
  return { assignments, overflow }
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function summarizeFailures(checks: PublishCheck[]): string {
  const bad = checks.filter((c) => !c.ok)
  if (bad.length === 0) return ''
  return bad.map((c) => c.label + '：' + c.detail).join('；')
}
