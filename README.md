# metactl

仅 Windows 的命令行工具，用 Node.js 管理 [mihomo (Clash.Meta)](https://github.com/MetaCubeX/mihomo) 内核。

分工很明确：

- **`npm install` 负责安装内核**：依赖装完后 `postinstall` 自动从 mihomo 官方 GitHub Releases 下载 zip、按官方 digest 校验 sha256、解压到 `.runtime/bin/mihomo.exe`。mihomo 是 Go 编译的独立可执行文件，**不是 npm 包**，所以不在 `dependencies` 里。
- **`init` 只负责添加订阅**：拉取订阅 YAML → 生成配置 → `mihomo -t` 校验。它不会下载或替换内核。
- 之后 `start` → `proxy on` 上网 → `proxy off` → `stop`。

## 运行前提

- Windows（系统代理走 HKCU 注册表，**不需要管理员权限**）
- Node.js **>= 16.20.2** 与 npm
- 首次 `npm install` 需要联网：除了约 1 MB 的纯 JS 依赖，还会下载约 22 MB 的内核 zip（解压后 exe 约 58 MB）。**不要加 `--ignore-scripts`**，否则 `postinstall` 不会执行、内核不会被安装。
- 想看下载进度用 `npm install --foreground-scripts`（npm 默认隐藏 lifecycle 脚本输出）。

下载主路径走 GitHub API 的 release asset 端点（避免依赖常被阻断的 `github.com`），并自动识别标准 `HTTPS_PROXY` / `NO_PROXY` 环境变量建立 CONNECT 隧道；直连失败时回退到代理，再回退到官方发布页直链。所有下载均按 GitHub 官方 `sha256` digest 校验。

工具不依赖任何本机已装的其他代理客户端，内核唯一来源是 mihomo 官方 GitHub Releases。

## 快速开始

在项目目录打开 **cmd** 或 **PowerShell**：

```bat
npm install
node bin\cli.js kernel status
node bin\cli.js init --sub "https://example.com/sub/<token>/clash#MySub"
node bin\cli.js start
node bin\cli.js proxy on
```

`npm install` 结束时内核已就位；`kernel status` 可确认版本与校验信息。`init` 只拉订阅并生成配置，不再联网下载内核，同时会**自动把项目目录加入当前用户的 PATH** —— 重新打开一个终端后就能直接敲 `metactl`。

此时浏览器等应用会通过 `127.0.0.1:17890` 走代理。用完：

```bat
node bin\cli.js proxy off
node bin\cli.js stop
```

`init` 已自动把项目目录加入用户 `PATH`，**重新打开一个终端**后就能直接用短命令（由仓库根的 `metactl.cmd` 提供）：

```bat
metactl status
```

`metactl.cmd` 用 `%~dp0` 定位自身，换盘符、路径含空格或中文都可用。`node bin\cli.js <命令>` 永远可用，不依赖 PATH 或 npm link；不想让 `init` 改环境变量就加 `--no-path`。

## 命令

| 命令 | 说明 |
| --- | --- |
| `init` | **添加订阅**：拉取订阅、生成并校验配置，并自动把项目目录加入用户 PATH。`--sub <地址>` 首次必填，之后可省略以复用已保存地址 |
| `fix` | **断网自救**：清除关机残留的 metactl 系统代理，一键恢复上网（也可写 `proxy fix`；幂等，可反复执行） |
| `speed` | **节点延迟测速**：全量节点按延迟排行（需内核正在运行），见下节 |
| `kernel status` | 查看已安装内核的版本、架构、大小与 sha256 校验信息（默认动作，可直接写 `kernel`） |
| `kernel install` | 手动补装内核（`postinstall` 失败或主动跳过时使用）；已存在且为最新版则跳过 |
| `kernel update` | 强制检查并升级到官方最新版 |
| `start` | 启动内核（**不**自动开系统代理） |
| `stop` | 停止内核（**不**自动关系统代理） |
| `restart` | 重启内核，系统代理设置保持不变 |
| `status` | 查看初始化、内核、订阅流量、进程、控制器、系统代理、端口状态 |
| `test` | 自检运行态：内核文件、配置、端口、控制器密钥、`mihomo -t` |
| `proxy on` | 开启系统代理并备份用户原有设置 |
| `proxy off` | 关闭系统代理并**精确恢复**开启前的设置 |
| `version` | 显示工具版本、Node 版本、运行态目录 |

常用选项：

- `--sub <地址>`：`init` 的订阅地址（地址含 token，只存本地 `.runtime/`）
- `--no-path`：`init` 跳过把项目目录加入用户 PATH（默认会自动加入）
- `kernel` 的选项：`--force`（强制重下）、`--arch auto|x64|ia32|arm64`、`--compatible`、`--mirror <前缀>`
- `--mirror <前缀>` 或环境变量 `METACTL_MIRROR`：为内核 / Geo 数据下载指定镜像前缀（受限网络自行指定，源码不内置任何镜像域名；sha256 始终按官方 digest 校验）
- `--force`：`proxy off --force` 仅关闭代理而不恢复；`fix --force` 强制关闭非 metactl 设置的代理（仅置 `ProxyEnable=0`，保留原值）
- `--home <目录>` 或环境变量 `METACTL_HOME`：覆盖运行态目录
- `speed` 的选项：`--group <名称>`（可重复）、`--url <地址>`、`--timeout <毫秒>`、`--limit <n>`，见「节点延迟测速」
- `--json`：输出机器可读 JSON；`--quiet`；`-v, --verbose`

### 安装阶段的环境变量

| 变量 | 作用 |
| --- | --- |
| `METACTL_SKIP_KERNEL=1` | 跳过 `postinstall` 的内核安装，只装依赖（离线 / CI）。之后用 `metactl kernel install` 补装 |
| `METACTL_MIRROR=<前缀>` | 为内核下载指定镜像前缀 |
| `METACTL_KERNEL_FORCE=1` | 即使已有有效内核也强制重新下载 |
| `METACTL_ARCH` / `METACTL_COMPATIBLE=1` | 指定内核架构 / 兼容版（一般跟随 `process.arch` 自动推导即可） |
| `METACTL_VERBOSE=1` | 输出下载调试信息 |
| `METACTL_HOME` | 运行态目录（对 CLI 与 `postinstall` 同时生效） |

**失败策略**：内核下载失败时 `npm install` 会以非零退出并打印原因（依赖本身已装好，不会留下静默的半成品）。可设置镜像重试，或用 `METACTL_SKIP_KERNEL=1 npm install` 先装依赖、之后 `metactl kernel install` 补装。若 `.runtime/bin/` 里已有有效内核，重复 `npm install` / `npm ci` 会直接跳过，不联网、不重复下载。

退出码：`0` 成功、`1` 内部错误、`2` 用法错误、`10` 环境问题、`11` 未初始化、`12` 订阅、`13` 内核、`14` 配置、`15` 已运行、`17` 端口占用、`18` 启动/探活失败、`19` 注册表被拦截、`20` 外来代理快照。

## 换一台 Windows 电脑使用

1. 安装 Node.js >= 16.20.2 与 npm
2. 复制**整个项目目录**到任意路径（含空格/中文也可以）
3. 执行 `npm install`（推荐 `npm ci`，需联网，会按 `package-lock.json` 逐字节还原依赖）→ **自动安装内核**；若 `.runtime/` 一起带过来且内核有效，这一步会直接跳过下载
4. `node bin\cli.js kernel status` 确认内核就位
5. `node bin\cli.js init --sub <订阅地址>`；`init` 会把**这台机器上的**项目目录加入用户 PATH，重开终端即可直接敲 `metactl`。如果 `.runtime/` 一起带过来了，配置也在，可直接 `start`
6. `metactl.cmd` 可直接用；`npm link` 是可选的，但它会生成带绝对路径的链接，换机后需重做，**不要作为唯一入口**

跨机时工具会自动识别 `.runtime/` 来自其他机器或路径：清理旧的 PID 记录、隔离旧的系统代理快照，绝不会拿旧 PID 去结束新机器上的无关进程。内核与配置仍可复用。

> **安全警告**：`.runtime/` 里的订阅快照与配置含订阅 token 和控制器密钥，随整目录拷贝会一起带走。拷贝给别人前请先删除 `.runtime/`。

## 用户 PATH 自动配置

`init` 成功后会把**项目根目录**（`metactl.cmd` 所在目录）追加到当前用户的 `PATH`：

- 改的是 `HKCU\Environment` 下的 `Path`，**不需要管理员权限**，不动系统级 PATH，也不影响其他用户
- **只追加、不覆盖**，原有每一项保持不变；值类型（`REG_SZ` / `REG_EXPAND_SZ`）也保持原样
- **幂等**：目录已在 PATH 中就不重复添加；写入后会回读校验确认生效
- 写入后广播环境变更通知；**已经开着的终端不会更新，必须重新打开一个新终端**才能用 `metactl`
- 目录由运行时推导，源码不含任何硬编码盘符；换到别的电脑后 `init` 会加入那台机器上的实际路径
- 只有订阅、配置、`mihomo -t` 全部成功之后才会动 PATH；写入失败只给警告，**不会让 `init` 失败**
- 不想改环境变量：`metactl init --no-path`，或全程用 `node bin\cli.js <命令>`

撤销：打开「编辑账户的环境变量」→ 用户变量 `Path` → 删除对应项目目录那一项。工具不提供自动移除。

## 运行态数据 `.runtime/`

所有状态都在项目目录内，便于整目录带走：

```
config.json            端口 / mode / 日志级别 / 控制器密钥等偏好（可手工编辑）
profile.yaml           订阅原文快照
profile.meta.json      订阅地址、显示名、流量与到期信息
config.yaml            最终生成的配置
config.yaml.bak        上一版配置（单代回滚）
bin/mihomo.exe         内核（npm install 的 postinstall 安装）
bin/kernel.json        内核版本与校验信息
state/                 实例指纹、PID、系统代理备份
logs/                  内核输出与工具日志
tmp/ data/             临时文件与内核工作目录
```

`.runtime/` 已加入 `.gitignore`，**不要提交、打包外发或公开分享**。

## 关于系统代理

- 修改的是当前用户的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 下的 `ProxyEnable` / `ProxyServer` / `ProxyOverride` 三个键，无需管理员。
- `proxy on` 会先备份三个键的原值；`proxy off` 精确恢复（原本不存在的键会删除）。刷新用系统自带的 PowerShell 通知已打开的程序。
- **Node、curl、git 默认不读 Windows 系统代理**。验证请用浏览器，或 `curl.exe -x http://127.0.0.1:17890 https://example.com`。
- 内核未运行时 `proxy on` 会拒绝执行，避免把流量指向不存在的端口导致断网。
- **关机 / 重启前记得 `metactl proxy off`**；忘记的话开机后执行 `metactl fix`（见下节）。
- 若安全软件或组策略拦截了 `reg.exe` / PowerShell，工具会给出 `E_REGISTRY_DENIED` 提示；请在普通终端运行或放行后重试。

## 断网自救

`proxy on` 写的是 HKCU 注册表，**关机不会让它自动消失**。如果忘了 `proxy off` 就关机，下次开机内核没启动，浏览器却仍把流量发往 `127.0.0.1:17890`，表现就是「连不上网」。

开机后发现上不了网，执行任意一条：

```bat
metactl fix
metactl proxy fix
```

`fix` 的特点：

- **幂等**：没有残留代理时什么都不做，可以反复运行，也适合放进开机启动项
- **不依赖内核运行，也不依赖备份文件**；`proxy off` 则要求 `state/proxy-backup.json` 存在且属于当前实例
- 有本实例备份时**精确恢复**到 `proxy on` 之前的原值；无备份时只关闭 `ProxyEnable` 并清除 metactl 自己写入的 `ProxyServer` / `ProxyOverride`
- **不误伤你自己的代理**：当前代理指向别处（非 metactl 端口）时默认不动并给出提示；确需关闭用 `metactl fix --force`（也只把 `ProxyEnable` 置 0，保留原 `ProxyServer` 值）
- `metactl status` 会检测这种「悬空代理」，输出 `staleProxy: true` 并给出警告
- 刷新通知被安全软件拦下时不会报错失败：注册表已恢复，重新打开浏览器或注销一次即可生效

### 开机自动恢复（可选，手动配置，工具不改系统）

因为 `fix` 幂等，可以让它每次登录静默跑一次：

1. `Win + R` 输入 `shell:startup`，打开当前用户的「启动」文件夹
2. 新建快捷方式，目标填 `"<项目目录>\metactl.cmd" fix --quiet`（把 `<项目目录>` 换成实际路径）
3. 之后每次登录自动检测；没有残留代理时不产生任何改动

`--quiet` 只抑制正常输出，不会隐藏真正的错误。该快捷方式含绝对路径，换到别的电脑后需要重新创建。

## 节点延迟测速

`speed` 复用 mihomo 内置的节点延迟测试接口，测的是**各节点到测试地址的往返延迟（RTT）**，不是下载带宽。请求由内核直接发出、不经过本机系统代理，只是一次轻量探测，几乎不消耗订阅流量。

前提：**内核正在运行**（`metactl start`）。

```bat
metactl speed                        :: 全量节点，按延迟从快到慢排行
metactl speed --limit 10             :: 只看最快的 10 个
metactl speed --group GLOBAL         :: 只测指定代理组（可重复）
metactl speed --url https://example.com --timeout 5000
metactl speed --json                 :: 机器可读结果（含组信息、全部结果与失败节点）
```

实现要点：从 `/proxies` 收集所有代理组的候选节点，用贪心选**最少的组**覆盖全部节点（多数订阅里 `GLOBAL` 一个组就含所有节点，因此只发一次请求），同名节点合并时取最小延迟，再排序输出统计（最快 / 最慢 / 平均 / 成功失败数）。超时或不可用的节点不进排行，只在 `--json` 的 `failures` 里列出。

选项：

- `--group <名称>`：只测指定代理组，可重复传；组名见 `metactl speed --json` 的 `groups`
- `--url <地址>`：默认 Clash 常用的 `generate_204` 探测地址
- `--timeout <毫秒>`：单节点超时，默认 3000，范围 200–30000
- `--limit <n>`：只显示延迟最低的前 n 个

> 说明：这是延迟测试，**不测下载速度**。带宽测速需要真实下载文件、会明显消耗订阅流量，MVP 不做。
>
> 排行包含订阅里全部候选策略，因此可能看到 `DIRECT` 这类内置策略，以及部分订阅商放置的「剩余流量」「打不开网站请...」等信息节点；它们同样会被探测，属于订阅原文内容，工具不擅自过滤。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `E_KERNEL_NOT_INSTALLED` | 内核没装：执行 `npm install`（别加 `--ignore-scripts`），或 `metactl kernel install` 手动补装 |
| `npm install` 卡在 / 失败于内核下载 | 用 `npm install --foreground-scripts` 看进度；受限网络设 `METACTL_MIRROR=<前缀>`；或 `METACTL_SKIP_KERNEL=1 npm install` 先装依赖，之后 `metactl kernel install` |
| `E_KERNEL_CHECKSUM` / 下载失败 | 网络问题或 CDN 干扰；已有内核不会被删除，重试 `metactl kernel install` 即可 |
| 想升级内核 | `metactl kernel update`（会要求先 `metactl stop`） |
| `E_PORT_IN_USE` | 改 `.runtime/config.json` 的 `ports` 段后重新 `init`，或结束占用程序 |
| `E_SUB_INVALID_YAML` | 订阅返回了 HTML / base64；MVP 只支持原生 Clash YAML 明文，请换用对应格式的订阅链接 |
| `mihomo -t` 提示无法下载 MMDB / Geo 数据 | 订阅含 `GEOIP` / `GEOSITE` 规则时内核需要本地 geodata 文件；CLI 会自动补下到 `.runtime/data/` 后重试校验，也可手动放入 |
| `E_NOT_INITIALIZED` | 先执行 `init` |
| `status` 提示「来自其他机器或路径」 | 正常运行态迁移，PID 与代理快照已隔离，`start` 即可 |
| `E_PROXY_BACKUP_FOREIGN` | 代理备份是别的机器留下的，用 `proxy off --force` 仅关闭代理 |
| `E_DEPS_MISSING` | 先在项目目录执行 `npm install` |
| `E_NODE_TOO_OLD` | 需要 Node.js 16.20.2 或更高 |
| 开机后连不上网 | 忘了 `proxy off` 就关机，系统代理残留指向已停掉的内核；执行 `metactl fix` 一键恢复，或按上节配置开机自愈 |
| `E_SPEED_NO_KERNEL` | 测速需要内核在跑，先执行 `metactl start` |
| 测速全部节点超时 | 检查节点可用性与 `--url` 是否可达，可调大 `--timeout`；`--json` 的 `failures` 会列出失败节点 |
| `metactl` 命令找不到 | `init` 已自动加入用户 PATH，但**需要重新打开一个新终端**；旧终端不会继承新 PATH。也可用 `node bin\cli.js <命令>` |
| `E_PATH_WRITE` / `E_PATH_TOO_LONG` | 用户 PATH 写入被安全软件/组策略拦截，或 PATH 过长；`init` 仍会正常生成订阅与配置。用 `--no-path` 跳过，或手动在「编辑账户的环境变量」里清理/添加 |

## 自检与开发

```bat
npm test        :: 运行单元测试（不联网、不启动内核）
npm run scan    :: 扫描源码，禁止出现任何本机硬编码路径或敏感字面量
node bin\cli.js kernel status   :: 查看内核安装信息
node bin\cli.js test           :: 校验真实运行态
```

## MVP 明确不做

不打包独立 exe、不要求目标机免装 Node、不发布到 npm；TUN、服务化、开机自启、WinHTTP / PAC、per-app 代理；base64 订阅、定时更新、多订阅合并、订阅转换；节点选择 / 带宽测速 / 规则编辑 / 流量面板 / external-ui（节点**延迟**测速已由 `speed` 支持）；GUI、国际化、自升级；非 Windows 平台；任何复用本机其他客户端内核的方式。
