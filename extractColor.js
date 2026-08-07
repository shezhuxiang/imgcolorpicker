// extractColor.js
// 主色提取：OKLab 感知色彩空间 + 带权 K-Means++（移植自 iOS 开源 LingdongPhoto / AGPL-3.0）
// 相比原 MMCQ（中位切分）：在感知空间聚类，结果更贴近人眼；并输出整图占比(percent)。
// 保留 edgeWeight（边缘加权，偏向背景）与 pickBackground / pickProminent 两个挑选函数。
//
// 浏览器用法：<script src="extractColor.js"></script> 后通过 window.ColorExtractor 调用。
// Node 用法：const { extractPalette } = require('./extractColor.js')
//
// 对外接口：
//   extractPalette(data, width, height, opts)
//     - data: Uint8ClampedArray（来自 ctx.getImageData）
//     - opts: { maxColors, edgeWeight }
//     - 返回: [{ r, g, b, hex, population, percent, name }]，按占比(population)降序
//   pickBackground(palette)  -> 最适合做柔和背景色
//   pickProminent(palette)   -> 最显眼/最有冲击力的强调色

/* ----------------------------- OKLab 转换 ----------------------------- */

function rgbToOkLab(r, g, b) {
  // r,g,b ∈ [0,1]
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const lr = lin(r)
  const lg = lin(g)
  const lb = lin(b)
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb
  const l3 = Math.cbrt(l)
  const m3 = Math.cbrt(m)
  const s3 = Math.cbrt(s)
  return {
    L: 0.2104542553 * l3 + 0.793617785 * m3 - 0.0040720468 * s3,
    a: 1.9779984951 * l3 - 2.428592205 * m3 + 0.4505937099 * s3,
    b: 0.0259040371 * l3 + 0.7827717662 * m3 - 0.808675766 * s3
  }
}

function okLabDist2(p, q) {
  const dl = p.L - q.L
  const da = p.a - q.a
  const db = p.b - q.b
  return dl * dl + da * da + db * db
}

function seedScore(point, centers) {
  let min = Infinity
  for (const c of centers) min = Math.min(min, okLabDist2(point.lab, c))
  return min * Math.log2(point.weight + 2)
}

/* ----------------------------- 工具函数 ----------------------------- */

function rgbToHex(r, g, b) {
  const h = (n) => {
    const s = Math.max(0, Math.min(255, Math.round(n))).toString(16)
    return s.length === 1 ? '0' + s : s
  }
  return '#' + h(r) + h(g) + h(b)
}

// HSL 辅助（pickBackground / pickProminent 使用），分量 0~1
function rgbToHsl(r, g, b) {
  const rf = r / 255
  const gf = g / 255
  const bf = b / 255
  const max = Math.max(rf, gf, bf)
  const min = Math.min(rf, gf, bf)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rf) h = (gf - bf) / d + (gf < bf ? 6 : 0)
    else if (max === gf) h = (bf - rf) / d + 2
    else h = (rf - gf) / d + 4
    h /= 6
  }
  return { h, s, l }
}

// 文学颜色名（基于 OKLab 的明度/彩度/色相），移植自 LingdongPhoto
function literaryName(r, g, b) {
  const lab = rgbToOkLab(r / 255, g / 255, b / 255)
  const chroma = Math.hypot(lab.a, lab.b)
  let hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI
  hue = ((hue % 360) + 360) % 360

  if (lab.L < 0.23) return chroma < 0.035 ? '玄夜' : '墨黛'
  if (lab.L > 0.94) return chroma < 0.025 ? '月白' : '云絮'
  if (chroma < 0.025) {
    if (lab.L < 0.48) return '远山黛'
    if (lab.L < 0.75) return '烟雨灰'
    return '素绡'
  }
  if (hue < 18 || hue >= 348) return lab.L > 0.72 ? '桃夭' : '胭脂'
  if (hue < 42) return lab.L > 0.76 ? '杏子' : '赭石'
  if (hue < 68) return lab.L > 0.82 ? '缃叶' : '秋香'
  if (hue < 102) return lab.L > 0.8 ? '鹅黄' : '苍黄'
  if (hue < 145) return lab.L > 0.76 ? '柳芽' : '竹青'
  if (hue < 178) return lab.L > 0.72 ? '豆绿' : '松花'
  if (hue < 205) return lab.L > 0.76 ? '水碧' : '青瓷'
  if (hue < 235) return lab.L > 0.75 ? '天水碧' : '黛蓝'
  if (hue < 270) return lab.L > 0.7 ? '晴山' : '群青'
  if (hue < 305) return lab.L > 0.72 ? '雪青' : '紫苑'
  return lab.L > 0.72 ? '藕荷' : '绛紫'
}

/* ----------------------------- 主提取流程 ----------------------------- */

function extractPalette(data, width, height, opts) {
  opts = opts || {}
  const maxColors = opts.maxColors || 8
  const edgeWeight = opts.edgeWeight > 0 ? opts.edgeWeight : 0

  // 1) 量化成"色桶"（去噪 + 加权），同时记录边缘权重
  const buckets = new Map()
  const total = width * height
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    if (data[p + 3] < 125) continue // 跳过透明像素
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    let w = 1
    if (edgeWeight > 0) {
      const x = i % width
      const y = (i / width) | 0
      const ed = Math.min(x, y, width - 1 - x, height - 1 - y)
      if (ed < edgeWeight) w = edgeWeight // 边缘像素加权，偏向背景
    }
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3) // 每通道 5bit
    let bk = buckets.get(key)
    if (!bk) {
      bk = { r: 0, g: 0, b: 0, w: 0 }
      buckets.set(key, bk)
    }
    bk.r += r * w
    bk.g += g * w
    bk.b += b * w
    bk.w += w
  }

  // 2) 每个桶 = 一个采样点（加权）
  const points = []
  buckets.forEach((bk) => {
    const r = bk.r / bk.w
    const g = bk.g / bk.w
    const b = bk.b / bk.w
    points.push({ r, g, b, lab: rgbToOkLab(r / 255, g / 255, b / 255), weight: bk.w })
  })
  if (!points.length) return []

  // 3) K-Means++ 加权播种
  const clusterCount = Math.min(maxColors, points.length)
  const centers = []
  let first = 0
  for (let i = 1; i < points.length; i++) {
    if (points[i].weight > points[first].weight) first = i
  }
  centers.push(points[first].lab)
  while (centers.length < clusterCount) {
    let next = 0
    let nextScore = -Infinity
    for (let i = 0; i < points.length; i++) {
      const s = seedScore(points[i], centers)
      if (s > nextScore) {
        nextScore = s
        next = i
      }
    }
    centers.push(points[next].lab)
  }

  const assign = new Array(points.length).fill(0)
  // 4) 加权 K-Means 迭代（最多 18 次，收敛即停）
  for (let iter = 0; iter < 18; iter++) {
    const lS = new Array(clusterCount).fill(0)
    const aS = lS.slice()
    const bS = lS.slice()
    const ws = lS.slice()
    for (let i = 0; i < points.length; i++) {
      let cl = 0
      let best = Infinity
      for (let k = 0; k < clusterCount; k++) {
        const d = okLabDist2(points[i].lab, centers[k])
        if (d < best) {
          best = d
          cl = k
        }
      }
      assign[i] = cl
      const w = points[i].weight
      lS[cl] += points[i].lab.L * w
      aS[cl] += points[i].lab.a * w
      bS[cl] += points[i].lab.b * w
      ws[cl] += w
    }
    let maxMove = 0
    for (let k = 0; k < clusterCount; k++) {
      if (ws[k] <= 0) continue
      const up = { L: lS[k] / ws[k], a: aS[k] / ws[k], b: bS[k] / ws[k] }
      maxMove = Math.max(maxMove, okLabDist2(centers[k], up))
      centers[k] = up
    }
    if (maxMove < 1e-7) break
  }

  // 5) 最终统计：加权 RGB 均值 + 权重占比
  const ws = new Array(clusterCount).fill(0)
  const rS = ws.slice()
  const gS = ws.slice()
  const bS = ws.slice()
  for (let i = 0; i < points.length; i++) {
    let cl = assign[i]
    let best = Infinity
    for (let k = 0; k < clusterCount; k++) {
      const d = okLabDist2(points[i].lab, centers[k])
      if (d < best) {
        best = d
        cl = k
      }
    }
    assign[i] = cl
    const w = points[i].weight
    ws[cl] += w
    rS[cl] += points[i].r * w
    gS[cl] += points[i].g * w
    bS[cl] += points[i].b * w
  }

  const totalW = Math.max(
    ws.reduce((s, x) => s + x, 0),
    1
  )
  const palette = []
  for (let k = 0; k < clusterCount; k++) {
    if (ws[k] <= 0) continue
    const r = Math.round(rS[k] / ws[k])
    const g = Math.round(gS[k] / ws[k])
    const b = Math.round(bS[k] / ws[k])
    palette.push({
      r,
      g,
      b,
      hex: rgbToHex(r, g, b),
      hsl: rgbToHsl(r, g, b),
      population: Math.round(ws[k]),
      percent: Math.round((ws[k] / totalW) * 1000) / 10,
      name: literaryName(r, g, b)
    })
  }

  // 舍入误差回补到最大簇，保证合计 100%
  if (palette.length) {
    let largest = 0
    for (let i = 1; i < palette.length; i++) {
      if (palette[i].percent > palette[largest].percent) largest = i
    }
    const sum = palette.reduce((s, c) => s + c.percent, 0)
    palette[largest].percent += Math.round((1000 - sum * 10)) / 10
  }

  palette.sort((a, b) => b.population - a.population)
  return palette
}

// 从调色板里挑一个最适合做「背景色」的：
// 偏好中高明度、中等饱和、较高占比；排除接近白/黑/灰的颜色。
function pickBackground(palette) {
  if (!palette || !palette.length) return null
  const maxPop = palette[0].population || 1
  let best = null
  let bestScore = -1
  for (const c of palette) {
    const { r, g, b } = c
    const { s, l } = rgbToHsl(r, g, b)
    if (l > 0.96 || l < 0.06) continue
    if (s < 0.05) continue
    const lightScore = 1 - Math.abs(l - 0.78)
    const satScore = s < 0.45 ? 1 : 1 - (s - 0.45)
    const popScore = Math.log(c.population + 1) / Math.log(maxPop + 1)
    const score = lightScore * satScore * (0.4 + 0.6 * popScore)
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best || palette[0]
}

// 从调色板里挑一个「最显眼 / 最有视觉冲击力」的颜色
function pickProminent(palette) {
  if (!palette || !palette.length) return null
  const bg = palette[0]
  const bgHsl = rgbToHsl(bg.r, bg.g, bg.b)
  const maxPop = bg.population || 1
  let best = null
  let bestScore = -1
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i]
    const { h, s, l } = rgbToHsl(c.r, c.g, c.b)
    if (s < 0.12) continue
    if (l > 0.97 || l < 0.04) continue
    if (c.population / maxPop < 0.03) continue
    const dh = Math.abs(h - bgHsl.h)
    const hueDist = Math.min(dh, 1 - dh)
    const lDist = Math.abs(l - bgHsl.l)
    const contrast = Math.min(1, hueDist * 2 + lDist)
    const popScore = Math.log(c.population + 1) / Math.log(maxPop + 1)
    const score = s * (0.5 + 0.5 * contrast) * (0.3 + 0.7 * popScore)
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best || palette[0]
}

// 双导出：浏览器挂到 window，Node 走 module.exports
const ColorExtractor = {
  extractPalette,
  pickBackground,
  pickProminent,
  rgbToHex,
  literaryName
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ColorExtractor
}
if (typeof window !== 'undefined') {
  window.ColorExtractor = ColorExtractor
}
