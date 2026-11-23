# metactl

Windows 上管理 [mihomo (Clash.Meta)](https://github.com/MetaCubeX/mihomo) 内核的命令行工具。添加订阅、启停内核、开关系统代理、节点延迟测速。

## 安装

两种方式任选其一。**装完重新打开一个终端，就能直接敲 `metactl`。**

### 方式一：一行安装（目标机不需要 Node.js）

```powershell
irm https://raw.githubusercontent.com/CosmicHourglass/metactl/main/install.ps1 | iex
```

安装包自带 Node 运行时和 mihomo 内核，安装脚本把内核直接落盘，并把命令目录写入用户 PATH —— 全程不需要连 MetaCubeX 的 GitHub。

### 方式二：npm 全局安装（已有 Node.js 16.20.2+）

```bat
npm i -g metactl
```

安装包同样自带 mihomo 内核，安装过程会把内核落到数据目录，并把 npm 全局命令目录写入用户 PATH。

> 两种方式都只改当前用户的 PATH，**不需要管理员权限**，也不影响其他用户。

## 快速开始

```bat
metactl init --sub "https://example.com/sub/<token>/clash#MySub"
metactl start
metactl proxy on
```

用完 / 关机前：

```bat
metactl proxy off
metactl stop
```

忘了 `proxy off` 就关机，下次开机连不上网时执行 `metactl fix` 一键恢复。

## 命令

| 命令 | 说明 |
| --- | --- |
| `init --sub <地址>` | 添加订阅：拉取订阅、生成并校验配置（首次必填，之后可省略） |
| `start` / `stop` / `restart` | 启停内核（不自动改系统代理） |
| `status` | 查看内核、进程、控制器与代理状态 |
| `proxy on` / `proxy off` | 开启系统代理并备份原值 / 精确恢复 |
| `fix` | 断网自救：清除关机残留的代理，幂等可反复执行 |
| `speed` | 节点延迟测速排行（按节点测、默认超时 10000 ms、测试地址取订阅健康检查地址；`--limit 10`、`--group <名称>`、`--url <地址>`、`--timeout <ms>`、`--json`） |
| `route` | 查看当前代理路线：系统代理指向、分流模式、策略组选中、活跃连接命中的规则与链路 |
| `kernel status` | 查看内核版本与校验信息 |
| `kernel install` / `kernel update` | 补装 / 升级内核（联网从 MetaCubeX 官方 release 获取） |
| `test` | 自检运行态（内核、配置、端口、控制器） |
| `version` | 显示工具与运行环境信息 |
| `uninstall` | 卸载：恢复系统代理原值、删内核、移除 PATH 并删除程序目录（`--purge` 连订阅与配置一起删） |

全局选项：`--json`（机器可读输出）、`--quiet`、`-v, --verbose`、`--home <目录>`（改运行态位置）、`-h, --help`。

## 系统代理

改的是当前用户的 `HKCU\...\Internet Settings` 三个键，无需管理员。内核未运行时 `proxy on` 会拒绝执行，避免把流量指向不存在的端口。

Node、curl、git 默认**不读** Windows 系统代理，验证请用浏览器，或 `curl.exe -x http://127.0.0.1:17890 https://example.com`。

## 数据位置

| 安装方式 | 运行态目录 |
| --- | --- |
| 一行安装 / npm 全局 | `%LOCALAPPDATA%\metactl\.runtime` |
| 项目目录内运行 | 项目目录下的 `.runtime\` |

里面是订阅快照、生成的配置、内核、日志与状态，可用 `--home <目录>` 覆盖。升级只替换程序目录，数据保留。

> `.runtime\` 含订阅 token 和控制器密钥，**不要提交、打包外发或公开分享**。

## 卸载

```bat
metactl uninstall                  # 保留订阅快照与配置
metactl uninstall --purge          # 连订阅快照与配置一起删除
```

卸载会恢复系统代理原值、删除内核、移除 PATH 并删除程序目录。内核正在运行时会拒绝执行，先 `metactl stop`。

也可以用安装脚本卸载：`.\install.ps1 -Uninstall`（加 `-Purge` 连数据一起删）。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 敲 `metactl` 提示找不到 | **重新打开一个新终端**；PATH 变更不会作用于已开着的窗口 |
| 开机后连不上网 | 忘了 `proxy off` 就关机，执行 `metactl fix` |
| `E_KERNEL_NOT_INSTALLED` | 重新安装，或执行 `metactl kernel install` |
| `E_PORT_IN_USE` | 改 `.runtime/config.json` 的 `ports` 段后重新 `init` |
| `E_SUB_INVALID_YAML` | 只支持原生 Clash YAML 明文订阅，请换对应格式的订阅链接 |
| `metactl` 命令被拦 / PATH 写入失败 | 在普通 cmd / PowerShell 终端运行；组策略拦截时手动把命令目录加入用户 PATH |

## 开发

```bat
npm test              :: 单元测试（不联网、不启内核）
npm run scan          :: 禁止本机硬编码路径与敏感字面量
npm run stage:kernel  :: 把本地 mihomo 内核暂存到 assets/（打包分发用）
npm run build:bundle  :: 打自带 Node 运行时与内核的安装包
npm run build:install :: 由 install-core.ps1 重新生成 install.ps1
```

## 致谢与许可证

本项目以 **GPL-3.0** 发布，源码见 [LICENSE](./LICENSE)。

- 内核 [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo)：A rule-based tunnel in Go。
  随安装包分发的 `mihomo-metactl.exe` 就是该项目的官方 release 产物（改名以区分来源），版权归其作者所有，同样以 GPL-3.0 发布。
  具体版本见 `metactl kernel status`，对应源码见该项目的 [Releases](https://github.com/MetaCubeX/mihomo/releases) 页面上的同名标签。
- 本工具的代码与安装脚本版权归 metactl 项目作者所有，以 GPL-3.0 发布。
