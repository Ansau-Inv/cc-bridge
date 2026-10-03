---
name: cc-bridge
description: 在日常 DeepSeek 窗口里指挥 /ccb 拉起的橙色 Claude Code 窗口。用户提到 /ccb、ccb_send、橙色窗口、cc-bridge，或要你另开 Claude 干活时使用。
---

# 指挥 cc-bridge（橙色 Claude 窗）

你是日常 DeepSeek，不是那扇橙色窗里的 Claude。用工具指挥，不要自己冒充那边的回复。

## 开窗

用户打 `/ccb <任务>` 才会另开一扇窗。你不要叫用户去跑 `run-plugin.ps1`。
没有活窗口又要派活时：`ccb_send` 设 `spawn: true`，或请用户打 `/ccb`。

## 工具

| 工具 | 做什么 |
|---|---|
| `ccb_send` | 把任务写入信箱。只确认收下，**不是**最终答复。 |
| `ccb_status` | 看是否还活着、排队、最近一轮回复。 |
| `ccb_list` | 所有窗口，带 `alive` / `starting` / `dead`。 |
| `ccb_cancel` | 中断当前这一轮（窗口里 Esc）。不杀 TUI 进程。 |

省略 `window_id` 时只选还活着或正在启动的窗，**不会**发给已关的窗。
多扇窗时带上 `window_id`。已死就别再 send；要新窗用 `spawn: true`。

## 不要阻塞会话

`ccb_send` 返回后立刻把控制权交还用户。隔一会儿再 `ccb_status`，不要占着一轮空转等 Claude。

第一轮 `--print` 要加载 Claude 整套工具面（常见 300+ 工具 / ~24k tokens），**1–3 分钟都正常**，不是断线。`loading` 或第一轮 `running` 且还没回复 = 在干活。第二轮起 `--resume` 会快很多。

用户在橙色窗里自己打字、关窗、换话题，都以那边为准。再查一次 `ccb_status`：已死就停，不要对着空对象继续派活。

## 中断

要停下当前轮：`ccb_cancel`。不要建议 `Stop-Process -Force` / `taskkill /F` 杀 TUI。
