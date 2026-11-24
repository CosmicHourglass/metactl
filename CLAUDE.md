# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目性质

Windows 专用的 Node.js CLI，管理 [mihomo (Clash.Meta)](https://github.com/MetaCubeX/mihomo) 内核：拉订阅 → 生成配置 → 启停内核 → 开关系统代理 → 测速 / 看路由 → 卸载。

纯 CommonJS，无 TypeScript、无打包器、**无测试框架**。运行时逻辑在 `src/`，子命令在 `src/commands/`，安装与打包脚本在 `scripts/`。仅支持 Windows（`bin/cli.js` 入口守卫拦截非 win32 与 Node < 16.20.2）。

## 常用命令

```bash
npm test                                    # 单元测试，不联网/不启内核/不改注册表
npm run scan                                # 可移植性守卫，见下文「禁词扫描」
npm run stage:kernel                        # 把本地 mihomo 内核暂存到 assets/（打包分发用）
npm run build:bundle -- --node <node.exe>   # 打自带 Node 运行时与内核的安装包（产物在 dist/）
npm run build:install                       # 由 install-core.ps1 重新生成 install.ps1
node bin/cli.js status                      # 在项目目录里直接跑 CLI
node scripts/build-bundle.js --help
```

- **测试**：全部集中在 `test/run.js` 一个文件里，用手写的 `t(name, fn)` 断言助手，**没有按名字过滤单个用例的能力**。要只跑一项，只能临时注释掉其余 `await t(...)` 块。测试通过替换 `require.cache` 里的模块来 mock（`withRegistry` 模拟内存注册表、`withFakeProcess` 模拟假控制器），新增依赖注入点的模块要同步在 `withRegistry(store, fn, extraModules)` 的第三个参数里列出路径。
- **`npm run build:install` 是强制步骤**：改过 `install-core.ps1` 后必须重跑，否则 `install.ps1` 里的 base64 还是旧内容。

## 架构：三种安装模式决定一切

这是读多个文件才能拼出来的主干。程序目录（代码）和数据目录（运行态）是**两个独立位置**，安装方式决定二者的组合。

| 模式 | 判定依据（`src/paths.js`） | 程序根 | 数据根 |
| --- | --- | --- | --- |
| `source` | 都不是 | 项目目录 | 项目目录 → `.runtime/` |
| `npm-global` | 路径里含 `node_modules` | `<prefix>\node_modules\metactl` | `%LOCALAPPDATA%\metactl` → `.runtime/` |
| `bundle` | 根下有 `bundle.json`（打包产物标记） | `<installDir>\current` | `%LOCALAPPDATA%\metactl` → `.runtime/` |

关键约束：**安装阶段与运行阶段必须解析到同一个数据目录**，否则 postinstall 装好的内核运行时找不到。`scripts/postinstall.js` 用 `npm_config_global` 判定，`src/paths.js` 的 `defaultDataRoot()` / `globalDataRoot()` 用 `isGlobalNpm()` 判定，两条路径必须对齐——改一处就要同步另一处。

`--home <目录>` 或 `METACTL_HOME` 可覆盖数据根；`paths.resolveRoot()` 是唯一入口。

### 运行态目录布局（`paths.createPaths()`）

```
.runtime/
  config.json          # 用户配置，与 constants.js 的 DEFAULT_CONFIG 深合并
  profile.yaml         # 订阅原文快照（永不修改）
  profile.meta.json    # 订阅元信息（url / sha256 / 流量 / 到期）
  config.yaml          # 生成后的实际配置，mihomo 读它
  config.yaml.bak      # 上一次的配置备份
  bin/mihomo-metactl.exe   # 内核（对外分发时改名，与官方 mihomo 区分）
  bin/kernel.json          # 内核元信息（tag / sha256 / arch / exeSha256）
  state/instance.json  # 机器+路径指纹
  state/mihomo.pid     # 进程记录
  state/proxy-backup.json
  logs/  data/  tmp/
```

`.runtime/` 含订阅 token 与控制器密钥，**不入库、不打包外发**（已在 `.gitignore`）。

## 命令执行链路

`bin/cli.js`（入口守卫：平台 / Node 版本 / 依赖）→ `src/cli.js`（commander 装配）→ `src/context.js`（构造 ctx）→ `src/commands/<name>.js` 的 `run(ctx, args, opts)`。

- 每个命令模块导出 `async run(ctx, args, opts)`，`ctx` 由 `context.create(opts)` 提供：`{ root, programRoot, installed, p, cfg, opts, migration, logger, paths, config }`。
- **新增命令必须改三处**：`src/cli.js` 的 `COMMANDS` 映射、`DESCRIPTIONS` 描述、`program.command(...)` 装配（还要在 `test/run.js` 的「全部模块可加载」与「cli 装配」两个用例里补断言）。
- 全局选项 `--home / --json / --quiet / -v` 同时挂在 program 和每个子命令上，所以 `metactl --json status` 和 `metactl status --json` 都合法。
- `--json` 模式下 `logger.info/ok/warn` 全部静默，由各命令自己调 `logger.json(out)` 输出结构化结果；错误由 `logger.printError` 输出 `{ ok:false, error:{ code, message, hint } }`。

## 切换线路 / 一键连接 / 网页端

三条新命令，逻辑都放在 `src/` 下的公共模块里，命令层只做输出编排（CLI 与网页端共用同一套逻辑，避免两处实现漂移）。

**`metactl select`**（`src/nodes.js`）：读 `/proxies` 列策略组，`PUT /proxies/{组名}` 带 `{"name":"节点名"}` 切换。只有 `Selector` 类型的组能手动切——`URLTest`/`Fallback` 由内核自动挑，对它们切换会被内核拒绝，命令层提前拦下并说明原因。切换**只影响新建立的连接**，已有连接仍走原节点。**切换不落盘**：内核一重启就回到订阅里 select 组的第一个候选（默认线路），这是明确的设计取舍，不要再往回加持久化。

**`metactl connect` / `metactl disconnect`**（`src/lifecycle.js`）：把「内核 + 系统代理」合成一条命令。**顺序不可颠倒**——连接时先起内核再开代理，断开时先关代理再停内核，任何一边反了都会让代理指向一个没人监听的端口，表现为断网。断开用 `proxy.repair()` 而不是 `proxy.off()`：前者能顺带清掉「关机残留的悬空代理」，且遇到不是本工具设置的代理会保持原样不动。连接时若代理没开成，会把本次启动的内核收回去，不留半吊子状态。

**`metactl web`**（`src/web.js` + `src/web-page.js`）：本地网页操作端。只监听 `127.0.0.1`，地址里带一次性令牌，所有 `/api/*` 都要带令牌才放行（浏览器里的恶意页面读不到本机地址栏里的令牌）。页面是单文件内联 HTML/CSS/JS，不引外部资源，断网可用。令牌地址用 `logger.raw()` 打印——**不落日志文件**，否则令牌就留在磁盘上了。

## 错误与退出码

`src/errors.js` 的 `AppError(code, message, hint, cause)`；`code → 退出码` 映射表在 `errors.js` 的 `CODE_EXIT`，语义常量在 `constants.js` 的 `EXIT`（如 `E_PORT_IN_USE → 17`、`E_NOT_INITIALIZED → 11`）。抛错统一用 `fail(code, msg, hint, cause)`；包装原生异常时用 `wrap(...)`。

**新增错误码要同时加进 `errors.js` 的 `CODE_EXIT` 和 `constants.js` 的 `EXIT`**，否则会落到 `EXIT.INTERNAL`（1）。

## 脱敏（贯穿全局）

`src/logger.js` 维护全局 secret 池：订阅 URL、订阅 token、控制器 secret 都在 `context.create()` 里 `registerSecret()`，任何输出（stdout / stderr / 日志文件）前统一替换成 `***`。`logger.maskUrl()` 对订阅 URL 做路径段打码。新增可能泄露敏感值的地方，一律走 `logger.*` 而非 `console.log`。

## 几个必须守住的不变量

**系统代理**（`src/proxy.js`）：注册表 `HKCU\...\Internet Settings` 的 `ProxyEnable` / `ProxyServer` / `ProxyOverride` 是唯一事实来源，PowerShell 只负责刷新通知（`InternetSetOption`），刷新失败不影响结果。所有改动前先 `backup()`，备份带 `instanceId`；重复 `proxy on` 不会把 metactl 自己写的值当成「用户原值」。`proxy off` 只在备份属于当前实例时才精确恢复，否则要求 `--force` 仅置 `ProxyEnable=0`。`fix` 幂等，不依赖内核运行、不依赖备份存在；遇到不是 metactl 设置的代理默认不动。

**实例指纹**（`src/instance.js`）：`hostname + sha256(项目路径)`。整目录拷到别的机器后，`instance.check()` 会在所有命令执行前识别迁移，删掉 PID 记录、把代理快照改名隔离，避免误杀进程或把别人的代理设置恢复回来。

**配置生成**（`src/yaml-patch.js`）：用 YAML AST 覆盖**顶层键**，保留订阅原文的注释、锚点、merge key、`proxies`/`rules` 原语义；被覆盖键的注释先收集再回填到文档顶部。订阅可能含重复顶层键，`deleteAll` 必须循环删干净再 set。`secret` 写进配置文件而不是 argv（argv 会被任务管理器看到）。

**init 的提交顺序**：拉订阅 → `yamlPatch.build()` 写临时文件 → `mihomo -t` 校验 → 通过后才 `commit()` 覆盖 `config.yaml`。校验失败时旧配置完全不受影响。校验一律交给内核自身（`src/validate.js`），AST 合法 ≠ mihomo 接受。若 `-t` 因缺 Geo 数据失败，`src/geodata.js` 补下 `geoip.metadb` / `geosite.dat` 后重试。

**PID 复用防护**（`src/process.js`）：判定进程在跑要三重核对——进程存在 + 映像名是本工具的内核 + `instanceId` 一致。映像名认两个：`mihomo-metactl.exe`（当前）与 `mihomo.exe`（0.2.x 留下的，升级后仍在跑的老内核也要认，否则会被误判成 PID 复用而清掉记录，老进程就成孤儿）。`tasklist.exe` 不可用时保守认为「在运行」，绝不因拿不到映像名就误清 PID。

**内核分发**（`scripts/stage-kernel.js` + `src/kernel.js` 的 `installBundled`）：内核**随安装包分发**，装完即用，不依赖 MetaCubeX 的 GitHub 可达性。`assets/mihomo-metactl.exe` + `assets/kernel.json` 由 `npm run stage:kernel` 从本地运行态生成（`assets/` 已 gitignore，61 MB 不进仓库；npm 的 `files` 字段仍会把它打进 tarball）。落盘前按 `kernel.json` 里的 `exeSha256` 校验，对不上就拒绝并删除已拷贝的文件。`metactl kernel install` 保留为「联网从官方 release 取内核」的路径，`install-core.ps1` 与 `postinstall.js` 在没有随包内核时回落到它。

**内核下载**（`src/kernel.js`）：zip 只把 exe 写到固定目标文件（天然免疫 zip-slip），同时逐条校验 entry 名，可疑条目放弃整包。下载路径依次尝试 `--mirror` 前缀 → GitHub API 资产端点 → 发布页直链，sha256 按官方 digest 校验。**源码里不得写死 release tag 或 sha256**，运行时从 API 取得。

## HTTP 层（`src/http.js`）

Node 16 没有全局 fetch，所以自封了 http/https：手写重定向跟随（跨 host 剥掉凭据）、流式算 sha256、区分「可重试网络错误」与「业务 HTTP 错误」。支持标准 `HTTP(S)_PROXY` 环境变量的 CONNECT 隧道；重试策略是首次直连、失败且存在代理时后续改走代理，这样受限网络和正常网络都能工作且不拖慢正常路径。

## 卸载（`src/uninstall.js` + `src/commands/uninstall.js`）

内核在运行就拒绝执行（提示先 `metactl stop`），不打断正在跑的流量。默认行为：恢复系统代理原值 → 删内核 → 摘 PATH → 删程序，**订阅快照与配置保留**；`--purge` 才连它们一起删。

三种模式分别处理：`bundle` 删程序目录、`npm-global` 交给 `npm uninstall -g`（不动共享的 PATH）、`source` 绝不删用户的源码目录。

自包含安装有个特殊难点：程序目录里的 `node.exe` 正是当前进程在跑的 exe，直接删不掉。做法是**先改名让位**（`<dir>.uninstalled-<ts>`），再由脱离父进程的 `cmd` 循环重试删除（目标路径走环境变量 `METACTL_RM_TARGET`，配合 `windowsVerbatimArguments`，避免中文/空格路径被 cmd 引号规则切碎）。

**清数据放最后**：日志目录被删后再写日志会把目录重建出来，所以 purge 之后只用 `logger.warn` 报错，最终汇总走 `process.stdout.write` 直写。

## 可移植性守卫（`npm run scan`）

`scripts/scan-forbidden.js` 扫描 `src/`、`scripts/`、`bin/cli.js`、`package.json`、`metactl.cmd`、`install-core.ps1`、`README.md`，禁止出现：本机用户目录 / Windows 绝对路径字面量 / 其它客户端名称 / 真实订阅名 / 本机实测端口 / 写死的 release tag / 写死的 sha256 片段 / 写死的用户名。**新增代码必须过这一关**——路径一律从 `__dirname` / `os.homedir()` / 环境变量 / `SystemRoot` 派生。

扫描器本身用字符串拼接构造敏感字面量，避免它自己命中自己的规则。

## 安装脚本管线

```
install-core.ps1  --(npm run build:install，base64 内嵌)-->  install.ps1  -->  用户 irm ... | iex
install-core.ps1（PowerShell 源码本体）
scripts/build-bundle.js --> dist/metactl-<ver>-win32-x64/ (+ .zip) --> install-core.ps1 下载它
scripts/stage-kernel.js --> assets/（内核 + 元信息）--> 被 build-bundle 与 npm 包共用
```

- `install.ps1` 是**生成物**，纯 ASCII、无 BOM（改 `install-core.ps1` 后重跑 `npm run build:install`）。
- `install-core.ps1` 保留 BOM + CRLF + 中文；`.gitattributes` 把 `*.ps1` / `*.cmd` 标成 `-text`，强制原样存储——否则 Windows PowerShell 5.1 直连下载后会误判编码导致中文乱码。**不要动换行符**。
- 内核安装由安装阶段负责（`scripts/postinstall.js` 或 `install-core.ps1`），`metactl init` 只管订阅和配置。PATH 写入也属于安装阶段，`init` 不再有 `--no-path` / `--no-kernel` 之类的选项。
- **PowerShell cmdlet 不要想当然**：这台机器上 `Get-FileHash` 就不可用（`Microsoft.PowerShell.Utility` 模块导出不完整）。算哈希用 .NET API 直接算；`ConvertFrom-Json` 等经过验证的可以用。

## 许可证

项目整体 **GPL-3.0**（`LICENSE` 为 GPLv3 全文，`package.json` 的 `license` 字段同步）。原因：随包分发的 mihomo 内核本身就是 GPLv3，打包分发即构成组合作品，必须整体以 GPLv3 发布。

新增代码时不要引入与 GPLv3 冲突的依赖；README 的「致谢与许可证」一节点名 MetaCubeX/mihomo 并说明内核版本可在 `metactl kernel status` 查到。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `METACTL_HOME` | 覆盖运行态目录（同 `--home`） |
| `METACTL_MIRROR` | GitHub 下载镜像前缀（源码不内置任何第三方域名） |
| `METACTL_SKIP_KERNEL` | postinstall 跳过内核下载 |
| `METACTL_KERNEL_FORCE` | postinstall 强制重新下载内核 |
| `METACTL_ARCH` / `METACTL_COMPATIBLE` | postinstall 的架构与兼容版选择 |
| `METACTL_VERBOSE` | postinstall 输出调试信息 |

## 写代码时的默认取向

- 所有文件读写用 UTF-8 **无 BOM**；写文件走 `paths.writeAtomic()`（临时文件 + fsync + rename），别直接 `fs.writeFileSync` 覆盖关键文件。
- 路径用绝对路径 + 单引号包裹；用户目录、系统盘路径一律运行时派生。
- 报错一律带 `hint`（给用户下一步动作），不静默吞异常；捕获后仍要把关键信息落到 `.runtime/logs/metactl.log`。
- 注释用中文，说明「为什么这么做」而不是复述代码；本仓库的注释密度较高，改动时保持同等风格。
