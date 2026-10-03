// 图片 → 精灵格的纯函数集合。
//
// 从 ../cc-tui/tools/make-maid-sprite.mjs 抽出来的可复用部分 ——
// 那边是命令行工具（自己读 argv、打印、写文件），这边只留纯函数，
// 好让 cc-bridge 运行时直接调。
//
// 处理链（顺序不能换，每步的理由见各自注释）：
//   键控背景 → 裁透明边 → 补成正方形 → 众数降采样

import zlib from 'node:zlib'

/**
 * 解 PNG 成 RGBA。自己解是为了不依赖 sharp / PIL 这类原生库 ——
 * cc-bridge 跑在 dsh 进程里，多一个原生依赖就多一份装不上的风险。
 *
 * @param buf 文件字节
 * @returns { width, height, data: Buffer(RGBA) }
 */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504E47) throw new Error('不是 PNG')
  let pos = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]
    } else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`只支持 8 位色深，这个文件是 ${bitDepth}`)
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的色彩类型 ${colorType}（调色板图请先转成 RGBA）`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride)); p += stride
    // PNG 的 5 种行过滤器（0=none 1=sub 2=up 3=avg 4=paeth）
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      line[i] = v & 0xFF
    }
    prev = line
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4
      if (channels === 4) { out[d] = line[s]; out[d+1] = line[s+1]; out[d+2] = line[s+2]; out[d+3] = line[s+3] }
      else if (channels === 3) { out[d] = line[s]; out[d+1] = line[s+1]; out[d+2] = line[s+2]; out[d+3] = 255 }
      else if (channels === 1) { out[d] = out[d+1] = out[d+2] = line[s]; out[d+3] = 255 }
      else if (channels === 2) { out[d] = out[d+1] = out[d+2] = line[s]; out[d+3] = line[s+1] }
    }
  }
  return { width, height, data: out }
}

/**
 * 键控背景色 → 透明。
 *
 * **必须放在裁边之前**。踩过的坑：一开始把键控写在降采样里，
 * 于是不透明底的图在裁边时"处处不透明"，裁不出轮廓 ——
 * 实测 600×300 的图裁边后还是 600×300，人物被背景挤扁。
 *
 * @param img decodePng 的结果
 * @param bgKey '#rrggbb'
 * @returns 新的 img（不改调用方的）
 */
export function keyOutBackground(img, bgKey) {
  const m = /^#?([0-9a-f]{6})$/i.exec(bgKey)
  if (!m) throw new Error(`背景色要写成 #rrggbb，收到 ${bgKey}`)
  const n = parseInt(m[1], 16)
  const br = (n >> 16) & 255, bg = (n >> 8) & 255, bb = n & 255
  const { width, height, data } = img
  const out = Buffer.from(data)
  let keyed = 0
  for (let i = 0; i < width * height; i++) {
    const p = i * 4
    const dr = out[p] - br, dg = out[p + 1] - bg, db = out[p + 2] - bb
    // 容差 30² —— 太小键不掉抗锯齿边缘，太大误伤同色主体
    if (dr * dr + dg * dg + db * db < 900) { out[p + 3] = 0; keyed++ }
  }
  return { width, height, data: out, keyed }
}

/**
 * 裁掉全透明的边。
 *
 * 这一步不能省：素材周围常有透明边距，不裁的话边距会占掉精灵格，
 * 人物被压缩、还可能偏心。实测官方 464×464 真图不裁就比原版精灵
 * 小一圈、还偏右。
 */
export function trimTransparent(img, threshold = 16) {
  const { width, height, data } = img
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return img
  const w = maxX - minX + 1, h = maxY - minY + 1
  if (w === width && h === height) return img
  const out = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    data.copy(out, y * w * 4, ((y + minY) * width + minX) * 4, ((y + minY) * width + minX + w) * 4)
  }
  return { width: w, height: h, data: out }
}

/**
 * 居中补成正方形。
 *
 * 30×30 是 dsh-TUI 的硬约束。源图非正方形时必须补齐，否则降采样会
 * 拉伸变形 —— 脸变宽、身子变扁。补透明边比裁剪安全（不丢内容）。
 */
export function padToSquare(img, side) {
  if (img.width === side && img.height === side) return img
  const out = Buffer.alloc(side * side * 4)
  const ox = Math.floor((side - img.width) / 2)
  const oy = Math.floor((side - img.height) / 2)
  for (let y = 0; y < img.height; y++) {
    img.data.copy(out, ((y + oy) * side + ox) * 4, y * img.width * 4, (y + 1) * img.width * 4)
  }
  return { width: side, height: side, data: out }
}

/**
 * 降采样成精灵格。
 *
 * 两种算法差别很大：
 *   mode（众数，默认）—— 每格取出现最多的颜色。像素画的正确做法，
 *     保住锐利边缘和纯色块。dsh-TUI 作者生成原版用的就是这个。
 *   average（面积平均）—— 按 alpha 加权平均。适合照片/渐变，
 *     但会**把像素画糊掉**：实测拿官方真图跑，眼睛和围裙细节全丢、
 *     整张发灰。
 *
 * @returns 行 × 列 的 [r,g,b] | null
 */
export function downsample(img, cols, rows, threshold = 128, method = 'mode') {
  const { width, height, data } = img
  const sprite = []
  for (let gy = 0; gy < rows; gy++) {
    const line = []
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor(gx * width / cols), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * width / cols))
      const y0 = Math.floor(gy * height / rows), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * height / rows))

      // 众数用的直方图。量化到 5 位/通道再计数 ——
      // 原图是抗锯齿的，不量化的话每种颜色都只出现一两次，
      // "众数"就退化成"随机取一个"。
      const hist = new Map()
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0, n = 0

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4
          const a = data[i + 3]
          if (a < 40) { aSum += a; n++; continue }   // 边缘羽化不参与
          const r = data[i], g = data[i+1], b = data[i+2]
          rSum += r; gSum += g; bSum += b; aSum += a; n++
          const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
          const e = hist.get(key)
          if (e) { e.n++; e.r += r; e.g += g; e.b += b }
          else hist.set(key, { n: 1, r, g, b })
        }
      }

      if (n === 0 || aSum / n < threshold) { line.push(null); continue }

      if (method === 'average' || hist.size === 0) {
        const wsum = aSum / 255 || 1
        line.push([Math.round(rSum / wsum), Math.round(gSum / wsum), Math.round(bSum / wsum)])
      } else {
        let best = null
        for (const e of hist.values()) if (!best || e.n > best.n) best = e
        line.push([Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)])
      }
    }
    sprite.push(line)
  }
  return sprite
}
