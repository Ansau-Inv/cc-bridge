// 把 dsh-TUI 自己的 `/` 斜杠命令**全部摘掉**，让 `/` 一律透传给 claude。
//
// ════════════════════════════════════════════════════════════════════
// 为什么
// ════════════════════════════════════════════════════════════════════
//
// 这个窗口本质上是给 claude 用的 —— dsh-TUI 只是个前端。但 dsh-TUI 有
// 一整套自己的斜杠命令（`/compact`、`/model`、`/help`…共 57 条），
// 而它的命令表**优先于**模型：
//
//     PromptInput.tryRunCommand()  (PromptInput.js:1324)
//       const command = channel.commandList.find(e => e.name === parsed.name)
//       const known = command !== undefined || isHiddenCommandName(parsed.name)
//       if (!known) return false          // ← 只有这一步才轮到模型
//
// 于是 `/compact` 会被 dsh-TUI 截胡（走它自己的压缩实现），根本到不了
// claude 那边。而 claude 自己也有一套同名命令，还能用 `/xxx` 触发它的
// 插件与技能命令（`/code-review`、`/simplify`…）。
//
// 目标：**表外的才透传** → 改成**全部透传**。
//
// ════════════════════════════════════════════════════════════════════
// 怎么摘 —— 清空内容，不是替换数组
// ════════════════════════════════════════════════════════════════════
//
// 关键是**引用关系**：
//
//     channel.js:426         commandList: LOCAL_COMMANDS          ← 存引用
//     skill-catalog.js:32    const merged = [...LOCAL_COMMANDS]   ← 复制内容
//     skill-catalog.js:48    deps.setCommands(merged)
//     channel.js:541         setCommands(c) { state.commandList = c }
//
// 两处都只在**用的时候**读内容，所以**清空数组内容**对它们都生效 ——
// 而且**与时机无关**：不管 channel 是在我们之前还是之后创建的，
// `state.commandList` 指向的都是同一个数组对象。
//
// 这就是为什么用 `splice` 而不是 `state.commandList = []`：
// 后者只影响那一刻的引用，下一次 `refreshCommands()` 又会
// `[...LOCAL_COMMANDS]` 把命令全捞回来。
//
// `export const LOCAL_COMMANDS` 的绑定不可重赋值，但**数组内容可以改** ——
// 和本项目改主题/立绘/大字是同一套办法。
//
// ════════════════════════════════════════════════════════════════════
// 外部命令（DSH 注册的）**不动**
// ════════════════════════════════════════════════════════════════════
//
// `refreshCommands()` 合成的列表里除了本地命令，还有 `commandService.list()`
// 注册的**外部命令** —— 插件与 skill（plan / goal / 以及各 skill）。
// 那些走的是另一条路（`external: true`），**不经过 LOCAL_COMMANDS**，
// 所以我们清空源头不会碰到它们。
//
// 这是对的：`/plan`、`/goal` 这类是 DSH 侧的能力，claude 那边没有对应物，
// 留着才有用。
//
// ════════════════════════════════════════════════════════════════════
// 还有一道闸门：hidden 命令
// ════════════════════════════════════════════════════════════════════
//
// `isHiddenCommandName()` 查的是另一个表（`HIDDEN_COMMANDS` / 配套的
// `HIDDEN_COMMAND_NAMES` Set，里面是 `/deepseek` 那个彩蛋）。它在
// `tryRunCommand` 里和 commandList 是**或**的关系：
//
//     const known = command !== undefined || isHiddenCommandName(parsed.name)
//
// 所以两张表都要清，否则 `/deepseek` 仍会被 TUI 吃掉。
//
// ════════════════════════════════════════════════════════════════════
// 摘掉之后还能退出吗
// ════════════════════════════════════════════════════════════════════
//
// **能。** 退出/中断走的是**硬编码快捷键**，不经过命令表
// （`keymap.js:280` 的 NON_REMAPPABLE）：
//
//     Ctrl+D   空输入时退出
//     Ctrl+C   中断 / 清空
//     Esc      选择器 / 中断 / 双击 rewind
//
// 所以 `/exit`、`/quit`、`/q` 没了不影响关窗口。
//
// ════════════════════════════════════════════════════════════════════
// 代价（有意的）
// ════════════════════════════════════════════════════════════════════
//
// `/new`、`/resume`、`/theme`、`/model`、`/cost`、`/status`、`/compact`…
// 这些 dsh-TUI 功能都**用不了了**，因为同名输入会发给 claude。
//
// 想找回来的话两条路：
//   · 关掉本模块（`cordis.patch.yml` 里 `slashPassthrough: false`）
//   · 或者把那几条加进下面的 `KEEP` 白名单

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tuiPackageRoots, tuiRootTag } from './tui-roots.mjs'

/**
 * 保留给 dsh-TUI 自己的命令名（不摘）。
 *
 * 目前**为空** —— 立场是这个窗口给 claude 用，`/` 全透传。
 *
 * 要放回来几条就写在这里。几个候选及理由：
 *   · `theme` / `lang`  纯前端显示，claude 那边没有对应能力
 *   · `exit`            虽然 Ctrl+D 也能退，但有人习惯打命令
 *   · `migrate`         导入别的 agent 的历史会话，与 claude 无关
 */
const KEEP = new Set([])

/** 从数组里按名字删（倒着走，避免索引偏移），返回删掉几条。 */
function dropFrom(arr, keep) {
  if (!Array.isArray(arr)) return 0
  let n = 0
  for (let i = arr.length - 1; i >= 0; i--) {
    if (keep.has(arr[i]?.name)) continue
    arr.splice(i, 1)
    n++
  }
  return n
}

/**
 * 摘掉 dsh-TUI 的本地斜杠命令。
 *
 * 幂等：重复调用不会重复计数（第二次已经空了）。
 *
 * @param log 日志函数
 * @returns `{ ok, roots: [{ tag, local, hidden }] }`
 */
export async function installSlashPassthrough(log = () => {}) {
  const roots = []

  for (const root of tuiPackageRoots()) {
    const tag = tuiRootTag(root)
    const rec = { tag, local: 0, hidden: 0, kept: 0 }
    try {
      const cmdPath = join(root, 'lib', 'types', 'commands.js')
      if (!existsSync(cmdPath)) { rec.error = 'commands.js 不存在'; roots.push(rec); continue }
      const mod = await import(pathToFileURL(cmdPath).href)

      // ── ① 本地命令表（`commandList` 和 `isLocalCommandName` 都读它）──
      const local = mod.LOCAL_COMMANDS
      if (!Array.isArray(local)) {
        rec.error = 'LOCAL_COMMANDS 不是数组'
      } else {
        rec.kept = local.filter((c) => KEEP.has(c?.name)).length
        rec.local = dropFrom(local, KEEP)
      }

      // ── ② hidden 命令（`isHiddenCommandName` 读它，是"或"的另一边）──
      //
      // 两张表 + 一个 Set，三个都要清：
      //   HIDDEN_COMMANDS       供 UI/调试列出
      //   HIDDEN_COMMAND_NAMES  `isHiddenCommandName` 直接查它
      rec.hidden = dropFrom(mod.HIDDEN_COMMANDS, KEEP)
      const names = mod.HIDDEN_COMMAND_NAMES
      if (names && typeof names.delete === 'function') {
        for (const n of [...names]) {
          if (KEEP.has(n)) continue
          names.delete(n)
          if (!mod.HIDDEN_COMMANDS?.some?.((c) => c?.name === n)) rec.hidden++
        }
      }

      roots.push(rec)
    } catch (err) {
      rec.error = String(err?.message ?? err)
      roots.push(rec)
    }
  }

  const ok = roots.some((r) => !r.error)
  for (const r of roots) {
    if (r.error) log(`  · 斜杠透传 [${r.tag}] 失败：${r.error}`)
    else log(`  · 斜杠透传 [${r.tag}]：摘掉本地命令 ${r.local} 条、hidden ${r.hidden} 条` +
      (r.kept ? `，保留 ${r.kept} 条` : '') + ` → / 全部透传给 claude`)
  }
  return { ok, roots }
}
