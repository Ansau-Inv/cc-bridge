# 打开**特色整窗** TUI：走独立 profile `cc-bridge-tui`，
# 这个进程本身就是 Claude 后端（橙色女仆 + factory）。
#
# 这不是日常用法。日常是 DeepSeek 窗口打 `/ccb <任务>` 另开橙色窗。
# 本脚本留给「整窗换成 Claude」那种特色模式。
#
# 先装：  .\install-plugin.ps1 -WithTui
# 再开：  .\run-plugin.ps1
# 卸：    .\uninstall-plugin.ps1
#
# 和 run.ps1 的差别：run.ps1 叠在日常 dsh-tui 上；
# 本脚本开独立 profile。默认组合包是 host 插入，所以这里仍要叠
# 窗口 overlay：禁 agent-loop + 橙色外观，否则 setFactory 会被官方 loop 抢占。

[CmdletBinding()]
param(
    [string]$Profile = 'cc-bridge-tui',
    [string]$TestPidFile
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$protected = @('dsh-tui', 'dsh-tui-safe', 'headless', 'web')
if ($protected -contains $Profile) {
    throw "run-plugin.ps1 拒绝启动日常 profile：$Profile"
}

Set-Location $here
Remove-Item Env:\NO_COLOR -ErrorAction SilentlyContinue
$env:NO_COLOR = $null

if ($TestPidFile) { $env:CCB_PID_FILE = $TestPidFile }

# 测试状态和日常 ~/.dsh/cc-bridge 分开
$env:CCB_STATE_DIR = Join-Path $here '.tmp-plugin-test'
New-Item -ItemType Directory -Force -Path $env:CCB_STATE_DIR | Out-Null

$env:CCB_MODE = 'takeover'
$env:DSH_TUI_THEME = 'cc-bridge:orange'
$preloadPath = (Resolve-Path (Join-Path $here 'src\preload.mjs')).Path -replace '\\', '/'
$env:NODE_OPTIONS = "--import file:///$preloadPath"

$probe = Join-Path $here 'probe-claude.ps1'
if (Test-Path $probe) {
    try {
        $info = (pwsh -NoProfile -File $probe 2>$null | Select-Object -Last 1) | ConvertFrom-Json
        if ($info.model) { $env:CCB_CLAUDE_MODEL = $info.model }
        if ($info.effort) { $env:CCB_CLAUDE_EFFORT = $info.effort }
        Write-Host "[cc-bridge] claude 实际配置: model=$($info.model) effort=$($info.effort)" -ForegroundColor DarkGray
    } catch {
        Write-Host "[cc-bridge] 探测 claude 配置失败，状态栏将用默认值：$($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

Write-Host "[cc-bridge] 启动特色整窗：$Profile（橙色女仆 + factory；日常 dsh-tui 不受影响）" -ForegroundColor Cyan
dsh --profile $Profile --patch (Join-Path $here 'cordis.patch.yml')
