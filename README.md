# metactl

仅 Windows 的命令行工具，管理 [mihomo (Clash.Meta)](https://github.com/MetaCubeX/mihomo) 内核：添加订阅、启停内核、开关系统代理、节点延迟测速。

## 安装

两种方式任选其一，装完都能直接用 `metactl` 命令。

### 方式一：自包含安装（目标机不需要 Node.js）

安装包内自带 Node 运行时，一条命令搞定：

```powershell
irm https://raw.githubusercontent.com/CosmicHourglass/metactl/main/install.ps1 | iex
```

需要传参数时（`iex` 无法透传，先取脚本再执行）：

```powershell
$s = irm https://raw.githubusercontent.com/CosmicHourglass/metactl/main/install.ps1
& ([scriptblock]::Create($s)) -Mirror https://gh-proxy.com/
```

用本地安装包（离线环境 / 不想联网下载 Release）：

```powershell
.\install.ps1 -ZipPath .\metactl-<版本>-win32-x64.zip
```

脚本分两层：`install.ps1` 是**自包含**的纯 ASCII 引导层（无 BOM），把主脚本以 base64 内嵌，因此 `irm ... | iex` 只需要一次网络请求；实际逻辑在 `install-core.ps1`（UTF-8 BOM + CRLF，保留中文输出）。改完主脚本要执行 `npm run build:install` 重新生成引导层。两者接受同一组参数。

安装脚本做的事：

- 下载约 **26 MB** 的安装包（含 Node 运行时），校验结构后解压
- 程序装到 `%LOCALAPPDATA%\metactl\current`，**升级时整体替换该目录**
- 数据放 `%LOCALAPPDATA%\metactl\.runtime`（订阅、配置、内核、日志），**升级不受影响**
- 把 `current\bin` **前置**写入当前用户 PATH（.NET API，不需要管理员），并检测 PATH 中是否有旧版本会抢先运行
- 最后调用 `metactl kernel install` 下载 mihomo 内核（约 22 MB）

常用参数：`-Mirror <前缀>` 加速下载、`-Version <版本>` 指定版本、`-SkipKernel` 略过内核、`-NoPath` 不改 PATH、`-InstallDir <目录>` 换安装位置。

卸载：

```powershell
.\install.ps1 -Uninstall          # 保留配置与内核
.\install.ps1 -Uninstall -Purge   # 连订阅与内核一起删
```

### 方式二：npm（已有 Node.js）

```bat
npm install
node bin\cli.js init --sub "https://example.com/sub/<token>/clash#MySub"
```

分工：

- **`npm install` 负责安装内核**：依赖装完后 `postinstall` 自动从 mihomo 官方 GitHub Releases 下载 zip、按官方 digest 校验 sha256、解压到 `.runtime/bin/mihomo.exe`。mihomo 是 Go 编译的独立可执行文件，**不是 npm 包**，所以不在 `dependencies` 里。
- **`init` 负责添加订阅**：拉取订阅 YAML → 生成配置 → `mihomo -t` 校验，不碰内核。
- 之后 `start` → `proxy on` 上网 → `proxy off` → `stop`。

## 运行前提

| | 方式一（自包含） | 方式二（npm） |
| --- | --- | --- |
| Node.js | **不需要** | >= 16.20.2 |
| 首次联网 | 约 26 MB 程序包 + 22 MB 内核 | 约 1 MB 依赖 + 22 MB 内核 |
| 管理员权限 | 不需要 | 不需要 |

- Windows（系统代理走 HKCU 注册表，**不需要管理员权限**）
- 方式二首次 `npm install` 需联网，**不要加 `--ignore-scripts`**，否则 `postinstall` 不会执行、内核不会被安装
- 想看下载进度用 `npm install --foreground-scripts`（npm 默认隐藏 lifecycle 脚本输出）

内核下载主路径走 GitHub API 的 release asset 端点（避免依赖常被阻断的 `github.com`），并自动识别标准 `HTTPS_PROXY` / `NO_PROXY` 环境变量建立 CONNECT 隧道；直连失败时回退到代理，再回退到官方发布页直链。所有下载均按 GitHub 官方 `sha256` digest 校验。

工具不依赖任何本机已装的其他代理客户端，内核唯一来源是 mihomo 官方 GitHub Releases。

## 快速开始

装完后**新开一个终端**（PATH 变更不影响已打开的窗口），然后：

```bat
metactl init --sub "https://example.com/sub/<token>/clash#MySub"
metactl start
metactl proxy on
```

浏览器等应用此时会通过 `127.0.0.1:17890` 走代理。用完：

```bat
metactl proxy off
metactl stop
```

如果 `metactl` 仍然找不到：

- 方式一：直接调用 `%LOCALAPPDATA%\metactl\current\bin\metactl.cmd`
- 方式二：用 `node bin\cli.js <命令>`（永远可用，不依赖 PATH 或 npm link）

`metactl.cmd` 用 `%~dp0` 定位自身，换盘符、路径含空格或中文都可用。

## 命令

| 命令 | 说明 |
| --- | --- |
| `init` | **添加订阅**：拉取订阅、生成并校验配置，并自动把项目目录加入用户 PATH。`--sub <地址>` 首次必填，之后可省略以复用已保存地址 |
| `fix` | **断网自救**：清除关机残留的 metactl 系统代理，一键恢复上网（也可写 `proxy fix`；幂等，可反复执行） |
| `speed` | **节点延迟测速**：全量节点按延迟排行（需内核正在运行），见下节 |
| `kernel status` | 查看已安装内核的版本、架构、大小与 sha256 校验信息（默认动作，可直接写 `kernel`） |
| `kernel install` | 手动补装内核（失败或主动跳过时使用）；已存在且为最新版则跳过。慢速/离线网络可加 `--from-file <zip>` 从本地包装 |
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
- `kernel` 的选项：`--force`（强制重下）、`--arch auto|x64|ia32|arm64`、`--compatible`、`--mirror <前缀>`、`--from-file <zip>`（从本地包装，配 `--sha256 <hex>` 校验）
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

**自包含方式**（对方不需要安装任何运行时）：

1. 把 `install.ps1` 与安装包 zip 一起拷过去；对方能访问 Release 时也可直接 `irm` 一行装
2. `.\install.ps1 -ZipPath .\metactl-<版本>-win32-x64.zip`
3. **新开一个终端** → `metactl init --sub <订阅地址>`

数据不会随程序走：每台机器的 `%LOCALAPPDATA%\metactl\.runtime` 各自独立，需要各自 `init`。想迁移订阅时把 `.runtime` 里的 `config.json` / `profile.yaml` / `profile.meta.json` / `config.yaml` 拷到新机器同一位置即可；工具会自动识别跨机并隔离旧的 PID 记录与代理快照。

**npm / 源码方式**：

1. 安装 Node.js >= 16.20.2 与 npm
2. 复制**整个项目目录**到任意路径（含空格/中文也可以）
3. `npm ci`（按 `package-lock.json` 逐字节还原依赖）→ **自动安装内核**；`.runtime/` 一起带过来且内核有效时直接跳过下载
4. `node bin\cli.js init --sub <订阅地址>`
5. 之后 `metactl.cmd` 或 `node bin\cli.js` 都可用

跨机时工具会自动识别 `.runtime/` 来自其他机器或路径：清理旧的 PID 记录、隔离旧的系统代理快照，绝不会拿旧 PID 去结束新机器上的无关进程。内核与配置仍可复用。

> **安全警告**：`.runtime/` 里的订阅快照与配置含订阅 token 和控制器密钥。拷贝给别人前请先删除 `.runtime/`。

## 用户 PATH 配置

两种安装方式都会把「启动器所在目录」写进当前用户的 `PATH`：

| 方式 | 写入的目录 | 时机 |
| --- | --- | --- |
| 自包含安装 | `%LOCALAPPDATA%\metactl\current\bin`（**前置**插入） | `install.ps1` 安装时，可用 `-NoPath` 跳过 |
| npm / 源码 | 项目根目录（仓库根的 `metactl.cmd`） | `init` 成功后追加，可用 `--no-path` 跳过 |

共同点：

- 改的是 `HKCU\Environment` 下的 `Path`，**不需要管理员权限**，不动系统级 PATH，也不影响其他用户
- **只添加、不覆盖**，原有每一项保持不变；值类型（`REG_SZ` / `REG_EXPAND_SZ`）也保持原样
- **幂等**：目录已在 PATH 中就不重复添加；写入后会回读校验确认生效
- 写入后广播环境变更通知；**已经开着的终端不会更新，必须重新打开一个新终端**才能用 `metactl`
- 目录由运行时或安装位置推导，脚本里不含任何硬编码盘符

自包含方式还会检查 PATH 中是否存在**另一个 metactl**（例如旧的 npm 全局版本）：如果它会抢先命中，安装脚本会明确警告，避免 `metactl version` 显示成旧版本。

撤销：自包含用 `.\install.ps1 -Uninstall`（会自动从 PATH 移除）；源码方式打开「编辑账户的环境变量」→ 用户变量 `Path` → 删除对应那一项。

## 运行态数据 `.runtime/`

位置取决于安装方式：

| 方式 | 数据目录 |
| --- | --- |
| 自包含安装 | `%LOCALAPPDATA%\metactl\.runtime` —— 与程序目录分离，**升级时不会丢** |
| npm / 源码 | 项目根目录下的 `.runtime\` —— 便于整目录带走 |

`--home <目录>` 或环境变量 `METACTL_HOME` 可覆盖。内容：

```
config.json            端口 / mode / 日志级别 / 控制器密钥等偏好（可手工编辑）
profile.yaml           订阅原文快照
profile.meta.json      订阅地址、显示名、流量与到期信息
config.yaml            最终生成的配置
config.yaml.bak        上一版配置（单代回滚）
bin/mihomo.exe         内核（自包含安装或 npm install 的 postinstall 安装）
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
| 内核下载反复超时（网络太慢） | 用能断点续传的工具先下好 zip，再 `metactl kernel install --from-file <zip>`；有官方 digest 时加 `--sha256 <hex>` 校验 |
| 想升级内核 | `metactl kernel update`（会要求先 `metactl stop`） |
| `E_PORT_IN_USE` | 改 `.runtime/config.json` 的 `ports` 段后重新 `init`，或结束占用程序 |
| `E_SUB_INVALID_YAML` | 订阅返回了 HTML / base64；MVP 只支持原生 Clash YAML 明文，请换用对应格式的订阅链接 |
| `mihomo -t` 提示无法下载 MMDB / Geo 数据 | 订阅含 `GEOIP` / `GEOSITE` 规则时内核需要本地 geodata 文件；CLI 会自动补下到 `.runtime/data/` 后重试校验，也可手动放入 |
| `E_NOT_INITIALIZED` | 先执行 `init` |
| `status` 提示「来自其他机器或路径」 | 正常运行态迁移，PID 与代理快照已隔离，`start` 即可 |
| `E_PROXY_BACKUP_FOREIGN` | 代理备份是别的机器留下的，用 `proxy off --force` 仅关闭代理 |
| `E_DEPS_MISSING` | 源码方式下先在项目目录执行 `npm install` |
| `E_NODE_TOO_OLD` | 源码方式需要 Node.js 16.20.2 或更高；自包含安装不受影响 |
| 开机后连不上网 | 忘了 `proxy off` 就关机，系统代理残留指向已停掉的内核；执行 `metactl fix` 一键恢复，或按上节配置开机自愈 |
| `E_SPEED_NO_KERNEL` | 测速需要内核在跑，先执行 `metactl start` |
| 测速全部节点超时 | 检查节点可用性与 `--url` 是否可达，可调大 `--timeout`；`--json` 的 `failures` 会列出失败节点 |
| `metactl` 命令找不到 | PATH 变更不影响已打开的终端，**重新打开一个新窗口**；仍未生效就用完整路径 `%LOCALAPPDATA%\metactl\current\bin\metactl.cmd`（源码方式用 `node bin\cli.js <命令>`） |
| `install.ps1` 下载失败 / 超时 | `github.com` 在部分网络被阻断；用 `-Mirror <镜像前缀>` 加速，或改用 `-ZipPath <本地包>` |
| `install.ps1` 提示无法获取最新版本 | 网络不通或 GitHub API 限流；改用 `-Version <版本>` 或 `-ZipPath` |
| `install.ps1` 报「无法替换现有安装」 | 有 metactl 命令正在运行；关闭其他终端窗口后重跑 |
| `E_PATH_WRITE` / `E_PATH_TOO_LONG` | 用户 PATH 写入被安全软件/组策略拦截，或 PATH 过长；订阅与配置仍会正常生成。用 `--no-path` / `-NoPath` 跳过，或手动在「编辑账户的环境变量」里清理/添加 |

## 自检与开发

```bat
npm test            :: 运行单元测试（不联网、不启动内核）
npm run scan        :: 扫描源码，禁止出现任何本机硬编码路径或敏感字面量
npm run build:bundle :: 打出自带 Node 运行时的安装包（产物在 dist\）
node bin\cli.js kernel status   :: 查看内核安装信息
node bin\cli.js test           :: 校验真实运行态
```

打包说明：`npm run build:bundle -- --node <node.exe 路径>` 可指定要内置的 Node 运行时（默认用当前进程的 `node.exe`）；产物为目录 + zip，压缩依赖系统自带的 `bsdtar`（Win10 1803+）。

## MVP 明确不做

不打包**单文件** exe（自包含安装已做到「目标机无需 Node」，形态是目录 + 启动器）；不发布到 npm；TUN、服务化、开机自启、WinHTTP / PAC、per-app 代理；base64 订阅、定时更新、多订阅合并、订阅转换；节点选择 / 带宽测速 / 规则编辑 / 流量面板 / external-ui（节点**延迟**测速已由 `speed` 支持）；GUI、国际化；独立的自升级命令（重跑 `install.ps1` 即为升级）；非 Windows 平台；任何复用本机其他客户端内核的方式。
