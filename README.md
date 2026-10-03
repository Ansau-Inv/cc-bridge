# cc-bridge —— DeepSeek 指挥，Claude Code 干活

日常 **DeepSeek Harness**（网页 / `dsh-tui`）继续当主 Agent。
打 `/ccb <任务>` 另开一扇**独立终端**，里面是完整的 cc-bridge-tui：
橙色女仆、`CLAUDE CODE / BRIDGE` 大标题、Claude Code 走 stream-json。

DeepSeek 用 `ccb_send` / `ccb_status` / `ccb_list` / `ccb_cancel` 当 teammate 指挥那扇窗；
你也可以进橙色窗口自己跟 Claude 聊。日常窗口**不换** factory，官方女仆不动。

独立 profile（`run-plugin.ps1`）是特色整窗模式，整窗换成 Claude，不是日常用法。

## 现在怎么用

正式用法：把本仓库装进日常 profile。组合包只插 `/ccb` 和 `ccb_*`，**不**换 factory、**不**改立绘。

```powershell
dsh plugin --profile dsh-tui add <本仓库绝对路径>
# 可选：网页 / 无界面
dsh plugin --profile web add <本仓库绝对路径>
dsh plugin --profile headless add <本仓库绝对路径>
```

然后和平时一样开窗口（工作目录跟你的项目，不要先 `cd` 进本仓库）：

```powershell
dsh --profile dsh-tui
# 或：dsh web
```

卸掉（只从那个 profile 拿掉本插件，不动 dsh / dsh-tui / claude 的安装）：

```powershell
dsh plugin --profile dsh-tui remove cc-bridge
dsh plugin --profile web remove cc-bridge
dsh plugin --profile headless remove cc-bridge
```

刚装完如果当前窗口已经开着，重启一次让组合包生效。装上之后 `/ccb` 由插件注册表进命令表。

没有 plugin add、只想临时试：`<path-to-repo>\run-host.ps1`（本次 `--patch`，不改 profile）。

窗口看起来仍是官方女仆。打 `/ccb` 时：

- 输入框会当斜杠命令截下来（不会进模型）
- 另开一扇橙色窗口，cwd 跟当前 DeepSeek 会话
- 任务写进信箱，橙色窗口里的 Claude 去干

在已经装了本插件（或 run-host.ps1 拉起）的 DeepSeek 窗口里：

```
/ccb 搜索网页，总结今天的某某新闻
```

会新开一扇橙色窗口，任务已经在信箱里。窗口绑上 Channel 后自己开工，
不用你先打字。之后 DeepSeek 可以：

- `ccb_send` —— 再下一道任务（只发给还活着的窗；可选 `spawn: true` 没活窗就新开）
- `ccb_status` —— 看是否还活着、以及最近一轮回复（不要阻塞空等）
- `ccb_list` —— 列出窗口，并标明 alive / starting / dead
- `ccb_cancel` —— 请窗口中断当前这一轮（等价于橙色窗里按 Esc，不杀 TUI）

通信是文件信箱（`$DSH_HOME/cc-bridge/mailbox/`），不是再开一轮
`claude --print`。同一 UUID 并发 `--print` 会互相踩，所以窗口独占那条进程。

### 第一轮为什么慢（不是没连上）

橙色窗口里的 Claude 走 `claude --print`。**每一次新会话**都要重新加载
本机 Claude 的整套工具 / MCP / 技能（实测常见 300+ 工具、约 24k tokens）。
第一轮常要 **1–3 分钟**，界面可能暂时没字。第二轮起走 `--resume`，
缓存命中后通常几秒就回。

不要在第一轮还没回时对橙色窗 `/clear` 再重试 —— `/clear` 丢掉映射，
下一轮又是一次 24k 冷启动。

状态 `loading` / 第一轮 `running` 且还没回复，就是在加载工具面。
窗口关了或没心跳时，`ccb_status` 会标 **已死**；这时再 `ccb_send`
会报错，不要把任务丢给空对象。

可选：把仓库里的 `skills/cc-bridge` 拷到 `~/.dsh/skills/cc-bridge`，
日常 DeepSeek 会按这份说明轮询、取消、避开死窗。不拷也能用工具。

直接开橙色窗（调试 / 自己跟 Claude 聊，不经 DeepSeek）：

```powershell
.\run.ps1
```

特色整窗（独立 profile，整窗就是 Claude）：

```powershell
.\install-plugin.ps1 -WithTui
.\run-plugin.ps1
.\uninstall-plugin.ps1
```

特色整窗是**另两个 profile 目录**，和日常 `dsh-tui` 分开。
卸特色模式：`.\uninstall-plugin.ps1`。日常窗口要卸本插件用上面的 `plugin remove`。

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| **操作系统** | **Windows**（目前仅支持） | 外观层与全部脚本都依赖 Windows；见下方说明 |
| **PowerShell** | **7+**（`pwsh`，不是 `powershell`） | 脚本用了 PS7 语法 |
| **Node** | **≥ 22.14** | 用了 `module.registerHooks()` 与 `process.getBuiltinModule` |
| **Windows Terminal** | 建议（非必须） | 真图/Sixel 渲染、鼠标交互体验更好 |
| **`dsh`** | 必须 | 本插件是 DSH 插件，没有它无从挂载 |
| **`claude`** | 必须，且在 **PATH** 里 | Claude Code CLI，`claude --version` 能出结果即可 |
| **`dsh-tui`** | **可选** | 没有它核心照跑（headless 可用），但**没有窗口** |

### 关于平台限制

**核心是跨平台的，外观层不是。** 实测：把外观功能全关掉后，核心能在没有
dsh-tui 的 headless profile 里完整跑通（详见「打包与安装」一节的验证方法）。

但作为**产品**，目前只有 Windows 这条路径被验证过：

- 立绘字符画、开屏大字、主题注入都靠 `module.registerHooks()` 改写上游源码，
  依赖 dsh-tui 的**具体实现**（有 65 条契约盯着）
- `kill-mine.ps1` / `launch-test.ps1` / `reset-tab.ps1` 是 Windows 专属
  （`Win32_Process`、`wt.exe`、`AttachConsole`）
- `inject.mjs` 走 Windows 命名管道 `\\.\pipe\...`

想在 macOS / Linux 上用，需要自己适配上面这些 —— 欢迎 PR。

### 找不到 claude 怎么办

启动时如果报「找不到 claude 可执行文件」，说明它不在 PATH 里。
显式指定即可：

```powershell
$env:CLAUDE_EXE = "$env:APPDATA\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"
```

> ⚠️ 要指向**真正的 `.exe`**，不要指 `%APPDATA%\npm\claude.cmd`。
> 那只是个批处理包装器，虽然也能用（插件会经 shell 起它），但多一层转发。

## 版本适配

| 组件 | 验证过的版本 |
|---|---|
| `dsh` | **0.2.0-rc.2** |
| `dsh-tui` | **0.12.0** |
| `claude` | 2.1.x |
| Node | ≥ 22.14（验证过 24） |

跟到 0.2.0 时同步修的地方（详见「踩过的坑」第 18 条）：

- `agent/assistant-stream` 的 **end 帧**：`outcome.kind` 是 `'committed'`
  不是 `'settled'`，且要带 `seq`；end 帧还要 `index`
- **StreamChunk** 的 `text-delta`/`reasoning-delta` 必填 `index`
- **ToolCallRecovery**（0.2.0 新增）取代手写的悬空工具调用回收
- `runMaintenance` 的契约是「占用时**同步抛**」，不是「异步拒绝」

**升级检查清单** —— 一条命令跑完（详见下节）：

```powershell
pwsh -File .\check-upgrade.ps1        # 全跑（含真起 claude，1-2 分钟）
pwsh -File .\check-upgrade.ps1 -Fast  # 只查静态契约（几秒）
pwsh -File .\check-upgrade.ps1 -SelfTest   # 自检：确认检查真的抓得到问题
```

## 安装 / 启动

日常（DeepSeek 指挥 + `/ccb`）：

```powershell
# 仓库放到任意目录后：
dsh plugin --profile dsh-tui add <仓库绝对路径>
dsh --profile dsh-tui
```

橙色窗口（factory + 女仆，给 `/ccb` 或自己开）仍走 `.\run.ps1`：
这次启动叠窗口 overlay（禁 agent-loop、换橙色女仆）。日常窗口不受影响。

**路径全部自适应** —— 仓库可以放在任何目录。立绘等资源在
`cordis.patch.yml` 里写的是**相对路径**（相对插件根目录）。

首次启动前可以确认一下前置条件：

```powershell
claude --version        # 要能出结果
dsh --version
pwsh -File .\check-upgrade.ps1 -Fast   # 契约检查（几秒）
```

### 特色整窗（独立测试 profile）

脚本只建 `cc-bridge-headless` / `cc-bridge-tui` 两个新目录，卸掉就是整目录删除。
**不会**改日常 `dsh-tui` / `headless` / `web`。日常请用上一节的 `plugin add`。

```powershell
.\install-plugin.ps1            # headless 测试 profile
.\install-plugin.ps1 -WithTui   # 再加一份带 dsh-tui 的测试 profile

# 验证（不改日常 profile）
dsh --profile cc-bridge-headless "Reply exactly CORE_OK"
.\run-plugin.ps1                # 开测试 TUI 窗口

.\uninstall-plugin.ps1          # 删掉这两个 profile + 仓库里的 .tmp-plugin-test
```

`dsh plugin add` 会自动把 `cc-bridge` 写进该 profile 的 `bundles`，
pnpm 建成指向本仓库的 junction。headless 实测：`factory 已注册 ✓`，
一轮 `CORE_OK`，映射写在仓库 `.tmp-plugin-test/`，不碰 `~/.dsh/cc-bridge`。

日常窗口：

```powershell
dsh --profile dsh-tui            # 已 plugin add 时：官方女仆 + /ccb
.\run-host.ps1                   # 没装组合包时的临时 --patch
.\run.ps1                        # 橙色整窗（这次启动叠窗口 overlay）
```

### ⚠️ 别被 `dsh-plugin.json` 误导

你可能在别处见过这种文件：

```json
{ "$schema": "https://dsh.community/schemas/dsh-plugin-0.15.json",
  "manifestVersion": "0.15", "facets": { "host": { ... } }, ... }
```

那是 **community v0.15 草案**（随 `@dsh-std/manifest` 发布，有 schema 和校验器），
但**当前 dsh 运行时不读它**，而且那个 `$schema` URL **解析不了**
（包自己的 README 说明：它只是随包发布的校验资源，不表示已指定 canonical URI）。

实测扫描了全部 9 个 dsh 模块，**没有任何一个引用 `dsh-plugin.json`**；
而 `dsh.bundle`（`package.json` 里那个）被 **9 个模块**读取，包括
`dsh-app-boot` 和 `dsh-plugin-manager`。

**所以本仓库用的是 `package.json` + `dsh.bundle`，不放 `dsh-plugin.json`。**

## 升级检查脚本

dsh / dsh-tui 升版本后跑这个。**为什么需要它**：升级最怕的不是崩，
而是「**能跑但契约变了**」—— 比如 0.2.0 把 end 帧的 `outcome.kind`
从 `'settled'` 改成 `'committed'`，TUI 恰好容错所以界面一切正常，
但换个实现就炸。这类问题**看着界面是查不出来的**。

所以脚本查的是**契约**（类型定义、导出、事件白名单），
界面的事交给最后那三条 runtime 用例。

```powershell
pwsh -File .\check-upgrade.ps1            # 全跑
pwsh -File .\check-upgrade.ps1 -Fast      # 跳过 runtime
pwsh -File .\check-upgrade.ps1 -Detailed  # 显示每项的「为什么」
pwsh -File .\check-upgrade.ps1 -SelfTest  # 自检
```

### 检查什么

| 段 | 内容 |
|---|---|
| 版本 | dsh / dsh-tui / claude 的实际版本号 |
| 核心包导出 | `createScope` / `agentEvents` / `ToolCallRecovery` 真的 require 得出来 |
| DSH 类型契约 | 帧协议、StreamChunk、事件白名单、ToolMessageSource… |
| dsh-tui 行为契约 | 注入协议、ctx bar 分段、流式帧消费、排队面板 |
| patch 解析 | host 组合包不禁 agent-loop；窗口 overlay 禁 loop 且不双挂 |
| 运行时 | 真起 claude 跑一轮：普通 / 工具 / 流式 |

### 检查项写在哪

`contracts.json` —— **改依赖时只动那个文件**，脚本自动跟着查。

把它做成数据而不是硬写在脚本里，是因为这张表本身就是一份文档：
一眼能看清「到底依赖了外部哪些东西」，每条还带一句「为什么依赖它」。

### 为什么要有 `-SelfTest`

**这种脚本最大的风险是「永远报绿」** —— 检查写松了自己不知道。
所以内置了自检：临时把事件白名单里的 `tool/result` 删掉，跑一遍，
确认它**变红**，然后还原。

这不是理论担忧 —— 第一版的 agent-loop 检查就写松了：

```powershell
# 第一版（错的）：dump 里同时出现这两个词就算过
$dump -match 'id:\s*agent-loop' -and $dump -match 'disabled:\s*true'
```

composition 里**别的行也有 `disabled: true`**，所以把 agent-loop 的禁用
改成 `false` 时脚本照样报 `[ok]`。实测故意破坏后没抓到，才发现。
现在按行切段，只抓 agent-loop 那一段再判。

### 修过的四个脚本 bug（供参考）

| 症状 | 根因 |
|---|---|
| 探测回来 `{"a":"undefined","g":"undefined",...}` | key 列表内插进 node 脚本，**引号被 PowerShell 吃掉**、字符串被当变量展开 → 改成 `ConvertTo-Json` 传 |
| `找不到属性 "__error"` / `"literal"` / `"optional"` | `Set-StrictMode -Version Latest` 下访问不存在的属性会**抛** → 先 `PSObject.Properties.Name -contains` |
| 读不到 dsh 版本 | 路径多剥了一层（`Get-DshNodeModules` 返回的已经是 `@deepseek-ai` 目录） |
| 带方括号的契约**永远误报缺失** | `-like` 里 `[...]` 是**字符类通配符**（`[ch]` = "c 或 h"），不是字面量 → 改用 `.Contains(…, Ordinal)` |

最后一个值得展开：加「自定义开屏大字」的契约检查时，写了

```powershell
if ($text -notlike "*font.glyphs[ch] ?? font.fallback*") { $missing += $needle }
```

而 `bigfont.js` 里**明明有**这一行，却一直报缺失 —— 因为 `[ch]` 被当成
「`c` 或 `h`」，于是它在找一个不存在的字符串 `font.glyphsc ?? font.fallback`。

改成纯字面量匹配后正常：

```powershell
$text.Contains($needle, [System.StringComparison]::Ordinal)   # → True
$text -like "*font.glyphs[ch] ?? font.fallback*"              # → False（对照）
```

**契约表里凡是带 `[` `]` 的条目都会中这个坑**（数组下标、类型标注都很常见），
所以现在全走 `.Contains()`。

```
dsh-TUI 输入框
   │  handle.agent.followup({content})
   ▼
cc-bridge 的 AgentFactory  ← 本项目
   │  spawn claude --input-format stream-json --output-format stream-json
   ▼
Claude Code
   │  NDJSON 事件
   ▼
session.append('assistant/message' / 'tool/call' / 'tool/result', ...)
   │
   ▼
dsh-TUI 渲染
```

## 为什么走这条路

`AgentRegistry.setFactory()` 是创建 Agent 的**唯一入口**，官方注释点名了这种用法：

> Kept on the `dsh-agent` interface so consumers (**e.g. the ACP bridge**)
> program against `ctx.agents` **without depending on the concrete
> `dsh-agent-loop` package**.

即「换工厂」是设计内支持的扩展点，不是 hack。

对比自己写前端（`../cc-tui`）：那边要复刻进度条、hover、光标、Markdown、
工具卡片、图片渲染、会话切换……这边**一行前端都不用写**。

## 用法

```powershell
# 1. 起 TUI（会在 Windows Terminal 新标签页里跑）
.\run.ps1

# 2. 往运行中的 TUI 注入消息（可选，主要给我调试用）
node inject.mjs --list                                      # 列出活跃会话
node inject.mjs <sessionId> "你的问题"                        # 追加到输入框
node inject.mjs <sessionId> " " --submit                     # 提交
```

正常用的话**直接在 TUI 里打字就行**，`inject.mjs` 是给「没法合成键盘输入」的场景兜底的。

### 无人值守跑一轮（不开窗口）

```powershell
dsh --profile headless --patch .\cordis.patch.yml '你的问题'
```

这个是**最重要的自测手段** —— headless 不需要 TTY，能在纯命令行验证
factory 的全链路。所有 bug 都是先在这里复现再修的。

## 文件

| 文件 | 作用 |
|---|---|
| `src/index.mjs` | 插件本体：注册 AgentFactory、跑 claude、翻译事件 |
| `src/ndjson.mjs` | stdout 行切分（最后一帧可能没有尾换行） |
| `src/session-map.mjs` | dsh sessionId ↔ claude UUID 的解析规则 |
| `src/inbox-queue.mjs` | inbox：`send`/`followup`/`steer`/`inject`；append 只落盘不唤醒 |
| `tests/core.test.mjs` | 上面三块的单测 |
| `src/maid-art.mjs` | 自定义标题立绘：真图缓冲 + 字符画精灵双路替换 |
| `src/splash-title.mjs` | 自定义开屏大字（改字体表的 `tagline`） |
| `src/splash-glyphs.mjs` | 开屏大字缺失字形（C L O U，带变换自校验） |
| `src/theme-orange.mjs` | 暖橙主题 + 标题渐变 + ctx 条分段色 + 反光高光 + 输入框前缀 `❯` |
| `src/subagent-bridge.mjs` | 队友面板桥接：prototype 钩子拿 store 实例（见「队友面板」一节） |
| `src/slash-passthrough.mjs` | 摘掉 dsh-TUI 的本地斜杠命令，`/` 全透传给 claude |
| `src/channel-hooks.mjs` | 拿 live Channel：`/clear` 归零、清屏、菜单抑制、队友快照镜像 |
| `src/brand-rename.mjs` | 品牌名替换：`DeepSeek`→`Claude`、`鲸鱼娘`→`Claude娘`（带跳过列表） |
| `src/tui-roots.mjs` | dsh-tui 三份副本的路径解析（外观层共用） |
| `src/model-route.mjs` | 注册「只作路由声明」的 llm provider —— 状态栏模型名/强度靠它 |
| `package.json` | 插件清单（`dsh plugin add` 用；核心零 npm 依赖，见「打包与安装」） |
| `install-plugin.ps1` / `uninstall-plugin.ps1` / `run-plugin.ps1` | 独立测试 profile 的装 / 卸 / 开窗 |
| `probe-claude.ps1` | 启动前探测 claude 的模型名与思考强度（喂给 patch 的 `!!js`） |
| `launch-test.ps1` | 开测试窗口并**记下 PID**（`.test-pids`），供安全清理 |
| `kill-mine.ps1` | 安全清理测试窗口（只杀账本里的 PID，杀完**自动复位终端模式**） |
| `reset-tab.ps1` | **远程**复位某个 tab 的终端模式（`AttachConsole` + 写 `CONOUT$`） |
| `reset-terminal.ps1` | 在**当前**窗口复位终端模式（`reset-tab` 修不了时的备选） |
| `src/welcome-tagline.mjs` | 自定义开屏欢迎语（改 `i18n.js` 的 `logo-tagline`） |
| `src/preload.mjs` | `--import` 预加载：jsx 包装（ctx 条配色重映射 + 去掉开屏提示行）+ host-registry 源码改写（必须抢在 dsh-tui 之前） |
| `src/sprite-tools.mjs` | 图片处理纯函数（解码 / 裁边 / 补方 / 降采样） |
| `assets/maid.png` | 当前用的立绘（安静版） |
| `assets/maid-happy.png` | 「高兴」版（点击时切换） |
| `host.patch.yml` | **日常组合包**：只 insert cc-bridge（`dsh.bundle.patch` 指向它） |
| `cordis.patch.yml` | 窗口 overlay：禁 agent-loop、覆盖外观；**不再 insert** |
| `contracts.json` | **依赖的外部契约清单**（升级检查脚本照着它查） |
| `check-upgrade.ps1` | **升级检查脚本**（dsh 跳版本后跑） |
| `run.ps1` | 启动脚本（清 `NO_COLOR`） |
| `run-debug-mouse.ps1` | 同上，另开 `DSH_TUI_DEBUG_MOUSE=1`（鼠标问题排查用） |
| `inject.mjs` | 通过命名管道往运行中的 TUI 注入消息 |
| `bridge.log` | 运行日志（每个关键步骤都记） |
| `session-map.json` | dsh sessionId ↔ claude UUID 映射（运行时生成，已 gitignore） |

> **关于运行时文件的位置**：`bridge.log` 和 `session-map.json` **不在仓库里**，
> 它们落在插件的私有状态目录：
>
> ```
> $CCB_STATE_DIR  ||  $DSH_HOME/cc-bridge  ||  ~/.cc-bridge
> ```
>
> 本机是 `C:\Users\<你>\.dsh\cc-bridge\`。这样设计是因为：仓库可能被 clone 到
> 只读位置、或被 npm 装进 `node_modules`（那里不该写运行时状态）；
> 而且日志里含本机路径，放在仓库里容易被误提交。

## 开发辅助工具（**不在本仓库**）

下面这些是开发时配套用的脚本，住在同级的 `cc-tui/tools/` 目录里，
**不属于本仓库**。列在这里只是说明「某些文档里提到的工具在哪」：

| 工具 | 作用 |
|---|---|
| `shot.py` | 截图（`--list` / `--title`） |
| `shot-hwnd.py` | 按 hwnd 精确截某个窗口（多窗口时用这个，别用标题） |
| `hover.py` | 把鼠标移到 TUI 的指定位置触发 hover / 点击 |
| `paste-submit.py` | 经剪贴板粘贴并提交（绕过中文键盘布局问题） |
| `prep-maid-art.py` | 清洗立绘源图（补 alpha、吸附调色板）→ `assets/` |
| `preview-maid.py` | 不开终端、直接把管线结果渲染出来看 |
| `verify-click.py` | 验证「点击变表情」：连拍 + 立绘区像素哈希判定 |
| `inject.mjs` | **在本仓库里** —— 注入文本/提交，比合成键盘可靠 |

> 想自己搭一套的话，核心是 `Windows API` 三件套：`EnumWindows` 找窗口、
> `PrintWindow`/`BitBlt` 截图、`SendInput` 合成输入。踩过的坑在
> 「踩过的坑」一节里都有（尤其是 `SendInput` 的 `argtypes` 必须写全）。

### 鼠标测试的关键坑：`SetCursorPos` 不产生终端鼠标事件

**这是花了半轮才定位到的。** 终端里的鼠标事件是终端把输入翻成
`\x1b[<35;col;rowM` 塞进 stdin 的；`SetCursorPos` 只改光标位置，
**不经过那条路**，所以 TUI 永远收不到 —— 日志里一条 `mouse arrive` 都没有。

必须用：

```python
u.mouse_event(0x0001 | 0x8000, ax, ay, 0, 0)   # MOUSEEVENTF_MOVE | ABSOLUTE
# ax/ay 是 0..65535 的虚拟屏幕归一化坐标
```

换成它之后事件立刻到达。

**排查用的内部视角**：`DSH_TUI_DEBUG_MOUSE=1` 会往
`~/.dsh-tui/mouse-debug.log` 写：

```
alt-screen enter {"mouseTracking":true,"inkFound":true}
stdout:1049 {"head":"\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h"}
mouse arrive {"button":35,"action":"press","col":111,"row":44,"clicksDisabled":false}
```

`button 35` = 32(motion) + 3(no button) = **无按键移动**，即 hover。
**空日志 = 终端没发序列**（不是应用层丢的）—— 源码注释里明说了这一点。

## 踩过的坑（都值得记）
### 1. `inject` 声明：先误删，后必须加回来

开始写 `inject: ['agents','sessions']` → 插件永远 pending、`apply` 不执行。
当时判断成「inject 导致挂起」，删掉改成软探测轮询。

**那个判断是错的。** 后来 TUI 报：

```
cannot get property "subagents" without inject
```

查 cordis 源码（`lib/index.js:676`）才明白 —— `ctx` 是 Proxy，
**只有声明过的属性才可访问**，否则直接抛。`inject` 不是可选项，是访问契约。

**而且 patch YAML 里的 `inject` 会覆盖模块里 `export` 的那份** ——
两边必须一致，少一个就在 setup 阶段以那个名字报错。

### 2. 模块实例必须和宿主是同一份

```
直接 import           → Cannot find package（插件在 profile 外，不在解析链上）
按 $DSH_HOME 推绝对路径 → 能加载，但 scopeOf() 认不出我 mint 的 scope
```

原因是 **`kScope` 是个 Symbol**，两份 `dsh-scope` 模块实例的 Symbol 不同，
我建的 scope 宿主的 `scopeOf()` 看不见。

还有个更阴的：包名写成 `dsh-scope`（少了 `@deepseek-ai/` 前缀），
`createRequire` 报 `Cannot find module 'dsh-scope'` —— 这个错藏在一堆
失败信息里，排查了好几轮才发现。

**正解**：用 `createRequire` 锚在 `$DSH_HOME/profiles/node_modules`，
从**宿主的模块图**里解析（`resolveFromHost()`）。

### 3. `createScope` 的 key 必须是对象

```js
createScope(ctx, session.id)   // ✗ TypeError: Invalid value used as weak map key
createScope(ctx, agent)        // ✓ 官方也是传 agent 实例
```

`dsh-scope` 内部用 `new WeakMap()` 存父链，WeakMap 的键只能是对象。

**顺带**：所以得**先建 agent 骨架，再 mint scope，最后把 ctx 接回去** ——
不能像直觉那样先建 scope 再建 agent。

### 4. scope 的父级要用插件自己的 ctx

```js
createScope(ownerCtx, agent)   // ✗ setup 报 "subagents without inject"
createScope(pluginCtx, agent)  // ✓
```

`ownerCtx` 是 dsh-tui 给的上下文，它没声明 `subagents`。
而 `inject` 是**插件级**声明 —— 我在自己插件上写影响不到 `ownerCtx`，
子 scope 继承过去照样缺。用本插件的 ctx（声明了 `subagents`）做父级才行。

**这个是最绕的**，改了四轮才定位到。

### 5. dsh sessionId ≠ claude sessionId

```
dsh:    session-aaaaaaaa-bbbb-cccc-dddd-...   （带前缀）
claude: 只认自己的 UUID，--resume 传别的报
        "Provided value ... is not a UUID and does not match any session title"
```

所以建了 `session-map.json` 做映射：第一轮不带 `--resume`（让 claude 新建），
从 `result` 事件里拿到真实 UUID 存下来，之后每轮用它续接。

### 6. `tool/result` 需要 `surfaceOp`，`tool/call` 不需要

```
session event "tool/result" is surface-eligible and requires a surfaceOp marker
```

因为 `SurfaceEventType` 包含 `'tool/result'` 但不含 `'tool/call'`。
别顺手给两边都加。

### 7. `ToolMessageSource` 要的是 `callId`，不是 `toolName`

```js
source: { kind: 'tool', toolName: call.name }   // ✗ 卡片永远停在"运行中… (23s)"
source: { kind: 'tool', callId: call.id }       // ✓
```

UI 靠 `source.callId` + `message.toolCallId` 把 result 配对回 call，
缺一个就配不上，卡片停在 pending 态。**两个字段都要给。**

### 7b. `sourceEventSeqs` 才是真正的配对机制

```js
const callSeq = session.append('tool/call', {...}).seq
session.append('tool/result', {...}, {
  surfaceOp: 'append',
  sourceEventSeqs: [callSeq],      // ← 漏了它，卡片照样卡住
})
```

官方 `appendToolResult` 就是这么写的。光有 `callId` 还不够，
`sourceEventSeqs` 把 result 事件**指向**产生它的 call 事件。

### 7c. 一个 step = 一次模型请求，别把整轮塞进一个 step

早先的写法是「整轮 = 一个 step，收完所有工具事件再补写」，结果是：

- 工具卡片不实时（回复完才出现）
- 语义错误（多次模型请求挤在一个 step 里）

改成：**每次 `assistant` 事件开一个 step**（如果这一步带工具调用且
step 里已有内容，说明是工具结果喂回去后的新一轮，先 `step/end` 再
`step/start` 下一个）。

### 7d. TUI 的"排队"面板靠事件驱动，要手动发 `agent/inbox/claimed`

界面底部一直挂着：

```
⏳ 排队 · 回合结束后送达
```

一开始以为是重复提交（查了 `followup` 次数，只有一次）。真正原因在
dsh-tui 的 `channel/binding-events.js`：

```js
// 用户发消息 → 消息进 state.pending
on('agent/inbox/claimed',   retirePending)   // 收到这个才移除
on('agent/inbox/discarded', ...)
```

官方 agent-loop 的 `inbox.claim()` 会发这个事件（带 `message` + `turn`）。
我们的 inbox 在排空时自己发：

```js
dispatch.emit('agent/inbox/claimed', { message, turn })
```

`inbox.append` / `prepend` / `splice` 只改队列，不唤醒；唤醒走
`agent.send(message, target, wakeup)` / `followup` / `steer`。
`inject` = `send(next-step, false)`，等下一次唤醒才跑。

**排查教训**：看到"重复条目"先别急着怪重复提交，先确认它读的是哪份状态。

### 8. UTF-8：三个流都要显式设

漏了 stdin 编码，中文会变成一串 `U+FFFD`，而且 **claude 不报错**，
只会猜乱码的意思 —— 发「今天天气怎么样」被猜成「查内核地址」去查
ntoskrnl/CE/IDA。这个坑在 `../claude-cli/README.md` 里有完整记录。

### 9. 合成键盘输入对 Windows Terminal 无效

- `KEYEVENTF_UNICODE` → WT 收到的是 `` ` `` `}` `J` `\x1f H` 这种垃圾
- `VkKeyScanW` → 只对当前代码页里有 VK 的字符有效，中文没戏
- 还得先抢前台焦点，抢不到就静默丢输入（工具报"已输入 41 个字符"，界面空白）

**改用 dsh-TUI 自己的注入通道**（`inject.mjs`）：命名管道
`\\.\pipe\dsh-tui-inject-<sessionId>`，协议是换行分隔的 JSON。
这个通道是官方为编辑器集成（`dsh.nvim`）设计的，比合成输入可靠得多。

**追加和提交要一次连接里发完** —— 拆成两次调用实战出现过状态不一致。
`inject.mjs` 的 `--submit` 现在是一次连接发两行。

### 10. `--profile` 不同，`DSH_PROFILE_DIR` 会骗你

环境变量里的 `DSH_PROFILE_DIR` 指向启动时的 profile（实测恒为 `dsh-tui`），
但跑 headless 时用的 profile 层是 `headless`。所以解析基点别用它，
直接锚 `profiles/node_modules`（所有 profile 共享的一层）。

### 11. 日志别截断

排查时把 assistant 文本截到 70 字符打日志，看到"文本似乎不全"，
白怀疑了一轮，实际内容是完整的。**日志是证据，不是摘要** ——
要截就在显示层截，别在记录层截。

## 事件结构

对齐 `dsh-agent-loop`（见其 `lib/index.js:968` / `682` / `697`）：

```
turn/start {turn}
  step/start {turn, step:1}                    ← 第 1 次模型请求
  user/message
  assistant/message  [text?, tool-call*]       ← 带 tool-call 块
  tool/call  ...                               ← 每个调用一条
  tool/result ...                              ← 配对，带 sourceEventSeqs
  step/end
  step/start {turn, step:2}                    ← 第 2 次请求（工具结果喂回去）
  assistant/message  [最终文本]
  step/end
turn/end {turn, reason}
```

**一个 step = 一次模型请求**，这是关键。claude 每收到一批工具结果就会
重新发起请求，对应 DSH 的一个新 step。

事件是**边跑边写**的 —— 每收到一个 assistant 事件立刻 append，
所以工具卡片实时出现，不用等整轮结束。

### 12. ctx 用量条：数据要喂，字段名要转dsh-TUI 的 ctx 用量条是原生功能，但**要喂两个事件**才有数据：

**① `assistant/message` 上带 `usage`**

```js
session.append('assistant/message', { ..., usage: {...} }, { surfaceOp: 'append' })
```

字段名是 **camelCase**（`projection.js:685` 读 `event.data.usage`）：

```
{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
```

而 claude 给的是 **snake_case 且名字不同**：

```
{ input_tokens, output_tokens,
  cache_read_input_tokens, cache_creation_input_tokens }
```

**不转就永远是 0，状态栏不显示 ctx。** 换算关系：

| DSH | claude |
|---|---|
| `inputTokens` | `input_tokens` |
| `outputTokens` | `output_tokens` |
| `cacheReadTokens` | `cache_read_input_tokens` |
| `cacheWriteTokens` | `cache_creation_input_tokens` |

UI 侧的公式（`screens/StatusLine.js:96`）：

```js
contextUsed = usage.input + usage.cacheRead + usage.cacheWrite
```

注意只取**最近一次请求**的 usage，不是累计 —— 它描述的是当前上下文占用。
所以攒 usage 时要覆盖而不是累加。

**② `request/context` 事件给窗口总量**

```js
session.append('request/context', {
  provider: 'claude-code', model: '...', contextWindow: 256000,
})
```

**数值从哪来：claude 自己会报。** 每轮 result 帧的 `modelUsage` 里带着：

```json
"modelUsage": {
  "claude-sonnet-4-5": {
    "inputTokens": 24000,
    "contextWindow": 256000,        ← 权威值
    "maxOutputTokens": 32000,
    "canonicalModel": "claude-sonnet-4-5"
  }
}
```

> 起初写死 200k（按 Sonnet/Opus 4.x 猜的），实测这个模型是 **256000**，
> 于是 ctx 条的百分比一直是错的。现在会自动读、并且**从第二轮起**用它
> —— 因为 `request/context` 必须在开跑前发出去，而 result 帧跑完才到。
> 第一轮用配置值兜底（`config.contextWindow`），想第一次就准就把它写成
> 真实值。

另一条路是 `llmRuntime.resolveModelInfo(provider, model)`（`channel/model-actions.js:45`）
—— 那要求 provider 在 DSH 的 llm 运行时注册过。我们现在**注册了**
（见下面「状态栏模型名」），所以那条路也通了，adapter 里的 `contextWindow`
会跟着 claude 的实报值同步。

**③ 进度条是 hover 出来的，不是默认显示**

平时状态栏是 `ctx 9.2% (24k/256k)` 纯文字；**鼠标悬停**才 morph 成
进度条 + 分段明细（`StatusLine.js:145` 的 `hover === 'ctx'` 分支）。
这是设计，不是 bug —— 排查时别以为是条子没渲染出来。

**④ hover 明细里的 `sys` 要靠 `system/message` 事件**

展开后那一行：

```
11.8% · 23.6k/200k · free 176.4k · sys 24k · pr 4 · ast 3 · th 0 · tl 0
```

`sys` 一项**只**由 `system/message` 决定（`projection.js:991`）：

```js
state.contextSegments.system = estimateTokens(textOf(event.data.message.content))
```

不报就是 **0** —— 而系统提示 + 工具定义恰恰是 24k 上下文的大头，
于是明细加起来只剩几个 token，**看着像统计坏了**。

claude 那边的数据来源：

| 要什么 | 从哪拿 |
|---|---|
| 工具清单（N 个） | `system/init` 事件的 `ev.tools` |
| MCP 服务器 | 同上 `ev.mcp_servers` |
| 技能 | 同上 `ev.skills` |
| 系统提示正文长度 | claude 自己的 transcript 里 `attachment.prompt_snapshot.systemPrompt` |

**载荷是长度不是内容** —— `estimateTokens` 就是 `ceil(len/4)`，
所以喂一段等长的填充文本即可（内容不进任何模型请求，纯展示）。

**系数要反推校准**：手上只有工具**名字**没有 schema，所以：

```
usage 总量        U tokens
- 系统提示        S 字符 ≈ S/4 tokens
= 剩给工具等       (U − S/4) tokens
字符/工具 ≈ 252 —— 这是**含名字**的平均值
```

踩过两次：按 380 字符/工具估 → 偏高 2.4 倍；
写成 `name.length + 252` → 名字算两遍，偏高 13%。
**名字长短已经包含在平均值里了，别再加。**

**⑤ 状态栏最左边的模型名 —— 改不了，试过了**

```
deepseek-v4.1-flash · max · 缓存 0.0% · cc-bridge
^^^^^^^^^^^^^^^^^^^
来自 channel.model（TUI 启动时的路由解析结果）
```

看起来能改：`config.model → startupRoute → displayRoute.model →
createChannel({model}) → channel.model`，而 `--patch` 也是 cordis 配置层。

**试了，不行。** 覆盖确实传进去了（诊断日志能打出
`provider=claude-code model=claude-code`），但被路由校验打回：

```js
// modelRoute.js validateModelRoute
models = await llm.listModels(route.provider)   // 'claude-code' 没注册 → 抛
if (!isUnregisteredProvider(error)) return { route }
return { route: fallback, rejected: route }     // ← 整份打回默认路由
```

`isUnregisteredProvider` 的注释说得很明确：

> An unregistered PROVIDER is not uncertainty: no adapter owns the name,
> so the route is proven unusable and falls back exactly like an unknown
> model does.

**所以 `claude-code` 这个 provider 名过不了校验**，除非在 DSH 的 llm 层
真的注册一个。而注册一个假 provider 会影响 `/model` 选择器等地方，
不划算。

**可行的两条路**（都没做）：

1. 改 `~/.dsh/profiles/dsh-tui/cordis.patch.yml` —— **不要**
   那是全局文件，会波及所有 dsh-tui 启动。
2. 在 patch 里注册一个真的 `claude-code` provider —— 要写 provider
   定义（baseURL / models 列表），为了改一格显示不值当。

**顺带**：patch 的 `config` 是**整段替换**不是深合并 ——
我曾经只写 `provider`/`model` 两行，结果把 profile 里原有的
`effort`/`preset`/`whaleGirl`/`fullscreen`/`terminalImages`/
`toolBackground` 全冲掉了（诊断日志一眼看出 `whaleGirl=(无)`）。
真要覆盖某个 config，得把原值原样抄回来。

**能显示的**：claude 实际模型是能拿到的（`system/init` 的 `ev.model`），
日志里会打：

```
[cc-bridge]   claude 实际模型: claude-sonnet-4-5 版本 <claude --version>
```

只是 TUI 那一格被启动配置占死了，没地方放。

### 13. 流式：走 `agent/assistant-stream` 瞬态帧，不是 session 事件

两条路都能让字逐个出现，**用对的那条**：

| 路径 | 状态 |
|---|---|
| `agent/assistant-stream` 瞬态帧 | **0.1.5+ 正式路径** |
| `assistant/chunk` session 事件 | pre-0.1.5 的 legacy（TUI 源码注释明说） |

帧协议：

```js
{ type:'start', attemptId, turn, step, revision }
{ type:'chunk', attemptId, revision, index, time, chunk:{ type:'text-delta', text } }
{ type:'end',   attemptId, revision, outcome:{ kind:'settled'|'abandoned', eventType } }
```

**三个必须遵守的约束：**

① `revision` **全局单调递增**，不是按 attempt 分组 ——
   TUI 只看 `frame.revision <= lastStreamRevision` 就丢弃。

② 一个 step 只能有一个 attempt：`start` 会**丢掉**上一个未结束的。

③ **增量拼的只是临时内容**。durable 的 `assistant/message` 一到，
   TUI 用它的文本**替换**临时行。所以绝不能把完整文本当增量再发一遍，
   否则界面上字会翻倍。

**收尾顺序**：先把 attempt `end` 掉，再 append `assistant/message`。
反过来的话，settle 之后还有 delta 往新行里塞，也是重复文字。

claude 侧要加 `--include-partial-messages`，事件形状：

```
{ type:'stream_event', event:{ type:'content_block_delta', index:0,
    delta:{ type:'text_delta', text:'hi' } } }
```

> **注意**：本地代理（`claude-*`）一次只发**一个** `text_delta`，
> 所以界面上还是一整段出现。管道是通的，接真实 Anthropic 端点就会逐字。
> 日志里 `chunks=3` 就是证据（start + 1 delta + end）。

### 14. 块转换是异步的 → 必须保序

`toDshBlocks` 要调 `attachments.saveImages()` 落图片，是 **async**。
而 stdout 的 `data` 回调不是 —— 直接在里面 `await` 会让同一批数据里
后面的行**抢先执行**。

而 DSH 的 session 是**顺序敏感**的（step / tool 边界都靠事件顺序）。
所以用一条 promise 链串起来：

```js
let chain = Promise.resolve()
// ...
chain = chain.then(async () => { /* 转换 + append */ })
```

**而且 `close` 事件里要先 `await chain`** —— 否则最后一批块还在落盘，
上层的 turn 收尾就跑在前面了，表现为"回复出现在 turn/end 之后"。

### 15. 图片要换成 attachment 引用，不能塞 base64

claude 给的是**内联 base64**：

```js
{ type:'image', file:{ base64:'...', type:'image/png', originalSize: N } }
```

DSH 要的是**内容寻址的引用**：

```js
{ type:'image', attachment: ImageAttachmentRef }
```

得先落盘：`await attachments.saveImages([{ data, mediaType }])`。

`attachments` 是 cordis 服务，**要写进 `inject`**（patch 里那份也要，
原因见第 1 条）。拿不到就降级成占位文字 —— DSH 自己的 migrate 适配器
也是这么做的（`IMAGE_PLACEHOLDER`）。

顺带：Mermaid 和 LaTeX **不需要任何额外支持** —— 它们只是
`assistant/message` 里的 Markdown 文本，dsh-TUI 自己会渲染
（```mermaid 画成字符图、`$...$` 画成公式）。

### 16. `registerAbort` 两边都写成 setter → cancel 空转

中断怎么调都不生效，日志里有 `cancel() cause={"kind":"user"}`，
却永远等不到 `cancel() → 中止 claude`。

原因：`runClaude` 里 hook 定义在 spawn 之后（要闭包 `child.pid`），
但 `registerAbort` 在函数顶部就调用了 —— 于是**两边都被迫写成 setter**：

```js
// runClaude 里
registerAbort?.((fn) => { abortHook = fn })
// followup 里
registerAbort: (fn) => { abortActive = fn }
```

结果 `abortActive` 存的是「把 hook 存进闭包」这个**动作**本身，
`cancel()` 调它等于空转。

**修法**：把 `registerAbort(abortHook)` 挪到 hook 定义之后，
直接交 hook **本身**。

**另一个坑**：Windows 上 claude 是 `.exe`，下面还挂着工具子进程，
`child.kill()` 只杀父进程，孙进程变孤儿继续跑。用
**`taskkill /PID <pid> /T /F`** 收整棵树。

### 17. 中断后悬空的工具卡片要补结果

按 esc 之后 spinner 停了、turn 也 aborted 了，但工具卡片还挂着
**"运行中… (24s)"** 一直走秒 —— 因为那个 `tool/call` 永远等不到配对的
`tool/result`。

收尾时用 `callSeqs` 减去已收到结果的 id 找出悬空的，补一条
`isError: true` 的 result：

```js
for (const [callId, seq] of callSeqs) {
  if (resolvedCalls.has(callId)) continue
  session.append('tool/result', { ... isError: true },
    { surfaceOp: 'append', sourceEventSeqs: [seq] })
}
```

补完之后卡片变成 `✗ ... · 14s` + `已中断：工具调用未返回结果`，计时停住。

**dsh 0.2.0 起这段手写逻辑换成了官方的 `ToolCallRecovery`**（见第 18 条）——
手写版保留为兜底，官方版不可用时才走。

### 18. 跟到 dsh 0.2.0 / dsh-tui 0.12.0 时要改的东西

版本跳了（0.1.x → 0.2.0-rc.2）就值得系统对一遍契约。这次改了四处：

**① end 帧的 `outcome.kind` 是 `'committed'` 不是 `'settled'`**

```js
// 0.1.x 我按 TUI 的读取代码反推的（那时类型没导出）：
{ type:'end', attemptId, outcome:{ kind:'settled', eventType:'assistant/message' } }

// 0.2.0 官方类型（dsh-agent runtime-types.d.ts 的 AssistantStreamFrame）：
{ type:'end', attemptId, index, outcome:{ kind:'committed', eventType, seq } }
```

TUI 只判 `kind === 'abandoned' || eventType === 'assistant/attempt'`，
所以旧写法**碰巧能跑**（`assistant/message` 不触发 discard）——
但契约是错的，换个实现就露馅。

**顺序也跟着变了**：`seq` 的语义是「**已提交**的 settlement 序号」，
所以必须**先写 durable 消息、拿到 seq，再发 end 帧**。
0.1.x 时代我先 end 再写消息（那时 outcome 只要一个字符串，无所谓）。

**② StreamChunk 的 delta 必填 `index`**

```js
{ type:'text-delta'; index:number; text:string }        // ← index 是必填
```

它标出这个 delta 属于消息里第几个块，用来关联交错的文本/推理/工具参数流。
claude 的 `content_block_delta` 本来就带 `index`，直接透传即可。

我早先只给了 `{type, text}` —— TUI 只读 `.text` 所以能跑，
但类型不完整。

**③ 用官方的 `ToolCallRecovery` 替掉手写回收**

dsh 0.2.0 新增 `dsh-session` 的 `ToolCallRecovery`
（commit `6a6f350b94` "settle pending tool results before failed steps close"），
正好是我手写那套 `callSeqs`/`resolvedCalls` 想做的事，而且更严谨：

```js
const recovery = new ToolCallRecovery()
// 订阅并喂事件
ctx.on('session/event', (subject, event) => {
  if (subject === session) recovery.observe(event)
})
// 收尾时拿该补的结果
for (const ev of recovery.results()) {
  const appended = session.append('tool/result', ev.data, { surfaceOp:'append', ... })
  recovery.observe(session.eventAt(appended.seq))   // ← 契约要求：提交后再 observe
}
```

**它比我手写的强在哪**：跟踪 step/turn 边界（关闭的 step 自动丢弃 pending）、
按 assistant 顺序产出、复用事件时间戳。

**而且给的错误文案更负责任**。对比：

```
我手写的： 已中断：工具调用未返回结果
官方的：   ToolOutcomeUnknownError: TOOL_OUTCOME_UNKNOWN —
          The tool call was interrupted after it was recorded, but no result
          was durably recorded. Its outcome is unknown. Decide whether to retry
          from the tool semantics; retry only if the operation is read-only or
          idempotent; if it may have side effects, first verify external state
          or ask the user. Do not retry blindly.
```

关键差别是**「结果未知」这个语义**：我那句读起来像「没执行」，
模型可能直接重试一个**已经产生了副作用**的操作。官方文案明确警告
「别盲目重试」。

**④ `runMaintenance` 的契约是「同步抛」**

```ts
runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
```

契约说：已有回合或另一个维护任务在跑时**同步抛**（表示占用冲突）。
我原先写成 `() => Promise.reject(new Error('not supported'))` ——
签名勉强对得上（都返回 rejected promise），但语义错了。
TUI 目前不调它所以没暴露，但别人一用就是坑。现在给了正经实现
（用 `busy` 做占用判定 + 可被 cancel 中止的 signal）。

**没变的**（核对过，不用动）：

- `AgentFactory` / `setFactory` 契约
- `Agent` 接口（连 `readonly id` 都还在）
- 注入管道的协议（`prompt.append` / `command.execute`）
- `system/message` → `contextSegments.system` 的算法
- ctx bar 的 hover 判据
- session 事件词汇（我发的类型全在 `KNOWN_SESSION_EVENT_TYPES` 里）

## 自定义标题立绘

配一行 `maidArt` 就能把 dsh-TUI 开屏那个女仆娘换成自己的图 ——
**只影响带本 patch 的这次启动，不碰 dsh-TUI 的包文件**。

```yaml
# cordis.patch.yml → cc-bridge 的 config 下
maidArt: 'F:\path\to\your-art.png'
# 可选：点击时切换的「开心」版
maidArtHappy: 'F:\path\to\your-art-happy.png'
```

### 「点击变表情」的触发条件

配了 `maidArtHappy` 之后，点立绘会换成第二张、**3 秒后自动回落**
（`MAID_HAPPY_MS = 3000`）。

但有个前提 —— `LogoV2.js` 里点击处理的第一句是：

```js
onClick: () => {
  if (whaleFrozen) return;        // ← 这里
  if (maidImageActive) { reactMaid(); return; }
  ...
}
```

而 `whaleFrozen` 在**第一个任务开始时就锁死**：

```js
React.useEffect(() => { if (working) setWhaleFrozen(true) }, [working])
```

所以**开屏那几秒才有反应** —— 一旦发过任何消息（哪怕是 `hi`），
立绘就变成纯静态 logo，点击不再有任何效果。这是 dsh-TUI 的原始设计
（欢迎阶段特性），不是 cc-bridge 的 bug。

> 验证时注意：**必须用没发过消息的新窗口**。发过消息的窗口点了没反应是正常的。
>
> 另外截图要快 —— 表情只保持 3 秒。踩过：第一次在点击后 1.5s 才截第一帧，
> 结果正好错过窗口期，误判成「切换没生效」。正确的做法是点完立刻连拍
> （`../cc-tui/verify-click.py` 就是干这个的，它按立绘区**像素哈希**判定，
> 不靠肉眼）：

```
点前          立绘区 md5 = aaaaaaaaaaaa
点击后  0.6s  立绘区 md5 = bbbbbbbbbbbb  ★ 与点前不同
点击后  1.2s  立绘区 md5 = bbbbbbbbbbbb  ★
点击后  2.0s  立绘区 md5 = bbbbbbbbbbbb  ★
点击后  3.0s  立绘区 md5 = aaaaaaaaaaaa  ← 自动回落（正好 3 秒）
```

### 两条渲染路径都要换

dsh-TUI 的标题立绘**按终端能力二选一**（`LogoV2.js`）：

```js
whaleGirl ? (maidImageActive ? <MaidPortrait/> : <WhaleGirlArt/>) : <WhaleArt/>
```

| 路径 | 组件 | 条件 | 怎么换 |
|---|---|---|---|
| **真图** | `MaidPortrait` | sharp 可用 + 终端支持 Kitty/Sixel | 覆写缓存的像素缓冲 |
| **字符画** | `WhaleGirlArt` | 上面不满足时的兜底 | 覆写预渲染的 ANSI 行 |

这台机器**两条会走哪条取决于终端** —— 实测 Windows Terminal 认 Sixel、
sharp 也装得上，所以走的是**真图**。不两套都换就会漏。

### 真图路径：覆写缓存缓冲

`maidPortrait.js` 的 `loadMaidPortraits()` 是**模块级缓存**：

```js
let loadOnce
export function loadMaidPortraits() {
  loadOnce ??= (async () => { ...; return { normal: {data,width,height}, happy: {...} } })()
  return loadOnce     // 每次都返回同一个对象
}
```

`Image.js` 把这个对象当**引用**传给 ink host（`imageData: image?.data`），
而 `isTerminalImageSource` 只校验：

```js
data instanceof Uint8Array && data.byteLength === width * height * 4
```

所以**原地 `data.set(新图)`、尺寸不变**就行。⚠️ 不能改 `width/height` ——
改了 `byteLength` 就对不上，会被判为非法源、**静默退回 alt 文本**
（什么图都不显示，也不报错）。

### 字符画路径：覆写 ANSI 行

```js
export const WHALE_GIRL_ROWS = [...]   // 15 行，每行是渲染好的 ANSI 字符串
```

`export const` 只约束**绑定**不可重赋值，**不约束数组内容** ——
原地改 `rows[i]` 即可（`WhaleGirlArt` 每次渲染都读这个数组，
但闭包捕获的是**绑定**，所以重新赋值整个数组是无效的）。

### 坑：系统里有三份 dsh-tui

```
%APPDATA%\npm\node_modules\@deepseek-harness-tui\dsh-tui        ← npm 全局
~\.dsh\profiles\dsh-tui\node_modules\...\dsh-tui                ← profile
~\.dsh\profiles\dsh-tui-safe\node_modules\...\dsh-tui           ← profile-safe
```

**三份是不同的模块实例**，改 A 不影响 B —— 和 README 第 2 条
「dsh-scope 两份实例」是同一类问题。

第一版只改了 profile 那份 → 日志说「装载成功」但界面纹丝不动。
**定位手段**：把 `WHALE_GIRL_ROWS` 全填成红色块启动，
截图上**红色像素数 = 0** → 证明那个数组压根没被渲染，
于是才发现走的是真图路径。

对策很朴素：**每份都打一遍补丁**，TUI 用哪份都能中。

### 图片要求

- **PNG**（自己解，不依赖 sharp/PIL —— cc-bridge 跑在 dsh 进程里，
  多一个原生依赖就多一份装不上的风险）
- 正方形最好；非正方形会**补透明边**适配，**不裁切**（不丢内容、不变形）
- 透明底最佳。不透明底的图会自动把左上角颜色当背景键控掉 ——
  否则"处处不透明"，裁不出轮廓，人物会被背景挤扁
- 源图尺寸随意，会重采样到目标槽位（alpha 预乘，边缘不发灰）

### 源图**已经是像素画**时：走无损直通

上面那套「重采样 → 像素化 → 量化」是给**抗锯齿插画**准备的补偿手段 ——
把照片感的连续渐变压成平坦色。但如果源图**本来就是手绘像素画**，
再走一遍就是**二次破坏**：

| 步骤 | 对像素画做了什么坏事 |
|---|---|
| 面积平均重采样 | 把硬边糊成过渡色 |
| `pixelate(5)` | 等于二次像素化，方块错位 |
| `quantize(24)` | 把作者精心选的 10 色改掉 |

所以 `fitToSlot` 会**先探测**，命中就走另一条路。

#### 探测：`detectPixelBlock()`

两级判据，从宽到严试 `n ∈ {16,12,10,8,6,5,4,3,2}`：

1. **严格**：`n×n` 块内**每像素完全相同**（容差 0）—— 手绘像素画导出后就是这样
2. **宽松**：块内极差 ≤ 6 **且**调色板 ≤ 32 色

第 2 条的「且」不能省：光看块内极差不够 —— 平滑渐变的插画在 8×8
小窗口里极差也很小，必须再加「颜色少」才能区分开。

实测这组素材：#6 立绘 **12768 块全部极差为 0**，10 色 —— 严格判据即命中。

#### 处理：抽逻辑网格 → 最近邻放大

```
裁切 ──▶ 抽 8×8 网格里每块的代表像素 ──▶ 补宽高比 ──▶ 最近邻放大
        （112×114 逻辑像素）                          （412×411）
```

**块内既然均匀，取一个就是全部** —— 不用求平均，颜色是原样搬过去的，
作者选的色一个不改。放大用最近邻，不插值。

日志会明确报走的是哪条：

```
[cc-bridge]   · 源图类型：像素画 8×8 无损直通
```

#### ⚠️ 探测必须在补宽高比**之前**

踩过：先 `padToRatio` 再 `detectPixelBlock`，`896×952` 被补成 `896×955`，
而 `955 % 8 = 3` —— **所有候选块边长都不整除**，探测直接落空，
像素画被当成插画走了一遍「像素化+量化」，10 色被改掉。

原因：`padToRatio` 按目标宽高比算出来的尺寸是**任意值**，不保证还是块边长的
整数倍。所以先把源图的网格关系确认下来，再谈补边。日志里那句
`源图类型：插画 像素化5+量化24` 就是当时的表现。

#### ⚠️ 两张图必须**共用裁切框**

`MaidPortrait` 点击时在 `normal` / `happy` 两个缓冲间切换，两者**同画布**。
如果各自按自己的内容裁边，两张图的宽高比就不同 → 缩放比例不同 →
同一张脸在两帧里位置不一样，**点一下人就跳**。

实测这组正好踩中：身体部分逐像素一致（x 都是 `88..983`），
但「开心」版多了右上角一滴汗，外接框顶部从 `y=112` 抬到 `y=72`：

| | 内容框 | 独立裁切后高度 | 差异 |
|---|---|---|---|
| 立绘 | 896×912 @ y=112 | 912 | |
| 开心 | 896×952 @ y=72 | 952 | **40px** |

40px ≈ 画布高度的 4%，是**肉眼可见的位移**。

`sharedCropFor()` 取两者外接框的**并集**，两图裁成同一块 → 同比例缩放 →
几何严格对齐。日志：

```
[cc-bridge]   · 共用裁切框 896x952 @ (88,72) — 两图几何对齐
```

#### 源图准备（`../cc-tui/tools/prep-maid-art.py`）

素材本身可能格式不齐，跑一遍这个脚本再交给 cc-bridge：

| 素材 | 原始状态 | 问题 |
|---|---|---|
| #6 立绘 | PNG/RGBA | 干净的 8×8 网格、10 色 —— **可直接用** |
| #7 开心 | **WEBP/RGB（无 alpha）** | 白底 + 有损压缩痕迹（块内极差最大 **102**、全图 **6046** 色） |

脚本做三件事：

1. **补 alpha** —— 不能简单用「非白 = 不透明」：人物的白裙、白围裙也是纯白
   （mask 内 12.5% 是纯白），那样会在裙子上打出洞。两图同源且身体逐像素对齐，
   所以**身体借 #6 的 alpha**，再补上「#6 mask 之外的非白内容」——
   实测正好是那滴汗（70 块，`y:9..21 x:101..108`），用连通域过滤掉零星噪点。
2. **块内取均值**抵消有损噪声，再**吸附到 #6 的调色板** —— 实测 10030/10030
   块全部吸附成功，说明两张图本来就是同一套色。
3. 写回实心块 PNG。

验收：两图前景色数**都是 10，交集 10**。

### 重采样：按缩放方向选滤波器

这不是讲究，是**会看出差别**的：

| 方向 | 滤波器 | 为什么 |
|---|---|---|
| **缩小** | 面积平均（box） | 双线性只采 2×2 邻域，比例一大就**漏掉大量源像素**，高频细节折叠成摩尔纹 |
| **放大** | 双线性 | 面积平均在放大时退化成最近邻，有块状感 |

实测：1254 → 412（缩 3 倍）时双线性让蕾丝边和书本纹理出现明显噪点，
换成面积平均后干净了。

### 像素化 + 色阶量化

立绘会做一层像素化，**再叠一层色阶量化** —— 两步都必要，缺一个就露馅。

#### 第一步：像素化

`src/maid-art.mjs` 的 `PIXELATE`（当前 **5**）。标准的**降采样再最近邻放大**：

```
目标尺寸 ──面积平均──▶ 1/5 尺寸 ──最近邻──▶ 目标尺寸
                      103×103              412×411
```

每个 5×5 方块取同一个颜色，就形成像素块。

**两步的滤波器必须不同**：

| 步骤 | 滤波器 | 为什么不能换 |
|---|---|---|
| 降采样 | 面积平均 | 用最近邻会丢像素、出摩尔纹 |
| 放大 | **最近邻** | 用双线性会把方块边缘抹平，像素感就没了 |

顺序也有讲究：**先平滑缩到目标尺寸、再打方块**。反过来方块会被缩放糊掉。

alpha 按预乘处理 —— 否则透明区的黑色会把边缘块拉暗、出现脏边。

#### 第二步：色阶量化（关键）

**光做像素化不够。** 和 dsh-TUI 原版立绘并排看，风格明显不是一个体系：

| | 原版 | 只做像素化 |
|---|---|---|
| 色块内部 | 大片**平坦同色** | 相邻块颜色**各不相同** |
| 边缘 | 1 像素级**硬边** | 有色阶过渡，发虚 |
| 观感 | 手绘像素画 | **照片打码** |

根因在**源图的出身**：原版是作者按像素画的 464×464 素材，而我们这张是
**抗锯齿插画**（1254×1254）—— 缩下来每个方块的平均色都略有差别，
实测 **3094 种不透明色**，于是读起来像马赛克滤镜而不是像素画。

`QUANTIZE_STEP`（当前 **24**）把每通道按步长取整，连续渐变塌成有限色带，
邻近方块因此合并成同一片平坦色。实测 **3094 色 → 102 色**。

同时 `ALPHA_CUTOFF`（128）做 **alpha 硬化**：缩放留下的半透明毛边收成
「实心 / 透明」两态，轮廓才利落。

#### 档位怎么定的

都叠在 `PIXELATE=5` 上，按**屏幕真实尺度**并排比过：

| 步长 | 色数 | 观感 |
|---|---|---|
| 关 | 3094 | 照片渐变，不像像素画 |
| 16 | 198 | 开始有平坦色，仍偏细腻 |
| **24** | **106** | **平坦色 + 硬边，最接近原版** |
| 32 | 65 | 更扁平，蕾丝开始简化 |
| 40 | 38 | 细节丢失（蕾丝糊了） |

像素化档位：N=2 太弱、N=3 偏保守、**N=5 方块明显但不丢细节**、N=6 起开始糊。

> **顺序固定**：补宽高比 → 面积平均缩到目标 → 像素化 → 量化。
> 量化必须最后 —— 像素化用的是面积平均，先量化会让平均失真。

> 顺带一提：字符画那条路径（`sprite-tools.mjs` 的众数降采样）本来就
> 是像素风的，不需要这两层处理。

#### 调参工具

```powershell
# 试任意组合，输出成 PNG 对比
node ../cc-tui/tools/render-maid-variant.mjs --pixelate 5 --step 24 --out v.png

# 和原版并排（按屏幕真实尺度）
python ../cc-tui/tools/true-scale.py "变体=v.png"
```

### 「高兴」版（点击切换）

配 `maidArtHappy` 就能还原 dsh-tui 原版那种「点她一下变表情」：

```yaml
maidArt:      '...\maid.png'
maidArtHappy: '...\maid-happy.png'   # 可选
```

不配的话两张缓冲填同一张图 —— 点击**照样触发**切换（TUI 那边逻辑正常），
但两张内容一样，**肉眼看不出变化**。日志会提示：

```
自定义立绘已装载：3 份 dsh-tui 实例（单图 → 点击无表情变化）
```

**字符画路径不受这个参数影响** —— 它本来就是静态的
（dsh-TUI 原版的字符画女仆也不响应点击，只有真图版会变）。

### 性能

装载约 **1.3 秒**，但它是 **`apply()` 里的 fire-and-forget**，
**不阻塞启动** —— TUI 照常立刻渲染。

时间花在哪（实测）：

| 步骤 | 耗时 |
|---|---|
| 三份 dsh-tui 的模块 import | ~610ms（占大头） |
| `loadMaidPortraits()`（sharp 解码 × 3） | ~130ms |
| PNG 解码 + 裁边 + 重采样 | ~110ms |

模块 import 那 610ms **省不掉** —— 不知道哪份会被用，只能都导入。
重采样那部分加了缓存（`源图路径|目标尺寸` → 结果），
把「3 份 × 2 张图 = 6 次」压到 2 次，省了约 440ms。

### 相关工具

`../cc-tui/tools/make-maid-sprite.mjs` —— 命令行版，用于**离线**生成
精灵表（写文件、可调 `--method` / `--bg` / `--threshold`）。
`src/sprite-tools.mjs` 是它和 `src/maid-art.mjs` 共用的纯函数集合。

## 队友（子代理）面板

claude 用 `Agent` 工具起的「队友」，现在能完整显示在 dsh-TUI 的队友 UI 里。
按 **`Ctrl+A`** 打开面板，`Enter` 进详情，详情有三页：`摘要` / `输出` / `工具`。

```
 子代理面板
1 运行中   0 已完成
🟡 子代理：Search example topic · claude-code · 1m35s · 15k tok · 4 tools
↑/↓ 选择 · Enter 查看详情 · Esc 关闭
```

详情页「输出」是队友的**完整对话记录**（markdown 渲染 + `── 结论 ──` 分隔），
「工具」页是**真实工具名 + 参数 + JSON 语法高亮**。

### 怎么打开的：靠 claude 的一个开关

队友原本是 claude **进程内部**的东西，一个字节都不出现在 stdout 事件流里。
`--forward-subagent-text` 是官方给的出口（`runClaude` 里加上了它）：

> Forward subagent text and thinking blocks as assistant/user messages with
> `parent_tool_use_id` set (only works with `--print` and `--output-format=stream-json`)

于是多出这些事件：

| 事件 | 内容 |
|---|---|
| `system/task_started` | `task_id`、`description`、`prompt`、`subagent_type` |
| `system/task_progress` | `usage.{total_tokens, tool_uses, duration_ms}`、`last_tool_name` |
| `system/task_updated` | 终态 `status`、`end_time`（**不含** summary） |
| `system/task_notification` | 终态 + `summary` + `usage`（**信息完整**） |
| 带 `parent_tool_use_id` 的 assistant/user 消息 | 队友自己的对话与工具调用 |

`task_id` 就是队友 id —— 它同时是磁盘上
`<session>/subagents/agent-<task_id>.jsonl` 的文件名，也和 `Agent` 工具
返回值里的 `agentId` 一致。

分流靠 `parent_tool_use_id`：实测它和 `task_started` 的 `tool_use_id`
**逐字符相同**（包括那串复合后缀），所以映射可靠。

### 工具名要改一下

dsh-TUI 靠**工具名**判断这是不是"起了个队友"：

```js
const SUBAGENT_TOOL_NAMES = new Set([
  'task', 'subagent', 'subagent_fork',
  'subagent_claude_code', 'subagent_codex', 'spawn_task',
])
```

而 claude 实际发的名字是 **`Agent`** —— 不在名单里，于是被渲染成一张普通
工具卡。有意思的是 claude 的 `system/init` 里注册的名字**恰恰是 `Task`**，
只有实际调用事件用了 `Agent`：

```
init 工具表:  ['Task', 'ListAgents', 'TaskStop', ...]   ← Task
实际调用:     {'Agent': 1}                              ← Agent
```

所以上报时映射回 `Task`，既让 dsh-TUI 认出，也和 claude 自己的工具表一致。

### 数据流的真相：单向快照，不是响应式

这是**卡最久**的一环，值得单独记。

tokens / 工具数 / 逐条输出都住在 `SubagentActivityStore` 里，而那个实例
**没有暴露在 ctx 上** —— 它是 `createSubagentProjection` 的闭包局部变量。

好消息是 `states` / `sessionToAgent` 是**实例字段**，而方法在 **prototype**
上，所以用本项目一贯的「原地改上游对象」就能拿到实例：

```js
const orig = Cls.prototype.onSpawned      // 每个 store 建队友行时必调
Cls.prototype.onSpawned = function (...args) {
  capturedStores.push(this)               // ← this 就是 store 实例
  return orig.apply(this, args)
}
```

> ⚠️ 必须存**数组**。系统里有**三份** dsh-tui 实例（npm 全局 / profile /
> profile-safe），各有自己的 store，而面板渲染用的是**其中特定一份**。
> 只留最后一个的话，补丁很可能打在另一份上，界面纹丝不动。
> 所以按 id 找：`st.states.has(taskId)`。

拿到实例之后，**真正的坑**来了 —— 往里写数据，界面**完全不动**：

```js
// subagent-projection.js
const syncNow = () => {
  state.subagents = store.snapshot()   // ← UI 读的是 state，不是 store
  ...
}
```

`syncNow()` **只在 dsh-TUI 自己的事件处理器里被调用**。全库搜下来，
没有任何地方 `store.subscribe(...)` —— `store.notify()` 的监听者列表
**始终是空的**。所以直接改 store 等于写进一个 UI 看不见的抽屉。

> 这个设计本身没错：dsh-TUI 里 store 的唯一写入者是 `session/event`，
> 而那条路已经顺带调了 `syncNow()`。只是我们从侧面写，就得自己补这一步。

解法是借它自己的通道：补完数据后发一个**无害的** `request/context`
（幂等的状态设置，重发无副作用），它会走到 `onSessionEvent` → `syncNow()`，
顺手把快照刷进 `state.subagents`。

### 四个踩过的坑

**① `subagent/start` 必须排在 `tool/call` 之后发**

dsh-TUI 的 `onStart` 里描述是这么取的：

```js
description: pendingTaskDescriptions.shift()
```

而这个队列**只从 `tool/call` 的 arguments 里抽**，不读 payload 里的
description。可事件到达顺序是反的 —— `task_started` 同步处理，而带
`Agent` 工具调用的 assistant 消息走异步保序链（`toDshBlocks` 里有 await）。
直接发的话队列还空着，`shift()` 得到 `undefined`，界面显示成占位值
`claude-code task`。

→ 解法：把 `onSubagent` 的 start 回调排进 `runClaude` 的保序链。

**② 终态会连着来两条，别让先到的赢**

```
task_updated       { status:'completed', end_time }    ← 只有状态
task_notification  { status, summary, usage }          ← 有产出和用量
```

而 dsh-TUI 的落定是**幂等**的（`store.finish` 见到已落定就直接 return），
谁先到谁说了算。先发 `task_updated` 的话，「摘要」页永远是「暂无摘要」。

→ 解法：`task_updated` 只登记，等 notification 来了一起发；配个 800ms
兜底定时器防 notification 不来。

**③ 队友的所有回调都得排在同一条保序链上**

隐蔽的竞态：start 回调排在链上，而转发来的队友消息如果同步处理，就会
**抢在队友行建立之前**到达 —— 那时 `byToolUse` 里还没有映射，队友说的
话**直接被丢掉**，「输出」页一片空白。

→ 解法：`message` / `chunk` / `toolResult` / `progress` 全部排队。

**④ 工具数不能按计数补**

`task_progress` 只给 `tool_uses` **计数**，而 store 存的是**逐条记录**。
一开始按差额补占位条目（name 用 `last_tool_name`），结果是假名字和真名字
混在一起重复计数。

→ 解法：工具**只从转发消息里逐条记**（那里有真实 `tool_use` 块），
`progress` 只负责补 tokens。

### 为什么不用「影子会话」这个正道解法

理论上更干净：给每个队友造一个**影子 DSH 会话**
（`sessions.create(taskId)` → 造个轻量 Agent → `agents.register()`），
这样 dsh-TUI 的 `lookupChild` 能查到、`linkSession` 能接上，
**全套机制自动生效**，一行 hack 都不需要。

**但代价是 `ctx.agents` 里多出一批非真实 Agent** —— 它们不是真能跑回合的
agent，却会出现在 `/agents`、可能参与路由与会话切换的判定。
为几个展示字段去污染核心注册表，风险收益不成比例，所以没走。

现在的做法是**只在展示层补数据**，注册表保持干净。

### 这些非官方路径的脆弱点

下面每一条都是 dsh-TUI 的内部实现细节，**升级时必须重验**：

| 依赖 | 用途 |
|---|---|
| `SubagentActivityStore` 的类名与模块路径 | prototype 钩子的落点 |
| `onSpawned` 是 prototype 方法（不是实例字段） | 拿实例的唯一入口 |
| `states` 是 `Map`，键是队友 id | 按 id 定位持有行的那份 store |
| `appendOutput` / `recordTool` / `setTokens` 的签名 | 写数据的三个入口 |
| `syncNow` 会被 `session/event` 触发 | 让界面刷新 |
| `subagent/start` 的 description 取自 `tool/call` 队列 | 描述能否正确显示 |
| `SUBAGENT_TOOL_NAMES` 含 `task` | 是否被认作队友 |

好在**失败是静默降级**的：钩子装不上、方法名变了，都只是面板少几个字段，
不影响主对话。`check-upgrade.ps1` 的契约测试就是防这个。

## 斜杠命令全部透传给 claude

**dsh-TUI 自己的 57 条 `/` 命令被摘掉了** —— 现在 `/` 开头的输入一律
送给 claude。

### 为什么原来不行

dsh-TUI 的命令表**优先于模型**。`PromptInput.tryRunCommand()`：

```js
const command = channel.commandList.find(e => e.name === parsed.name)
const known = command !== undefined || isHiddenCommandName(parsed.name)
if (!known) return false        // ← 只有这一步才轮到模型
```

而 `Chat.js` 的 `default` 分支注释写得很直白：

> *Unknown names fall through to the model.*

所以原来是**表外的才透传**：

| 输入 | 改造前 | 改造后 |
|---|---|---|
| `/theme`、`/model`、`/cost`、`/compact`… | dsh-TUI 处理，**到不了 claude** | 透传 ✓ |
| `/code-review`、`/simplify`… | 透传（表里没有） | 透传 ✓ |
| `/zzz-nope` | 透传，claude 回"没这条命令" | 透传 ✓ |

### 怎么摘的：清空**内容**，不是替换数组

关键是**引用关系**：

```js
channel.js:426         commandList: LOCAL_COMMANDS          // ← 存引用
skill-catalog.js:32    const merged = [...LOCAL_COMMANDS]   // ← 用的时候复制
skill-catalog.js:48    deps.setCommands(merged)
channel.js:541         setCommands(c) { state.commandList = c }
```

两处都只在**用的时候**读内容，所以 `LOCAL_COMMANDS.splice(...)` 清空
对它们都生效 —— 而且**与时机无关**：不管 channel 在我们之前还是之后
创建，`state.commandList` 指向的都是同一个数组对象。

这就是为什么用 `splice` 而不是 `state.commandList = []`：后者只影响那一刻
的引用，下一次 `refreshCommands()` 又会 `[...LOCAL_COMMANDS]` 把命令全捞回来。

> `export const LOCAL_COMMANDS` 的绑定不可重赋值，但**数组内容可以改** ——
> 和本项目改主题/立绘/大字是同一套办法。

### 还有一张表也要清

`isHiddenCommandName()` 查的是另一个表（`HIDDEN_COMMANDS` / 配套的
`HIDDEN_COMMAND_NAMES` Set，里面是 `/deepseek` 那个彩蛋）。它在
`tryRunCommand` 里和 commandList 是**或**的关系：

```js
const known = command !== undefined || isHiddenCommandName(parsed.name)
```

所以两张表 + 那个 Set 都清。

### 外部命令**不动**

`refreshCommands()` 合成的列表里除了本地命令，还有 `commandService.list()`
注册的**外部命令** —— 插件与 skill（`/plan`、`/goal` 等）。那些走另一条路
（`external: true`），**不经过 `LOCAL_COMMANDS`**，所以不受影响。

这是对的：`/plan`、`/goal` 这类是 DSH 侧的能力，claude 那边没有对应物，
留着才有用。

### 摘掉之后还能退出吗

**能。** 退出/中断走的是**硬编码快捷键**，不经过命令表
（`keymap.js:280` 的 NON_REMAPPABLE）：

```
Ctrl+D   空输入时退出
Ctrl+C   中断 / 清空
Esc      选择器 / 中断 / 双击 rewind
```

所以 `/exit`、`/quit`、`/q` 没了不影响关窗口。

### 代价（有意的）

`/new`、`/resume`、`/theme`、`/model`、`/cost`、`/status`、`/compact`…
这些 dsh-TUI 功能**用不了了**，因为同名输入会发给 claude。

想找回来两条路：

```yaml
# 1. 整个关掉
slashPassthrough: false
```

```js
// 2. 或者放回几条（src/slash-passthrough.mjs 的 KEEP）
const KEEP = new Set(['theme', 'lang', 'exit'])
```

### 顺带一个好用的事实

claude 在无头模式下遇到不认识的命令会**列出有哪些可用命令**：

```
> /zzz-nope
`/zzz-nope` is not installed in this session, so it did not run.

Available slash commands here include `/reverse-engineering`, `/dataviz`,
`/update-config`, `/code-review`, `/simplify`, `/loop`, `/claude-api`,
`/workflow-authoring`, `/run`, `/init`, `/security-review`, and others…
```

所以**随便打一个不存在的斜杠命令**，就能看到当前会话有哪些可用。

### ⚠️ 有些命令在无头模式下本来就不工作

claude 的 `--print` 是**非交互**模式，纯 REPL 的命令会回
*"isn't available in this environment"*（实测 `/help`、`/theme` 就是）。
这不是 cc-bridge 的问题，是 claude 的设计 —— 传到了，但它不执行。

而**功能型**命令是执行的，比如 `/compact` 实测返回
*"Error: No messages to compact"*（真的去压缩了，只是没内容可压）。

## `/clear`：真正重开会话

`/clear` 在 claude 的无头模式下**清不掉上下文**，所以自己实现了。

按 `/clear` 会做三件事：

1. **丢弃 claude 会话映射** —— 下一个问题不带 `--resume`，claude 开全新会话
2. **归零 ctx 条** —— `24k/256k 9.2%` → `0/256k 0.0%`
3. **清空对话区** —— 回到开屏画面

（顺带：输入 `/` 也不再弹补全菜单了，见下一节。）

### 为什么 claude 自己清不掉

实测证据：

```
followup: /clear
usage: {"inputTokens":23697, ...}     ← 上下文一点没降
```

而 claude 的 transcript 里明确有：

```xml
<command-name>/clear</command-name>
<local-command-caveat>...</local-command-caveat>
```

说明它**认出了**这是命令，但在 `--print` 模式下只是把它记成一条本地命令 ——
真正的「当前会话」由**我们**持有（`claude --resume <uuid>`），claude 那边清不掉，
下次 `--resume` 还是把全部历史带回来。

### 拿到了 Channel

要归零 ctx 条、清屏，就得够到 dsh-tui 的 `Channel` 对象（它就是
`channel.js` 里 `createChannel()` 返回的那个 `state`）。它是**闭包私有**的，
不注册到 ctx。

官方接缝是 `adapter/channel/host-registry.js`：

```js
registerTuiChannel(ctx, rawChannel)          // dsh-tui 写入
getRegisteredTuiChannel(ctx) → rawChannel    // 按 composition root 查
```

**但这条路走不通**：键是 `compositionRoot(ctx)`，三种键都试过（`ctx.root` /
`compositionRoot(ctx)` / `ctx`），查不到；订阅 `onTuiChannelRegistered`
也从不触发。大概我们插件与 dsh-tui 不在同一个 fiber 树里。

于是绕开键 —— 用 **`preload.mjs` 的模块加载钩子**改写
`host-registry.js` 的源码，让 `registerTuiChannel` 顺手 push 一份到
`globalThis.__ccBridgeChannels`：

```js
export function registerTuiChannel(ctx, channel) {
    try { (globalThis.__ccBridgeChannels ??= []).push(channel); } catch {}
    const key = rootKey(ctx);
    ...
```

取 Channel 于是变成"读一个全局数组" —— 没有键匹配、没有时序问题。
**这是唯一可行的路径**，因为 ESM 具名导出改不动（运行时），但加载钩子
在模块求值**之前**介入，改的是源码文本。

> preload 启动时会**自校验**这个改写能否命中，并把结果写进日志：
> `host-registry 改写自校验：WeakMap 3/3，register 记录=是 ✓`
> 匹配不上就是 `★ 上游写法变了，/clear 归零会失效` —— 不会静默坏掉。

### ⚠️ 血的教训：不要 import dsh-tui 的内部模块

第一版从三份 dsh-tui 副本各 `import()` 一次
`dsh-adapter/host-access.js`（为了拿 `compositionRoot`），**把启动搞崩了**：

```
TypeError: Cannot redefine property: execute
    at Object.defineProperty (<anonymous>)
    at Fiber.value (dsh-adapter/host-access.js:250)
```

原因：`host-access.js` **顶层**就调 `installGlobalFiberInstrumentation()`
（第 34 行），而它做两件危险的事：

```js
Object.defineProperty(Fiber.prototype, '_execute', {...})   // 改共享的类
Object.defineProperty(runner, 'execute', {
  configurable: false,        // ← 不可重定义
})
```

防重复守卫是**模块级** `WeakSet`（`wrappedRunners`）—— 每份副本一个。
从第二份 import 时，新副本的 WeakSet 是空的，于是再次
`defineProperty(runner, 'execute')`，而那个属性已被设成
`configurable: false` → **抛错**。

更隐蔽的是：`Fiber` 类来自 `@deepseek-ai/cordis`，**三份副本共享同一个类**
（同一个 node_modules 解析结果），所以这不是"各改各的"，是真的重复改同一个对象。

**结论：`channel-hooks.mjs` 现在不 import 任何 dsh-tui 内部模块。**

> 这个 bug 最坑的地方是它**掩盖了真相**：崩溃发生在 dsh-tui 建 Channel
> **之前**，所以 `registerTuiChannel` 从未被调用，而"没捕获到 Channel"
> 看起来像是接缝找错了。修掉之后一次就通了。

### 归零时抄了官方清单

dsh-tui 自己有个 `channel/session-reset.js` 的 `resetSessionProjection()`
—— 会话切换（adopt / resume / rewind）时用它把投影重置成"新会话"。
`/clear` 做的是同一件事，所以字段清单**对齐它**，别自己猜。

两处**故意不同**：

**① `lastUsage` 设成零值而不是 `undefined`**

官方设 `undefined`，因为那是"换了个会话、还不知道用量"。但 `StatusLine` 里
`usage === undefined` 会让整个 ctx 字段**消失**。而 `/clear` 的期望是
**看到它归零**，所以给零值 → `formatContextUsage(0, 256000)` → `0.0% (0/256k)`。

**② 不清 `sessionTitle` / `sessionColor`**

官方清是因为真换了会话。`/clear` 是同一个窗口重开一段对话，标题留着更符合直觉。

抄不了的 4 个内部闭包：`resetProjector()`、`rowIds`、`resetSubagents()`、
`resetJobs()` —— 不是 `state` 上的字段。影响可控：下一次 `turn/start`
会重开 step，投影自然重新铺。

### ⚠️ 改完 `rows` 必须标脏

最隐蔽的一环。`adapter/channel/read-view.js` 的投影**带缓存复用**：

```js
if (prior !== undefined && Array.isArray(value)
    && prior.value.length === value.length
    && prior.dirtyRevision === dirtyRevision)
  return prior.value                    // ← 返回旧快照！
```

也就是说：**行数没变的话，改内容界面不会更新**。清空后补一条提示
（清 N 行 → 补 1 行）如果恰好与原行数相同，界面会继续显示旧内容。

所以 `state.rows` 一要**原地改**（`rows.length = 0`，不能 `rows = []` ——
组件里已持有的旧数组会指向旧内容），二要调 `markChannelReadDirty`。

## 摘掉 `/` 命令菜单

输入 `/` **不再弹补全菜单**了 —— 因为菜单里的东西全都用不了。

### 为什么清了 `LOCAL_COMMANDS` 还会弹

菜单的数据源是（`command-completions.js:21`）：

```js
return completeCommands(input, state.commandList, path => {...})
```

而 `state.commandList` 里除了本地命令，还有 **DSH 注册的外部命令**
（插件 / skill，`external: true`）。那些不经过 `LOCAL_COMMANDS`，
所以「斜杠透传」那一步清空源头碰不到它们。

### 怎么彻底关掉

把 `state.commandList` 定义成"读永远是空数组、写被丢弃"的访问器：

```js
let empty = []
Object.defineProperty(target, 'commandList', {
  get() { return empty },
  set(_ignored) { empty = [] },   // refreshCommands 的写入被吞掉
})
```

**为什么不能只清一次内容**：`refreshCommands()` 会
`setCommands(merged)` → `state.commandList = commands`，那是**换掉整个数组
引用**，清过的那个就没人引用了。访问器对 refresh 免疫。

**为什么要在 Channel 到手之后做**：`state.commandList` 初始指向
`LOCAL_COMMANDS`，但启动时 `refreshCommands()` 会换成新数组。早于那一刻
`defineProperty`，改的是旧引用，随后被覆盖。

> 副作用：`Chat.js` 用 `commandList` 判断 `/permission`、`/plan` 这些外部命令
> **是否挂载**。列表恒空会让那两个分支走"未挂载"路径。对纯 claude 用途无影响。

## 状态栏那个 `cc-bridge` 是什么

**是 cwd（当前工作目录），不是 workspace 名。**

```js
// StatusLine.js:274-278
...(statusBar.cwd ? [{
  key: 'cwd',
  node: <Text>{statusBar.compact ? basename(displayCwd) : displayCwd}</Text>,
}] : []),
```

`compact` 模式（默认）只取 basename，所以 `D:\code\cc-bridge` 显示成
`cc-bridge`。跟 workspace 无关。

### 关于「缓存 0.0%」

**那个数字是准的**，不是 bug。`formatCacheHitRate` 的算法：

```js
const total = usage.input + usage.cacheRead + usage.cacheWrite
return `${((usage.cacheRead / total) * 100).toFixed(1)}%`
```

**第一轮请求必然 0.0%** —— 没有缓存可命中。实测多个真实会话：

| 会话 | 条数 | 首条 | 末条 |
|---|---|---|---|
| sess-a | 5 | 0.0% | 99.3% |
| sess-b | 18 | 0.0% | 99.7% |
| sess-c | 4 | 0.0% | 97.7% |

**首条永远 0.0%，之后 96~99%。** 所以看到 0.0% 通常是"才聊了一轮"。

还有个显示细节：`/clear` 归零后缓存字段会**整个消失**（不是显示 0.0%）——
因为 `lastUsage` 全零时 `formatCacheHitRate` 返回 `undefined`，字段就不渲染了。

## 品牌名替换

界面里的 `DeepSeek` → `Claude`，`鲸鱼娘` → `Claude娘`。

```js
// src/brand-rename.mjs
const WORD_MAP = [
  ['DeepSeek', 'Claude'],
  ['鲸鱼娘', 'Claude娘'],
  ['whale girl', 'Claude girl'],
]
```

接缝和「换开屏欢迎语」同一套：`i18n.js` 导出的 `i18nDict` 与内部 `dict`
是**同一个对象**，原地改条目属性即可，`t()` 立刻看到新值。

`/settings` 里的文案是**另一份**硬编码（`settings/definitions.js` 的
`SETTING_DEFINITIONS`），所以那个文件也走一遍。

### ⚠️ 有 23 条**故意不改**

这是本模块最重要的设计。i18n 里有 29 个词条含 `DeepSeek`，但其中 23 条
改成 Claude 会变成**错误信息**：

| 词条 | 原文 | 为什么不能改 |
|---|---|---|
| `balance-*` | 「DeepSeek 余额 ¥{{total}}」 | 查的是 **DeepSeek 平台**的余额 |
| `cmd-desc-balance` | 「查看 DeepSeek 账户余额」 | 同上 |
| `coupon-*` | 「DeepSeek 送你的 …鲸鱼券到账啦」 | 券是 DeepSeek 发的 |
| `login-*` / `logout-*` | `DEEPSEEK_API_KEY` | 真实环境变量名 |
| `doctor-*` | 同上 + `llm-deepseek` 配置段名 | 真实标识符 |
| `cost-note*` | 「以 DeepSeek 平台为准」 | 账单确实在那边 |
| `model-usage` | 「如 `deepseek/deepseek-flash`」 | 真实 provider/model 路由 |
| `update-*` | `@deepseek-harness-tui/dsh-tui` | 真实包名 |
| `logo-drift-*` | `npm i -g @deepseek-ai/dsh` | 真实命令 |
| `provider-opt-catalog-desc` | 「openai、anthropic、deepseek 等内置目录」 | provider 列表 |

改这些会让人以为要写 `CLAUDE_API_KEY`、或以为 `/balance` 查的是 Anthropic
账户 —— **比不改更糟**。

所以用 `SKIP_PREFIXES` 前缀跳过 + `isReplaceable()` 再挡一道（环境变量名、
`deepseek/` 路由、含反引号的代码样式一律跳过）。

> 踩过两次，都是**前缀写窄了**：
> · `balance-` 匹配不到 `cmd-desc-balance`
> · `coupon-` 一开始根本没列
>
> 教训：改词条名时要**对着 grep 结果逐个核**，别凭印象写前缀。

实测：**改 48 条，跳过 232 条**。穷举验证过每个含品牌词的词条，
留下的 23 条全部有正当理由。

## 队友卡片显示真实模型

原来卡片上写的是 `claude-code`，那其实是 **provider 名被当成了模型名**。

### 根因

dsh-TUI 建队友行时（`subagent-projection.js:378`）：

```js
store.onSpawned(info.id, info.provider || 'subagent', info.provider, {...})
//                          ↑ provider              ↑ **这个位置是 model**
```

第二、三个参数分别是 `provider` 和 `model`，而两个都拿到了 `info.provider`。
我们报的 provider 是 `claude-code` —— 于是模型也成了 `claude-code`。

而 store 里是 `model: model ?? info.model ?? provider`，所以最终显示 provider 名。

### 修法

`subagent/start` 的 payload 里**没有 model 字段**（projection 也不读），
所以只能拿到 store 后改。好在 `initInfo.model` 就是 claude 实报的真实模型：

```js
applySubagentPatch(msg.id, { model: initInfo.model })   // 队友一出现就纠正
```

后面每条转发消息还会用 `message.model` 再校一次（更精确 —— 实测队友
transcript 里带着 `claude-sonnet-4-5`）。

效果：

```
子代理：Search example topic · claude-sonnet-4-5 · 55s · 15k tok · 5 tools
```

## ⚠️ 队友数据为什么要「自己镜像」

这是整个项目**最绕**的一环，值得单独记 —— 因为它有一个极具迷惑性的表现。

### 迷惑现象

`store` 里的值**确实改了**（读回验证通过），界面**纹丝不动**：

```
[cc-bridge] 队友初始模型: task-demo → <claude 实报模型>（store 读回: 同一名字）
面板显示：  · claude-code ·
```

### 为什么

dsh-TUI 的数据流是**两级**的：

```
store（真相）──syncNow()──▶ state.subagents（快照）──▶ UI
```

我原以为"改 store 再触发 `syncNow`"就行，办法是发一条无害的 `request/context`。
**那条路根本走不通** —— `subagent-projection.js:193`：

```js
const onSessionEvent = (session, event) => {
  let id = store.getSubagentIdBySession(session);
  if (id === undefined) return false;   // ← 在这就返回了
  ...
  syncNow();                            // ← 永远走不到
}
```

它要求这个 session 能关联到某个队友 —— 而 **claude 的队友没有 DSH 子会话**
（那正是本项目要桥接的东西），所以永远匹配不上，`syncNow()` **从来没跑过**。

### 解法：自己镜像

既然已经拿到 Channel（= `state`），就照着 `syncNow()` / `syncRows()` 的做法
把要显示的字段抄进去：

```js
mirrorSubagent(taskId, storeState)   // src/channel-hooks.mjs
```

**⚠️ 必须写两个地方，它们是不同的对象：**

| 位置 | 谁读它 |
|---|---|
| `state.subagents[i]` | 队友面板（`Ctrl+A`） |
| `state.rows[i].subagent` | 对话流里的**内联卡片** |

`syncRows()` 里是 `row.subagent = view` —— **新建**的 view，不是 ① 的元素引用。
所以只改一处的话另一边还是旧值。

### 顺带修好的

同一套镜像逻辑也让 `-- tok · 0 tools` 变成了真实值：

```
修复前： · claude-code · 2m33s · -- tok · 0 tools
修复后： · claude-sonnet-4-5 · 55s · 15k tok · 5 tools
           │ I'll look up the language origin…
```

（之前 tokens 一直显示 `--`，就是因为 `setTokens` 调用了但快照没更新。）

## 去掉大标题下那行提示

开屏时大标题下面本来有一行：

```
提示：/login 查看凭据状态 · /tips 更多技巧
```

已经去掉，现在那里是干净的：

```
✦ dsh-TUI  v0.12.0
CLAUDE CODE
BRIDGE
<claude 实报模型> · Xhigh effort
D:\code\cc-bridge
```

### 为什么不用「清空 i18n 词条」这招

那行的结构是：

```jsx
<ThemedText>
  <ThemedText dimColor>提示：</ThemedText>                  ← 前缀元素
  {随机技巧}                                                 ← 纯字符串
  <ThemedText dimColor> · /tips 更多技巧</ThemedText>        ← 尾巴元素
</ThemedText>
```

前缀和尾巴是**独立元素**，而尾巴那段的 `' · /tips '` 是**硬编码字面量**
（`' · /tips ' + tr('logo-tip-more')`），**不走 i18n** —— 清词条只会剩
「提示： · /tips 更多技巧」，比原来更难看。

而且它还需要**从 `jsx` 那一层整行干掉**（清词条也去不掉中间的随机技巧）。

### 怎么做的

`preload.mjs` 已经包装了 `react/jsx-runtime` 的 `jsx/jsxs`（原本用于 ctx 条
颜色重映射），顺手加一条：识别到那一行就 `return null`。

React 对 `null` 不占位，所以不留空行。

判别条件（实测的真实结构）：

```js
children 是长度 3 的数组 && children[2].props.children 含 ' · /tips '
```

` · /tips ` 之所以可靠：它是硬编码字面量，且全库渲染代码里**只此一处**
（三份 dsh-tui 副本各 grep 过，都是 1 次）。

### ⚠️ 踩了个大坑：只包了一份 jsx-runtime

第一版实现**逻辑完全正确，却一点效果都没有**，日志里连"已隐藏"都不打。

原因在 `loadJsxRuntime()`：

```js
for (const root of tuiPackageRoots()) {
  const mod = createRequire(pkg)('react/jsx-runtime')
  if (mod && typeof mod.jsx === 'function') return mod   // ← 找到第一份就返回！
}
```

三份 dsh-tui **各有自己的 `react` 依赖** —— 而实际渲染用的那份**未必是第一个**。
实测：包装只落在 `npm 全局` 那份，真正渲染的是 `dsh-tui profile` 那份。

> 这个坑很隐蔽：包装函数明明装好了（`jsx=function`），颜色重映射还有生效
> 的迹象（某些渲染确实走了被包的那份），偏偏针对性的那一项不生效 ——
> 看起来像"判别条件写错了"。

**修法：三份都包。**

```js
const jsxRuntimes = loadJsxRuntimes()      // 返回数组
for (const { root, mod } of jsxRuntimes) { mod.jsx = wrap(mod.jsx); ... }
```

日志会打出包装了几份，方便一眼确认：

```
[preload] 已执行：pid=24332 jsxRuntime=3 份（npm 全局/dsh-tui profile/dsh-tui-safe）
[preload] 已隐藏开屏提示行（提示：… · /tips）
```

### 排查手法（值得记）

定位这个 bug 靠的是**往 jsx 包装里插 dump**，把真实的 `children` 结构打进日志：

```
[tipdiag3] prof/jsxs 命中！ type=ThemedText children.length=3
  [0] el(ThemedText) inner="提示："
  [1] str "/export 把完整会话导出为 Markdown（含思考）"
  [2] el(ThemedText) inner=" · /tips 更多技巧"
```

两个关键收获：
1. **确认了判别条件是对的**（children 确实是 3 项数组）
2. **命中的 `prof` 前缀暴露了"只有 profile 那份是活的"** —— 这才把注意力
   从"判别写错了"转到"包装装错地方了"

如果只靠读源码猜，很容易一直在改判别条件。

## 工作目录：跟随宿主

claude 在哪个目录干活，**默认跟随 dsh-tui 的会话目录** —— 不用配置。

```
[cc-bridge] apply() 被调用；config.cwd = (未配，将跟随宿主)
[cc-bridge]   cwd 解析：meta = D:\code\cc-bridge  config = (未配)  → 采用 = D:\code\cc-bridge
```

结果：状态栏的 `cc-bridge` / `D:\code\cc-bridge` 和 claude 自己的工作目录**是同一个值**。
问 claude「你当前的工作目录是什么」，它答 `D:\code\cc-bridge`。

### 接缝在哪

dsh-tui 建 agent 时**主动把 cwd 传下来了**：

```js
// dsh-adapter/plugin.js:414
const meta = { cwd: sessionCwd }
// dsh-adapter/plugin.js:1666
ctx.agents.create({ sessionId, meta: { ...meta }, ... })
```

于是我的 `createAgent(ownerCtx, options)` 里能读 `options.meta.cwd`。优先级：

| 顺序 | 来源 | 用途 |
|---|---|---|
| ① | `options.meta.cwd` | **宿主传下来的会话目录**（首选） |
| ② | `config.cwd` | 手动覆盖（沙盒等特殊场景） |
| ③ | `process.cwd()` | 兜底（headless 等没有 meta 的宿主） |

### ⚠️ 踩过：在 `apply()` 里捕获 cwd 是错的

原先是插件级捕获一次，闭包传给所有 agent：

```js
export function apply(ctx, config = {}) {
  const cwd = config.cwd ?? process.cwd()   // ← 错
```

而 patch 里写死了 `cwd: 'D:\code\playground'`（当年为测试隔离）。后果是界面上
**同时出现两个目录**：

```
状态栏：  cc-bridge / D:\code\cc-bridge     ← dsh-tui 的会话目录
claude：  D:\code\playground                 ← 我写死的
```

看着像 bug，其实是两行配置各管各的。**`cwd` 是 per-agent 的属性**，不是插件级的 ——
修法是在 `mountAgent()` 里逐 agent 解析（`resolveAgentCwd()`）。

> 想做沙盒就显式写 `config.cwd`。但要知道那时状态栏仍显示宿主目录 ——
> 因为状态栏显示的是「你所在的窗口位置」，这**不算 bug**。

## 安全与边界

这一节说明**本插件会动什么、不会动什么** —— 如果你要把它装到自己的机器上，
这些是应该知道的事。

### ✅ 不会做的事（都有代码级证据）

| 项 | 结论 |
|---|---|
| 改写 dsh-tui 包文件 | **不会**。源码改写发生在 `module.registerHooks()` 的 load 钩子里，只 `return` 改写后的**字符串**，原文件只被 `readFileSync` 读 |
| 改写 dsh 包文件 | **不会**。只 `import()` 它们 |
| 写 `~/.claude/` | **不会**。只读 transcript 文件（`projects/<mangled>/<uuid>.jsonl`） |
| 写 `~/.dsh/profiles/*/cordis.patch.yml` | **不会**。只用 `--patch` 传自己的文件 |
| 写 `~/.dsh-tui/`（theme/model/effort.json） | **不会**。主题走 `ctx.tuiThemes.register()` **内存**注册 |
| 网络请求 / 数据外传 | **没有任何** `fetch` / `http` / `https` / `WebSocket`。`inject.mjs` 只连本机命名管道 |
| shell 注入 | 参数**数组**传参，无字符串拼接。唯一走 shell 的路径（启动 `.cmd` 包装器）有字符白名单 |

**唯一会写的两个文件**都在插件自己的状态目录里：

```
$CCB_STATE_DIR  ||  $DSH_HOME/cc-bridge  ||  ~/.cc-bridge
  ├── bridge.log         诊断日志
  └── session-map.json   dsh ↔ claude 的会话 id 映射
```

### ⚠️ 需要知道的副作用

1. **首次运行会在 `~/.dsh/` 下新建 `cc-bridge/` 目录**（与 `profiles/` 平级，
   不会被当成 profile 加载）。

2. **`--import` 预加载会改写内存里的上游源码。**
   `run.ps1` 设 `NODE_OPTIONS=--import .../preload.mjs`，它做两件事：
   - 包装 `react/jsx-runtime` 的 `jsx/jsxs`（ctx 条配色 + 去掉开屏提示行）
   - 用 load 钩子共享 `host-registry.js` 的 WeakMap（让插件能拿到 live Channel）

   两者都**只在内存里**，但命中失败时是**静默降级** —— 所以启动日志里会
   打印自校验结果，看到 `WeakMap 3/3，register 记录=是 ✓` 才算正常。

3. **`check-upgrade.ps1 -SelfTest` 不碰上游。**
   早期版本会把 npm 全局的 `dsh-session` 源码 `Set-Content` 改掉再还原 ——
   窗口期被打断就**永久损坏**上游包。现在改成在 `$env:TEMP` 的副本上做，
   上游文件全程只读。

4. **`kill-mine.ps1` 只动 `.test-pids` 里记的 PID**，且有命令行二次校验。
   PID 由插件**自己汇报**（`CCB_PID_FILE`），不靠时间窗口猜 —— 避免把你
   自己开的窗口误记成测试进程。

### 权限模式

本插件**不**使用 `--dangerously-skip-permissions`，也不改 claude 的权限配置。
claude 用什么权限模式，取决于你自己的 `~/.claude/settings.json`。

`Agent.cancel()` 会经 `taskkill /T /F`（Windows）或 `SIGKILL` 收掉 claude 及其
子进程树 —— 这是为了不留下孤儿进程。

## 打包与安装

### 现状

```
dsh plugin --profile dsh-tui add <package>     # 官方安装命令
```

`package.json` 的 `dsh.bundle.patch` 指向 **host.patch.yml**（只 insert，不禁
agent-loop）。日常：

```powershell
dsh plugin --profile dsh-tui add <本仓库>
dsh plugin --profile dsh-tui remove cc-bridge
```

橙色窗 `run.ps1` 仍叠 `cordis.patch.yml`（只影响这一次启动）。
不要把窗口 overlay 写进日常 profile 的 `cordis.patch.yml`。

### 仓库结构（给想 fork 的人）

```
cc-bridge/
├── src/                   17 个模块，见下面分层
├── assets/                立绘（授权状态见 assets/README.md）
├── tests/                 核心协议单测（`npm test`）
├── host.patch.yml         日常组合包（只 insert /ccb）
├── cordis.patch.yml       窗口 overlay（禁 agent-loop + 橙色外观）
├── locale/                插件卡标题（en / zh）
├── icon.svg               插件图标
├── contracts.json         65 条上游契约（check-upgrade.ps1 读它）
├── package.json           插件清单（dsh.bundle 指向 host.patch.yml）
├── LICENSE                MIT（**不含 assets/**）
├── .gitignore             排除运行时状态
├── run.ps1                启动（--patch，只影响这一次）
├── install-plugin.ps1     装进独立测试 profile
├── uninstall-plugin.ps1   拆掉测试 profile
├── run-plugin.ps1         开测试 TUI profile 窗口
├── check-upgrade.ps1      升级检查 + 自检
├── probe-claude.ps1       探测 claude 配置 → 状态栏
├── probe-core-only.yml    验证「核心不依赖 dsh-tui」
├── inject.mjs             注入文本/提交（命名管道）
└── kill-mine / launch-test / reset-tab / reset-terminal   测试窗口管理
```

**运行时会生成**（不在仓库里，已被 `.gitignore` 排除）：

```
$CCB_STATE_DIR || $DSH_HOME/cc-bridge || ~/.cc-bridge/
├── bridge.log          诊断日志
└── session-map.json    dsh ↔ claude 会话 id 映射
```

### 依赖分层（实测）

**核心零 npm 依赖** —— `index.mjs` 的外部 import 全是 Node 内置模块：

```js
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, ... } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
```

| 层 | 模块 | 依赖 dsh-tui |
|---|---|---|
| **核心** | `index.mjs` `model-route.mjs` `channel-hooks.mjs` `tui-roots.mjs` `sprite-tools.mjs` | **否** |
| **外观/桥接** | `preload.mjs` `maid-art.mjs` `splash-title.mjs` `splash-glyphs.mjs` `theme-orange.mjs` `welcome-tagline.mjs` `brand-rename.mjs` `slash-passthrough.mjs` `subagent-bridge.mjs` | 是 |

`package.json` 里 dsh-tui 声明为 **optional peerDependency** —— 因为核心不需要它，
只有外观层需要。

### 验证方法：核心能否脱离 dsh-tui

把全部外观功能关掉，在 **headless**（没有 dsh-tui）profile 里跑：

```powershell
dsh --profile headless --patch .\host.patch.yml --patch .\probe-core-only.yml 'Reply exactly CORE_OK'
```

实测结果（这是"核心不绑 dsh-tui"的证据）：

```
[cc-bridge] createAgent 完成 session-aaaaaaaa-...
[cc-bridge] followup: Reply exactly CORE_OK
[cc-bridge] spawn claude (新建会话)
[cc-bridge]   init: model=claude-sonnet-4-5 tools=N mcp=M skills=K
[cc-bridge]   ctx 窗口容量（claude 实报）: 256000
[cc-bridge] turn 1 done ok=true steps=1 tools=0 chunks=3
CORE_OK                                        ← 退出码 0
```

**结论**：`dsh` 是硬前置（它就是 dsh 插件）；`dsh-tui` 是**窗口**（本项目的目标），
但**不是核心的硬前置**。

## 换开屏欢迎语

立绘下面那句话（原版「探索未至之境！」）也能换：

```yaml
welcomeTagline: '这用户有股味！'
```

同样**只影响带本 patch 的启动**。

### 接缝：为什么能生效

文案在 dsh-tui 的 `i18n.js` 字典里：

```js
const dict = {
  'logo-tagline': { zh: '探索未至之境！', en: 'Explore the uncharted!' },
}
export const i18nDict = dict;     // ← 导出的是同一个对象引用
```

`t()` 内部读 `dict`，而 `i18nDict` 导出的是**同一个对象** —— 所以原地改
`i18nDict['logo-tagline'].zh` 就能生效，`t()` 立刻返回新值。

对象和条目都未冻结，改属性不会抛。

### 不用管居中对齐

`LogoV2.js` 是**运行时按实际宽度**算缩进的：

```js
const welcomeWidth = starLine === null ? stringWidth(tagline) : starLine.width;
const welcomePad = Math.max(0, Math.round(MAID_BOX_CENTER - welcomeWidth / 2));
```

所以换多长的文案都会**自动居中**，不需要重算 pad。

> 顺带：中文 7 字 = 14 列，和原句等宽 —— 视觉位置分毫不差。

### 英文界面不跟着变

只改 `zh`，`en` 保持原样。切到英文界面时会显示原版英文 —— 这是**有意的**：
比把一句中文硬塞进英文界面自然。

## 自定义开屏大字

把右侧那两排大字（原版 `DEEPSEEK` / `HARNESS`）也换掉：

```yaml
splashTitle:    'CLAUDE'
splashSubtitle: 'CODE'
```

同样**只影响带本 patch 的启动，不动 dsh-TUI 的包**。

字库里没有的字母会**自动补字形**，所以 `CLAUDE` / `CODE` 开箱即用
（详见下面「字形」一节）。

### 字形：原本只有 13 个字母，会自动补

dsh-TUI 字库里**原本只有**这些字母：

```
A D E H I K M N P R S W Y
```

用别的字母会画成 fallback 方块。所以 `CLAUDE CODE` 缺 `C L U O`、
`SAKURA` 缺 `U`、`CCBRIDGE` 缺 `C B G`。

**但本插件会自动把缺的字形补上**（`src/splash-glyphs.mjs`），
`CLAUDE CODE` 开箱即用：

```
[cc-bridge]   补了字形：C L O U（24 款字体）
[cc-bridge] 开屏大字已更换：3 份 dsh-tui 实例
```

补不了的字母（没设计过的）仍会明确警告，不会悄悄糊成方块：

```
⚠️ 这些字母字库里没有，会画成方块：B G
   可用字母：A C D E ...
```

**目前补了 4 个**：`C` `L` `O` `U`。要别的字母跟我说，加进
`splash-glyphs.mjs` 的基准表即可（三套基准各加一份）。

### 补字形怎么保证不出错

八款字体不是八套字形，而是**三套基准 + 五个变换**：

```
BOLD (6列) ──┬─ SQUARE   圆角填实
             ├─ BEVEL    按邻居做左亮右暗
             ├─ WIDE     6→8 列最近邻拉伸
             ├─ DOT      压成灰度
             └─ STENCIL  中段挖空
CLASSIC (5列) ── 独立
SLAB (5列)    ── 独立
```

那五个变换函数是**模块私有**的，外部拿不到，所以 `splash-glyphs.mjs`
重新实现了一遍。**但不盲信自己的实现** —— 每个变换都拿已知字母
（`D E A H P S`）算一遍，跟字体表里的实际结果比对：

```js
const bad = verifyTransform(font, baseGlyphs, transform)
if (bad.length > 0) {
  // 拒绝打补丁，而不是画出错字
  errors.push(`变换「${transform}」自校验失败（${bad.join(' ')} 对不上）`)
}
```

这样即使哪天 dsh-TUI 改了变换规则，也是**明确失败**而非静默画错。
实测把 `SQUARE` 故意改错一个字符，8 款字体全被拒绝：

```
ok: false
reason: npm 全局/square: 认不出基准字形 | dsh-tui profile/square: ...
```

### 原理

大字由 `splashFonts.js` 的字体表驱动，每款字体带一个 `tagline`：

```js
{ id: 'bold', glyphs: {...}, glyphWidth: 6,
  tagline: { top: 'DEEPSEEK', bottom: 'HARNESS', topKerning, bottomKerning, bottomIndent } }
```

渲染时 `LogoV2.js` 读 `titleFont.tagline.top/bottom` 交给 `renderBigText`。
而 `pickSplashFont()` 就是 `SPLASH_FONTS[day % length]` —— **返回表里的对象本身**
（不是副本），字体表也没冻结。所以**原地改 `tagline`** 就能换词。

### 三个必须注意的点

**① 改词必须重算字距**，否则两排不等宽、下排居中缩进也不对。
官方有 `withTagline(font, top, bottom)` 干这个（节日彩蛋换 `MERRY` / `NEW YEAR`
就用它）。但它返回**新对象**，所以做法是：**用 withTagline 算好，再
`Object.assign` 回原对象** —— 身份不变、值更新。

**② 不能替换数组项**。`DEFAULT_SPLASH_FONT` 是模块加载时捕获的
`SPLASH_FONTS[0]` 引用，`splashFontById` 也走 `find` —— 替换数组项会让它们
变成陈旧引用。

**③ 必须八款字体全改**。`pickSplashFont()` **按本地日期取模**选字体，
只改一款的话，今天恰好不是那款就不生效。

> 这第 ③ 点就是第一版踩的坑：只改了 `SPLASH_FONTS[0]`，
> 日志显示「更换成功」，但界面上词纹丝不动 —— 因为今天轮到的不是那款。

### 字距会自动拉宽（不然右边空一截）

官方的 `solveTagline` 只保证**两排互相等宽居中**，且字距从**最小值**
（`minKerning = 1`）往上试、命中第一个解就返回 —— 它**不管整块占多宽**。

原版 `DEEPSEEK`(8 字) / `HARNESS`(7 字) 恰好画到 56 列、几乎填满文字列，
所以看不出问题。换成 `CLAUDE`(6 字) / `CODE`(4 字) 只剩 42 列：

```
实测截图（文字列宽 534px）
  拉伸前  CLAUDE  x 406..763  宽 358px  距右 171px   ← 右边空约 1/3
  拉伸后  CLAUDE  x 404..808  宽 405px  距右 124px
```

解法是在**上游契约允许的范围内**搜一组尽量宽的字距
（`src/splash-title.mjs` 的 `solveWidestTagline`），约束照抄 `solveTagline`：

- `bottomIndent >= 0` —— 下排不能比上排宽
- `|bigTextWidth(top) - bigTextWidth(bottom) - 2*indent| <= 1` —— 上游的等宽判据
- 字距上限 `MAX_KERNING = 8`

度量直接用**上游导出的** `paintedWidth` / `bigTextWidth`，不自己重实现公式 ——
免得哪天上游改了算术这里跟着漂移。

`CLAUDE` / `CODE` 的可行解只有三组，会自动选最宽的：

| 字距 | 宽度 |
|---|---|
| 1 / 4 | 42 列（官方 `withTagline` 给的，最窄） |
| 2 / 5 | 48 列 |
| **4 / 8** | **60 列** ← 采用 |

日志会报出来：

```
[cc-bridge]   字距拉到 60 列（上排 4 / 下排 8，缩进 4）
```

### 时序是宽容的

`useState(() => pickSplashFont())` 只捕获**字体对象**，而词是每次渲染现读
`tagline.top` 的。开屏有 ~3.4 秒动画持续重渲染，所以即使补丁打在首帧之后，
下一次渲染就会用上新词。

## 状态栏跟随 claude

底部状态栏那三个值现在**全部跟随 claude 实际用的**：

```
claude-sonnet-4-5 · xhigh · 缓存 0.0% · cc-bridge
                                          ctx 9.2% (24k/256k)
```

| 显示项 | 改前 | 现在 | 来源 |
|---|---|---|---|
| 模型名 | `deepseek-v4.1-flash` | `claude-sonnet-4-5` | `probe-claude.ps1` 探测 |
| 思考强度 | `max` | `xhigh` | 同上 |
| 上下文 | `200k` | `256k` | claude result 帧实报 |

它们本来都是 **dsh-TUI 自己的会话路由**，跟 claude 用什么毫无关系。
下面分别说三项各自怎么接上的。

### 模型名从哪来

```
StatusLine.js:206   <Text>{channel.model}</Text>
     ↑
channel.model = state.model          （channel.js:566 `model: () => state.model`）
     ↑
state.model = route.model            （session-resume.js:27 / model-switch.js:86）
     ↑
route = resolveModelRoute(configured, readModelPref(), DEFAULT_MODEL_ROUTE)
```

注意显示的是 **model id**，不是 display name。思考强度
（`channel.reasoningEffort`）和它同源，都由这条路由决定。

### ① 模型名与思考强度：启动前探测 + 注册 provider

#### 探测

claude 的模型/强度存在两个地方，`probe-claude.ps1` 在**启动前**读出来：

```powershell
# ~/.claude/settings.json
{ "model": "claude-sonnet-4-5" }

# 强度在环境变量里
CLAUDE_CODE_EFFORT_LEVEL = xhigh
```

写进两个环境变量 `CCB_CLAUDE_MODEL` / `CCB_CLAUDE_EFFORT`，再由
`cordis.patch.yml` 的 `!!js` 表达式读走。探测失败就回落成字面量，
**不影响启动**。

> 若 `settings.json` 的 `model` 写的是**别名**（`sonnet`/`opus`/…），
> 真名要去 `ANTHROPIC_DEFAULT_<ALIAS>_MODEL_NAME` 里查 —— 脚本已处理。

#### 让这个路由被接受

`!js` 拿到的名字要进 dsh-tui 的路由，而路由过 `validateModelRoute` 校验：

```js
export async function validateModelRoute(llm, route, fallback) {
  let models
  try { models = await llm.listModels(route.provider) }
  catch (error) {
    if (!isUnregisteredProvider(error)) return { route }
    return { route: fallback, rejected: route }    // ← provider 没注册 → 打回
  }
  if (models.length === 0 || models.some(m => m.id === route.model))
    return { route }                                // ← 接受
  return { route: fallback, rejected: route }       // ← 模型不在表里 → 打回
}
```

一开始把 provider 写成 `claude-code`，而它**不是 DSH 注册过的 provider**
—— `llm.listModels` 抛 NO_ADAPTER，**整份路由被打回默认值**，于是状态栏
显示的是那个跟实际后端毫无关系的名字。

解法是 `ctx.llm.registerAdapter(providers, adapter)`（官方 `LlmAdapter`
抽象类），在 `src/model-route.mjs` 里注册一个**只作路由声明**的 provider：

- `listModels()` 返回我们声明的那个模型 → `models.some(...)` 为真 → 接受
- `resolveModel()` 返回 `context.contextWindow` 和 `reasoning.efforts`
  → ctx 条刻度、强度档位都从这条路拿到

**我们从不通过它发请求** —— claude 是 spawn 出来的子进程。这个 adapter
只负责「宣告路由存在」，`stream()` 永远不会被调用（真被调到会明确抛错，
不静默返回空流）。

#### ⚠️ 还要在 patch 里成对写 provider + model

`resolveModelRoute` 的优先级：

```
cordis.yml 里成对的 provider+model  >  ~/.dsh-tui/model.json  >  默认值
```

dsh-tui 那行的配置原来只有 `provider`、**没有 model** —— 半配会被整份忽略，
于是落到 `~/.dsh-tui/model.json`（`wbp` / `deepseek-v4.1-flash`）。
**那个文件是全局的**，改它会影响你所有 dsh-tui 窗口，不能动。

> ⚠️ **patch 的 config 是整段替换、不是深合并**
> （`cordis-plugin-include` 的 `applyEntryPatches` 里就是 `target[key] = value`），
> 所以 `effort` / `fullscreen` / `whaleGirl` / `splashFont` … 都得手工写全，
> 漏一项就丢一项。

#### ⚠️ `xhigh` 不在 dsh-tui 的标准档序里

`effortPrefs.js` 里的档序是：

```js
const EFFORT_TIER_ORDER = ['off', 'low', 'medium', 'high', 'max'];   // 没有 xhigh
```

而 claude 实测用的**就是 `xhigh`**。好在标准序只用于「偏好档不在路由表里
就降一档」的回退 —— **精确命中会短路放行**（`nearestLowerEffort`）。
所以只要 adapter 的 `reasoning.efforts` 里声明了 `xhigh`，就能原样显示。

patch 里因此显式列了档位：

```yaml
effortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
```

（这五档就是 `claude --help` 里 `--effort` 认的那些。）

### ② 上下文容量：claude 自己会报

每轮 `result` 帧的 `modelUsage` 里带着权威值：

```json
"modelUsage": {
  "claude-sonnet-4-5": {
    "contextWindow": 256000,        ← 权威值
    "maxOutputTokens": 32000,
    "canonicalModel": "claude-sonnet-4-5"
  }
}
```

起初写死 200k（按 Sonnet/Opus 4.x 猜的），实测是 **256000**，于是 ctx 条
百分比一直是错的。

**时序上有个先有鸡先有蛋**：`request/context` 必须在开跑前发出（条子得先有
刻度），而 result 帧跑完才到。所以第一轮用配置值兜底，拿到真实值后
**从第二轮起**一直用它。想第一次就准，把 `contextWindow` 写成真实值。

拿到之后还会**同步给 llm adapter**（`setContextWindow`）—— dsh-tui 的
`resolveModelInfo` 从那里读容量（`model-actions.js` 的 `applyRouteMetadata`），
和 `request/context` 事件互为补充。

## 橙色主题

dsh-TUI 默认是「Gentle Mist Blue」雾蓝配色。本项目注册了一套暖橙主题，
配 `run.ps1` 里的环境变量选中 —— **只影响带这个启动器的窗口**：

```powershell
# run.ps1
$env:DSH_TUI_THEME = 'cc-bridge:orange'
```

你别的 dsh-tui 会话照旧是蓝色。

### 为什么走环境变量

dsh-TUI 的主题解析优先级（`ThemeProvider.js`）：

```
显式 theme prop > DSH_TUI_THEME 环境变量 > ~/.dsh-tui/theme.json > OSC 11 检测
```

我们取中间那条。**故意不写 `~/.dsh-tui/theme.json`** —— 那是全局持久化，
改了你所有会话都变橙。

主题本体注册在 `src/theme-orange.mjs`（`ctx.tuiThemes.register`），
跟插件同生命周期。

### 踩的两个坑

**① hex 颜色在大标题那里解析失败** —— 底栏、边框都变橙了，**只有大标题还是蓝的**。

上游注册运行时主题时做的是 `{ ...getTheme(base), ...colors }`：内置色板的值
是**已包装**的 `rgb(125,161,222)`，而我们传的覆盖值**原样合并、不包装**。

而大标题取色走 `parseRGB(theme.accent)`，它只认 `rgb(...)`：

```js
parseRGB('rgb(232,145,63)')  →  { r:232, g:145, b:63 }
parseRGB('#E8913F')          →  null   ← 落到 `?? BRAND`（蓝）
```

其他消费方（Ink 的 `color` prop）两种格式都吃，所以只有标题一处露馅。
**修法**：注册前把 hex 全转成 `rgb(r, g, b)`。

**② 第二行的终点色是模块常量，主题管不到**

`LogoV2.js` 渲染两行大字：

```js
bigDeepSeek = renderBigText(..., palette?.from ?? wordmarkRGB,
                                 palette?.to   ?? taglineRGB, ...)
bigHarness  = renderBigText(..., palette?.from ?? taglineRGB,
                                 palette?.to   ?? PALE, ...)
                                            ↑ 写死的蓝 #D7E4FF
```

所以第一行能跟着 `theme.accent` 变，第二行的终点永远是蓝的。

**唯一的入口是字体的 `palette`**（`??` 优先级高于主题色）。所以补了一步：
给八款字体**原地写** `font.palette = { from: 深橙, to: 浅橙 }`
（手法同改 `tagline` —— 必须八款全改，`pickSplashFont()` 按日期取模）。

**代价**：两行共用一对 `from`/`to`，原本「accent → activity」那层
品牌色/活动色的区分没了。视觉上仍是渐变，也统一。

### 改了哪些颜色

41 个键，分三层：

| 层 | 键 | 说明 |
|---|---|---|
| 品牌/焦点 | `accent` `accentShimmer` `activity` `suggestion` `remember` | 最显眼的橙 `#E8913F` |
| 面板/边框 | `promptBorder` `permission` `bashBorder` `planMode` | 浅一档的橙 |
| **衬底** | `toolCardBackground` `selectionBg` `messageActionsBackground` | **暖褐** `#33261C` |

**衬底那层是关键** —— 只换前景不换底色，橙字压在原来的蓝灰卡片
（`#242B3A`）上会"脏"。所以卡片底、选中块、悬停块全部转成暖褐。

**状态色不动**（`success` 绿 / `error` 红 / `autoAccept` 紫）—— 它们表达语义，
改了会让用户误读。只把 `warning` 的色温调暖了一点。

语法高亮跟着暖化，但 `syntaxString` 保留绿色（可读性 + 语义）。

### 主题管不到的三处

主题系统只覆盖**色板里的键**。有三处颜色是模块常量/内联字面量，
需要单独改 —— 都在 `src/theme-orange.mjs` 里（空闲段那处例外，见下）：

| 位置 | 原色 | 为什么主题管不到 |
|---|---|---|
| **ctx 条 5 个已用分段** | 深蓝→亮蓝 | `USED_SEGMENTS[i].color`，直接写进 ANSI，不走主题 |
| **ctx 条空闲段** | `#2E3440` 蓝灰 | `StatusLine.js` 的**内联字面量**，每次渲染新建 |
| **字上扫过的反光** | `#C6D8F8` 雾蓝 | `shimmer.js` 的 `FLASH` 常量，只当参数传给 `sweep()` |
| **输入框前缀 `❯`** | `#82B9FF` 天蓝 | `effortIgnition.js` 的 `HUES_DARK[0]` 常量 |

前两处和第四处能**原地改对象/数组的成员**（导出的是引用，未冻结）：

```js
USED_SEGMENTS[i].color = '...'      // ctx 条分段
FLASH.r = 255; FLASH.g = 214; ...   // 反光高光
HUES_DARK[0].r = 232; ...           // 输入框前缀
```

**但字符串常量改不了** —— `export const FREE_SEGMENT_FILL = '#E8E8E8'` 是
只读导出（ESM 命名空间属性 `writable: false`），而 `StatusLine.js` 里的
`freeFill: '#2E3440'` 更是连对象都没有。

#### ctx 条空闲段：为什么必须用 `--import` 预加载

这条最绕，试错过四条路：

| 方案 | 结果 |
|---|---|
| 改 `chalk.bgHex` | ❌ `Cannot redefine property` —— chalk 的 builder 属性描述符退不掉 |
| 改 `colorize` / `renderNodeToOutput` | ❌ ESM 命名空间只读 |
| 事后包装 `react/jsx-runtime` 的 `jsx` | ❌ **ESM 具名导入是快照** |
| **`--import` 预加载提前包装** | ✅ 有效 |

第三条是**最容易误判的坑**：`react/jsx-runtime` 是 CJS，实测

```js
cjs.jsx = wrapped
(await import('react/jsx-runtime')).jsx === cjs.jsx   // → false
```

——组件在**模块加载那一刻**就把 `_jsx` 捕获成了快照。插件 `apply()` 跑在
dsh-tui 组件加载**之后**，所以那时包装是白费功夫（日志说"成功"、采样仍是旧色）。

只有 `--import` 能在入口模块之前执行：

```powershell
# run.ps1
$env:NODE_OPTIONS = "--import file:///.../src/preload.mjs"
```

包装只重映射**这几个特定 hex**、其它一律放行 —— 不是全局调色板劫持。
上游以后不用这些色了，包装就退化成无害的空转。

#### 输入框前缀 `❯`

就是**紧贴光标左边**那一枚（不是用户消息气泡那个）。平时 dim 无色，
只有思考强度处于**当前路线最高档**时才点亮 —— 你的 `effort: max` 正好是最高的。

颜色链：`EffortChargeGlyph.js` → `accentRamp(onLight).full` → `ignitionHues(onLight)[0]`

上游注释写着「与波共用 hues[0]」「同一瞬间前缀与波是同一种橙」，
但那三个 hue 实际是**冷色**（`#82B9FF` / `#8CFCF8` / `#C3ACFF`），
跟暖橙主题撞得厉害。

`ignitionHues()` 返回的是**数组本身**（不是副本），所以原地改 `[0]` 的分量，
两个消费点（前缀 + `EffortTierBadge` 强度徽章）同时生效。
`[1]`/`[2]` 是「留给未来多带风格」的预留位，也一并暖化了。

## 现状

**能用的：**

- 一问一答，多轮续接（靠 `session-map.json`）
- **实时工具卡片** —— 工具调用、参数、结果、耗时都显示，和文本按序交错
- **token 级流式** —— `--include-partial-messages` → `agent/assistant-stream` 帧
- **中断** —— TUI 的 `esc` 能杀掉正在跑的 claude（连进程树），
  悬空的工具卡片由官方 `ToolCallRecovery` 补一条「结果未知，别盲目重试」的结果
- 多 step 轮次（一次提问触发多次工具调用，逐个 step 展示）
- **ctx 用量条** —— 状态栏 `ctx 12% (24k/200k)`，hover 展开进度条 + 分段明细
- **图片** —— claude 读图（Read 工具）时 tool_result 里的 base64 会被
  落成 DSH attachment，在 TUI 里**真的画出图**来
- 缓存命中率显示
- Mermaid / LaTeX 白拿 —— 它们只是 `assistant/message` 里的 Markdown
  文本，dsh-TUI 自己会渲染成字符图/公式，**不需要额外事件支持**
- dsh-TUI 的全部原生功能：hover 提示、`/` 命令、主题、会话管理

**还没做的：**

- **核心协议已拆文件** —— `ndjson` / `session-map` / `inbox-queue` 有单测
  （`npm test`）。外观层仍和插件本体住同一个包，真要给别的 TUI 用才需要
  再拆成 `@cc-bridge/core` + `@cc-bridge/tui`
- **没有 `/cd` 命令** —— 想中途改 claude 的工作目录目前只能改配置重启。
  好消息是实测 `--resume` **不依赖 cwd**（在 B 目录能续接 A 目录建的会话），
  所以 `/cd` 是安全的，只是还没做
- `steer` 不是往当前 `--print` 进程插嘴：忙时入队，本轮结束后再开一轮
- `inject` 已对齐官方：只落入 `next-step`，不唤醒；下一次 followup/steer 才发出。
  仍不是「塞进当前 claude 进程」——`--print` 一轮一条 user 帧。
- 工具结果的截断策略（超长输出会全量塞进 session）
- 会话 fork / rewind（TUI 有入口，但本 factory 的 resume 只做朴素恢复）

**额外能力（不在原计划里，顺手做的）：**

- **工作目录跟随宿主** —— 不用配置就和 dsh-tui 会话目录一致
  （见「工作目录：跟随宿主」）
- **状态栏跟随 claude** —— 模型名、思考强度、上下文容量三项都跟着
  claude 实际用的走（见「状态栏跟随 claude」一节）
- **自定义标题立绘** —— `maidArt` 配一张 PNG 就换掉开屏的女仆娘，
  还会做一层轻微像素化（见上节）
- **自定义开屏大字** —— `splashTitle` / `splashSubtitle` 换掉
  `DEEPSEEK` / `HARNESS`，缺的字母会自动补字形（见上节）
- **自定义开屏欢迎语** —— `welcomeTagline` 换掉「探索未至之境！」，
  居中会自动重算（见上节）
- **暖橙主题** —— `DSH_TUI_THEME=cc-bridge:orange`（`run.ps1` 里已设），
  只影响带这个启动器的窗口（见上节）

## 调试

```powershell
# 看运行日志（每个关键步骤都有）
Get-Content "$env:DSH_HOME\cc-bridge\bridge.log" -Tail 30
# DSH_HOME 没设时：
# Get-Content "$HOME\.cc-bridge\bridge.log" -Tail 30

# 看事件有没有写对
#   session 文件在 $DSH_HOME/sessions/ 下
```

`bridge.log` 里会记：
```
[cc-bridge]   [1/4] sessions.create
[cc-bridge]   [2/4] mountAgent
[cc-bridge]   [3/4] setup(agent.ctx, agent)
[cc-bridge]   [4/4] agents.register
[cc-bridge] createAgent 完成 <sessionId>
[cc-bridge] followup: <消息前 80 字>
[cc-bridge]   tool call: PowerShell {"command":"..."}
[cc-bridge]   tool result: PowerShell ok
[cc-bridge] turn 1 done ok=true len=12 tools=1
```

**四步分段日志是故意加的** —— 之前 setup 失败时只报了 message，
定位不到卡在哪一步，白费好几轮。

## ⚠️ 不要强杀 dsh-TUI

这一条是**踩过的坑**，而且后果会波及用户正在用的窗口。

### 现象

某个 dsh-tui tab 里，**鼠标一动就往输入框吐 ANSI 符号**，输入没法用。
别的 tab 正常 —— 坏的只有那一个。

### 根因

dsh-TUI 进全屏时往终端写这一串（`mouse-debug.log` 里的实证）：

```
\x1b[?1049h  \x1b[2J \x1b[H  \x1b[?1000h \x1b[?1002h \x1b[?1003h \x1b[?1006h
  备用屏                       按键     拖动     任何移动    SGR编码
```

**撤销序列只在优雅退出时才写出去** —— ink 里挂在 `signal-exit` 的
`onExit` 上（`ink.js` 的 `unmount`）：

```
\x1b[?1006l ?1003l ?1002l ?1000l ?1049l
```

进程被 `Stop-Process -Force` / `taskkill /F` 强杀时，**撤销代码永远不会执行**，
终端就留在鼠标追踪模式里 —— 鼠标一移动，终端往输入流注入
`\x1b[<35;col;rowM` 这类 SGR 序列，看起来就是「输入变成了 ANSI 符号」。

### 两个错误示范

排查期间我用过这几条，**都会误伤**：

```powershell
# ① 按路径模式匹配 —— 用户自己用 run.ps1 开的窗口同样带这个路径，照样被杀
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match '--patch D:\\code\\cc-bridge' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# ② 零过滤 —— 杀全系统所有 claude.exe，包括用户窗口里正在跑的
Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# ③ 「清理残留外壳」—— 看起来无害，其实同样没区分你我
Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'" |
  Where-Object { $_.CommandLine -match 'run\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

① 的问题是**命令行没法区分你我** —— 用户用同一个 `run.ps1` 启动时，
命令行长得**一模一样**。② 更直接，无差别扫射。③ 最能说明问题：
我把它当成「收尾小操作」，结果杀掉了**用户窗口的外壳 pwsh** ——
那个 pwsh 当时正带着一个活着的 dsh（`node` 变成孤儿，窗口勉强还能用）。

> **教训**：判断归属**只能靠 pid 账本**，任何形式的命令行模式匹配都不行。
> 因为「我」和「用户」跑的**是同一份代码、同一个启动脚本**，命令行必然相同。

### 正确做法

用 `launch-test.ps1` 启动（它自动记 PID），用 `kill-mine.ps1` 收尾：

```powershell
.\launch-test.ps1          # 开测试窗口，PID 记进 .test-pids
.\kill-mine.ps1            # 只收这些
```

判定归属靠 **`.test-pids` 里记的 PID**，不靠命令行模式。

### 三条走不通的路（都实测过）

| 方案 | 结果 |
|---|---|
| **按 pid 沿祖先链找窗口 → 发 `WM_CLOSE`** | ❌ **危险**。WT 的**所有 tab 共享同一个 `WindowsTerminal.exe`**，所以会命中**第一个** WT 窗口 —— 也就是**别人的 tab**。实测我的 pid 15600 找到的是用户的「你好」 |
| **`GenerateConsoleCtrlEvent`** | ❌ 在 **ConPTY 下不投递**。`AttachConsole` 成功、事件函数也返回成功，但目标进程纹丝不动（WT 用伪 console，Ctrl 事件不走老路径） |
| **直接强杀** | ⚠️ 能用，但 dsh-tui 来不及写撤销序列，那个 tab 会留在鼠标追踪模式 |

### 最终方案：强杀 + 无条件复位

既然优雅退出三条路都堵死，就**不追求优雅**，改成：

1. 记下目标 pid **及其祖先链上所有 shell**（`pwsh`/`cmd`/`OpenConsole`）
   —— 必须在**杀之前**记，因为 dsh 一死就 attach 不上它的 console 了
2. 强杀
3. **不管怎么死的，都往那个 tab 的 `CONOUT$` 写复位序列**

第 3 步是 `reset-tab.ps1`，它在一个**独立子进程**里 `AttachConsole` 到目标，
然后 `CreateFile("CONOUT$")` + `WriteConsoleW` 写
`\x1b[?1006l ?1003l ?1002l ?1000l ?1049l`。

> 为什么必须独立子进程：`AttachConsole` 之后**调用者自己的 `CONOUT$` 也变了**
> —— 实测直接在脚本里做，脚本自己的输出会跑到目标 console 上，还编码错乱
> 显示成乱码。

实测输出：

```
  结束 pid=37548
  终端模式已复位 ✓
```

### 已经卡住了怎么办

**首选**：从外面远程修（不用碰那个窗口）：

```powershell
# 不知道 pid 就先列候选
pwsh -File reset-tab.ps1 -List

# 然后按 pid 复位（同一个 tab 里的进程共享 console，挑哪个都行）
pwsh -File reset-tab.ps1 -TargetPid 12345
```

`kill-mine.ps1` 收尾时会**自动**做这一步，所以正常流程下不会遇到坏 tab。

**备选**：在**那个坏掉的窗口里**执行：

```powershell
pwsh -File reset-terminal.ps1
```

它往当前终端写撤销序列，把鼠标追踪、焦点上报、括号粘贴、备用屏、
光标显示全部复位。

> `reset-terminal.ps1` 修的是**它自己所在的那个终端** —— 转义序列是写给
> 当前 stdout 的，从别的窗口跑修不到。远程修请用 `reset-tab.ps1`。

**兜底**：关掉那个 tab 重开 —— WT 会重置该 tab 的模式。

> ⚠️ 注意复位序列**只关模式、不清屏**。被强杀后屏幕上残留的 TUI 画面
> （或者已经吐出来的乱码）不会自动消失，`cls` 一下即可。
