// 预加载脚本：在 dsh-tui 加载**之前**包装 react/jsx-runtime 的 jsx/jsxs。
//
// ── 为什么必须"提前" ────────────────────────────────────────────────
//
// `react/jsx-runtime` 是 CJS，dsh-tui 里以 ESM 具名导入方式使用：
//
//     import { jsx as _jsx } from "react/jsx-runtime";
//
// Node 的 CJS→ESM 互操作是**在首次 import 时**把 CJS 的属性拷贝成命名导出
// ——**之后**再改 `cjs.jsx` 对已加载的模块**无效**。实测：
//
//     先 import，后 patch  →  ns.jsx === cjs.jsx  →  false（快照，改不动）
//     先 patch，后 import  →  ns.jsx === cjs.jsx  →  true （拿到的就是包装）
//
// 插件里的 `apply()` 跑在 dsh-tui 组件**已经加载**之后，所以那时再包装
// 是白费功夫（实测 ctx 条空闲段仍是 `#2E3440`）。必须靠这个 preload
// 抢在前面。
//
// ── 怎么挂上 ────────────────────────────────────────────────────────
//
// `run.ps1` 里设：
//
//     $env:NODE_OPTIONS = "--import file:///D:/code/cc-bridge/src/preload.mjs"
//
// `--import` 在入口模块之前执行，所以这里的包装一定早于 dsh-tui。
//
// ── 只重映射已知的旧值 ──────────────────────────────────────────────
//
// 不是全局调色板劫持：只认几个特定 hex，其它一律放行。上游以后不用这些色
// 了，包装就退化成无害的空转（多一次 Map 查询）。

import { createRequire } from 'node:module'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tuiPackageRoots, tuiRootTag } from './tui-roots.mjs'

/** 空闲段（bar 的"未使用"部分）的新底色。旧值见下面 REMAP。 */
const BAR_FREE_FILL = '#3A2C21'
/** 空闲段读数文字的新颜色。 */
const BAR_FREE_TEXT = '#A3907C'

/** 开屏提示行尾巴元素的文本特征。 */
const TIP_SUFFIX = ' · /tips '

/**
 * 判断某个 JSX 调用是不是开屏那行「提示：… · /tips 更多技巧」。
 *
 * 实测结构（诊断 dump，见下面 `wrap` 的注释）：
 *
 *     children = [
 *       el(ThemedText) inner="提示：",
 *       str "/export 把完整会话导出为 Markdown（含思考）",
 *       el(ThemedText) inner=" · /tips 更多技巧",
 *     ]
 *
 * 判别：**长度 3 的数组 + 第 3 项文本含 ` · /tips `**。
 *
 * 为什么用第 3 项而不是第 0 项：` · /tips ` 更独特。`提示：` 只有 3 个字，
 * 而且是 i18n 词条，万一别处也用就误伤了。
 *
 * 为什么 ` · /tips ` 可靠：它是**硬编码字面量**
 * （`' · /tips ' + tr('logo-tip-more')`，不走 i18n），而且全库渲染代码里
 * **只此一处**（三份 dsh-tui 副本各 grep 过，都是 1 次）。
 *
 * 尾部文本是 `tr('logo-tip-more')` 的求值结果，中文下 ` · /tips 更多技巧`、
 * 英文下 ` · /tips more tips` —— 判别只看前半段，与语言无关。
 */
function isStartupTipLine(props) {
  const kids = props?.children
  if (!Array.isArray(kids) || kids.length !== 3) return false
  const tail = kids[2]?.props?.children
  return typeof tail === 'string' && tail.includes(TIP_SUFFIX)
}

/** 旧值 → 新值。小写键，只认这几个。 */
const REMAP = new Map([
  ['#2e3440', BAR_FREE_FILL],   // ctx 条空闲段底色（dark 主题分支）
  ['#e8e8e8', BAR_FREE_FILL],   // 同上的 light 分支常量
  ['#8d95a6', BAR_FREE_TEXT],   // 空闲段读数文字（dark）
  ['#4a4a4a', BAR_FREE_TEXT],   // 同上的 light 分支常量
])

function loadJsxRuntimes() {
  const found = []
  for (const root of tuiPackageRoots()) {
    const pkg = join(root, 'package.json')
    if (!existsSync(pkg)) continue
    try {
      const mod = createRequire(pkg)('react/jsx-runtime')
      if (mod && typeof mod.jsx === 'function') found.push({ root, mod })
    } catch { /* 试下一份 */ }
  }
  return found
}

/**
 * ⚠️ 必须**三份都包**，不能只包第一份。
 *
 * 踩过：原来是 `return mod`（找到第一份就返回），而三份 dsh-tui 各有自己的
 * `react` 依赖 —— **实际渲染用的那份未必是第一个**。实测：
 *
 *   · 包装只落在 `npm 全局` 那份
 *   · 而真正渲染的是 `dsh-tui profile` 那份
 *   · 结果提示行**照旧显示**，日志里连"已隐藏"都没打
 *
 * 这个坑很隐蔽：包装函数明明装好了（`jsx=function`），颜色重映射也有
 * 生效的迹象（因为某些渲染确实走了被包的那份），但针对性的那一项不生效。
 *
 * 诊断手法（值得记）：把三份**都**包上并各自留痕，一眼就能看出命中来自
 * 哪一份 —— 日志里出现 `prof/jsxs 命中` 就说明只有 profile 那份是活的。
 */
const jsxRuntimes = loadJsxRuntimes()

// 诊断留痕：确认 preload 真的跑了、以及包装是否成功。
// 这条日志写进 bridge.log 会让排查容易得多 —— 之前「日志说成功但颜色没变」
// 就是因为分不清是 preload 没跑、还是包装被快照吃掉了。
appendLog(
  `[preload] 已执行：pid=${process.pid} jsxRuntime=${jsxRuntimes.length} 份` +
  `（${jsxRuntimes.map((x) => tuiRootTag(x.root)).join('/') || '无'}）\n`,
)

const remap = (v) => (typeof v === 'string' ? REMAP.get(v.toLowerCase()) ?? v : v)

/**
 * 包一层 jsx/jsxs，做两件事：
 *
 *   ① 去掉开屏大字下面那行「提示：… · /tips 更多技巧」
 *   ② 改 `backgroundColor` / `color` 这两个会承载颜色的 prop
 *
 * ⚠️ 为什么用返回 null 而不是把文字清空：那行是
 *
 *     <ThemedText>
 *       <ThemedText dimColor>提示：</ThemedText>       ← 前缀元素
 *       {随机技巧}                                      ← 纯字符串
 *       <ThemedText dimColor> · /tips 更多技巧</ThemedText>  ← 尾巴元素
 *     </ThemedText>
 *
 * 前缀和尾巴都是**独立元素**，尾巴还是硬编码字面量（不走 i18n，所以改
 * 词条没用）。清词条只会剩「提示： · /tips 更多技巧」—— 比原来更难看。
 * 返回 `null` 让整行消失，且不留空行（React 对 null 不占位）。
 *
 * ── 判别为什么落在"整行的 children 数组"上 ──────────────────────────
 *
 * 实测的真实结构（诊断 dump）：
 *
 *     jsxs 命中！ type=ThemedText children.length=3
 *       [0] el(ThemedText) inner="提示："
 *       [1] str "/export 把完整会话导出为 Markdown（含思考）"
 *       [2] el(ThemedText) inner=" · /tips 更多技巧"
 *
 * 所以判别条件：children 是长度 3 的数组，且**第 3 项的文本**含 ` · /tips `。
 *
 * ⚠️ 中间那项（随机技巧）是**普通字符串**，不是元素 —— 它不含任何关键词，
 *    所以判别只能靠第 0 或第 2 项。选第 2 项是因为 ` · /tips ` 更独特
 *    （`提示：` 这种短词容易误伤）。
 *
 * 惰性浅拷贝：只在真要改时才新建 props 对象 —— 这两个函数是每次渲染的
 * 热路径，不该无条件多分配。
 */
const wrap = (orig) => function ccBridgeOrangeJsx(type, props, key) {
  if (props !== null && typeof props === 'object') {
    // ① 去掉开屏提示行（整行，一次干掉）
    if (isStartupTipLine(props)) {
      if (!tipHidden) {
        tipHidden = true
        appendLog('[preload] 已隐藏开屏提示行（提示：… · /tips）\n')
      }
      return null
    }

    // ② 颜色重映射
    let patched
    for (const prop of ['backgroundColor', 'color']) {
      const cur = props[prop]
      if (typeof cur !== 'string') continue
      const next = remap(cur)
      if (next === cur) continue
      patched ??= { ...props }
      patched[prop] = next
    }
    if (patched !== undefined) props = patched
  }
  return orig(type, props, key)
}

let tipHidden = false

for (const { root, mod } of jsxRuntimes) {
  if (mod.__ccBridgeOrange) continue
  try {
    mod.jsx = wrap(mod.jsx)
    mod.jsxs = wrap(mod.jsxs)
    try { mod.__ccBridgeOrange = true } catch { /* 只读就算了 */ }
  } catch (err) {
    appendLog(`[preload] ${tuiRootTag(root)} 包装失败：${err}\n`)
  }
}

// ════════════════════════════════════════════════════════════════════
// 让 host-registry 的注册表**跨模块实例共享**
// ════════════════════════════════════════════════════════════════════
//
// ── 问题 ────────────────────────────────────────────────────────────
//
// cc-bridge 要靠 `getRegisteredTuiChannel(ctx)` 拿到 dsh-tui 的 live
// Channel（用来做 `/clear` 归零、清屏、菜单抑制）。
//
// 但系统里存在**三份 dsh-tui**（npm 全局 / profile / profile-safe），
// 路径不同 → Node 视为不同模块 → `host-registry.js` 被加载**三次**，
// 而它内部的注册表是模块级私有变量：
//
//     const channels = new WeakMap()
//     const channelListeners = new WeakMap()
//     const registrationListeners = new WeakMap()
//
// dsh-tui 注册进**它那一份**的 WeakMap；cc-bridge 查的是**自己那一份**
// —— 两个 WeakMap 毫无关系，所以永远查不到。实测表现：
//
//     · Channel 捕获钩子已装：2 份 dsh-tui
//     · [dsh-tui profile] 暂时查不到 Channel（试了 3 个键）
//     · 之后订阅也从不触发
//
// 这不是键的问题（`ctx.root` / `compositionRoot(ctx)` / `ctx` 三个键都试过），
// 是**实例分裂**。
//
// ── 修法 ────────────────────────────────────────────────────────────
//
// 用 `module.registerHooks()` 在**加载时改写源码**，把三张表挂到
// `globalThis` 上 —— 于是所有实例共用同一份：
//
//     const channels = (globalThis.__ccBridgeChannels ??= new WeakMap())
//
// 为什么这里能做源码改写、而插件里不能：ESM 的具名导出是**只读绑定**，
// 运行时改不动（本项目踩过：「ESM 具名导入是快照」）。但加载钩子在
// **模块求值之前**介入，改的是源码文本，不受那条限制。
//
// ⚠️ 只认这一个文件（按 URL 后缀匹配），不碰别的模块。
// ⚠️ 三处替换是**字面量**匹配，上游改了变量名就自动退化成空转
//    （不报错，只是 `/clear` 归零失效），不会把进程搞坏。

const REGISTRY_SUFFIX = 'adapter/channel/host-registry.js'

/** 把模块级 WeakMap 换成 globalThis 上的共享实例。 */
function shareRegistryState(source) {
  let out = source
  let hits = 0
  for (const name of ['channels', 'channelListeners', 'registrationListeners']) {
    // 只匹配「声明 + new WeakMap()」这种形态，别误伤别处。
    // ⚠️ 结尾的 `;` 是可选的 —— 实测源码里**有**分号
    //    （`const channels = new WeakMap();`），第一版正则漏了它，
    //    结果命中 0 处、静默退化成空转。
    const re = new RegExp(
      `const\\s+${name}\\s*=\\s*new\\s+WeakMap\\(\\)\\s*;?`, 'g')
    out = out.replace(re, () => {
      hits++
      return `const ${name} = (globalThis.__ccBridgeRegistry ??= {})` +
        `.${name} ??= new WeakMap();`
    })
  }
  return { source: out, hits: hits }
}

/**
 * 在 `registerTuiChannel` 入口把 Channel 记进**全局数组**。
 *
 * ════════════════════════════════════════════════════════════════════
 * 为什么不能只靠 getRegisteredTuiChannel
 * ════════════════════════════════════════════════════════════════════
 *
 * 那个函数按 **composition root** 作键查 WeakMap。实测走不通：
 *
 *     · 三种键都试过（ctx.root / compositionRoot(ctx) / ctx）
 *     · compositionRoot 没回退成自身（说明键算对了）
 *     · 但查不到，订阅 `onTuiChannelRegistered` 也从不触发
 *
 * 查不出确切原因（可能我们插件与 dsh-tui 不在同一个 fiber 树里，
 * 于是 `rootKey()` 算出的键不同）。**与其继续猜键，不如绕开键**。
 *
 * 记进 `globalThis.__ccBridgeChannels` 之后，取 Channel 变成"读一个全局
 * 数组" —— 没有键匹配、没有时序问题（读的时候现查即可）。
 *
 * 这也正是源码改写相对运行时 hook 的优势：ESM 具名导出改不动，但
 * 加载期改源码可以。
 */
/**
 * 日志文件 —— 与 `index.mjs` 的 `STATE_DIR` 规则**必须一致**，
 * 否则 preload 的日志和插件的日志会落到两个文件里，排查时看不过来。
 *
 * ⚠️ 原先是写死的 `D:\code\cc-bridge\bridge.log`，别人 clone 到别处后：
 *    · 日志写不进去（被 catch 吞掉）
 *    · 而且下面注入的**探针代码**里也是这个绝对路径 —— 那是写进上游
 *      `host-registry.js` 源码里的字符串，路径错了探针会静默失效
 */
const LOG_PATH = (() => {
  const dir = process.env.CCB_STATE_DIR
    || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'cc-bridge') : null)
    || join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.cc-bridge')
  try { process.getBuiltinModule('node:fs').mkdirSync(dir, { recursive: true }) } catch { /* 兜底 */ }
  return join(dir, 'bridge.log')
})()

/** 日志路径的**源码字面量** —— 注入代码时用，必须转义成合法 JS 字符串。 */
const LOG_PATH_LITERAL = JSON.stringify(LOG_PATH)

function recordChannelOnRegister(source) {
  const re = /export\s+function\s+registerTuiChannel\s*\(\s*ctx\s*,\s*channel\s*\)\s*\{/
  if (!re.test(source)) return { source, hit: false }
  // 注入的探针**直接写日志** —— 这是唯一能证明
  // "registerTuiChannel 到底有没有被调用" 的办法。
  // 用 `process.getBuiltinModule`（Node 22.14+）拿 fs，因为这里是同步上下文，
  // 不能用动态 import。
  //
  // ⚠️ 路径用 `LOG_PATH_LITERAL` 插值，**不要**写死 —— 见 LOG_PATH 的注释。
  const probe = `
    try {
      (globalThis.__ccBridgeChannels ??= []).push(channel);
      process.getBuiltinModule('node:fs').appendFileSync(
        ${LOG_PATH_LITERAL},
        '[preload] ★ registerTuiChannel 被调用 pid=' + process.pid +
        ' channel=' + (channel && typeof channel) + '\\n');
    } catch (e) {
      try {
        process.getBuiltinModule('node:fs').appendFileSync(
          ${LOG_PATH_LITERAL},
          '[preload] registerTuiChannel 探针异常: ' + e + '\\n');
      } catch {}
    }`
  return {
    source: source.replace(re, (m) => `${m}\n${probe}`),
    hit: true,
  }
}

/** 完整改写：共享注册表 + 记录 register 调用。 */
function rewriteRegistry(source) {
  const shared = shareRegistryState(source)
  const rec = recordChannelOnRegister(shared.source)
  return {
    source: rec.source,
    hits: shared.hits,
    recordHit: rec.hit,
  }
}

// ── 自校验：预加载时先把三处替换在**真实文件**上试一遍 ────────────────
//
// 这个替换是**弱契约**（靠正则匹配上游源码），上游改个写法就静默失效。
// 所以启动时主动验一次并把结果写进日志 —— 否则 `/clear` 归零不工作时
// 根本不知道是没匹配上。
try {
  const { readFileSync } = await import('node:fs')
  const probe = tuiPackageRoots()
    .map((r) => join(r, 'lib', 'types', 'adapter', 'channel', 'host-registry.js'))
    .find((p) => existsSync(p))
  if (probe) {
    const { hits, recordHit } = rewriteRegistry(readFileSync(probe, 'utf8'))
    appendLog(`[preload] host-registry 改写自校验：WeakMap ${hits}/3` +
      `，register 记录=${recordHit ? '是' : '否 ★'}` +
      (hits === 3 && recordHit ? ' ✓\n' : ' ★ 上游写法变了，/clear 归零会失效\n'))
  } else {
    appendLog('[preload] 找不到 host-registry.js，跳过自校验\n')
  }
} catch (err) {
  appendLog(`[preload] 自校验失败：${err}\n`)
}

try {
  const { registerHooks } = await import('node:module')
  // 开关：`CCB_NO_REGISTRY_REWRITE=1` 时整个跳过。
  //
  // ⚠️ 这段改写是**实验性**的，且实测**没能解决目标问题**（Channel 注册
  //    走的是另一条架构路径，`registerTuiChannel` 从未被调用）。留着是因为
  //    它有独立的诊断价值，但默认行为必须是"不干扰启动"。
  if (process.env.CCB_NO_REGISTRY_REWRITE === '1') {
    appendLog('[preload] 注册表改写已按 CCB_NO_REGISTRY_REWRITE 跳过\n')
  } else if (typeof registerHooks === 'function') {
    registerHooks({
      load(url, context, nextLoad) {
        const result = nextLoad(url, context)
        // 诊断：记录所有 dsh-tui 的模块加载（只在排查期开，量大）
        if (process.env.CCB_TRACE_LOADS === '1' && url.includes('dsh-tui')) {
          const short = url.replace(/^.*dsh-tui\/lib\/types\//, '')
          appendLog(`[preload] load ${short}\n`)
        }
        // 只碰这一个文件；`result` 可能是 Promise（取决于 Node 版本），
        // 但同步钩子里拿到的是同步结果 —— 非本文件一律原样放行。
        if (!url.includes(REGISTRY_SUFFIX)) return result
        if (result instanceof Promise) return result
        try {
          const src = result?.source
          if (src === undefined || src === null) return result
          const text = typeof src === 'string' ? src : Buffer.from(src).toString('utf8')
          const { source, hits, recordHit } = rewriteRegistry(text)
          if (hits === 0 && !recordHit) return result
          // 运行时留痕：确认这个钩子**真的**改到了被加载的模块
          // （自校验只读文件，证明不了运行时命中）
          appendLog(`[preload] 运行时改写 ${url.includes('safe') ? 'safe' : 'prof/npm'}` +
            `：WeakMap ${hits}/3，register=${recordHit ? '是' : '否'}\n`)
          return { ...result, source, format: result?.format ?? 'module', shortCircuit: true }
        } catch {
          return result
        }
      },
    })
    appendLog('[preload] 模块加载钩子已注册\n')
  } else {
    appendLog('[preload] 本 Node 没有 registerHooks，注册表共享不可用\n')
  }
} catch (err) {
  appendLog(`[preload] 注册加载钩子失败：${err}\n`)
}

/** 往日志追加一行 —— preload 阶段没有别的日志通道。 */
function appendLog(line) {
  try {
    appendFileSync(LOG_PATH, line)
  } catch { /* 日志失败不影响功能 */ }
}
