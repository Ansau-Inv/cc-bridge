/**
 * cc-bridge —— 两条模式，默认互不抢。
 *
 * ## host（日常 DSH / 网页 / `dsh --profile dsh-tui`）
 *
 * DeepSeek 继续当主 Agent。本插件只挂：
 *   · `/ccb <任务>` —— 另开一扇独立终端，跑完整 cc-bridge 窗口
 *   · `ccb_send` / `ccb_status` / `ccb_list` / `ccb_cancel` —— 指挥那个窗口里的 Claude
 *
 * **不** setFactory，**不**改立绘 / 大字 / 主题。日常窗口保持官方女仆。
 *
 * ## window（`run.ps1` / `/ccb` 拉起的那扇独立终端）
 *
 * 换掉 AgentFactory，后端接 Claude Code 的 stream-json。
 * 橙色主题、女仆立绘、CLAUDE CODE 大标题都只发生在这个进程里。
 *
 *   dsh-TUI 输入框
 *        │  handle.agent.followup({content})
 *        ▼
 *   本 factory 的 Agent 实现
 *        │  spawn claude --resume <sid> --input-format stream-json ...
 *        ▼
 *   Claude Code  → session.append(...) → 这个窗口渲染
 *
 * 宿主经信箱（`mailbox/`）往这个窗口塞任务；窗口认领后走同一条 inbox。
 *
 * ## takeover（独立 profile / `run-plugin.ps1`，特色模式）
 *
 * 整窗替换：这个 dsh 进程本身就是 Claude 后端。和 window 同一套 factory
 * + 外观。默认组合包只插 host 面，所以 takeover 仍要叠 `cordis.patch.yml`
 * （禁 agent-loop）；独立 profile 的用户层也可以持久写这份 overlay。
 */

import { spawn } from 'node:child_process'
import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
// 静态 import：`subagentStore()` 必须在事件处理时**同步**可用。
// 动态 import 即使命中缓存也要等一个微任务，会让 tokens 补不上（踩过）。
import {
  installSubagentBridge, subagentStoresHolding, subagentStores,
} from './subagent-bridge.mjs'
import { installSlashPassthrough } from './slash-passthrough.mjs'
import {
  installChannelCapture, suppressCommandList, resetSessionState, activeChannel,
  patchSubagentSnapshot, mirrorSubagent,
} from './channel-hooks.mjs'
import { consumeNdjson, flushNdjson } from './ndjson.mjs'
import { parseMapJson, mappingIdFromResult } from './session-map.mjs'
import { createInboxQueue } from './inbox-queue.mjs'
import {
  clearMailboxCancel, readMailbox, setMailboxStatus,
  takePending, touchMailboxHeartbeat, watchMailbox, writeTurnResult,
} from './mailbox.mjs'
import { installHostSurface } from './host-surface.mjs'
import { installHostSlashIntercept } from './host-slash.mjs'
import { resolveMode, resolveStateDir, resolveWindowCwd, windowAppearanceDefaults } from './mode.mjs'

/**
 * cc-bridge 的私有状态目录 —— 日志和会话映射都放这里。
 *
 * ⚠️ **不能用绝对路径**。原先是写死的 `D:\code\cc-bridge\...`，那意味着
 *    别人 clone 到别的盘符/目录后，所有写盘都会失败（`appendFileSync` 抛错
 *    被 catch 吞掉 → 日志静默消失，排查时一片空白）。
 *
 * 位置优先级：
 *   ① `CCB_STATE_DIR` 环境变量（给多实例/测试用）
 *   ② `$DSH_HOME/cc-bridge`（跟 dsh 的家目录走，天然是用户私有区）
 *   ③ `~/.dsh/cc-bridge`（`--import` 时 DSH_HOME 常还没设，但家目录已经在）
 *   ④ `~/.cc-bridge`（连 `.dsh` 都没有时）
 *
 * 用 `import.meta.dirname` 相对定位是**不行的** —— 插件可能被 npm 装进
 * `node_modules`，那里不该写运行时状态。
 *
 * ⚠️ 这个块必须放在**所有用到它的地方之前** —— `const` 有 TDZ，
 *    放到后面会报 `Cannot access 'STATE_DIR' before initialization`
 *    （踩过：挪到文件中部，于是整个插件 import 失败、dsh 只报一行
 *     "failed to import"，看不出原因）。
 */
const STATE_DIR = resolveStateDir()

try { mkdirSync(STATE_DIR, { recursive: true }) } catch { /* 下面各自再兜底 */ }

const LOG_FILE = join(STATE_DIR, 'bridge.log')

/** 本进程认领的信箱。一扇窗口只该有一个 --print 主人。 */
let boundMailboxId = null

function mailboxIdFromEnv() {
  const id = process.env.CCB_MAILBOX_ID
  return typeof id === 'string' && id.trim() ? id.trim() : ''
}

/**
 * 插件自己的根目录（`src/` 的上一级）。
 *
 * 用于解析**仓库内**的资源路径（立绘等）—— 这样 `cordis.patch.yml` 里
 * 可以写相对路径，clone 到任何目录都能用。
 */
const PLUGIN_ROOT = join(import.meta.dirname, '..')

/**
 * 把配置里的资源路径解析成绝对路径。
 *
 * 支持两种写法：
 *   · **绝对路径** —— 原样返回（用户自备素材时用）
 *   · **相对路径** —— 相对**插件根目录**解析（`assets/maid.png` 这种）
 *
 * 为什么需要：patch 文件里写死 `D:\code\cc-bridge\assets\maid.png`
 * 的话，别人 clone 到 `D:\code\cc-bridge` 就找不到图了 —— 而且失败是
 * **静默**的（maid-art 内部 try/catch，只打一行日志），
 * 表现为"招牌立绘莫名其妙不见了，也不知道为什么"。
 *
 * 相对路径的语义定为「相对插件根」而不是「相对 cwd」—— cwd 是
 * claude 的工作目录，会随项目变，拿它当锚点太不稳定。
 */
function resolveAssetPath(p) {
  if (typeof p !== 'string' || !p.trim()) return null
  const s = p.trim()
  // 绝对路径：Windows 盘符 / UNC / POSIX 根
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/')) return s
  return join(PLUGIN_ROOT, s)
}

/**
 * 把本进程的 PID 汇报到一个文件 —— 给 `launch-test.ps1` 做**精确归属**。
 *
 * 为什么需要：测试脚本原先靠「启动后 45 秒内新出现的、命令行含 `cc-bridge`
 * 的 node.exe」来认自己开的那个进程。如果使用者在那个时间窗里自己开了一个
 * cc-bridge 窗口，它会被**误认**成测试进程记进 `.test-pids`，
 * 之后 `kill-mine.ps1` 就会把用户的窗口杀掉。
 *
 * 改成让进程自己报 PID 之后：零歧义、不依赖时间窗口、不依赖命令行匹配。
 * 只在 `CCB_PID_FILE` 设了的时候写（正常运行不留任何痕迹）。
 */
if (process.env.CCB_PID_FILE) {
  try {
    writeFileSync(process.env.CCB_PID_FILE, String(process.pid), 'utf8')
  } catch { /* 归属信息拿不到不影响插件功能 */ }
}

/**
 * dsh sessionId ↔ claude sessionId 的映射表。
 *
 * 为什么需要：dsh 的 sessionId 形如 `session-aaaaaaaa-bbbb-cccc-dddd-...`，
 * 而 claude 的 `--resume` 只接受**它自己的 UUID**（实测报
 * "Provided value ... is not a UUID and does not match any session title"）。
 *
 * 所以两边各有一套 id，必须建立映射：dsh 的 id 当键，claude 的 UUID 当值。
 * 第一轮不带 --resume（让 claude 新建），从 result 事件里拿到它分配的真实
 * UUID 后存下来；之后每轮用这个 UUID 续接，对话历史才连得上。
 *
 * 落盘而不是只放内存：dsh 重启后要能接着聊同一个 claude 会话。
 */
const MAP_FILE = join(STATE_DIR, 'session-map.json')

function loadMap() {
  try {
    const raw = readFileSync(MAP_FILE, 'utf8')
    const parsed = parseMapJson(raw)
    // parseMapJson 把坏内容收成 {}。原文件不是空对象却解析成空表时，记一笔方便排查。
    if (raw.trim() && raw.trim() !== '{}' && Object.keys(parsed).length === 0) {
      log('映射文件内容不是对象，忽略：', raw.slice(0, 80))
    }
    return parsed
  } catch { return {} }
}

function saveMap(map) {
  try {
    mkdirSync(dirname(MAP_FILE), { recursive: true })
    const body = JSON.stringify(map, null, 2)
    const tmp = `${MAP_FILE}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
    writeFileSync(tmp, body, 'utf8')
    try {
      renameSync(tmp, MAP_FILE)
    } catch {
      // Windows 上 rename 不能覆盖已存在的目标。
      try { unlinkSync(MAP_FILE) } catch { /* dest 不存在 */ }
      try {
        renameSync(tmp, MAP_FILE)
      } catch (err) {
        try { unlinkSync(tmp) } catch { /* ignore */ }
        throw err
      }
    }
  } catch (err) { log('保存映射失败:', String(err)) }
}

/** 只改一个键，写之前重新 load。写入串行，避免两轮 close 交错覆盖。 */
let mapWrite = Promise.resolve()
function persistMapEntry(dshSid, claudeSid) {
  const job = mapWrite.then(() => {
    const map = loadMap()
    if (map[dshSid] === claudeSid) return false
    map[dshSid] = claudeSid
    saveMap(map)
    return true
  })
  mapWrite = job.then(() => undefined, () => undefined)
  return job
}

function dropMapEntry(dshSid) {
  const job = mapWrite.then(() => {
    const map = loadMap()
    if (!Object.hasOwn(map, dshSid)) return undefined
    const dropped = map[dshSid]
    delete map[dshSid]
    saveMap(map)
    return dropped
  })
  mapWrite = job.then(() => undefined, () => undefined)
  return job
}

/**
 * 解析 DSH 核心包 —— 必须拿到**和 dsh 宿主同一份模块实例**。
 *
 * 踩了两轮坑，都记下来：
 *
 * ① 直接 `import '@deepseek-ai/dsh-scope'` 报 "Cannot find package" ——
 *    本插件住在 profile 之外（D:\code\cc-bridge），Node 从插件目录往上
 *    找 node_modules，而 DSH 的包不在那条链上。
 *
 * ② 改成按 `$DSH_HOME/profiles/node_modules` 推绝对路径 —— 加载成功了，
 *    但 TUI 仍然报 "Agent preset binding requires a scoped context"。
 *    原因：**dsh 宿主实际运行的是 npx 缓存里的那一份**
 *    （AppData\Local\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\...），
 *    profile 层的包是给 npx 那份解析用的。
 *    我加载的 profile 副本与宿主副本**不是同一个模块实例**，
 *    于是 `dsh-scope` 内部的 `kScope` Symbol 不同 —— 我 mint 的 scope
 *    宿主的 `scopeOf()` 认不出来，等于没 scope。
 *    （诊断脚本里 `m1 === m2` 巧合为 true，是因为那个 hash 目录恰好也是
 *    解析结果；换台机器/换个 npx 缓存就会暴露。）
 *
 * 正解：让 dsh 自己告诉我它在哪，从它的模块图里解析。
 * `dsh` 通过 npm 的 bin 脚本启动，脚本路径在 process.argv[1]；
 * 用它做 createRequire 基点，就能解析到宿主真正用的那份。
 */
function resolveFromHost(pkg) {
  // 直接锚在 profile 层的 node_modules —— 不依赖环境变量指对了哪个 profile。
  //
  // 试过的弯路：用 DSH_PROFILE_DIR 做基点，但那个变量指向启动时的 profile
  // （实测恒为 dsh-tui），而跑 headless 时用的是 headless profile。
  // 好在 profiles/node_modules 是**所有 profile 共享**的一层，锚它最稳。
  //
  // 注意这些路径下的 package.json 并不存在 —— 无所谓，createRequire
  // 接受任意路径作起点，它会自己沿目录往上找 node_modules。
  const profilesNm = process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'profiles', 'node_modules')
    : null

  const anchors = [
    profilesNm && join(profilesNm, 'noop.js'),
    profilesNm && join(profilesNm, '..', 'noop.js'),
    process.argv[1],
  ].filter(Boolean)

  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor)
      const hit = req.resolve(pkg)
      log(`解析 ${pkg} <- ${hit}`)
      return hit
    } catch (err) {
      // 每个基点的失败原因都要记 —— 之前只报"全部失败"，
      // 看不出是路径不对还是包名不对，白费了好几轮。
      log(`基点失败 ${anchor}: ${err.code ?? ''} ${err.message}`)
    }
  }
  return null
}

export const name = 'cc-bridge'

// ── 关于 inject：必须声明，且要声明全 ────────────────────────────────
//
// 踩了两轮，方向是反的，记清楚：
//
// 第一轮：写 `inject: ['agents','sessions']` → 插件永远 pending、
//   apply 不执行。当时以为"inject 会导致挂起"，就把它删了改成软探测。
//   **那个判断是错的** —— 真正原因是服务名/时机，不是 inject 本身。
//
// 第二轮：TUI 启动报 `cannot get property "subagents" without inject`。
//   查 cordis 源码（lib/index.js:676）才明白：ctx 是个 Proxy，
//   **只有声明过的属性才可访问**，否则直接抛这个错。
//   而 dsh-tui 的 preset 在 setup 阶段要 `ctx.subagents`。
//
// 所以 inject 不是可选项，是 cordis 的访问契约。这里声明本插件（及其
// 下游 setup）会用到的全部服务。少一个，setup 里就会以那个名字报错。
//
// `attachments` 是图片用的：claude 的 Read 工具读图时会在 tool_result 里
// 塞 base64 图片块，我们调 `attachments.saveImages()` 把它落成 DSH 的
// 内容寻址对象，再发 `image` 块给 UI（见 toDshBlocks）。
export const inject = ['agents', 'sessions', 'subagents', 'attachments']

/**
 * 加载 DSH 核心包 —— 从**宿主模块图**解析，保证与 dsh 是同一份实例。
 * 为什么这点至关重要，见 resolveFromHost 上方那段注释。
 */
const pkgCache = new Map()
async function loadDshPackage(pkg) {
  if (pkgCache.has(pkg)) return pkgCache.get(pkg)

  const resolved = resolveFromHost(pkg)
  if (!resolved) {
    throw new Error(`cc-bridge: 无法从 dsh 宿主解析 ${pkg}（argv[1]=${process.argv[1]}）`)
  }
  const mod = await import(pathToFileURL(resolved).href)
  pkgCache.set(pkg, mod)
  return mod
}

const log = (...args) => {
  const line = `[cc-bridge] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`
  // ESM 里没有 require —— 一开始写成 require('node:fs') 直接抛错，
  // 而 dsh 把插件初始化异常吞成一行 warning，表现为"插件没反应"。
  try { appendFileSync(LOG_FILE, line, 'utf8') } catch { /* ignore */ }
  try { process.stderr.write(Buffer.from(line, 'utf8')) } catch { /* ignore */ }
}

/**
 * 已注册的 llm provider adapter 句柄（见 `installModelAdapter`）。
 *
 * 拿到 claude 实报的上下文容量后，用它把 adapter 里的值同步过去 ——
 * dsh-tui 会通过 `llm.resolveModelInfo()` 读这个值来定 ctx 条的刻度
 * （model-actions.js 的 applyRouteMetadata），和 `request/context` 事件
 * 互为补充。
 */
let modelAdapter = null

/**
 * claude 的内容块 → DSH 的 ContentBlock。
 *
 * 两边词汇不同，这张表是全部差异：
 *
 * | claude                    | DSH                        |
 * |---------------------------|----------------------------|
 * | `{type:'text',text}`      | `{type:'text',text}`       |
 * | `{type:'tool_use',...}`   | `{type:'tool-call',...}`   |
 * | `{type:'image',file:{…}}` | `{type:'image',attachment}`|
 * | `{type:'thinking',…}`     | `{type:'reasoning',text}`  |
 *
 * 图片是最麻烦的一个：claude 给的是内联 base64，而 DSH 要的是
 * **内容寻址的 attachment 引用** —— 得先 `saveImages()` 落盘换成 ref。
 * 这也是唯一一个**异步**的转换，所以整个函数是 async 的。
 *
 * @param blocks      claude 的块数组
 * @param attachments ctx 上的 attachments 服务（可能为 undefined）
 * @returns DSH 能吃的块数组
 */
async function toDshBlocks(blocks, attachments) {
  const out = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue

    if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') {
      out.push({ type: 'text', text: b.text })
    } else if (b.type === 'tool_use' && b.id && b.name) {
      out.push({
        type: 'tool-call',
        id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      })
    } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking !== '') {
      out.push({ type: 'reasoning', text: b.thinking })
    } else if (b.type === 'image') {
      // claude 的形状：{ type:'image', file:{ base64, type:'image/png', ... } }
      // 也见过 { type:'image', source:{ type:'base64', data, media_type } }，
      // 两种都认 —— 前者是 sdk-tools.d.ts 里的，后者是 Anthropic API 原生形状。
      const base64 = b.file?.base64 ?? (b.source?.type === 'base64' ? b.source.data : undefined)
      const mediaType = b.file?.type ?? b.source?.media_type
      if (!base64 || !mediaType) {
        out.push({ type: 'text', text: '[图片：缺少数据]' })
        continue
      }
      if (!attachments?.saveImages) {
        // 没有 attachments 服务时降级成占位文字，别让整条消息挂掉。
        // DSH 自己的 migrate 适配器也是这么处理的（IMAGE_PLACEHOLDER）。
        out.push({ type: 'text', text: `[图片 ${mediaType}]` })
        continue
      }
      try {
        const data = Buffer.from(base64, 'base64')
        const [ref] = await attachments.saveImages([{ data, mediaType }])
        log('  图片已落盘:', mediaType, data.length, 'bytes →', ref?.id ?? ref?.digest ?? '(ref)')
        out.push({ type: 'image', attachment: ref })
      } catch (err) {
        log('保存图片失败:', String(err))
        out.push({ type: 'text', text: `[图片保存失败：${err.message}]` })
      }
    }
    // 其他类型（tool_result 等）不属于模型输出的 assistant 消息，跳过
  }
  return out
}

/**
 * claude 的 tool_result 内容 → DSH 的内容块（可含图片）。
 */
async function toolResultBlocks(raw, attachments) {
  if (typeof raw === 'string') return [{ type: 'text', text: raw }]
  if (!Array.isArray(raw)) return [{ type: 'text', text: String(raw ?? '') }]
  const blocks = raw.map((b) => (typeof b === 'string' ? { type: 'text', text: b } : b))
  return toDshBlocks(blocks, attachments)
}

/**
 * 读 claude 本次会话的**真实系统提示词**。
 *
 * 为什么要绕这一圈：claude 的 stream-json **不暴露**系统提示，
 * 但它把 `prompt_snapshot` 附件写进了自己的 transcript：
 *   ~/.claude/projects/<mangled-cwd>/<uuid>.jsonl
 * 里面 `attachment.prompt_snapshot.systemPrompt` 是个字符串数组
 * （实测 8 段：基础提示、代码风格、代词规则、确认规则、会话指引、
 *  记忆、环境、上下文管理）。
 *
 * 拿到长度就能让状态栏的 `sys` 显示真实值，而不是猜一个数。
 *
 * 找不到就返回 null —— 调用方会用基线值兜底，不让 sys 变 0。
 *
 * @param claudeSessionId claude 的 UUID（不是 dsh 的 session id）
 * @param cwd             用来推 transcript 目录
 * @returns 系统提示的**字符数**，或 null
 *
 * ⚠️ 返回的是数字不是字符串！
 * 踩坑：一开始这里 `return 'x'.repeat(chars)`，调用方写成
 *   `const sysChars = readClaudeSystemPrompt(...) ?? 6000`
 * 看着像数字，其实是字符串 —— 于是
 *   `totalChars = sysChars + toolChars` 变成**字符串拼接**，
 *   `Math.ceil(totalChars / 4)` 得到 NaN，
 * 日志里还打出了 22 万个 x。名字叫 chars 就该返回字符数。
 */
function readClaudeSystemPrompt(claudeSessionId, cwd) {
  if (!claudeSessionId || !cwd) return null
  try {
    // claude 把 cwd 里的非字母数字换成 '-'，形如 D:\code\playground
    //   → D--code-playground
    // 规则来自实测（路径分隔符、冒号、点都变 '-'，连续多个只保留？
    // 不 —— 实测是**每个**非字母数字字符各换一个 '-'）。
    const mangled = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const dir = join(homedir(), '.claude', 'projects', mangled)
    const file = join(dir, `${claudeSessionId}.jsonl`)
    if (!existsSync(file)) return null

    // 整个文件可能很大（几十 MB），但我们只需要最后一条 prompt_snapshot，
    // 而它通常在文件靠后的位置。这里图省事直接读全文 —— transcript 是
    // 追加写的，单轮会话不会太大。真变慢了再改成尾部读。
    const text = readFileSync(file, 'utf8')
    let chars = 0
    for (const line of text.split('\n')) {
      if (!line.includes('prompt_snapshot')) continue
      let rec
      try { rec = JSON.parse(line) } catch { continue }
      const snap = rec?.attachment
      if (snap?.type !== 'prompt_snapshot') continue
      const parts = snap.systemPrompt
      if (!Array.isArray(parts)) continue
      // 最后一条生效（会话中途可能换过提示）
      chars = parts.reduce((n, s) => n + (typeof s === 'string' ? s.length : 0), 0)
    }
    return chars > 0 ? chars : null
  } catch (err) {
    log('读 claude 系统提示失败:', String(err))
    return null
  }
}

/**
 * 定位 claude 可执行文件。
 *
 * ════════════════════════════════════════════════════════════════════
 * ⚠️ 为什么要区分「真可执行文件」和「包装脚本」
 * ════════════════════════════════════════════════════════════════════
 *
 * npm 全局安装会在 `%APPDATA%\npm\` 下生成三个**包装脚本**：
 *
 *     claude        （sh 风格，无扩展名）
 *     claude.cmd    （批处理）
 *     claude.ps1    （PowerShell）
 *
 * 它们只是转发到真正的 `node_modules\@anthropic-ai\claude-code\bin\claude.exe`。
 *
 * **Node 不能直接 spawn `.cmd` / `.bat`** —— 会抛 `spawn EINVAL`
 * （Windows 上非 PE 文件不能直接 CreateProcess）。踩过：
 *
 *     · 原先的实现优先用绝对路径的 `claude.exe` → 正常
 *     · 我"改进"成**先扫 PATH** → 命中了 `claude.cmd` → 每轮都失败，
 *       日志里只有 `turn 1 done ok=false`，连 spawn 的错误都没打出来
 *
 * 所以顺序必须是：**真可执行文件优先，包装脚本最后**（且要特殊处理）。
 *
 * ── 优先级 ─────────────────────────────────────────────────────────
 *   ① `CLAUDE_EXE` 环境变量（用户显式指定）
 *   ② 已知安装位置里的**真 .exe**（npm 全局、官方安装器、常见路径）
 *   ③ PATH 里扫到的**真 .exe**
 *   ④ PATH 里扫到的 `.cmd`/`.bat` —— 记下来，交给调用方决定怎么起
 *
 * @returns {{ exe: string, wrapper: boolean } | null}
 *   `wrapper: true` 表示这是个批处理包装器，**不能直接 spawn**，
 *   调用方要用 `spawnViaShell()`。
 */
function resolveClaudeExe() {
  const isWin = process.platform === 'win32'
  // 真可执行文件（能直接 CreateProcess 的）
  const realNames = isWin ? ['claude.exe'] : ['claude']
  // 包装脚本（必须走 shell 才能起）
  const wrapperNames = isWin ? ['claude.cmd', 'claude.bat'] : []

  const tryPath = (p) => {
    if (typeof p !== 'string' || !p) return false
    try { return existsSync(p) } catch { return false }
  }

  // ── ① 用户显式指定 ───────────────────────────────────────────────
  const explicit = process.env.CLAUDE_EXE
  if (explicit) {
    if (tryPath(explicit)) {
      const lower = explicit.toLowerCase()
      const isWrapper = isWin && (lower.endsWith('.cmd') || lower.endsWith('.bat'))
      return { exe: explicit, wrapper: isWrapper }
    }
    // 给了但不存在 —— **不静默跳过**，否则像是"配了却没生效"
    log('⚠️ CLAUDE_EXE 指向的文件不存在，继续查找：', explicit)
  }

  // ── ② 已知安装位置（真 .exe）────────────────────────────────────
  const home = homedir()
  const known = [
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules',
      '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    home && join(home, '.local', 'bin', isWin ? 'claude.exe' : 'claude'),
    home && join(home, '.claude', 'local', isWin ? 'claude.exe' : 'claude'),
    home && join(home, '.npm-global', 'bin', isWin ? 'claude.exe' : 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/bin/claude',
  ].filter(Boolean)
  for (const c of known) if (tryPath(c)) return { exe: c, wrapper: false }

  // ── ③④ PATH 扫描：先收集，再按「真 exe 优先」挑 ─────────────────
  const pathVar = process.env.PATH ?? process.env.Path ?? ''
  const dirs = pathVar.split(isWin ? ';' : ':').filter(Boolean)
  let wrapperHit = null
  for (const dir of dirs) {
    for (const name of realNames) {
      const full = join(dir, name)
      if (tryPath(full)) return { exe: full, wrapper: false }
    }
    // 真 exe 没找到时先记下包装器，扫完再决定（不要立刻返回！）
    if (wrapperHit === null) {
      for (const name of wrapperNames) {
        const full = join(dir, name)
        if (tryPath(full)) { wrapperHit = full; break }
      }
    }
  }
  if (wrapperHit) return { exe: wrapperHit, wrapper: true }

  return null
}

/**
 * 起一个**批处理包装器**（`.cmd` / `.bat`）。
 *
 * Node 不能直接 spawn 它们（`EINVAL`），必须经由 `cmd.exe`。
 * 这条路上**引号处理就是注入面**，所以：
 *
 *   ① 用 Node 官方的 `shell: true` 让它自己拼引号（比自己拼安全）
 *   ② 调用前**强校验**每个参数 —— 只允许我们自己生成的安全字符集
 *
 * 我们的参数构成：静态字面量 + 一个来自 `session-map.json` 的 claude UUID。
 * 那个文件理论上可被本机其他程序改写，所以 UUID 走白名单正则校验。
 *
 * @returns {import('node:child_process').ChildProcess}
 */
function spawnViaShell(exe, args, opts) {
  for (const a of args) {
    if (typeof a !== 'string' || !/^[A-Za-z0-9 ._:/\\@-]*$/.test(a)) {
      throw new Error(`cc-bridge: 参数含不安全字符，拒绝经 shell 传递：${JSON.stringify(a)}`)
    }
  }
  return spawn(exe, args, { ...opts, shell: true })
}

/**
 * 从 claude 的 result 帧里取「这次用的那个模型」的运行时信息。
 *
 * result 帧带一个 `modelUsage` 字典，键是模型 id、值是它的用量与容量：
 *
 *   "modelUsage": {
 *     "claude-sonnet-4-5": {
 *       "inputTokens": 24000,
 *       "contextWindow": 256000,      ← 我们要的
 *       "maxOutputTokens": 32000,
 *       "canonicalModel": "claude-sonnet-4-5",
 *       "provider": "firstParty"
 *     }
 *   }
 *
 * 正常只有一项。真出现多项（比如中途换了模型）时取**上下文窗口最大**的那个
 * —— 那是本轮的权威容量，取错会让百分比偏小、提前报「上下文不足」。
 *
 * @param result claude 的 result 帧
 * @returns 选中的那条 modelUsage，取不到就 undefined
 */
function readModelUsageEntry(result) {
  const usage = result?.modelUsage
  if (usage === null || typeof usage !== 'object') return undefined
  const entries = Object.values(usage).filter((e) => e !== null && typeof e === 'object')
  if (entries.length === 0) return undefined
  if (entries.length === 1) return entries[0]
  return entries.reduce((best, e) =>
    (typeof e.contextWindow === 'number' && e.contextWindow > (best.contextWindow ?? 0)) ? e : best)
}

/**
 * 跑一轮 claude，返回最终文本。
 *
 * 用的就是前面验证过的 stream-json 协议：
 *   claude --print --resume <sid> --input-format stream-json --output-format stream-json --verbose
 *
 * 三个流的编码都必须显式 UTF-8 —— 漏了 stdin 中文会变成 U+FFFD
 * （这个坑前面踩过，README 里有记录）。
 */
function runClaude({ sessionId, cwd, text, onAssistant, onToolResult, onChunk, onActivity, registerAbort, attachments, onInit, onSubagent, signal }) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, cancelled: true, error: '已中断' })
      return
    }
    // 中止钩子：外部（Agent.cancel）调它来干掉这个子进程。
    // 真正的赋值在 spawn 之后（那时才拿得到 child.pid），
    // 但**声明必须在这里**，因为 done() 要清它。
    //
    // 踩坑：最初 `registerAbort` 在文件顶部就调用，而 hook 到下面才定义，
    // 于是两边都被迫写成 setter 风格：
    //   runClaude:  registerAbort?.((fn) => { abortHook = fn })
    //   followup:   registerAbort: (fn) => { abortActive = fn }
    // 结果 abortActive 存的是「把 hook 存进闭包」这个**动作**本身，
    // cancel() 调它等于空转 —— 日志里有 "cancel() cause=..." 却永远
    // 等不到 "cancel() → 中止 claude"，进程纹丝不动。
    // 修法：先定义 hook，再把它**本身**交出去（见下方 registerAbort 调用）。
    let abortHook = null

    const found = resolveClaudeExe()
    if (!found) {
      // 给出可操作的提示 —— 只报"找不到"用户无从下手。
      resolve({
        ok: false,
        error: '找不到 claude 可执行文件。请确认 claude 已安装并在 PATH 里，'
          + '或设环境变量 CLAUDE_EXE 指向它（例如 '
          + '`$env:CLAUDE_EXE = "$env:APPDATA\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"`）',
      })
      return
    }
    const exe = found.exe
    if (found.wrapper) {
      log('  claude 入口是包装脚本（' + exe + '），将经 shell 启动')
    }

    // 有映射就用 claude 的 UUID 续接；没有就新建（不带 --resume）。
    // 不能把 dsh 的 `session-xxx` 直接丢给 --resume —— claude 只认 UUID。
    const claudeSid = loadMap()[sessionId]
    const args = [
      '--print',
      ...(claudeSid ? ['--resume', claudeSid] : []),
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      // 开增量事件：会让 claude 额外吐 `stream_event` 类型的事件，
      // 里面是逐 token 的 `content_block_delta/text_delta`。
      // 没有它就只能等整条 assistant 消息，界面上是"唰"一下全出来。
      ...(onChunk ? ['--include-partial-messages'] : []),
      // ── 把「队友」（子代理）的活动转发进事件流 ──────────────────────
      //
      // 不开这个开关，claude 的队友是**进程内部**的东西 —— 它的搜索、它的
      // 工具调用、它说了什么，一个字节都不会出现在 stdout 的事件流里。
      // 表现就是：你在 Claude Code 里能看到队友在跑，但 dsh-TUI 里
      // 那部分活动全被算到主会话头上（或干脆消失）。
      //
      // 开了之后 claude 会额外发：
      //   · `system/task_started` / `task_progress` / `task_updated` /
      //     `task_notification` —— 队友的生命周期（id、描述、token、耗时）
      //   · 队友自己的 assistant/user 消息，**带 `parent_tool_use_id`**
      //     （= 发起它的那次 Agent 工具调用的 id）
      //
      // 后者是分流的关键：靠它才能把「队友说的话」和「主会话说的话」分开。
      // 官方说明：only works with --print and --output-format=stream-json。
      ...(onSubagent ? ['--forward-subagent-text'] : []),
    ]
    log('spawn claude', claudeSid ? `resume=${claudeSid.slice(0, 8)}` : '(新建会话)', onChunk ? '(流式)' : '')

    let child
    try {
      // 包装脚本（.cmd/.bat）必须经 shell —— Node 直接 spawn 会 EINVAL。
      child = found.wrapper
        ? spawnViaShell(exe, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        : spawn(exe, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve({ ok: false, error: `spawn 失败: ${err.message}` })
      return
    }

    let settled = false
    let cancelled = false
    const done = (v) => { if (!settled) { settled = true; abortHook = null; resolve(v) } }
    const stderrLines = []
    const STDERR_MAX = 200
    let stderrDropped = 0
    const requestCancel = () => {
      if (abortHook) {
        abortHook()
        return
      }
      if (settled) return
      cancelled = true
      done({ ok: false, cancelled: true, error: '已中断' })
    }

    /**
     * 已收到 `task_updated` 终态、但还没等到 `task_notification` 的队友。
     *
     * 两条事件的**信息量不同**：`task_updated` 只有状态，`task_notification`
     * 才有 summary 和 usage。而 dsh-TUI 的落定是幂等的，谁先到谁说了算 ——
     * 所以必须等后者（详见下面 task_updated 分支的注释）。
     */
    const pendingEnds = new Map()

    // ── 暴露中止入口 ────────────────────────────────────────────
    //
    // 上层的 Agent.cancel() 通过这个钩子杀掉正在跑的 claude。
    //
    // 为什么不用 AbortController + kill('SIGTERM') 就完事：
    // Windows 上 claude 是 .exe（不是 node 脚本），它下面还可能挂着子进程
    // （bash/pwsh 工具调用）。直接 kill 只杀父进程，孙进程会变孤儿继续跑。
    // 所以用 **taskkill /T /F** 连整棵进程树一起收掉。
    //
    // stdin 在开跑时就已经 end 了（`--print` 一轮一条），再等 EOF
    // 收尾等于白等。Esc / interruptAndDeliver 要立刻杀掉进程树，
    // 排队里的下一条才能马上开新的 `--print`。
    abortHook = () => {
      if (settled || cancelled) return
      cancelled = true
      log('cancel() → 中止 claude')
      try { child.stdin.end() } catch { /* ignore */ }
      try {
        if (process.platform === 'win32') {
          if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        } else {
          child.kill('SIGKILL')
        }
      } catch (err) {
        log('强杀失败:', String(err))
      }
      // 立刻收轮：interruptAndDeliver 的 followup 卡在 await runClaude。
      // 映射仍由 close 里的 persistMapEntry 写（done 已结算也不挡）。
      done({ ok: false, cancelled: true, error: '已中断', stderr: stderrLines })
    }

    // 把 hook **本身**交出去（不是 setter —— 那个坑见函数开头的注释）。
    // 放在这里而不是开头，是因为 hook 要闭包 child.pid。
    registerAbort?.(abortHook)
    if (signal) {
      if (signal.aborted) {
        requestCancel()
      } else {
        try { signal.addEventListener('abort', requestCancel, { once: true }) } catch { /* ignore */ }
      }
    }

    let outBuf = ''
    let result = null
    let seenClaudeSid = null
    // 最近一次请求的 usage —— 它描述的是**当前上下文占用**
    // （未缓存 input + 缓存命中都占窗口），所以只保留最后一份，
    // 不是累计。这个口径和 dsh-tui 的 lastUsage 一致。
    let latestUsage = null

    // 保序链：块转换（含图片落盘）是异步的，而 stdout 的 data 回调不是。
    // 不串起来的话，同一批数据里「先来的 assistant 事件」可能因为
    // await 图片落盘而被「后来的工具结果」抢先处理，事件顺序就乱了 ——
    // 而 DSH 的 session 是**顺序敏感**的（step/tool 边界都靠它）。
    let chain = Promise.resolve()

    child.stdout.setEncoding('utf8')
    /**
     * 把一块 stdout 数据切成行、逐行交给下面的循环处理。
     *
     * ⚠️ 定义成**具名函数**而不是内联箭头，是为了让 `close` 处理器能调用它
     *    来 **flush 最后一行残料**（见 close 里的注释）。内联的话那份残料
     *    就只能丢掉了。
     */
    const feedStdout = (chunk) => {
      const sliced = consumeNdjson(outBuf, chunk)
      outBuf = sliced.rest
      for (const line of sliced.lines) {
        let ev
        try { ev = JSON.parse(line) } catch { continue }

        if (ev.type === 'result') result = ev
        // 已中断：只留 session_id / result 给映射，别再往 TUI 写块。
        if (cancelled) {
          if (typeof ev.session_id === 'string' && ev.session_id && !seenClaudeSid) {
            seenClaudeSid = ev.session_id
          }
          continue
        }
        // init / assistant / result 都可能带 session_id；先见到就记，
        // 别等 result —— Esc 时 result 经常没来得及写。
        if (typeof ev.session_id === 'string' && ev.session_id && !seenClaudeSid) {
          seenClaudeSid = ev.session_id
        }

        // ── claude 的 init 事件 → 系统提示 + 工具清单 ────────────────
        //
        // claude 启动后第一条 `system/init` 带着这次会话的**全部家当**：
        //   · model        —— 它实际用的模型（如 claude-sonnet-4-5）
        //   · tools[]      —— 工具名单（本机 359 个，含一堆 MCP）
        //   · mcp_servers  —— MCP 连接状态
        //   · skills[]     —— 技能
        //   · claude_code_version / permissionMode / output_style ...
        //
        // 为什么重要：hover 展开的分段明细里 `sys` 一直是 0，而系统提示 +
        // 工具定义占了 24k 上下文的绝大部分 —— 不报的话明细加起来
        // 只有几个 token，看起来像统计坏了。
        //
        // 注意 tools 里只有**名字**，没有 schema。所以只能估：
        // 名字本身 + 每个工具一份平均大小的 schema。估得不准没关系，
        // 分段条本来就是近似；关键是别让 sys 显示成 0。
        if (ev.type === 'system' && ev.subtype === 'init') {
          // 别在这里直接赋值给外层的 initInfo —— runClaude 是模块级函数，
          // 看不到 mountAgent 里的变量（踩过：ReferenceError）。
          // 一律通过 onInit 回调把数据交出去。
          const info = {
            model: typeof ev.model === 'string' ? ev.model : undefined,
            tools: Array.isArray(ev.tools) ? ev.tools : [],
            mcpServers: Array.isArray(ev.mcp_servers) ? ev.mcp_servers : [],
            skills: Array.isArray(ev.skills) ? ev.skills : [],
            version: typeof ev.claude_code_version === 'string' ? ev.claude_code_version : undefined,
            permissionMode: typeof ev.permission_mode === 'string' ? ev.permission_mode : undefined,
          }
          log('  init: model=' + (info.model ?? '?') +
            ' tools=' + info.tools.length +
            ' mcp=' + info.mcpServers.length +
            ' skills=' + info.skills.length)
          try { onInit?.(info) } catch (err) { log('onInit 抛错:', String(err)) }
        }

        // ── 队友（子代理）的生命周期事件 ────────────────────────────
        //
        // 只有加了 `--forward-subagent-text` 才会来这几个。它们是 dsh-TUI
        // 队友面板的**唯一数据源**（`subagent-projection.js` 的 onParentEvent）。
        //
        // 字段实测（claude 2.1.x）：
        //   task_started      { task_id, tool_use_id, description, subagent_type,
        //                       is_backgrounded, spawn_depth, task_type, prompt }
        //   task_progress     { task_id, tool_use_id, description, usage:{total_tokens,
        //                       tool_uses, duration_ms}, last_tool_name }
        //   task_updated      { task_id, patch:{ status, end_time } }
        //   task_notification { task_id, status, output_file, summary, usage }
        //
        // ⚠️ `task_id` 才是那个稳定的队友 id —— 它同时也是磁盘上
        //    `<session>/subagents/agent-<task_id>.jsonl` 的文件名，
        //    和 `Agent` 工具返回值里的 `agentId` 一致。
        //    `tool_use_id` 是**发起它的那次工具调用**，用来做分流。
        if (ev.type === 'system' && onSubagent) {
          const st = ev.subtype
          if (st === 'task_started' && typeof ev.task_id === 'string') {
            log('  队友启动:', ev.task_id, JSON.stringify(ev.description ?? ''))
            // ⚠️ start 必须**排到保序链后面**：dsh-TUI 的 `onStart` 里
            //    `description: pendingTaskDescriptions.shift()`，而这个队列
            //    只从 `tool/call` 的 arguments 里抽。
            //
            //    但事件到达顺序是反的 —— `system/task_started` 同步处理，
            //    而那条带 Agent 工具调用的 assistant 消息走异步保序链
            //    （`toDshBlocks` 里有 await）。直接发的话队列还是空的，
            //    shift() 得到 undefined，界面显示成占位值 `claude-code task`。
            //    实测踩过。
            const payload = {
              kind: 'start',
              id: ev.task_id,
              toolUseId: ev.tool_use_id,
              description: ev.description,
              subagentType: ev.subagent_type,
              background: ev.is_backgrounded === true,
              prompt: typeof ev.prompt === 'string' ? ev.prompt : undefined,
            }
            chain = chain.then(() => {
              try { onSubagent(payload) } catch (err) { log('onSubagent(start) 抛错:', String(err)) }
            }).catch((err) => { log('subagent start 链失败:', String(err)) })
          }
          else if (st === 'task_progress' && typeof ev.task_id === 'string') {
            const payload = {
              kind: 'progress',
              id: ev.task_id,
              toolUseId: ev.tool_use_id,
              description: ev.description,
              lastTool: ev.last_tool_name,
              usage: ev.usage,
            }
            // ⚠️ 也排队。理由和 start 一样（见上），而且更要紧：
            //    这个分支要往 store 里写 tokens，若抢在 start 之前跑，
            //    队友行还没建立，store 里根本没有这个 id，写了个空。
            chain = chain.then(() => {
              try { onSubagent(payload) } catch (err) { log('onSubagent(progress) 抛错:', String(err)) }
            }).catch((err) => { log('subagent progress 链失败:', String(err)) })
          }
          else if (st === 'task_updated' && typeof ev.task_id === 'string') {
            const patch = ev.patch ?? {}
            // `status` 只在**终态**时才有意义；running 的 patch 不带它。
            if (typeof patch.status === 'string' &&
                patch.status !== 'running' && patch.status !== 'pending') {
              // ⚠️ **别在这里直接发 end。**
              //
              // claude 的终态会连着来两条：
              //   task_updated      { status:'completed', end_time }   ← 只有状态
              //   task_notification { status, summary, usage }          ← 有产出和用量
              //
              // 而 dsh-TUI 的落定是**幂等**的（store.finish 见到已落定就直接
              // return），所以先发的那条赢了 —— 拿到的是一条**没有 summary**
              // 的 end，详情页「摘要」页于是显示「暂无摘要」。实测踩过。
              //
              // 所以这里只**登记**，等 notification 来了一起发；notification
              // 万一不来（非后台任务等情形），用兜底定时器补一条。
              pendingEnds.set(ev.task_id, {
                status: patch.status,
                endedAt: patch.end_time,
              })
              const id = ev.task_id
              const timer = setTimeout(() => {
                const pending = pendingEnds.get(id)
                if (!pending) return          // notification 已经处理掉了
                pendingEnds.delete(id)
                const payload = { kind: 'end', id, status: pending.status, endedAt: pending.endedAt }
                try { onSubagent(payload) } catch (err) { log('onSubagent(兜底 end) 抛错:', String(err)) }
              }, 800)
              timer.unref?.()
            }
          }
          else if (st === 'task_notification' && typeof ev.task_id === 'string') {
            // notification 才是**信息完整**的那条 —— 取消兜底，用它落定。
            pendingEnds.delete(ev.task_id)
            const payload = {
              kind: 'end',
              id: ev.task_id,
              toolUseId: ev.tool_use_id,
              status: typeof ev.status === 'string' ? ev.status : 'completed',
              summary: typeof ev.summary === 'string' ? ev.summary : undefined,
              usage: ev.usage,
            }
            chain = chain.then(() => {
              try { onSubagent(payload) } catch (err) { log('onSubagent(end) 抛错:', String(err)) }
            }).catch((err) => { log('subagent notification 链失败:', String(err)) })
          }
        }

        // ── 增量事件 → 文本流 ────────────────────────────────────────
        //
        // 开了 `--include-partial-messages` 之后 claude 会发 `stream_event`：
        //   { type:'stream_event', event:{ type:'content_block_delta',
        //       index:0, delta:{ type:'text_delta', text:'hi' } } }
        //
        // 我们只关心 text_delta（逐字）和 reasoning 的 thinking_delta。
        // 工具参数的 arguments_delta 也转发，但 UI 目前用不到。
        //
        // 注意：**同一个文本会来两遍** —— 先是一串 text_delta 增量，
        // 然后一条完整的 `assistant` 事件。所以上层必须在收到完整消息时
        // 用它的文本**替换**掉增量拼出来的临时内容，不能追加，
        // 否则界面上的字会翻倍。
        if (ev.type === 'stream_event' && ev.event) {
          const se = ev.event
          // 队友的增量也带 parent_tool_use_id —— 分流出去，别混进主流，
          // 否则队友逐字输出的内容会出现在主对话的流式气泡里。
          const pStream = typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id
            ? ev.parent_tool_use_id
            : null
          if (se.type === 'content_block_delta' && se.delta) {
            const d = se.delta
            // `index` 是 DSH 的 StreamChunk 里**必填**的字段 —— 它标出这个
            // delta 属于消息里的第几个块，用来关联交错的文本/推理/工具参数流。
            // claude 的 `content_block_delta` 也带 `index`，直接透传；没有就退回 0。
            //
            // 踩坑：0.1.x 时代 DSH 的类型定义没导出 StreamChunk，我按 TUI 的
            // 读取代码反推，只给了 `{type, text}` —— 能跑（TUI 只读 .text），
            // 但契约不完整。0.2.0 的 types 里写得很清楚：
            //   { type:'text-delta'; index:number; text:string }
            const blockIndex = typeof se.index === 'number' ? se.index : 0
            if (d.type === 'text_delta' && typeof d.text === 'string' && d.text) {
              if (pStream && onSubagent) {
                // 排队 —— 理由同 message 分支（避免抢在队友行建立之前）
                chain = chain.then(() => {
                  try { onSubagent({ kind: 'chunk', toolUseId: pStream, text: d.text, thinking: false }) } catch { /* ignore */ }
                }).catch(() => {})
              } else {
                try { onChunk?.({ type: 'text-delta', index: blockIndex, text: d.text }) } catch { /* ignore */ }
              }
            } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
              if (pStream && onSubagent) {
                chain = chain.then(() => {
                  try { onSubagent({ kind: 'chunk', toolUseId: pStream, text: d.thinking, thinking: true }) } catch { /* ignore */ }
                }).catch(() => {})
              } else {
                try { onChunk?.({ type: 'reasoning-delta', index: blockIndex, text: d.thinking }) } catch { /* ignore */ }
              }
            }
          }
          // message_start 里带首字延迟，可以喂给 TPS 统计
          if (se.type === 'message_start' && typeof ev.ttft_ms === 'number') {
            try { onActivity?.({ ttftMs: ev.ttft_ms }) } catch { /* ignore */ }
          }
        }

        // ── 把 claude 的 usage 转成 DSH 的形状 ──────────────────────
        //
        // DSH 的 ctx 用量条（dsh-tui 的 StatusLine / ContextBarView）靠
        // `assistant/message` 事件上的 `usage` 字段算：
        //
        //   contextUsed = usage.input + usage.cacheRead + usage.cacheWrite
        //   （见 dsh-tui screens/StatusLine.js:96）
        //
        // 而 projection.js:685 是从 `event.data.usage` 读的，字段名是
        // **camelCase**：
        //   { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
        //
        // claude 那边是 snake_case 且名字不同：
        //   { input_tokens, output_tokens,
        //     cache_read_input_tokens, cache_creation_input_tokens }
        //
        // 不做这层映射，事件里的 usage 是 undefined，
        // 结果就是状态栏永远不显示 ctx 用量。
        if (ev.type === 'assistant' && ev.message?.usage) {
          const u = ev.message.usage
          const toDsh = {
            inputTokens: u.input_tokens ?? u.inputTokens ?? 0,
            outputTokens: u.output_tokens ?? u.outputTokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? u.cacheReadTokens ?? 0,
            // claude 的 cache_creation_* 对应 DSH 的 cacheWrite
            cacheWriteTokens: u.cache_creation_input_tokens ?? u.cacheWriteTokens ?? 0,
          }
          if (toDsh.inputTokens || toDsh.outputTokens || toDsh.cacheReadTokens || toDsh.cacheWriteTokens) {
            latestUsage = toDsh
            log('  usage:', JSON.stringify(toDsh))
          }
        }

        // ── assistant 事件 = 模型的一次完整响应 = DSH 的一个 step ──────
        //
        // 这里把整个 content 数组交给上层，而不是拆成 text/tool_use 两个
        // 回调 —— 因为 DSH 的 assistant/message 必须**一次性**带齐它这一步
        // 产出的所有块（文本 + tool-call 块），拆开就没法构造完整消息了。
        //
        // 块转换走 toDshBlocks（含图片 → attachment 的异步落盘），
        // 所以这里必须**保序**：用一条 promise 链把异步处理串起来，
        // 不能直接 await（那会让 stdout 的处理回调变成 async，
        // 同一批数据里的后续行就可能在 await 期间抢先执行）。
        if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          const raw = ev.message.content
          const usageAtEvent = latestUsage
          // ── 队友的消息分流 ──────────────────────────────────────────
          //
          // 开了 `--forward-subagent-text` 之后，**队友的** assistant 消息
          // 也会出现在同一条 stdout 流里，它们唯一的标记就是
          // `parent_tool_use_id`（= 发起它的那次 Agent 调用的 id）。
          //
          // 不分流的话后果很具体：队友搜了 18 次网页，那 18 条会全部被当成
          // **主会话**的活动渲染成工具卡片 —— 主对话流被队友的活动刷屏，
          // 而真正的队友面板里反而是空的。
          //
          // 所以这里一旦看到 parent_tool_use_id 就走队友通道，不进主流。
          const parentId = typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id
            ? ev.parent_tool_use_id
            : null
          if (parentId && onSubagent) {
            const texts = []
            const tools = []
            for (const b of raw) {
              if (!b || typeof b !== 'object') continue
              if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text)
              else if (b.type === 'thinking' && typeof b.thinking === 'string') texts.push(b.thinking)
              else if (b.type === 'tool_use' && typeof b.name === 'string') {
                tools.push({ id: b.id, name: b.name, args: b.input })
              }
            }
            const payload = {
              kind: 'message',
              toolUseId: parentId,
              text: texts.join('\n'),
              tools,
              // ── 队友**实际用的模型** ─────────────────────────────
              //
              // claude 的每条 assistant 消息都带 `message.model`，队友的
              // 也一样（实测队友 transcript 里是 `claude-sonnet-4-5`）。
              //
              // 为什么必须从这儿拿：dsh-TUI 建队友行时调
              //   store.onSpawned(info.id, info.provider || 'subagent',
              //                   info.provider, {...})
              //                    ↑ provider              ↑ **这个位置是 model**
              // 第二、三个参数分别是 provider 和 model，而那种情况下两个都
              // 填的是 `info.provider` —— 我们报的 provider 是 `claude-code`，
              // 于是卡片上模型也显示成 `claude-code`（看起来像模型名，
              // 其实是 provider 名）。
              //
              // 事件本身**传不了** model（`subagent/start` 的 payload 里没这个
              // 字段，projection 也不会读），所以只能拿到 store 后直接补。
              model: typeof ev.message?.model === 'string' ? ev.message.model : undefined,
            }
            // ⚠️ **必须排队**（踩过的竞态）：
            //
            // `task_started` 的 start 回调排在保序链上，而这条转发消息如果
            // 同步处理，就会**抢在队友行建立之前**到达 —— 那时
            // `byToolUse` 里还没有映射（或者 store 里还没有这个队友 id），
            // 于是队友说的话**直接被丢掉**，「输出」页一片空白。
            //
            // 排进同一条链，顺序就还原成事件本来的顺序。
            chain = chain.then(() => {
              try { onSubagent(payload) } catch (err) { log('onSubagent(message) 抛错:', String(err)) }
            }).catch((err) => { log('队友消息链失败:', String(err)) })
          }
          else {
            chain = chain.then(async () => {
              const blocks = await toDshBlocks(raw, attachments)
              if (blocks.length > 0) {
                // usage 和内容块一起交出去 —— ctx 用量条要的是**最近一次请求**
                // 的占用，正好和这条 assistant 消息同源。
                try { onAssistant?.(blocks, usageAtEvent) } catch (err) { log('onAssistant 抛错:', String(err)) }
              }
            }).catch((err) => { log('块转换失败:', String(err)) })
          }
        }

        // ── 工具结果 ────────────────────────────────────────────────
        //
        // claude 把 tool_result 放在 **user 角色**的 message 里（工具结果回灌
        // 给模型时算用户侧输入），别被 `type === 'user'` 迷惑。
        // 工具结果里可能有图片（Read 工具读图），同样要落盘 + 保序。
        if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
          // 队友的工具结果同样带 parent_tool_use_id —— 一起分流，
          // 否则队友的每条工具结果都会在主对话流里冒出一张卡。
          const pUser = typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id
            ? ev.parent_tool_use_id
            : null
          for (const b of ev.message.content) {
            if (b.type === 'tool_result' && b.tool_use_id) {
              if (pUser && onSubagent) {
                const payload = {
                  kind: 'toolResult',
                  toolUseId: pUser,
                  resultId: b.tool_use_id,
                  isError: b.is_error === true,
                  content: typeof b.content === 'string' ? b.content : undefined,
                }
                // 排队 —— 同上，避免抢在队友行建立之前
                chain = chain.then(() => {
                  try { onSubagent(payload) } catch (err) { log('onSubagent(toolResult) 抛错:', String(err)) }
                }).catch(() => {})
                continue
              }
              const payload = { id: b.tool_use_id, content: b.content, isError: b.is_error === true }
              chain = chain.then(async () => {
                try { onToolResult?.(payload) } catch (err) { log('onToolResult 抛错:', String(err)) }
              }).catch((err) => { log('工具结果处理失败:', String(err)) })
            }
          }
        }
      }
    }
    child.stdout.on('data', feedStdout)

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const l of chunk.split(/\r?\n/)) {
        const t = l.trim()
        if (!t) continue
        if (stderrLines.length >= STDERR_MAX) { stderrDropped++; continue }
        stderrLines.push(t)
      }
    })

    child.on('error', (err) => done({ ok: false, error: err.message }))

    child.on('close', async (code) => {
      // ── 先 flush 最后一行残料（关键）────────────────────────────
      //
      // `--output-format stream-json` 的行**不保证以换行结尾** —— claude 写完
      // 最后一条 `result` 帧后可能直接退出，没有尾随 `\n`。而 `feedStdout`
      // 靠「切到换行才成行」工作，所以那份残料会**永远留在 outBuf 里**。
      //
      // 后果：`result` 帧丢失 → `!result` 分支命中 → 整轮被报成
      // 「claude 退出 code=0 且无 result」→ 界面上明明有回复却说这一轮失败，
      // 而且**会话映射也存不下来**（映射是从 result.session_id 取的），
      // 于是下一轮又是新会话、历史连不上。
      //
      // 这个 bug 只在「最后一行恰好没换行」时发作，所以时好时坏 ——
      // 属于最难受的那类。无条件 flush 一次即可，多喂一个空串也无害。
      if (outBuf !== '') {
        log('  flush stdout 残行:', outBuf.length, '字节')
        try {
          const flushed = flushNdjson(outBuf)
          outBuf = ''
          for (const line of flushed.lines) feedStdout(line + '\n')
        } catch (err) { log('  flush 失败:', String(err)) }
      }

      // 再等保序链清空 —— 最后一批块转换（可能还在落图片）必须落完，
      // 否则上层的 turn 收尾会跑在 assistant/message 之前，
      // 事件顺序就反了（表现为"回复出现在 turn/end 之后"）。
      try { await chain } catch { /* 链上已有 catch，这里只防御 */ }

      // 记住 claude 分配的真实 UUID —— 下一轮靠它续接。
      // 限流、工具失败、用户 Esc 时 stdout 里往往仍带着 session_id；
      // 以前 cancel 提前 return，映射不写，下一轮不带 --resume，
      // 界面上还有旧 transcript，模型却像失忆。
      const mapped = mappingIdFromResult(sessionId, {
        session_id: result?.session_id ?? seenClaudeSid,
      })
      if (mapped && await persistMapEntry(sessionId, mapped)) {
        log('记录映射:', sessionId, '->', mapped)
      }

      // 被中止的情况：没有 result 是正常的，不是错误。
      // 标成 ok:false + cancelled:true，让上层把 turn 收成 aborted。
      if (cancelled) {
        done({ ok: false, cancelled: true, error: '已中断', stderr: stderrLines })
        return
      }
      if (!result) {
        done({ ok: false, error: stderrLines[0] ?? `claude 退出 code=${code} 且无 result`, stderr: stderrLines })
        return
      }
      const okFlag = result.is_error !== true

      done({
        ok: okFlag,
        text: typeof result.result === 'string' ? result.result : '',
        // 优先用逐条 assistant 事件里攒的 usage —— 它描述的是**当前上下文**。
        // result.usage 是整个 --print 调用的累计值，语义不同，只作兜底。
        usage: latestUsage ?? (result.usage ? {
          inputTokens: result.usage.input_tokens ?? 0,
          outputTokens: result.usage.output_tokens ?? 0,
          cacheReadTokens: result.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: result.usage.cache_creation_input_tokens ?? 0,
        } : undefined),
        cost: result.total_cost_usd,
        sessionId: result.session_id,
        // ── 真实的上下文窗口容量 ────────────────────────────────────
        //
        // **claude 自己会报**，在 result 帧的 `modelUsage` 里：
        //
        //   "modelUsage": {
        //     "claude-sonnet-4-5": {
        //       "contextWindow": 256000,        ← 就是这个
        //       "maxOutputTokens": 32000,
        //       "canonicalModel": "claude-sonnet-4-5",
        //       ...
        //     }
        //   }
        //
        // 本机实测这个模型报的是 **256000**，而之前写死的默认值是 200000
        // —— 状态栏那条 ctx 条一直按 200k 算百分比，对不上。
        //
        // 为什么要在这里取而不是 init 帧：init 里**没有**这个字段
        // （只有 model / tools / mcp_servers / skills）。result 帧才有。
        contextWindow: readModelUsageEntry(result)?.contextWindow,
        error: okFlag
          ? undefined
          : (stderrLines.find((l) => !/^\[claude-code:/.test(l)) ?? result.subtype)
            // stderr 被截断时补一句，免得排查时以为"就这么多输出"
            + (stderrDropped > 0 ? `（另有 ${stderrDropped} 行 stderr 因超限被丢弃）` : ''),
      })
    })

    try {
      child.stdin.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      }) + '\n', 'utf8')
      child.stdin.end()
    } catch (err) {
      done({ ok: false, error: `写 stdin 失败: ${err.message}` })
    }
  })
}

export function apply(ctx, config = {}) {
  // ⚠️ 这里**不再**捕获 cwd —— 每个 agent 的工作目录由 `resolveAgentCwd()`
  //    各自解析（优先跟随宿主的 `options.meta.cwd`）。
  //    早先在这里写 `const cwd = config.cwd ?? process.cwd()` 并用闭包传给
  //    所有 agent，导致状态栏（宿主的会话目录）和 claude 实际目录分叉。
  const mode = resolveMode(config)
  log('apply() 被调用；mode =', mode, 'config.cwd =', config.cwd ?? '(未配，将跟随宿主)')

  // host：日常 DeepSeek。只挂 /ccb 和 teammate 工具，绝不 setFactory / 改立绘。
  // tools / commands 不写进 inject（网页端可能晚于本插件才起来），轮询软探测。
  //
  // `/ccb` 必须进 commandList，否则 TUI 当普通消息发给 DeepSeek
  // （用户截图：模型去 Glob 搜 ccb）。commands.register 之后 refreshCommands
  // 会把 external 命令拷进表；host-preload.mjs 赶在 Channel 绑表之前再写
  // LOCAL_COMMANDS，给「register 晚于第一轮刷表」兜底。
  if (mode === 'host') {
    const tryHost = () => installHostSurface(ctx, config, { stateDir: STATE_DIR, log })
    const complete = (r) => r?.command && r?.tools
    // 先补 LOCAL_COMMANDS，再 register：commands/change 触发的 refresh
    // 才能把 /ccb 拷进 commandList。钩子没挂上时这条路径仍能截胡。
    const boot = async () => {
      await installHostSlashIntercept(log)
      return tryHost()
    }
    boot()
      .then((r) => {
        if (r?.command) log('host 面：/ccb 已进注册表', r)
        if (complete(r)) {
          log('host 面就绪', r)
          return
        }
        let tries = 0
        const timer = setInterval(() => {
          tries++
          tryHost()
            .then((again) => {
              if (again?.command && tries === 1) log('host 面：/ccb 已进注册表', again)
              if (complete(again) || tries >= 40) {
                clearInterval(timer)
                log(complete(again)
                  ? 'host 面就绪（第 ' + tries + ' 次探测）'
                  : 'host 面部分就绪', again)
              }
            })
            .catch((err) => {
              clearInterval(timer)
              log('host 面失败：' + String(err))
            })
        }, 250)
      })
      .catch((err) => log('host 面失败：' + String(err)))
    return
  }

  // window / takeover：整窗 Claude。缺外观字段就补上，避免掉回官方女仆。
  config = { ...config, ...windowAppearanceDefaults(config), mode }

  // ── 让状态栏显示我们想要的模型名（可选）────────────────────────
  //
  // 状态栏那个模型名走 `channel.model` ← `state.model` ← `route.model`，
  // 而 route 要过 `validateModelRoute` 一道校验 —— provider 没在 DSH 的
  // llm 运行时注册过的话，整份路由会被打回默认值（于是显示
  // `deepseek-v4.1-flash`，跟实际后端毫无关系）。
  //
  // 解法是给 `claude-code` 这个 provider 注册一个**只作路由声明**的
  // adapter（`ctx.llm.registerAdapter`），让它被认作合法路由。
  // 详见 `src/model-route.mjs` 的文件头。
  //
  // ⚠️ 光注册还不够，**dsh-tui 那行的配置里必须成对写 provider + model**
  //    （`cordis.patch.yml` 里已写）。只有 provider 没有 model 是半配，
  //    会被整份忽略、回落到全局的 `~/.dsh-tui/model.json`。
  //
  // ⚠️ 同步执行（不 await、不 then）—— 必须在 dsh-tui 解析路由**之前**
  //    完成注册，否则校验那一刻 listModels 还是 NO_ADAPTER。
  if (config.model) {
    import('./model-route.mjs')
      .then((m) => m.installModelAdapter(ctx, log, {
        providerId: config.modelProvider ?? 'claude-code',
        modelId: config.model,
        modelName: config.modelDisplayName ?? config.model,
        contextWindow: config.contextWindow,
        // 档位必须包含 claude 实际会用的那一档（探测得来），否则
        // dsh-tui 会「降一档」显示 —— 而 xhigh 不在它自己的标准档序里。
        effortLevels: config.effortLevels,
        effort: config.effort,
      }))
      .then((r) => { modelAdapter = r?.ok ? r : null })
      .catch((err) => log('模型路由注册异常：' + String(err)))
  }

  // ── 斜杠命令透传（默认开）──────────────────────────────────────
  //
  // dsh-TUI 自己的 57 条 `/` 命令会**截胡**同名输入，导致 `/compact` 这类
  // 到不了 claude。这个窗口是给 claude 用的，所以把本地命令表清空，
  // `/` 一律透传。详见 `src/slash-passthrough.mjs`。
  //
  // ⚠️ **必须最早装**：`state.commandList` 初始就指向 `LOCAL_COMMANDS`
  //    那个数组对象，但 `refreshCommands()` 会在启动时重建列表。
  //    虽然清空内容对两者都生效（都是读内容），但早装能保证第一条命令
  //    就已经透传。
  if (config.slashPassthrough !== false) {
    installSlashPassthrough(log).catch((err) => log('斜杠透传异常：' + String(err)))
  }

  // ── 捕获 live Channel（默认开）─────────────────────────────────
  //
  // 用来做几件官方 UI 没提供的事：`/clear` 后归零 ctx 条、清空对话区、
  // 让 `/` 菜单彻底空掉。详见 `src/channel-hooks.mjs` 的文件头。
  //
  // 走的是 dsh-tui 自己的 `host-registry` 接缝（adapter Kernel 的正规入口），
  // 不是 hack 组件或 JSX props。
  if (config.channelHooks !== false) {
    installChannelCapture(ctx, log)
      .then(() => {
        // 菜单抑制要在 Channel 到手之后做 —— 时序原因见 channel-hooks.mjs。
        // 这里用轮询等它（`installChannelCapture` 内部也在轮询，
        // 但它是异步返回的，拿不到"以后才有"的引用）。
        let tries = 0
        const t = setInterval(() => {
          tries++
          const ch = activeChannel()
          if (ch !== undefined) {
            clearInterval(t)
            if (suppressCommandList(ch)) log('  · 已接管 commandList：/ 菜单不再弹出')
          } else if (tries > 150) {
            clearInterval(t)
          }
        }, 100)
      })
      .catch((err) => log('Channel 捕获异常：' + String(err)))
  }

  // ── 队友（子代理）桥接（可选）──────────────────────────────────
  //
  // dsh-TUI 有完整的队友 UI（`Ctrl+A` 面板 + 三页详情），但它只认 DSH 自己的
  // `subagent/*` 事件。claude 的队友是它进程内部的东西 —— 靠 spawn 时的
  // `--forward-subagent-text` 把活动转发出来，再由本插件翻译成 dsh-TUI 认的
  // 事件。详见 `src/subagent-bridge.mjs` 的文件头。
  //
  // 这里只装一个 prototype 钩子（拿到 store 实例做诊断用）；
  // 事件翻译在 mountAgent 里，因为它要拿到 agent 的 dispatch。
  if (config.subagents !== false) {
    // 静态 import 之后再装钩子 —— 保证 `subagentStore()` 在事件处理时
    // 是**同步可调用**的（动态 import 的话引用要等一个微任务才到位）。
    installSubagentBridge(log)
      .then((r) => { if (!r.ok) log('队友桥接未装上（面板会看不到队友）') })
      .catch((err) => log('队友桥接异常：' + String(err)))
  }

  // ── 橙色主题（可选）────────────────────────────────────────────
  //
  // 注册一个暖橙配色到 dsh-TUI 的主题系统。**注册本身不会切换主题** ——
  // 要配上 `DSH_TUI_THEME=cc-bridge:orange` 才生效（见 run.ps1）。
  //
  // 为什么不直接写 `~/.dsh-tui/theme.json`：那是**全局持久化**，会把你
  // 所有 dsh-tui 会话都变橙。用环境变量则只影响带这个启动器的窗口。
  //
  // 优先级（ThemeProvider.js）：theme prop > DSH_TUI_THEME > theme.json > OSC11
  if (config.orangeTheme !== false) {
    import('./theme-orange.mjs')
      .then((m) => m.registerOrangeTheme(ctx, log))
      .catch((err) => log('橙色主题注册异常：' + String(err)))
  }

  // ── 自定义女仆娘立绘（可选）────────────────────────────────────
  //
  // 配了 `maidArt` 就把 dsh-TUI 标题的立绘换成那张图。
  //
  // 关键：**不改 dsh-TUI 的包**。做法是加载它的 `WhaleGirl.js`，
  // 原地改写导出的 `WHALE_GIRL_ROWS` 数组内容 —— `export const` 只约束
  // 绑定不可重赋值，不约束数组内容，而 `WhaleGirlArt` 每次渲染都读它。
  //
  // 所以这是**进程内**的替换：只影响加载了本插件的 dsh 进程，
  // 你别的 dsh-tui 会话照旧用原版立绘。
  //
  // （真图 PNG 那条路只有终端支持 Kitty/Sixel 才走得到，
  //   Windows Terminal 不支持，所以对本机没用 —— 只能换这个字符精灵。）
  if (config.maidArt) {
    // 路径可以是相对的（相对插件根）—— 见 resolveAssetPath。
    const mainArt = resolveAssetPath(config.maidArt)
    const happyArt = resolveAssetPath(config.maidArtHappy)
    import('./maid-art.mjs')
      .then((m) => m.installMaidArt(mainArt, log, happyArt))
      .then((r) => {
        if (!r.ok) log('自定义立绘装载失败：' + r.reason)
      })
      .catch((err) => log('自定义立绘装载异常：' + String(err)))
  }

  // ── 换开屏大字（可选）──────────────────────────────────────────
  //
  // 配了 `splashTitle` / `splashSubtitle` 就把右侧那两排大字
  // （原版 `DEEPSEEK` / `HARNESS`）换掉。
  //
  // 和立绘同理：**不改 dsh-TUI 的包**，而是加载它的 `splashFonts.js`，
  // 原地改写字体表里每款字体的 `tagline`。原理与字形限制见
  // `src/splash-title.mjs` 的文件头。
  //
  // ⚠️ 字库里只有 13 个字母（A D E H I K M N P R S W Y），
  //    用了别的字母会画成方块 —— 模块会明确警告，不让它悄悄糊过去。
  if (config.splashTitle || config.splashSubtitle) {
    import('./splash-title.mjs')
      .then((m) => m.installSplashTitle(config.splashTitle, config.splashSubtitle, log))
      .then((r) => {
        if (!r.ok) log('开屏大字更换失败：' + r.reason)
      })
      .catch((err) => log('开屏大字更换异常：' + String(err)))
  }

  // ── 换开屏欢迎语（可选）────────────────────────────────────────
  //
  // 就是立绘下面那句话（原版「探索未至之境！」）。
  //
  // 文案在 dsh-tui 的 `i18n.js` 字典里，而它导出的 `i18nDict` 与内部的
  // `dict` 是**同一个对象** —— 原地改词条即可生效，`t()` 立刻看到新值。
  // 详见 `src/welcome-tagline.mjs` 的文件头。
  if (config.welcomeTagline) {
    import('./welcome-tagline.mjs')
      .then((m) => m.installWelcomeTagline(config.welcomeTagline, log))
      .then((r) => {
        if (!r.ok) log('开屏欢迎语更换失败：' + r.reason)
      })
      .catch((err) => log('开屏欢迎语更换异常：' + String(err)))
  }

  // ── 品牌名替换（默认开）────────────────────────────────────────
  //
  // 界面里的 `DeepSeek` → `Claude`、`鲸鱼娘` → `Claude娘`。
  //
  // 只改**纯展示文案** —— 环境变量名（`DEEPSEEK_API_KEY`）、provider id
  // （`deepseek/deepseek-flash`）、配置段名（`llm-deepseek`）一律跳过，
  // 改了反而误导。详见 `src/brand-rename.mjs` 的文件头。
  if (config.brandRename !== false) {
    import('./brand-rename.mjs')
      .then((m) => m.installBrandRename(log))
      .then((r) => {
        if (!r.ok) log('品牌名替换失败：' + r.reason)
      })
      .catch((err) => log('品牌名替换异常：' + String(err)))
  }

  // 软探测所需服务。cordis 的 Service 通过 ctx.get 拿。
  const agents = ctx.get?.('agents', false) ?? ctx.agents
  const sessions = ctx.get?.('sessions', false) ?? ctx.sessions

  log('服务探测: agents=' + (agents ? '有' : '无') + ' sessions=' + (sessions ? '有' : '无'))

  // 诊断：状态栏模型名的覆盖到底有没有传进来。
  // dsh-tui 那行的 config 是**整段替换**的，patch 里漏写就会冲掉原值 ——
  // 所以这里把关键项打出来，一眼能看出有没有生效。
  try {
    const entries = [...(ctx.loader?.entries?.() ?? [])]
    const tuiRow = entries.find((e) => e.options?.id === 'dsh-tui')
    const cfg = tuiRow?.options?.config
    // `!!js` 写法的值是**惰性表达式对象**，直接拼字符串会得到
    // `[object Object]`。能拿到 `.value` 就取它，取不到就 JSON 一下 ——
    // 两者都不是字符串时，说明这一层还没求值（正常，dsh 稍后才算）。
    const show = (v) => {
      if (v === undefined || v === null) return '(无)'
      if (typeof v === 'string') return v
      if (typeof v === 'object' && 'value' in v) return String(v.value)
      return JSON.stringify(v)
    }
    log('dsh-tui 行配置: provider=' + show(cfg?.provider) +
      ' model=' + show(cfg?.model) +
      ' effort=' + show(cfg?.effort) +
      ' whaleGirl=' + show(cfg?.whaleGirl) +
      ' fullscreen=' + show(cfg?.fullscreen))
  } catch (err) {
    log('读 dsh-tui 行配置失败:', String(err))
  }

  if (!agents || !sessions) {
    log('服务未就绪 —— 轮询等待')
    let tries = 0
    const timer = setInterval(() => {
      tries++
      const a = ctx.get?.('agents', false) ?? ctx.agents
      const s = ctx.get?.('sessions', false) ?? ctx.sessions
      if (a && s) {
        clearInterval(timer)
        log('服务就绪（第 ' + tries + ' 次探测）')
        register(a, s, ctx, config)
      } else if (tries >= 60) {
        clearInterval(timer)
        log('服务始终未就绪，放弃。agents=' + !!a + ' sessions=' + !!s)
      }
    }, 500)
    return
  }

  register(agents, sessions, ctx, config)
}

function register(agents, sessions, ctx, config) {
  // 图片落盘用（claude 的 Read 读图 → DSH attachment）。
  // 软探测：拿不到就降级成占位文字，不让整条链路挂掉。
  const attachments = ctx.get?.('attachments', false) ?? ctx.attachments
  log('attachments 服务: ' + (attachments ? '有' : '无（图片会降级成文字）'))
  log('开始注册 factory')

  // scope/agentEvents 是 DSH 核心包提供的，动态加载（原因见文件头的注释）。
  // 放在这里而不是模块顶层，是为了让加载失败只影响 factory 注册，
  // 并在日志里留下明确原因 —— 而不是让整个插件模块 import 失败。
  const ready = (async () => {
    const scopeMod = await loadDshPackage('@deepseek-ai/dsh-scope')
    const agentMod = await loadDshPackage('@deepseek-ai/dsh-agent')
    // ToolCallRecovery（dsh 0.2.0 新增）：官方给的悬空工具调用回收器。
    // 替代我手写的 callSeqs/resolvedCalls 那套 —— 它更严谨：
    // 跟踪 step/turn 边界、按 assistant 顺序产出、复用事件时间戳。
    // 见 dsh-session 的 repair.d.ts。
    const sessionMod = await loadDshPackage('@deepseek-ai/dsh-session')
    if (typeof scopeMod.createScope !== 'function') throw new Error('dsh-scope 没有导出 createScope')
    if (typeof agentMod.agentEvents !== 'function') throw new Error('dsh-agent 没有导出 agentEvents')
    log('核心包已加载: createScope + agentEvents' +
      (typeof sessionMod.ToolCallRecovery === 'function' ? ' + ToolCallRecovery' : '（无 ToolCallRecovery，退回手写回收）'))
    return {
      createScope: scopeMod.createScope,
      agentEvents: agentMod.agentEvents,
      ToolCallRecovery: typeof sessionMod.ToolCallRecovery === 'function'
        ? sessionMod.ToolCallRecovery
        : null,
    }
  })().catch((err) => {
    log('核心包加载失败:', String(err))
    return null
  })

  // followup 里的文本要取出来发给 claude
  const textOf = (message) => {
    const c = message?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).filter(Boolean).join('\n')
    }
    return ''
  }

  /**
   * 解析**这个 agent** 该用哪个工作目录。
   *
   * ════════════════════════════════════════════════════════════════════
   * 为什么是 per-agent，不是插件级
   * ════════════════════════════════════════════════════════════════════
   *
   * 原先在 `apply()` 里 `const cwd = config.cwd ?? process.cwd()` 捕获一次，
   * 然后闭包传给所有 agent —— 那是错的，因为**每个 agent 有自己的会话目录**。
   *
   * 后果（用户发现的）：状态栏显示 `D:\code\cc-bridge`（dsh-TUI 的会话目录），
   * 而 claude 实际在 `D:\code\playground` 干活（我写死的 config.cwd）——
   * 界面上出现两个目录，看着像 bug。
   *
   * ── 优先级 ─────────────────────────────────────────────────────────
   *
   *   ① `options.meta.cwd`  —— **宿主传下来的会话目录**（首选）
   *   ② `config.cwd`        —— 手动覆盖（沙盒/特殊场景才用）
   *   ③ `process.cwd()`     —— 兜底（headless 等没有 meta 的宿主）
   *
   * ① 是哪来的：dsh-tui 建 agent 时带上了它
   *     （`dsh-adapter/plugin.js:414` 的 `const meta = { cwd: sessionCwd }`
   *      → `:1666` 的 `ctx.agents.create({ sessionId, meta })`）。
   * 实测能拿到（日志里 `meta.cwd = D:\code\cc-bridge`）。
   *
   * 所以默认行为是**跟随宿主** —— 换项目目录零配置，且状态栏与 claude 一致。
   * 想固定成别的目录（比如沙盒）就在 config 里写 `cwd` 显式覆盖。
   */
  const resolveAgentCwd = (options) => {
    const mailboxId = mailboxIdFromEnv()
    let mailboxCwd
    if (mailboxId) {
      try { mailboxCwd = readMailbox(STATE_DIR, mailboxId)?.cwd } catch { /* ignore */ }
    }
    return resolveWindowCwd({
      metaCwd: options?.meta?.cwd,
      configCwd: config.cwd,
      mailboxCwd,
      processCwd: process.cwd(),
    })
  }

  /** 构造一个由 claude 驱动的 Agent */
  const mountAgent = (pluginCtx, session, options, core, attachments) => {
    let idle = Promise.resolve()
    let turnCounter = 0
    // 官方 whenIdle 跟 activityDone。维护结束 nudge 出新一轮时，
    // 把那一轮接到当前活动后面，调用方才不会在维护刚完时误以为闲了。
    const followActivity = (p) => {
      const next = Promise.resolve(p).then(() => undefined, () => undefined)
      const prev = idle
      idle = prev.then(() => next)
    }
    // 本 agent 的工作目录 —— 每个 agent 各自解析（见 resolveAgentCwd）。
    const cwd = resolveAgentCwd(options)
    // 是否有回合/维护任务在跑 —— runMaintenance 的占用判定用。
    // 官方 Agent 的 status 也是由这个派生的（idle/running）。
    let busy = false
    let maintaining = false
    // 先声明，cancel 才能在 queue 建好之前把引用闭包进去。
    let queue = null

    // ── 先建 agent 对象，再建 scope ──────────────────────────────────
    //
    // 两个坑都在这一行上，记下来：
    //
    // ① scope 的 key 必须是**对象**，不能是字符串。
    //    写 `createScope(ctx, session.id)` 会报
    //      TypeError: Invalid value used as weak map key
    //        at linkScopeParent (dsh-scope/lib/index.js:243)
    //    因为 dsh-scope 内部用 `new WeakMap()` 存父链（scopeParents），
    //    WeakMap 的键只能是对象。官方 agent-loop 传的是 agent 实例
    //    （agent.ts:130 `createScope(loopCtx, this)`）。
    //
    // ② scope 的**父 ctx 必须是插件自己的 ctx，不是 ownerCtx**。
    //    这是最绕的一个：传 ownerCtx（dsh-tui 给的）时，setup 阶段报
    //      cannot get property "subagents" without inject
    //    查 cordis 源码（lib/index.js:676）才明白 —— ctx 是 Proxy，
    //    **只有父级声明过 inject 的属性才能访问**。而 inject 是「插件级」
    //    声明：我在自己插件上写 inject 影响不到 ownerCtx（dsh-tui 的上下文），
    //    所以子 scope 继承过去照样缺 subagents。
    //    改成用 pluginCtx（本插件的 ctx，声明了 subagents）做父级即可。
    //
    // 所以顺序是：先有 agent 骨架 → 用 pluginCtx mint scope → 把 ctx 接回去。
    const agent = {
      id: session.id,
      options: options?.agentOptions ?? {},
      session,
      status: 'idle',
      inbox: null,
      runMaintenance: null,
      send: () => {},
      steer: () => {},
      inject: () => {},
      followup: () => {},
      whenIdle: () => idle,
      cancel: () => {},
    }

    // ── 中止 ────────────────────────────────────────────────────────
    //
    // TUI 的 `esc 中断`、`/stop`、以及切换会话时的清理都会走这里
    // （调用点见 dsh-tui 的 input-actions.js:88/111、agent-view-projection.js:209）。
    //
    // 需要做三件事，缺一界面就会卡在"运行中"：
    //   ① 杀掉 claude 子进程（连进程树）
    //   ② 把 turn 收成 aborted —— 否则 TUI 一直转圈
    //   ③ 结束还开着的流式 attempt
    //
    // `cause` 是 AgentCancelCause（如 `{kind:'user'}`）。
    // `options.keepInbox`：Esc 无排队时 TUI 传 true，排队/steer 留给下一轮；
    // rewind / interruptAndDeliver 不传，默认清掉。
    // interruptAndDeliver 随后会把排队重投 followup；官方靠 abort 后的
    // wake latch 立刻开工，所以这里必须先 markAborting。
    let abortActive = null
    let abortMaintenance = null
    let turnAbort = null

    agent.cancel = (cause, options) => {
      log('cancel() cause=' + JSON.stringify(cause ?? null),
        options?.keepInbox ? 'keepInbox' : '')
      queue?.markAborting()
      if (!options?.keepInbox) queue?.clear()
      try { turnAbort?.abort(cause ?? { kind: 'user' }) } catch (err) { log('abort turn signal 失败:', String(err)) }
      const m = abortMaintenance
      if (m) {
        try { m.abort(cause ?? { kind: 'user' }) } catch (err) { log('abort maintenance 失败:', String(err)) }
      }
      const a = abortActive
      if (!a) {
        if (!m) log('  （当前没有在跑的 turn）')
        return
      }
      try { a() } catch (err) { log('abort 调用失败:', String(err)) }
    }


    const scope = core.createScope(pluginCtx, agent)
    const agentCtx = scope.ctx
    const dispatch = core.agentEvents(pluginCtx, agent)

    // claude 的 init 信息（模型名、工具清单、MCP、技能）。
    // 声明在这一层的原因：onInit 回调在 followup 里跑，
    // 而数据来自 runClaude 的事件循环 —— 两者作用域不同。
    // 早先声明在 runClaude 内部，直接 ReferenceError。
    let initInfo = null

    // claude 实报的上下文窗口容量 —— 来自每轮 result 帧的 `modelUsage`。
    //
    // 为什么不能直接用配置值：那个是**猜**的（默认 200k），而 claude 知道
    // 真实值（本机这个模型是 256000）。但事件顺序是「先发 request/context、
    // 后收 result」，所以第一轮只能用配置值兜底，学到真的之后固化成
    // `learnedContextWindow`，从第二轮起一直用它。
    let learnedContextWindow = null

    // 流式帧 revision 必须跨 turn 单调递增。
    // TUI 用 `frame.revision <= lastStreamRevision` 直接丢帧，且只在
    // 换会话 / 投影重置时把 lastStreamRevision 置回 -1。
    // 以前写在 runTurn 里每轮从 0 起，第二轮起整段增量被静默丢掉。
    let streamRevision = 0

    // ════════════════════════════════════════════════════════════════
    // 队友（子代理）→ dsh-TUI 的队友面板
    // ════════════════════════════════════════════════════════════════
    //
    // dsh-TUI 有一套完整的队友 UI（`Ctrl+A` 面板 + 三页详情 + 转录内联卡），
    // 但它只认 DSH 自己的 `subagent/*` 事件族。claude 的队友是它**进程内部**
    // 的东西，不转发就完全不可见。
    //
    // 数据来源有两路，缺一不可：
    //
    //   ① `system/task_*` 系列 —— 队友的 id、描述、token、耗时、终态
    //   ② 带 `parent_tool_use_id` 的消息 —— 队友说了什么、调了什么工具
    //
    // 两路的**关联键不一样**：① 用 `task_id`（稳定 id），② 用
    // `tool_use_id`（发起它的那次 Agent 调用）。所以要维护一张
    // toolUseId → taskId 的映射，才能把 ② 的内容挂到 ① 建立的行上。
    //
    // ── 事件怎么发 ──────────────────────────────────────────────────
    //
    // 走 `dispatch.emit('subagent/start' | 'subagent/end', ...)`。实测这两条
    // 在 `dsh-scope` 的 scoped-events 表里 resolver 是 `null` —— 意思是
    // **只校验「有 scope carrier」，不校验 subject 一致**，所以用主 agent 的
    // dispatch 发就合法，不会触发 invariant。
    //
    // ── 输出怎么进去 ────────────────────────────────────────────────
    //
    // dsh-TUI 的 store 有两级关联：
    //   · `onSpawned(id)` 建立队友行 —— **这一级我们够得着**
    //   · `linkSession(id, session)` 把**子会话对象**当 key 记进
    //     `sessionToAgent`，之后 `session/event` 到达时靠它查到队友
    //
    // 第二级走不通：`onStart` 内部调 `deps.lookupChild(info.id)`，也就是
    // `ctx.agents.get(taskId)` —— 而 claude 的队友**不是 DSH Agent**，
    // 查不到，于是 `linkSession` 被跳过。
    //
    // 好在 `onStart` 里那句注释写明了这是**可选增强**：
    //     catch { /* child enrichment is optional; the spawn remains visible */ }
    //
    // 所以：直接写 store（够得着），再直接写**快照**（见下）。
    const subagents = new Map()        // taskId → { toolUseId, description, ... }
    const byToolUse = new Map()        // toolUseId → taskId

    /**
     * 把队友的补丁同时写进 store 和 **UI 快照**。
     *
     * ════════════════════════════════════════════════════════════════
     * 为什么不能只写 store（绕了一大圈才明白）
     * ════════════════════════════════════════════════════════════════
     *
     * dsh-TUI 的数据流是**两级**的：
     *
     *     store（真相）──syncNow()──▶ state.subagents（快照）──▶ UI
     *
     * 我原以为"改 store 再触发 syncNow"就行，办法是发一条无害的
     * `request/context`。**那条路根本走不通** —— `subagent-projection.js:193`：
     *
     *     const onSessionEvent = (session, event) => {
     *       let id = store.getSubagentIdBySession(session);
     *       if (id === undefined) return false;   // ← 在这就返回了
     *       ...
     *       syncNow();                            // ← 永远走不到
     *     }
     *
     * 它要求 session 能关联到某个队友 —— 而 **claude 的队友没有 DSH 子会话**
     * （那正是本项目要桥接的东西），所以永远匹配不上，`syncNow()` 从没跑过。
     *
     * 表现是最迷惑的那种：**store 里的值确实改了**（读回验证能过），
     * 界面纹丝不动。
     *
     * ── 解法 ────────────────────────────────────────────────────────
     *
     * 既然已经拿到 Channel（= `state`，靠 preload 的源码改写），而 UI 读的
     * 就是 `state.subagents` / `state.rows[].subagent` —— **直接改快照**。
     * 不需要 syncNow，不需要子会话。
     *
     * store 仍然要写：它是"真相"，别的消费方（费用统计等）读它，而且
     * 万一将来 syncNow 真的跑了，快照会从 store 重建（那时 store 里
     * 已经是新值，不会被覆盖回旧的）。
     *
     * @param taskId 队友 id
     * @param patch  要合并的字段
     */
    const applySubagentPatch = (taskId, patch) => {
      let mirrored = 0
      for (const st of subagentStoresHolding(taskId)) {
        try {
          st.patch?.(taskId, patch)
          mirrored += mirrorSubagent(taskId, st.states?.get?.(taskId), patch)
        } catch { /* ignore */ }
      }
      // store 一份都没捕获到时，至少把补丁打进快照
      if (mirrored === 0) patchSubagentSnapshot(taskId, patch)
    }

    const onSubagent = (msg) => {
      try {
        if (msg.kind === 'start') {
          subagents.set(msg.id, {
            id: msg.id,
            toolUseId: msg.toolUseId,
            description: msg.description ?? 'subagent',
            startedAt: Date.now(),
          })
          if (msg.toolUseId) byToolUse.set(msg.toolUseId, msg.id)
          log('  队友 start:', msg.id, JSON.stringify(msg.description ?? ''))
          // 建立队友行。`provider` 决定卡片上显示的来源标签。
          //
          // ⚠️ 顺序由 runClaude 保证（它把这次回调排进了保序链）——
          //    必须等那条带 Agent 工具调用的 assistant 消息 append 完，
          //    dsh-TUI 才能从 `tool/call` 的 arguments 里取到描述。
          //    详见 runClaude 里 onSubagent 的调用点。
          dispatch.emit('subagent/start', {
            id: msg.id,
            provider: 'claude-code',
            runId: msg.id,
            local: false,
          })
          // dsh-TUI 的 store 实例（由 subagent-bridge 的 prototype 钩子捕获）。
          // 拿到它就能补 tokens / 工具数 —— 这两项住在 store 里，走不了事件。
          //
          // ⚠️ 必须**同步**取。踩过：先前写成 `import(...).then(m => ref = ...)`，
          //    而 `import()` 即使命中缓存也是异步的 —— progress 事件到时 ref
          //    还是 null，于是 tokens 一直显示 `--`。
          log('  store 捕获状态:', subagentStores().length > 0
            ? `已捕获 ${subagentStores().length} 份`
            : '未捕获（onSpawned 没被调到？）')

          // ── 立刻把模型改成真实值 ────────────────────────────────────
          //
          // 上面那条 `subagent/start` 让 dsh-TUI 建行时把 provider 同时当成了
          // model（见 subagent-projection.js:378），所以这里马上纠一次。
          //
          // 用 `initInfo.model`（claude 在 `system/init` 里报的**真实模型**，
          // 实测 `claude-sonnet-4-5`）—— 它在本轮开始前就到了，所以
          // 队友卡片一出现就是对的，不用等第一条消息。
          //
          // 后面每条转发消息还会用 `message.model` 再校一次（更精确，
          // 万一队友用了不同的模型）。
          const modelNow = initInfo?.model
          if (modelNow) {
            // 同时写 store 和 UI 快照 —— 只写 store 界面不会动，见
            // `applySubagentPatch` 的说明。
            applySubagentPatch(msg.id, { model: modelNow })
            // 读回验证 —— 光看"调用没抛错"不算成功，要看到值真的变了
            const readBack = subagentStoresHolding(msg.id)
              .map((s) => s.states?.get?.(msg.id)?.model)
              .join(' | ')
            log('  队友初始模型:', msg.id.slice(0, 8),
              '→', modelNow, `（store 读回: ${readBack || '无'}）`)
          } else {
            log('  队友初始模型: initInfo.model 还没到，等第一条转发消息')
          }
        }
        else if (msg.kind === 'progress') {
          const u = msg.usage
          if (u) {
            log('  队友 progress:', msg.id,
              'tokens=' + (u.total_tokens ?? '?'),
              'tools=' + (u.tool_uses ?? '?'),
              'ms=' + (u.duration_ms ?? '?'),
              msg.lastTool ? 'last=' + msg.lastTool : '')
            // ── 补 tokens ───────────────────────────────────────────
            //
            // tokens 只有 store 里有，而 store 只在收到**子会话**的
            // `session/event` 时才更新 —— claude 的队友没有 DSH 子会话，
            // 那条路是断的（详见 src/subagent-bridge.mjs 文件头）。
            //
            // 走 `applySubagentPatch` —— **store 和 UI 快照一起写**。
            // 只写 store 界面不会动（原因见该函数的注释：syncNow 那条路
            // 因为"没有子会话"而永远走不到）。
            //
            // 工具**不在这里补** —— 真实工具名走 `message` 分支逐条记，
            // 这里只补 token。早先按 `tool_uses` 计数补占位条目，结果是
            // 假名字（`WebSearch`×5）和真名字混在一起重复计数。
            const total = u.total_tokens
            if (typeof total === 'number') {
              for (const st of subagentStoresHolding(msg.id)) {
                try { st.setTokens?.(msg.id, { total }) } catch { /* ignore */ }
              }
              applySubagentPatch(msg.id, {})
            }
          }
        }
        else if (msg.kind === 'end') {
          log('  队友 end:', msg.id, msg.status ?? '?',
            msg.usage ? `tokens=${msg.usage.total_tokens ?? '?'} ms=${msg.usage.duration_ms ?? '?'}` : '')
          dispatch.emit('subagent/end', {
            id: msg.id,
            runId: msg.id,
            // dsh-TUI 按 `stopReason` 分流到 onCompleted / onCancelled / onFailed。
            // 它认的是 `completed` / `cancelled` / `aborted`，其它一律走 failed。
            stopReason: msg.status === 'completed' ? 'completed'
              : (msg.status === 'cancelled' || msg.status === 'aborted') ? 'cancelled'
                : 'failed',
            // 这段会成为队友详情页「摘要」页的内容 —— 也是**唯一**能把队友
            // 产出送进去的通道（逐条对话走不通，见上面的说明）。
            lastAssistantMessage: msg.summary ? [{ text: msg.summary }] : undefined,
          })
          // 落定后**镜像一次** —— 让面板立刻显示完成状态、耗时和摘要。
          // （`subagent/end` 事件会让 dsh-TUI 自己 syncNow，但那条路需要
          //  子会话关联，对 claude 的队友是断的，所以还得自己来。）
          for (const st of subagentStoresHolding(msg.id)) {
            mirrorSubagent(msg.id, st.states?.get?.(msg.id), {})
          }
          // 用量单独补：`store.onSpawned` 不接 usage，而 `subagent/end` 的
          // payload 里也没有这个字段 —— claude 给了就得自己留着。
          const info = subagents.get(msg.id)
          if (info?.toolUseId) byToolUse.delete(info.toolUseId)
          subagents.delete(msg.id)
        }
        // ══════════════════════════════════════════════════════════
        // 队友的**逐条内容** —— 详情页「输出」页和「工具」页的数据源
        // ══════════════════════════════════════════════════════════
        //
        // 这些消息靠 `parent_tool_use_id` 关联到队友（实测它和
        // `task_started` 的 `tool_use_id` **逐字符相同**，包括那串复合
        // 后缀，所以映射可靠）。
        //
        // 直接写 store —— 没有子会话，走不了 `session/event` 那条正道。
        // 写法和 store 内部一致：
        //   · 文本/思考 → `appendOutput`（它会自动把同 kind 的连续增量
        //     拼成一行，正是流式文本要的效果）
        //   · 工具调用 → `recordTool`（**用真实的工具名**）
        else if (msg.kind === 'message') {
          const taskId = msg.toolUseId ? byToolUse.get(msg.toolUseId) : undefined
          if (!taskId) return
          // **每一份持有者都写** —— 见 subagentStoresHolding 的说明
          const holders = subagentStoresHolding(taskId)
          if (holders.length === 0) return
          let touched = false

          for (const st of holders) {
            // ── 补上队友**实际用的模型** ──────────────────────────────
            //
            // 为什么事件传不了：dsh-TUI 建队友行时是
            //   store.onSpawned(info.id, info.provider || 'subagent',
            //                   info.provider, {...})
            //                    ↑ provider              ↑ **这个位置是 model**
            // 两个参数都拿到 `info.provider`，而我们报的 provider 是
            // `claude-code` —— 于是卡片上的「模型」显示成 `claude-code`。
            //
            // `subagent/start` 的 payload 里根本没有 model 字段（projection 也
            // 不读），所以只能拿到 store 之后用 `patch()` 直接改。
            //
            // claude 每条 assistant 消息都带 `message.model` —— 队友的也一样，
            // 那是**真实模型名**（实测 `claude-sonnet-4-5`）。
            if (msg.model) {
              try {
                if (st.states?.get?.(taskId)?.model !== msg.model) {
                  st.patch?.(taskId, { model: msg.model })
                  touched = true
                }
              } catch (err) { log('  patch(model) 失败:', String(err)) }
            }

            if (msg.text) {
              try {
                st.appendOutput?.(taskId, msg.text, 'text')
                touched = true
              } catch (err) { log('  appendOutput 失败:', String(err)) }
            }
            for (const t of msg.tools ?? []) {
              try {
                st.recordTool?.(taskId, {
                  ...(t.id ? { id: t.id } : {}),
                  name: t.name,
                  status: 'completed',
                  startedAt: Date.now(),
                  endedAt: Date.now(),
                  // `argsPreview` 是「工具」页显示的那行参数
                  ...(t.args ? { argsPreview: JSON.stringify(t.args).slice(0, 400) } : {}),
                })
                touched = true
              } catch (err) { log('  recordTool 失败:', String(err)) }
            }
          }
          // 写完 store 后**镜像进 UI 快照** —— 只写 store 界面不会动。
          if (touched) {
            for (const st of holders) {
              mirrorSubagent(taskId, st.states?.get?.(taskId), {})
            }
          }
        }
        else if (msg.kind === 'chunk' && msg.text) {
          const taskId = msg.toolUseId ? byToolUse.get(msg.toolUseId) : undefined
          if (!taskId) return
          const holders = subagentStoresHolding(taskId)
          for (const st of holders) {
            try {
              st.appendOutput?.(taskId, msg.text, msg.thinking ? 'thinking' : 'text')
              mirrorSubagent(taskId, st.states?.get?.(taskId), {})
            } catch { /* ignore */ }
          }
        }
        // 队友的工具结果 —— 失败时在「输出」页留一条 error 行
        else if (msg.kind === 'toolResult' && msg.isError) {
          const taskId = msg.toolUseId ? byToolUse.get(msg.toolUseId) : undefined
          if (!taskId) return
          for (const st of subagentStoresHolding(taskId)) {
            try {
              st.appendOutput?.(taskId, '工具失败', 'error')
              mirrorSubagent(taskId, st.states?.get?.(taskId), {})
            } catch { /* ignore */ }
          }
        }
      } catch (err) {
        log('onSubagent 处理失败:', String(err))
      }
    }

    // ── 悬空工具调用的官方回收器 ──────────────────────────────────
    //
    // 出错的 step 里，已发出的 `tool/call` 可能永远等不到配对的
    // `tool/result`，卡片就卡在"运行中…"。ToolCallRecovery 是 dsh 0.2.0
    // 提供的权威解法（dsh-session/repair.d.ts）：
    //   · observe(event) 逐条喂事件，内部跟踪 pending 的 call
    //     （step/turn 边界会自动丢弃，不用我操心）
    //   · results() 按 assistant 顺序产出保守的错误结果
    //   · 提交后要把提交的事件再 observe 回去（契约要求）
    // 官方 agent-loop 就是这么用的（commit 6a6f350b94）。
    //
    // 挂在 mountAgent 这一层而不是每个 turn 重建：它要跟整条会话的事件流，
    // 且订阅本身只建一次。拿不到这个类时保持 null，走手写兜底。
    const recovery = core.ToolCallRecovery ? new core.ToolCallRecovery() : null
    if (recovery) {
      try {
        agentCtx.effect(
          () => pluginCtx.on('session/event', (subject, event) => {
            // 只观察本 agent 的会话 —— 一个进程里可能挂着多个
            if (subject !== session) return
            try { recovery.observe(event) } catch (err) { log('recovery.observe 失败:', String(err)) }
          }),
          'cc-bridge.toolCallRecovery',
        )
      } catch (err) {
        log('订阅 session/event 失败，工具回收退回手写:', String(err))
      }
    }

    agent.ctx = agentCtx
    agent.dispatch = dispatch
    agent.scope = scope

    // ── followup：把 dsh 的一条用户消息转成 claude 的一轮 ──────────────
    //
    // 事件结构对齐 dsh-agent-loop（见其 lib/index.js:968 / 682 / 697）：
    //
    //   turn/start {turn}
    //     step/start {turn, step:1}          ← 第 1 次模型请求
    //     user/message
    //     assistant/message  [text?, tool-call*]     ← 带 tool-call 块
    //     tool/call  ...                             ← 每个调用一条
    //     tool/result ...                            ← 配对，带 sourceEventSeqs
    //     step/end
    //     step/start {turn, step:2}          ← 第 2 次请求（把工具结果喂回去）
    //     assistant/message  [最终文本]
    //     step/end
    //   turn/end {turn, reason}
    //
    // **一个 step = 一次模型请求**，这是关键 —— 早先把整轮塞进一个 step，
    // 工具卡片和后续回复挤在一起，语义是错的。
    //
    // 而且现在是**边跑边写**：每收到一个 assistant 事件就立刻 append，
    // 不再等整轮结束才补写，所以工具卡片是实时的。
    //
    // followup / steer 都经 inbox 队列进这里。claimed 由队列发出，
    // 这里不要再发一遍，否则 TUI 会把同一条消息认领两次。
    const runTurn = async (message, ctx = {}) => {
      const text = textOf(message)
      const claimedTurn = typeof ctx.turn === 'number' ? ctx.turn : ++turnCounter

      // 空文本已经 claimed 了。官方空 claimed 会开一轮再立刻 completed；
      // 我们这边没东西给 claude，但 TUI pending 已经靠 claimed 退下。
      if (!text.trim()) {
        log('followup: （空文本，跳过）')
        return
      }
      log('followup:', text.slice(0, 80))

      // ── `/clear` 拦截 ────────────────────────────────────────────
      //
      // claude 在 `--print`（无头）模式下**清不掉上下文**。实测证据：
      //
      //     followup: /clear
      //     usage: {"inputTokens":23697, ...}     ← 上下文一点没降
      //
      // 而且 claude 的 transcript 里明确有
      //     <command-name>/clear</command-name>
      //     <local-command-caveat>...</local-command-caveat>
      // 说明它**认出了**这是命令，但在无头模式下只是把它记成一条本地命令，
      // 真正的"当前会话"由**我们**持有（`claude --resume <uuid>`），
      // claude 那边清不掉 —— 下次 `--resume` 还是把全部历史带回来。
      //
      // 所以这里自己实现：丢开旧 UUID（下一轮不带 `--resume`，claude 会开
      // 全新会话）、清空对话区、归零 ctx 条。三件事一起做才符合 `/clear`
      // 在交互式 claude 里的观感。
      //
      // 队列保证同一时刻只有一轮在跑，所以这里不用再看 busy。
      // 排队里还没 claimed 的 leftover 必须丢掉：否则下一轮会拿着旧上下文
      // 的后续问题去打一个新的 claude 会话。
      if (/^\/clear\s*$/.test(text)) {
        try {
          const leftover = queue.clear()
          if (leftover.length > 0) {
            log('  /clear → 丢弃排队中的', leftover.length, '条')
          }
          const mailboxId = mailboxIdFromEnv()
          if (mailboxId) {
            const leftoverMail = takePending(STATE_DIR, mailboxId)
            if (leftoverMail.length > 0) {
              log('  /clear → 丢弃信箱排队', leftoverMail.length, '条')
            }
            try { setMailboxStatus(STATE_DIR, mailboxId, 'idle', { claudeSid: null }) } catch { /* ignore */ }
          }
          const dropped = await dropMapEntry(session.id)
          if (dropped) {
            log('  /clear → 已丢弃 claude 会话映射:', dropped)
          } else {
            log('  /clear → 本来就没有映射，等于已经是新会话')
          }
          resetSessionState()
          return
        } catch (err) {
          log('/clear 处理失败:', String(err))
          // 失败就往下走，当普通文本发给 claude（至少它会给个回复）
        }
      }

      const turn = claimedTurn
      let step = 1
      let stepOpen = false
      let stepHasContent = false
      let abandonOpenAttempt = () => {}
      const ac = new AbortController()
      turnAbort = ac
      try {

        // toolCallId → tool/call 事件的 seq。
        // tool/result 要靠它做 `sourceEventSeqs`，UI 才配得上卡片。
        // （手写兜底路径用；主路径走下面 mountAgent 层的 ToolCallRecovery）
        const callSeqs = new Map()
        // 已经收到结果的 callId —— 手写兜底时用来找出"悬空"的调用
        const resolvedCalls = new Set()
        // 系统提示只上报一次（每个 turn 重发是浪费）
        let initReported = null

        const openStep = () => {
          if (stepOpen) return
          session.append('step/start', { turn, step })
          stepOpen = true
          stepHasContent = false
        }

        const closeStep = () => {
          if (!stepOpen) return
          session.append('step/end', { turn, step })
          stepOpen = false
        }

        session.append('turn/start', { turn })
        openStep()
        session.append('user/message', message, { surfaceOp: 'append' })

        // ── 告知上下文窗口大小 ──────────────────────────────────────
        //
        // dsh-tui 的 ctx 用量条需要**两个**数：已用（来自 assistant/message
        // 的 usage）和窗口总量。窗口总量走这个事件：
        //   projection.js:984  case 'request/context' → state.contextWindow
        //
        // 另一条路是让 dsh-tui 通过 `llmRuntime.resolveModelInfo(provider,
        // model)` 去查注册表（channel/model-actions.js:45），但我们报的
        // provider 是 'claude-code'，DSH 的模型注册表里没有它，查不到。
        // 所以直接发事件最省事。
        //
        // ── 数值从哪来 ──────────────────────────────────────────────
        //
        // **claude 自己会报** —— 在每轮 result 帧的 `modelUsage` 里（见
        // `readModelUsageEntry`）。实测本机这个模型报 256000，而原先写死的
        // 默认值是 200000，于是 ctx 条的百分比一直是错的。
        //
        // 但时序上有个先有鸡还是先有蛋：`request/context` 要在**开跑之前**
        // 发（条子得先有刻度），而 result 帧在**跑完之后**才到。所以：
        //
        //   · 第一轮用 `config.contextWindow`（或内置默认）
        //   · 拿到 result 后记下真实值，**后续每轮**都用它
        //
        // 也就是说启动后第一轮的数字可能偏保守，从第二轮起就准了。
        // 想第一轮就准，在 cordis.patch.yml 里写死 `contextWindow: 256000`。
        //
        // 每次 turn 都发一次：它是幂等的状态设置，重发无害，
        // 而漏发会导致 /resume 之后条子不显示。
        session.append('request/context', {
          provider: 'claude-code',
          model: config.model ?? 'claude-code',
          contextWindow: learnedContextWindow ?? config.contextWindow ?? 200000,
        })

        // ── 把 claude 的系统提示 + 工具清单报给状态栏 ────────────────
        //
        // hover 展开的分段明细里 `sys` 一项由 `system/message` 事件决定
        // （projection.js:991）：
        //   state.contextSegments.system = estimateTokens(textOf(content))
        //
        // 不报的话 `sys` 永远是 0 —— 而系统提示 + 工具定义恰恰占了
        // 上下文的大头（本机实测：24k 里绝大部分是它们）。
        // 结果就是明细加起来只有几个 token，看着像统计坏了。
        //
        // claude 的 `system/init` 只给工具**名字**（没有 schema），
        // 所以按经验值折算：
        //   · 每个工具 ≈ 名字 + 一份平均大小的 JSON schema
        //   · MCP 工具的 schema 明显更大，按名字前缀区分
        // 估得不准无所谓 —— 分段条本来就是近似值，
        // 关键是别让它显示成 0。
        //
        // 只在拿到 init 之后发一次（每个 turn 重发会浪费日志，
        // 而且 TUI 每次都要重算 estimateTokens）。
        //
        // ⚠️ 时机：**必须放在 runClaude 之后** —— initInfo 是 claude 启动后
        // 才发出来的，turn 开头它还是 null，那时上报会什么都不发。
        // 所以这段逻辑挪到下面 `const r = await runClaude(...)` 之后。

        // ── 流式帧状态 ──────────────────────────────────────────────
        //
        // dsh-tui 0.1.5+ 的实时增量走**瞬态事件** `agent/assistant-stream`，
        // 不是 session 事件（`assistant/chunk` 是 pre-0.1.5 的旧路径，
        // TUI 里注释写明是 legacy）。
        //
        // 帧协议（官方类型 dsh-agent 的 runtime-types.d.ts `AssistantStreamFrame`，
        // dsh 0.2.0 起有导出；TUI 侧见 projection.js renderStreamFrame）：
        //   { type:'start', attemptId, revision, turn, step }
        //   { type:'chunk', attemptId, revision, index, time, chunk:StreamChunk }
        //   { type:'end',   attemptId, revision, index,
        //     outcome: {kind:'committed', eventType, seq} | {kind:'abandoned'} }
        //
        // 四个必须遵守的约束，不然界面上会出乱子：
        // ① `revision` 必须**全局单调递增** —— TUI 用 `frame.revision <=
        //    lastStreamRevision` 直接丢弃，不是按 attempt 分组的。
        // ② `start` 会丢掉上一个未结束的 attempt，所以一个 step 只能有一个。
        // ③ 增量拼出来的只是**临时**内容；durable 的 `assistant/message`
        //    一到，TUI 用它的文本替换（`renderEvent` 里的 settle 逻辑）。
        //    所以绝对不能把完整文本当增量再发一遍，否则字会翻倍。
        // ④ chunk.chunk 是 **StreamChunk**，`text-delta`/`reasoning-delta`
        //    都**必填 `index`**（块在消息里的位置，用来关联交错的 delta）。
        //
        // ⚠️ dsh 0.2.0 同步修正（原先按 0.1.x 猜的，有两处对不上）：
        //   · `end.outcome.kind` 是 **`'committed'`** 不是 `'settled'`，
        //     且 committed 时必须带 `seq`（durable settle 的序号）。
        //   · `end` 帧还要一个 `index`（本 attempt 发出的 chunk 数量）。
        //   TUI 只判 `kind === 'abandoned' || eventType === 'assistant/attempt'`，
        //   所以旧写法**碰巧**能跑，但契约是错的 —— 换实现就会露馅。
        let attemptId = null
        let chunkIndex = 0
        const turnStreamStart = streamRevision

        const emitFrame = (frame) => {
          streamRevision += 1
          try {
            dispatch.emit('agent/assistant-stream', { frame: { ...frame, revision: streamRevision } })
          } catch (err) {
            log('emit assistant-stream 失败:', String(err))
          }
        }

        const startAttempt = (t, s) => {
          attemptId = `cc-${session.id}-${t}-${s}-${Date.now()}`
          chunkIndex = 0
          emitFrame({ type: 'start', attemptId, turn: t, step: s })
        }

        /**
         * 结束当前 attempt。
         * @param outcome `{kind:'committed', eventType, seq}` 或 `{kind:'abandoned'}`
         */
        const endAttempt = (outcome) => {
          if (attemptId === null) return
          emitFrame({ type: 'end', attemptId, index: chunkIndex, outcome })
          attemptId = null
        }
        abandonOpenAttempt = () => endAttempt({ kind: 'abandoned' })

        const r = await runClaude({
          sessionId: session.id,
          cwd,

          // 图片要用（claude 的 Read 读图 → 落成 DSH attachment）
          attachments,

          // 把中止钩子挂到 agent 上 —— Agent.cancel() 通过它杀掉子进程。
          // runClaude 会在结算时自动清掉（done() 里置 null）。
          //
          // 注意这里是「拿到 hook 就存起来」的**接收方**，
          // 真正的 hook 由 runClaude 传进来（见它开头的契约注释）。
          registerAbort: (hook) => { abortActive = hook },
          signal: ac.signal,

          // claude 的 init（模型名、工具清单）→ 喂给状态栏
          onInit: (info) => { initInfo = info },
          text,

          // 队友（子代理）的生命周期与内容 → dsh-TUI 的队友面板。
          // 传了它就等于开了 `--forward-subagent-text`。
          onSubagent,

          // 逐字增量 → 流式帧
          onChunk: (chunk) => {
            if (attemptId === null) startAttempt(turn, step)
            emitFrame({
              type: 'chunk',
              attemptId,
              index: chunkIndex++,
              time: Date.now(),
              chunk,
            })
          },

          // 一个 assistant 事件 = 一次模型响应 = 一个 step 的内容
          onAssistant: (blocks, usage) => {
            const toolBlocks = blocks.filter((b) => b.type === 'tool-call')
            const textBlocks = blocks.filter((b) => b.type === 'text')

            // 如果这一步只产出工具调用、没有文本，且 step 里已经有内容了，
            // 说明是**上一批工具结果喂回去后的新一轮** —— 需要开新 step。
            //
            // 判断依据：claude 每收到工具结果都会重新发起一次请求，
            // 对应 DSH 的一个新 step。所以只要见到工具结果之后的 assistant
            // 事件，就说明该换步了。
            if (stepHasContent && toolBlocks.length > 0) {
              closeStep()
              step += 1
              openStep()
            }

            // assistant/message 必须在 step 内一次性带齐全部块。
            //
            // `usage` 是**必须的** —— dsh-tui 的 ctx 用量条靠它算：
            //   contextUsed = usage.input + usage.cacheRead + usage.cacheWrite
            //   （screens/StatusLine.js:96，字段来自 projection.js:685 的
            //    event.data.usage）
            // 不带这个字段，状态栏就不显示 ctx 用量。
            const settled = session.append('assistant/message', {
              stream: [],
              turn,
              step,
              message: {
                role: 'assistant',
                content: blocks,
                source: { kind: 'model', provider: 'claude-code', model: config.model ?? 'claude-code' },
              },
              ...(usage ? { usage } : {}),
            }, { surfaceOp: 'append' })

            // 结束这一步的增量流。
            //
            // 顺序（dsh 0.2.0 的契约）：**先落 durable 消息，再发 end 帧** ——
            // `outcome.seq` 的语义是「已经提交的 settlement 的序号」，
            // 反过来就引用不到东西了。
            // （0.1.x 时代我写的是「先 end 再写消息」，那时 outcome 只要
            //  一个 eventType 字符串，没有 seq，所以顺序无所谓。）
            endAttempt({
              kind: 'committed',
              eventType: 'assistant/message',
              seq: settled.seq,
            })
            stepHasContent = true

            // 工具调用紧跟在产生它的 assistant 消息之后
            for (const b of toolBlocks) {
              const ev = session.append('tool/call', {
                turn,
                step,
                callId: b.id,
                // ── 队友工具改名 ────────────────────────────────────────
                //
                // dsh-TUI 靠**工具名**判断这是不是"起了个队友"：
                //   SUBAGENT_TOOL_NAMES = {task, subagent, subagent_fork, ...}
                //   （projection-helpers.js，小写精确匹配）
                //
                // 而 claude 实际发的名字是 `Agent` —— 不在名单里，于是被渲染成
                // 一张普通工具卡。实测确认：
                //   isSubagentToolName('Task')  = true
                //   isSubagentToolName('Agent') = false
                //
                // 有意思的是 claude 的 `system/init` 里注册的名字**恰恰是
                // `Task`**（init.tools 含 Task / TaskStop / ListAgents），
                // 只有实际调用事件用了 `Agent`。所以这里映射回 `Task`
                // 既能让 dsh-TUI 认出来，也和 claude 自己的工具表一致。
                name: b.name === 'Agent' ? 'Task' : b.name,
                arguments: b.arguments,
              })
              callSeqs.set(b.id, ev.seq)
              log('  tool call:', b.name, b.arguments.slice(0, 90))
            }

            if (textBlocks.length > 0) {
              // 不截断 —— 之前截到 70 字符，排查时看到"文本似乎不全"，
              // 白怀疑了一轮。日志就是要能当证据用。
              log('  assistant text:', textBlocks.map((b) => b.text).join(''))
            }
          },

          onToolResult: async (res) => {
            const callSeq = callSeqs.get(res.id)
            // 走统一转换 —— 工具结果里可能有图片（claude 的 Read 读图），
            // 那些要落成 DSH 的 attachment 才能显示。
            // 这个函数是 async，所以 onToolResult 也必须是；
            // runClaude 那边用保序链串着调它，顺序不会乱。
            const content = await toolResultBlocks(res.content, attachments)

            // tool/result 是 **surface-eligible** 事件（dsh-session 的
            // SurfaceEventType 含 'tool/result' 但不含 'tool/call'），
            // 必须带 surfaceOp，否则 append 直接抛：
            //   session event "tool/result" is surface-eligible and requires
            //   a surfaceOp marker
            //
            // ToolMessageSource 要的是 **callId** 而不是 toolName，
            // 且 message 上另有一个 `toolCallId` —— 两个都要给。
            // 最关键的还有 `sourceEventSeqs: [callSeq]`：官方 agent-loop
            // 就是这么写的（appendToolResult），UI 靠它把 result 挂回 call。
            // 早先漏了它，卡片一直停在"运行中…"。
            session.append('tool/result', {
              turn,
              step,
              message: {
                role: 'tool',
                toolCallId: res.id,
                content,
                source: { kind: 'tool', callId: res.id },
                ...(res.isError ? { isError: true } : {}),
              },
            }, {
              surfaceOp: 'append',
              ...(callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] }),
            })
            log('  tool result:', res.id.slice(0, 12), res.isError ? '(错误)' : 'ok')
            resolvedCalls.add(res.id)
          },
        })

        // ── 上报 claude 的系统提示 + 工具清单（只做一次）────────────
        //
        // 放在 runClaude 之后：initInfo 是 claude 启动后才发出来的，
        // turn 开头它还是 null。
        //
        // 为什么要把这些塞进一个 `system/message`：dsh-tui 的 hover 明细里
        // `sys` 一项**只**由 `system/message` 决定（projection.js:991）：
        //   state.contextSegments.system = estimateTokens(textOf(content))
        // 不报就是 0 —— 而系统提示 + 工具定义恰恰是 24k 上下文的大头，
        // 于是明细加起来只剩几个 token，看着像统计坏了。
        //
        // 载荷是**长度**不是内容：estimateTokens 是 `ceil(len/4)`，
        // 所以喂等长填充文本即可（内容不进任何模型请求，纯展示）。
        if (initReported === null && initInfo) {
          // ── 系数是怎么定的 ────────────────────────────────────────
          //
          // 手上只有工具**名字**，没有 schema，所以只能反推。
          // 反推示例（N 个工具、系统提示 S 字符）：
          //   usage 总量        U tokens
          //   - 系统提示        S 字符 ≈ S/4 tokens
          //   = 剩给工具等       (U − S/4) tokens ≈ 4(U − S/4) 字符
          //   字符/工具 ≈ 252 —— 这是**含名字**的平均值
          //
          // 踩坑：第一版写成 `name.length + 252`，把名字算了两遍，
          // 估出会偏高约一成；再早一版按 380 估，直接偏高两倍多，
          // hover 里 sys 一大坨。
          // 名字长短本来就已经包含在平均值里了，别再加。
          const CHARS_PER_TOOL = 252
          const CHARS_PER_MCP_SERVER = 120
          const CHARS_PER_SKILL = 60

          const toolChars = initInfo.tools.length * CHARS_PER_TOOL
          const mcpChars = initInfo.mcpServers.length * CHARS_PER_MCP_SERVER
          const skillChars = initInfo.skills.length * CHARS_PER_SKILL

          // 系统提示正文：claude 的 stream-json 不给，但它的 transcript 里
          // 有 prompt_snapshot，读长度即可。读不到用保守基线。
          const claudeSid = loadMap()[session.id]
          const sysChars = readClaudeSystemPrompt(claudeSid, cwd) ?? 6000

          const totalChars = sysChars + toolChars + mcpChars + skillChars
          // estimateTokens 是 ceil(len/4)（utils/usage.js），所以填充文本的
          // **长度**就是载荷。内容不会被任何模型请求读走，纯展示用。
          session.append('system/message', {
            message: {
              role: 'system',
              content: [{ type: 'text', text: 'x'.repeat(totalChars) }],
              source: { kind: 'system-prompt' },
            },
          }, { surfaceOp: 'append' })
          initReported = 'sent'

          // 日志只打数字 —— 曾经把 filler 拼进来，刷了 22 万个 x 把日志淹了
          log('  sys 上报: ' + totalChars + ' 字符 ≈ ' + Math.ceil(totalChars / 4) +
            ' tokens（系统提示 ' + sysChars + ' + 工具 ' + initInfo.tools.length +
            ' 个/' + toolChars + ' + MCP ' + initInfo.mcpServers.length +
            ' + 技能 ' + initInfo.skills.length + '）')
          log('  claude 实际模型: ' + (initInfo.model ?? '?') +
            ' 版本 ' + (initInfo.version ?? '?') +
            ' 权限 ' + (initInfo.permissionMode ?? '?'))
        }

        // 收尾：任何还没结束的 attempt 都要 end 掉，
        // 否则 TUI 里那行会一直停在"正在输入"的光标状态。
        //
        // 走到这里 attempt 还开着，说明**这一步的流没有正常落地**
        // （中断，或者 claude 中途挂了）—— 所以用 `abandoned`：
        // TUI 会丢弃这行增量拼出来的临时内容
        // （projection.js renderStreamFrame 的 end 分支）。
        // 正常路径上每个 assistant 事件都已经自己 end 过了，
        // 这里是个兜底，正常情况下 attemptId 已经是 null。
        endAttempt({ kind: 'abandoned' })

        // ── 记下 claude 实报的上下文窗口 ────────────────────────────
        //
        // result 帧的 `modelUsage[<model>].contextWindow` 是**权威值**
        // （本机实测 256000，而配置里的默认是猜的 200000）。
        // 记下来给**下一轮**的 request/context 用 —— 本轮的已经发出去了。
        if (r.ok && typeof r.contextWindow === 'number' && r.contextWindow > 0) {
          if (learnedContextWindow !== r.contextWindow) {
            learnedContextWindow = r.contextWindow
            log('  ctx 窗口容量（claude 实报）: ' + r.contextWindow +
              (config.contextWindow && config.contextWindow !== r.contextWindow
                ? '  ← 配置里写的 ' + config.contextWindow + ' 已被取代'
                : ''))
          }
          // 同步给 llm adapter —— dsh-tui 的 `resolveModelInfo` 从那里读
          // 容量（model-actions.js:45），和 request/context 事件互为补充。
          try { modelAdapter?.setContextWindow?.(r.contextWindow) } catch { /* 非致命 */ }
        }

        const mailboxId = mailboxIdFromEnv()
        if (mailboxId) {
          try {
            writeTurnResult(STATE_DIR, mailboxId, {
              text: r.ok
                ? (typeof r.text === 'string' ? r.text : '')
                : (r.cancelled ? '已中断' : (r.error ?? '失败')),
              ok: r.ok && !r.cancelled,
              claudeSid: typeof r.sessionId === 'string' ? r.sessionId : undefined,
            })
          } catch (err) {
            log('信箱回合回写失败:', String(err))
          }
        }

        if (r.cancelled) {
          log('  已被用户中断')
        } else if (!r.ok) {
          // 出错时把错误也作为一条 assistant 消息写出来，别让界面空着
          session.append('assistant/message', {
            stream: [],
            turn,
            step,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: `调用 claude 失败：${r.error ?? '未知错误'}` }],
              source: { kind: 'model', provider: 'claude-code', model: config.model ?? 'claude-code' },
            },
          }, { surfaceOp: 'append' })
        }

        // ── 回收悬空的 tool/call ────────────────────────────────────
        //
        // 中断或出错时，已发出的 `tool/call` 可能永远等不到配对的
        // `tool/result`，卡片就一直是"运行中…"（即使 turn 已经 aborted）。
        //
        // dsh 0.2.0 起官方提供了 **ToolCallRecovery**（dsh-session/repair），
        // 它就是干这个的，而且是权威实现：
        //   · 观察事件流，跟踪 pending 的 call（step/turn 边界会自动丢弃）
        //   · results() 按 assistant 顺序产出保守的错误结果，不改内部状态
        //   · 复用最新事件的时间戳，seq 接在其后
        // 官方 agent-loop 在 step 失败时也是这么收尾的
        // （见 commit 6a6f350b94 "settle pending tool results before failed steps close"）。
        //
        // 早先我手写了一套（callSeqs + resolvedCalls 做差集），能用但重复造轮子，
        // 而且没处理 step/turn 边界。现在优先用官方的，拿不到才退回手写。
        if (!r.ok) {
          const pending = recovery ? recovery.results() : null
          if (pending && pending.length > 0) {
            for (const ev of pending) {
              const appended = session.append('tool/result', ev.data, {
                surfaceOp: 'append',
                ...(ev.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: ev.sourceEventSeqs }),
              })
              // 契约要求「调用方提交结果后**再 observe 那些提交**」——
              // 见 repair.d.ts 的 results() 注释。不然下一轮 results()
              // 会把刚补的当成还没补，重复产出。
              const committed = session.eventAt(appended.seq)
              if (committed) recovery.observe(committed)
            }
            log('  回收悬空工具调用:', pending.length, '个（ToolCallRecovery）')
          } else {
            // 退回手写：callSeqs 减去已收到结果的 id
            let n = 0
            for (const [callId, seq] of callSeqs) {
              if (resolvedCalls.has(callId)) continue
              session.append('tool/result', {
                turn,
                step,
                message: {
                  role: 'tool',
                  toolCallId: callId,
                  content: [{ type: 'text', text: r.cancelled ? '已中断：工具调用未返回结果' : '工具调用未返回结果' }],
                  source: { kind: 'tool', callId },
                  isError: true,
                },
              }, { surfaceOp: 'append', sourceEventSeqs: [seq] })
              n++
            }
            if (n > 0) log('  回收悬空工具调用:', n, '个（手写兜底）')
          }
        }

        closeStep()
        // turn 的结束原因：中断用 `aborted` + cause user。
        // TUI 靠它把 spinner 停掉、把状态从"运行中"改回来
        // （projection.js:955 明确写了 `Agent.cancel()` closes the turn
        //  as `aborted``）。
        session.append('turn/end', {
          turn,
          reason: r.ok
            ? { kind: 'completed' }
            : r.cancelled
              ? { kind: 'aborted', reason: { kind: 'user' } }
              : { kind: 'aborted', reason: { kind: 'error' } },
        })
        log('turn', turn, 'done ok=' + r.ok, 'steps=' + step, 'tools=' + callSeqs.size,
          'chunks=' + (streamRevision - turnStreamStart))
      } catch (err) {
        log('turn failed:', err?.stack ?? String(err))
        try { abandonOpenAttempt() } catch { /* ignore */ }
        try { if (stepOpen) session.append('step/end', { turn, step }) } catch { /* ignore */ }
        try {
          session.append('turn/end', {
            turn,
            reason: { kind: 'aborted', reason: { kind: 'error' } },
          })
        } catch { /* ignore */ }
        const mailboxId = mailboxIdFromEnv()
        if (mailboxId) {
          try {
            writeTurnResult(STATE_DIR, mailboxId, {
              text: err?.message ?? String(err),
              ok: false,
            })
          } catch { /* ignore */ }
        }
      } finally {
        if (turnAbort === ac) turnAbort = null
        if (abortActive) abortActive = null
      }
    }

    // ── 单飞收件箱 ──────────────────────────────────────────────────
    //
    // `--print` 一轮只吃一条 user 帧。steer 落成 next-step，等本轮结束后
    // 再开一轮新的 claude --print，不是往当前进程插嘴。
    //
    // TUI 契约（dsh-tui 0.12）：
    //   · 忙时 Enter → agent.steer
    //   · 闲时 Enter → agent.followup
    //   · Alt+Up     → agent.inbox.remove
    //   · Esc 无排队 → cancel({keepInbox:true})
    //   · Esc 有排队 → interruptAndDeliver：cancel() 再重投 followup
    //   · rewind     → agent.inbox.clear()
    // claimed / discarded 必须带 agent，binding-events 靠它过滤。
    queue = createInboxQueue({
      agent,
      get dispatch() { return dispatch },
      log,
      blocked: () => maintaining,
      run: (message, ctx) => runTurn(message, ctx),
      nextTurnNumber: () => ++turnCounter,
      onStart: () => {
        busy = true
        agent.status = 'running'
        try { dispatch.emit('agent/status', { status: 'running' }) } catch { /* ignore */ }
        followActivity(queue.whenIdle())
        const mailboxId = mailboxIdFromEnv()
        if (mailboxId) {
          try {
            const existing = readMailbox(STATE_DIR, mailboxId)
            setMailboxStatus(STATE_DIR, mailboxId, existing?.claudeSid ? 'running' : 'loading', {
              windowPid: process.pid,
              heartbeatAt: Date.now(),
            })
          } catch { /* ignore */ }
        }
      },
      onEnd: () => {
        busy = false
        agent.status = 'idle'
        try { dispatch.emit('agent/status', { status: 'idle' }) } catch { /* ignore */ }
      },
    })
    agent.inbox = queue.inbox
    agent.send = (message, target, wakeup) => { queue.send(message, target, wakeup) }
    agent.followup = (message) => { queue.followup(message) }
    agent.steer = (message) => { queue.steer(message) }
    // 官方 inject = send(next-step, false)：只落队列，不唤醒。
    // `--print` 一轮一条，注入的上下文会在下一次 followup/steer 之前
    // 作为单独一轮发出（不是塞进当前进程）。
    agent.inject = (message) => { queue.inject(message) }
    agent.whenIdle = async () => {
      let activity
      do {
        activity = idle
        await activity
      } while (activity !== idle)
    }

    // runMaintenance：占用判定是同步抛。维护期间对外仍是 idle，
    // 入队的 followup/steer 因 blocked 先趴着，结束再 nudge。
    // whenIdle 必须跟「维护 + 它释放出来的那一轮」。
    agent.runMaintenance = (task) => {
      if (typeof task !== 'function') throw new TypeError('cc-bridge: runMaintenance 需要 task 函数')
      if (busy || maintaining || queue.running) {
        throw new Error('cc-bridge: runMaintenance 需要真正的 idle 阶段（当前有回合在跑）')
      }
      const ac = new AbortController()
      abortMaintenance = ac
      maintaining = true
      const run = Promise.resolve()
        .then(() => task(ac.signal))
        .finally(() => {
          maintaining = false
          abortMaintenance = null
          queue.nudge()
        })
      followActivity(run)
      return run
    }

    // 宿主经信箱塞任务。本窗口独占 --print，所以只 followup，不另开一轮。
    //
    // 领取必须等 live Channel 绑上：否则 followup 已经 spawn claude，
    // 界面还是空白，用户会当成「没开工」。认领写 pid 也别抢 pending。
    const mailboxId = mailboxIdFromEnv()
    if (mailboxId) {
      const hostMessage = (text) => ({
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      const drainMailbox = () => {
        let taken
        try { taken = takePending(STATE_DIR, mailboxId) } catch (err) {
          log('信箱领取失败（将重试）:', String(err))
          return 0
        }
        let n = 0
        for (const item of taken) {
          const text = typeof item?.text === 'string' ? item.text.trim() : ''
          if (!text) continue
          log('信箱 → followup:', text.slice(0, 80))
          queue.followup(hostMessage(text))
          n++
        }
        return n
      }
      const pollCancel = () => {
        try {
          const box = readMailbox(STATE_DIR, mailboxId)
          if (!box?.cancelRequestedAt) return
          log('信箱 → 宿主要求中断')
          try { agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch (err) {
            log('信箱中断失败:', String(err))
          }
          try { clearMailboxCancel(STATE_DIR, mailboxId) } catch { /* ignore */ }
        } catch { /* ignore */ }
      }
      let started = false
      const startMailbox = () => {
        if (started) return
        started = true
        try {
          const existing = readMailbox(STATE_DIR, mailboxId)
          const sid = existing?.claudeSid ?? null
          const pending = existing?.pending?.length ?? 0
          setMailboxStatus(STATE_DIR, mailboxId, pending ? 'loading' : 'idle', {
            windowPid: process.pid,
            heartbeatAt: Date.now(),
            ...(sid ? { claudeSid: sid } : {}),
          })
          log('信箱已认领', mailboxId, 'pid=', process.pid, 'pending=', pending)
        } catch (err) {
          log('信箱认领失败（将重试）:', String(err))
        }
        const drained = drainMailbox()
        try {
          const ch = activeChannel()
          if (ch && typeof ch.notify === 'function' && (drained > 0 || queue.running)) {
            ch.notify('任务已从信箱领取。第一轮要加载 Claude 工具面，常要 1–3 分钟，不是没连上。', {
              timeoutMs: 8000,
            })
          }
        } catch { /* 没有 Channel 就只靠日志 */ }
        watchMailbox(STATE_DIR, mailboxId, () => {
          pollCancel()
          drainMailbox()
        })
        const beat = setInterval(() => {
          try { touchMailboxHeartbeat(STATE_DIR, mailboxId, process.pid) } catch { /* ignore */ }
        }, 4000)
        beat.unref?.()
      }
      if (activeChannel()) {
        startMailbox()
      } else {
        let tries = 0
        const wait = setInterval(() => {
          tries++
          if (activeChannel() || tries >= 80) {
            clearInterval(wait)
            if (!activeChannel()) log('信箱：没等到 Channel，仍领取任务（界面可能晚一拍）')
            startMailbox()
          }
        }, 100)
        wait.unref?.()
      }
    }

    return agent
  }

  const factory = {
    async createAgent(ownerCtx, options) {
      log('createAgent', options.sessionId)
      // 工作目录：**跟随宿主**（`options.meta.cwd`），详见 `resolveAgentCwd()`。
      // 打出来是为了让"状态栏目录 vs claude 实际目录"一眼可查。
      log('  cwd 解析：meta =', options.meta?.cwd ?? '(无)',
        ' config =', config.cwd ?? '(未配)',
        ' → 采用 =', resolveAgentCwd(options))
      const core = await ready
      if (!core) throw new Error('cc-bridge: 核心包未加载，无法建 agent')

      log('  [1/4] sessions.create')
      const session = sessions.create(options.sessionId, {
        ...(options.meta === undefined ? {} : { meta: options.meta }),
      })

      log('  [2/4] mountAgent')
      const agent = mountAgent(ctx, session, options, core, attachments)

      // ⚠️ 传给 setup 的必须是 **agent 自己的 scoped ctx**，不是 ownerCtx。
      //
      // 踩坑记录：最早传 ownerCtx，报
      //   "Agent preset binding requires a scoped context"
      // 因为 setup 内部会做 agent-preset 绑定，它走 `scopeOf(ctx)`，
      // 而 ownerCtx 是调用方（dsh-tui）的上下文，不带本 agent 的 scope。
      //
      // 官方 agent-loop 的做法是传它自己 mint 的 `this.ctx`（= scope.ctx）。
      // 这是契约的一部分：setup 里注册的东西要挂在 agent 的 scope 上，
      // 这样 agent 销毁时能一起回收。
      log('  [3/4] setup(agent.ctx, agent)')
      try {
        await options.setup?.(agent.ctx, agent)
        log('  [3/4] setup 完成')
      } catch (err) {
        // 打印完整栈 —— TUI 的场景下 setup 步骤多，只报 message 定位不到。
        log('  [3/4] setup 失败:', err?.stack ?? String(err))
        throw err
      }

      log('  [4/4] agents.register')
      await agents.register(agent)
      log('createAgent 完成', options.sessionId)
      return { agent, dispose: () => Promise.resolve() }
    },

    async resume(ownerCtx, options) {
      log('resume', options.resumeSessionId)
      const core = await ready
      if (!core) throw new Error('cc-bridge: 核心包未加载，无法恢复 agent')

      const session = sessions.get(options.resumeSessionId)
      if (session === undefined) {
        throw new Error(`cc-bridge: 没有这个 session ${options.resumeSessionId}`)
      }
      const agent = mountAgent(ctx, session, options, core, attachments)
      await options.setup?.(agent.ctx, agent)
      await agents.register(agent)
      log('resume 完成', options.resumeSessionId)
      return { agent, dispose: () => Promise.resolve() }
    },
  }

  try {
    ctx.effect(() => agents.setFactory(factory), 'cc-bridge.setFactory()')
    log('factory 已注册 ✓')
  } catch (err) {
    log('setFactory 失败:', String(err))
  }

  const mailboxId = mailboxIdFromEnv()
  if (mailboxId && boundMailboxId !== mailboxId) {
    boundMailboxId = mailboxId
    try {
      const existing = readMailbox(STATE_DIR, mailboxId)
      const sid = existing?.claudeSid ?? null
      setMailboxStatus(STATE_DIR, mailboxId, existing?.pending?.length ? 'loading' : 'starting', {
        windowPid: process.pid,
        heartbeatAt: Date.now(),
        ...(sid ? { claudeSid: sid } : {}),
      })
      log('信箱窗口已绑定', mailboxId, 'pid=', process.pid)
    } catch (err) {
      log('信箱绑定失败（将重试）:', String(err))
    }
  }
}
