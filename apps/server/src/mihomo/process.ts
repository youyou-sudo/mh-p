/**
 * Mihomo 数据面进程托管。
 *
 * 与 Xray 版（apps/server/src/xray/process.ts）的分工相同：面板负责 spawn/监督子进程、
 * 崩溃时只**记录**不自动重启（是否重启由外层调度决定）；差别在于就绪判据来自
 * Clash 兼容 REST 的 `GET /version`，而不是 xray 的 `version` 子命令。
 *
 * 三条实测出来的纪律（v1.19.33，Windows/amd64）：
 *
 * 1. **就绪 = REST 能应答**。进程刚 spawn 时端口还没起来，所以 start() 是「spawn + 轮询
 *    client.version() 直到超时」，而不是「spawn 成功即 running」。
 * 2. **`-t` 会自动创建缺失的配置**。`mihomo -t -f <不存在的文件>` 会写出一份默认配置并
 *    打印 "test is successful"、exit 0（实测）。所以 testConfig() 先自己判 existsSync，
 *    否则「配置丢了」会被报成「配置合法」。start() 同样拦这一条，避免拿默认配置跑起来。
 * 3. **`-d` 目录会被创建**（`-t` 也会）。因此 dataDir 必须提前 mkdir，避免 cwd 依赖。
 */
import { existsSync, mkdirSync } from 'node:fs'
import type { MihomoClient } from './client'

/** 数据面退出/启动失败的归类，供外层决定是否重启与如何告警。 */
export type MihomoExitReason = 'stopped' | 'crash' | 'start-failed'

export interface MihomoProcStatus {
  /** 注意：启动失败记作 'crashed'（status 没有单独的 start-failed 态），用 lastExitReason 区分。 */
  status: 'stopped' | 'starting' | 'running' | 'crashed'
  pid: number | null
  version: string | null
  startedAt: number | null
  restarts: number
  lastExitReason: MihomoExitReason | null
  lastExitAt: number | null
}

export interface MihomoProcessOptions {
  /** mihomo 二进制路径（打包版通常是 DATA_DIR/bin/mihomo[.exe]） */
  binary: () => string
  /** 配置文件路径（-f） */
  configPath: () => string
  /** 配置/工作目录（-d）：cache.db、providers、geodata 都相对它 */
  dataDir: () => string
  /** 控制面客户端；process 只用它的 version() 做就绪探测 */
  client: MihomoClient
  /** 追加命令行参数（例如 -ext-ctl 覆盖 external-controller） */
  extraArgs?: () => string[]
  /** 就绪等待预算，默认 15s */
  readyTimeoutMs?: () => number
}

export interface MihomoTestResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

/** 日志环形缓冲上限（行）。面板「查看日志」只需要尾部，几十万行没有意义。 */
const MAX_LOG_LINES = 400
/** 就绪轮询间隔 */
const READY_POLL_MS = 120
/** 停机的默认优雅窗口 */
const STOP_TIMEOUT_MS = 5000
/** testConfig 的整体超时（大配置首次加载 geodata 会慢，但不应无限挂住面板） */
const TEST_TIMEOUT_MS = 30_000

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class MihomoProcess {
  private proc: Bun.Subprocess | null = null
  private stopping = false
  private everStarted = false
  private st: MihomoProcStatus = {
    status: 'stopped',
    pid: null,
    version: null,
    startedAt: null,
    restarts: 0,
    lastExitReason: null,
    lastExitAt: null,
  }
  /** 环形缓冲：已完整的行 */
  private lines: string[] = []
  /** 尚未换行的尾巴 */
  private partial = ''

  constructor(private opts: MihomoProcessOptions) {}

  private readyTimeoutMs(): number {
    const v = this.opts.readyTimeoutMs?.()
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 15_000
  }

  status(): MihomoProcStatus {
    return { ...this.st }
  }

  isRunning(): boolean {
    return this.st.status === 'running' && this.proc !== null
  }

  /**
   * 拉起引擎并等待 REST 就绪。
   * 失败时抛出的 Error 里**带进程最后一段输出**（stderr 常是唯一的线索，例如
   * "listener 0: unsupport proxy type" 或端口占用）。
   */
  async start(): Promise<{ version: string }> {
    if (this.proc) {
      if (this.st.version) return { version: this.st.version }
      throw new Error('Mihomo 正在启动中，不能重复 start()')
    }
    const binary = this.opts.binary()
    const configPath = this.opts.configPath()
    const dataDir = this.opts.dataDir()

    if (!binary || !existsSync(binary)) {
      this.failStart('二进制不存在：' + (binary || '(空)'))
    }
    // 见文件头纪律 2：配置缺失时 mihomo 会自己造一份默认配置并「成功」启动，
    // 那样面板会得到一个没有 listener、没有 external-controller 的假数据面。
    if (!existsSync(configPath)) {
      this.failStart('配置不存在：' + configPath)
    }
    try {
      mkdirSync(dataDir, { recursive: true })
    } catch (e) {
      this.failStart('无法创建数据目录 ' + dataDir + '：' + errText(e))
    }

    if (this.everStarted) this.st.restarts++
    this.everStarted = true

    const args = [binary, '-d', dataDir, '-f', configPath, ...(this.opts.extraArgs?.() ?? [])]
    this.st.status = 'starting'
    this.st.startedAt = Date.now()
    this.pushLine('[panel] spawn: ' + args.join(' '))

    let proc: Bun.Subprocess
    try {
      proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    } catch (e) {
      this.failStart('无法执行 ' + binary + '：' + errText(e))
    }
    this.proc = proc
    this.st.pid = proc.pid ?? null
    this.pipeLogs(proc)
    void proc.exited
      .then((code) => this.handleExit(proc, code))
      .catch(() => this.handleExit(proc, null))

    const deadline = Date.now() + this.readyTimeoutMs()
    let lastError = '未收到 /version 响应'
    while (Date.now() < deadline) {
      if (this.proc !== proc) {
        // 进程在就绪前就退出了：handleExit 已经写过日志，这里按「启动失败」收尾
        this.failStart('进程在就绪前退出（最后输出见下）')
      }
      try {
        const info = await this.opts.client.version()
        const version = typeof info?.version === 'string' ? info.version.trim() : ''
        if (version) {
          this.st.status = 'running'
          this.st.version = version
          this.pushLine('[panel] 就绪：version=' + version + ' pid=' + String(this.st.pid))
          return { version }
        }
        lastError = '/version 未返回 version 字段'
      } catch (e) {
        lastError = errText(e)
      }
      await sleep(READY_POLL_MS)
    }

    // 超时：把可能半死的进程收掉，避免留下一个占着端口的孤儿
    this.stopping = true
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
    await this.waitExit(proc, STOP_TIMEOUT_MS)
    this.proc = null
    this.st.pid = null
    this.stopping = false
    this.failStart('等待 REST 就绪超时（' + this.readyTimeoutMs() + 'ms）：' + lastError)
  }

  /** 优雅停止：先 SIGTERM，超时再强杀；无论哪条路径都清空引用与定时器。 */
  async stop(timeoutMs = STOP_TIMEOUT_MS): Promise<void> {
    const proc = this.proc
    this.stopping = true
    if (!proc) {
      this.st.status = 'stopped'
      this.st.pid = null
      this.st.lastExitReason = 'stopped'
      this.st.lastExitAt = Date.now()
      this.stopping = false
      return
    }
    try {
      proc.kill()
    } catch {
      /* 进程可能已经死了 */
    }
    const graceful = await this.waitExit(proc, timeoutMs)
    if (!graceful) {
      this.pushLine('[panel] ' + timeoutMs + 'ms 内未退出，强制 kill')
      try {
        proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      await this.waitExit(proc, 2000)
    }
    // 迟到的退出通知由 handleExit 的 this.proc !== proc 守卫吸收
    this.proc = null
    this.st.pid = null
    this.st.status = 'stopped'
    this.st.lastExitReason = 'stopped'
    this.st.lastExitAt = Date.now()
    this.pushLine('[panel] 已停止')
    this.stopping = false
  }

  /** 重启：停 → 起。注意不会重新渲染配置（那是调用方的事）。 */
  async restart(): Promise<{ version: string }> {
    await this.stop()
    return this.start()
  }

  /**
   * `mihomo -t -d <dataDir> -f <file>`：只做配置构建测试，不监听端口。
   * 退出码实测：成功 0（stdout 末行 "configuration file ... test is successful"），
   * 失败 1（"test failed" + stderr 里的 level=error）。
   */
  async testConfig(file: string): Promise<MihomoTestResult> {
    // 文件头纪律 2：不存在时 mihomo 会自动创建默认配置并返回成功，必须自己先拦。
    if (!existsSync(file)) {
      return {
        ok: false,
        code: -1,
        stdout: '',
        stderr:
          '配置文件不存在：' + file +
          '（已跳过 mihomo -t：它会把缺失的配置自动创建成默认配置并报「test is successful」）',
      }
    }
    const args = [this.opts.binary(), '-t', '-d', this.opts.dataDir(), '-f', file]
    try {
      const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
      }, TEST_TIMEOUT_MS)
      try {
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
        ])
        const code = await proc.exited
        // 兜底：即便文件在 existsSync 之后被删掉，也能识别出「它自己造了一份配置」
        const autoCreated = /create a initial config file/i.test(stdout + stderr)
        const ok = code === 0 && !autoCreated
        return {
          ok,
          code,
          stdout,
          stderr: autoCreated
            ? stderr + '\n[mihomo 自动创建了缺失的配置文件，本次结果不可信]'
            : stderr,
        }
      } finally {
        clearTimeout(timer)
      }
    } catch (e) {
      return { ok: false, code: -1, stdout: '', stderr: '执行 ' + args[0] + ' 失败：' + errText(e) }
    }
  }

  /** 进程 stdout+stderr 的尾部（日志环缓冲）。lines<=0 返回空数组。 */
  tailLog(lines: number): string[] {
    const n = Math.trunc(lines)
    if (!(n > 0)) return []
    const all = this.partial ? [...this.lines, this.partial] : this.lines
    return all.slice(-n)
  }

  // ------------------------------------------------------------------ 内部

  /** 等待进程退出；到时返回 false，并且**清掉定时器**（不留下悬空的 sleep）。 */
  private waitExit(proc: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(false)
      }, timeoutMs)
      void proc.exited.then(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private pipeLogs(proc: Bun.Subprocess): void {
    const feed = (chunk: Uint8Array) => {
      try {
        this.pushLog(Buffer.from(chunk).toString('utf8'))
      } catch {
        /* ignore：日志不能影响主流程 */
      }
    }
    void (async () => {
      for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) feed(chunk)
    })().catch(() => undefined)
    void (async () => {
      for await (const chunk of proc.stderr as AsyncIterable<Uint8Array>) feed(chunk)
    })().catch(() => undefined)
  }

  private handleExit(proc: Bun.Subprocess, code: number | null): void {
    // stop() 已经收尾过 → 这条通知是迟到的，忽略（否则会把 stopped 改写成 crashed）
    if (this.proc !== proc) return
    this.proc = null
    this.st.pid = null
    this.st.lastExitAt = Date.now()
    if (this.stopping) {
      this.st.status = 'stopped'
      this.st.lastExitReason = 'stopped'
      return
    }
    this.st.status = 'crashed'
    this.st.lastExitReason = 'crash'
    this.pushLine('[panel] mihomo 意外退出（code=' + String(code) + '）；不自动重启，等外层调度')
  }

  private failStart(reason: string): never {
    // 启动失败路径可能从「正在收尾」的中途进来（例如就绪超时），这里统一复位，
    // 否则残留的 stopping=true 会把之后真实的崩溃误判成 stopped。
    this.stopping = false
    this.st.status = 'crashed'
    this.st.lastExitReason = 'start-failed'
    this.st.lastExitAt = Date.now()
    this.st.pid = null
    const tail = this.stderrTail()
    this.pushLine('[panel] 启动失败：' + reason)
    throw new Error('数据面（Mihomo）启动失败：' + reason + (tail ? '\n' + tail : ''))
  }

  /** stderr 优先的尾部若干行，用于把启动失败原因塞进异常消息。 */
  private stderrTail(max = 6): string {
    return this.tailLog(MAX_LOG_LINES)
      .filter((l) => l.trim())
      .slice(-max)
      .join('\n')
  }

  /** 环形缓冲写入：按行切分，保留未换行的尾巴；超上限从头丢弃。 */
  private pushLog(text: string): void {
    if (!text) return
    this.partial += text
    const parts = this.partial.split('\n')
    this.partial = parts.pop() ?? ''
    for (const raw of parts) {
      this.pushLine(raw)
    }
  }

  private pushLine(raw: string): void {
    const line = raw.replace(/\s+$/, '')
    if (!line) return
    this.lines.push(line)
    if (this.lines.length > MAX_LOG_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LOG_LINES)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
