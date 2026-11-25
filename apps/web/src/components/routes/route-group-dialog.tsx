import { useEffect, useState } from "react"
import { Pencil, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { LoadingButton } from "@/components/common/loading-button"
import { describeError, eden, unwrap } from "@/lib/api"
import { useAction } from "@/lib/hooks"
import type { RouteBalanceMode, RouteGroup } from "./types"

interface RouteGroupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 传入 = 编辑；不传 = 新建 */
  group?: RouteGroup | null
  onSaved: () => void
}

interface FormErrors {
  name?: string
  id?: string
  countryRegex?: string
}

/** 新建 / 编辑路由组。 */
export function RouteGroupDialog({ open, onOpenChange, group, onSaved }: RouteGroupDialogProps) {
  const editing = !!group
  const [name, setName] = useState("")
  const [id, setId] = useState("")
  const [countryRegex, setCountryRegex] = useState("")
  const [balanceMode, setBalanceMode] = useState<RouteBalanceMode>("balanced")
  const [enabled, setEnabled] = useState(true)
  const [errors, setErrors] = useState<FormErrors>({})

  useEffect(() => {
    if (!open) return
    setName(group?.name ?? "")
    setId(group?.id ?? "")
    setCountryRegex(group?.countryRegex ?? "")
    setBalanceMode(group?.balanceMode ?? "balanced")
    setEnabled(group?.enabled ?? true)
    setErrors({})
  }, [open, group])

  const action = useAction(async () => {
    const nextErrors: FormErrors = {}
    if (!name.trim()) nextErrors.name = "请填写名称"
    if (!editing && id.trim() && !/^[A-Za-z0-9_.-]{2,32}$/.test(id.trim())) {
      nextErrors.id = "组 ID 只允许字母数字与 _.-（2-32 位）"
    }
    if (!countryRegex.trim()) nextErrors.countryRegex = "请填写国家正则"
    else {
      try {
        new RegExp(countryRegex.trim())
      } catch {
        nextErrors.countryRegex = "不是合法的正则表达式"
      }
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      throw new Error("请检查表单")
    }

    if (editing && group) {
      await unwrap(
        eden.api["route-groups"]({ id: group.id }).patch({
          name: name.trim(),
          countryRegex: countryRegex.trim(),
          balanceMode,
          enabled,
        }),
      )
      toast.success("路由组已更新")
    } else {
      await unwrap(
        eden.api["route-groups"].post({
          name: name.trim(),
          countryRegex: countryRegex.trim(),
          balanceMode,
          id: id.trim() || undefined,
        }),
      )
      toast.success("路由组已创建")
    }
    onSaved()
    onOpenChange(false)
  })

  return (
    <Dialog open={open} onOpenChange={(next) => (!action.pending ? onOpenChange(next) : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "编辑路由组" : "新建路由组"}</DialogTitle>
          <DialogDescription>
            组内节点由「国家字段正则」动态圈定；客户端用组 ID 作为用户名接入网关。
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="rg-name">名称</FieldLabel>
            <Input
              id="rg-name"
              value={name}
              placeholder="例如 香港节点池"
              aria-invalid={!!errors.name}
              onChange={(event) => {
                setName(event.target.value)
                setErrors((prev) => ({ ...prev, name: undefined }))
              }}
            />
            <FieldError>{errors.name}</FieldError>
          </Field>

          <Field data-invalid={!!errors.id}>
            <FieldLabel htmlFor="rg-id">组 ID（接入用户名）</FieldLabel>
            <Input
              id="rg-id"
              value={id}
              disabled={editing}
              placeholder="留空按名称自动生成，例如 hk-pool"
              aria-invalid={!!errors.id}
              onChange={(event) => {
                setId(event.target.value)
                setErrors((prev) => ({ ...prev, id: undefined }))
              }}
            />
            <FieldDescription>客户端连接网关时的用户名；创建后不可修改。</FieldDescription>
            <FieldError>{errors.id}</FieldError>
          </Field>

          <Field data-invalid={!!errors.countryRegex}>
            <FieldLabel htmlFor="rg-regex">国家正则</FieldLabel>
            <Input
              id="rg-regex"
              value={countryRegex}
              placeholder="例如 ^(HK|TW)$ 或 HK|JP"
              aria-invalid={!!errors.countryRegex}
              onChange={(event) => {
                setCountryRegex(event.target.value)
                setErrors((prev) => ({ ...prev, countryRegex: undefined }))
              }}
            />
            <FieldDescription>大小写不敏感，匹配节点的国家码（country_code）。</FieldDescription>
            <FieldError>{errors.countryRegex}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="rg-mode">IP 均衡模式</FieldLabel>
            <Select value={balanceMode} onValueChange={(value) => setBalanceMode(value as RouteBalanceMode)}>
              <SelectTrigger id="rg-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="balanced">均衡平均（轮询）</SelectItem>
                <SelectItem value="sticky">固定一个直到失败（失败冷却 10 分钟）</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {editing ? (
            <Field>
              <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <div className="space-y-0.5">
                  <FieldLabel htmlFor="rg-enabled">启用</FieldLabel>
                  <p className="text-xs text-muted-foreground">停用后该组不再接受新连接。</p>
                </div>
                <Switch id="rg-enabled" checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </Field>
          ) : null}
        </FieldGroup>

        {action.error ? (
          <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {describeError(action.error)}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={action.pending} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <LoadingButton
            loading={action.pending}
            loadingText={editing ? "保存中…" : "创建中…"}
            onClick={() => void action.run().catch(() => {})}
          >
            {editing ? <Pencil data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
            {editing ? "保存" : "创建"}
          </LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
