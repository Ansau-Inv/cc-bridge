// 给开屏大字补字形 —— `CLAUDE CODE` 缺 C L U O，dsh-TUI 字库里没有。
//
// ── 背景 ────────────────────────────────────────────────────────────
//
// dsh-TUI 的字库只有 13 个字母（`A D E H I K M N P R S W Y`），
// 别的字母一律画成 fallback 方块。所以想显示 `CLAUDE CODE` 就得补字形。
//
// ── 三套基准 + 五个派生 ─────────────────────────────────────────────
//
// 八款字体不是八套独立字形，而是**三套基准 + 五个变换**：
//
//   BOLD (6列) ──┬─ SQUARE   圆角填实
//                ├─ BEVEL    按邻居做左亮右暗
//                ├─ WIDE     6→8 列最近邻拉伸
//                ├─ DOT      压成灰度
//                └─ STENCIL  中段挖空
//   CLASSIC (5列) ── 独立一套
//   SLAB (5列)    ── 独立一套
//
// `splashFonts.js` 里那五个变换函数是**模块私有**的，外部拿不到，
// 所以这里重新实现一遍 —— 但**不盲信自己的实现**：
// 每个变换都会拿已有的已知字母（`D`/`E`/`A`）验一遍，
// 对不上就报错、拒绝打补丁（见 `verifyTransform`）。
//
// 这样即使哪天 dsh-TUI 改了变换规则，也是**明确失败**而不是画出错字。

import { tuiPackageRoots, tuiRootTag } from './tui-roots.mjs'

/** 空白格（这些字形里用 `·` 表示"不画"）。 */
const BLANK = '·'

/**
 * BOLD 基准字形（6 列）：竖笔 2 格、横笔 1 像素、圆角用 `▀`/`▄`。
 *
 * 新补的四个字母要跟已有字母的笔法一致 —— 左边竖笔一律占 0-1 两列，
 * 圆角沿用 `A` 的 `·▄▀▀▄·`（顶部拱）与 `D` 的 `██▄▄▀▀`（底部收角）。
 */
const BOLD_NEW = {
  // B：`D` 加一道中横。中横用 `██▀▀██` —— 跟 `A`/`H` 中横的画法一致。
  B: ['██▀▀▄▄', '██··██', '██▀▀██', '██··██', '██▄▄▀▀'],
  // C：`E` 去掉中横，右下收角。顶部拱沿用 A 的画法。
  C: ['·▄▀▀▄·', '██····', '██····', '██····', '██▄▄▄▀'],
  // G：`C` 加右侧的勾（中段收进来、末端往下接到底）。
  G: ['·▄▀▀▄·', '██····', '██·▀▀▀', '██··██', '██▄▄▄▀'],
  // L：光杆 + 底部横bar。`H`/`N` 顶部也是光杆，所以这是同一种笔法。
  L: ['██····', '██····', '██····', '██····', '██▄▄▄▄'],
  // O：`A` 去掉中横 → 上下都收圆角。
  O: ['·▄▀▀▄·', '██··██', '██··██', '██··██', '·▀▄▄▀·'],
  // U：`O` 去掉顶部拱。
  U: ['██··██', '██··██', '██··██', '██··██', '·▀▄▄▀·'],
}

/** CLASSIC 基准字形（5 列）：竖笔 1 格、空心。 */
const CLASSIC_NEW = {
  B: ['█▀▀▀▄', '█···█', '█▀▀▀█', '█···█', '█▄▄▄▀'],
  C: ['█▀▀▀▀', '█····', '█····', '█····', '█▄▄▄▀'],
  G: ['█▀▀▀▀', '█····', '█··▀█', '█···█', '█▄▄▄▀'],
  L: ['█····', '█····', '█····', '█····', '█▄▄▄▄'],
  O: ['·▄▀▄·', '█···█', '█···█', '█···█', '·▀▄▀·'],
  U: ['█···█', '█···█', '█···█', '█···█', '·▀▄▀·'],
}

/** SLAB 基准字形（5 列）：横笔满格、方角实心。 */
const SLAB_NEW = {
  B: ['████·', '█···█', '████·', '█···█', '████·'],
  C: ['████·', '█····', '█····', '█····', '████·'],
  G: ['████·', '█····', '█··██', '█···█', '████·'],
  L: ['█····', '█····', '█····', '█····', '█████'],
  O: ['·███·', '█···█', '█···█', '█···█', '·███·'],
  U: ['█···█', '█···█', '█···█', '█···█', '·███·'],
}

// ════════════════════════════════════════════════════════════════════
// 五个变换（照 splashFonts.js 重实现）
// ════════════════════════════════════════════════════════════════════

const isInk = (cell) => cell === '█' || cell === '▀' || cell === '▄'

/** 方角实心：圆角 `▀`/`▄` 全填成 `█`。 */
const SQUARE = (rows) => rows.map((r) => [...r].map((c) => (c === '▀' || c === '▄' ? '█' : c)).join(''))

/** 点阵灰度：`█`→`▓`、`▀`/`▄`→`▒`。 */
const DOT = (rows) => rows.map((r) => [...r].map((c) => (c === '█' ? '▓' : c === '▀' || c === '▄' ? '▒' : c)).join(''))

/** 宽体：6 列最近邻拉到 8 列（照原式 `floor(x * len / 8)`）。 */
const WIDE = (rows) => rows.map((row) => {
  const cells = [...row]
  return Array.from({ length: 8 }, (_, x) =>
    cells[Math.min(cells.length - 1, Math.floor(x * cells.length / 8))]).join('')
})

/** 半立体：朝上/左的面留亮（`█`），朝下/右的压暗（`▓`）。 */
const BEVEL = (rows) => {
  const solid = (source, x) => isInk(source?.[x] ?? ' ')
  return rows.map((row, y) => [...row].map((cell, x) => {
    if (!isInk(cell)) return cell
    const up = solid(rows[y - 1], x)
    const down = solid(rows[y + 1], x)
    if (!up && !down) return y === rows.length - 1 ? '▓' : '█'
    if (!down) return '▓'
    if (!up) return '█'
    const left = solid(row, x - 1)
    const right = solid(row, x + 1)
    return right || !left ? '█' : '▓'
  }).join(''))
}

/** 镂空模板：中段只在竖笔上留 1 列桥，其余挖空（横笔不动）。 */
const STENCIL = (rows) => rows.map((row, y) => {
  if (y === 0 || y === rows.length - 1) return row
  const above = rows[y - 1] ?? ''
  const below = rows[y + 1] ?? ''
  const vertical = (x) => isInk(above[x] ?? ' ') && isInk(below[x] ?? ' ')
  let bridge = false
  return [...row].map((cell, x) => {
    if (!isInk(cell) || !vertical(x)) { bridge = false; return cell }
    if (!bridge) { bridge = true; return cell }
    return ' '
  }).join('')
})

/** 变换名 → 函数。`bold` / `classic` / `slab` 是基准表，不在这里。 */
const TRANSFORMS = {
  square: SQUARE,
  bevel: BEVEL,
  wide: WIDE,
  dot: DOT,
  stencil: STENCIL,
}

// ════════════════════════════════════════════════════════════════════
// 自校验：拿已知字母比对，确认变换实现没跑偏
// ════════════════════════════════════════════════════════════════════

/** 用基准字形里已有的字母反推 —— 比对不上就说明我的变换实现跟官方不一致。 */
const PROBE_LETTERS = ['D', 'E', 'A', 'H', 'P', 'S']

/**
 * 验一个变换：对每个探针字母，用我的实现算一遍，跟字体表里的实际结果比。
 *
 * @returns 不匹配的字母列表（空 = 实现正确）
 */
function verifyTransform(font, baseGlyphs, transformName) {
  const fn = TRANSFORMS[transformName]
  if (!fn) return []   // 基准款不用验
  const bad = []
  for (const ch of PROBE_LETTERS) {
    const base = baseGlyphs[ch]
    if (!base) continue
    const actual = font.glyphs[ch]
    if (!actual) continue
    const mine = fn(base)
    if (mine.join('\n') !== actual.join('\n')) bad.push(ch)
  }
  return bad
}

// ════════════════════════════════════════════════════════════════════

/**
 * 给所有字体补上缺失的字形。
 *
 * @param log 日志函数
 * @returns { ok, fonts, added, reason? }
 */
export async function addMissingGlyphs(log = () => {}) {
  const { existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')

  let totalFonts = 0
  const addedAll = new Set()
  const errors = []

  for (const root of tuiPackageRoots()) {
    const fontsPath = join(root, 'lib', 'types', 'components', 'splashFonts.js')
    if (!existsSync(fontsPath)) continue
    const tag = tuiRootTag(root)

    let mod
    try {
      mod = await import(pathToFileURL(fontsPath).href)
    } catch (err) {
      errors.push(`${tag}: 加载失败 ${err?.message ?? err}`)
      continue
    }
    if (!Array.isArray(mod.SPLASH_FONTS)) {
      errors.push(`${tag}: 没有导出 SPLASH_FONTS`)
      continue
    }

    for (const font of mod.SPLASH_FONTS) {
      // 判断这款字体属于哪套基准：用字形宽度 + 变换验证来定。
      // bold/square/bevel/dot/stencil 都是 6 列，classic/slab 是 5 列，
      // wide 是 8 列 —— 光看宽度分不出 bold 和 square，所以靠变换自校验。
      const base = pickBase(font)
      if (!base) {
        errors.push(`${tag}/${font.id}: 认不出基准字形`)
        continue
      }

      const { glyphs: baseGlyphs, name: baseName, transform } = base
      if (transform) {
        const bad = verifyTransform(font, baseGlyphs, transform)
        if (bad.length > 0) {
          errors.push(`${tag}/${font.id}: 变换「${transform}」自校验失败（${bad.join(' ')} 对不上），拒绝补字形`)
          continue
        }
      }

      const source = baseGlyphs
      let n = 0
      for (const [ch, rows] of Object.entries(source)) {
        if (ch in font.glyphs) continue
        const shaped = transform ? TRANSFORMS[transform](rows) : rows
        // 宽度必须跟该款字体一致，否则整行会错位
        const want = font.glyphWidth
        if (shaped[0].length !== want) {
          errors.push(`${tag}/${font.id}: 字形 ${ch} 宽 ${shaped[0].length} ≠ 字身 ${want}`)
          continue
        }
        font.glyphs[ch] = shaped
        n++
        addedAll.add(ch)
      }
      if (n > 0) totalFonts++
    }
  }

  if (errors.length > 0) {
    return { ok: false, added: [], fonts: 0, reason: errors.join(' | ') }
  }
  const added = [...addedAll].sort()
  if (added.length === 0) {
    return { ok: true, added: [], fonts: 0 }   // 已经补过了
  }
  log(`  补了字形：${added.join(' ')}（${totalFonts} 款字体）`)
  return { ok: true, added, fonts: totalFonts }
}

/**
 * 认出一款字体用的是哪套基准字形、需不需要变换。
 *
 * 判据：
 *   · 字身 5 列 → classic 还是 slab？用 `D` 的字形区分（slab 是实心横笔 `████·`）
 *   · 字身 8 列 → wide（变换自 6 列 BOLD）
 *   · 字身 6 列 → bold 本体，或 square/bevel/dot/stencil 之一；
 *     逐个试变换，哪个能复现已知字母就是哪个。
 */
function pickBase(font) {
  const w = font.glyphWidth
  if (w === 5) {
    // classic 的 D 顶行是 `█▀▀▀▄`（圆角），slab 的是 `████·`（实心横笔）
    const top = font.glyphs.D?.[0] ?? ''
    const isSlab = top.startsWith('████')
    return isSlab
      ? { name: 'slab', glyphs: SLAB_NEW, transform: null }
      : { name: 'classic', glyphs: CLASSIC_NEW, transform: null }
  }
  if (w === 8) return { name: 'bold', glyphs: BOLD_NEW, transform: 'wide' }
  if (w === 6) {
    // bold 本体：`D` 原样
    if ((font.glyphs.D?.[0] ?? '') === '██▀▀▄▄') {
      return { name: 'bold', glyphs: BOLD_NEW, transform: null }
    }
    // 派生款：逐个试
    for (const name of ['square', 'bevel', 'dot', 'stencil']) {
      const probe = TRANSFORMS[name]({ D: ['██▀▀▄▄', '██··██', '██··██', '██··██', '██▄▄▀▀'] }.D)
      if (probe.join('\n') === (font.glyphs.D ?? []).join('\n')) {
        return { name: 'bold', glyphs: BOLD_NEW, transform: name }
      }
    }
  }
  return null
}
