// 橙色主题 —— 给 cc-bridge 的会话换掉 dsh-TUI 默认的「Gentle Mist Blue」。
//
// ── 怎么做到"只影响自己的窗口" ──────────────────────────────────────
//
// dsh-TUI 的主题解析优先级（`ThemeProvider.js`）：
//
//     显式 theme prop > DSH_TUI_THEME 环境变量 > ~/.dsh-tui/theme.json > OSC 11 检测
//
// 我们用**中间那条**：插件注册一个运行时主题，`run.ps1` 里设
// `DSH_TUI_THEME=cc-bridge:orange`。这样：
//
//   · 只影响带这个启动器的窗口 —— 你别的 dsh-tui 会话照旧是蓝色
//   · 不写 `~/.dsh-tui/theme.json`（那是全局持久化，会改到所有会话）
//   · 不改 dsh-TUI 的包文件
//
// ── 为什么用运行时注册而不是静态 JSON ───────────────────────────────
//
// `~/.dsh-tui/themes/*.json` 是**全局文件**，虽然也要 DSH_TUI_THEME 选中，
// 但主题本体留在用户目录里、跟着所有 dsh-tui 走。注册进插件则跟着插件
// 生命周期（`bindCallerEffect`），进程结束就没了。
//
// ── 配色思路 ────────────────────────────────────────────────────────
//
// 原版是「Gentle Mist Blue」—— 蓝色承载品牌/焦点/交互，正文是暖灰。
// 橙色版保持同一套结构，只把色相转到暖橙：
//
//   品牌蓝 #7DA1DE → 暖橙 #E8913F
//   边框蓝 #ABC2EC → 浅橙 #F5C08A
//   卡片底 #242B3A（蓝灰）→ #33261C（暖褐）—— 底色也得跟着转，
//                 否则橙字压在蓝灰底上会"脏"
//
// 状态色（成功绿/错误红/警告黄）**不动** —— 它们表达语义，改了会让
// 用户误读。只调 `warning` 的色相稍微偏暖，跟整体协调。

/** 主题在 `/theme` 里的名字。前缀是插件的，避免撞内置名。 */
export const THEME_NAME = 'cc-bridge:orange'
/** 给 `DSH_TUI_THEME` 用的名字。 */
export const THEME_ID = THEME_NAME

/**
 * 大标题两行的渐变端点（深橙 → 浅橙）。
 *
 * 写进字体的 `palette` —— 这是**唯一**能改到第二行终点色的入口，
 * 原因见 `installBigTitlePalette` 的注释。
 */
const PALETTE = Object.freeze({
  from: { r: 232, g: 145, b: 63 },    // #E8913F 深橙
  to: { r: 250, g: 214, b: 168 },     // #FAD6A8 浅橙
})

/**
 * 把 `#rrggbb` 转成上游用的 `rgb(r, g, b)` 字符串。
 *
 * ── 为什么必须转 ────────────────────────────────────────────────────
 *
 * 注册运行时主题时，上游做的是 `{ ...getTheme(base), ...colors }` ——
 * 内置色板的每个值都是**已包装**的 `rgb(125,161,222)`，而我们传的
 * 覆盖值**原样合并**、不做包装。
 *
 * 问题在于大标题取色走的是 `parseRGB(theme.accent)`，而 `parseRGB`
 * 只认 `rgb(...)` 格式：
 *
 *     parseRGB('rgb(232,145,63)')  →  { r:232, g:145, b:63 }
 *     parseRGB('#E8913F')          →  null   ← 落到 `?? BRAND`（蓝）
 *
 * 实测症状：底栏、边框、状态点都变橙了，**只有大标题还是蓝的** ——
 * 因为它走了 `parseRGB` 那条路，hex 解析失败后回落到了品牌蓝常量。
 *
 * 其他消费方（Ink 的 `color` prop）两种格式都吃，所以只有标题露馅。
 */
function toRgbString(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex   // 非 #rrggbb（如 ansi256(...)）原样传
  const n = parseInt(m[1], 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

/**
 * 橙色配色表 —— 基于内置 `dark` 色板，只覆盖需要变的键。
 *
 * 命名分三层（跟原版一样）：
 *   · 品牌/焦点：`accent` / `accentShimmer` —— 最显眼的橙
 *   · 面板/边框：`promptBorder` / `permission` —— 浅一档的橙
 *   · 衬底：`toolCardBackground` / `selectionBg` —— 暖褐色，不是橙
 */
const ORANGE_HEX = Object.freeze({
  // ── 品牌 / 焦点 / 活动 ──────────────────────────────────────────
  accent: '#E8913F',            // 暖橙 —— 标题渐变起点、焦点色
  accentShimmer: '#F5C08A',     // 浅橙 —— 扫光、边框高光
  activity: '#E8913F',
  activityShimmer: '#F5C08A',
  suggestion: '#F5C08A',
  remember: '#F5C08A',
  professionalBlue: '#E8913F',  // 名字没改，但语义是"品牌色"

  // ── 面板 / 边框 ────────────────────────────────────────────────
  permission: '#F5C08A',
  permissionShimmer: '#FBDDB8',
  promptBorder: '#6B5844',      // 暗暖褐 —— 输入框边框（原来 #55606F）
  promptBorderShimmer: '#E8913F',
  bashBorder: '#E0A06B',
  planMode: '#D9B26B',          // 偏金沙色，跟橙同族但能区分

  // ── 衬底（关键：不能留蓝灰，否则橙字发脏）──────────────────────
  toolCardBackground: '#33261C',     // 暖褐卡片底（原 #242B3A 蓝灰）
  toolCardBackgroundDim: '#291E16',  // 更深一档
  messageActionsBackground: '#3A2C21',
  selectionBg: '#5C4128',            // 选中块 —— 暖褐，不是雾蓝
  bashMessageBackgroundColor: '#332B24',
  memoryBackgroundColor: '#38302A',
  rate_limit_empty: '#4A3B2E',
  rate_limit_fill: '#E8913F',
  userMessageBackgroundHover: '#B4632A',   // 悬停块（原 #3B5BDB 蓝）

  // ── 正文（保持暖白 —— 它本来就暖，跟橙不冲突）──────────────────
  text: '#EDE6DC',
  inverseText: '#241C15',
  inactive: '#A3907C',          // 暖灰（原 #8D95A6 蓝灰）
  inactiveShimmer: '#C0AE99',
  subtle: '#736253',

  // ── 徽标 / 强调 ────────────────────────────────────────────────
  background: '#E8913F',        // 徽标填充
  mascotBody: '#E8913F',        // 吉祥物本体 —— 跟品牌色统一

  // ── 状态（语义色，只微调色温不动色相）──────────────────────────
  warning: '#E0B070',
  warningShimmer: '#EFCB94',
  autoAccept: '#C9A0D4',        // 保留紫色 —— 它是"自动接受"的信号色
  merged: '#C9A0D4',

  // ── 语法高亮（跟着暖化，不然代码块里蓝绿一片很突兀）────────────
  syntaxKeyword: '#E8A05C',
  syntaxNumber: '#E8B87C',
  syntaxFunction: '#D9A05F',
  syntaxType: '#C9A0D4',
  syntaxString: '#9CB884',      // 字符串保持绿（可读性 + 语义）
  syntaxOperator: '#B09880',
  syntaxPunctuation: '#8A7868',
  syntaxComment: '#7D6E60',
})

/**
 * 实际注册用的配色表：全部转成 `rgb(...)`。
 *
 * 见 `toRgbString` 的注释 —— 大标题的 `parseRGB(theme.accent)` 不认 hex，
 * 不转的话标题会回落到品牌蓝，只有标题一处露馅。
 */
export const ORANGE_COLORS = Object.freeze(
  Object.fromEntries(
    Object.entries(ORANGE_HEX).map(([k, v]) => [k, toRgbString(v)]),
  ),
)

// ════════════════════════════════════════════════════════════════════
// 主题管不到的两处：ctx bar 分段色 + 反光高光色
// ════════════════════════════════════════════════════════════════════

/**
 * ctx 用量条的分段配色（深橙 → 亮橙）。
 *
 * ── 为什么主题管不到 ────────────────────────────────────────────────
 *
 * 这五段颜色是 `StatusMetrics.js` 里的**模块常量**：
 *
 *     export const USED_SEGMENTS = [
 *       { key: 'system',    color: '#22305F' },  // deep navy
 *       { key: 'prompt',    color: '#2B3D78' },  // navy
 *       { key: 'assistant', color: '#344A92' },  // indigo
 *       { key: 'thinking',  color: '#4D6BFE' },  // DeepSeek brand blue
 *       { key: 'tools',     color: '#5A7CFF' },  // lighter blue
 *     ]
 *
 * 它们直接写进 ANSI 序列，不走主题系统 —— 实测换成橙主题后整条 bar
 * 还是蓝的。
 *
 * 顺序即语义（越靠左越"基础"），所以暖化时保持**同一条明度阶梯**：
 * 深橙 → 亮橙，让分段的层次感还在。
 */
const BAR_SEGMENTS = Object.freeze({
  system: '#4A2A14',      // 深褐橙（原 deep navy）
  prompt: '#7A4218',      // 褐橙
  assistant: '#B4632A',   // 中橙
  thinking: '#E8913F',    // 品牌橙（原 DeepSeek brand blue）
  tools: '#F5B671',       // 亮橙（原 lighter blue）
})

/**
 * 空闲段（bar 的"未使用"部分）的颜色**由 `src/preload.mjs` 重映射**，
 * 不在这里改 —— 那两格是 `StatusLine.js` 的内联字面量，且 dsh-tui 的组件
 * 在模块加载时就把 `jsx` 捕获成了快照，插件跑起来之后再包装已经无效
 * （实测：日志说成功，但采样仍是 `#2E3440`）。必须靠 `--import` 预加载
 * 抢在 dsh-tui 之前。详见 `preload.mjs` 的文件头。
 */

/**
 * 反光高光色（`FLASH`）。
 *
 * ── 为什么主题管不到 ────────────────────────────────────────────────
 *
 * `shimmer.js` 的四个颜色是模块常量，且**只被 `sweep()` / `renderBigText()`
 * 当参数用**，不经过主题：
 *
 *     export const BRAND = { r: 77,  g: 107, b: 254 }   // 蓝
 *     export const ICE   = { r: 147, g: 190, b: 255 }   // 蓝
 *     export const PALE  = { r: 215, g: 228, b: 255 }   // 蓝
 *     export const FLASH = { r: 198, g: 216, b: 248 }   // 蓝
 *
 * 调用点：
 *     sweep('✦ dsh-TUI', t, wordmarkRGB, wordmarkShimmerRGB, 60)  ← 这处跟主题
 *     sweep(tagline, t, taglineRGB, FLASH, 60)                    ← 高光是死蓝
 *     renderBigText(font, text, t, from, to, FLASH, ...)          ← 扫光也是死蓝
 *
 * 所以换主题后，**字上面扫过的那道反光是蓝的**，跟橙色撞得厉害。
 *
 * 修法：原地改这四个常量的分量（对象未冻结，模块缓存保证各处读到同一份）。
 * `FLASH` 是实际用到的那个；`BRAND`/`ICE`/`PALE` 只作回落，一并改掉以免
 * 哪条路径走到它们。
 */
const SHIMMER_COLORS = Object.freeze({
  // 暖白偏橙的高光 —— 原来是"雾蓝提亮的浪尖"，换成"暖阳照过"
  FLASH: { r: 255, g: 214, b: 170 },
  // 下面三个只在回落路径用得到，给成橙系免得露出蓝色
  BRAND: { r: 232, g: 145, b: 63 },
  ICE: { r: 245, g: 192, b: 138 },
  PALE: { r: 250, g: 214, b: 168 },
})

/**
 * 「点火色」—— 输入框前缀 `❯` 在**最高思考档**时的强调色。
 *
 * ── 这是哪个 `❯` ────────────────────────────────────────────────────
 *
 * 不是用户消息气泡那个（那个跟主题的 `userPromptLabel`），而是**输入框里
 * 紧贴光标左边**那一枚：`EffortChargeGlyph.js` 画的。
 *
 * 平时它是 dim 的（无颜色）；只有思考强度处于**当前路线的最高档**时才点亮，
 * 换成一个强调色并加粗 —— 同一瞬间「点焰波」也用这同一种颜色。
 *
 * 用户的 `effort: max` 正好是最高档，所以那枚箭头一直是亮的。
 *
 * ── 为什么主题管不到 ────────────────────────────────────────────────
 *
 * 颜色来自 `trajectory/effortIgnition.js` 里的模块常量：
 *
 *     const HUES_DARK = [
 *       { r: 130, g: 185, b: 255 },   // ← #82B9FF，就是它
 *       { r: 140, g: 252, b: 248 },
 *       { r: 195, g: 172, b: 255 },
 *     ]
 *
 * 不经过主题系统。注释里写着「与波共用 hues[0]」「同一瞬间前缀与波是同一种
 * 橙」—— 但那三个 hue 都是**冷色**，跟暖橙主题撞得厉害。
 *
 * 消费者只有两个，都读 `ignitionHues()[0]`：
 *     · `EffortChargeGlyph.js` —— 输入框前缀 `❯`
 *     · `EffortTierBadge.js`   —— 强度徽章
 *
 * 修法：原地改 `[0]` 的分量（数组和元素都未冻结，且 `ignitionHues()` 返回的
 * 就是这同一个数组，各处拿到同一份）。改一处两个消费点同时生效。
 *
 * `[1]`/`[2]` 也一并暖化 —— 注释说它们「留给未来的多带风格」，目前没用到，
 * 但留着冷色迟早会露出来。
 */
const IGNITION_HUES = Object.freeze({
  // 深色主题（我们用的）
  dark: {
    // 品牌橙（原来是 #82B9FF 天蓝）
    primary: { r: 232, g: 145, b: 63 },
    secondary: { r: 245, g: 192, b: 138 },
    tertiary: { r: 255, g: 214, b: 170 },
  },
  // 浅色主题：值要更深才在浅底上有对比度（原来是 #1E5FEB 等深冷色）
  light: {
    primary: { r: 196, g: 96, b: 20 },
    secondary: { r: 214, g: 130, b: 40 },
    tertiary: { r: 168, g: 84, b: 30 },
  },
})

/**
 * 把 ctx bar 分段色与反光高光色改成橙色。
 *
 * @param log 日志函数
 * @returns 改了几份 dsh-tui 实例
 */
export async function installOrangeDetails(log = () => {}) {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { tuiPackageRoots } = await import('./tui-roots.mjs')

  let barCount = 0
  let shimmerCount = 0
  let ignitionCount = 0
  const problems = []

  for (const root of tuiPackageRoots()) {
    const lib = join(root, 'lib', 'types')

    // ── ctx bar 的**已用**分段色 ────────────────────────────────
    // `USED_SEGMENTS[i].color` 是渲染时现读的，原地改对象的属性即可。
    const metricsPath = join(lib, 'screens', 'StatusMetrics.js')
    if (existsSync(metricsPath)) {
      try {
        const m = await import(pathToFileURL(metricsPath).href)
        if (Array.isArray(m.USED_SEGMENTS)) {
          let n = 0
          for (const seg of m.USED_SEGMENTS) {
            const hex = BAR_SEGMENTS[seg.key]
            if (hex) { seg.color = hex; n++ }
          }
          if (n > 0) barCount++
        }
      } catch (err) {
        problems.push('StatusMetrics: ' + (err?.message ?? err))
      }
    }

    // ── 反光高光色 ──────────────────────────────────────────────
    // 只改**对象的分量**、不重新赋值 —— 调用方 import 的是对象引用，
    // 换绑定对它们不可见（ESM 具名导入对 `const` 字符串是快照）。
    const shimmerPath = join(lib, 'components', 'shimmer.js')
    if (existsSync(shimmerPath)) {
      try {
        const sh = await import(pathToFileURL(shimmerPath).href)
        let n = 0
        for (const [name, rgb] of Object.entries(SHIMMER_COLORS)) {
          const target = sh[name]
          if (target && typeof target === 'object') {
            target.r = rgb.r; target.g = rgb.g; target.b = rgb.b
            n++
          }
        }
        if (n > 0) shimmerCount++
      } catch (err) {
        problems.push('shimmer: ' + (err?.message ?? err))
      }
    }

    // ── 点火色（输入框前缀 `❯` + 强度徽章）──────────────────────
    // `ignitionHues()` 返回的就是模块内那个数组本身 —— 原地改元素的分量，
    // 两个消费点同时生效。
    const ignPath = join(lib, 'trajectory', 'effortIgnition.js')
    if (existsSync(ignPath)) {
      try {
        const mod = await import(pathToFileURL(ignPath).href)
        let n = 0
        for (const [onLight, want] of [[false, IGNITION_HUES.dark], [true, IGNITION_HUES.light]]) {
          const hues = mod.ignitionHues?.(onLight)
          if (!Array.isArray(hues)) continue
          // 只改 [0]（实际用到的那个）；[1]/[2] 是"未来多带风格"的预留位，
          // 一并暖化免得哪天启用时露出冷色。
          const targets = [want.primary, want.secondary, want.tertiary]
          for (let i = 0; i < targets.length && i < hues.length; i++) {
            const slot = hues[i]
            const rgb = targets[i]
            if (slot && typeof slot === 'object') {
              slot.r = rgb.r; slot.g = rgb.g; slot.b = rgb.b
              n++
            }
          }
        }
        if (n > 0) ignitionCount++
      } catch (err) {
        problems.push('effortIgnition: ' + (err?.message ?? err))
      }
    }
  }

  if (problems.length > 0) log('  部分细节色没改成功：' + problems.join(' | '))
  if (barCount > 0) log(`  ctx 条分段色已改为暖橙（${barCount} 份实例）`)
  if (shimmerCount > 0) log(`  反光高光色已改为暖橙（${shimmerCount} 份实例）`)
  if (ignitionCount > 0) log(`  输入框前缀 ❯ / 强度徽章已改为暖橙（${ignitionCount} 份实例）`)
  return { barCount, shimmerCount, ignitionCount }
}

/**
 * 把橙色主题注册到 dsh-TUI。
 *
 * 必须在 `ctx.tuiThemes` 可用时调用。拿不到服务就静默跳过 ——
 * 老版本 profile 没有这个服务，不该因此让插件挂掉。
 *
 * @param ctx cordis 上下文
 * @param log 日志函数
 * @returns 注册成功与否
 */
export function registerOrangeTheme(ctx, log = () => {}) {
  let themes
  try {
    themes = ctx.get?.('tuiThemes', false)
  } catch {
    themes = undefined
  }
  if (!themes || typeof themes.register !== 'function') {
    log('  tuiThemes 服务不可用，橙色主题没注册（窗口会退回默认蓝色）')
    return false
  }

  let ok = false
  try {
    const dispose = themes.register({
      name: THEME_NAME,
      displayName: '暖橙',
      base: 'dark',
      colors: ORANGE_COLORS,
    })
    if (typeof dispose === 'function') {
      log(`  橙色主题已注册：${THEME_NAME}（${Object.keys(ORANGE_COLORS).length} 个颜色键）`)
      ok = true
    } else {
      log('  橙色主题注册被拒（名字冲突或描述符非法）')
    }
  } catch (err) {
    log('  橙色主题注册失败：' + (err?.message ?? err))
  }

  // 主题只管到「大标题第一行」的取色（`parseRGB(theme.accent)`）。
  // 另外两处是模块常量、不走主题系统，得单独改（见 installOrangeDetails）。
  if (ok) {
    installBigTitlePalette(log).catch((err) => log('  标题调色板装载异常：' + String(err)))
    installOrangeDetails(log).catch((err) => log('  ctx 条/反光色装载异常：' + String(err)))
  }
  return ok
}

/**
 * 给 dsh-TUI 的每款字体补一个暖橙 `palette`，接管大标题两行的渐变端点。
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────
 *
 * `LogoV2.js` 渲染两行大字时：
 *
 *     bigDeepSeek = renderBigText(..., palette?.from ?? wordmarkRGB,
 *                                      palette?.to   ?? taglineRGB, ...)
 *     bigHarness  = renderBigText(..., palette?.from ?? taglineRGB,
 *                                      palette?.to   ?? PALE, ...)
 *                                                 ↑ 模块常量，写死的蓝 #D7E4FF
 *
 * 所以第二行的**终点色**永远偏蓝，主题怎么配都改不到 —— 实测第一行橙、
 * 第二行蓝。唯一的入口是字体的 `palette`（`??` 优先级高于主题色）。
 *
 * ── 代价 ────────────────────────────────────────────────────────────
 *
 * 加了 palette 之后，两行都用**同一对** `from`/`to`，第一行原本
 * 「accent → activity」的双色渐变会变成「from → to」。
 * 我们让 from/to 都是橙系（深橙 → 浅橙），所以两行仍然是渐变、
 * 视觉上也统一，只是不再区分"品牌色/活动色"那层语义。
 *
 * ── 手法 ────────────────────────────────────────────────────────────
 *
 * 跟改 `tagline` 一样：**原地写** `font.palette`，不替换数组项 ——
 * `pickSplashFont()` 返回的是表里的对象本身，八款字体全改才生效
 * （它按日期取模选一款）。
 */
async function installBigTitlePalette(log = () => {}) {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const { tuiPackageRoots } = await import('./tui-roots.mjs')

  let patched = 0
  for (const root of tuiPackageRoots()) {
    const p = join(root, 'lib', 'types', 'components', 'splashFonts.js')
    if (!existsSync(p)) continue
    try {
      const mod = await import(pathToFileURL(p).href)
      if (!Array.isArray(mod.SPLASH_FONTS)) continue
      for (const font of mod.SPLASH_FONTS) {
        // 原地写：palette 在 pickSplashFont() 返回的对象上被读取
        font.palette = PALETTE
      }
      patched++
    } catch { /* 试下一份 */ }
  }
  if (patched > 0) {
    log(`  标题渐变已改为暖橙（${patched} 份 dsh-tui 实例）`)
  }
}
