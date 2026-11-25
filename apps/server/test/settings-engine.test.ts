/**
 * settings.engine（Mihomo 过渡形态）测试。
 *
 * 覆盖三件容易在“改名”里静默坏掉的事：
 *  1) 新库默认值：engine.binary 必须是 mihomo、REST secret 必须生成并落库（不能是固定默认值）；
 *  2) 旧库兼容：老库只有 settings.xray.*，读出来要把能对应的键复制到 engine.*，
 *     且 engine.binary 强制 mihomo（否则会覆盖 env 继续找 xray 启动失败）；
 *     不删 xray（过渡期旧引擎代码仍读它），engine 里不能残留 xray 专属键；
 *  3) 校验：slotCapacity 越界、端口区间容不下槽位必须被拒。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb, type Db } from '../src/core/db'
import { runMigrations } from '../src/core/migrations'
import { settings as settingsTable } from '../src/core/schema'
import { DEFAULT_SETTINGS, SettingsStore } from '../src/core/settings'

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

function setup(stored?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'xcp-settings-engine-'))
  const db = openDb(join(dir, 'sb.db'))
  resources.push({ dir, db })
  runMigrations(db)
  if (stored) {
    db.insert(settingsTable)
      .values({ key: 'root', value_json: JSON.stringify(stored), updated_at: 1 })
      .run()
  }
  return { db, store: new SettingsStore(db) }
}

describe('settings.engine：新库默认值', () => {
  test('binary=mihomo、external-controller=9090、REST secret 随机生成并落库', () => {
    const { db } = setup()
    const store = new SettingsStore(db)
    const engine = store.get().engine
    expect(engine.binary).toBe('mihomo')
    expect(engine.apiAddress).toBe(DEFAULT_SETTINGS.engine.apiAddress)
    expect(engine.apiTimeoutMs).toBe(10000)
    expect(engine.slotCapacity).toBe(256)
    expect(engine.inboundPortStart).toBe(24000)
    expect(engine.inboundPortEnd).toBe(28999)
    // secret 不能是空串或固定值：必须是随机生成且已持久化
    expect(engine.secret.length).toBeGreaterThanOrEqual(32)

    // 再开一个 store 读同一库：secret 必须稳定（否则每次重启都会把客户端/脚本踢下线）
    const again = new SettingsStore(db)
    expect(again.get().engine.secret).toBe(engine.secret)
  })

  test('detect.delayTimeoutMs 默认 5000（Mihomo 延迟测试用）', () => {
    const { db } = setup()
    expect(new SettingsStore(db).get().detect.delayTimeoutMs).toBe(5000)
  })
})

describe('settings.engine：旧库（只有 xray.*）迁移', () => {
  const legacy = {
    xray: {
      mode: 'external',
      binary: 'xray',
      binarySha256: 'a'.repeat(64),
      apiAddress: '127.0.0.1:8501',
      apiChannel: 'grpc',
      apiTimeoutSec: 7,
      metricsListen: '127.0.0.1:8502',
      inboundPortStart: 25000,
      inboundPortEnd: 25999,
      portCooldownSec: 42,
      retireDelayMs: 1000,
      hotOpsRestartThreshold: 10,
      maintenanceWindow: '05:30',
      logLevel: 'info',
      replayOnStart: false,
    },
  }

  test('能对应的键复制到 engine.*，binary 强制 mihomo，xray 组被丢弃', () => {
    const { store } = setup(legacy)
    const s = store.get()
    expect(s.engine.mode).toBe('external')
    expect(s.engine.binary).toBe('mihomo')
    expect(s.engine.apiAddress).toBe('127.0.0.1:8501')
    // xray 用秒、engine 用毫秒：7s → 7000ms
    expect(s.engine.apiTimeoutMs).toBe(7000)
    expect(s.engine.logLevel).toBe('info')
    expect(s.engine.inboundPortStart).toBe(25000)
    expect(s.engine.inboundPortEnd).toBe(25999)
    expect(s.engine.portCooldownSec).toBe(42)
    expect(s.engine.maintenanceWindow).toBe('05:30')
    // 切流后没有任何引擎读 xray.*（旧引擎代码已删），留着只会让面板显示一份"看似生效"的死配置
    expect('xray' in (s as unknown as Record<string, unknown>)).toBe(false)
  })

  test('engine 里不残留 xray 专属键；迁移结果持久化，二次启动不再重迁', () => {
    const { db, store } = setup(legacy)
    const keys = Object.keys(store.get().engine).sort()
    expect(keys).toEqual([
      'apiAddress', 'apiTimeoutMs', 'binary', 'inboundPortEnd', 'inboundPortStart',
      'logLevel', 'maintenanceWindow', 'mode', 'portCooldownSec', 'secret', 'slotCapacity',
    ])
    const secret = store.get().engine.secret

    // 迁移后必须立即落库：重启后不能再靠“stored 里没有 engine”来猜
    const row = db.select().from(settingsTable).get()
    expect(row?.value_json).toContain('"engine"')
    const again = new SettingsStore(db)
    expect(again.get().engine.apiAddress).toBe('127.0.0.1:8501')
    expect(again.get().engine.secret).toBe(secret)
  })

  test('新库（已有 engine）不会被旧键覆盖（迁移只做一次）', () => {
    const { store } = setup({ engine: { binary: 'mihomo-custom', apiAddress: '127.0.0.1:9099' }, xray: { binary: 'xray' } })
    // 已有 engine 时不再从 xray 复制（只有 partial engine 缺的键走默认值）
    expect(store.get().engine.binary).toBe('mihomo-custom')
    expect(store.get().engine.apiAddress).toBe('127.0.0.1:9099')
  })
})

describe('settings.engine：校验', () => {
  test('slotCapacity 越界（>2000）被拒', () => {
    const { store } = setup()
    expect(() => store.update({ engine: { slotCapacity: 5000 } })).toThrow(/slotCapacity/)
  })

  test('端口区间容不下槽位被拒', () => {
    const { store } = setup()
    expect(() => store.update({ engine: { inboundPortStart: 24000, inboundPortEnd: 24010, slotCapacity: 256 } }))
      .toThrow(/端口区间容不下/)
  })

  test('inboundPortEnd 必须大于 start', () => {
    const { store } = setup()
    expect(() => store.update({ engine: { inboundPortStart: 25000, inboundPortEnd: 25000 } })).toThrow(/inboundPortEnd/)
  })

  test('合法的 engine 更新会落库并可再次读取', () => {
    const { db, store } = setup()
    store.update({ engine: { slotCapacity: 64, apiAddress: '127.0.0.1:9091' } })
    const again = new SettingsStore(db)
    expect(again.get().engine.slotCapacity).toBe(64)
    expect(again.get().engine.apiAddress).toBe('127.0.0.1:9091')
    expect(again.get().engine.secret).toBe(store.get().engine.secret)
  })
})
