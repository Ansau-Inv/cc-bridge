# cc-bridge 升级检查 —— dsh / dsh-tui 升版本后跑这个
#
#   pwsh -File .\check-upgrade.ps1              # 全跑（含真跑 claude，约 1-2 分钟）
#   pwsh -File .\check-upgrade.ps1 -Fast        # 跳过 runtime（只查契约，几秒）
#   pwsh -File .\check-upgrade.ps1 -Verbose     # 显示每项细节
#
# 设计意图：
#   升级 dsh 之后最怕的是「能跑但契约变了」—— 比如 0.2.0 把 end 帧的
#   outcome.kind 从 'settled' 改成 'committed'，TUI 恰好容错所以不报错，
#   但换个实现就炸。这类问题跑一遍界面看不出来。
#
#   所以这个脚本查的是**契约**（类型定义、导出、事件白名单），
#   不查界面。界面的事交给 headless 那几条 runtime 用例。
#
# 检查项定义在 contracts.json 里 —— 改依赖时只动那个文件。
#
# 自检（-SelfTest）：脚本最怕的是「永远报绿」。所以内置了一个自检模式：
# 临时把 event 白名单里的一个类型删掉，跑一遍，确认它**变红**，然后还原。
# 绿不了的自检比没自检更糟，所以这个开关值得留着。

[CmdletBinding()]
param(
    # 跳过 runtime（不真起 claude），只做静态契约核对
    [switch]$Fast,
    # 输出更啰嗦
    [switch]$Detailed,
    # 自检：故意破坏一处契约，确认检查真的抓得到（改完自动还原）
    [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ── 统一 UTF-8，不然中文在部分终端是乱码 ──────────────────────────────
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = $PSScriptRoot
$contractsPath = Join-Path $root 'contracts.json'
if (-not (Test-Path $contractsPath)) { throw "找不到 contracts.json（应在 $root）" }

# ── DSH_HOME 兜底（必须在任何 Join-Path 之前）────────────────────────
#
# ⚠️ `DSH_HOME` **不是持久化的环境变量** —— 它由 dsh harness 在启动进程时
#    注入，所以从「普通终端」直接跑本脚本时它是 `$null`。
#    而 `Join-Path $null 'x'` 会**抛异常**，加上下面 `$ErrorActionPreference
#    = 'Stop'`，脚本会在第一行就死掉，报的还是难懂的绑定错误。
#
#    实测：`[Environment]::GetEnvironmentVariable('DSH_HOME','User')` 和
#    `'Machine'` 都返回空。默认位置是 `~/.dsh`。
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$appData = if ($env:APPDATA) { $env:APPDATA } else { $null }
$C = Get-Content $contractsPath -Raw -Encoding utf8 | ConvertFrom-Json

# ── 结果收集 ────────────────────────────────────────────────────────
$script:pass = 0
$script:warn = 0
$script:fail = 0
$script:fails = [System.Collections.Generic.List[string]]::new()
$script:warns = [System.Collections.Generic.List[string]]::new()

function Ok($msg) {
    $script:pass++
    Write-Host "  [ok] " -ForegroundColor DarkGreen -NoNewline
    Write-Host $msg
}
function Warn($msg) {
    $script:warn++
    $script:warns.Add($msg)
    Write-Host "  [!]  " -ForegroundColor Yellow -NoNewline
    Write-Host $msg
}
function Bad($msg) {
    $script:fail++
    $script:fails.Add($msg)
    Write-Host "  [X]  " -ForegroundColor Red -NoNewline
    Write-Host $msg
}
function Head($msg) {
    Write-Host ''
    Write-Host "── $msg " -ForegroundColor Cyan -NoNewline
    Write-Host ('─' * [Math]::Max(0, 58 - $msg.Length)) -ForegroundColor DarkCyan
}
function Detail($msg) {
    if ($Detailed) { Write-Host "       $msg" -ForegroundColor DarkGray }
}

# ── 定位 DSH 安装位置 ───────────────────────────────────────────────
# 注意：不能用 DSH_HOME/profiles —— 宿主实际跑的是 npm 全局里那一份，
# 两处都可能有包、且**不是同一份模块实例**（这个坑在 README 第 2 条）。
# 优先用 dsh 自己的 bin 做解析基点。
function Get-DshNodeModules {
    $candidates = @(
        ($appData ? (Join-Path $appData 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai') : $null),
        (Join-Path $dshHome 'profiles\node_modules\@deepseek-ai')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

function Get-TuiRoot {
    $p = Join-Path $dshHome 'profiles\dsh-tui\node_modules\@deepseek-harness-tui\dsh-tui'
    if (Test-Path $p) { return $p }
    return $null
}

$dshNm = Get-DshNodeModules
$tuiRoot = Get-TuiRoot

# dsh 包自己的根目录（Get-DshNodeModules 返回的是它内部的 node_modules/@deepseek-ai）
$dshPkgRoot = if ($dshNm) { Split-Path (Split-Path $dshNm -Parent) -Parent } else { $null }

# ── 契约文件在哪读 ──────────────────────────────────────────────────
#
# 默认读真实的上游安装。但 `-SelfTest` 会把它指向一份**临时副本** ——
# 这样自检就完全不碰上游文件（原因见下面 SelfTest 那段的注释）。
$typesRoot = if ($env:CCB_SELFTEST_TYPES_ROOT) { $env:CCB_SELFTEST_TYPES_ROOT } else { $dshNm }

# ── 自检模式 ────────────────────────────────────────────────────────
#
# 脚本最怕「永远报绿」—— 检查写松了自己不知道。所以自检就干一件事：
# 故意破坏一处契约，确认检查**真的变红**。
#
# ⚠️ 关键：**在上游文件的一份临时副本上破坏，绝不碰原文件**。
#
#    早先的写法是把 npm 全局的 `@deepseek-ai/dsh-session` 源码直接
#    `Set-Content` 改掉、跑完再 `Move-Item` 还原：
#
#        Set-Content $victim -Value $broken   # ← 改写真实的上游包
#        ...
#        Move-Item $backup $victim -Force      # ← finally 里还原
#
#    这段窗口里如果被 Ctrl+C / 关窗 / 强杀打断，**上游包就永久损坏了**，
#    而且没有任何提示 —— 用户下次启动 dsh 会莫名其妙地缺事件类型。
#    对一个要公开给别人用的仓库来说，这是不能接受的（改的是别人机器上的
#    npm 全局安装）。
#
#    现在改成：整个自检跑在 `$env:TEMP\ccb-selftest-<guid>\` 里，
#    用 `CCB_SELFTEST_TYPES_ROOT` 环境变量把子进程的读取根指过去。
#    上游文件全程只被 `Get-Content` 读一次。
if ($SelfTest) {
    Write-Host ''
    Write-Host '自检：在临时副本上故意破坏一处契约，确认检查抓得到' -ForegroundColor White
    if (-not $dshNm) { Write-Host '找不到 DSH 包，无法自检' -ForegroundColor Red; exit 1 }

    $srcFile = Join-Path $dshNm 'dsh-session\lib\types\known-event-types.js'
    if (-not (Test-Path $srcFile)) { Write-Host "找不到 $srcFile" -ForegroundColor Red; exit 1 }

    # ── 搭沙盒 ──────────────────────────────────────────────────────
    # 目录结构要和上游一致，因为 $typesRoot 是**替根**，契约里的
    # `dsh-session/lib/types/...` 相对路径要能对上。
    $sandbox = Join-Path $env:TEMP ("ccb-selftest-" + [guid]::NewGuid().ToString('n'))
    $dstDir = Join-Path $sandbox 'dsh-session\lib\types'
    $dstFile = Join-Path $dstDir 'known-event-types.js'

    $caught = $false
    try {
        New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
        $orig = Get-Content $srcFile -Raw -Encoding utf8
        $broken = $orig -replace "'tool/result',", ''
        if ($broken -eq $orig) {
            Write-Host '破坏失败（没找到 tool/result 字面量）—— 契约文本可能变了' -ForegroundColor Red
            exit 1
        }
        Set-Content $dstFile -Value $broken -Encoding utf8 -NoNewline
        Write-Host '  已在临时副本里删掉 tool/result，跑检查…' -ForegroundColor DarkGray

        $env:CCB_SELFTEST_TYPES_ROOT = $sandbox
        try {
            $probeOut = & pwsh -NoProfile -File $PSCommandPath -Fast 2>&1 | Out-String
        } finally {
            Remove-Item Env:\CCB_SELFTEST_TYPES_ROOT -ErrorAction SilentlyContinue
        }
        $caught = $probeOut -match 'tool/result'
        if ($caught) {
            Write-Host '  [ok] 检查抓到了（报红），脚本有效' -ForegroundColor DarkGreen
        } else {
            Write-Host '  [X]  检查没抓到 —— 检查逻辑太松，要修' -ForegroundColor Red
        }
    } finally {
        # 只删我们自己刚建的那个 GUID 目录（多一道前缀校验，避免路径算错删到别处）
        if ($sandbox -and (Split-Path $sandbox -Leaf).StartsWith('ccb-selftest-')) {
            Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
        }
        Write-Host '  临时副本已清理（上游文件全程只读）' -ForegroundColor DarkGray
    }
    Write-Host ''
    if ($caught) { exit 0 } else { exit 1 }
}

Write-Host ''
Write-Host 'cc-bridge 升级检查' -ForegroundColor White
Write-Host "  仓库: $root"

# ════════════════════════════════════════════════════════════════════
Head '版本'
# ════════════════════════════════════════════════════════════════════
if (-not $dshNm) { Bad '找不到 DSH 包目录（dsh 装了吗？）' }
else {
    try {
        $pkgJson = Join-Path $dshPkgRoot 'package.json'
        if (Test-Path $pkgJson) {
            $dshVer = (Get-Content $pkgJson -Raw -Encoding utf8 | ConvertFrom-Json).version
            Ok "dsh       $dshVer"
        } else { Warn "读不到 dsh 版本（没找到 $pkgJson）" }
    } catch { Warn "读不到 dsh 版本：$($_.Exception.Message)" }
}
if ($tuiRoot) {
    $tuiVer = (Get-Content (Join-Path $tuiRoot 'package.json') -Raw | ConvertFrom-Json).version
    Ok "dsh-tui   $tuiVer"
} else { Warn '找不到 dsh-tui' }
try {
    $claudeExe = (Get-Command claude -ErrorAction SilentlyContinue).Source
    if ($claudeExe) { Ok "claude    $claudeExe" } else { Warn '找不到 claude 可执行文件' }
} catch { Warn '找不到 claude' }

if (-not $dshNm) {
    Write-Host ''
    Write-Host '没有 DSH 包目录，后续检查无法进行。' -ForegroundColor Red
    exit 1
}

# ════════════════════════════════════════════════════════════════════
Head '核心包导出'
# ════════════════════════════════════════════════════════════════════
foreach ($pkg in $C.packages.PSObject.Properties) {
    $name = $pkg.Name
    $spec = $pkg.Value
    # StrictMode 下访问不存在的属性会抛 —— optional 只有部分包有
    $isOptional = ($spec.PSObject.Properties.Name -contains 'optional') -and $spec.optional
    $entry = Join-Path (Join-Path $dshNm $name) $spec.entry
    if (-not (Test-Path $entry)) {
        if ($isOptional) { Warn "$name 不存在（可选：$($spec.why)）" }
        else { Bad "$name 不存在（$entry）—— $($spec.why)" }
        continue
    }
    # 用 node 实际 require，比 grep 可靠（能看到真实导出）
    #
    # 踩坑：一开始把 key 列表内插进 node 的 -e 脚本，结果引号被 PowerShell
    # 吃掉、字符串被当变量展开，探测回来的是
    #   {"a":"undefined","g":"undefined",...}（每个键只剩首字母）。
    # 改成把 key 列表序列化成 JSON 传进去，彻底避开两边引号规则打架。
    $url = 'file:///' + ($entry -replace '\\', '/' -replace ' ', '%20')
    $keyJson = ConvertTo-Json @($spec.exports.PSObject.Properties.Name) -Compress
    $probe = @"
(async () => {
  try {
    const m = await import('$url');
    const keys = $keyJson;
    const out = {};
    for (const k of keys) out[k] = typeof m[k];
    console.log(JSON.stringify(out));
  } catch (e) { console.log(JSON.stringify({ __error: String(e.message) })); }
})()
"@
    $res = & node -e $probe 2>&1 | Out-String
    $got = $null
    try { $got = $res.Trim() | ConvertFrom-Json } catch { $got = $null }
    # StrictMode 下访问不存在的属性会抛，所以先判属性在不在
    $loadErr = $null
    if ($got -and ($got.PSObject.Properties.Name -contains '__error')) { $loadErr = $got.__error }
    if ($loadErr) {
        Bad "$name 加载失败：$loadErr"
        continue
    }
    if (-not $got) {
        Bad "$name 探测无输出：$($res.Trim())"
        continue
    }
    foreach ($exp in $spec.exports.PSObject.Properties) {
        # StrictMode 下 $got.名字 对不存在的属性会抛，统一走 PSObject 取
        $prop = $got.PSObject.Properties | Where-Object { $_.Name -eq $exp.Name } | Select-Object -First 1
        $actual = if ($prop) { $prop.Value } else { $null }
        if ($actual -eq $exp.Value) { Ok "$name → $($exp.Name)()" ; Detail $spec.why }
        elseif ($isOptional) { Warn "$name → $($exp.Name) 是 $actual（期望 $($exp.Value)），可选" }
        else { Bad "$name → $($exp.Name) 是 $actual（期望 $($exp.Value)）—— $($spec.why)" }
    }
}

# ════════════════════════════════════════════════════════════════════
Head 'DSH 类型契约'
# ════════════════════════════════════════════════════════════════════
# 用 [string]::Contains 而不是 -like：
#
# 踩坑：`$text -like "*font.glyphs[ch] ?? font.fallback*"` **永远匹配不到** ——
# PowerShell 的 `-like` 里 `[...]` 是**字符类通配符**（`[ch]` = "c 或 h"），
# 不是字面量。契约文本里带方括号的（数组下标、类型标注）全都会误报缺失。
# 改成 .Contains() 走纯字面量匹配，`[` `]` `*` `?` 都不再有特殊含义。
function Test-ContainsLiteral([string]$Haystack, [string]$Needle) {
    return $Haystack.Contains($Needle, [System.StringComparison]::Ordinal)
}

foreach ($t in $C.types) {
    # 用 $typesRoot 而不是 $dshNm —— 自检时它指向临时副本（见 SelfTest 段）。
    $f = Join-Path $typesRoot $t.file
    if (-not (Test-Path $f)) { Bad "$($t.file) 不存在 —— $($t.why)"; continue }
    $text = Get-Content $f -Raw -Encoding utf8
    $missing = @()
    foreach ($needle in $t.must) { if (-not (Test-ContainsLiteral $text $needle)) { $missing += $needle } }
    # literal 数组：逐个检查字面量（事件白名单那种）。
    # StrictMode 下 $t.literal 对没有该键的对象会抛，先判存在。
    if ($t.PSObject.Properties.Name -contains 'literal') {
        foreach ($lit in $t.literal) {
            if (-not (Test-ContainsLiteral $text "'$lit'") -and
                -not (Test-ContainsLiteral $text "`"$lit`"")) { $missing += $lit }
        }
    }
    if ($missing.Count -eq 0) { Ok "$($t.file)" ; Detail $t.why }
    else { Bad "$($t.file) 缺：$($missing -join ', ') —— $($t.why)" }
}

# ════════════════════════════════════════════════════════════════════
Head 'dsh-tui 行为契约'
# ════════════════════════════════════════════════════════════════════
if (-not $tuiRoot) { Warn '没有 dsh-tui，跳过' }
else {
    foreach ($t in $C.tui) {
        $f = Join-Path $tuiRoot $t.file
        if (-not (Test-Path $f)) { Bad "$($t.file) 不存在 —— $($t.why)"; continue }
        $text = Get-Content $f -Raw -Encoding utf8
        $missing = @()
        foreach ($needle in $t.must) { if (-not (Test-ContainsLiteral $text $needle)) { $missing += $needle } }
        if ($missing.Count -eq 0) { Ok "$($t.file)" ; Detail $t.why }
        else { Bad "$($t.file) 缺：$($missing -join ', ') —— $($t.why)" }
    }
}

# ════════════════════════════════════════════════════════════════════
Head 'patch 能否解析'
# ════════════════════════════════════════════════════════════════════
# 精确抓某个 id **那一段**再判字段。
# 踩坑：dump 里同时出现 'id: agent-loop' 和 'disabled: true' 就算过 —— 太松，
# 别的行也有 disabled: true。按行切段：从 `- id: X` 到下一个顶层 `- id:`。
function Get-DumpSegment([string]$Dump, [string]$Id) {
    $lines = $Dump -split "`r?`n"
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match ('^\s*-?\s*id:\s*' + [regex]::Escape($Id) + '\s*$')) { $start = $i; break }
    }
    if ($start -lt 0) { return $null }
    $seg = @($lines[$start])
    for ($i = $start + 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*-\s+id:\s') { break }
        $seg += $lines[$i]
    }
    return ($seg -join "`n")
}

function Test-AgentLoopDisabled([string]$Seg, [bool]$ExpectDisabled) {
    if ($null -eq $Seg) { Bad 'composition 里找不到 agent-loop 行'; return }
    $isDisabled = $Seg -match 'disabled:\s*true'
    $isEnabled = $Seg -match 'disabled:\s*false'
    if ($ExpectDisabled) {
        if ($isDisabled) { Ok '窗口 overlay：agent-loop 已被禁用' }
        elseif ($isEnabled) { Bad '窗口 overlay：agent-loop 的 disabled 是 false —— factory 会被官方 loop 抢占' }
        else { Bad "窗口 overlay：agent-loop 那一段没写 disabled`n$Seg" }
    } else {
        if ($isDisabled) { Bad 'host 组合包禁了 agent-loop —— 日常 DeepSeek 会被换掉' }
        else { Ok 'host 组合包：agent-loop 仍启用' }
    }
}

$hostPatch = Join-Path $root 'host.patch.yml'
$windowPatch = Join-Path $root 'cordis.patch.yml'
$corePatch = Join-Path $root 'probe-core-only.yml'

function Test-ProfileHasCcBridge([string]$ProfileName) {
    $pkg = Join-Path $dshHome "profiles\$ProfileName\package.json"
    if (-not (Test-Path -LiteralPath $pkg)) { return $false }
    try {
        $j = Get-Content -LiteralPath $pkg -Raw -Encoding utf8 | ConvertFrom-Json
        return @($j.dsh.profile.bundles) -contains 'cc-bridge'
    } catch { return $false }
}

# 已经 plugin add 过再叠 host.patch.yml 会二次 insert。没装才 --patch 插入。
$hostDumpArgs = @('--profile', 'dsh-tui')
if (-not (Test-ProfileHasCcBridge 'dsh-tui')) { $hostDumpArgs += @('--patch', $hostPatch) }
$winDumpArgs = @($hostDumpArgs) + @('--patch', $windowPatch)
$headlessHasBundle = Test-ProfileHasCcBridge 'headless'

try {
    $hostDump = & dsh @hostDumpArgs --dump-config 2>&1 | Out-String
    Test-AgentLoopDisabled (Get-DumpSegment $hostDump 'agent-loop') $false
    $ccbHost = Get-DumpSegment $hostDump 'cc-bridge'
    if ($ccbHost) {
        Ok 'host：cc-bridge 已挂上'
        if ($ccbHost -match 'mode:\s*host') {
            Bad 'host 行写死了 config.mode: host —— 会压过 CCB_MODE / 橙色窗'
        } else {
            Ok 'host 行没有写死 mode（默认 host，橙色窗靠 overlay / 环境）'
        }
        $hostInsertCount = ([regex]::Matches($hostDump, '(?m)^\s*- id: cc-bridge\s*$')).Count
        if ($hostInsertCount -gt 1) { Bad "host dump 里 cc-bridge 出现 $hostInsertCount 次（重复 insert）" }
        else { Ok 'host dump 只有一行 cc-bridge' }
    } else {
        Bad 'host：cc-bridge 没挂上'
    }
    if ($hostDump -match 'inject:[\s\S]{0,200}attachments') { Ok 'host inject 含 attachments' }
    else { Warn 'host inject 里没看到 attachments（图片会降级成文字）' }
} catch {
    Bad "host dump-config 失败：$($_.Exception.Message)"
}

try {
    $winDump = & dsh @winDumpArgs --dump-config 2>&1 | Out-String
    Test-AgentLoopDisabled (Get-DumpSegment $winDump 'agent-loop') $true
    $ccbWin = Get-DumpSegment $winDump 'cc-bridge'
    if ($ccbWin) {
        Ok '窗口 overlay：cc-bridge 仍是一行'
        if ($ccbWin -match 'maidArt:') { Ok '窗口 overlay：已覆盖外观' }
        else { Warn '窗口 overlay：没看到 maidArt' }
        $winCount = ([regex]::Matches($winDump, '(?m)^\s*- id: cc-bridge\s*$')).Count
        if ($winCount -gt 1) { Bad "窗口 dump 里 cc-bridge 出现 $winCount 次（overlay 又 insert 了一行）" }
        else { Ok '窗口 dump 没有双挂 cc-bridge' }
    } else {
        Bad '窗口 overlay：cc-bridge 丢了'
    }
} catch {
    Bad "窗口 dump-config 失败：$($_.Exception.Message)"
}

try {
    $pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding utf8 | ConvertFrom-Json
    if ($pkg.dsh.bundle.patch -eq './host.patch.yml') { Ok 'dsh.bundle.patch 指向 host.patch.yml' }
    else { Bad "dsh.bundle.patch 是 $($pkg.dsh.bundle.patch) —— 日常 plugin add 会换 factory" }
    if ($pkg.icon) { Ok 'package.json 声明了 icon' } else { Warn '没声明 icon（插件卡会用默认图）' }
} catch {
    Bad "读 package.json 失败：$($_.Exception.Message)"
}

# 运行时仍走 headless + 核心 overlay。$patchFile 给下面真跑 claude 用。
$patchFile = $corePatch
$script:ccbHostPatch = $hostPatch

# ════════════════════════════════════════════════════════════════════
if (-not $Fast) {
    Head '运行时（真跑 claude）'
    # 日志现在落在插件的 STATE_DIR（`$DSH_HOME/cc-bridge/bridge.log`），
    # 不再是仓库根目录 —— 见 src/index.mjs 的 STATE_DIR 注释。
    $stateDir = if ($env:CCB_STATE_DIR) { $env:CCB_STATE_DIR }
        elseif ($env:DSH_HOME) { Join-Path $env:DSH_HOME 'cc-bridge' }
        else { Join-Path $HOME '.cc-bridge' }
    $logFile = Join-Path $stateDir 'bridge.log'
    foreach ($case in $C.runtime) {
        if (Test-Path $logFile) { Remove-Item $logFile -Force }
        # 每次换一个新的 dsh session，避免 --resume 干扰
        $rtArgs = @('--profile', 'headless')
        if (-not $headlessHasBundle) { $rtArgs += @('--patch', $script:ccbHostPatch) }
        $rtArgs += @('--patch', $patchFile, $case.prompt)
        $out = & dsh @rtArgs 2>&1 | Out-String
        $log = if (Test-Path $logFile) { Get-Content $logFile -Raw -Encoding utf8 } else { '' }
        $missing = @()
        foreach ($needle in $case.expect) { if ($log -notlike "*$needle*") { $missing += $needle } }
        if ($missing.Count -eq 0) {
            Ok "$($case.id)"
            # 顺手把关键数字打出来，便于人工核对
            $m = [regex]::Match($log, 'turn \d+ done[^\r\n]*')
            if ($m.Success) { Detail $m.Value }
        } else {
            Bad "$($case.id) 日志缺：$($missing -join ', ') —— $($case.why)"
            $tail = ($log -split "`n" | Select-Object -Last 6) -join "`n"
            if ($Detailed) { Write-Host $tail -ForegroundColor DarkGray }
        }
    }
} else {
    Head '运行时'
    Write-Host '  [跳过] -Fast 模式' -ForegroundColor DarkGray
}

# ════════════════════════════════════════════════════════════════════
# 汇总
# ════════════════════════════════════════════════════════════════════
Write-Host ''
Write-Host ('═' * 60) -ForegroundColor DarkCyan
Write-Host "通过 $script:pass  警告 $script:warn  失败 $script:fail" -ForegroundColor White

if ($script:fails.Count -gt 0) {
    Write-Host ''
    Write-Host '失败项（要改代码）：' -ForegroundColor Red
    $script:fails | ForEach-Object { Write-Host "  · $_" -ForegroundColor Red }
}
if ($script:warns.Count -gt 0) {
    Write-Host ''
    Write-Host '警告（多半无害，但要知情）：' -ForegroundColor Yellow
    $script:warns | ForEach-Object { Write-Host "  · $_" -ForegroundColor Yellow }
}

Write-Host ''
if ($script:fail -gt 0) {
    Write-Host '先看 README「版本适配」那一节 —— 里面记了上一次升级改了哪四处。' -ForegroundColor Yellow
    exit 1
}
if (-not $Fast) {
    Write-Host '静态契约都过了。界面的事再手工过一遍：' -ForegroundColor DarkGray
    Write-Host '  普通一轮 → 工具卡片 → esc 中断 → ctx hover' -ForegroundColor DarkGray
}
exit 0
