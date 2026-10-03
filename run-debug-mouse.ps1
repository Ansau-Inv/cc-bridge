# cc-bridge 启动（真终端 + 鼠标调试）
#
# 和 run.ps1 的唯一区别是开了 dsh-TUI 的鼠标调试日志。
# 路径全部从 $PSScriptRoot 推 —— 这个仓库要给别人 clone 到任意目录用。
$here = $PSScriptRoot

Set-Location $here
Remove-Item Env:\NO_COLOR -ErrorAction SilentlyContinue
$env:NO_COLOR = $null

# 打开 dsh-TUI 的鼠标调试日志 —— 它会记到 ~/.dsh-tui/mouse-debug.log：
#   · alt-screen enter（含 mouseTracking 标志）
#   · 每个鼠标事件的命中判定
# 排查"hover 不生效"时这是唯一的内部视角，比自己猜坐标靠谱。
#
# ⚠️ 注意：这个文件是**上游 dsh-tui 自己**写的（不是本插件），而且写在
#    `~/.dsh-tui/` 下 —— 属于全局位置。调试完把它关掉即可，不影响别处。
$env:DSH_TUI_DEBUG_MOUSE = '1'

dsh --profile dsh-tui --patch (Join-Path $here 'cordis.patch.yml')
