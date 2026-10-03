# 拆掉 install-plugin.ps1 建的测试 profile，不动日常用的那些。
#
#   .\uninstall-plugin.ps1
#   .\uninstall-plugin.ps1 -KeepState     # 保留仓库里的 .tmp-plugin-test
#
# 只删：
#   ~/.dsh/profiles/cc-bridge-headless
#   ~/.dsh/profiles/cc-bridge-tui
#   仓库 .tmp-plugin-test/（测试日志 / 映射）
#
# 不删、不改：
#   ~/.dsh/profiles/{dsh-tui,dsh-tui-safe,headless,web}
#   ~/.dsh/cc-bridge（你平时 --patch 跑出来的映射）
#   claude / dsh / dsh-tui 的全局安装

[CmdletBinding()]
param(
    [string]$HeadlessProfile = 'cc-bridge-headless',
    [string]$TuiProfile = 'cc-bridge-tui',
    [switch]$KeepState
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$profilesRoot = Join-Path $HOME '.dsh\profiles'
$protected = @('dsh-tui', 'dsh-tui-safe', 'headless', 'web')

function Get-PkgHash([string]$name) {
    $p = Join-Path $profilesRoot $name 'package.json'
    if (-not (Test-Path $p)) { return $null }
    (Get-FileHash $p -Algorithm SHA256).Hash
}

function Assert-Isolated([string]$name) {
    if ($protected -contains $name) {
        throw "拒绝删除受保护 profile：$name"
    }
    if ($name -notmatch '^cc-bridge-') {
        throw "卸载只删 cc-bridge-* 测试 profile，收到的是：$name"
    }
}

Write-Host '卸载前核对照片：' -ForegroundColor DarkGray
$before = @{}
foreach ($n in $protected) {
    $h = Get-PkgHash $n
    $before[$n] = $h
    Write-Host ("  {0}: {1}" -f $n, $(if ($h) { $h.Substring(0, 12) } else { '(不存在)' }))
}

foreach ($name in @($HeadlessProfile, $TuiProfile)) {
    Assert-Isolated $name
    $dir = Join-Path $profilesRoot $name
    if (-not (Test-Path $dir)) {
        Write-Host "没有 $name，跳过" -ForegroundColor DarkGray
        continue
    }
    Write-Host "删除 $dir" -ForegroundColor Cyan
    Remove-Item -LiteralPath $dir -Recurse -Force
}

if (-not $KeepState) {
    $state = Join-Path $here '.tmp-plugin-test'
    if (Test-Path $state) {
        Write-Host "删除 $state" -ForegroundColor Cyan
        Remove-Item -LiteralPath $state -Recurse -Force
    }
}

Write-Host ''
Write-Host '卸载后核对照片：' -ForegroundColor DarkGray
foreach ($n in $protected) {
    $h = Get-PkgHash $n
    if ($h -ne $before[$n]) {
        throw "受保护 profile $n 的 package.json 变了。"
    }
    Write-Host ("  {0}: 未改" -f $n) -ForegroundColor Green
}

Write-Host '测试 profile 已卸干净。日常 dsh / dsh-tui / claude 没动。' -ForegroundColor Green
