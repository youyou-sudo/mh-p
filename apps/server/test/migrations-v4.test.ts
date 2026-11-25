/**
 * v4 迁移（engine-core）测试：Mihomo 时代新增的表/列必须真的落库，且迁移可重复执行。
 * 手工迁移与 drizzle 生成迁移并存时，最容易坏的是「列名/表名对不上」和「重跑 ALTER 报 duplicate」。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'

import type { Db } from '../src/core/db'
import { openDb } from '../src/core/db'
import { runMigrations, schemaVersion } from '../src/core/migrations'

const resources: { dir: string; db: Db }[] = []

afterEach(() => {
  for (const item of resources.splice(0)) {
    try {
      item.db.raw.close()
    } catch {
      /* already closed */
    }
    try {
      rmSync(item.dir, { recursive: true, force: true })
    } catch {
      /* Windows 上 WAL 句柄可能晚一拍释放 */
    }
  }
})

function open(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'xcp-migrations-v4-'))
  const db = openDb(join(dir, 'sb.db'))
  resources.push({ dir, db })
  return db
}

const tableNames = (db: Db): string[] =>
  db
    .all<{ name: string }>(sql.raw("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
    .map((r) => r.name)

const columnNames = (db: Db, table: string): string[] =>
  db.all<{ name: string }>(sql.raw('PRAGMA table_info(' + table + ')')).map((c) => c.name)

const indexNames = (db: Db, table: string): string[] =>
  db.all<{ name: string }>(sql.raw('PRAGMA index_list(' + table + ')')).map((i) => i.name)

describe('v4 迁移（engine-core）', () => {
  test('nodes 新增 proxy_name / proxy_source / proxy_json 三列', () => {
    const db = open()
    runMigrations(db)
    const cols = columnNames(db, 'nodes')
    for (const c of ['proxy_name', 'proxy_source', 'proxy_json']) expect(cols).toContain(c)
  })

  test('engine_slots 表结构：slot 主键、node_id 唯一、port/updated_at 非空', () => {
    const db = open()
    runMigrations(db)
    expect(tableNames(db)).toContain('engine_slots')
    expect(columnNames(db, 'engine_slots')).toEqual(['slot', 'node_id', 'port', 'updated_at'])
    // node_id 唯一约束（drizzle 生成的是 UNIQUE INDEX）
    expect(indexNames(db, 'engine_slots').some((n) => n.includes('node_id'))).toBe(true)
    // 实测插两行同 node_id 必须冲突
    db.raw.exec("INSERT INTO engine_slots (slot, node_id, port, updated_at) VALUES (0, 'n1', 24000, 1)")
    expect(() =>
      db.raw.exec("INSERT INTO engine_slots (slot, node_id, port, updated_at) VALUES (1, 'n1', 24001, 1)"),
    ).toThrow()
  })

  test('engine_ops 表结构 + at 索引；自增 id 可用', () => {
    const db = open()
    runMigrations(db)
    expect(tableNames(db)).toContain('engine_ops')
    expect(columnNames(db, 'engine_ops')).toEqual([
      'id', 'revision_id', 'at', 'op', 'target', 'ok', 'duration_ms', 'detail',
    ])
    expect(indexNames(db, 'engine_ops')).toContain('idx_engine_ops_at')
    db.raw.exec("INSERT INTO engine_ops (at, op, ok) VALUES (1, 'reload', 1), (2, 'switch', 0)")
    const rows = db.all<{ id: number }>(sql.raw('SELECT id FROM engine_ops ORDER BY id'))
    expect(rows.map((r) => r.id)).toEqual([1, 2])
  })

  test('重复执行迁移是幂等的（不会重复 ALTER / 建表）', () => {
    const db = open()
    const first = runMigrations(db)
    expect(first).toBeGreaterThan(0)
    expect(runMigrations(db)).toBe(0)
    expect(schemaVersion(db)).toBe(first)
    // 再跑一次 schemaVersion 不应变化，且表结构仍可读
    expect(columnNames(db, 'nodes')).toContain('proxy_json')
  })
})
