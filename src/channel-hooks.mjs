// 拿到 dsh-TUI 的 **live Channel 对象**，用来做官方 UI 没暴露的几件事：
//
//   ① `/clear` 后归零 ctx 用量条
//   ② `/clear` 后清空对话区
//   ③ 让 `/` 补全菜单彻底空掉
//
// ════════════════════════════════════════════════════════════════════
// ⚠️⚠️ 血的教训：不要 import dsh-tui 的内部模块 ⚠️⚠️
// ════════════════════════════════════════════════════════════════════
//
// 本模块最初从三份 dsh-tui 副本各 `import()` 一次
// `dsh-adapter/host-access.js`（为了拿 `compositionRoot`），结果把启动搞崩：
//
//     TypeError: Cannot redefine property: execute
//         at Object.defineProperty (<anonymous>)
//         at Fiber.value (dsh-adapter/host-access.js:250)
//
// 原因：`host-access.js` **顶层**就调 `installGlobalFiberInstrumentation()`
// （第 34 行），而那个函数做两件危险的事：
//
//     Object.defineProperty(Fiber.prototype, '_execute', {...})   // 改共享的类
//     Object.defineProperty(runner, 'execute', {
//       configurable: false,          // ← 不可重定义
//     })
//
// 它的防重复守卫是**模块级** `WeakSet`（`wrappedRunners`）—— 每份副本一个。
// 于是从第二份副本 import 时，新副本的 WeakSet 是空的，它再次尝试
// `defineProperty(runner, 'execute')`，而那个属性已经被第一份设成
// `configurable: false` → **抛错**。
//
// 更隐蔽的是：`Fiber` 类来自 `@deepseek-ai/cordis`，**三份副本共享同一个类**
// （同一个 node_modules 解析结果），所以这不是"各改各的"，而是真的重复改同一个对象。
//
// **结论：绝不 import `host-access.js`。** Channel 本体靠 preload 改写拿。
// `read-view.js` 只导出纯函数、没有顶层副作用，可以按路径加载，用来标脏。
//
// ════════════════════════════════════════════════════════════════════
// 那 Channel 到底怎么拿
// ════════════════════════════════════════════════════════════════════
//
// 靠 `preload.mjs` 的模块加载钩子，把 `registerTuiChannel` 的入口改成
// "顺手往 `globalThis.__ccBridgeChannels` 里 push 一份"。
//
// 这是**唯一**可行的路径：Channel 是 dsh-tui 的闭包私有对象，官方
// `getRegisteredTuiChannel(ctx)` 按 composition root 查 WeakMap，我们
// 拿不到匹配的键（实测三种键都不行，订阅也从不触发）。
//
// 而源码改写不 import 任何东西、不产生副作用 —— 它只在 Node 加载那个
// 文件时把源码文本换掉。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tuiPackageRoots } from './tui-roots.mjs'

/** 所有已捕获的 live Channel（每个 dsh-tui 副本一个）。 */
const channels = []

/**
 * 各份 dsh-tui 的 `markChannelReadDirty`。
 *
 * `/clear` 和队友快照都是原地改 `state.rows`。读投影用 WeakMap 记脏版本，
 * 「长度相同且未标脏」会直接复用上一帧冻结快照（read-view.js）。
 * 官方 `resetSessionProjection` / `syncRows` 改完都调这个。
 *
 * 不 import `host-access.js`（那个文件顶层有副作用）。`read-view.js` 只导出
 * 纯函数，三份都调一遍 —— 渲染用的是其中特定一份。
 */
const dirtyMarkers = []

/** 是否已经装过（幂等）。 */
let installed = false

/**
 * 返回所有已捕获的 Channel —— **数组**，因为系统里有三份 dsh-tui。
 *
 * 跟 `subagentStores()` 同样的教训：只留最后一个的话，很可能拿到的是
 * 没在渲染的那一份，改了界面纹丝不动。
 */
export function liveChannels() {
  return channels
}

/**
 * 找"当前活跃"的那个 Channel。
 *
 * 判据是 `rows.length` 最大的那个 —— 刚启动的会话至少有一条 splash/notice
 * 行，而没挂载的副本从没被 emit 过。比"取第一个/最后一个"可靠。
 */
export function activeChannel() {
  let best
  for (const c of channels) {
    if (!Array.isArray(c?.rows)) continue
    if (best === undefined || c.rows.length > best.rows.length) best = c
  }
  return best
}

/**
 * 装上捕获（幂等）。
 *
 * **不 import `host-access.js`**（见文件头的教训）。`read-view.js` 只导出
 * 纯函数，可以按路径加载，用来标脏读投影。Channel 本体仍只靠 preload
 * 填好的全局数组轮询。
 */
export async function installChannelCapture(ctx, log = () => {}) {
  if (installed) return { ok: true, already: true }
  installed = true

  const roots = tuiPackageRoots()
  for (const root of roots) {
    const p = join(root, 'lib', 'types', 'adapter', 'channel', 'read-view.js')
    if (!existsSync(p)) continue
    try {
      const mod = await import(pathToFileURL(p).href)
      if (typeof mod.markChannelReadDirty === 'function'
          && !dirtyMarkers.includes(mod.markChannelReadDirty)) {
        dirtyMarkers.push(mod.markChannelReadDirty)
      }
    } catch { /* 这份没有或加载失败：标脏退化，见 markLiveDirty */ }
  }

  // ── 轮询全局数组 ────────────────────────────────────────────────
  //
  // 为什么用轮询而不是订阅：`preload` 的改写让 `registerTuiChannel`
  // 直接 push 到一个全局数组，我们只能"读它"，没有回调可挂。
  // dsh-tui 建 Channel 在插件加载之后，所以要等一会儿。
  //
  // 100ms × 150 = 15 秒，足够 dsh-tui 启动（实测 40 秒内一定好了，
  // 但那是整个 TUI 起来；Channel 注册远早于此）。
  let polls = 0
  const poll = setInterval(() => {
    polls++
    harvest(log)
    if (channels.length > 0 || polls > 150) {
      clearInterval(poll)
      if (channels.length === 0) {
        log('  · 没等到 live Channel —— /clear 归零、清屏会失效')
        log('    （多半是 preload 的 registerTuiChannel 改写没生效，')
        log('      看日志里有没有「运行时改写」那几行）')
      }
    }
  }, 100)
  harvest(log)   // 万一已经注册了

  log(`  · Channel 捕获已启用（等 registerTuiChannel 被调用）`)
  return { ok: true, roots: roots.length }
}

/** 标脏读投影。优先走官方 WeakMap；拿不到就 bump 一个本地计数，至少让 emit 有变化。 */
function markLiveDirty(ch, extra) {
  const targets = []
  if (Array.isArray(ch?.rows)) targets.push(ch.rows)
  if (extra) {
    for (const v of extra) {
      if (v && typeof v === 'object') targets.push(v)
    }
  }
  if (dirtyMarkers.length > 0) {
    for (const value of targets) {
      for (const mark of dirtyMarkers) {
        try { mark(value) } catch { /* 这份实例对不上这个对象 */ }
      }
    }
    return
  }
  if (ch && typeof ch === 'object') {
    ch.__ccBridgeDirty = (ch.__ccBridgeDirty ?? 0) + 1
  }
}

/** 把 `globalThis.__ccBridgeChannels` 里的 Channel 收进来。 */
function harvest(log) {
  const g = globalThis.__ccBridgeChannels
  if (!Array.isArray(g)) return
  for (const ch of g) {
    if (ch === undefined || ch === null) continue
    if (channels.includes(ch)) continue
    channels.push(ch)
    log(`  · 捕获到 live Channel（共 ${channels.length} 个）`)
  }
}

/**
 * 把某个队友的 store 状态**镜像**进 UI 快照 —— 自己实现一遍 `syncNow()`。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么需要（绕了一大圈才明白）
 * ════════════════════════════════════════════════════════════════════
 *
 * dsh-TUI 的数据流是**两级**的：
 *
 *     store（真相）──syncNow()──▶ state.subagents（快照）──▶ UI
 *
 * 我原以为"改 store 再触发 syncNow"就行，办法是发一条无害的
 * `request/context` 事件。**那条路根本走不通** —— `subagent-projection.js:193`：
 *
 *     const onSessionEvent = (session, event) => {
 *       let id = store.getSubagentIdBySession(session);
 *       if (id === undefined) return false;   // ← 在这就返回了
 *       ...
 *       syncNow();                            // ← 永远走不到
 *     }
 *
 * 它要求这个 session 能关联到某个队友 —— 而 **claude 的队友没有 DSH
 * 子会话**（那正是本项目要桥接的东西），所以永远匹配不上。
 *
 * 表现是最迷惑的那种：**store 里的值确实改了**（读回验证能过），
 * 界面纹丝不动。
 *
 * ── 解法：自己镜像 ──────────────────────────────────────────────────
 *
 * 既然已经拿到 Channel（= `state`，靠 preload 的源码改写），就照着
 * `syncNow()` / `syncRows()` 的做法把要显示的字段抄进去。
 *
 * ⚠️ **要写两个地方**，它们是不同的对象：
 *   ① `state.subagents[i]`           —— 队友面板（Ctrl+A）读这个
 *   ② `state.rows[i].subagent`       —— 对话流里的内联卡片读这个
 *
 * `syncRows()` 里是 `row.subagent = view`（**新建**的 view，不是 ① 的
 * 元素引用），所以只改一处的话另一边还是旧值。
 *
 * @param taskId 队友 id
 * @param storeState store 里的那条 state（`st.states.get(taskId)`）
 * @param patch 额外的直接覆盖（优先级最低，字段会再被 storeState 覆盖）
 * @returns 改到了几处
 */
export function mirrorSubagent(taskId, storeState, patch = {}) {
  const ch = activeChannel()
  if (ch === undefined) return 0
  if (storeState === undefined || storeState === null) {
    // 没有 store 状态时退化成"只打补丁"
    return patchSubagentSnapshot(taskId, patch)
  }

  // 按 syncNow → snapshot() 的语义导出显示字段
  const output = Array.isArray(storeState.output) ? storeState.output : []
  const toolCalls = Array.isArray(storeState.toolCalls)
    ? storeState.toolCalls.map((t) => ({ ...t }))
    : []
  const view = {
    ...patch,
    agentId: storeState.agentId ?? taskId,
    runId: storeState.runId,
    description: storeState.description,
    provider: storeState.provider,
    model: storeState.model || 'default',
    effort: storeState.effort,
    status: storeState.status,
    startedAt: storeState.startedAt,
    completedAt: storeState.completedAt,
    durationMs: storeState.completedAt
      ? storeState.completedAt - storeState.startedAt
      : Date.now() - (storeState.startedAt ?? Date.now()),
    // `outputLines` 是内联卡片显示的那几行（syncRows 只取最后 3 条）
    outputLines: output.slice(-3),
    toolCalls,
    tokens: storeState.tokens,
    summary: storeState.summary,
    stopReason: storeState.stopReason,
    error: storeState.error,
  }

  let hits = 0

  // ① `state.subagents` —— 面板读它（完整 output，不是 -3）
  if (Array.isArray(ch.subagents)) {
    for (const sub of ch.subagents) {
      if (sub?.agentId !== taskId) continue
      Object.assign(sub, view, {
        output: [...output],
        outputEvents: Array.isArray(storeState.outputEvents)
          ? [...storeState.outputEvents] : [],
      })
      hits++
    }
  }

  // ② `state.rows[].subagent` —— 内联卡片读它
  if (Array.isArray(ch.rows)) {
    for (const row of ch.rows) {
      const sub = row?.subagent
      if (!sub || sub.agentId !== taskId) continue
      Object.assign(sub, view)
      hits++
    }
  }

  if (hits > 0) {
    markLiveDirty(ch, Array.isArray(ch.rows) ? ch.rows.filter((r) => r?.subagent?.agentId === taskId) : [])
    try { ch.emit?.() } catch { /* ignore */ }
  }
  return hits
}

/**
 * 直接改 **UI 真正读的那个快照** —— 不需要 store 状态时的简化版。
 *
 * @param agentId 队友 id
 * @param patch   要合并进那一项的字段
 * @returns 是否找到并改了
 */
export function patchSubagentSnapshot(agentId, patch) {
  const ch = activeChannel()
  if (ch === undefined) return 0
  let hits = 0

  // ① `state.subagents` —— 队友**面板**（Ctrl+A）读这个
  if (Array.isArray(ch.subagents)) {
    for (const sub of ch.subagents) {
      if (sub?.agentId !== agentId) continue
      Object.assign(sub, patch)
      hits++
    }
  }

  // ② `state.rows[].subagent` —— 对话流里的**内联卡片**读这个
  //
  // ⚠️ 这是**另一个对象**，不是 ① 里那些元素的引用。`syncRows()` 里：
  //
  //     const view = { agentId: sub.agentId, model: sub.model || 'default', ... }
  //     row.subagent = view
  //
  // 它从快照**重建**了一个 view。所以只改 ① 的话，面板对了但内联卡片
  // 还是旧值（反之亦然）—— 两边都要改。
  if (Array.isArray(ch.rows)) {
    for (const row of ch.rows) {
      const sub = row?.subagent
      if (!sub || sub.agentId !== agentId) continue
      Object.assign(sub, patch)
      hits++
    }
  }

  if (hits > 0) {
    markLiveDirty(ch, Array.isArray(ch.rows) ? ch.rows.filter((r) => r?.subagent?.agentId === agentId) : [])
    try { ch.emit?.() } catch { /* ignore */ }
  }
  return hits
}

/**
 * 让 `/` 补全菜单彻底空掉。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么清空 LOCAL_COMMANDS 不够
 * ════════════════════════════════════════════════════════════════════
 *
 * 菜单的数据源是（command-completions.js:21）：
 *
 *     return completeCommands(input, state.commandList, path => {...})
 *
 * 而 `state.commandList` 里除了本地命令，还有 **DSH 注册的外部命令**
 * （插件 / skill，`external: true`）。那些不经过 `LOCAL_COMMANDS`，
 * 所以 `slash-passthrough.mjs` 清空源头碰不到它们 —— 输 `/` 仍会
 * 列出 `/plan`、`/goal`、各种 skill。
 *
 * ── 为什么用访问器而不是清一次内容 ──────────────────────────────────
 *
 * 清内容不够：`refreshCommands()` 会 `setCommands(merged)`，那是
 * `state.commandList = commands` —— **换掉整个数组引用**，我们清过的
 * 那个就没人引用了。
 *
 * 定义成"读永远是空数组、写被丢弃"的访问器，就对 refresh 免疫了。
 * `state` 是普通对象字面量（没被 freeze），`commandList` 是普通数据属性
 * （`configurable` 默认为真），所以能重新定义。
 *
 * ⚠️ 副作用：`Chat.js` 用 `commandList` 判断 `/permission`、`/plan`
 *    这些外部命令**是否挂载**。列表恒空会让那两个分支走"未挂载"路径。
 *    对纯 claude 用途无影响。
 */
export function suppressCommandList(ch) {
  const target = ch ?? activeChannel()
  if (target === undefined) return false
  try {
    let empty = []
    Object.defineProperty(target, 'commandList', {
      configurable: true,
      enumerable: true,
      get() { return empty },
      set(_ignored) { empty = [] },   // refreshCommands 的写入被吞掉
    })
    return true
  } catch {
    return false
  }
}

/**
 * 把会话状态重置成"新会话" —— `/clear` 的核心。
 *
 * 字段清单对齐官方的 `channel/session-reset.js: resetSessionProjection()`，
 * 但有两处**故意不同**：
 *
 *   ① `lastUsage` 设成**零值**而不是 `undefined`
 *
 *      官方设 `undefined`，因为那是"换了个会话、还不知道用量"。
 *      但 StatusLine 里 `usage === undefined` 会让整个 ctx 字段**消失**
 *      （`formattedContext === undefined → ctxNode = undefined`）。
 *      而 `/clear` 的期望是**看到它归零**，所以给零值：
 *      `formatContextUsage(0, 256000)` → `0.0% (0/256k)`。
 *
 *   ② 不清 `sessionTitle` / `sessionColor`
 *
 *      官方清是因为真的换了会话。`/clear` 是同一个窗口重开一段对话，
 *      标题留着更符合直觉。
 *
 * ⚠️ 抄不了的 4 个内部闭包：`resetProjector()`、`rowIds`、
 *    `resetSubagents()`、`resetJobs()` —— 不是 state 上的字段，够不到。
 *    影响可控：下一次 `turn/start` 会重开 step，投影自然重新铺。
 */
export function resetSessionState() {
  const ch = activeChannel()
  if (ch === undefined) return false
  try {
    // ── 对话区 ────────────────────────────────────────────────────
    //
    // **原地**清空，不能 `ch.rows = []` —— PromptInput 上有条注释专门讲
    // 这个坑："rows is a live in-place array on the channel (no new
    // reference per update)"。换引用的话，组件里已持有的旧数组仍指向旧内容。
    if (Array.isArray(ch.rows)) {
      ch.rows.length = 0
      // 补一条提示，否则纯空白看着像卡住
      ch.rows.push({ id: 0, kind: 'notice', text: '已清空上下文（下一个问题开新的 claude 会话）' })
    }

    // ── 用量与上下文 ──────────────────────────────────────────────
    // ctx 条 = lastUsage.input + cacheRead + cacheWrite（StatusLine.js:96）
    ch.lastUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    ch.contextSegments = { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }
    ch.tokens = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      peak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      idle: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }
    ch.mainCost = {}
    ch.subagentCost = []
    ch.tps = undefined
    ch.tpsSamples = []

    // ── 运行态 ────────────────────────────────────────────────────
    ch.responseChars = 0
    ch.activeToolCount = 0
    ch.lastUserText = ''
    ch.working = false
    ch.compaction = undefined
    ch.cancelPending = false
    ch.spinnerMode = 'requesting'
    ch.todos = []
    ch.pending = []
    // 对齐官方 reset：goal 跟会话内容走。标题/颜色故意留着（见上方 ②）。
    ch.goal = undefined

    markLiveDirty(ch)
    ch.emit?.()
    return true
  } catch {
    return false
  }
}
