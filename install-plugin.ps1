# 把 cc-bridge 装进**独立特色 profile**，不改现有的 dsh-tui / headless / web。
#
# 这是整窗替换（橙色女仆 + factory），不是日常用法。
# 日常：dsh plugin --profile dsh-tui add <本仓库>，然后普通开 dsh-tui 打 /ccb。
#
#   .\install-plugin.ps1              # 只装 headless 测试 profile
#   .\install-plugin.ps1 -WithTui     # 再装一份带 dsh-tui 的特色整窗 profile
#   .\uninstall-plugin.ps1            # 整目录删掉这两个 profile
#
# 不会：
#   · 改 ~/.dsh/profiles/{dsh-tui,dsh-tui-safe,headless,web}
#   · 改 ~/.dsh-tui、claude 的配置、全局 npm 包
#   · 写 ~/.dsh/cc-bridge（测试状态走仓库里的 .tmp-plugin-test/）

[CmdletBinding()]
param(
    [switch]$WithTui,
    [string]$HeadlessProfile = 'cc-bridge-headless',
    [string]$TuiProfile = 'cc-bridge-tui'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$profilesRoot = Join-Path $HOME '.dsh\profiles'
$protected = @('dsh-tui', 'dsh-tui-safe', 'headless', 'web')

function Assert-Isolated([string]$name) {
    if ($protected -contains $name) {
        throw "拒绝往受保护 profile 上装：$name"
    }
}

function Get-PkgHash([string]$name) {
    $p = Join-Path $profilesRoot $name 'package.json'
    if (-not (Test-Path $p)) { return $null }
    (Get-FileHash $p -Algorithm SHA256).Hash
}

Write-Host '安装前核对照片（这几个 profile 不能被改）：' -ForegroundColor DarkGray
$before = @{}
foreach ($n in $protected) {
    $h = Get-PkgHash $n
    $before[$n] = $h
    Write-Host ("  {0}: {1}" -f $n, $(if ($h) { $h.Substring(0, 12) } else { '(不存在)' }))
}

Assert-Isolated $HeadlessProfile
Assert-Isolated $TuiProfile

# ── headless 测试 profile ────────────────────────────────────────────
$headlessDir = Join-Path $profilesRoot $HeadlessProfile
if (-not (Test-Path (Join-Path $headlessDir 'package.json'))) {
    Write-Host "创建 profile $HeadlessProfile（从 headless 模板）…" -ForegroundColor Cyan
    dsh --profile $HeadlessProfile --from-default-profile headless --dump-config | Out-Null
} else {
    Write-Host "profile $HeadlessProfile 已存在，跳过创建" -ForegroundColor DarkGray
}

Write-Host "dsh plugin --profile $HeadlessProfile add $here" -ForegroundColor Cyan
dsh plugin --profile $HeadlessProfile add $here
if ($LASTEXITCODE -ne 0) { throw "plugin add 失败（headless），exit=$LASTEXITCODE" }

# 默认组合包只插 host 面。独立 profile 要整窗 Claude，用户层必须禁 agent-loop。
# headless 没有 dsh-tui 行，用核心 overlay（不要拷窗口那份，否则会 warn 找不到 dsh-tui）。
$coreOverlay = Join-Path $here 'probe-core-only.yml'
$windowOverlay = Join-Path $here 'cordis.patch.yml'
Copy-Item -LiteralPath $coreOverlay -Destination (Join-Path $headlessDir 'cordis.patch.yml') -Force

# ── 可选：带 TUI 的 profile（只为验证组合，默认不开窗）────────────────
if ($WithTui) {
    Assert-Isolated $TuiProfile
    $tuiDir = Join-Path $profilesRoot $TuiProfile
    if (-not (Test-Path (Join-Path $tuiDir 'package.json'))) {
        Write-Host "创建 profile $TuiProfile 并装 dsh-tui…" -ForegroundColor Cyan
        dsh plugin --profile $TuiProfile add '@deepseek-harness-tui/dsh-tui'
        if ($LASTEXITCODE -ne 0) { throw "plugin add dsh-tui 失败，exit=$LASTEXITCODE" }
    }
    Write-Host "dsh plugin --profile $TuiProfile add $here" -ForegroundColor Cyan
    dsh plugin --profile $TuiProfile add $here
    if ($LASTEXITCODE -ne 0) { throw "plugin add 失败（tui），exit=$LASTEXITCODE" }
    Copy-Item -LiteralPath $windowOverlay -Destination (Join-Path $tuiDir 'cordis.patch.yml') -Force
}

Write-Host ''
Write-Host '安装后核对照片：' -ForegroundColor DarkGray
foreach ($n in $protected) {
    $h = Get-PkgHash $n
    if ($h -ne $before[$n]) {
        throw "受保护 profile $n 的 package.json 变了——立刻停。请不要继续用这个环境。"
    }
    Write-Host ("  {0}: 未改" -f $n) -ForegroundColor Green
}

Write-Host ''
Write-Host "已装（独立测试 profile，日常 dsh-tui 没动）：" -ForegroundColor Green
Write-Host "  dsh --profile $HeadlessProfile --dump-config"
Write-Host "  dsh --profile $HeadlessProfile `"Reply exactly CORE_OK`""
if ($WithTui) {
    Write-Host "  dsh --profile $TuiProfile --dump-config"
    Write-Host "  .\run-plugin.ps1"
}
Write-Host ''
Write-Host "日常用法请 plugin add 到 dsh-tui，不要用这两个测试 profile。" -ForegroundColor DarkGray
Write-Host "卸测试 profile：  .\uninstall-plugin.ps1" -ForegroundColor Cyan
