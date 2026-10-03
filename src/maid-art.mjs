// 让 cc-bridge 的会话换上自定义立绘 —— 不改 dsh-TUI 的包。
//
// ── 为什么有两套机制 ────────────────────────────────────────────────
//
// dsh-TUI 的标题立绘按终端能力**二选一**渲染（LogoV2.js）：
//
//     whaleGirl ? (maidImageActive ? <MaidPortrait/> : <WhaleGirlArt/>) : <WhaleArt/>
//
//   · `MaidPortrait` —— 真图。需要 sharp 解 PNG + 终端支持 Kitty/Sixel。
//   · `WhaleGirlArt` —— 字符画。30×30 半块精灵，兜底用。
//
// 这台机器**两条都可能走**（sharp 装得上、Windows Terminal 认 Sixel），
// 实测当前走的是**真图**那条。所以这里**两套都换** —— 换哪套都不会漏。
//
// ── 真图那条路：覆写缓存的像素缓冲 ──────────────────────────────────
//
// `maidPortrait.js` 的 `loadMaidPortraits()` 是**模块级缓存**（`loadOnce ??=`），
// 返回 `{ normal: {data, width, height}, happy: {...} }`，其中 `data` 是
// 可写的 `Uint8Array`。
//
// `Image.js` 把它当**引用**传给 ink host（`imageData: image?.data`），
// 而 `isTerminalImageSource` 只校验：
//     data instanceof Uint8Array && data.byteLength === width*height*4
//
// 所以**原地覆写 data 的内容、尺寸不变**，渲染出来的就是我们自己的图。
// 不能改 width/height —— 改了 byteLength 就对不上，会被判为非法源、
// 静默退回 alt 文本（什么都不显示）。
//
// ── 字符画那条路：覆写预渲染的 ANSI 行 ──────────────────────────────
//
// `WhaleGirl.js` 导出 `WHALE_GIRL_ROWS`（15 行 ANSI 字符串），
// `WhaleGirlArt` 每次渲染都读它。`export const` 只约束绑定不可重赋值，
// **不约束数组内容** —— 原地改 `rows[i]` 即可。
//
// ── 多份 dsh-tui 的坑 ───────────────────────────────────────────────
//
// 系统里可能有**多份** dsh-tui（实测三份：npm 全局、profile、profile-safe），
// 各自是**不同的模块实例**，改 A 不影响 B。这和 README 第 2 条
// 「dsh-scope 两份实例」是同一类问题。
//
// 第一版只改 profile 那份 → 「装载成功」但界面纹丝不动（红色块探针
// 零像素，才定位到这条）。对策很朴素：**每份都打一遍补丁**。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tuiPackageRoots, tuiRootTag } from './tui-roots.mjs'

/** 字符画精灵的列数（dsh-TUI 硬编码）。 */
const SPRITE_COLS = 30
/** 字符画精灵的行数（半块渲染 → 15 个文本行）。 */
const SPRITE_ROWS = 30

// ════════════════════════════════════════════════════════════════════
// 真图路径
// ════════════════════════════════════════════════════════════════════

/**
 * 重采样到指定尺寸，alpha 预乘。
 *
 * **按缩放方向选滤波器** —— 这是必要的，不是讲究：
 *
 *   · 缩小（scale < 1）→ **面积平均**（box filter）。
 *     双线性在缩小场景只采 2×2 邻域，比例一大就**漏掉大量源像素**，
 *     高频细节折叠成摩尔纹。实测 1254 → 412（缩 3 倍）时，蕾丝边和
 *     书本纹理出现明显噪点；改成面积平均后干净了。
 *
 *   · 放大（scale > 1）→ **双线性**。面积平均在放大时退化成最近邻，
 *     会有块状感。
 *
 * alpha 预乘是必须的：透明像素的 RGB 通常是 0（黑），不预乘的话
 * 边缘会被染成灰黑色描边。
 */
function resample(img, outW, outH) {
  const scaleX = outW / img.width
  const scaleY = outH / img.height
  // 只要有一个方向在缩小，就用面积平均（缩小方向更需要抗混叠）
  return (scaleX < 1 || scaleY < 1)
    ? resampleBox(img, outW, outH)
    : resampleBilinear(img, outW, outH)
}

/**
 * 像素化强度：目标尺寸的 1/N 分辨率。
 *
 * ── 怎么做 ──────────────────────────────────────────────────────────
 *
 * 把图**降采样到 1/N**，再用**最近邻放大回目标尺寸** —— 每个 N×N 方块
 * 取同一个颜色，就形成像素块。
 *
 * 关键是两步的滤波器**必须不同**：降采样用面积平均（否则丢像素、出摩尔纹），
 * 放大必须用最近邻（双线性会把方块边缘抹平，像素感就没了）。
 *
 * ── 为什么是 5 ──────────────────────────────────────────────────────
 *
 * 逐档试过：N=2 色块感偏弱、N=3 仍偏保守，N=5 的方块明显但不至于糊成
 * 一团（脸的轮廓、头发层次、书本还认得出）。用户选定 5。
 *
 * 改这个值就能调强度 —— 1 = 关掉（平滑），6 以上开始丢细节。
 */
const PIXELATE = 5

/**
 * 色阶量化步长（每通道按这个数取整）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *
 * 光做像素化**不够** —— 和 dsh-TUI 原版立绘并排看，风格明显不是一个体系：
 * 原版是**手绘像素画**（大片平坦色 + 硬边），我这边像**照片打码**
 * （色阶连续、每块都略有差别）。
 *
 * 根因在源图的出身：原版是作者按像素画的 464×464 素材；我们这张是
 * **抗锯齿插画**（1254×1254），缩下来每个方块的平均色都不一样。
 * 量化前实测 **3094 种不透明色**，而原版是有限色阶。
 *
 * 量化把连续渐变压成色带，邻近方块合并成同一片平坦色 —— 这一步才是
 * 「像像素画」和「像马赛克」的分界。
 *
 * ── 为什么是 24 ─────────────────────────────────────────────────────
 *
 * 逐档比过（都叠在 N=5 上，按屏幕真实尺度并排看）：
 *
 *   | 步长 | 色数 | 观感                         |
 *   |------|------|------------------------------|
 *   | 关   | 3094 | 照片渐变，不像像素画         |
 *   | 16   |  198 | 开始有平坦色，仍偏细腻       |
 *   | 24   |  106 | **平坦色 + 硬边，最接近原版** |
 *   | 32   |   65 | 更扁平，蕾丝开始简化         |
 *   | 40   |   38 | 细节丢失（蕾丝糊了）         |
 *
 * 设 0 就关掉量化。
 */
const QUANTIZE_STEP = 24

/**
 * alpha 硬化阈值：低于它的像素判为全透明。
 *
 * 缩放会在轮廓上留下半透明毛边（抗锯齿残留）—— 手绘像素画是**硬边**的，
 * 所以把边缘收成「实心 / 透明」两态。128 是常见的中点。
 */
const ALPHA_CUTOFF = 128

/**
 * 色阶量化 + alpha 硬化。
 *
 * 每通道按 `step` 取整，让原本连续的渐变塌成有限的几档 —— 邻近方块因此
 * 合并成同一片平坦色，这正是手绘像素画的观感来源。
 *
 * alpha 顺带硬化：源图抗锯齿留下的半透明边缘收成实心，轮廓变利落。
 *
 * @param img 已像素化的图
 * @param step 量化步长（0 = 跳过）
 * @param alphaCutoff 低于此值的 alpha 视为全透明
 */
function quantize(img, step, alphaCutoff) {
  if (!(step > 0)) return img
  const out = new Uint8Array(img.data.length)
  for (let i = 0; i < img.data.length; i += 4) {
    // 透明像素保持全透明（RGB 留在 0，不参与后续混合）
    if (img.data[i + 3] < alphaCutoff) continue
    out[i + 3] = 255
    for (let c = 0; c < 3; c++) {
      const v = img.data[i + c]
      out[i + c] = Math.max(0, Math.min(255, Math.round(v / step) * step))
    }
  }
  return { width: img.width, height: img.height, data: out }
}

/**
 * 像素化：降采样到 1/N 再最近邻放大回来。
 *
 * alpha 的处理很关键：降采样时按 alpha 预乘求平均，否则透明区的黑色会把
 * 边缘块拉暗、出现脏边；放大是纯拷贝，直接带 alpha 一起搬。
 *
 * @param img 已经是目标尺寸的图
 * @param factor N（1 = 原样返回）
 */
function pixelate(img, factor) {
  if (!(factor > 1)) return img
  const w = Math.max(1, Math.round(img.width / factor))
  const h = Math.max(1, Math.round(img.height / factor))
  const small = resampleBox(img, w, h)
  // 最近邻放大 —— 不能用 resample()（它会按方向选双线性，把方块抹平）
  const { width: sw, height: sh, data: sd } = small
  const out = new Uint8Array(img.width * img.height * 4)
  for (let y = 0; y < img.height; y++) {
    const sy = Math.min(sh - 1, Math.floor(y * sh / img.height))
    for (let x = 0; x < img.width; x++) {
      const sx = Math.min(sw - 1, Math.floor(x * sw / img.width))
      const i = (sy * sw + sx) * 4
      const o = (y * img.width + x) * 4
      out[o] = sd[i]; out[o + 1] = sd[i + 1]; out[o + 2] = sd[i + 2]; out[o + 3] = sd[i + 3]
    }
  }
  return { width: img.width, height: img.height, data: out }
}

/**
 * 面积平均：每个目标像素取它覆盖的**全部**源像素的加权平均。
 *
 * 权重按覆盖面积算（边缘像素只被覆盖一部分），所以不是简单算术平均 ——
 * 否则非整数倍缩放时会有半像素偏移。
 */
function resampleBox(img, outW, outH) {
  const { width: sw, height: sh, data: sd } = img
  const out = new Uint8Array(outW * outH * 4)
  const xScale = sw / outW
  const yScale = sh / outH

  for (let y = 0; y < outH; y++) {
    // 这个目标像素在源图上覆盖的纵向区间
    const sy0 = y * yScale
    const sy1 = Math.min(sh, (y + 1) * yScale)
    const iy0 = Math.floor(sy0)
    const iy1 = Math.min(sh - 1, Math.ceil(sy1) - 1)

    for (let x = 0; x < outW; x++) {
      const sx0 = x * xScale
      const sx1 = Math.min(sw, (x + 1) * xScale)
      const ix0 = Math.floor(sx0)
      const ix1 = Math.min(sw - 1, Math.ceil(sx1) - 1)

      let aSum = 0, rSum = 0, gSum = 0, bSum = 0, wSum = 0
      for (let sy = iy0; sy <= iy1; sy++) {
        // 纵向覆盖比例
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)
        if (wy <= 0) continue
        for (let sx = ix0; sx <= ix1; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0)
          if (wx <= 0) continue
          const w = wx * wy
          const i = (sy * sw + sx) * 4
          const a = sd[i + 3]
          aSum += a * w
          // 预乘：颜色按 alpha 加权，透明像素不参与拉低亮度
          rSum += sd[i] * a * w
          gSum += sd[i + 1] * a * w
          bSum += sd[i + 2] * a * w
          wSum += w
        }
      }

      const o = (y * outW + x) * 4
      if (wSum === 0) continue
      const a = aSum / wSum
      out[o + 3] = Math.max(0, Math.min(255, Math.round(a)))
      if (a > 0) {
        // 除以 (a * wSum) 而不是 wSum —— 预乘后的反归一化
        out[o] = clamp255(rSum / (a * wSum))
        out[o + 1] = clamp255(gSum / (a * wSum))
        out[o + 2] = clamp255(bSum / (a * wSum))
      }
    }
  }
  return { width: outW, height: outH, data: out }
}

/** 双线性插值（放大用），alpha 预乘。 */
function resampleBilinear(img, outW, outH) {
  const { width: sw, height: sh, data: sd } = img
  const out = new Uint8Array(outW * outH * 4)
  for (let y = 0; y < outH; y++) {
    const sy = (y + 0.5) * sh / outH - 0.5
    const y0 = Math.max(0, Math.floor(sy))
    const y1 = Math.min(sh - 1, y0 + 1)
    const fy = Math.max(0, Math.min(1, sy - y0))
    for (let x = 0; x < outW; x++) {
      const sx = (x + 0.5) * sw / outW - 0.5
      const x0 = Math.max(0, Math.floor(sx))
      const x1 = Math.min(sw - 1, x0 + 1)
      const fx = Math.max(0, Math.min(1, sx - x0))

      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy)
      const w01 = (1 - fx) * fy, w11 = fx * fy

      const a = sd[i00+3]*w00 + sd[i10+3]*w10 + sd[i01+3]*w01 + sd[i11+3]*w11
      const o = (y * outW + x) * 4
      out[o + 3] = clamp255(a)
      if (a > 0) {
        out[o]     = clamp255((sd[i00]*sd[i00+3]*w00 + sd[i10]*sd[i10+3]*w10 + sd[i01]*sd[i01+3]*w01 + sd[i11]*sd[i11+3]*w11) / a)
        out[o + 1] = clamp255((sd[i00+1]*sd[i00+3]*w00 + sd[i10+1]*sd[i10+3]*w10 + sd[i01+1]*sd[i01+3]*w01 + sd[i11+1]*sd[i11+3]*w11) / a)
        out[o + 2] = clamp255((sd[i00+2]*sd[i00+3]*w00 + sd[i10+2]*sd[i10+3]*w10 + sd[i01+2]*sd[i01+3]*w01 + sd[i11+2]*sd[i11+3]*w11) / a)
      }
    }
  }
  return { width: outW, height: outH, data: out }
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)))
}

// ════════════════════════════════════════════════════════════════════
// 像素画源图：识别 + 几何对齐
// ════════════════════════════════════════════════════════════════════

/** 内容外接框（alpha > threshold 的范围）。全透明则返回 null。 */
function bboxOf(img, threshold = 16) {
  const { width, height, data } = img
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** 按矩形裁切（自动夹紧到图内）。 */
function cropTo(img, rect) {
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y)
  const x1 = Math.min(img.width, rect.x + rect.w)
  const y1 = Math.min(img.height, rect.y + rect.h)
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0)
  if (w === img.width && h === img.height && x0 === 0 && y0 === 0) return img
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.width + x0) * 4
    out.set(img.data.subarray(from, from + w * 4), y * w * 4)
  }
  return { width: w, height: h, data: out }
}

/**
 * 两张图共用的裁切框 —— 取**内容外接框的并集**。
 *
 * ── 为什么必须共用 ──────────────────────────────────────────────────
 *
 * `MaidPortrait` 点击时在 normal / happy 两个缓冲间切换，两者**同画布**。
 * 如果各自按自己的内容裁边，两张图的宽高比就不同 → 缩放比例不同 →
 * 同一张脸在两帧里位置不一样，**点一下人就跳**。
 *
 * 实测这组图正好踩中：身体部分逐像素一致（x 都是 88..983），但 #7 多了
 * 右上角一滴汗，外接框顶部从 y=112 抬到 y=72。独立裁切后高度 912 vs 952，
 * 差 40px ≈ 画布高度的 4% —— 肉眼可见的位移。
 *
 * 取并集后两图裁成同一块 → 同比例缩放 → 几何严格对齐。
 */
async function sharedCropFor(pngPath, happyPath) {
  const key = `${pngPath}|${happyPath ?? ''}`
  if (cropCache.has(key)) return cropCache.get(key)

  const { decodePng } = await loadSpriteTools()
  const boxes = []
  for (const p of [pngPath, happyPath].filter(Boolean)) {
    try {
      const b = bboxOf(decodePng(readFileSync(p)))
      if (b) boxes.push(b)
    } catch { /* 解不开的图交给后面报错，这里只是量尺寸 */ }
  }
  let crop = null
  if (boxes.length) {
    const x0 = Math.min(...boxes.map((b) => b.x))
    const y0 = Math.min(...boxes.map((b) => b.y))
    const x1 = Math.max(...boxes.map((b) => b.x + b.w))
    const y1 = Math.max(...boxes.map((b) => b.y + b.h))
    crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }
  cropCache.set(key, crop)
  return crop
}

/** 裁切框缓存（三份 dsh-tui 会各调一次，别重复解码）。 */
const cropCache = new Map()

let spriteToolsPromise = null
function loadSpriteTools() {
  spriteToolsPromise ??= import(
    pathToFileURL(join(import.meta.dirname, 'sprite-tools.mjs')).href)
  return spriteToolsPromise
}

/**
 * 探测源图**本身就是像素画**，是的话返回它的像素块边长 N（否则 0）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *
 * `PIXELATE` + `QUANTIZE_STEP` 是为**抗锯齿插画**准备的补偿手段（把照片感
 * 的连续渐变压成平坦色）。但用户后来直接给了**已经画好的像素画**：
 * 8×8 像素块零误差、10 色手绘调色板。
 *
 * 再走一遍那条管线就是**二次破坏**：
 *   · 面积平均重采样会把硬边糊成过渡色
 *   · 再 pixelate 一次等于二次像素化
 *   · quantize(24) 会把作者精心选的 10 色改掉
 *
 * 所以先探测：命中就走「抽逻辑网格 → 最近邻放大」的无损路径。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *
 * 先试**严格**（块内每像素完全相同）—— 手绘像素画导出后就是这样。
 * 不中再试**宽松**（块内极差 ≤ 6）+ **调色板 ≤ 32 色**。
 * 两个条件是「与」的关系：光看块内极差不够，平滑渐变的插画在 8×8 小窗口里
 * 极差也很小，必须再加「颜色少」这条才能区分开。
 */
function detectPixelBlock(img) {
  const { width, height, data } = img
  for (const n of [16, 12, 10, 8, 6, 5, 4, 3, 2]) {
    if (width % n || height % n) continue
    if (blocksUniform(data, width, height, n, 0)) return n
  }
  for (const n of [16, 12, 10, 8, 6, 5, 4, 3, 2]) {
    if (width % n || height % n) continue
    if (!blocksUniform(data, width, height, n, 6)) continue
    // 颜色少才算像素画
    const seen = new Set()
    let tooMany = false
    for (let y = 0; y < height && !tooMany; y += n) {
      for (let x = 0; x < width; x += n) {
        const i = (y * width + x) * 4
        if (data[i + 3] < 16) continue
        // 量化到 5 位/通道再计数
        seen.add(((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3))
        if (seen.size > 32) { tooMany = true; break }
      }
    }
    if (!tooMany) return n
  }
  return 0
}

/** 所有 n×n 块内是否一致（极差 ≤ tolerance）。 */
function blocksUniform(data, width, height, n, tolerance) {
  for (let by = 0; by < height; by += n) {
    for (let bx = 0; bx < width; bx += n) {
      const i0 = (by * width + bx) * 4
      const r = data[i0], g = data[i0 + 1], b = data[i0 + 2], a = data[i0 + 3]
      for (let y = by; y < by + n; y++) {
        for (let x = bx; x < bx + n; x++) {
          const i = (y * width + x) * 4
          if (Math.abs(data[i] - r) > tolerance ||
              Math.abs(data[i + 1] - g) > tolerance ||
              Math.abs(data[i + 2] - b) > tolerance ||
              Math.abs(data[i + 3] - a) > tolerance) return false
        }
      }
    }
  }
  return true
}

/**
 * 抽出逻辑网格：每个 n×n 块取左上角那一个像素。
 *
 * 块内是均匀的（`detectPixelBlock` 已经确认），所以**取一个就是全部** ——
 * 不用求平均，颜色是**原样**搬过来的，作者选的色一个不改。
 */
function toLogicalGrid(img, n) {
  const gw = Math.floor(img.width / n), gh = Math.floor(img.height / n)
  const out = new Uint8Array(gw * gh * 4)
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = ((gy * n) * img.width + gx * n) * 4
      const o = (gy * gw + gx) * 4
      out[o] = img.data[i]; out[o + 1] = img.data[i + 1]
      out[o + 2] = img.data[i + 2]; out[o + 3] = img.data[i + 3]
    }
  }
  return { width: gw, height: gh, data: out }
}

/** 最近邻重采样 —— 像素画专用：不插值，颜色和硬边都原样保留。 */
function resampleNearest(img, outW, outH) {
  const { width: sw, height: sh, data: sd } = img
  const out = new Uint8Array(outW * outH * 4)
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(sh - 1, Math.floor(y * sh / outH))
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(sw - 1, Math.floor(x * sw / outW))
      const i = (sy * sw + sx) * 4, o = (y * outW + x) * 4
      out[o] = sd[i]; out[o + 1] = sd[i + 1]
      out[o + 2] = sd[i + 2]; out[o + 3] = sd[i + 3]
    }
  }
  return { width: outW, height: outH, data: out }
}

/** 补足宽高比：**补透明边而不是裁切** —— 不丢内容、也不变形。 */
function padToRatio(img, outW, outH) {
  const targetRatio = outW / outH
  const srcRatio = img.width / img.height
  if (Math.abs(srcRatio - targetRatio) <= 1e-3) return img
  let w = img.width, h = img.height
  if (srcRatio > targetRatio) h = Math.round(img.width / targetRatio)
  else w = Math.round(img.height * targetRatio)
  const padded = new Uint8Array(w * h * 4)
  const ox = Math.floor((w - img.width) / 2), oy = Math.floor((h - img.height) / 2)
  for (let y = 0; y < img.height; y++) {
    padded.set(
      img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4),
      ((y + oy) * w + ox) * 4,
    )
  }
  return { width: w, height: h, data: padded }
}

/**
 * 把用户图适配到目标尺寸。
 *
 * ── 两条路 ──────────────────────────────────────────────────────────
 *
 * **像素画源**（`detectPixelBlock` 命中）：
 *     裁切 → 抽逻辑网格 → 补宽高比 → 最近邻放大
 *   全程不插值、不改色，作者的像素网格原样送到终端。
 *
 * **插画源**（原路径）：
 *     裁切 → 补宽高比 → 面积平均重采样 → 像素化 → 色阶量化
 *   顺序不能换：
 *     · 补边而不是裁切 —— 不丢内容、也不变形
 *     · 像素化在缩到目标尺寸**之后** —— 反过来方块会被缩放糊掉
 *     · 量化在**最后** —— 像素化时用的是面积平均，先量化会让平均失真
 *
 * @param crop 共用的裁切框（见 `sharedCropFor`）。不给就各自裁自己的内容边。
 * @returns `{width, height, data, kind}`；`kind` 只用于日志。
 */
async function fitToSlot(pngPath, outW, outH, crop = null) {
  const { decodePng, trimTransparent } = await loadSpriteTools()
  let img = decodePng(readFileSync(pngPath))
  img = crop ? cropTo(img, crop) : trimTransparent(img)

  // ⚠️ 探测必须在**补宽高比之前**。
  //
  // 踩过：先 padToRatio 再 detectPixelBlock，`896×952` 被补成 `896×955`，
  // 而 `955 % 8 = 3` —— 所有候选块边长都不整除，检测直接落空，
  // 于是像素画被当成插画走了一遍「像素化+量化」，作者的 10 色被改掉。
  //
  // 原因：padToRatio 按目标宽高比算出来的尺寸是**任意值**，不保证还是
  // 块边长的整数倍。所以先把源图的网格关系确认下来，再谈补边。
  const block = detectPixelBlock(img)

  if (block > 1) {
    // 像素画：抽逻辑网格 → 补宽高比（在**逻辑**尺度上补，仍是整数格）
    // → 最近邻放大。全程不插值、不改色。
    const logical = toLogicalGrid(img, block)
    return {
      ...resampleNearest(padToRatio(logical, outW, outH), outW, outH),
      kind: `像素画 ${block}×${block} 无损直通`,
    }
  }

  const padded = padToRatio(img, outW, outH)
  return {
    ...quantize(pixelate(resample(padded, outW, outH), PIXELATE), QUANTIZE_STEP, ALPHA_CUTOFF),
    kind: `插画 像素化${PIXELATE}+量化${QUANTIZE_STEP}`,
  }
}

/**
 * 覆写真图缓冲。**尺寸必须保持不变**，所以是把用户图缩放到原缓冲的
 * 尺寸再 `set()` 进去，而不是换掉整个对象。
 *
 * @param happyPath 可选的第二张图（点击时切换的「高兴」版）。
 *   不给就两张都用同一张 —— 代价是**点她没反应**（dsh-TUI 会切到 happy
 *   缓冲，但两张内容一样，肉眼看不出）。想要原版那种"点一下变表情"，
 *   就给 `maidArtHappy` 配第二张图。
 */
async function patchPortraits(root, pngPath, happyPath, log) {
  const modPath = join(root, 'lib', 'types', 'components', 'maidPortrait.js')
  if (!existsSync(modPath)) return 'skip'
  const mod = await import(pathToFileURL(modPath).href)
  if (typeof mod.loadMaidPortraits !== 'function') return 'skip'

  const portraits = await mod.loadMaidPortraits()
  if (!portraits) return 'no-portraits'   // sharp 不可用，或资产缺失

  // 两张图**共用**一个裁切框 —— 否则点击切换时人物会位移（见 sharedCropFor）
  const crop = await sharedCropFor(pngPath, happyPath)

  // happy 优先用第二张图；没配就退回主图
  let n = 0
  const kinds = new Set()
  for (const variant of ['normal', 'happy']) {
    const target = portraits[variant]
    if (!target?.data) continue
    const src = variant === 'happy' && happyPath ? happyPath : pngPath
    // 走缓存 —— 三份 dsh-tui 的缓冲**尺寸完全一样**（都是 412×411），
    // 不缓存的话同一张图要重采样 3 次。实测总耗时 1777ms，缓存后降到 ~600ms。
    const key = `${src}|${target.width}x${target.height}|${JSON.stringify(crop)}`
    let fitted = fitCache.get(key)
    if (!fitted) {
      fitted = await fitToSlot(src, target.width, target.height, crop)
      fitCache.set(key, fitted)
    }
    if (target.data.byteLength !== fitted.data.byteLength) {
      log(`  ${variant}: 字节数不匹配，跳过`)
      continue
    }
    kinds.add(fitted.kind)
    target.data.set(fitted.data)
    n++
  }
  if (n > 0) {
    log(`  · 源图类型：${[...kinds].join(' / ')}`)
    if (crop) log(`  · 共用裁切框 ${crop.w}x${crop.h} @ (${crop.x},${crop.y}) — 两图几何对齐`)
  }
  return n > 0 ? `ok:${n}` : 'no-variant'
}

/**
 * 重采样缓存：`源图路径|目标尺寸` → 已适配的 RGBA。
 *
 * 三份 dsh-tui 实例的画面尺寸一致，所以这个缓存能把
 * 「3 份 × 2 张图 = 6 次重采样」压到 2 次。
 */
const fitCache = new Map()

// ════════════════════════════════════════════════════════════════════
// 字符画路径
// ════════════════════════════════════════════════════════════════════

/** 解析图片 → 30×30 精灵表（兜底路径用）。 */
export async function loadSprite(pngPath) {
  const { decodePng, trimTransparent, padToSquare, downsample, keyOutBackground } =
    await import(pathToFileURL(join(import.meta.dirname, 'sprite-tools.mjs')).href)
  let img = decodePng(readFileSync(pngPath))
  // 不透明底的图自动键控背景，否则裁边时"处处不透明"、裁不出轮廓
  if (!hasTransparency(img)) {
    const { data } = img
    const hex = (n) => n.toString(16).padStart(2, '0')
    img = keyOutBackground(img, `#${hex(data[0])}${hex(data[1])}${hex(data[2])}`)
  }
  const trimmed = trimTransparent(img)
  const side = Math.max(trimmed.width, trimmed.height)
  return downsample(padToSquare(trimmed, side), SPRITE_COLS, SPRITE_ROWS, 128, 'mode')
}

function hasTransparency(img) {
  const { data } = img
  for (let i = 3; i < data.length; i += 4) if (data[i] < 16) return true
  return false
}

/** 就地替换 WHALE_GIRL_ROWS 的内容（不换数组 —— 组件闭包捕获的是绑定）。 */
export function replaceRows(target, rows) {
  if (!Array.isArray(target)) throw new Error('WHALE_GIRL_ROWS 不是数组')
  if (rows.length !== target.length) {
    throw new Error(`行数不匹配：目标 ${target.length} 行，新图 ${rows.length} 行`)
  }
  for (let i = 0; i < rows.length; i++) target[i] = rows[i]
}

async function patchSprites(root, sprite) {
  const wgPath = join(root, 'lib', 'types', 'components', 'WhaleGirl.js')
  const whalePath = join(root, 'lib', 'types', 'components', 'Whale.js')
  if (!existsSync(wgPath) || !existsSync(whalePath)) return 'skip'
  const wg = await import(pathToFileURL(wgPath).href)
  const whale = await import(pathToFileURL(whalePath).href)
  if (typeof whale.renderCellRows !== 'function') return 'no-renderer'
  if (!Array.isArray(wg.WHALE_GIRL_ROWS)) return 'no-rows'
  replaceRows(
    wg.WHALE_GIRL_ROWS,
    whale.renderCellRows(SPRITE_COLS, SPRITE_ROWS, (x, y) => sprite[y]?.[x] ?? undefined),
  )
  return 'ok'
}

// ════════════════════════════════════════════════════════════════════

/**
 * 给每一份找得到的 dsh-tui 都装上自定义立绘（真图 + 字符画两条路都换）。
 *
 * @param pngPath 源图路径
 * @param log 日志函数
 * @param happyPath 可选的「高兴」版（点击时切换）。不给就用主图，
 *   代价是点她看不出变化。仅真图路径吃这个参数；字符画路径本来就是静态的
 *   （dsh-TUI 原版的字符画女仆也不响应点击）。
 * @returns { ok, patched, reason? }
 */
export async function installMaidArt(pngPath, log = () => {}, happyPath = null) {
  if (!existsSync(pngPath)) {
    return { ok: false, patched: [], reason: `图片不存在：${pngPath}` }
  }
  if (happyPath && !existsSync(happyPath)) {
    log(`  「高兴」版图片不存在，忽略：${happyPath}`)
    happyPath = null
  }

  let sprite
  try {
    sprite = await loadSprite(pngPath)
  } catch (err) {
    return { ok: false, patched: [], reason: `解析图片失败：${err?.message ?? err}` }
  }

  const patched = []
  const errors = []

  for (const root of tuiPackageRoots()) {
    const tag = tuiRootTag(root)
    try {
      const raster = await patchPortraits(root, pngPath, happyPath, log)
      const text = await patchSprites(root, sprite)
      const rasterOk = raster.startsWith('ok:')
      const textOk = text === 'ok'
      if (rasterOk || textOk) {
        patched.push(root)
        const opaque = sprite.flat().filter(Boolean).length
        log(`  · ${tag}: 真图 ${raster}` +
          (raster === 'no-portraits' ? '（sharp 不可用 → 走字符画）' : '') +
          ` / 字符画 ${text}` +
          (textOk ? `（不透明格 ${opaque}/${SPRITE_COLS * SPRITE_ROWS}）` : ''))
      } else {
        errors.push(`${tag}: 真图 ${raster} / 字符画 ${text}`)
      }
    } catch (err) {
      errors.push(`${tag}: ${err?.message ?? err}`)
    }
  }

  if (patched.length === 0) {
    return { ok: false, patched, reason: errors.join(' | ') || '找不到任何 dsh-tui 包' }
  }
  log(`自定义立绘已装载：${patched.length} 份 dsh-tui 实例` +
    (happyPath ? '' : '（单图 → 点击无表情变化）'))
  return { ok: true, patched }
}
