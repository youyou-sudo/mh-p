import { eq } from 'drizzle-orm'
import type { Db } from '../../core/db'
import { AppError } from '../../core/errors'
import { decryptSecret, encryptSecret, generateNodePassword, passwordLookupHash } from '../../core/crypto'
import { compileCountryRegex, normalizeBalanceMode, type BalanceMode, type RouteGroupConfig } from '../../core/route-groups'
import { nodeAliases, nodes as nodesT, routeGroups } from '../../core/schema'
import { connectionStrings } from '../nodes/service'

const ID_RE = /^[A-Za-z0-9_.-]{2,32}$/

function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
}

function configOf(row: typeof routeGroups.$inferSelect): RouteGroupConfig {
  return {
    id: row.id,
    name: row.name,
    countryRegex: row.country_regex,
    balanceMode: normalizeBalanceMode(row.balance_mode),
    enabled: !!row.enabled,
  }
}

/** 校验组 ID 不与节点 ID / 别名 / 其它路由组冲突（它们共用网关的用户名命名空间）。 */
function assertIdFree(db: Db, id: string): void {
  if (db.select({ id: nodesT.id }).from(nodesT).where(eq(nodesT.id, id)).get()) {
    throw new AppError('conflict', '组 ID 与节点 ID 冲突', 409)
  }
  if (db.select({ alias: nodeAliases.alias }).from(nodeAliases).where(eq(nodeAliases.alias, id)).get()) {
    throw new AppError('conflict', '组 ID 与节点别名冲突', 409)
  }
  if (db.select({ id: routeGroups.id }).from(routeGroups).where(eq(routeGroups.id, id)).get()) {
    throw new AppError('conflict', '组 ID 已存在', 409)
  }
}

export interface CreateRouteGroupInput {
  name: string
  countryRegex: string
  balanceMode?: BalanceMode | string
  id?: string
}

/** 新建路由组：生成组凭据（明文只在本次响应里返回一次，之后走 rotate/connection 展示）。 */
export function createRouteGroup(db: Db, input: CreateRouteGroupInput): { config: RouteGroupConfig; password: string } {
  const name = input.name.trim()
  if (!name) throw new AppError('validation_failed', '名称不能为空', 422)
  const regex = input.countryRegex.trim()
  if (!regex) throw new AppError('validation_failed', '国家正则不能为空', 422)
  if (!compileCountryRegex(regex)) throw new AppError('validation_failed', '国家正则不是合法的正则表达式', 422)

  let id = (input.id?.trim() || slugFromName(name) || 'g').slice(0, 32)
  if (!ID_RE.test(id)) throw new AppError('validation_failed', '组 ID 只允许字母数字与 _.-（2-32 位）', 422)
  // 名称撞号时自动加随机后缀，而不是直接失败（用户没显式指定 ID 的情况）。
  if (!input.id) {
    const taken =
      !!db.select({ id: nodesT.id }).from(nodesT).where(eq(nodesT.id, id)).get() ||
      !!db.select({ alias: nodeAliases.alias }).from(nodeAliases).where(eq(nodeAliases.alias, id)).get() ||
      !!db.select({ id: routeGroups.id }).from(routeGroups).where(eq(routeGroups.id, id)).get()
    if (taken) id = (id.slice(0, 27) + '-' + randomSuffix()).slice(0, 32)
  }
  assertIdFree(db, id)

  const password = generateNodePassword()
  const now = Date.now()
  db.insert(routeGroups)
    .values({
      id,
      name,
      country_regex: regex,
      balance_mode: normalizeBalanceMode(input.balanceMode),
      enabled: 1,
      password_enc: encryptSecret(password),
      password_lookup_hash: passwordLookupHash(password),
      created_at: now,
      updated_at: now,
    })
    .run()
  const row = db.select().from(routeGroups).where(eq(routeGroups.id, id)).get()!
  return { config: configOf(row), password }
}

export interface UpdateRouteGroupInput {
  name?: string
  countryRegex?: string
  balanceMode?: BalanceMode | string
  enabled?: boolean
}

export function updateRouteGroup(db: Db, id: string, patch: UpdateRouteGroupInput): RouteGroupConfig {
  const row = db.select().from(routeGroups).where(eq(routeGroups.id, id)).get()
  if (!row) throw new AppError('not_found', '路由组不存在', 404)
  const set: Partial<typeof routeGroups.$inferInsert> = { updated_at: Date.now() }
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new AppError('validation_failed', '名称不能为空', 422)
    set.name = name
  }
  if (patch.countryRegex !== undefined) {
    const regex = patch.countryRegex.trim()
    if (!regex) throw new AppError('validation_failed', '国家正则不能为空', 422)
    if (!compileCountryRegex(regex)) throw new AppError('validation_failed', '国家正则不是合法的正则表达式', 422)
    set.country_regex = regex
  }
  if (patch.balanceMode !== undefined) set.balance_mode = normalizeBalanceMode(patch.balanceMode)
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0
  db.update(routeGroups).set(set).where(eq(routeGroups.id, id)).run()
  const next = db.select().from(routeGroups).where(eq(routeGroups.id, id)).get()!
  return configOf(next)
}

export function deleteRouteGroup(db: Db, id: string): boolean {
  const row = db.select({ id: routeGroups.id }).from(routeGroups).where(eq(routeGroups.id, id)).get()
  if (!row) return false
  db.delete(routeGroups).where(eq(routeGroups.id, id)).run()
  return true
}

/** 组凭据明文（供面板展示与网关校验）。 */
export function routeGroupCredentialOf(db: Db, id: string): { username: string; password: string } | null {
  const row = db
    .select({ password_enc: routeGroups.password_enc })
    .from(routeGroups)
    .where(eq(routeGroups.id, id))
    .get()
  if (!row) return null
  try {
    return { username: id, password: decryptSecret(row.password_enc) }
  } catch {
    return null
  }
}

/** 轮换组密码：网关立即生效（与节点凭据同一套加解密）。 */
export function rotateRouteGroup(db: Db, id: string): { username: string; password: string } {
  const row = db.select({ id: routeGroups.id }).from(routeGroups).where(eq(routeGroups.id, id)).get()
  if (!row) throw new AppError('not_found', '路由组不存在', 404)
  const password = generateNodePassword()
  db.update(routeGroups)
    .set({ password_enc: encryptSecret(password), password_lookup_hash: passwordLookupHash(password), updated_at: Date.now() })
    .where(eq(routeGroups.id, id))
    .run()
  return { username: id, password }
}

/** 生成组接入连接串（用户名 = 组 ID，密码 = 组凭据）。 */
export function routeGroupConnection(db: Db, id: string, host: string, port: number) {
  const cred = routeGroupCredentialOf(db, id)
  if (!cred) throw new AppError('not_found', '路由组不存在', 404)
  return { groupId: id, ...connectionStrings(cred.username, cred.password, host, port) }
}

export function listRouteGroupRows(db: Db): Array<typeof routeGroups.$inferSelect> {
  return db.select().from(routeGroups).all()
}

export function routeGroupRowOf(db: Db, id: string): typeof routeGroups.$inferSelect | undefined {
  return db.select().from(routeGroups).where(eq(routeGroups.id, id)).get()
}

export { configOf as routeGroupConfigOf }
// I have nothing but my burger and I want nothing more
