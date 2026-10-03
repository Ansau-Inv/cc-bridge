# 给日常 DSH 的 /ccb 用：新开一扇**独立**终端，跑完整 cc-bridge 窗口。
#
# 走 run.ps1（--patch + preload + 橙色主题），不走独立 profile。
# 日常 dsh-tui / web 的立绘、工厂、色彩一律不动。
#
# 不要对这个窗口 Stop-Process -Force / taskkill /F
# （dsh-TUI 鼠标追踪撤不掉，见 run.ps1 头注释）。

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MailboxId,
    [string]$Cwd,
    [string]$Title,
    [string]$StateDir
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$pwshCmd = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $pwshCmd) { $pwshCmd = Get-Command powershell }
$pwshExe = $pwshCmd.Source

if (-not $Title) { $Title = "ccb $MailboxId" }
if (-not $Cwd) { $Cwd = $here }

$env:CCB_MAILBOX_ID = $MailboxId
$env:CCB_MODE = 'window'
# 新窗口和日常 DSH 共用同一 STATE_DIR，信箱才对得上。
# 不要改成仓库 .tmp-plugin-test —— 那是独立 profile 测试用的。
if ($StateDir) { $env:CCB_STATE_DIR = $StateDir }

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wt) {
    $wtArgs = @(
        '-w', 'new', 'new-tab',
        '--title', $Title,
        '--startingDirectory', $Cwd,
        $pwshExe, '-NoLogo', '-NoExit',
        '-File', (Join-Path $here 'run.ps1'),
        '-MailboxId', $MailboxId,
        '-Cwd', $Cwd
    )
    if ($StateDir) { $wtArgs += @('-StateDir', $StateDir) }
    Start-Process -FilePath $wt.Source -ArgumentList $wtArgs
    return
}

$fallbackArgs = @('-NoLogo', '-NoExit', '-File', (Join-Path $here 'run.ps1'), '-MailboxId', $MailboxId, '-Cwd', $Cwd)
if ($StateDir) { $fallbackArgs += @('-StateDir', $StateDir) }
Start-Process -FilePath $pwshExe -ArgumentList $fallbackArgs -WorkingDirectory $Cwd
