# 远程复位**指定 tab** 的终端模式 —— 不用在那个窗口里操作。
#
# ════════════════════════════════════════════════════════════════════
# 原理
# ════════════════════════════════════════════════════════════════════
#
# `AttachConsole(pid)` 能挂到**别的进程的 console** 上，挂上之后
# `CreateFile("CONOUT$")` 就指向那个 console 的输出缓冲区 —— 往里写
# 转义序列，等于在**那个 tab 里**敲了同样的序列。
#
# 所以不需要用户手动去那个卡住的窗口里跑（他可能根本没法输入，
# 因为鼠标一动就在吐 ANSI 序列）。这个脚本能从外面修。
#
# ════════════════════════════════════════════════════════════════════
# ⚠️ 必须在**独立子进程**里做 attach
# ════════════════════════════════════════════════════════════════════
#
# 踩过：直接在脚本进程里 `AttachConsole` 会导致
#   · 脚本**自己**的 Write-Host 输出跑到**目标** console 上
#   · 而且编码不对，目标那边显示成一串乱码
#   · 自己的输出全丢
#
# 因为 AttachConsole 后 `CONOUT$`（也就是 stdout 的落点）就变了。
#
# 所以本脚本是个**调度器**：它把真正的活交给一个隐藏的**子 pwsh**，
# 子进程 attach → 写 → 退出，全程不碰父进程的 console。
#
# ════════════════════════════════════════════════════════════════════
# 为什么不用 GenerateConsoleCtrlEvent
# ════════════════════════════════════════════════════════════════════
#
# 试过，**在 ConPTY 下不投递** —— 实测 AttachConsole 成功、
# GenerateConsoleCtrlEvent 也返回成功，但目标进程纹丝不动。
# Windows Terminal 用的是伪 console（ConPTY），Ctrl 事件不走老路径。
#
# 写 CONOUT$ 是纯字节流，不依赖事件机制，ConPTY 一样通。
#
# ════════════════════════════════════════════════════════════════════
# 用法
# ════════════════════════════════════════════════════════════════════
#
#   # 不知道 pid？列出候选（标出哪个像 cc-bridge）
#   pwsh -File reset-tab.ps1 -List
#
#   # 按 pid 复位。同一个 tab 里的进程共享 console，挑哪个都行
#   pwsh -File reset-tab.ps1 -TargetPid 12345
#
#   # 连备用屏也退出（默认只复位鼠标/焦点/粘贴，不动屏幕内容）
#   pwsh -File reset-tab.ps1 -TargetPid 12345 -ExitAltScreen

[CmdletBinding()]
param(
  [int]$TargetPid = 0,
  # 只列出候选进程，不动任何东西
  [switch]$List,
  # 连备用屏也退出（默认只复位"输入类"模式，不动屏幕内容）
  [switch]$ExitAltScreen,
  # 内部用：标记当前是执行 attach 的子进程
  [switch]$Worker
)

$ErrorActionPreference = 'Stop'

# ══════════════════════════════════════════════════════════════════
# Worker 分支：真正做 attach + 写序列。只有这一支会碰 CONOUT$。
# ══════════════════════════════════════════════════════════════════
if ($Worker) {
  $modes = @(1006, 1003, 1002, 1000, 1004, 2004)
  if ($ExitAltScreen) { $modes += 1049 }

  Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ConWrite {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share,
      IntPtr sec, uint disp, uint flags, IntPtr templ);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool WriteConsoleW(IntPtr h, string buf, uint len, out uint written, IntPtr res);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  const uint GENERIC_WRITE = 0x40000000, GENERIC_READ = 0x80000000;
  const uint FILE_SHARE_WRITE = 0x2, FILE_SHARE_READ = 0x1, OPEN_EXISTING = 3;

  public static string Write(uint pid, string text) {
    FreeConsole();                       // 先脱离自己的，AttachConsole 才有意义
    if (!AttachConsole(pid)) return "AttachConsole 失败 (win32=" + Marshal.GetLastWin32Error() + ")";
    IntPtr h = IntPtr.Zero;
    try {
      // 控制台输出设备必须 CreateFile("CONOUT$")，不能直接拿 stdout
      h = CreateFileW("CONOUT$", GENERIC_WRITE | GENERIC_READ,
        FILE_SHARE_WRITE | FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
      if (h == (IntPtr)(-1) || h == IntPtr.Zero)
        return "打不开 CONOUT$ (win32=" + Marshal.GetLastWin32Error() + ")";
      uint written;
      if (!WriteConsoleW(h, text, (uint)text.Length, out written, IntPtr.Zero))
        return "WriteConsoleW 失败 (win32=" + Marshal.GetLastWin32Error() + ")";
      return null;
    } finally {
      if (h != IntPtr.Zero && h != (IntPtr)(-1)) CloseHandle(h);
      FreeConsole();
    }
  }
}
'@

  # 转义序列本身是**纯 ASCII**，不受代码页影响。
  # 末尾补 CR LF，避免残留在半行（鼠标序列可能已经污染了输入回显）。
  $seq = ($modes | ForEach-Object { "$([char]27)[?$($_)l" }) -join ''
  $seq += "$([char]27)[?25h"   # 光标显示出来
  $seq += "`r`n"

  $err = [ConWrite]::Write([uint32]$TargetPid, $seq)
  if ($err) { exit 2 }

  # 出口码写进临时文件 —— 子进程没有可用的 stdout（它 attach 到别人家了）
  if ($env:CCB_RESULT_FILE) {
    Set-Content -Path $env:CCB_RESULT_FILE -Value 'OK' -Encoding utf8 -EA SilentlyContinue
  }
  exit 0
}

# ══════════════════════════════════════════════════════════════════
# 调度分支：列候选 / 起子进程干活
# ══════════════════════════════════════════════════════════════════

if ($List -or $TargetPid -le 0) {
  Write-Host '带 console 的候选进程：' -ForegroundColor Cyan
  Write-Host ''
  $rows = @()
  foreach ($p in Get-CimInstance Win32_Process -EA SilentlyContinue) {
    if ($p.Name -notin @('node.exe', 'pwsh.exe', 'cmd.exe', 'powershell.exe', 'claude.exe')) { continue }
    $cl = [string]$p.CommandLine
    $tag = ''
    if ($cl -match 'cc-bridge') { $tag = '★ cc-bridge' }
    elseif ($cl -match 'dsh-tui') { $tag = 'dsh-tui' }
    elseif ($cl -match 'run\.ps1') { $tag = 'run.ps1 外壳' }
    if (-not $tag) { continue }
    $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.ProcessId)" -EA SilentlyContinue)
    $rows += [pscustomobject]@{
      Pid = $p.ProcessId; Name = $p.Name; 标记 = $tag
      子进程 = if ($kids) { ($kids | ForEach-Object { $_.Name }) -join ',' } else { '（空壳）' }
    }
  }
  $rows | Sort-Object Pid | Format-Table -AutoSize
  Write-Host '选一个 pid 然后跑：' -ForegroundColor Yellow
  Write-Host '  pwsh -File reset-tab.ps1 -TargetPid <pid>' -ForegroundColor White
  Write-Host ''
  Write-Host '同一个 tab 里的进程共享 console —— 挑哪个都行。' -ForegroundColor DarkGray
  Write-Host '「空壳」的 pwsh 通常就是被强杀后残留的 tab 外壳，拿它最稳。' -ForegroundColor DarkGray
  return
}

# 目标得先确认存在，不然白起一个进程
$target = Get-CimInstance Win32_Process -Filter "ProcessId=$TargetPid" -EA SilentlyContinue
if (-not $target) {
  Write-Host "pid=$TargetPid 不存在。" -ForegroundColor Red
  exit 1
}

$resultFile = Join-Path $env:TEMP ("ccb-reset-" + [guid]::NewGuid().ToString('n') + ".txt")
$workerArgs = @(
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', $PSCommandPath,
  '-Worker', '-TargetPid', $TargetPid
)
if ($ExitAltScreen) { $workerArgs += '-ExitAltScreen' }

# 关键：**新进程**跑 worker，它 attach 别人家的 console 时，
# 本进程（调度器）的 console 毫发无损。
$env:CCB_RESULT_FILE = $resultFile
$proc = Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList $workerArgs `
  -WindowStyle Hidden -PassThru -Wait
Remove-Item Env:\CCB_RESULT_FILE -EA SilentlyContinue

$ok = (Test-Path $resultFile) -and ((Get-Content $resultFile -Raw -EA SilentlyContinue).Trim() -eq 'OK')
Remove-Item $resultFile -Force -EA SilentlyContinue

if ($ok) {
  Write-Host "已向 pid=$TargetPid 的 console 写入复位序列：" -ForegroundColor Green
  Write-Host ("  鼠标追踪 1000/1002/1003/1006、焦点 1004、括号粘贴 2004" +
    $(if ($ExitAltScreen) { '、备用屏 1049' } else { '' }) + '、光标显示')
  Write-Host '  去那个 tab 看看 —— 鼠标应该不再吐字符了。' -ForegroundColor DarkGray
  exit 0
}

Write-Host "FAIL（worker 出口码 $($proc.ExitCode)）" -ForegroundColor Red
Write-Host ''
Write-Host '可能的原因：' -ForegroundColor DarkYellow
Write-Host '  · 那个 pid 没有 console（headless 进程，比如 dsh 的子进程 runner）' -ForegroundColor DarkYellow
Write-Host '  · pid 已经退出' -ForegroundColor DarkYellow
Write-Host '用 -List 看候选，挑「空壳」那个 pwsh 或它的兄弟进程再试。' -ForegroundColor DarkYellow
exit 1
