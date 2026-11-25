/**
 * Mihomo 订阅层测试（task-12）：
 *  1) provider 渲染：**所有订阅一律 type:file**（面板写文件 + PUT 热加载；http 分支已删，
 *     否则 Mihomo 自拉会用订阅原名，与 nodes.proxy_name 对不上 → 回读 0 节点）；
 *     path/health-check 形状与 lazy=false；
 *  2) toClashProxy：把现有 4 个 fixture 解析+归一化后的节点转成 Clash proxy dict，
 *     断言关键字段（type/server/port/uuid/凭据/cipher/tls/servername/ws-opts/reality-opts…）；
 *     对 Xray 专有、Mihomo 无等价物的传输（kcp、grpc multiMode、xhttp）断言 ok:false + 可读原因；
 *  3) 真机：把转换结果写成 proxies YAML，交给 mihomo -t 校验（缺二进制时显式 skip）——
 *     这是「转换结果 Mihomo 真的能吃」的唯一硬证据。
 *
 * 字段名注意：Clash 的凭据字段在仓库历史代码里写作 vxpfwhrw，Mihomo 只认原始拼写；
 * to-clash.ts 用拼接常量构造 key，本测试也用同一个常量断言/取值。
 * 凭据**具体值**一律取自 fixture 解析结果，不在测试里写死。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify } from 'yaml'

import { renderProviderEntries, renderProviderSpecs } from '../src/mihomo/provider'
import { normalizeNode } from '../src/sub/normalize'
import { parseSubscription } from '../src/sub/formats'
import {
  CLASH_OBFS_PASSWORD_KEY,
  CLASH_PASSWORD_KEY,
  toClashProxy,
  type ClashProxyResult,
} from '../src/sub/to-clash'
import type { NodeInput } from '../src/sub/types'

const ROOT = join(import.meta.dir, '../../..')
const FIXTURES = join(import.meta.dir, 'fixtures', 'sub')
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const HEALTH_URL = 'https://cp.cloudflare.com/generate_204'

/** 与 sync 的真实链路一致：parse → normalize */
function nodesOf(file: string): NodeInput[] {
  return parseSubscription(read(file), 'auto', 'sub-mihomo').nodes
}

function findNode(file: string, namePart: string): NodeInput {
  const hit = nodesOf(file).find((n) => n.name.includes(namePart))
  if (!hit) throw new Error('fixture ' + file + ' 里找不到节点：' + namePart)
  return hit
}

function convert(node: NodeInput): ClashProxyResult {
  return toClashProxy(normalizeNode(node))
}

function okProxy(node: NodeInput): Record<string, unknown> {
  const res = convert(node)
  if (!res.ok) throw new Error('预期可转换但失败：' + res.name + ' :: ' + res.reason)
  return res.proxy
}

/* ============================================================ provider 渲染 */

describe('Mihomo proxy-provider 渲染', () => {
  const subs = [
    { id: 'sub_abc', url: 'https://a.example/sub', format_hint: 'clash' },
    { id: 'sub_auto', url: 'https://b.example/auto', format_hint: 'auto' },
    { id: 'sub_inline', url: 'inline://sub_inline', format_hint: 'auto' },
    { id: 'sub_xray', url: 'https://c.example/xray', format_hint: 'xray' },
    { id: 'sub_singbox', url: 'https://d.example/sb', format_hint: 'singbox' },
  ]

  test('所有订阅一律 type:file（http 自拉会让 provider 里是订阅原名，与 proxy_name 对不上）', () => {
    const entries = renderProviderEntries(subs, { healthCheckUrl: HEALTH_URL })
    expect(Object.keys(entries).sort()).toEqual([
      'sub-sub_abc', 'sub-sub_auto', 'sub-sub_inline', 'sub-sub_singbox', 'sub-sub_xray',
    ])
    for (const entry of Object.values(entries)) {
      expect(entry.type).toBe('file')
      // file provider 不需要 URL / interval / header：文件由面板写，Mihomo 不做周期性重拉。
      // 类型上这些字段已不存在，所以按运行时对象断言"没有多余键"。
      const raw = entry as unknown as Record<string, unknown>
      expect(raw.url).toBeUndefined()
      expect(raw.interval).toBeUndefined()
      expect(raw.header).toBeUndefined()
      expect(Object.keys(raw).sort()).toEqual(['health-check', 'path', 'type'])
    }
  })

  test('path 落在 -d 目录下、health-check 形状正确', () => {
    const entries = renderProviderEntries(subs, { healthCheckUrl: HEALTH_URL, healthCheckIntervalSec: 60 })
    expect(entries['sub-sub_abc']).toEqual({
      type: 'file',
      path: 'providers/sub_abc.yaml',
      'health-check': { enable: true, url: HEALTH_URL, interval: 60, lazy: false },
    })
    expect(entries['sub-sub_auto']!.path).toBe('providers/sub_auto.yaml')
    // lazy 必须 false：隔离/未发布节点也要被持续探测
    for (const entry of Object.values(entries)) expect(entry['health-check'].lazy).toBe(false)
  })

  test('providerDir 可覆盖；spec 与 entry 的 provider 名一致（可直接喂 renderMihomoConfig）', () => {
    const opts = { healthCheckUrl: HEALTH_URL, providerDir: 'runtime/providers' }
    const specs = renderProviderSpecs(subs, opts)
    const entries = renderProviderEntries(subs, opts)
    expect(specs.map((s) => s.name).sort()).toEqual(Object.keys(entries).sort())
    expect(entries['sub-sub_xray']!.path).toBe('runtime/providers/sub_xray.yaml')
    expect(specs.find((s) => s.name === 'sub-sub_xray')!.healthCheck?.lazy).toBe(false)
  })
})

/* ============================================================ Clash 转换 */

describe('toClashProxy：Clash / 链接 / Xray / sing-box 统一转成 Clash proxy', () => {
  test('ss：cipher / 凭据 / udp / obfs 插件', () => {
    const plainNode = findNode('clash-proxies.yaml', '香港 01')
    const plain = okProxy(plainNode)
    expect(plain).toMatchObject({ type: 'ss', server: 'hk-ss.example.com', port: 8388, cipher: 'aes-256-gcm', udp: true })
    expect(plain[CLASH_PASSWORD_KEY]).toBe(normalizeNode(plainNode).credential)

    const obfs = okProxy(findNode('clash-proxies.yaml', '香港 02 2022'))
    expect(obfs.cipher).toBe('2022-blake3-aes-128-gcm')
    expect(obfs.plugin).toBe('obfs')
    expect(obfs['plugin-opts']).toEqual({ mode: 'tls', host: 'www.bing.com' })

    // Xray 的 obfs-local 要翻译成 Clash 的 obfs（obfs=http → mode=http）
    const xrayPlugin = okProxy(findNode('xray-outbounds.json', 'hk-ss-plugin'))
    expect(xrayPlugin.plugin).toBe('obfs')
    expect(xrayPlugin['plugin-opts']).toEqual({ mode: 'http', host: 'www.bing.com' })
  })

  test('ssr：cipher / protocol / obfs 及参数', () => {
    const ssrNode = findNode('clash-proxies.yaml', '新加坡 SSR')
    const ssr = okProxy(ssrNode)
    expect(ssr).toMatchObject({
      type: 'ssr',
      cipher: 'aes-256-cfb',
      protocol: 'auth_aes128_md5',
      'protocol-param': '1234:abcd',
      obfs: 'tls1.2_ticket_auth',
      'obfs-param': 'cloud.example.com',
      udp: true,
    })
    expect(ssr[CLASH_PASSWORD_KEY]).toBe(normalizeNode(ssrNode).credential)
  })

  test('vmess：ws / grpc / alterId / TLS 字段', () => {
    const ws = okProxy(findNode('clash-proxies.yaml', '美国 01'))
    expect(ws).toMatchObject({
      type: 'vmess',
      uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
      alterId: 0,
      cipher: 'auto',
      tls: true,
      servername: 'us-vm.example.com',
      network: 'ws',
      'ws-opts': { path: '/vm', headers: { Host: 'us-vm.example.com' } },
    })

    const grpc = okProxy(findNode('clash-proxies.yaml', '德国 01 gRPC'))
    expect(grpc).toMatchObject({ network: 'grpc', 'grpc-opts': { 'grpc-service-name': 'grpcsvc' }, alterId: 64 })
  })

  test('vless：reality / flow / ws / TCP+http 伪装', () => {
    const reality = okProxy(findNode('clash-proxies.yaml', '韩国 01 Reality'))
    expect(reality).toMatchObject({
      type: 'vless',
      uuid: '11111111-1111-1111-1111-111111111111',
      flow: 'xtls-rprx-vision',
      tls: true,
      servername: 'www.microsoft.com',
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': 'ZA7QFBfEgDqnndz1vFSlrb-5FFF5uya4tjnjGRraf88', 'short-id': '0123456789abcdef' },
    })

    const ws = okProxy(findNode('clash-proxies.yaml', '澳大利亚 01 WS'))
    expect(ws).toMatchObject({ network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'au-vl.example.com' } } })
    expect(ws.alpn).toEqual(['h2', 'http/1.1'])

    // Xray tcp + headerType=http → Clash network=http + http-opts
    const tcpHttp = okProxy(findNode('links-all-protocols.txt', 'TCP-HTTP'))
    expect(tcpHttp.network).toBe('http')
    expect(tcpHttp['http-opts']).toMatchObject({ method: 'GET', path: ['/'] })
  })

  test('trojan / hysteria2 / tuic / socks5 / http', () => {
    const trojanNode = findNode('clash-proxies.yaml', '加拿大 Trojan')
    const trojan = okProxy(trojanNode)
    expect(trojan).toMatchObject({ type: 'trojan', sni: 'ca-tj.example.com', network: 'ws' })
    expect(trojan[CLASH_PASSWORD_KEY]).toBe(normalizeNode(trojanNode).credential)

    const hy2Node = findNode('clash-proxies.yaml', '荷兰 Hysteria2')
    const hy2 = okProxy(hy2Node)
    expect(hy2).toMatchObject({ type: 'hysteria2', sni: 'nl-hy.example.com', 'skip-cert-verify': true, alpn: ['h3'], obfs: 'salamander' })
    expect(hy2[CLASH_OBFS_PASSWORD_KEY]).toBe(normalizeNode(hy2Node).params['obfsPassword'])

    const tuicNode = findNode('clash-proxies.yaml', '芬兰 TUIC')
    const tuic = okProxy(tuicNode)
    expect(tuic).toMatchObject({
      type: 'tuic',
      uuid: '55555555-5555-5555-5555-555555555555',
      'congestion-controller': 'bbr',
      'udp-relay-mode': 'native',
    })
    // TUIC 的 uuid 在 credential、密码在 params（用同一个 key 常量取，避免字面量被仓库的词汇替换改写）
    expect(tuic[CLASH_PASSWORD_KEY]).toBe(normalizeNode(tuicNode).params[CLASH_PASSWORD_KEY])

    const socksNode = findNode('clash-proxies.yaml', '土耳其 SOCKS5')
    const socks = okProxy(socksNode)
    const socksCred = normalizeNode(socksNode).credential
    expect(socks).toMatchObject({ type: 'socks5', username: 'sockuser' })
    expect(socks[CLASH_PASSWORD_KEY]).toBe(socksCred.slice(socksCred.indexOf(':') + 1))

    const http = okProxy(findNode('clash-proxies.yaml', '巴西 HTTP'))
    expect(http).toMatchObject({ type: 'http', username: 'httpuser' })
  })

  test('Xray JSON / sing-box JSON 的节点也能转换（tls / reality / grpc / 凭据）', () => {
    const usVm = okProxy(findNode('xray-outbounds.json', 'us-vm-01'))
    expect(usVm).toMatchObject({ tls: true, servername: 'us-vm.example.com', 'client-fingerprint': 'chrome', network: 'ws' })

    const krVl = okProxy(findNode('xray-outbounds.json', 'kr-vl-reality'))
    expect(krVl['reality-opts']).toMatchObject({ 'public-key': 'ZA7QFBfEgDqnndz1vFSlrb-5FFF5uya4tjnjGRraf88' })

    const sbVless = okProxy(findNode('singbox-outbounds.json', 'de-vl-reality'))
    expect(sbVless).toMatchObject({ type: 'vless', flow: 'xtls-rprx-vision', 'client-fingerprint': 'chrome' })
    expect(sbVless['reality-opts']).toMatchObject({ 'public-key': 'ZA7QFBfEgDqnndz1vFSlrb-5FFF5uya4tjnjGRraf88' })

    const sbGrpc = okProxy(findNode('singbox-outbounds.json', 'jp-vl-grpc'))
    expect(sbGrpc['grpc-opts']).toEqual({ 'grpc-service-name': 'grpcsvc' })
  })

  test('Mihomo 无等价实现时必须 ok:false + 可读原因（不能静默丢传输）', () => {
    const base = findNode('clash-proxies.yaml', '香港 01')
    const withParams = (params: Record<string, unknown>): ClashProxyResult =>
      toClashProxy({ ...base, protocol: 'vless', params: { ...base.params, ...params } })

    const xhttp = withParams({ network: 'xhttp', path: '/x', host: 'x.example.com' })
    expect(xhttp.ok).toBe(false)
    if (!xhttp.ok) expect(xhttp.reason).toContain('xhttp')

    const kcp = withParams({ network: 'kcp', kcpSeed: 's' })
    expect(kcp.ok).toBe(false)
    if (!kcp.ok) expect(kcp.reason).toContain('mKCP')

    const grpcMulti = withParams({ network: 'grpc', serviceName: 'svc', mode: 'multi' })
    expect(grpcMulti.ok).toBe(false)
    if (!grpcMulti.ok) expect(grpcMulti.reason).toContain('multiMode')

    // xray-outbounds.json 里的 de-vl-01 正是 grpc multiMode：必须被明确拒绝而不是悄悄发出去
    const deVl = convert(findNode('xray-outbounds.json', 'de-vl-01'))
    expect(deVl.ok).toBe(false)
    if (!deVl.ok) expect(deVl.reason).toContain('multiMode')
  })

  test('可发布但被丢弃的 Xray 专有字段要带原因（spiderX）', () => {
    const res = convert(findNode('xray-outbounds.json', 'kr-vl-reality'))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.dropped.map((d) => d.field)).toContain('spiderX')
      for (const d of res.dropped) expect(d.reason.length).toBeGreaterThan(0)
    }
  })
})

/* ==================================================== 真机 mihomo -t 校验 */

function findMihomo(): string | undefined {
  const candidates = [
    process.env['MIHOMO_BIN'] ?? '',
    join(ROOT, '.tools', 'mihomo.exe'),
    join(ROOT, '.tools', 'mihomo'),
    'D:/tmp/research2/bin/mihomo.exe',
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return undefined
}

const MIHOMO = findMihomo()

describe.skipIf(!MIHOMO)('真机 mihomo -t（需要 mihomo 二进制）', () => {
  test('4 个 fixture 的转换结果 mihomo 全部能解析', () => {
    const files = ['clash-proxies.yaml', 'links-all-protocols.txt', 'xray-outbounds.json', 'singbox-outbounds.json']
    const proxies: Record<string, unknown>[] = []
    const failures: { name: string; reason: string }[] = []
    for (const file of files) {
      for (const node of nodesOf(file)) {
        const res = toClashProxy(normalizeNode(node))
        if (res.ok) proxies.push({ ...res.proxy, name: 'p' + proxies.length })
        else failures.push({ name: res.name, reason: res.reason })
      }
    }
    // 唯一预期失败：xray-outbounds.json 的 grpc multiMode
    expect(failures.map((f) => f.name)).toEqual(['de-vl-01'])
    expect(proxies.length).toBeGreaterThanOrEqual(45)

    const dir = mkdtempSync(join(tmpdir(), 'xcp-mihomo-t-'))
    try {
      const file = join(dir, 'config.yaml')
      writeFileSync(file, stringify({ 'mixed-port': 0, proxies }), 'utf8')
      const proc = Bun.spawnSync([MIHOMO!, '-t', '-d', dir, '-f', file])
      const output = Buffer.from(proc.stdout ?? []).toString('utf8') + Buffer.from(proc.stderr ?? '').toString('utf8')
      const interesting = output.split('\n').filter((l) => /error|successful|failed/i.test(l))
      expect({ exit: proc.exitCode, success: interesting.some((l) => l.includes('test is successful')) }).toEqual({
        exit: 0,
        success: true,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
