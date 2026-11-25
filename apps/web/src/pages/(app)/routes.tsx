import { useEffect, useMemo, useState } from "react"
import { defineRoute } from "@teyik0/furin"
import { Pencil, Plus, RefreshCw, RotateCcw, Trash2, Waypoints } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/common/page-header"
import { SectionCard, InfoGrid } from "@/components/common/section-card"
import { EmptyState } from "@/components/common/empty-state"
import { ErrorState } from "@/components/common/error-state"
import { LoadingButton } from "@/components/common/loading-button"
import { CodeBlock } from "@/components/common/code-block"
import { useConfirm } from "@/components/common/confirm-dialog"
import { RouteGroupDialog } from "@/components/routes/route-group-dialog"
import { balanceModeLabel, type RouteGroup, type RouteGroupConnection, type RouteGroupListResponse } from "@/components/routes/types"
import { describeError, eden, unwrap } from "@/lib/api"
import { useAction, useResource } from "@/lib/hooks"
import { fmtTime } from "@/lib/format"
import { route as appRoute } from "./_route"

export const route = defineRoute()
  .config({ layout: appRoute, mode: "ssg" })
  .head(() => ({ meta: [{ title: "路由组 · mh-p" }] }))
  .page(() => <RoutesPage />)

export function RoutesPage() {
  const confirm = useConfirm()
  const groups = useResource<RouteGroupListResponse>(
    "routes:groups",
    (signal) => unwrap(eden.api["route-groups"].get({ fetch: { signal } })),
    { pollMs: 30_000 },
  )
  const items = useMemo(() => groups.data?.items ?? [], [groups.data])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<RouteGroup | null>(null)

  useEffect(() => {
    if (items.length === 0) {
      setSelectedId(null)
      return
    }
    if (!selectedId || !items.some((item) => item.id === selectedId)) setSelectedId(items[0]!.id)
  }, [items, selectedId])

  const selected = items.find((item) => item.id === selectedId) ?? null

  const connection = useResource<RouteGroupConnection>(
    `routes:conn:${selectedId ?? "none"}`,
    (signal) => unwrap(eden.api["route-groups"]({ id: selectedId! }).connection.get({ fetch: { signal } })),
    { enabled: !!selectedId },
  )

  const rotate = useAction(async () => {
    if (!selectedId) return
    await unwrap(eden.api["route-groups"]({ id: selectedId }).rotate.post())
    toast.success("已轮换组密码，旧连接串立即失效")
    groups.refresh()
    connection.refresh()
  })

  const removeGroup = async (group: RouteGroup) => {
    await confirm({
      title: "删除路由组？",
      description: "删除后使用该组 ID 的客户端将无法再接入。",
      details: <span className="font-mono">{group.id}</span>,
      destructive: true,
      confirmText: "删除",
      action: async () => {
        await unwrap(eden.api["route-groups"]({ id: group.id }).delete())
        toast.success("路由组已删除")
        if (selectedId === group.id) setSelectedId(null)
        groups.refresh()
      },
    })
  }

  const openCreate = () => {
    setEditing(null)
    setDialogOpen(true)
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="路由组"
        description="按国家字段正则聚合节点；客户端用组 ID 接入，可在均衡平均与固定一个直到失败之间选择。"
        updatedAt={groups.updatedAt}
        onRefresh={groups.refresh}
        refreshing={groups.refreshing}
        actions={
          <LoadingButton onClick={openCreate} size="sm">
            <Plus data-icon="inline-start" />
            新建路由组
          </LoadingButton>
        }
      />

      {groups.error && !groups.data ? (
        <ErrorState error={groups.error} onRetry={groups.refresh} />
      ) : groups.loading && !groups.data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="h-48 animate-pulse rounded-xl border bg-muted/30" />
          <div className="h-48 animate-pulse rounded-xl border bg-muted/30" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Waypoints}
          title="还没有路由组"
          description="路由组把一批符合国家正则的节点聚合为一个接入端点，客户端用组 ID 作为用户名连接。"
          action={
            <LoadingButton onClick={openCreate} size="sm">
              <Plus data-icon="inline-start" />
              新建第一个路由组
            </LoadingButton>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <SectionCard title="全部路由组" description={`${items.length} 个组`}>
            <div className="flex flex-col gap-2">
              {items.map((item) => {
                const active = item.id === selectedId
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={
                      "flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors " +
                      (active ? "border-primary bg-primary/5" : "hover:bg-muted/50")
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{item.name}</span>
                      {item.enabled ? (
                        <Badge variant="outline">启用</Badge>
                      ) : (
                        <Badge variant="secondary">停用</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{item.id}</span>
                      <span>·</span>
                      <span>{balanceModeLabel(item.balanceMode)}</span>
                      <span>·</span>
                      <span>{item.memberCount} 个节点</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </SectionCard>

          {selected ? (
            <div className="flex flex-col gap-4">
              <SectionCard
                title={selected.name}
                description={`组 ID：${selected.id}`}
                actions={
                  <>
                    <LoadingButton
                      variant="outline"
                      size="sm"
                      loading={rotate.pending}
                      loadingText="轮换中…"
                      onClick={() => void rotate.run().catch((error) => toast.error("轮换失败", { description: describeError(error) }))}
                    >
                      <RotateCcw data-icon="inline-start" />
                      轮换密码
                    </LoadingButton>
                    <LoadingButton
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(selected)
                        setDialogOpen(true)
                      }}
                    >
                      <Pencil data-icon="inline-start" />
                      编辑
                    </LoadingButton>
                    <LoadingButton variant="outline" size="sm" onClick={() => void removeGroup(selected)}>
                      <Trash2 data-icon="inline-start" />
                      删除
                    </LoadingButton>
                  </>
                }
              >
                <div className="flex flex-col gap-4">
                  <InfoGrid
                    columns={2}
                    items={[
                      { label: "国家正则", value: <code className="font-mono text-xs">{selected.countryRegex}</code> },
                      { label: "IP 均衡", value: balanceModeLabel(selected.balanceMode) },
                      { label: "匹配节点", value: selected.memberCount },
                      { label: "状态", value: selected.enabled ? "启用" : "停用" },
                    ]}
                  />
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">成员节点</p>
                    {selected.members.length === 0 ? (
                      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                        当前没有匹配到已上线的节点。检查国家正则，或确认节点已发布到槽位。
                      </p>
                    ) : (
                      <div className="divide-y rounded-md border">
                        {selected.members.map((member) => (
                          <div key={member.nodeId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                            <span className="font-mono">{member.nodeId}</span>
                            <span className="text-xs text-muted-foreground">{member.country ?? "-"}</span>
                            <span className="text-xs text-muted-foreground">:{member.port}</span>
                            <span className="ml-auto flex items-center gap-1.5">
                              {member.current ? <Badge variant="outline">当前</Badge> : null}
                              {member.coolingUntil && member.coolingUntil > Date.now() ? (
                                <Badge variant="destructive">冷却至 {fmtTime(member.coolingUntil)}</Badge>
                              ) : null}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="接入连接串" description="用户名 = 组 ID，密码 = 组凭据；修改后请重新复制。">
                {connection.error ? (
                  <ErrorState error={connection.error} onRetry={connection.refresh} compact />
                ) : connection.loading && !connection.data ? (
                  <div className="h-24 animate-pulse rounded-md border bg-muted/30" />
                ) : connection.data ? (
                  <Tabs defaultValue="http" className="gap-3">
                    <TabsList>
                      <TabsTrigger value="http">HTTP</TabsTrigger>
                      <TabsTrigger value="socks5">SOCKS5</TabsTrigger>
                      <TabsTrigger value="curl">curl</TabsTrigger>
                      <TabsTrigger value="env">环境变量</TabsTrigger>
                      <TabsTrigger value="clash">Clash</TabsTrigger>
                    </TabsList>
                    <TabsContent value="http">
                      <CodeBlock code={connection.data.http} language="HTTP 代理" wrap maxHeight={120} />
                    </TabsContent>
                    <TabsContent value="socks5">
                      <CodeBlock code={connection.data.socks5} language="SOCKS5 代理" wrap maxHeight={120} />
                    </TabsContent>
                    <TabsContent value="curl">
                      <CodeBlock code={connection.data.curl} language="curl" wrap maxHeight={120} />
                    </TabsContent>
                    <TabsContent value="env">
                      <CodeBlock code={connection.data.env} language="shell" maxHeight={160} />
                    </TabsContent>
                    <TabsContent value="clash">
                      <CodeBlock code={connection.data.clash} language="yaml" maxHeight={200} />
                    </TabsContent>
                  </Tabs>
                ) : (
                  <EmptyState icon={RefreshCw} title="暂无连接串" description="刷新后重试。" compact />
                )}
              </SectionCard>
            </div>
          ) : (
            <SectionCard title="选择一个路由组" description="左侧选择路由组后查看成员与连接串。">
              <EmptyState icon={Waypoints} title="未选择" compact />
            </SectionCard>
          )}
        </div>
      )}

      <RouteGroupDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        group={editing}
        onSaved={() => groups.refresh()}
      />
    </div>
  )
}
