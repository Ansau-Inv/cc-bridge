# 日常 DeepSeek 窗口：只叠 host 面（/ccb + ccb_*）。
#
# **不**换 AgentFactory，**不**改立绘 / 大字 / 主题，**不**预加载调色。
# 官方女仆和日常色彩保持原样。
#
#   .\run-host.ps1                 # dsh-tui
#   .\run-host.ps1 -Profile web    # 网页端
#
# 在窗口里打 `/ccb 某件事` 会另开一扇橙色 cc-bridge-tui。
# 不要对橙色窗口 Stop-Process -Force（见 run.ps1 头注释）。

[CmdletBinding()]
param(
    [string]$Profile = 'dsh-tui'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
# 不要 Set-Location $here：日常窗口的 cwd 必须跟用户开 TUI 时所在目录。
# 补丁路径用 $here 绝对定位即可。

# 明确清掉窗口模式的环境，免得从橙色窗口复制过来的会话把日常也染橙。
Remove-Item Env:\CCB_MAILBOX_ID -ErrorAction SilentlyContinue
Remove-Item Env:\DSH_TUI_THEME -ErrorAction SilentlyContinue
Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue
Remove-Item Env:\NO_COLOR -ErrorAction SilentlyContinue
$env:CCB_MODE = 'host'

# 赶在 dsh-tui 建 Channel / 刷命令表之前，把 /ccb 写进 LOCAL_COMMANDS。
# 只改本进程内存，不写盘、不改立绘。plugin add 之后 commands.register 通常够用；
# Channel 若绑得比 apply() 早，没有这一步 `/ccb` 仍可能进模型。
$hostPreload = (Resolve-Path (Join-Path $here 'src\host-preload.mjs')).Path -replace '\\', '/'
$env:NODE_OPTIONS = "--import file:///$hostPreload"

function Test-ProfileHasCcBridge([string]$Name) {
    $pkg = Join-Path $HOME ".dsh\profiles\$Name\package.json"
    if (-not (Test-Path -LiteralPath $pkg)) { return $false }
    try {
        $j = Get-Content -LiteralPath $pkg -Raw -Encoding utf8 | ConvertFrom-Json
        return @($j.dsh.profile.bundles) -contains 'cc-bridge'
    } catch { return $false }
}

$dshArgs = @('--profile', $Profile)
if (Test-ProfileHasCcBridge $Profile) {
    Write-Host "[cc-bridge] host 面：$Profile（已装进 profile；官方 DeepSeek 不变）" -ForegroundColor Cyan
} else {
    Write-Host "[cc-bridge] host 面：$Profile（本次 --patch，官方 DeepSeek 不变）" -ForegroundColor Cyan
    $dshArgs += @('--patch', (Join-Path $here 'host.patch.yml'))
}
dsh @dshArgs

