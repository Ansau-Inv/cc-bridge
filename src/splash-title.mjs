// 换掉开屏右侧那两排大字（`DEEPSEEK` / `HARNESS`）—— 不改 dsh-TUI 的包。
//
// ── 原理 ────────────────────────────────────────────────────────────
//
// 大字由 `splashFonts.js` 的字体表驱动，每款字体带一个 `tagline`：
//
//     { id: 'bold', glyphs: {...}, glyphWidth: 6,
//       tagline: { top: 'DEEPSEEK', bottom: 'HARNESS', topKerning, bottomKerning, bottomIndent } }
//
// 渲染时 `LogoV2.js` 读 `titleFont.tagline.top/bottom` 交给 `renderBigText`：
//
//     const [dailyFont] = React.useState(() => pickSplashFont())
//     const titleFont = dailyEgg === null ? font : withTagline(font, egg.top, egg.bottom)
//     const bigDeepSeek = renderBigText(titleFont, top, ...)
//
// 而 `pickSplashFont()` 就是 `SPLASH_FONTS[day % length]` —— **返回表里的对象本身**
// （不是副本），字体表也没冻结。所以**原地改每个 font 的 tagline** 就能换词。
//
// ── 为什么只改 tagline、不改整个 font ───────────────────────────────
//
// 改词必须**重算字距**，否则两排字不等宽、下排的居中缩进也不对。
// 官方给了 `withTagline(font, top, bottom)` —— 节日彩蛋（圣诞换成 `MERRY`、
// 新年换成 `NEW YEAR`）用的就是它。但它返回一个**新对象**：
//
//     withTagline = (font, top, bottom) => ({ ...font, tagline: {...} })
//
// 直接替换数组项是**不行**的：`DEFAULT_SPLASH_FONT` 是模块加载时捕获的
// `SPLASH_FONTS[0]` 引用，`splashFontById` 也走 `find`，替换数组项会让它们
// 变成陈旧引用。所以做法是**用 withTagline 算好，再 Object.assign 回原对象**——
// 身份不变，值更新。
//
// ── 必须八款字体全改 ────────────────────────────────────────────────
//
// `pickSplashFont()` **按本地日期取模**选字体。只改一款的话，今天恰好不是那款
// 就不生效（第一版就是这么踩的：改了 `SPLASH_FONTS[0]`，日志看着成功，
// 但 `pickSplashFont()` 返回的词纹丝不动）。所以循环改全部八款。
//
// ── 时序是宽容的 ────────────────────────────────────────────────────
//
// `useState(() => pickSplashFont())` 只捕获**字体对象**，而词是每次渲染现读
// `tagline.top` 的。开屏有 ~3.4 秒动画持续重渲染，所以即使补丁打在首帧之后，
// 下一次渲染就会用上新词。
//
// ── ⚠️ 字形限制（唯一的硬约束）──────────────────────────────────────
//
// 字库里**只有 13 个字母**：`A D E H I K M N P R S W Y`。
// 其他字母（B C F G J L O Q T U V X Z）会退化成同一个方块字形。
//
// 所以「CLAUDE」里的 C、L、U 会变成三个一样的方块 —— 能显示，但一眼看得出
// 是缺字。本模块会**明确列出哪些字母没字形**，别让它悄悄画成方块。

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tuiPackageRoots, tuiRootTag } from './tui-roots.mjs'

/**
 * 把词规范成字体能画的形式。
 *
 * 大写、去掉字库里没有的字符之外的空白处理：保留单词间的空格
 * （`renderBigText` 对空格画 `WORD_GAP` 列），但压掉首尾空白与连续空格。
 */
function normalizeWord(text) {
  return String(text).trim().toUpperCase().replace(/\s+/g, ' ')
}

/** 词里哪些字母没有字形（会画成 fallback 方块）。 */
function missingGlyphs(font, word) {
  const missing = new Set()
  for (const ch of word) {
    if (ch === ' ') continue
    if (!(ch in font.glyphs)) missing.add(ch)
  }
  return [...missing]
}

/** 上游 splashFonts.js 的常量：字距上限。 */
const MAX_KERNING = 8
/** 上游 splashLayout.js 的常量：鲸鱼/立绘盒宽（40）与文字列间隔（2）。
 *  **只用于注释里说明布局阶梯的判据**，代码不依赖它们。 */
const WHALE_BOX_WIDTH = 40
const COLUMN_GAP = 2
/**
 * 字距的**下限**：1。
 *
 * 为什么不是 0（虽然上游 `solveTagline` 的兜底分支会试 0）：
 * **字距 0 会让相邻字母粘在一起**。每个字形左右两侧各占 2 列
 * （如 `U` = `██··██`），字距 0 时上一字母的右竖笔和下一字母的左竖笔
 * 紧挨着，合并成一根 4 列宽的柱子 —— 实测截图里 `CLAUDE` 的 `D`
 * 看起来像缺了左半边。可读性不能让位给宽度。
 */
const MIN_KERNING = 1
/**
 * 允许的最大对齐误差。
 *
 * 上游 `solveTagline` 用 `error <= 1` 判定"两排视觉等宽"，超了就只记
 * 最接近的解、并把两排各自居中（下排偏一点）。这里放到 6 是因为：
 * 长词在严格契约下常常**只有宽解**（`CLAUDE CODE` 只有 82 列），
 * 而那个宽度会把立绘挤掉。误差的视觉含义是 `error/2` 列偏差 ——
 * 放到 6（偏 3 列）换来一幅立绘，划算。
 */
const MAX_ERROR = 6

/**
 * 在**上游契约允许的范围内**找一组字距，让画出来的宽度尽量贴近目标。
 *
 * ── 为什么需要这个 ──────────────────────────────────────────────────
 *
 * 官方的 `solveTagline` 只保证**两排互相等宽居中**，而且字距从**最小值**
 * （`minKerning = 1`）往上试、命中第一个解就返回 —— 它**不管整块占多宽**：
 *
 *   · 词短了偏窄：`CLAUDE`/`CODE` 只有 42 列（原版 56），右边空一截
 *   · 词长了偏宽：`CLAUDE CODE`/`BRIDGE` 到 82 列，**把立绘挤掉**
 *
 * ── 为什么要分级放宽误差 ────────────────────────────────────────────
 *
 * 上游的布局阶梯（`resolveSplashLayout`）要求：
 *
 *     titleWidth + COLUMN_GAP + WHALE_BOX_WIDTH <= 内容列数
 *
 * 不满足就**撤掉鲸鱼/立绘**（它优先保大字）。而 `CLAUDE CODE` 这种长词
 * 在上游严格契约（误差 ≤ 1）下**只有 82 列一个解**，实测正好把立绘挤掉
 * （截图橙色像素数 = 0，差 2 列）。
 *
 * 所以搜索分两级：
 *
 *   ① 先用上游的严格契约（误差 ≤ 1）—— 这是"正确"的解
 *   ② 若 ① 的结果宽到会挤掉立绘，**逐级放宽误差**（2 → 3 …），
 *      换一个窄一点、但两排居中差半格/一格的解
 *
 * 误差的视觉含义是 `err/2` 列的对齐偏差 —— `err=2` 就是下排偏半格，
 * 肉眼几乎看不出；比丢掉整幅立绘划算得多。放宽时会在日志里**说明**。
 *
 * ── 为什么目标是动态算的、不写死 56 ────────────────────────────────
 *
 * 拿**改词之前**那个字体的宽度现算 —— 上游换了默认词/字距时自动跟着变。
 *
 * ── 约束（照抄 solveTagline 的判据）────────────────────────────────
 *
 *   · `bottomIndent >= 0` —— 下排不能比上排宽，否则居中缩进没意义
 *   · `|bigTextWidth(top) - bigTextWidth(bottom) - 2*indent| <= maxError`
 *   · 字距上限 `MAX_KERNING = 8`
 *
 * 度量直接用**上游导出的** `paintedWidth` / `bigTextWidth`，
 * 不自己重实现公式 —— 免得哪天上游改了算术这里跟着漂移。
 *
 * @param targetWidth 目标宽度（列）
 * @param maxCoexist 能跟立绘并存的宽度上限（`null` = 不限制）
 * @returns { topKerning, bottomKerning, bottomIndent, width, error, relaxed } 或 null
 */
function solveTaglineNear(font, top, bottom, bigfont, targetWidth, maxCoexist) {
  const metrics = { glyphWidth: font.glyphWidth }

  /**
   * 在给定误差容忍度下，找离 targetWidth 最近的解。
   *
   * 同等距离时依次偏好：**误差小**（两排更齐）→ **宽度小**（宁可留白，
   * 不要溢出/挤掉立绘）。这个偏好顺序是有意的：实测 62 列（err 2）和
   * 82 列（err 1）两个解里，62 列能让立绘活下来，82 列会把立绘挤掉。
   */
  const search = (maxError) => {
    let best = null
    for (let kt = MIN_KERNING; kt <= MAX_KERNING; kt++) {
      for (let kb = MIN_KERNING; kb <= MAX_KERNING; kb++) {
        const indent = bigfont.paintedWidth(metrics, top, kt) - bigfont.paintedWidth(metrics, bottom, kb)
        if (indent < 0) continue
        const error = Math.abs(
          bigfont.bigTextWidth(metrics, top, kt) -
          bigfont.bigTextWidth(metrics, bottom, kb) - 2 * indent)
        if (error > maxError) continue
        const width = bigfont.paintedWidth(metrics, top, kt)
        const dist = Math.abs(width - targetWidth)
        if (!best || dist < best.dist
          || (dist === best.dist && error < best.error)
          || (dist === best.dist && error === best.error && width < best.width)) {
          best = { topKerning: kt, bottomKerning: kb, bottomIndent: indent, width, error, dist }
        }
      }
    }
    return best
  }

  // 一次搜到底、容忍度放到 6 —— 靠上面的偏好顺序自然选出合适的解。
  //
  // 为什么不先严格再逐级放宽：实测 `CLAUDE CODE`/`BRIDGE` 在严格契约
  // （误差 ≤ 1）下**只有 82 列一个解**，而 82 列会把立绘挤掉（橙色像素数
  // 归零）。放宽到误差 2 就多出 62 列的窄解 —— `err=2` 的视觉含义是下排
  // 偏 1 列，肉眼几乎看不出，比丢掉整幅立绘划算得多。
  const best = search(MAX_ERROR)
  return best ? { ...best, relaxed: best.error > 1 } : null

}

/**
 * 给一份 dsh-tui 换掉开屏大字。
 *
 * @param root dsh-tui 包目录
 * @param top 上排词（`undefined`/空串 = 保持原样）
 * @param bottom 下排词（同上）
 * @param log 日志函数
 * @returns 'ok' | 'skip' | 'no-tagline' | 'same'
 */
async function patchSplashTitle(root, top, bottom, log, bigfont, stretchedLoggedRef) {
  const fontsPath = join(root, 'lib', 'types', 'components', 'splashFonts.js')
  if (!existsSync(fontsPath)) return 'skip'

  const mod = await import(pathToFileURL(fontsPath).href)
  if (!Array.isArray(mod.SPLASH_FONTS) || typeof mod.withTagline !== 'function') {
    return 'no-tagline'
  }

  let changed = 0
  let warned = false
  // 「字距拉到 N 列」只报一次（八款字体算出来一样）
  let stretchedLogged = stretchedLoggedRef?.value ?? false

  for (const font of mod.SPLASH_FONTS) {
    const nextTop = top || font.tagline.top
    const nextBottom = bottom || font.tagline.bottom
    if (nextTop === font.tagline.top && nextBottom === font.tagline.bottom) continue

    // 缺字警告只报一次（八款字体的字形表是一样的）
    if (!warned) {
      const missing = [...new Set([
        ...missingGlyphs(font, nextTop),
        ...missingGlyphs(font, nextBottom),
      ])]
      if (missing.length > 0) {
        const available = Object.keys(font.glyphs).sort().join(' ')
        log(`  ⚠️ 这些字母字库里没有，会画成方块：${missing.join(' ')}`)
        log(`     可用字母：${available}`)
      }
      warned = true
    }

    // 目标宽度 = **改词之前**这个字体原本画多宽（原版是 56 列）。
    //
    // ⚠️ 特意**不看终端列数**：`process.stdout.columns` 在 apply() 时读到的
    // 是过时值（实测报 107，而实际内容宽 ≥ 124 —— 立绘和 82 列大字能同时
    // 显示）。拿它当约束会误判，反而选错解。
    //
    // 只对齐原版宽度就够了：偏好顺序（误差小 → 宽度小）会自然选出
    // 62 列那个解 —— 比原版略宽、又不会挤掉立绘。
    const metrics = { glyphWidth: font.glyphWidth }
    const targetWidth = bigfont
      ? bigfont.paintedWidth(metrics, font.tagline.top, font.tagline.topKerning)
      : 0

    // 用官方的 withTagline 算字距（保证两排等宽），再**原地写回** ——
    // 不替换数组项，避免 DEFAULT_SPLASH_FONT / splashFontById 拿到陈旧引用。
    Object.assign(font.tagline, mod.withTagline(font, nextTop, nextBottom).tagline)

    // 再把字距挪到贴近目标宽度 —— 官方只保证"两排互相等宽"，不管整块占多宽：
    // 词短了右边空一截（CLAUDE/CODE 只有 42 列），词长了会把立绘挤掉
    // （CLAUDE CODE/BRIDGE 到 82 列）。见 solveTaglineNear 的注释。
    // 度量用上游 bigfont 导出的函数，不自己重算公式。
    if (bigfont && targetWidth > 0) {
      const fitted = solveTaglineNear(font, nextTop, nextBottom, bigfont, targetWidth)
      if (fitted && fitted.width > 0) {
        font.tagline.topKerning = fitted.topKerning
        font.tagline.bottomKerning = fitted.bottomKerning
        font.tagline.bottomIndent = fitted.bottomIndent
        if (!stretchedLogged) {
          const delta = fitted.width - targetWidth
          log(`  字距对齐到 ${fitted.width} 列` +
            `（原版 ${targetWidth} 列，${delta === 0 ? '正好' : delta > 0 ? '+' + delta : delta}` +
            `；字距 ${fitted.topKerning}/${fitted.bottomKerning} 缩进 ${fitted.bottomIndent}）`)
          if (fitted.relaxed) {
            log(`     （严格契约下只有更宽的解，放到误差 ${fitted.error}` +
              ` ＝ 下排偏 ${(fitted.error / 2).toFixed(1)} 列，` +
              `换来立绘不被挤掉）`)
          }
          stretchedLogged = true
          if (stretchedLoggedRef) stretchedLoggedRef.value = true
        }
      } else {
        log('  ⚠️ 找不到任何字距解，沿用官方 withTagline 的结果')
      }
    }
    changed++
  }

  return changed > 0 ? 'ok' : 'same'
}

/**
 * 给每一份找得到的 dsh-tui 都换掉开屏大字。
 *
 * 会**先自动补缺失的字形**（见 `splash-glyphs.mjs`）—— 字库里原本只有
 * 13 个字母，`CLAUDE CODE` 这种词需要 `C L U O`。补不上的字母才会警告。
 *
 * @param top 上排词
 * @param bottom 下排词
 * @param log 日志函数
 * @returns { ok, patched, reason? }
 */
export async function installSplashTitle(top, bottom, log = () => {}) {
  const wantTop = top ? normalizeWord(top) : ''
  const wantBottom = bottom ? normalizeWord(bottom) : ''
  if (!wantTop && !wantBottom) {
    return { ok: false, patched: [], reason: '没给词（splashTitle / splashSubtitle 都是空的）' }
  }

  // 先补字形。补不了的（真没设计过的字母）留给下面的警告报出来。
  const glyphMod = await import(pathToFileURL(join(import.meta.dirname, 'splash-glyphs.mjs')).href)
  const glyphResult = await glyphMod.addMissingGlyphs(log)
  if (!glyphResult.ok) {
    log('  字形补充有问题（继续，可能画出方块）：' + glyphResult.reason)
  }

  // 字距拉伸要用上游的度量函数（`paintedWidth` / `bigTextWidth`），
  // 从第一份能加载的 dsh-tui 里拿 —— 八份实例的算术是一样的。
  let bigfont = null
  for (const root of tuiPackageRoots()) {
    const p = join(root, 'lib', 'types', 'components', 'bigfont.js')
    if (!existsSync(p)) continue
    try {
      const m = await import(pathToFileURL(p).href)
      if (typeof m.paintedWidth === 'function' && typeof m.bigTextWidth === 'function') {
        bigfont = m
        break
      }
    } catch { /* 试下一份 */ }
  }
  if (!bigfont) log('  ⚠️ 拿不到 bigfont 的度量函数，字距不做拉伸（右边可能空一截）')


  const patched = []
  const errors = []
  const stretchedLoggedRef = { value: false }

  for (const root of tuiPackageRoots()) {
    const tag = tuiRootTag(root)
    try {
      const r = await patchSplashTitle(root, wantTop, wantBottom, log, bigfont, stretchedLoggedRef)
      if (r === 'ok') {
        patched.push(root)
        log(`  · ${tag}: ${wantTop || '(原样)'} / ${wantBottom || '(原样)'}`)
      } else {
        errors.push(`${tag}: ${r}`)
      }
    } catch (err) {
      errors.push(`${tag}: ${err?.message ?? err}`)
    }
  }

  if (patched.length === 0) {
    return { ok: false, patched, reason: errors.join(' | ') || '找不到任何 dsh-tui 包' }
  }
  log(`开屏大字已更换：${patched.length} 份 dsh-tui 实例`)
  return { ok: true, patched, glyphsAdded: glyphResult.added }
}

/** 供外部（诊断 / 测试）查字库有哪些字母。 */
export async function availableGlyphs(root = tuiPackageRoots()[0]) {
  if (!root) return []
  const fontsPath = join(root, 'lib', 'types', 'components', 'splashFonts.js')
  if (!existsSync(fontsPath)) return []
  const mod = await import(pathToFileURL(fontsPath).href)
  return Object.keys(mod.SPLASH_FONTS[0]?.glyphs ?? {}).sort()
}
