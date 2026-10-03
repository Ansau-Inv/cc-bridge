# cc-bridge 启动（真终端）
#
# ⚠️ 要结束这个窗口时，**别用 Stop-Process -Force / taskkill /F**。
#    dsh-TUI 全屏时会开鼠标追踪（`\x1b[?1000h ?1002h ?1003h ?1006h`），
#    撤销序列只在**优雅退出**时才写出去（ink 挂在 signal-exit 上）。
#    强杀会让撤销代码永不执行，那个 tab 就留在鼠标追踪模式里 ——
#    鼠标一动就往输入流注入 `\x1b[<35;c;rM`，看起来是「输入变成 ANSI 符号」。
#
#    正确做法：在窗口里按 Ctrl+C 正常退出，或者直接关掉那个 tab。
#    已经卡住了就跑 `pwsh -File reset-terminal.ps1`（在**那个窗口里**）。
#
# 所有路径都从 `$PSScriptRoot` 推 —— 这个仓库要给别人 clone 到任意目录用，
# 写死 `D:\code\cc-bridge` 会让别人直接跑不起来。

[CmdletBinding()]
param(
    # 把本进程（dsh）的 PID 记到这个文件 —— 供 launch-test.ps1 精确归属。
    # 不传就只是普通启动。
    [string]$TestPidFile,
    [string]$MailboxId,
    [string]$StateDir,
    # DeepSeek 会话目录。/ccb 拉起时必须带上，否则 Set-Location $here
    # 会让橙色窗口和 claude 都跑在插件仓库里。
    [string]$Cwd
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

# 工作目录跟 DeepSeek 会话，不跟仓库。脚本自己的路径用 $here。
if ($Cwd -and (Test-Path -LiteralPath $Cwd)) {
    Set-Location -LiteralPath $Cwd
    $env:DSH_TUI_WORKSPACE_TARGET = $Cwd
} else {
    Set-Location $here
}
Remove-Item Env:\NO_COLOR -ErrorAction SilentlyContinue
$env:NO_COLOR = $null

# ── 让 dsh 把 PID 汇报出来（测试归属用）────────────────────────────
#
# 为什么不让 launch-test.ps1 去"猜"哪个进程是自己开的：
# 之前的做法是「启动后 45 秒内新出现的、命令行含 cc-bridge 的 node.exe」——
# 如果使用者在那个窗口里自己开了一个 cc-bridge 窗口，它会被**误认**成
# 测试进程记进 .test-pids，之后被 kill-mine.ps1 杀掉。
#
# 改成让插件自己报 PID（src/index.mjs 读到 CCB_PID_FILE 就写自己的
# `process.pid`）—— 零歧义，不依赖时间窗口，也不依赖命令行匹配。
if ($TestPidFile) { $env:CCB_PID_FILE = $TestPidFile }

# 窗口模式：/ccb 拉起时带信箱 id。run.ps1 自己开窗（特色/调试）也可以不带。
if ($MailboxId) { $env:CCB_MAILBOX_ID = $MailboxId }
if ($StateDir) { $env:CCB_STATE_DIR = $StateDir }
$env:CCB_MODE = 'window'

# 主题：选中 cc-bridge 插件注册的暖橙配色。
#
# 为什么走环境变量而不是 `~/.dsh-tui/theme.json`：
# 那个文件是**全局持久化**，改了你所有 dsh-tui 会话都跟着变橙。
# 环境变量只对**这一次启动**生效 —— 别的窗口照旧是默认的雾蓝。
#
# 优先级（ThemeProvider.js）：theme prop > DSH_TUI_THEME > theme.json > OSC11 检测。
# 主题本体注册在 src/theme-orange.mjs。
$env:DSH_TUI_THEME = 'cc-bridge:orange'

# ctx 条空闲段的底色重映射 —— 必须在 dsh-tui 加载**之前**完成。
#
# 那两格颜色是 StatusLine.js 里的内联字面量（`{ freeFill: '#2E3440', ... }`），
# 既不是模块常量也不走主题，插件跑起来之后再改已经太晚 —— dsh-tui 的组件
# 在模块加载时就捕获了 jsx 快照。所以用 --import 预加载抢在前面。
# 细节见 src/preload.mjs 的文件头。
$preloadPath = (Resolve-Path (Join-Path $here 'src\preload.mjs')).Path -replace '\\', '/'
$env:NODE_OPTIONS = "--import file:///$preloadPath"

# ── 让状态栏跟随 claude 实际用的模型与强度 ──────────────────────
#
# 状态栏显示的「模型 · 强度」本来是 dsh-TUI 自己的会话路由，跟 claude
# 实际用什么没关系。这里在启动前探测 claude 的配置，写进环境变量，
# 再由 cordis.patch.yml 的 `!!js` 表达式读走。
#
# 探测什么：
#   · model  —— ~/.claude/settings.json 的 `model`（别名会自动查 *_MODEL_NAME）
#   · effort —— 环境变量 CLAUDE_CODE_EFFORT_LEVEL
#
# 探测失败不影响启动 —— 那两个变量为空时 patch 会回落成 default 值。
# 细节见 probe-claude.ps1 的文件头。
$probe = Join-Path $here 'probe-claude.ps1'
if (Test-Path $probe) {
    try {
        $info = (pwsh -NoProfile -File $probe 2>$null | Select-Object -Last 1) | ConvertFrom-Json
        if ($info.model) { $env:CCB_CLAUDE_MODEL = $info.model }
        if ($info.effort) { $env:CCB_CLAUDE_EFFORT = $info.effort }
        Write-Host "[cc-bridge] claude 实际配置: model=$($info.model) effort=$($info.effort)" -ForegroundColor DarkGray
    }
    catch {
        Write-Host "[cc-bridge] 探测 claude 配置失败，状态栏将用默认值：$($_.Exception.Message)" -ForegroundColor DarkYellow
    }
}

# 窗口 overlay 只覆盖已有的 cc-bridge 行并禁 agent-loop。
# 日常还没 plugin add 时，先叠 host 插入，否则覆盖找不到目标。
# 已经装进 profile 就不要再叠 host.patch.yml —— 二次 insert 会挂两行同 id。
function Test-ProfileHasCcBridge([string]$ProfileName) {
    $pkg = Join-Path $HOME ".dsh\profiles\$ProfileName\package.json"
    if (-not (Test-Path -LiteralPath $pkg)) { return $false }
    try {
        $j = Get-Content -LiteralPath $pkg -Raw -Encoding utf8 | ConvertFrom-Json
        return @($j.dsh.profile.bundles) -contains 'cc-bridge'
    } catch { return $false }
}

$dshArgs = @('--profile', 'dsh-tui')
if (-not (Test-ProfileHasCcBridge 'dsh-tui')) {
    $dshArgs += @('--patch', (Join-Path $here 'host.patch.yml'))
}
$dshArgs += @('--patch', (Join-Path $here 'cordis.patch.yml'))
dsh @dshArgs

