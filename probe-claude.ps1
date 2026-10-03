# 探测 Claude Code 实际使用的模型名与思考强度，输出一行 JSON。
#
# ── 为什么需要它 ────────────────────────────────────────────────────
#
# dsh-TUI 状态栏显示的「模型 · 强度」是**它自己的会话路由**，跟 claude 实际
# 用什么毫无关系。要让它们跟随，就得在启动前把 claude 的配置读出来，
# 通过环境变量喂给 cordis.patch.yml 的 `!!js` 表达式。
#
# ── 两个值的来源 ────────────────────────────────────────────────────
#
# **模型**：`~/.claude/settings.json` 的顶层 `model`。
#   实测它就是 init 帧里 `model` 报的那个名字（`claude-sonnet-4-5`）。
#   但如果那里写的是**别名**（`sonnet` / `opus` / `fable` 之类），真实模型名
#   要看环境变量里那组映射：
#     ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = claude-sonnet-4-5
#   所以别名时优先按别名查这组 `*_MODEL_NAME`。
#
# **强度**：环境变量 `CLAUDE_CODE_EFFORT_LEVEL`（实测 `xhigh`）。
#   claude 的 `--effort` 接受 low / medium / high / xhigh / max —— 跟它一致。
#
# ── 输出 ────────────────────────────────────────────────────────────
#
#   {"model":"claude-sonnet-4-5","effort":"xhigh","source":"settings.json"}
#
# 读不到就输出 null，调用方回落即可 —— 绝不能因为探测失败挡住启动。

[CmdletBinding()]
param(
  # 已知的模型别名（写这些时真名要去 *_MODEL_NAME 里查）
  [string[]]$Aliases = @('sonnet', 'opus', 'haiku', 'fable')
)

$ErrorActionPreference = 'Stop'

function Get-ClaudeSettings {
  $p = Join-Path $env:USERPROFILE '.claude\settings.json'
  if (-not (Test-Path $p)) { return $null }
  try { return (Get-Content $p -Raw -Encoding utf8 | ConvertFrom-Json) } catch { return $null }
}

$settings = Get-ClaudeSettings
$model = $null
$source = $null

if ($settings -and $settings.model) {
  $raw = [string]$settings.model
  $source = 'settings.json'
  # 别名 → 查环境变量里的真名映射
  if ($Aliases -contains $raw.ToLowerInvariant()) {
    $key = 'ANTHROPIC_DEFAULT_' + $raw.ToUpperInvariant() + '_MODEL_NAME'
    $mapped = [Environment]::GetEnvironmentVariable($key)
    if (-not $mapped -and $settings.env) {
      $mapped = $settings.env.$key
    }
    if ($mapped) { $model = $mapped; $source = "settings.json(model=$raw) + $key" }
    else { $model = $raw }
  }
  else {
    $model = $raw
  }
}

# 兜底：settings.json 没写 model 时，看那组映射里有没有非别名的真名
if (-not $model -and $settings -and $settings.env) {
  foreach ($prop in $settings.env.PSObject.Properties) {
    if ($prop.Name -like 'ANTHROPIC_DEFAULT_*_MODEL_NAME' -and $prop.Value) {
      $model = [string]$prop.Value
      $source = 'settings.json env 里的 *_MODEL_NAME'
      break
    }
  }
}

# ── 强度 ────────────────────────────────────────────────────────────
$effort = [Environment]::GetEnvironmentVariable('CLAUDE_CODE_EFFORT_LEVEL')
if (-not $effort -and $settings -and $settings.env) {
  $effort = $settings.env.CLAUDE_CODE_EFFORT_LEVEL
}
# claude 只认这几档（见 `claude --help` 的 --effort 说明）
$validEfforts = @('low', 'medium', 'high', 'xhigh', 'max')
if ($effort -and ($validEfforts -notcontains $effort.ToLowerInvariant())) {
  Write-Warning "probe-claude: 强度 `"$effort`" 不在 claude 认可的档位里，忽略"
  $effort = $null
}

[ordered]@{
  model  = $model
  effort = if ($effort) { $effort.ToLowerInvariant() } else { $null }
  source = $source
} | ConvertTo-Json -Compress
