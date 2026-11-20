<#
.SYNOPSIS
    安装 metactl —— 自带 Node 运行时，目标机不需要安装 Node.js。

.DESCRIPTION
    公开仓库可直接一行安装：
      irm https://raw.githubusercontent.com/<owner>/metactl/main/install.ps1 | iex

    需要传参数时（iex 无法透传参数），先取脚本再执行：
      $s = irm https://raw.githubusercontent.com/<owner>/metactl/main/install.ps1
      & ([scriptblock]::Create($s)) -Mirror https://gh-proxy.com/

    用本地安装包（离线 / 私有仓库）：
      .\install.ps1 -ZipPath .\metactl-0.2.0-win32-x64.zip

    卸载：
      .\install.ps1 -Uninstall          # 保留配置与内核
      .\install.ps1 -Uninstall -Purge   # 连运行态数据一起删除

.PARAMETER Version
    指定版本（带不带 v 前缀都可以）；默认取最新 Release。

.PARAMETER Mirror
    下载加速前缀，拼在 GitHub 地址之前，例如 https://gh-proxy.com/

.PARAMETER InstallDir
    安装根目录，默认 %LOCALAPPDATA%\metactl。

.PARAMETER ZipPath
    使用本地 zip 安装，跳过网络下载。

.PARAMETER SkipKernel
    只装程序，不下载 mihomo 内核（之后可执行 metactl kernel install）。

.PARAMETER NoPath
    不修改用户 PATH，只打印需要添加的目录。
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$Mirror = '',
    [string]$InstallDir = '',
    [string]$ZipPath = '',
    [switch]$SkipKernel,
    [switch]$NoPath,
    [switch]$Uninstall,
    [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# 固定输出编码：GBK/UTF-8 混用的环境里中文才不会时好时坏
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$Repo = 'CosmicHourglass/metactl'
$Target = 'win32-x64'
$InstallDir = if ($InstallDir) { $InstallDir } else { Join-Path $env:LOCALAPPDATA 'metactl' }
$CurrentDir = Join-Path $InstallDir 'current'
$BinDir = Join-Path $CurrentDir 'bin'
$DataDir = Join-Path $InstallDir '.runtime'

function Write-Step([string]$Message) { Write-Host $Message }

function Get-UserPathItems([string]$Value) {
    if (-not $Value) { return @() }
    return @($Value -split ';' | Where-Object { $_.Trim() })
}

function Test-PathItem([string[]]$Items, [string]$Dir) {
    $norm = $Dir.TrimEnd('\')
    foreach ($i in $Items) { if ($i.TrimEnd('\') -ieq $norm) { return $true } }
    return $false
}

function Resolve-LatestVersion {
    try {
        $req = [System.Net.HttpWebRequest]::Create("https://github.com/$Repo/releases/latest")
        $req.Method = 'HEAD'
        $req.AllowAutoRedirect = $false
        $req.UserAgent = 'metactl-install'
        $req.Timeout = 15000
        $resp = $req.GetResponse()
        try {
            if ($resp.Headers['Location'] -match '/releases/tag/([^/?#]+)') {
                return [Uri]::UnescapeDataString($Matches[1])
            }
        } finally { $resp.Close() }
    } catch { }

    try {
        $api = 'https://api.github.com/repos/' + $Repo + '/releases/latest'
        $r = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'metactl-install' } -TimeoutSec 20
        if ($r.tag_name) { return $r.tag_name }
    } catch { }

    throw "无法获取最新版本。可能是网络不通或仓库为私有：请改用 -Version <版本号> 或 -ZipPath <本地包>。"
}

function Download-Package([string]$Url, [string]$Destination) {
    Write-Step "下载 $Url"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -TimeoutSec 600 -UseBasicParsing
    } catch {
        $msg = $_.Exception.Message
        throw "下载失败：$msg`n受限网络可加 -Mirror <镜像前缀>，或改用 -ZipPath <本地包>。"
    }
    $size = (Get-Item -LiteralPath $Destination).Length
    if ($size -lt 5MB) { throw "下载的文件过小（$size 字节），可能不是有效安装包。" }
    return $size
}

function Get-ExpandedPackage([string]$Zip, [string]$Staging) {
    if (Test-Path -LiteralPath $Staging) { Remove-Item -LiteralPath $Staging -Recurse -Force }
    New-Item -ItemType Directory -Path $Staging -Force | Out-Null
    try {
        # 用 .NET 解压：比 Expand-Archive 快很多，也不产生进度条噪音
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Staging)
    } catch {
        throw "解压失败（安装包可能已损坏）：$($_.Exception.Message)"
    }
    # 包内应有一个顶层目录；有就进去，没有就直接用 staging。
    $dirs = @(Get-ChildItem -LiteralPath $Staging -Directory)
    $files = @(Get-ChildItem -LiteralPath $Staging -File)
    if ($files.Count -eq 0 -and $dirs.Count -eq 1) { return $dirs[0].FullName }
    return $Staging
}

function Assert-Package([string]$Source) {
    foreach ($need in @('node.exe', 'bundle.json', 'bin\metactl.cmd', 'bin\cli.js', 'src', 'node_modules')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Source $need))) {
            throw "安装包不完整（缺少 $need），未做任何改动。"
        }
    }
}

function Install-Program([string]$Source, [string]$Dest, [string]$Root) {
    $stamp = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $aside = Join-Path $Root "current.old-$stamp"
    $hadAside = $false

    if (Test-Path -LiteralPath $Dest) {
        # 优先直接删除：没有正在运行的 node.exe 时最干净，不留任何残留
        try {
            [System.IO.Directory]::Delete($Dest, $true)
        } catch {
            # 删不掉通常是有 metactl 进程正占用 node.exe；改名让位，装完再清理
            try {
                [System.IO.Directory]::Move($Dest, $aside)
                $hadAside = $true
            } catch {
                throw "无法替换现有安装（可能有 metactl 命令正在运行）。请关闭其他终端窗口后重试。"
            }
        }
    }
    try {
        [System.IO.Directory]::Move($Source, $Dest)
    } catch {
        if ($hadAside -and (Test-Path -LiteralPath $aside) -and -not (Test-Path -LiteralPath $Dest)) {
            [System.IO.Directory]::Move($aside, $Dest)
        }
        throw "安装失败，已保留原版本：$($_.Exception.Message)"
    }
    if ($hadAside -and (Test-Path -LiteralPath $aside)) {
        try { Remove-Item -LiteralPath $aside -Recurse -Force -ErrorAction Stop }
        catch { Write-Warning "旧版本目录未能删除（不影响使用，可稍后手动删除）：$aside" }
    }
}

function Set-UserPath([string]$Dir) {
    # 失败只警告：程序已经装好了，不该因为环境变量写不进去就整体失败
    try {
        $raw = [Environment]::GetEnvironmentVariable('Path', 'User')
        $items = Get-UserPathItems $raw
        if (Test-PathItem $items $Dir) {
            Write-Step "用户 PATH 中已包含 $Dir"
            return
        }
        # 前置插入：避免旧版本（如 npm 全局包）抢先命中
        $next = if ($raw) { "$Dir;$raw" } else { $Dir }
        [Environment]::SetEnvironmentVariable('Path', $next, 'User')
        Write-Step "已将 $Dir 加入用户 PATH（新开终端后生效）"
    } catch {
        Write-Warning "无法写入用户 PATH：$($_.Exception.Message)"
        Write-Warning "程序已可用，请手动把下面的目录加入用户 PATH：$Dir"
    }
}

function Remove-UserPath([string]$Dir) {
    $raw = [Environment]::GetEnvironmentVariable('Path', 'User')
    $items = Get-UserPathItems $raw
    $norm = $Dir.TrimEnd('\')
    $kept = @($items | Where-Object { $_.TrimEnd('\') -ine $norm })
    if ($kept.Count -eq $items.Count) {
        Write-Step "用户 PATH 中未找到 $Dir，无需移除"
        return
    }
    [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
    Write-Step "已从用户 PATH 移除 $Dir"
}

function Show-ShadowWarning {
    $expected = Join-Path $BinDir 'metactl.cmd'
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $fresh = ((@($machine, $user) | Where-Object { $_ }) -join ';')
    foreach ($pathStr in @($fresh, $env:Path)) {
        foreach ($dir in ($pathStr -split ';')) {
            if (-not $dir) { continue }
            foreach ($leaf in @('metactl.cmd', 'metactl.exe', 'metactl.bat')) {
                $cand = Join-Path $dir $leaf
                if (Test-Path -LiteralPath $cand) {
                    if ($cand -ine $expected) {
                        Write-Warning "PATH 中还有另一个 metactl 会抢先运行：$cand"
                        Write-Warning "本次安装位置：$expected"
                        Write-Warning "若 metactl version 显示的不是新版本，请移除旧的那份或调整 PATH 顺序。"
                    }
                    return
                }
            }
        }
    }
}

# ---------------- 卸载 ----------------
if ($Uninstall) {
    if (Test-Path -LiteralPath $CurrentDir) {
        Remove-Item -LiteralPath $CurrentDir -Recurse -Force
        Write-Step "已删除 $CurrentDir"
    } else {
        Write-Step "未找到已安装的程序目录，跳过"
    }
    Remove-UserPath $BinDir
    if ($Purge) {
        if (Test-Path -LiteralPath $DataDir) {
            Remove-Item -LiteralPath $DataDir -Recurse -Force
            Write-Step "已删除运行态数据 $DataDir（含订阅快照与内核）"
        }
    } elseif (Test-Path -LiteralPath $DataDir) {
        Write-Step "运行态数据保留在 $DataDir（含订阅 token 与内核），如需彻底清理：-Uninstall -Purge"
    }
    return
}

# ---------------- 安装 ----------------
if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'metactl 目前只提供 64 位 Windows 安装包。'
}

$resolved = $Version
if (-not $ZipPath -and -not $resolved) { $resolved = Resolve-LatestVersion }
$bareVersion = if ($resolved) { $resolved -replace '^[vV]', '' } else { '' }
$tag = if ($resolved) { if ($resolved -match '^[vV]') { $resolved } else { "v$resolved" } } else { '' }

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$staging = Join-Path $InstallDir ('.staging-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$tempZip = $null

try {
    if ($ZipPath) {
        $zip = (Resolve-Path -LiteralPath $ZipPath).ProviderPath
        Write-Step "使用本地安装包 $zip"
    } else {
        $asset = "metactl-$bareVersion-$Target.zip"
        $url = "https://github.com/$Repo/releases/download/$tag/$asset"
        if ($Mirror) {
            $url = $Mirror.TrimEnd('/') + '/' + $url
            Write-Step "通过镜像下载：$Mirror"
        }
        $tempZip = Join-Path $env:TEMP ('metactl-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.zip')
        $size = Download-Package $url $tempZip
        Write-Step ("下载完成 {0:N1} MB" -f ($size / 1MB))
        $zip = $tempZip
    }

    $source = Get-ExpandedPackage $zip $staging
    Assert-Package $source
    # 以包内元数据为准：-ZipPath 场景没有版本号来源，靠它补齐
    try {
        $meta = Get-Content -LiteralPath (Join-Path $source 'bundle.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($meta.version) { $bareVersion = $meta.version }
    } catch { }
    Write-Step "校验通过，正在安装 metactl $bareVersion 到 $CurrentDir"
    Install-Program $source $CurrentDir $InstallDir
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
} finally {
    if ($tempZip -and (Test-Path -LiteralPath $tempZip)) {
        Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
    }
}

if (-not $NoPath) {
    Set-UserPath $BinDir
    Show-ShadowWarning
} else {
    Write-Step "按 -NoPath 未修改 PATH。需要时手动加入：$BinDir"
}

$launcher = Join-Path $BinDir 'metactl.cmd'
Write-Step "已安装 metactl $bareVersion 到 $CurrentDir"

if (-not $SkipKernel) {
    Write-Step '正在安装 mihomo 内核（约 22 MB，受限网络可能需要几分钟）...'
    if ($Mirror) { $env:METACTL_MIRROR = $Mirror }
    & $launcher kernel install
    if ($LASTEXITCODE -ne 0) {
        Write-Warning '内核安装未成功。稍后可在新终端执行：metactl kernel install'
    }
} else {
    Write-Step '按 -SkipKernel 跳过内核。稍后执行：metactl kernel install'
}

Write-Host @"

安装完成。请新开一个终端，然后运行：
  metactl init --sub <你的订阅地址>
  metactl start

程序目录：$CurrentDir
数据目录：$DataDir
"@
