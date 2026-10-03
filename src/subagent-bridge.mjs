// 把 claude 的「队友」（子代理）接进 dsh-TUI 的队友面板。
//
// ════════════════════════════════════════════════════════════════════
// 背景：dsh-TUI 有一套完整的队友 UI，但它是为 DSH 自己的子代理设计的
// ════════════════════════════════════════════════════════════════════
//
//   `Ctrl+A`  队友面板（清单 + 状态 + 耗时 + tokens + 工具数）
//   `Enter`   队友详情（摘要 / 输出 / 工具 三页）
//
// 它消费的是 `subagent/start` / `subagent/end` 事件 + **子会话的**
// `session/event`。而 claude 的队友是它**进程内部**的东西 —— 不转发就
// 完全不可见，转发了也只是"半可见"（见下面「能做到什么程度」）。
//
// ════════════════════════════════════════════════════════════════════
// 数据从哪来
// ════════════════════════════════════════════════════════════════════
//
// 靠 claude 的 `--forward-subagent-text` 开关（`runClaude` 里加的），
// 它让队友的活动进入同一条 stdout 事件流：
//
//   system/task_started      队友诞生：task_id、description、prompt
//   system/task_progress     实时进度：total_tokens、tool_uses、duration_ms
//   system/task_updated      终态：status、end_time（**不含** summary）
//   system/task_notification 终态：status、summary、usage（**信息完整**）
//   带 parent_tool_use_id 的 assistant/user 消息 = 队友自己的对话
//
// ════════════════════════════════════════════════════════════════════
// 两个踩过的坑
// ════════════════════════════════════════════════════════════════════
//
// ① **`subagent/start` 必须排在 `tool/call` 之后发**
//
//    dsh-TUI 的 `onStart` 里描述是这么取的：
//        description: pendingTaskDescriptions.shift()
//    而这个队列**只从 `tool/call` 的 arguments 里抽**，不读 payload 里的
//    description。可事件到达顺序是反的 —— `task_started` 同步处理，而带
//    Agent 工具调用的 assistant 消息走异步保序链。直接发的话队列还空着，
//    界面显示成占位值 `claude-code task`。
//    → 解法：`runClaude` 把这个回调排进保序链（见那边的调用点）。
//
// ② **终态会连着来两条，别让先到的赢**
//
//    `task_updated` 只有状态，`task_notification` 才有 summary。而
//    dsh-TUI 的落定是**幂等**的（`store.finish` 见到已落定就 return），
//    谁先到谁说了算 —— 先发 `task_updated` 的话，详情页「摘要」永远是
//    「暂无摘要」。
//    → 解法：`task_updated` 只登记，等 notification 来了一起发；配个
//      兜底定时器防 notification 不来（非后台任务等情形）。
//
// ③ **队友的所有回调都必须排在同一条保序链上**
//
//    这是个隐蔽的竞态：`task_started` 的 start 回调排在 `runClaude` 的
//    保序链上（因为它要让 `tool/call` 先落地），而转发来的队友消息如果
//    同步处理，就会**抢在队友行建立之前**到达 —— 那时 `byToolUse` 里还
//    没有映射，队友说的话**直接被丢掉**，「输出」页一片空白。
//    → 解法：`message` / `chunk` / `toolResult` / `progress` 全部排队。
//
// ④ **光改 store，界面不会动**（最反直觉的一个）
//
//    见下面「单向快照」那段。必须额外发一个事件触发 `syncNow()`。
//
// ════════════════════════════════════════════════════════════════════
// 为什么不用「影子会话」这个正道解法
// ════════════════════════════════════════════════════════════════════
//
// 理论上更干净的做法是给每个队友造一个**影子 DSH 会话**：
//
//     sessions.create(taskId) → 造个轻量 Agent → agents.register()
//
// 这样 `lookupChild(info.id)` 能查到、`linkSession` 能接上，dsh-TUI 全套
// 机制（输出页、工具页、费用并入、tail -f）**自动生效**，一行非官方
// hack 都不需要。
//
// **但代价是 `ctx.agents` 里多出一批非真实 Agent** —— 它们不是真的能跑
// 回合的 agent，却会出现在 `/agents`、可能参与路由与会话切换的判定。
// 为了几个展示字段去污染核心注册表，风险收益不成比例，所以没走。
//
// 现在的做法是：**只在展示层补数据**，注册表保持干净。副作用是那几个
// 字段依赖 dsh-TUI 的内部实现（见下面的脆弱点清单）。
//
// ════════════════════════════════════════════════════════════════════
// 能做到什么程度
// ════════════════════════════════════════════════════════════════════
//
// 全部打通了（三页都有真实内容）：
//   ✓ 面板：真实描述、状态、耗时、**tokens**、**工具数**、运行中/已完成计数
//   ✓ 详情「摘要」：队友的完整产出（markdown 渲染）
//   ✓ 详情「输出」：逐条对话（文本/思考/工具行 + `── 结论 ──` 分隔）
//   ✓ 详情「工具」：**真实工具名 + 参数 + JSON 语法高亮**
//
// ── 打通的代价：两条**非官方**路径 ──────────────────────────────────
//
// dsh-TUI 的正道是「子会话事件流」：队友得是个真 DSH Agent，它的
// `session/event` 经 `sessionToAgent` 路由进 store。claude 的队友不是
// DSH Agent（`agents.get(taskId)` 查不到），那条路走不通。于是用了：
//
//   ① **prototype 钩子**拿 store 实例（见下）
//   ② **直接调 store 的公开方法**写数据，再发一个无害的
//      `request/context` 事件触发 `syncNow()` 把快照刷进 `state.subagents`
//
// ② 里那个"触发"是必需的，也是最反直觉的一环：dsh-TUI 的数据流是
// **单向快照**，不是响应式绑定 ——
//
//     const syncNow = () => { state.subagents = store.snapshot() }   // UI 读 state
//
// 而 `syncNow()` **只在 dsh-TUI 自己的事件处理器里被调用**，全库没有任何
// `store.subscribe(...)`，`store.notify()` 的监听者列表始终是空的。
// 所以往 store 里写数据等于写进了一个 UI 看不见的抽屉（踩过：tokens
// 一直显示 `--`，界面纹丝不动）。
//
// ── 这些非官方路径的脆弱点 ──────────────────────────────────────────
//
// 下面每一条都是 dsh-TUI 的内部实现细节，升级时**必须重验**：
//   · `SubagentActivityStore` 的类名与所在模块路径
//   · `onSpawned` 是 prototype 方法（而不是实例字段）
//   · `states` 是 `Map`，键是队友 id
//   · `appendOutput(agentId, text, kind)` / `recordTool` / `setTokens` 签名
//   · `syncNow` 会被 `session/event` 触发
//   · `subagent/start` 的 `description` 取自 `tool/call` 的 arguments 队列
//
// 好在**失败是静默降级**的：钩子装不上、方法名变了，都只是面板少几个
// 字段，不影响主对话。`check-upgrade.ps1` 里那套契约测试就是干这个的。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tuiPackageRoots, tuiRootTag } from './tui-roots.mjs'

/** 捕获到的所有 store 实例。
 *
 * ⚠️ 必须是**数组**，不能只留一个。系统里有**三份** dsh-tui 实例
 * （npm 全局 / profile / profile-safe），各自模块独立，于是会有三个
 * `SubagentActivityStore` 实例。而面板渲染用的是其中**特定一份** ——
 * 只留最后一个的话，很可能补到了另一份上，界面纹丝不动（踩过：
 * tokens 一直是 `--`）。
 */
const capturedStores = []

/**
 * 捕获 dsh-TUI 的 `SubagentActivityStore` 实例。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────
 *
 * tokens / 工具数 / 逐条输出只有 store 内部有，而那个实例**没有暴露在
 * ctx 上** —— 它是 `createSubagentProjection` 的闭包局部变量。
 *
 * ── 怎么拿 ──────────────────────────────────────────────────────────
 *
 * 和本项目改主题/立绘/大字同一套办法：**在 prototype 上挂钩子**。
 *
 *   · `states` / `sessionToAgent` 是**实例字段**（class field）
 *   · 而 `onSpawned` / `setTokens` / `recordTool` 等方法在 **prototype** 上
 *
 * 所以只要包一层 `onSpawned`（每个 store 实例建立队友行时必调），就能在
 * 第一次调用时把 `this` 留下来 —— 那就是 store 实例本身。
 *
 * 全程不碰 dsh-TUI 的包文件，只改**本进程内存里**的 prototype。
 */
export async function installSubagentBridge(log = () => {}) {
  let hooked = 0
  for (const root of tuiPackageRoots()) {
    try {
      const p = join(root, 'lib', 'types', 'dsh-adapter', 'subagents.js')
      if (!existsSync(p)) continue
      const mod = await import(pathToFileURL(p).href)
      const Cls = mod.SubagentActivityStore
      if (typeof Cls !== 'function' || !Cls.prototype) continue
      const proto = Cls.prototype
      if (proto.__ccBridgeHooked) continue
      const orig = proto.onSpawned
      if (typeof orig !== 'function') continue

      proto.onSpawned = function (...args) {
        // 第一次被调用时把 this 留下 —— 这就是 store 实例
        if (!capturedStores.includes(this)) capturedStores.push(this)
        return orig.apply(this, args)
      }
      proto.__ccBridgeHooked = true
      hooked++
      log(`  · 队友 store 钩子已装：${tuiRootTag(root)}`)
    } catch (err) {
      log('  队友 store 钩子失败：' + (err?.message ?? err))
    }
  }
  // 实例要等 onSpawned 真被调用才有，所以这里返回 0 个是正常的
  return { ok: hooked > 0, hooked, stores: capturedStores.length }
}

/** 读已捕获的 store 列表（还没被调用过就是空数组）。 */
export function subagentStores() {
  return capturedStores
}

/**
 * 找出**所有持有**这个队友行的 store。
 *
 * ⚠️ 必须返回**数组**，不能只返回第一个。踩过两次：
 *
 *   ① 一开始只留最后捕获的一份 → 补丁打在没在渲染的那份上，界面不动
 *   ② 改成"返回第一个持有者" → 仍然错，因为**多份 store 可能都持有**同一行
 *      （`subagent/start` 是广播式的，各副本的 projection 都建了行）。
 *      实测：日志显示 patch 成功，但面板仍显示旧值 + `-- tok · 0 tools`
 *      —— 因为渲染用的是另一位。
 *
 * 所以：**谁持有就补谁**，全都补一遍，总有一份是渲染用的。
 */
export function subagentStoresHolding(taskId) {
  const out = []
  for (const st of capturedStores) {
    try {
      if (st.states?.has?.(taskId)) out.push(st)
    } catch { /* ignore */ }
  }
  return out
}

/**
 * 找出**持有**这个队友行的那一份 store，并返回它。
 *
 * 单个版本 —— 只读字段（比如诊断）用它就够了；**要改数据时请用
 * `subagentStoresHolding()` 全补**，见上面的说明。
 */
export function subagentStoreHolding(taskId) {
  return subagentStoresHolding(taskId)[0] ?? null
}
