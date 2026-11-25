/**
 * 槽位管理。
 *
 * 为什么需要「槽位」：Mihomo 的 listener 是配置期静态的，运行期只有 `PUT /proxies/<组>`
 * 这一条热路径。于是我们把「一个 listener + 一个 select 组」预先分配成固定数量的槽位，
 * 节点只是「被指派到某个槽位」（运行期热切换），这样增删节点不需要重载配置、不断连。
 * 代价是节点数上限 = 槽位容量（设置项 engine.slotCapacity），超了必须扩容并重载。
 *
 * 端口与槽位一一对应（portStart + slot），不做动态分配：
 * 端口稳定才能让网关路由表在重载前后保持一致，也便于排障时一眼对上。
 */

import { and, eq, inArray, isNotNull, notInArray } from 'drizzle-orm'
import type { Db } from '../core/db'
import { engineSlots } from '../core/schema'

export interface SlotAssignment {
  slot: number
  nodeId: string | null
  port: number
}

export interface SlotCapacity {
  capacity: number
  portStart: number
  portEnd: number
}

export interface SlotPlan {
  /** 全部槽位（含空闲），按 slot 升序 */
  assignments: SlotAssignment[]
  /** 本次新占用槽位的节点 */
  added: string[]
  /** 本次释放槽位的节点 */
  removed: string[]
  /** 槽位未变、但节点集合里仍在的 */
  kept: string[]
  /** 期望节点里没有槽位可用的（容量不足） */
  overflow: string[]
}

/** 槽位容量与端口区间的一致性检查；返回人话错误或 null */
export function checkCapacity(c: SlotCapacity): string | null {
  if (!Number.isInteger(c.capacity) || c.capacity < 1 || c.capacity > 2000) return '槽位容量必须是 1..2000 的整数'
  if (!Number.isInteger(c.portStart) || !Number.isInteger(c.portEnd)) return '入站端口区间必须是整数'
  if (c.portStart < 1 || c.portEnd > 65535 || c.portEnd < c.portStart) return '入站端口区间非法'
  if (c.portStart + c.capacity - 1 > c.portEnd) {
    return '入站端口区间容不下 ' + c.capacity + ' 个槽位（' + c.portStart + '..' + c.portEnd + '）'
  }
  return null
}

export class SlotManager {
  constructor(
    private db: Db,
    private capacity: () => SlotCapacity,
  ) {}

  portOf(slot: number): number {
    return this.capacity().portStart + slot
  }

  /** 读全部槽位（含空闲），按 slot 升序；容量缩小后多出来的槽位行不返回（由 reconcile 清理） */
  load(): SlotAssignment[] {
    const cap = this.capacity()
    const rows = this.db.select().from(engineSlots).all()
    const bySlot = new Map<number, { nodeId: string | null; port: number }>()
    for (const r of rows) bySlot.set(r.slot, { nodeId: r.node_id ?? null, port: r.port })
    const out: SlotAssignment[] = []
    for (let slot = 0; slot < cap.capacity; slot++) {
      const hit = bySlot.get(slot)
      out.push({ slot, nodeId: hit?.nodeId ?? null, port: hit?.port ?? cap.portStart + slot })
    }
    return out
  }

  /** 槽位 → 端口（网关路由表与按需探测都用它） */
  portByNode(): Map<string, number> {
    const map = new Map<string, number>()
    for (const a of this.load()) if (a.nodeId) map.set(a.nodeId, a.port)
    return map
  }

  /**
   * 计算并落库新的槽位指派：已有映射尽量不动（换槽位会白白切换一次出口），
   * 新节点占用编号最小的空槽，消失的节点释放槽位。整个写入在一个事务里完成。
   */
  assign(desiredNodeIds: string[], now = Date.now()): SlotPlan {
    const cap = this.capacity()
    const current = this.load()
    const desired = new Set(desiredNodeIds)

    const kept: string[] = []
    const removed: string[] = []
    const assigned = new Map<number, string>() // slot -> nodeId
    for (const a of current) {
      if (a.nodeId && desired.has(a.nodeId)) {
        assigned.set(a.slot, a.nodeId)
        kept.push(a.nodeId)
      } else if (a.nodeId) {
        removed.push(a.nodeId)
      }
    }

    const usedSlots = new Set(assigned.keys())
    const pending = desiredNodeIds.filter((id) => !kept.includes(id))
    const added: string[] = []
    const overflow: string[] = []
    for (const nodeId of pending) {
      let free = -1
      for (let slot = 0; slot < cap.capacity; slot++) {
        if (!usedSlots.has(slot)) {
          free = slot
          break
        }
      }
      if (free < 0) {
        overflow.push(nodeId)
        continue
      }
      usedSlots.add(free)
      assigned.set(free, nodeId)
      added.push(nodeId)
    }

    this.db.transaction(
      () => {
        // 只保留容量范围内的槽位；缩容时多出来的行删掉
        this.db.delete(engineSlots).where(notInArray(engineSlots.slot, range(cap.capacity))).run()
        this.db.delete(engineSlots).where(and(isNotNull(engineSlots.node_id), notInArray(engineSlots.node_id, [...desired]))).run()
        for (const [slot, nodeId] of [...assigned.entries()].sort((a, b) => a[0] - b[0])) {
          this.db
            .insert(engineSlots)
            .values({ slot, node_id: nodeId, port: cap.portStart + slot, updated_at: now })
            .onConflictDoUpdate({
              target: engineSlots.slot,
              set: { node_id: nodeId, port: cap.portStart + slot, updated_at: now },
            })
            .run()
        }
      },
      { behavior: 'immediate' },
    )

    const assignments: SlotAssignment[] = []
    for (let slot = 0; slot < cap.capacity; slot++) {
      assignments.push({ slot, nodeId: assigned.get(slot) ?? null, port: cap.portStart + slot })
    }
    return { assignments, added, removed, kept, overflow }
  }
}

function range(n: number): number[] {
  return Array.from({ length: Math.max(n, 1) }, (_, i) => i)
}

/** 供外部只读查询：某个节点当前占用的槽位端口（没有则 undefined） */
export function portOfNode(db: Db, nodeId: string): number | undefined {
  const row = db.select().from(engineSlots).where(eq(engineSlots.node_id, nodeId)).get()
  return row?.port
}

/** 供对账/清理使用：找出槽位行里已不在期望集合内的节点 */
export function orphanSlots(db: Db, desiredNodeIds: string[]): string[] {
  const rows = db.select().from(engineSlots).where(isNotNull(engineSlots.node_id)).all()
  const desired = new Set(desiredNodeIds)
  return rows.map((r) => r.node_id!).filter((id) => !desired.has(id))
}

export { inArray }
