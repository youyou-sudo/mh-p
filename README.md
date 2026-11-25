# mh-p

Mihomo 节点池管理面板：**订阅 → 检测 → 发布 → 面板 / API** 一体，打包成**单个可执行文件**。

控制面用 Bun + Elysia + SQLite 存期望状态，数据面交给 [Mihomo](https://github.com/MetaCubeX/mihomo)（Clash Meta 内核）。
单端口网关（HTTP CONNECT / SOCKS5）把「用户名 = 节点 ID」映射到**槽位 listener**：
每个节点占用一个固定槽位（= 一个 select 组 + 一个 listener），节点上线只是 `PUT /proxies/<组>` 换选中项，
**热生效、不断连、不重载配置**。

## 能力

- **订阅**：Xray / sing-box JSON、Clash YAML、base64 或明文链接列表；面板解析并转成 Clash proxy 写进
  Mihomo 的 provider 文件，再用 `PUT /providers/proxies/<sub-id>` 热加载（**不重载整份配置、不断连**）。
- **检测**：两条互补路径——① 周期采样读 Mihomo provider 的健康历史（只有 up/down 与延迟）；
  ② 按需经槽位 listener 发真实请求，拿 `error_kind` 与出口 IP（手动检查、API、定时出口确认都走它）。
- **发布**：期望状态 → 结构同步（provider 集合/槽位容量/基础参数变了才重载）→ 逐槽位热切换 → 网关路由表。
  发布是**幂等**的（"对账"就是再发布一次），失败会还原上一份 config 且不重载。
- **网关**：单端口同时接受 HTTP 代理与 SOCKS5，首字节分流。
- **面板**：11 个页面（Furin + React 19 + shadcn/ui），构建产物内嵌进二进制。
- **API**：面板 API、服务 API（API Key scope）、SSE 事件流、`/api/health`。

## 快速开始

### Docker（推荐）

```bash
docker build -t mh-p .
docker run -d --name mh-p \
  -p 8080:8080 -p 7890:7890 \
  -v mh-p-data:/data \
  -e ADMIN_PASSWORD='你的口令' \
  mh-p
```

镜像是 distroless + 单文件二进制，以 `nonroot` 运行，Mihomo 已按目标平台内嵌。
持久化数据（SQLite、证书、解出的 Mihomo、config.yaml 与 provider 文件、日志）都在 `/data`；
健康检查用二进制自带的 `mh-p healthcheck` 子命令。

### 源码运行

需要 [Bun](https://bun.sh) 和一份 Mihomo 二进制（放到 `.tools/mihomo[.exe]`，或设 `MIHOMO_BINARY`；
  只下载不编译：`bun run build:exe -- --fetch-only`）。

```bash
bun install
DATA_DIR=./data PANEL_PORT=8080 ADMIN_PASSWORD='你的口令' bun run start
```

`bun run start` 会先构建前端并嵌入控制面，再启动；已构建过可用 `bun run start:fast` 跳过重复构建。

| 地址 | 说明 |
| --- | --- |
| <http://127.0.0.1:8080> | 面板（首屏 `/login`） |
| `<节点ID>:<密码>@127.0.0.1:7890` | 单端口网关入口 |

## 登录

- 用户名 `admin`（`ADMIN_USERNAME` 可覆盖）
- 口令 `ADMIN_PASSWORD` 的值；**未设置时为 `change-me-on-first-run`，请务必改掉**

账号只在数据库为空时创建一次，之后只存 argon2id 哈希。忘记口令不必删库：

```bash
bun run admin:password "你的新口令"   # 重置并吊销全部会话
```

## 配置

配置只有两个入口：**引导参数**（环境变量，见 `.env.example`）与**面板「系统设置」**（落库，启动时被引导参数覆盖）。

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `DATA_DIR` | `./data` | 持久化目录（SQLite / 证书 / Mihomo / 日志） |
| `PANEL_HOST` | `localhost` | 面板监听地址；对外访问需 `0.0.0.0`（Docker 镜像已设） |
| `PANEL_PORT` | `8080` | 面板 + REST API 端口 |
| `ADMIN_USERNAME` | `admin` | 管理员用户名（仅首次创建生效） |
| `ADMIN_PASSWORD` | `change-me-on-first-run` | 管理员口令（仅首次创建生效） |
| `MIHOMO_BINARY` | `mihomo` | 外部 Mihomo 路径；打包版默认用内嵌版本 |
| `TZ` | `Asia/Shanghai` | 会话与日志展示时区 |
| `LOG_LEVEL` | `info` | 面板日志级别 |
| `MHP_API` | `http://127.0.0.1:3000` | 仅前端开发：`/api` 反代到的控制面地址 |

其余参数（网关监听、engine 的槽位容量/端口区间/REST 地址与 secret/日志级别、检测与同步策略等）
都在面板「系统设置」里改。注意 engine 的槽位容量与端口区间是**配置期**参数：改完会自动触发一次
发布并重载配置（会短暂断开经 provider 转发的在途连接）。

## 构建单文件可执行

```bash
bun run build:exe                              # 当前平台 → dist/mh-p[.exe]
bun run build:exe -- --target=bun-linux-x64    # 交叉编译（也支持 arm64 / darwin / windows）
bun run build:exe -- --mihomo-version=v1.19.33  # 换 Mihomo 版本
bun run build:exe -- --fetch-only              # 只下载解出 Mihomo 到 .cache/mihomo（CI 预热）
MIHOMO_DOWNLOAD_MIRROR=https://ghfast.top/ bun run build:exe  # GitHub 拉不动时走镜像
```

流程是：构建前端 → 内嵌 → 按目标平台下载 [Mihomo](https://github.com/MetaCubeX/mihomo/releases)
发行包（windows 是 zip、linux/darwin 是裸 gzip）→ 用 GitHub Release API 的 `digest` 字段校验
SHA-256（Mihomo 不发布 `.dgst`）→ `bun build --compile` 打成单文件。
运行时把内嵌的 `mihomo[.exe]` 解出到 `DATA_DIR/bin`（哈希一致则复用），优先级高于 PATH 上的旧版本；
删掉该目录下次启动会自动重建。

## 项目结构

```text
apps/server/     Elysia 控制面 + 数据面引擎（订阅、同步、检测、渲染与热应用、网关）
apps/web/        Furin + React 19 + shadcn/ui 面板
packages/api-client/  前后端共享的 Eden Treaty 客户端与 App 类型
scripts/         构建、验收、排障脚本
```

后端按业务域拆成 `modules/<feature>/`（控制器 + service + TypeBox 模型），全局错误与请求头走
`plugins/`，鉴权用 session macro 声明式保护。前端不手写 `fetch`：`eden.api.nodes.get({ query: { limit: 50 } })`
的路径、参数与响应类型全部由后端导出，共享类型通过 `bun run api:types` 生成。

## 常用命令

```bash
bun run dev            # 构建前端并以 watch 模式启动控制面
bun run web:dev        # 前端 HMR（默认 3100，需先起控制面）
bun run typecheck:all  # 前后端类型检查
bun test               # 单元 / 集成测试
bun run verify:api     # 面板与服务 API 全端点冒烟
bun run verify:web     # 浏览器 E2E（Playwright）
bun run mihomo:fetch   # 只下载/解出内嵌用的 Mihomo 二进制
```

> 端到端验收脚本（原 `verify:all`）随 Xray 退役一并移除，真机验收矩阵见
> `/d/tmp/research2/MIGRATION.md §4`，重写后再补回 CI 门禁。

CI：push 到 `master` 触发 [release.yml](.github/workflows/release.yml)，先过 `typecheck` + `test` 门禁，
再产出各平台单文件 + `SHA256SUMS.txt` 并发到 GitHub Release；[deploy.yml](.github/workflows/deploy.yml)
推送多架构镜像到 GHCR。

## 排障

**数据面起不来 / 面板显示「REST 不可达」** —— 先看面板「事件」页与数据面日志：
最常见是 REST 端口（`engine.apiAddress`，默认 `127.0.0.1:9090`）被别的进程占着。此时面板会连到
**别人的引擎**（症状：`/api/health` 的 version 不是你的版本、槽位接口 404）。换成空端口后点
「运行配置 → 重启数据面」即可。

**端口被占用（EADDRINUSE）** —— Windows 的 Hyper-V / WSL 会保留一段动态端口
（`netsh int ipv4 show excludedportrange protocol=tcp`）。换一个区间外的端口即可，例如
`PANEL_PORT=8899 DATA_DIR=./data bun run start:fast`；网关端口在「系统设置 → 网关」里改。

**面板打不开 / 提示前端未构建** —— 先跑 `bun run web:build`，确认生成
`apps/server/src/web/assets.generated.ts`，再强制刷新（Ctrl/Cmd + Shift + R）。
前端开发请用 `bun run web:dev`，不要直接改 `apps/web/dist`。

## 许可

Mihomo 为 GPL-3.0，作为**独立进程**分发（不链接、不改动其源码）。本仓库代码遵循项目自身约定。
