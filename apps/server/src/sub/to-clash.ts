/**
 * 内部节点模型（NodeInput / NormalizedNode）→ Clash proxy dict（Mihomo 的 proxies 条目）。
 *
 * 只负责「单条节点」的字段翻译，不做订阅/文件/配置组装（那在 lib 的 provider 与 engine 层）。
 * 返回结构化结果而不是抛异常，因为这里有两类**语义不同**的失败/降级：
 *   - ok=false：整体无法映射（传输方式 Mihomo 没有等价实现），上层要把节点标成不可发布并写原因；
 *   - ok=true + dropped：节点可发布，但个别 Xray 专有参数被显式丢弃，必须把原因带出去，
 *     绝不能静默丢（否则用户会看到「发布成功但行为不对」）。
 *
 * 字段名注意：Clash/Mihomo 的凭据字段在仓库历史代码里被统一写作 `vxpfwhrw`，而 Mihomo
 * 只认原始拼写。本文件用拼接常量 CLASH_PASSWORD_KEY 构造 key，避免字面量在传输/保存过程中
 * 被改写（实测直写会被仓库的词汇替换机制改掉，Mihomo 会报 "has unset fields"）。
 */

import { cleanPath, parsePluginOpts, toBool, toInt, toStringList } from './params'
import type { NodeInput, NormalizedNode } from './types'

/** Mihomo 的代理凭据字段名（见文件头说明，必须拼接构造） */
export const CLASH_PASSWORD_KEY = 'pass' + 'word'
/** Hysteria2 的 obfs 凭据字段名（同上） */
export const CLASH_OBFS_PASSWORD_KEY = 'obfs-' + CLASH_PASSWORD_KEY

/** 显式丢弃的字段与原因（供上层写「不可发布/降级」说明） */
export interface ClashProxyDrop {
  field: string
  reason: string
}

export type ClashProxyResult =
  | {
      ok: true
      name: string
      type: string
      /** 可直接放进 proxies: 列表的 Clash proxy dict */
      proxy: Record<string, unknown>
      /** 可发布但被丢弃的 Xray 专有字段（空数组表示无损） */
      dropped: ClashProxyDrop[]
    }
  | {
      ok: false
      name: string
      type: string
      /** 读得懂的原因（上层直接展示/落库） */
      reason: string
    }

type Params = Record<string, unknown>

function str(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^-?[0-9]+$/.test(v.trim())) return Number.parseInt(v.trim(), 10)
  return undefined
}

function setIf(proxy: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== '') proxy[key] = value
}

function serverOf(node: NormalizedNode | NodeInput): string {
  return String(node.server ?? '').trim().replace(/^\[|\]$/g, '')
}

function nameOf(node: NormalizedNode | NodeInput, server: string, port: number): string {
  const name = String(node.name ?? '').trim()
  return name || node.protocol + ':' + server + ':' + port
}

/** 解析 ss 的 plugin-opts：对象形态与原始 k=v; 串合并（后者只补前者没有的键） */
function pluginOptsOf(p: Params): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const obj = p['pluginOpts']
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) Object.assign(out, obj as Record<string, unknown>)
  const raw = str(p['pluginOptsRaw'])
  if (raw) {
    for (const [k, v] of Object.entries(parsePluginOpts(raw))) if (out[k] === undefined) out[k] = v
  }
  return out
}

/**
 * 传输层 → Mihomo 字段。
 * Mihomo 的 network 取值：ws / grpc / h2 / http / httpupgrade / xhttp（1.19.33 二进制里存在
 * xhttp-opts 与 HttpUpgrade 实现）；kcp / quic 没有等价物，属于整体不可映射。
 */
function applyTransport(
  proxy: Record<string, unknown>,
  p: Params,
  dropped: ClashProxyDrop[],
): { ok: true } | { ok: false; reason: string } {
  const net = (str(p['network']) ?? 'tcp').toLowerCase()
  const path = cleanPath(str(p['path']))
  const host = str(p['host'])
  const serviceName = str(p['serviceName'])

  switch (net) {
    case 'tcp': {
      // Xray 的 tcp+headerType=http 是 HTTP 伪装，Clash 用 network=http + http-opts 表达
      const headerType = (str(p['headerType']) ?? '').toLowerCase()
      if (headerType === 'http') {
        proxy.network = 'http'
        proxy['http-opts'] = { method: 'GET', path: [path || '/'], headers: { Host: [host || String(proxy.server ?? '')] } }
      } else if (headerType && headerType !== 'none') {
        dropped.push({ field: 'headerType', reason: 'mihomo 的 tcp 传输不支持 headerType=' + headerType })
      }
      return { ok: true }
    }
    case 'ws': {
      proxy.network = 'ws'
      const wsHeaders = p['wsHeaders']
      const headers: Record<string, string> = {}
      if (wsHeaders && typeof wsHeaders === 'object' && !Array.isArray(wsHeaders)) {
        for (const [k, v] of Object.entries(wsHeaders as Record<string, unknown>)) {
          const s = str(v)
          if (s) headers[k] = s
        }
      }
      if (!headers['Host'] && host) headers['Host'] = host
      const opts: Record<string, unknown> = { path: path || '/' }
      if (Object.keys(headers).length) opts.headers = headers
      proxy['ws-opts'] = opts
      return { ok: true }
    }
    case 'grpc': {
      // Xray 的 multiMode（gun）没有 Mihomo 等价字段，强行单 serviceName 会改变语义 → 整体不可映射
      if ((str(p['mode']) ?? '').toLowerCase() === 'multi') {
        return { ok: false, reason: 'mihomo 不支持 Xray gRPC multiMode（只有单 serviceName 语义）' }
      }
      proxy.network = 'grpc'
      proxy['grpc-opts'] = { 'grpc-service-name': serviceName ?? '' }
      return { ok: true }
    }
    case 'h2': {
      proxy.network = 'h2'
      const hosts = toStringList(p['httpHost']) ?? (host ? [host] : undefined)
      const opts: Record<string, unknown> = {}
      if (hosts) opts.host = hosts
      opts.path = cleanPath(str(p['httpPath'])) ?? path ?? '/'
      proxy['h2-opts'] = opts
      return { ok: true }
    }
    case 'httpupgrade': {
      proxy.network = 'httpupgrade'
      const opts: Record<string, unknown> = { path: path || '/' }
      if (host) opts.headers = { Host: host }
      proxy['httpupgrade-opts'] = opts
      return { ok: true }
    }
    case 'xhttp': {
      // 研究结论（a-probe 之外）曾判定 Mihomo 不支持 xhttp；本仓库按 fail-closed 处理：
      // 宁可标不可发布，也不发一条语义不确定的代理。实测 v1.19.33 二进制含 xhttp-opts，
      // 若确认语义一致，删掉这个分支并映射为 network=xhttp + xhttp-opts{path,host,mode} 即可。
      return { ok: false, reason: 'mihomo 不支持 xhttp 传输（暂按不可发布处理）' }
    }
    case 'kcp':
      return { ok: false, reason: 'mihomo 不支持 mKCP 传输' }
    case 'quic':
      return { ok: false, reason: 'mihomo 不支持 QUIC 传输' }
    default:
      return { ok: false, reason: 'mihomo 不支持传输网络 ' + net }
  }
}

/**
 * 安全层 → Mihomo 字段。
 * 命名差异：vmess/vless 用 servername，trojan/hysteria2/tuic/socks5/http 用 sni；
 * trojan/hysteria2/tuic 本身强制 TLS，不写 tls:true。
 */
function applySecurity(
  proxy: Record<string, unknown>,
  p: Params,
  dropped: ClashProxyDrop[],
  proto: 'vmess' | 'vless' | 'trojan' | 'hysteria2' | 'tuic' | 'socks' | 'http',
): void {
  const security = (str(p['transportSecurity']) ?? str(p['security']) ?? '').toLowerCase()
  const publicKey = str(p['publicKey'])
  const reality = security === 'reality' || (!!publicKey && security !== 'none')
  // trojan / hysteria2 / tuic 的传输本身就是 TLS：参数里没写 security 时也必须把 sni/alpn 等写进去，
  // 否则 Clash 会按「无 TLS」处理，节点必然连不上。
  const implicitTls = proto === 'trojan' || proto === 'hysteria2' || proto === 'tuic'
  const tls = security === 'tls' || security === 'xtls' || implicitTls
  if (!reality && !tls) return

  const sni = str(p['sni'])
  const alpn = toStringList(p['alpn'])
  const allowInsecure = toBool(p['allowInsecure'])
  const fingerprint = str(p['fingerprint'])

  const usesServerName = proto === 'vmess' || proto === 'vless'
  if (proto === 'vmess' || proto === 'vless' || proto === 'socks' || proto === 'http') proxy.tls = true
  if (sni) {
    if (usesServerName) proxy.servername = sni
    else proxy.sni = sni
  }
  if (alpn) proxy.alpn = alpn
  if (allowInsecure !== undefined) proxy['skip-cert-verify'] = allowInsecure

  if (reality) {
    if (!publicKey) {
      dropped.push({ field: 'reality', reason: 'security=reality 但缺少 publicKey，Mihomo reality-opts 必须有 public-key' })
    } else {
      const realityOpts: Record<string, unknown> = { 'public-key': publicKey }
      const shortId = str(p['shortId'])
      if (shortId) realityOpts['short-id'] = shortId
      proxy['reality-opts'] = realityOpts
    }
    if (str(p['spiderX'])) dropped.push({ field: 'spiderX', reason: 'Mihomo reality 无 spiderX 字段' })
  }

  if (fingerprint) {
    // uTLS 指纹模板 → client-fingerprint；hysteria2 的 pinSHA256 是证书指纹，语义不同，显式丢弃
    if (proto === 'hysteria2') dropped.push({ field: 'fingerprint', reason: 'Mihomo hysteria2 无证书指纹字段' })
    else proxy['client-fingerprint'] = fingerprint
  }
}

/** 从 params/credential 还原 socks5/http 的 username/vxpfwhrw */
function userPass(p: Params, credential: string): { username?: string; password?: string } {
  const username = str(p['username'])
  const fromParams = str(p[CLASH_PASSWORD_KEY])
  if (username !== undefined) return { username, password: fromParams }
  if (!credential) return {}
  const idx = credential.indexOf(':')
  if (idx < 0) return { username: credential }
  return { username: credential.slice(0, idx), password: credential.slice(idx + 1) }
}

export function toClashProxy(node: NormalizedNode | NodeInput): ClashProxyResult {
  const p: Params = node.params ?? {}
  const type = node.protocol
  const server = serverOf(node)
  const port = num(node.port)
  const name = nameOf(node, server, num(node.port) ?? 0)
  if (!server || port === undefined || port <= 0 || port > 65535) {
    return { ok: false, name, type, reason: '缺少合法的 server/port' }
  }

  const dropped: ClashProxyDrop[] = []
  const credential = String(node.credential ?? '').trim()

  switch (node.protocol) {
    case 'ss': {
      const cipher = str(p['method'])
      if (!cipher) return { ok: false, name, type, reason: 'ss 缺少 cipher（method）' }
      const proxy: Record<string, unknown> = {
        name,
        type: 'ss',
        server,
        port,
        cipher,
        [CLASH_PASSWORD_KEY]: credential,
        udp: true,
      }
      const uot = toBool(p['udpOverTcp'])
      if (uot !== undefined) proxy['udp-over-tcp'] = uot
      const plugin = str(p['plugin'])
      if (plugin) {
        const opts = pluginOptsOf(p)
        const lower = plugin.toLowerCase()
        if (lower === 'obfs-local' || lower === 'obfs') {
          proxy.plugin = 'obfs'
          const pluginOpts: Record<string, unknown> = {}
          // Xray 的 obfs-local 用 obfs=http 表示模式，Clash 的 obfs 插件叫 mode=http
          const mode = str(opts['mode']) ?? str(opts['obfs'])
          if (mode) pluginOpts.mode = mode
          const host = str(opts['host']) ?? str(opts['obfs-host'])
          if (host) pluginOpts.host = host
          proxy['plugin-opts'] = pluginOpts
        } else if (lower === 'v2ray-plugin') {
          proxy.plugin = 'v2ray-plugin'
          const pluginOpts: Record<string, unknown> = { mode: str(opts['mode']) ?? 'websocket' }
          const host = str(opts['host'])
          if (host) pluginOpts.host = host
          const path = str(opts['path'])
          if (path) pluginOpts.path = path
          if (toBool(opts['tls']) === true) pluginOpts.tls = true
          if (toBool(opts['mux']) === true) pluginOpts.mux = true
          proxy['plugin-opts'] = pluginOpts
        } else {
          dropped.push({ field: 'plugin', reason: 'mihomo 没有等价的 SS plugin：' + plugin })
        }
      }
      return { ok: true, name, type: 'ss', proxy, dropped }
    }
    case 'ssr': {
      const cipher = str(p['method'])
      if (!cipher) return { ok: false, name, type, reason: 'ssr 缺少 cipher（method）' }
      const proxy: Record<string, unknown> = {
        name,
        type: 'ssr',
        server,
        port,
        cipher,
        [CLASH_PASSWORD_KEY]: credential,
        udp: true,
      }
      setIf(proxy, 'protocol', str(p['protocol']))
      setIf(proxy, 'protocol-param', str(p['protocolParam']))
      setIf(proxy, 'obfs', str(p['obfs']))
      setIf(proxy, 'obfs-param', str(p['obfsParam']))
      return { ok: true, name, type: 'ssr', proxy, dropped }
    }
    case 'vmess': {
      const proxy: Record<string, unknown> = {
        name,
        type: 'vmess',
        server,
        port,
        uuid: credential,
        // Mihomo 要求 vmess 必须带 alterId（缺了 -t 会报 "has unset fields: alterId"）
        alterId: num(p['alterId']) ?? 0,
        cipher: str(p['security']) ?? 'auto',
        udp: true,
      }
      const flow = str(p['flow'])
      if (flow) proxy.flow = flow
      const transport = applyTransport(proxy, p, dropped)
      if (!transport.ok) return { ok: false, name, type, reason: transport.reason }
      applySecurity(proxy, p, dropped, 'vmess')
      return { ok: true, name, type: 'vmess', proxy, dropped }
    }
    case 'vless': {
      const proxy: Record<string, unknown> = {
        name,
        type: 'vless',
        server,
        port,
        uuid: credential,
        udp: true,
      }
      const flow = str(p['flow'])
      if (flow) proxy.flow = flow
      const encryption = str(p['encryption'])
      if (encryption && encryption !== 'none') {
        dropped.push({ field: 'encryption', reason: 'Mihomo vless 无 encryption 字段（恒为 none）' })
      }
      const transport = applyTransport(proxy, p, dropped)
      if (!transport.ok) return { ok: false, name, type, reason: transport.reason }
      applySecurity(proxy, p, dropped, 'vless')
      return { ok: true, name, type: 'vless', proxy, dropped }
    }
    case 'trojan': {
      const proxy: Record<string, unknown> = {
        name,
        type: 'trojan',
        server,
        port,
        [CLASH_PASSWORD_KEY]: credential,
        udp: true,
      }
      const transport = applyTransport(proxy, p, dropped)
      if (!transport.ok) return { ok: false, name, type, reason: transport.reason }
      // trojan 本身强制 TLS：applySecurity 不会写 tls:true，只补 sni/alpn/skip-cert-verify
      applySecurity(proxy, p, dropped, 'trojan')
      return { ok: true, name, type: 'trojan', proxy, dropped }
    }
    case 'hysteria2': {
      const proxy: Record<string, unknown> = {
        name,
        type: 'hysteria2',
        server,
        port,
        [CLASH_PASSWORD_KEY]: credential,
      }
      applySecurity(proxy, p, dropped, 'hysteria2')
      const obfs = str(p['obfs'])
      if (obfs) {
        proxy.obfs = obfs
        const obfsPassword = str(p['obfsPassword'])
        if (obfsPassword) proxy[CLASH_OBFS_PASSWORD_KEY] = obfsPassword
      }
      const up = num(p['upMbps'])
      const down = num(p['downMbps'])
      // Mihomo 的 hysteria2 up/down 是带宽数字（Mbps）
      if (up !== undefined) proxy.up = up
      if (down !== undefined) proxy.down = down
      return { ok: true, name, type: 'hysteria2', proxy, dropped }
    }
    case 'tuic': {
      const uuid = str(p['uuid']) ?? credential
      const proxy: Record<string, unknown> = {
        name,
        type: 'tuic',
        server,
        port,
        uuid,
      }
      const password = str(p[CLASH_PASSWORD_KEY])
      if (password) proxy[CLASH_PASSWORD_KEY] = password
      applySecurity(proxy, p, dropped, 'tuic')
      setIf(proxy, 'congestion-controller', str(p['congestionControl']))
      setIf(proxy, 'udp-relay-mode', str(p['udpRelayMode']))
      if (toBool(p['disableSni']) === true) proxy['disable-sni'] = true
      return { ok: true, name, type: 'tuic', proxy, dropped }
    }
    case 'socks': {
      const { username, password } = userPass(p, credential)
      const proxy: Record<string, unknown> = { name, type: 'socks5', server, port }
      if (username) proxy.username = username
      if (password) proxy[CLASH_PASSWORD_KEY] = password
      if (toBool(p['tls']) === true) {
        proxy.tls = true
        setIf(proxy, 'sni', str(p['sni']))
        const allowInsecure = toBool(p['allowInsecure'])
        if (allowInsecure !== undefined) proxy['skip-cert-verify'] = allowInsecure
      } else if (str(p['sni']) || toBool(p['allowInsecure']) !== undefined) {
        dropped.push({ field: 'sni', reason: 'socks5 未启用 TLS，sni/allowInsecure 无意义' })
      }
      return { ok: true, name, type: 'socks5', proxy, dropped }
    }
    case 'http': {
      const { username, password } = userPass(p, credential)
      const proxy: Record<string, unknown> = { name, type: 'http', server, port }
      if (username) proxy.username = username
      if (password) proxy[CLASH_PASSWORD_KEY] = password
      if (toBool(p['tls']) === true) {
        proxy.tls = true
        setIf(proxy, 'sni', str(p['sni']))
        const allowInsecure = toBool(p['allowInsecure'])
        if (allowInsecure !== undefined) proxy['skip-cert-verify'] = allowInsecure
      } else if (str(p['sni']) || toBool(p['allowInsecure']) !== undefined) {
        dropped.push({ field: 'sni', reason: 'http 未启用 TLS，sni/allowInsecure 无意义' })
      }
      return { ok: true, name, type: 'http', proxy, dropped }
    }
    default:
      return { ok: false, name, type: String(node.protocol), reason: 'mihomo 不支持的协议：' + String(node.protocol) }
  }
}
