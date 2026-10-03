# 安全清理 cc-bridge 测试窗口 —— **只动我自己开的那些**。
#
# ════════════════════════════════════════════════════════════════════
# 为什么需要这个脚本
# ════════════════════════════════════════════════════════════════════
#
# 排查过程中我反复用过这两条命令，**它们都会误伤**：
#
#   # ① 按路径模式匹配 —— 用户自己用 run.ps1 开的窗口同样带这个路径
#   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
#     Where-Object { $_.CommandLine -match '--patch D:\\code\\cc-bridge' } |
#     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
#
#   # ② 零过滤 —— 杀全系统所有 claude.exe，包括用户窗口里正在跑的
#   Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
#     ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
#
# ① 的问题是**命令行没法区分你我** —— 用户用同一个 run.ps1 启动时，
# 命令行长得一模一样。② 更直接，无差别扫射。
#
# 后果有两层：
#
#   1. 用户的窗口被误杀 —— 他可能正在用 cc-bridge 干活
#   2. **更糟：终端会留在鼠标追踪模式**。dsh-TUI 全屏时写
#      `\x1b[?1000h ?1002h ?1003h ?1006h`，撤销序列只在**优雅退出**时
#      才发出（ink 的 `signal-exit` → `unmount`）。`-Force` 强杀让撤销
#      代码永不执行，于是鼠标一动就往输入里注入 `\x1b[<35;c;rM` ——
#      表现就是「输入变成了 ANSI 符号」，而且**只影响那一个 tab**。
#
# ════════════════════════════════════════════════════════════════════
# 正确做法
# ════════════════════════════════════════════════════════════════════
#
# 用 `launch-test.ps1` 启动（它自动记 PID），用本脚本收尾：
#
#   .\launch-test.ps1          # 开测试窗口，PID 记进 .test-pids
#   .\kill-mine.ps1            # 只收这些
#
# 判定归属靠 **.test-pids 里记的 PID**，不靠命令行模式。
#
# ════════════════════════════════════════════════════════════════════
# 优雅退出：发 Ctrl+C，**不是** WM_CLOSE
# ════════════════════════════════════════════════════════════════════
#
# ⚠️ 曾经想「按 pid 找窗口 → 发 WM_CLOSE」，那是**错的且危险**：
#    Windows Terminal 的**所有 tab 共享同一个 WindowsTerminal.exe**，
#    所以沿祖先链找窗口会命中**第一个** WT 窗口 —— 也就是**别人的 tab**，
#    等于把用户的窗口关掉。实测踩过：
#
#      祖先链: 15600 <- 28460 <- 30668
#      命中:   pid=30668 title='你好'      ← 不是我的 tab！
#
#    正确做法是 `GenerateConsoleCtrlEvent` —— 它按 **console** 投递，
#    而每个 tab 有独立的 console（自己的 OpenConsole.exe），不会串。
#    实现在 `send-ctrlc.ps1`。
#
# 发 Ctrl+C 能复原终端模式的原因：Node 把它映射成 SIGINT，dsh-tui 的 ink
# 用 `signal-exit` 挂了清理逻辑，会写出
# `\x1b[?1006l ?1003l ?1002l ?1000l ?1049l`。只有强杀才会跳过这一步。

[CmdletBinding()]
param(
  # 记录我开的 PID 的文件
  [string]$PidFile = (Join-Path $PSScriptRoot '.test-pids'),

  # 不尝试优雅关闭，直接强杀（会留下坏掉的终端模式！）
  [switch]$Force,

  # 超时多少秒后放弃优雅退出
  [int]$GraceSeconds = 8
)

$ErrorActionPreference = 'Stop'

# ── 读 PID 清单 ─────────────────────────────────────────────────────
if (-not (Test-Path $PidFile)) {
  Write-Host "没有 PID 清单（$PidFile）—— 没东西可清理。" -ForegroundColor Yellow
  Write-Host '下次启动请用 launch-test.ps1，它会自动记 PID。' -ForegroundColor DarkGray
  return
}

$pids = @(Get-Content $PidFile -EA SilentlyContinue |
  ForEach-Object { $_.Trim() } |
  Where-Object { $_ -match '^\d+$' } |
  ForEach-Object { [int]$_ })

if ($pids.Count -eq 0) {
  Write-Host 'PID 清单是空的。' -ForegroundColor Yellow
  Remove-Item $PidFile -Force -EA SilentlyContinue
  return
}

Write-Host "PID 清单里有 $($pids.Count) 个：$($pids -join ', ')" -ForegroundColor Cyan

# ── 只保留还活着、且确实是我们那份 dsh 的 ──────────────────────────
$alive = @()
foreach ($procId in $pids) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -EA SilentlyContinue
  if (-not $p) { Write-Host "  pid=$procId 已经退出了" -ForegroundColor DarkGray; continue }
  # 二次确认：命令行里必须带我们的 patch 路径，避免 PID 被复用后误杀别人
  if ($p.CommandLine -and $p.CommandLine -match 'cc-bridge') {
    $alive += $procId
    Write-Host "  pid=$procId $($p.Name) ✓" -ForegroundColor Green
  }
  else {
    Write-Host "  pid=$procId 命令行不像我们的（PID 可能被复用），跳过" -ForegroundColor Yellow
  }
}

if ($alive.Count -eq 0) {
  Write-Host '没有活着的目标。' -ForegroundColor Yellow
  Remove-Item $PidFile -Force -EA SilentlyContinue
  return
}

# ── 优雅退出优先，然后**必定复位终端模式** ──────────────────────────
#
# ⚠️ 别指望「按 pid 找窗口 → 发 WM_CLOSE 走优雅退出」：
#    Windows Terminal 的**所有 tab 共享同一个 WindowsTerminal.exe**，
#    所以沿祖先链找窗口会命中**第一个** WT 窗口 —— 也就是**别人的 tab**，
#    等于把用户的窗口关掉。实测踩过：
#
#      祖先链: 15600 <- 28460 <- 30668
#      命中:   pid=30668 title='你好'      ← 不是我的 tab！
#
# ⚠️ 也别指望 `GenerateConsoleCtrlEvent`：在 ConPTY 下**不投递**。
#    实测 AttachConsole 成功、事件函数也返回成功，但目标进程纹丝不动
#    （Windows Terminal 用的是伪 console，Ctrl 事件不走老路径）。
#
# 所以策略是：**先尽力优雅，再强杀，最后无条件复位终端模式**。
#
# 复位那步（reset-tab.ps1）是**关键保险** —— 它直接往目标 tab 的
# CONOUT$ 写 `\x1b[?1006l ?1003l ?1002l ?1000l ?1049l`，不管 dsh 是
# 怎么死的都能把模式清干净。这样即使走了强杀，那个 tab 也不会坏。
$resetScript = Join-Path $PSScriptRoot 'reset-tab.ps1'

# ── 记下「同 console 的候选进程」—— 必须**在杀之前**做 ──────────────
#
# 关键：dsh 一死就 attach 不上它的 console 了。但同一个 tab 里还有
# 外壳 pwsh（run.ps1 那个）活着，**它共享同一个 console** —— 拿它来
# attach 一样能复位那个 tab。
#
# 所以先把「dsh 自己 + 它的祖先链上所有 pwsh」都收进候选。
$consoleCandidates = @()
foreach ($procId in $alive) {
  $consoleCandidates += $procId
  $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -EA SilentlyContinue
  for ($d = 0; $d -lt 4 -and $cur; $d++) {
    $parentId = [int]$cur.ParentProcessId
    if ($parentId -le 0) { break }
    $par = Get-CimInstance Win32_Process -Filter "ProcessId=$parentId" -EA SilentlyContinue
    if (-not $par) { break }
    # 只要 shell / 终端宿主这类会持有 console 的
    if ($par.Name -in @('pwsh.exe', 'powershell.exe', 'cmd.exe', 'OpenConsole.exe', 'conhost.exe')) {
      $consoleCandidates += $parentId
    }
    $cur = $par
  }
}
$consoleCandidates = @($consoleCandidates | Select-Object -Unique)

# ── 结束目标进程 ────────────────────────────────────────────────────
#
# ⚠️ 为什么不走「优雅退出」：
#
#   · 「按 pid 找窗口 → 发 WM_CLOSE」**危险** —— WT 的所有 tab 共享同一个
#     WindowsTerminal.exe，沿祖先链找窗口会命中**第一个** WT 窗口（也就是
#     别人的 tab）。实测踩过：我的 pid 15600 找到的是用户的「你好」。
#
#   · `GenerateConsoleCtrlEvent` 在 **ConPTY 下不投递** —— 实测
#     AttachConsole 成功、事件函数也返回成功，但目标进程纹丝不动
#     （Windows Terminal 用伪 console，Ctrl 事件不走老路径）。
#
# 所以直接强杀，再用下面那步**无条件复位**兜底 —— 实测有效。
$alive | ForEach-Object {
  Write-Host "  结束 pid=$_" -ForegroundColor DarkGray
  Stop-Process -Id $_ -Force -EA SilentlyContinue
}
Start-Sleep -Milliseconds 800

# ── 无条件复位终端模式（关键保险）──────────────────────────────────
#
# 这一步让「强杀」也不再留下坏终端 —— 直接往那个 tab 的 CONOUT$ 写
# `\x1b[?1006l ?1003l ?1002l ?1000l ?1049l`，不管 dsh 是怎么死的都能清干净。
if ($resetScript -and (Test-Path $resetScript)) {
  $done = 0
  foreach ($procId in $consoleCandidates) {
    if (-not (Get-Process -Id $procId -EA SilentlyContinue)) { continue }
    $out = & pwsh -NoProfile -File $resetScript -TargetPid $procId 2>&1
    if (($out | Out-String) -match '已向') { $done++; break }   # 一个 tab 成功一次就够
  }
  if ($done -gt 0) { Write-Host '  终端模式已复位 ✓' -ForegroundColor Green }
  else { Write-Host '  没找到可复位的 console（headless 运行属正常）' -ForegroundColor DarkGray }
}

# ── 顺带收掉它们**自己的** claude 子进程 ────────────────────────────
#
# 只杀「父进程在我们要清理的那批 PID 里」的 claude.exe —— 不再是无过滤的
# 全系统扫射。用户的 claude 进程有它自己的父，不会被碰。
foreach ($procId in $alive) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$procId" -EA SilentlyContinue |
    Where-Object { $_.Name -eq 'claude.exe' } |
    ForEach-Object {
      Write-Host "  收掉子进程 claude.exe pid=$($_.ProcessId)" -ForegroundColor DarkGray
      Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue
    }
}

Remove-Item $PidFile -Force -EA SilentlyContinue
Write-Host '清理完成。' -ForegroundColor Green

if ($Force) {
  Write-Host ''
  Write-Host '⚠️  用了强杀 —— 如果那个 tab 的鼠标一动就吐 ANSI 符号，' -ForegroundColor Yellow
  Write-Host '   在那个窗口里执行：pwsh -File reset-terminal.ps1' -ForegroundColor Yellow
}
