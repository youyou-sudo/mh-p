import { t } from 'elysia'

export const routeGroupCreateBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 48 }),
  countryRegex: t.String({ minLength: 1, maxLength: 200 }),
  balanceMode: t.Optional(t.Union([t.Literal('balanced'), t.Literal('sticky')])),
  /** 可选自定义组 ID（= 客户端接入用户名）；省略时按名称生成 */
  id: t.Optional(t.String()),
})

export const routeGroupPatchBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 48 })),
  countryRegex: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  balanceMode: t.Optional(t.Union([t.Literal('balanced'), t.Literal('sticky')])),
  enabled: t.Optional(t.Boolean()),
})
