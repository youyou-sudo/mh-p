/**
 * 订阅表 → Mihomo proxy-providers 渲染（纯函数）。
 *
 * **一律 type: file**。这条是切流时按实测改的，不要退回 http：
 *   sync 已经把每个订阅解析、转成 Clash proxy、写成 <engineDir>/providers/<subId>.yaml，
 *   然后 PUT /providers/proxies/sub-<id> 热加载。代理名由面板生成（n-<nodeId>），
 *   只有"文件由面板写"这个前提下名字才可控。
 *   若渲染成 type: http，Mihomo 会自己按 interval 重拉订阅：
 *     · provider 里是订阅**原名**，与 nodes.proxy_name（n-<nodeId>）对不上 →
 *       /providers 回读匹配不到任何节点，整订阅被判"无观测数据"，节点数直接变 0；
 *     · 拉取走引擎自己的网络栈（provider 的 proxy 要显式 DIRECT，否则会走代理链，代理挂→EOF）；
 *     · 面板的逐条容错也全部失效——Clash 解析是"全或无"，一条坏节点让整份变 0 条。
 *   所以 http 分支已删除：普通 URL + Clash 格式的订阅同样由面板拉、面板转、面板写文件。
 *
 * 两个必须解释的约束（踩过坑）：
 *   1. path 必须落在 Mihomo 的 -d（data dir）下面：Mihomo 对相对路径是相对 -d 解析的，
 *      写绝对路径会在打包/换盘符后失效；面板只负责在 Mihomo 启动前把文件准备好。
 *   2. health-check.lazy 必须是 false：lazy=true 时只有"正在被使用"的节点才被测，
 *      隔离/未发布节点永远不会产生健康数据，面板的健康度与恢复逻辑就永远等不到事实。
 *      代价是 Mihomo 会周期性测全部节点，这正是我们要的（探测由数据面做）。
 */

import type { MihomoProviderSpec } from './config'
import { providerNameOf } from './config'

/** 订阅行里渲染 provider 需要的字段（DB 行多几个字段也能结构化传入） */
export interface MihomoProviderSub {
  id: string
  url: string
  format_hint: string
}

/** 写进 config.yaml 的 proxy-providers 条目（与 config.ts 的渲染结果保持一致） */
export interface MihomoProviderEntry {
  /** 恒为 file：见文件头 */
  type: 'file'
  /** 相对 Mihomo -d 目录的路径 */
  path: string
  'health-check': {
    enable: true
    url: string
    interval: number
    lazy: false
  }
}

export interface ProviderRenderOptions {
  /** provider 文件目录（相对 Mihomo -d），默认 providers */
  providerDir?: string
  /** 存活探测地址（沿用 detect.testUrl） */
  healthCheckUrl: string
  /** provider 健康检查间隔（秒），默认 300 */
  healthCheckIntervalSec?: number
}

const DEFAULT_PROVIDER_DIR = 'providers'
const DEFAULT_HEALTH_INTERVAL_SEC = 300

/** 订阅 ID → provider 文件路径（相对 -d；非法字符替换，避免 Windows 路径问题） */
export function providerFilePath(subscriptionId: string, providerDir = DEFAULT_PROVIDER_DIR): string {
  const safe = subscriptionId.replace(/[^A-Za-z0-9_.-]/g, '-')
  return providerDir.replace(/[/\\]+$/, '') + '/' + safe + '.yaml'
}

/**
 * 渲染成 config.ts 的 provider spec（给 renderMihomoConfig 直接使用）。
 * 排序保证同一输入产出逐字节相同的配置（对账/快照依赖稳定性）。
 */
export function renderProviderSpecs(
  subscriptions: MihomoProviderSub[],
  opts: ProviderRenderOptions,
): MihomoProviderSpec[] {
  const providerDir = opts.providerDir ?? DEFAULT_PROVIDER_DIR
  const healthInterval = opts.healthCheckIntervalSec ?? DEFAULT_HEALTH_INTERVAL_SEC
  const specs: MihomoProviderSpec[] = []

  for (const sub of subscriptions) {
    specs.push({
      name: providerNameOf(sub.id),
      type: 'file',
      path: providerFilePath(sub.id, providerDir),
      healthCheck: {
        url: opts.healthCheckUrl,
        intervalSec: healthInterval,
        // 见文件头约束 2：隔离/未发布节点也必须持续被测
        lazy: false,
      },
    })
  }
  return specs.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 渲染成可以直接铺进 config.yaml 的 proxy-providers 映射。
 * provider 名 = sub-<subscriptionId>（与 config.ts 的 providerNameOf 一致）。
 */
export function renderProviderEntries(
  subscriptions: MihomoProviderSub[],
  opts: ProviderRenderOptions,
): Record<string, MihomoProviderEntry> {
  const out: Record<string, MihomoProviderEntry> = {}
  for (const spec of renderProviderSpecs(subscriptions, opts)) {
    out[spec.name] = {
      type: 'file',
      path: spec.path,
      'health-check': {
        enable: true,
        url: spec.healthCheck?.url ?? opts.healthCheckUrl,
        interval: spec.healthCheck?.intervalSec ?? opts.healthCheckIntervalSec ?? DEFAULT_HEALTH_INTERVAL_SEC,
        lazy: false,
      },
    }
  }
  return out
}
