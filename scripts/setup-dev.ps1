#Requires -Version 5.1
<#
.SYNOPSIS
    Dasktop 开发环境检查与初始化脚本。

.DESCRIPTION
    在新电脑上准备 Dasktop 开发环境。默认只做「只读检查」并打印报告，
    不会修改任何文件；显式传入 -Install 时才会安装缺失依赖、预置打包
    工具链并执行 pnpm install。

    覆盖的检查项：
      - Node.js（要求 >= 20.19.0，与 package.json 的 engines 一致）
      - pnpm（要求 11.x，与 package.json 的 packageManager 字段一致）
      - Rust 工具链（rustup / rustc / cargo，且默认 target 为 MSVC）
      - MSVC 生成工具（Visual Studio 2022 Build Tools，C++ 工作负载）
      - WebView2 Runtime（Tauri 运行与调试的必需运行时）
      - WiX 3.14 与 NSIS 打包工具链缓存（仅构建安装包时需要）

.PARAMETER Install
    在检查基础上执行安装动作：用 winget 装上缺失的 Node / Rust / BuildTools /
    WebView2，并执行 pnpm install。默认关闭，避免误改开发机。

.PARAMETER SkipBundleTools
    跳过 WiX / NSIS 工具链的检查与预置。只做前端与 Rust 调试时可加此参数
    节省时间。

.PARAMETER Proxy
    访问 GitHub 的本地代理地址，例如 http://127.0.0.1:7890。中国大陆网络
    下载 WiX / NSIS / rustup 组件时需要。留空则直连。

.EXAMPLE
    .\scripts\setup-dev.ps1
    只检查环境并打印报告。

.EXAMPLE
    .\scripts\setup-dev.ps1 -Install -Proxy http://127.0.0.1:7890
    检查并补装缺失依赖，走本地代理下载 GitHub 资源。

.NOTES
    编码：本文件必须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1
    会按系统 ANSI 代码页解析，导致中文注释与输出乱码。
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$SkipBundleTools,
    [string]$Proxy = ""
)

# ---------------------------------------------------------------------------
# 常量：与项目配置文件保持一致，避免脚本与工程出现「两份事实」
# ---------------------------------------------------------------------------

# node 版本下限取自 package.json 的 engines.node
$script:RequiredNodeVersion = [version]"20.19.0"
# pnpm 版本取自 package.json 的 packageManager
$script:RequiredPnpmVersion = "11.5.3"
# WiX 目录名固定为 WixTools314，是 tauri-bundler 的硬编码路径，不要改
$script:WixDirName = "WixTools314"
$script:NsisDirName = "NSIS"
# WiX 3.14 官方下载地址（与 tauri-bundler 源码中的 WIX_URL 一致）
$script:WixUrl = "https://github.com/wixtoolset/wix3/releases/download/wix3141rtm/wix314-binaries.zip"
# NSIS 3.11 官方下载地址（与 tauri-bundler 源码一致）
$script:NsisUrl = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip"
# tauri-bundler 缓存的根目录
$script:TauriCacheDir = Join-Path $env:LOCALAPPDATA "tauri"

# ---------------------------------------------------------------------------
# 输出工具：统一中文提示与颜色，避免散落的 Write-Host
# ---------------------------------------------------------------------------

$script:IssueCount = 0

function Write-Title {
    param([string]$Text)
    Write-Host ""
    Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "  [OK]   $Text" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Text)
    Write-Host "  [警告] $Text" -ForegroundColor Yellow
}

function Write-Bad {
    param([string]$Text)
    $script:IssueCount++
    Write-Host "  [缺失] $Text" -ForegroundColor Red
}

function Write-Info {
    param([string]$Text)
    Write-Host "  [信息] $Text" -ForegroundColor Gray
}

function Write-Step {
    param([string]$Text)
    Write-Host "  -> $Text" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------

<#
.SYNOPSIS
    判断命令是否存在于 PATH。
#>
function Test-CommandExists {
    param([string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

<#
.SYNOPSIS
    执行外部命令并返回首行文本；命令不存在或失败时返回空串。

.DESCRIPTION
    把 stderr 一并吞掉，避免 rustup / winget 的提示噪音污染报告输出。
#>
function Invoke-CaptureFirstLine {
    param([string]$Command)
    # @() 包裹是必需的：PowerShell 函数返回单元素数组时会把数组「解包」成
    # 裸字符串，导致随后的 $lines[0] 变成取字符串首字符。用 @() 强制成数组。
    $lines = @(Invoke-CaptureOutput -Command $Command)
    if ($lines.Count -eq 0) {
        return ""
    }
    return $lines[0]
}

<#
.SYNOPSIS
    执行外部命令并返回全部输出行（已去除空行与首尾空白）。

.DESCRIPTION
    部分命令的关键信息不在首行（例如 `rustc -vV` 的 host 在第 2 行），
    因此保留完整输出供调用方自行匹配。

    外部命令的中文输出按系统 ANSI 代码页编码（中文 Windows 为 GBK），
    而当前控制台可能是 UTF-8，直接读取会乱码。这里在读取前后临时切换
    [Console]::OutputEncoding，保证取回的是正确的 Unicode 字符串。
#>
function Invoke-CaptureOutput {
    param([string]$Command)

    $originalEncoding = [Console]::OutputEncoding
    try {
        # GetEncoding(0) 取系统 ANSI 代码页，与 cmd.exe 的默认输出一致
        [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(0)
        $output = & cmd.exe /c "$Command 2>&1"
    } catch {
        return @()
    } finally {
        [Console]::OutputEncoding = $originalEncoding
    }

    if ($null -eq $output) {
        return @()
    }
    $result = @()
    foreach ($line in @($output)) {
        $text = ($line | Out-String).Trim()
        if (-not [string]::IsNullOrWhiteSpace($text)) {
            $result += $text
        }
    }
    # 直接返回数组，由调用方用 @() 包裹承接。
    # 切勿写成 `return , $result`——那会包成嵌套数组，导致调用方拿到
    # @(@(行1,行2,...))，后续 -like / -match 会在内层数组上做过滤而误判。
    return $result
}

<#
.SYNOPSIS
    从形如 "v22.22.2" 或 "22.22.2" 的文本中解析出 [version]。

.DESCRIPTION
    Node 的 `-v` 带 v 前缀，pnpm / rustc 的输出夹带额外文字，统一用正则
    提取第一段 x.y.z，避免各处重复写解析逻辑。
#>
function Get-VersionFromText {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $null
    }
    $match = [regex]::Match($Text, '\d+\.\d+(\.\d+)?')
    if (-not $match.Success) {
        return $null
    }
    $raw = $match.Value
    # [version] 至少需要两段，缺失的部分补 0
    $parts = $raw.Split('.')
    while ($parts.Count -lt 3) {
        $parts += "0"
    }
    try {
        return [version]($parts -join ".")
    } catch {
        return $null
    }
}

<#
.SYNOPSIS
    检查单个依赖项，返回是否通过。

.DESCRIPTION
    把「检测 → 打印结果 → 给出修复提示」收在一处，让主流程保持线性可读。
    检测函数通过 -Detector 脚本块注入，便于复用同一套输出格式。
#>
function Test-Requirement {
    param(
        [string]$Name,
        [scriptblock]$Detector,
        [string]$FixHint
    )

    $result = & $Detector
    if ($result.Passed) {
        Write-Ok "$Name — $($result.Detail)"
        return $true
    }

    Write-Bad "$Name — $($result.Detail)"
    if (-not [string]::IsNullOrWhiteSpace($FixHint)) {
        Write-Info "修复：$FixHint"
    }
    return $false
}

# ---------------------------------------------------------------------------
# 各项依赖的检测逻辑
# ---------------------------------------------------------------------------

function Test-NodeJs {
    if (-not (Test-CommandExists "node")) {
        return @{ Passed = $false; Detail = "未安装（要求 >= $script:RequiredNodeVersion）" }
    }
    $version = Get-VersionFromText (Invoke-CaptureFirstLine "node -v")
    if ($null -eq $version) {
        return @{ Passed = $false; Detail = "无法解析版本号" }
    }
    if ($version -lt $script:RequiredNodeVersion) {
        return @{ Passed = $false; Detail = "版本过低 v$version（要求 >= $script:RequiredNodeVersion）" }
    }
    return @{ Passed = $true; Detail = "v$version" }
}

function Test-Pnpm {
    if (-not (Test-CommandExists "pnpm")) {
        return @{ Passed = $false; Detail = "未安装（要求 $script:RequiredPnpmVersion）" }
    }
    $version = Get-VersionFromText (Invoke-CaptureFirstLine "pnpm -v")
    if ($null -eq $version) {
        return @{ Passed = $false; Detail = "无法解析版本号" }
    }
    # 只要求 major.minor 匹配：patch 位差异不影响 lockfile 兼容性
    $expected = Get-VersionFromText $script:RequiredPnpmVersion
    if ($version.Major -ne $expected.Major -or $version.Minor -ne $expected.Minor) {
        return @{ Passed = $false; Detail = "版本不匹配 v$version（packageManager 要求 $script:RequiredPnpmVersion）" }
    }
    return @{ Passed = $true; Detail = "v$version" }
}

function Test-RustToolchain {
    if (-not (Test-CommandExists "rustc") -or -not (Test-CommandExists "cargo")) {
        return @{ Passed = $false; Detail = "未安装 rustc/cargo" }
    }
    $rustcVersion = Invoke-CaptureFirstLine "rustc -V"
    # rustc -vV 输出多行，其中一行形如 "host: x86_64-pc-windows-msvc"，
    # 必须遍历全部行才能取到 host——首行只是版本号。
    # @() 同 Invoke-CaptureFirstLine：避免单行输出被解包成字符串。
    $verboseLines = @(Invoke-CaptureOutput -Command "rustc -vV")
    $hostLine = ""
    foreach ($line in $verboseLines) {
        if ($line -like "host:*") {
            $hostLine = $line
            break
        }
    }
    if ([string]::IsNullOrWhiteSpace($hostLine)) {
        return @{ Passed = $false; Detail = "无法读取 rustc host 信息（rustc -vV 输出异常）" }
    }
    if ($hostLine -notmatch "windows-msvc") {
        return @{ Passed = $false; Detail = "默认 target 非 MSVC（$hostLine），Tauri 需要 x86_64-pc-windows-msvc" }
    }
    if (-not (Test-CommandExists "rustup")) {
        Write-Warn "未检测到 rustup，后续无法用 rustup 管理工具链"
    }
    return @{ Passed = $true; Detail = $rustcVersion }
}

function Test-MsvcBuildTools {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        return @{ Passed = $false; Detail = "未找到 vswhere.exe，通常意味着未安装 Visual Studio Build Tools" }
    }
    # 用 installationVersion（纯 ASCII）而非 displayName 做展示，
    # 规避不同代码页下中文产品名乱码的问题
    $version = Invoke-CaptureFirstLine "`"$vswhere`" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion"
    if ([string]::IsNullOrWhiteSpace($version)) {
        return @{ Passed = $false; Detail = "已装 Visual Studio，但缺少 C++ 生成工具工作负载" }
    }
    return @{ Passed = $true; Detail = "Build Tools $version（含 C++ 生成工具）" }
}

function Test-WebView2Runtime {
    # WebView2 由 EdgeUpdate 客户端注册，键名不固定，需遍历查找
    $clients = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients"
    if (-not (Test-Path $clients)) {
        return @{ Passed = $false; Detail = "未在注册表中找到 WebView2 记录" }
    }
    foreach ($key in Get-ChildItem $clients -ErrorAction SilentlyContinue) {
        $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
        if ($null -ne $props -and $props.name -like "*WebView2*") {
            return @{ Passed = $true; Detail = "Runtime $($props.pv)" }
        }
    }
    return @{ Passed = $false; Detail = "未安装 WebView2 Runtime" }
}

<#
.SYNOPSIS
    检查打包工具链缓存是否就位。

.DESCRIPTION
    Tauri 在首次执行 `tauri build` 时会从 GitHub 下载 WiX 3.14 与 NSIS。
    国内网络下这一步极易超时，提前预置可以避开。此处只做检测，实际
    下载由 Install-BundleTools 完成。
#>
function Test-BundleTools {
    $wixDir = Join-Path $script:TauriCacheDir $script:WixDirName
    $nsisDir = Join-Path $script:TauriCacheDir $script:NsisDirName

    $wixReady = (Test-Path (Join-Path $wixDir "candle.exe")) -and (Test-Path (Join-Path $wixDir "light.exe"))
    $nsisReady = Test-Path (Join-Path $nsisDir "makensis.exe")

    if ($wixReady) {
        Write-Ok "WiX 3.14 — $wixDir"
    } else {
        Write-Warn "WiX 3.14 未预置（首次构建 MSI 时会联网下载，国内较慢）"
        Write-Info "预置：$wixDir"
    }

    if ($nsisReady) {
        Write-Ok "NSIS — $nsisDir"
    } else {
        Write-Warn "NSIS 未预置（首次构建 NSIS 安装包时会联网下载）"
        Write-Info "预置：$nsisDir"
    }

    # 打包工具缺失不算「阻断开发」的硬问题，不累加 IssueCount
    return ($wixReady -and $nsisReady)
}

# ---------------------------------------------------------------------------
# 安装动作（仅在 -Install 时执行）
# ---------------------------------------------------------------------------

<#
.SYNOPSIS
    通过 winget 安装指定包，已安装则跳过。
#>
function Install-WithWinget {
    param(
        [string]$PackageId,
        [string]$DisplayName,
        [string]$ExtraArgs = ""
    )

    if (-not (Test-CommandExists "winget")) {
        Write-Warn "未找到 winget，无法自动安装 $DisplayName，请手动安装"
        return $false
    }

    Write-Step "winget install $PackageId"
    $command = "winget install --id $PackageId --accept-source-agreements --accept-package-agreements --silent $ExtraArgs"
    & cmd.exe /c $command
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "$DisplayName 安装完成（可能需要重开终端才能生效）"
        return $true
    }

    Write-Warn "$DisplayName 安装返回码 $LASTEXITCODE，请检查输出"
    return $false
}

<#
.SYNOPSIS
    下载并解压打包工具链到 Tauri 缓存目录。

.DESCRIPTION
    解压后必须是「扁平结构」——candle.exe 等直接位于 WixTools314 目录下，
    不能多一层子目录，否则 tauri-bundler 找不到文件会重复下载。

    参数 -Proxy 用于指定 GitHub 代理；这里显式走 curl.exe（Windows 10+
    自带），避免 Invoke-WebRequest 在旧版本上不支持代理 TLS 的问题。
#>
function Install-BundleTools {
    if (-not (Test-Path $script:TauriCacheDir)) {
        New-Item -ItemType Directory -Path $script:TauriCacheDir -Force | Out-Null
    }

    $proxyArgs = @()
    if (-not [string]::IsNullOrWhiteSpace($Proxy)) {
        $proxyArgs = @("-x", $Proxy)
        Write-Info "使用代理：$Proxy"
    }

    # --- WiX ---
    $wixDir = Join-Path $script:TauriCacheDir $script:WixDirName
    if (-not (Test-Path (Join-Path $wixDir "candle.exe"))) {
        $zip = Join-Path $env:TEMP "wix314-binaries.zip"
        Write-Step "下载 WiX 3.14 ..."
        & curl.exe @proxyArgs -L -o $zip $script:WixUrl
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "WiX 下载失败（返回码 $LASTEXITCODE），请检查网络或代理"
        } else {
            Write-Step "解压到 $wixDir"
            if (Test-Path $wixDir) { Remove-Item $wixDir -Recurse -Force }
            Expand-Archive -LiteralPath $zip -DestinationPath $wixDir -Force
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
            if (Test-Path (Join-Path $wixDir "candle.exe")) {
                Write-Ok "WiX 3.14 预置完成"
            } else {
                Write-Warn "解压后未找到 candle.exe，目录结构可能不符预期，请手动检查"
            }
        }
    } else {
        Write-Ok "WiX 3.14 已就位，跳过下载"
    }

    # --- NSIS ---
    $nsisDir = Join-Path $script:TauriCacheDir $script:NsisDirName
    if (-not (Test-Path (Join-Path $nsisDir "makensis.exe"))) {
        $zip = Join-Path $env:TEMP "nsis-3.11.zip"
        Write-Step "下载 NSIS 3.11 ..."
        & curl.exe @proxyArgs -L -o $zip $script:NsisUrl
        if ($LASTEXITCODE -ne 0) {
            Write-Warn "NSIS 下载失败（返回码 $LASTEXITCODE），请检查网络或代理"
        } else {
            Write-Step "解压到 $nsisDir"
            if (Test-Path $nsisDir) { Remove-Item $nsisDir -Recurse -Force }
            Expand-Archive -LiteralPath $zip -DestinationPath $nsisDir -Force
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
            if (Test-Path (Join-Path $nsisDir "makensis.exe")) {
                Write-Ok "NSIS 3.11 预置完成"
            } else {
                Write-Warn "解压后未找到 makensis.exe，请手动检查目录结构"
            }
        }
    } else {
        Write-Ok "NSIS 已就位，跳过下载"
    }
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $projectRoot "package.json"))) {
    Write-Host "错误：未能在 $projectRoot 找到 package.json，请从仓库内运行本脚本" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Dasktop 开发环境检查" -ForegroundColor White
Write-Host "项目目录：$projectRoot" -ForegroundColor Gray
if ($Install) {
    Write-Host "模式：检查 + 安装（-Install）" -ForegroundColor Yellow
} else {
    Write-Host "模式：仅检查（只读，不改动任何文件）" -ForegroundColor Gray
}

Write-Title "运行时依赖"

# 每项只检测一次并记录结果，供后续 -Install 分支决定是否补装
# Node：版本过低时 vite 8 无法启动
$nodeOk = Test-Requirement -Name "Node.js" -Detector { Test-NodeJs } `
    -FixHint "winget install OpenJS.NodeJS.LTS（或从 nodejs.org 安装 LTS）"
# pnpm：版本由 corepack 按 packageManager 字段锁定
$pnpmOk = Test-Requirement -Name "pnpm" -Detector { Test-Pnpm } `
    -FixHint "corepack enable; corepack prepare pnpm@$script:RequiredPnpmVersion --activate"
# Rust：需要 MSVC target，GNU target 无法链接 WebView2
$rustOk = Test-Requirement -Name "Rust 工具链" -Detector { Test-RustToolchain } `
    -FixHint "winget install Rustlang.Rustup；安装后执行 rustup default stable-x86_64-pc-windows-msvc"
$msvcOk = Test-Requirement -Name "MSVC 生成工具" -Detector { Test-MsvcBuildTools } `
    -FixHint 'winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
$webviewOk = Test-Requirement -Name "WebView2 Runtime" -Detector { Test-WebView2Runtime } `
    -FixHint "Win11 通常已内置；缺失可从 developer.microsoft.com/microsoft-edge/webview2 安装 Evergreen Runtime"

if (-not $SkipBundleTools) {
    Write-Title "打包工具链（构建安装包时需要）"
    Test-BundleTools | Out-Null
}

Write-Title "项目依赖"

$nodeModulesDir = Join-Path $projectRoot "node_modules"
if (Test-Path $nodeModulesDir) {
    Write-Ok "node_modules 已存在"
} else {
    Write-Warn "node_modules 不存在，需要执行 pnpm install"
    Write-Info "执行：pnpm install"
}

$distDir = Join-Path $projectRoot "dist"
if (Test-Path $distDir) {
    Write-Ok "dist/ 已存在（可用于生产构建）"
} else {
    Write-Warn "dist/ 不存在；dev 模式不影响，生产构建前需执行 pnpm build"
}

# --- 安装动作 ---
if ($Install) {
    Write-Title "执行安装"

    if (-not $nodeOk) {
        Install-WithWinget -PackageId "OpenJS.NodeJS.LTS" -DisplayName "Node.js LTS" | Out-Null
    }
    if (-not $rustOk) {
        Install-WithWinget -PackageId "Rustlang.Rustup" -DisplayName "Rustup" | Out-Null
    }
    if (-not $msvcOk) {
        Install-WithWinget -PackageId "Microsoft.VisualStudio.2022.BuildTools" -DisplayName "Visual Studio 2022 Build Tools" `
            -ExtraArgs '--override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' | Out-Null
    }
    if (-not $webviewOk) {
        Install-WithWinget -PackageId "Microsoft.EdgeWebView2Runtime" -DisplayName "WebView2 Runtime" | Out-Null
    }
    if (-not $pnpmOk) {
        if (Test-CommandExists "corepack") {
            Write-Step "corepack enable && corepack prepare pnpm@$script:RequiredPnpmVersion --activate"
            & cmd.exe /c "corepack enable && corepack prepare pnpm@$script:RequiredPnpmVersion --activate"
        } else {
            Write-Warn "未找到 corepack（需 Node 16.13+），请手动安装 pnpm"
        }
    }

    if (-not $SkipBundleTools) {
        Install-BundleTools
    }

    # 依赖安装必须显式触发：脚本不会自动猜用户想不想装
    Write-Step "pnpm install"
    Push-Location $projectRoot
    try {
        & cmd.exe /c "pnpm install"
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "依赖安装完成"
        } else {
            Write-Warn "pnpm install 返回码 $LASTEXITCODE，请检查上方输出"
        }
    } finally {
        Pop-Location
    }
}

# --- 汇总 ---
Write-Title "结果"

if ($script:IssueCount -eq 0) {
    Write-Host "  运行时依赖齐全，可以开始开发。" -ForegroundColor Green
} else {
    Write-Host "  发现 $script:IssueCount 项缺失，请按上方提示处理后重跑本脚本。" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "后续步骤：" -ForegroundColor White
$step = 1
if (-not (Test-Path $nodeModulesDir)) {
    Write-Host "  $step. pnpm install" -ForegroundColor Gray
    $step++
}
Write-Host "  $step. pnpm tauri dev        # 启动开发调试" -ForegroundColor Gray
$step++
Write-Host "  $step. pnpm build && pnpm tauri build   # 产出 exe / msi / nsis 安装包" -ForegroundColor Gray
Write-Host ""
Write-Host "更多说明见 docs/development.md" -ForegroundColor Gray
Write-Host ""

# 有硬缺失时以非 0 退出，便于 CI 或批处理判断
if ($script:IssueCount -gt 0) {
    exit 1
}
exit 0
