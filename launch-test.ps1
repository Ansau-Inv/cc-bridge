# 启动一个**测试用** cc-bridge 窗口，并记下 PID 供安全清理。
#
# ════════════════════════════════════════════════════════════════════
# 为什么要有这个
# ════════════════════════════════════════════════════════════════════
#
# 用 `run.ps1` 直接开测试窗口时，事后**没法区分**哪个进程是我开的、
# 哪个是用户自己开的 —— 命令行长得一模一样（同一个 patch 路径）。
#
# 于是清理时只能靠命令行模式去猜，而猜的结果是**误杀用户的窗口**。
# 更糟的是 `Stop-Process -Force` 会让 dsh-TUI 来不及复原终端模式，
# 那个 tab 就留在鼠标追踪状态里（详见 README「不要强杀 dsh-TUI」）。
#
# 这个脚本把「记 PID」变成启动流程的一部分，于是清理可以**精确**到
# 只动自己开的那一个。
#
# ════════════════════════════════════════════════════════════════════
# 用法
# ════════════════════════════════════════════════════════════════════
#
#   .\launch-test.ps1                 # 开一个测试窗口
#   .\launch-test.ps1 -Title foo      # 自定义 tab 标题
#   .\kill-mine.ps1                   # 事后安全收掉（先优雅退出）
#
# PID 记在 `.test-pids`，**追加**而不是覆盖 —— 可以同时开好几个测试窗口。

[CmdletBinding()]
param(
  [string]$Title = 'ccb',
  [string]$PidFile = (Join-Path $PSScriptRoot '.test-pids'),
  # 内容区给宽一点：开屏大字 + 立绘并排大概需要 114 列
  [int]$Columns = 120,
  [int]$Rows = 42
)

$ErrorActionPreference = 'Stop'

$here = $PSScriptRoot
$pwshExe = (Get-Command pwsh).Source

# ── PID 归属：让 dsh 进程**自己报**，不靠时间窗口猜 ─────────────────
#
# ⚠️ 早先的做法是「启动后出现的、命令行含 cc-bridge 的 node.exe」——
#    那有个真实的误杀路径：如果使用者在探测窗口（45 秒）内**自己**开了
#    一个 cc-bridge 窗口，它会被误认成测试进程记进 `.test-pids`，
#    之后 `kill-mine.ps1` 就把用户的窗口杀了。
#
# 改成：`run.ps1 -TestPidFile <路径>` → 设 `CCB_PID_FILE` 环境变量 →
# 插件启动时把自己的 `process.pid` 写进去（见 src/index.mjs 顶部）。
# 零歧义，且不依赖命令行匹配（那本来也没法区分你我）。
#
# ⚠️ 变量名**不能**叫 `$pidFile` —— PowerShell 变量名**大小写不敏感**，
#    它会和参数 `$PidFile`（.test-pids 的路径）是**同一个变量**，
#    于是这里的赋值会把用户要写的清单路径覆盖掉。
#    症状：Add-Content 写进了临时文件，紧接着 Remove-Item 又把它删了 ——
#    看起来"已记录 PID"，实际 .test-pids 是空的，kill-mine 无东西可清。
#    所以叫 `$reportFile`。
$reportFile = Join-Path $here ('.test-pid-' + ([guid]::NewGuid().ToString('n').Substring(0, 8)))

Start-Process 'wt.exe' -ArgumentList @(
  '-w', 'new', 'new-tab',
  '--title', $Title,
  '--startingDirectory', $here,
  $pwshExe, '-NoLogo', '-NoExit', '-File', (Join-Path $here 'run.ps1'),
  '-TestPidFile', $reportFile
)

# ── 等插件把 PID 写出来 ─────────────────────────────────────────────
Write-Host '等待 dsh 启动' -NoNewline
$deadline = (Get-Date).AddSeconds(60)
$reported = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
  Write-Host '.' -NoNewline
  if (Test-Path $reportFile) {
    $raw = (Get-Content $reportFile -Raw -EA SilentlyContinue).Trim()
    if ($raw -match '^\d+$') { $reported = [int]$raw; break }
  }
}
Write-Host ''

if (-not $reported) {
  Write-Host '⚠️  没等到 PID 汇报 —— 插件可能没加载起来。' -ForegroundColor Yellow
  Write-Host '   看日志确认原因：' -ForegroundColor DarkGray
  $stateDir = if ($env:CCB_STATE_DIR) { $env:CCB_STATE_DIR }
    elseif ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'cc-bridge' }
    else { Join-Path $HOME '.cc-bridge' }
  Write-Host "     Get-Content '$(Join-Path $stateDir 'bridge.log')' -Tail 30" -ForegroundColor DarkGray
  Remove-Item $reportFile -Force -EA SilentlyContinue
  return
}

# 二次确认进程确实活着（PID 有可能在极短时间内就被回收）
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$reported" -EA SilentlyContinue
if (-not $p) {
  Write-Host "⚠️  插件报的 pid=$reported 已经不存在了。" -ForegroundColor Yellow
  Remove-Item $reportFile -Force -EA SilentlyContinue
  return
}

# ── 记下来（追加）──────────────────────────────────────────────────
Add-Content -Path $PidFile -Value $reported -Encoding utf8
Remove-Item $reportFile -Force -EA SilentlyContinue
Write-Host "已记录 PID：$reported（由插件自报，$($p.Name)）  →  $PidFile" -ForegroundColor Green
Write-Host ''
Write-Host '收尾时用：' -NoNewline -ForegroundColor Cyan
Write-Host '  .\kill-mine.ps1' -ForegroundColor White
Write-Host '（杀完会**自动复位终端模式**，不会留下坏 tab）' -ForegroundColor DarkGray
Write-Host ''
Write-Host '⚠️  别手工 Stop-Process —— 用 kill-mine.ps1，它会连终端模式一起清。' -ForegroundColor Yellow
