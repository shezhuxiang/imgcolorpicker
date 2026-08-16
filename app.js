// app.js —— 图片取色（零构建，纯前端）
// 布局（参考 IroHana）：左列=上传卡片+预览卡片，右列=色板列表
// 功能：
//   A. 上传图片 → 提取主色调 → 色板列表（色块+hex+占比条，点击复制）
//   B. 在图上移动出放大镜、点击任意像素采样
// 不含保存/下载。取色核心见 extractColor.js（OKLab + 加权 K-Means++）。

(function () {
  const { extractPalette, rgbToHex } = window.ColorExtractor

  const fileInput = document.getElementById('fileInput')
  const dropzone = document.getElementById('dropzone')
  const stage = document.getElementById('stage')
  const previewImg = document.getElementById('previewImg')
  const emptyHint = document.getElementById('emptyHint')
  const lens = document.getElementById('lens')
  const lensHex = document.getElementById('lensHex')
  const stageHintText = document.getElementById('stageHintText')

  const swatches = document.getElementById('swatches')
  const paletteEmpty = document.getElementById('paletteEmpty')
  const paletteCount = document.getElementById('paletteCount')

  const toast = document.getElementById('toast')

  const sampledCard = document.getElementById('sampledCard')
  const sampledList = document.getElementById('sampledList')
  const sampledEmpty = document.getElementById('sampledEmpty')
  const sampledCount = document.getElementById('sampledCount')
  const sampledClear = document.getElementById('sampledClear')

  const state = {
    imgDataUrl: null,
    sampleCanvas: null, sampleCtx: null, sampleW: 0, sampleH: 0,
    palette: [],
    sampled: []
  }
  let currentObjectURL = null

  // GA4 事件上报（Measurement ID 未配置时静默跳过，不报错）
  function track(name, params) {
    if (typeof gtag === 'function') {
      try { gtag('event', name, params || {}) } catch (e) {}
    }
  }

  // 单次访问（session）内累计上传数，用于统计「一次访问上传多少张图」
  // 用 sessionStorage：同标签页、刷新不丢，关页/新标签重置 —— 近似等于一次「访问」
  function bumpSessionUploads() {
    let n = parseInt(sessionStorage.getItem('img2color_uploads') || '0', 10)
    n += 1
    sessionStorage.setItem('img2color_uploads', String(n))
    return n
  }

  /* ---------------- 默认演示图 ----------------
   * 站点打开时自动加载一张示例图并提取配色，让访客立刻看懂「工具能做什么」。
   * 显示规则（二选一，通过常量切换）：
   *   DEMO_EVERY_LOAD = true  → 每次打开网站都显示演示图（最适合「打开即懂」的营销站）
   *   DEMO_EVERY_LOAD = false → 仅首次访问显示；用过工具后写 localStorage，
   *                             之后不再自动显示（缓存机制，不骚扰老用户）
   * 演示图不算「上传」，不会触发 upload_image 事件 / 不计入 session_uploads。
   */
  const DEMO_EVERY_LOAD = true
  const DEMO_IMG = 'demo.jpg'
  const LS_USED = 'icp_used'

  function markDemoActive(on) {
    const tag = document.getElementById('sampleTag')
    if (tag) tag.hidden = !on
  }

  function showDemoFromUrl(url) {
    const img = new Image()
    img.onload = () => {
      state.imgDataUrl = url
      processImage(img)
      markDemoActive(true)
    }
    img.onerror = () => { /* 演示图缺失则保持空态 */ }
    img.src = url
  }

  function loadDemoImage() {
    // 优先 fetch + blob（http/https 同源，canvas 不被污染，getImageData 正常）
    fetch(DEMO_IMG)
      .then(r => { if (!r.ok) throw new Error('demo not found'); return r.blob() })
      .then(blob => { showDemoFromUrl(URL.createObjectURL(blob)) })
      .catch(() => {
        // file:// 等非 http 环境 fetch 受限 → 退化用 new Image
        // 注意：file:// 下 canvas 会被跨域污染，getImageData 仍可能被浏览器拦截（Palette 可能为空）
        console.warn('[demo] fetch 失败，已退化直接加载图片（file:// 环境下可能无法提取颜色，请用本地 HTTP 服务器测试）')
        showDemoFromUrl(DEMO_IMG)
      })
  }

  function maybeLoadDemo() {
    if (!DEMO_EVERY_LOAD && localStorage.getItem(LS_USED)) return
    loadDemoImage()
  }

  /* ---------------- 上传 ---------------- */
  function openPicker() { fileInput.click() }
  dropzone.addEventListener('click', openPicker)
  dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openPicker() })
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0]
    if (f) handleFile(f)
  })
  ;['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('dragover') })
  )
  ;['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('dragover') })
  )
  dropzone.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0]
    if (f) handleFile(f)
  })
  stage.addEventListener('dragover', (e) => e.preventDefault())
  stage.addEventListener('drop', (e) => {
    e.preventDefault()
    const f = e.dataTransfer.files && e.dataTransfer.files[0]
    if (f) handleFile(f)
  })

  function enterWorkMode() {
    dropzone.hidden = true
    emptyHint.hidden = true
    previewImg.hidden = false
    stageHintText.hidden = false
    paletteEmpty.hidden = true
    paletteCount.hidden = false
  }

  function resetToIdle() {
    dropzone.hidden = false
    emptyHint.hidden = false
    previewImg.hidden = true
    previewImg.src = ''
    lens.hidden = true
    stageHintText.hidden = true
    sampledCard.hidden = true
    paletteEmpty.hidden = false
    paletteCount.hidden = true
    swatches.innerHTML = ''
    swatches.appendChild(paletteEmpty)
    sampledList.innerHTML = ''
    state.imgDataUrl = null
    state.sampleCanvas = null; state.sampleCtx = null
    state.palette = []; state.sampled = []
    if (currentObjectURL) { URL.revokeObjectURL(currentObjectURL); currentObjectURL = null }
  }

  function handleFile(file) {
    if (!file.type || !file.type.startsWith('image/')) { alert('Please select an image file'); return }
    if (currentObjectURL) { URL.revokeObjectURL(currentObjectURL); currentObjectURL = null }
    const url = URL.createObjectURL(file)
    currentObjectURL = url
    const img = new Image()
    img.onload = () => {
      state.imgDataUrl = url
      processImage(img)
      const uploads = bumpSessionUploads()
      track('upload_image', { file_type: file.type || 'unknown', colors: state.palette.length, session_uploads: uploads })
      // 用户已使用自己的图片 → 标记「已用过」，缓存机制下不再自动显示演示图
      try { localStorage.setItem(LS_USED, '1') } catch (e) {}
      markDemoActive(false)
    }
    img.onerror = () => alert('Failed to load image')
    img.src = url
  }

  /* ---------------- 处理已加载的 Image（上传 / 演示图共用） ---------------- */
  function processImage(img) {
    // 采样画布：放大镜用
    const sMax = 1000
    const sScale = Math.min(1, sMax / Math.max(img.naturalWidth, img.naturalHeight))
    const sw = Math.max(1, Math.round(img.naturalWidth * sScale))
    const sh = Math.max(1, Math.round(img.naturalHeight * sScale))
    const sc = document.createElement('canvas')
    sc.width = sw; sc.height = sh
    const sctx = sc.getContext('2d')
    sctx.drawImage(img, 0, 0, sw, sh)
    state.sampleCanvas = sc; state.sampleCtx = sctx; state.sampleW = sw; state.sampleH = sh

    previewImg.src = state.imgDataUrl
    enterWorkMode()

    // 提取主色
    const eMax = 240
    const eScale = Math.min(1, eMax / Math.max(img.naturalWidth, img.naturalHeight))
    const ew = Math.max(1, Math.round(img.naturalWidth * eScale))
    const eh = Math.max(1, Math.round(img.naturalHeight * eScale))
    const off = document.createElement('canvas')
    off.width = ew; off.height = eh
    const octx = off.getContext('2d')
    octx.drawImage(img, 0, 0, ew, eh)
    let data
    try { data = octx.getImageData(0, 0, ew, eh).data } catch (err) { console.error(err); return }
    const palette = extractPalette(data, ew, eh, { maxColors: 8, edgeWeight: 8 })
    state.palette = palette
    renderResults(palette)
  }

  /* ---------------- 渲染结果（A）：右列色板列表 ---------------- */
  function fmtRgb(r, g, b) { return `rgb(${r}, ${g}, ${b})` }
  function fmtHsl(hsl) {
    const h = Math.round((hsl.h || 0) * 360)
    const s = Math.round((hsl.s || 0) * 100)
    const l = Math.round((hsl.l || 0) * 100)
    return `hsl(${h}, ${s}%, ${l}%)`
  }
  // 生成 RGB / HSL 可点击复制的子行
  function buildChannels(r, g, b, hsl) {
    const rgb = fmtRgb(r, g, b)
    const hslStr = hsl ? fmtHsl(hsl) : fmtHsl(rgbToHsl(r, g, b))
    return `<span class="cr-chan" data-copy="${rgb}">RGB ${rgb}</span>` +
           `<span class="cr-sep">·</span>` +
           `<span class="cr-chan" data-copy="${hslStr}">HSL ${hslStr}</span>`
  }
  // 组装一行颜色；pct 为 null 时（采样）不显示占比与占比条
  function buildColorRow({ hex, r, g, b, hsl, pct, isMain }) {
    const row = document.createElement('div')
    row.className = 'color-row' + (isMain ? ' is-main' : '')
    row.title = hex + ' (click to copy)'
    const barW = pct != null ? Math.max(8, Math.round((pct / state._maxPct) * 100)) : 0
    row.innerHTML =
      `<i class="cr-chip" style="background:${hex}"></i>` +
      `<div class="cr-info">` +
        `<div class="cr-line">` +
          `<span class="cr-hex">${hex}</span>` +
          (isMain ? `<span class="cr-tag">Main</span>` : '') +
          (pct != null ? `<span class="cr-pct">${pct}%</span>` : '') +
        `</div>` +
        `<div class="cr-sub">${buildChannels(r, g, b, hsl)}</div>` +
      `</div>` +
      (pct != null
        ? `<div class="cr-bar"><div class="cr-bar-fill" style="width:${barW}%;background:${hex}"></div></div>`
        : '')
    row.addEventListener('click', (e) => {
      // 点具体通道复制该通道，否则复制 hex
      const chan = e.target.closest('.cr-chan')
      if (chan) copyHex(chan.dataset.copy)
      else copyHex(hex)
    })
    return row
  }

  function renderResults(palette) {
    // 清空但保留空态节点引用
    swatches.innerHTML = ''
    if (!palette.length) {
      swatches.appendChild(paletteEmpty)
      paletteEmpty.hidden = false
      paletteCount.hidden = true
      return
    }
    paletteCount.textContent = palette.length
    paletteCount.hidden = false
    state._maxPct = Math.max(...palette.map(c => c.percent || 0), 1)

    palette.forEach((c, i) => {
      const row = buildColorRow({
        hex: c.hex, r: c.r, g: c.g, b: c.b, hsl: c.hsl,
        pct: Math.round(c.percent || 0), isMain: i === 0
      })
      swatches.appendChild(row)
    })
  }

  /* ---------------- 放大镜取色（B） ---------------- */
  const LENS = 120
  const ZOOM = 2.6

  function pixelAt(rect, clientX, clientY) {
    let x = clientX - rect.left
    let y = clientY - rect.top
    x = Math.max(0, Math.min(rect.width, x))
    y = Math.max(0, Math.min(rect.height, y))
    const px = Math.floor(x * (state.sampleW / rect.width))
    const py = Math.floor(y * (state.sampleH / rect.height))
    const d = state.sampleCtx.getImageData(px, py, 1, 1).data
    return { x, y, r: d[0], g: d[1], b: d[2] }
  }

  stage.addEventListener('mousemove', (e) => {
    if (!state.sampleCtx) return
    const rect = previewImg.getBoundingClientRect()
    if (!rect.width) return
    let p
    try { p = pixelAt(rect, e.clientX, e.clientY) } catch (err) { return }
    const hex = rgbToHex(p.r, p.g, p.b)

    const sRect = stage.getBoundingClientRect()
    const offX = rect.left - sRect.left
    const offY = rect.top - sRect.top

    lens.hidden = false
    lens.style.left = (offX + p.x - LENS / 2) + 'px'
    lens.style.top = (offY + p.y - LENS / 2) + 'px'
    lens.style.backgroundImage = `url("${state.imgDataUrl}")`
    lens.style.backgroundSize = `${rect.width * ZOOM}px ${rect.height * ZOOM}px`
    lens.style.backgroundPosition = `${-(p.x * ZOOM - LENS / 2)}px ${-(p.y * ZOOM - LENS / 2)}px`
    lensHex.textContent = hex
    stage.style.cursor = 'crosshair'
    stageHintText.hidden = true
  })

  stage.addEventListener('mouseleave', () => {
    lens.hidden = true
    stage.style.cursor = ''
    if (!state.sampled.length) stageHintText.hidden = false
  })

  stage.addEventListener('click', (e) => {
    if (!state.sampleCtx) return
    const rect = previewImg.getBoundingClientRect()
    let p
    try { p = pixelAt(rect, e.clientX, e.clientY) } catch (err) { return }
    const hex = rgbToHex(p.r, p.g, p.b)
    addSample(hex, p)
    track('pick_color', { color: hex })
    copyHex(hex)
  })

  function addSample(hex, rgb) {
    const exists = state.sampled.some((s) => s.hex.toLowerCase() === hex.toLowerCase())
    if (!exists) {
      state.sampled.unshift({ hex, r: rgb.r, g: rgb.g, b: rgb.b })
      if (state.sampled.length > 12) state.sampled.pop()
      renderSampled()
    }
  }

  function renderSampled() {
    sampledList.innerHTML = ''
    if (!state.sampled.length) {
      sampledCard.hidden = true
      return
    }
    sampledCard.hidden = false
    sampledEmpty.hidden = true
    sampledCount.hidden = false
    sampledCount.textContent = state.sampled.length
    sampledClear.hidden = false

    state.sampled.forEach((s) => {
      const row = buildColorRow({
        hex: s.hex, r: s.r, g: s.g, b: s.b, hsl: null, pct: null, isMain: false
      })
      sampledList.appendChild(row)
    })
  }

  sampledClear.addEventListener('click', () => {
    state.sampled = []
    renderSampled()
    stageHintText.hidden = false
  })

  /* ---------------- 工具 ---------------- */
  function hexToRgb(hex) {
    const h = hex.replace('#', '')
    return {
      r: parseInt(h.substr(0, 2), 16),
      g: parseInt(h.substr(2, 2), 16),
      b: parseInt(h.substr(4, 2), 16)
    }
  }
  function textOn(hex) {
    const { r, g, b } = hexToRgb(hex)
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return L > 140 ? '#3B322C' : '#FFFFFF'
  }

  let toastTimer = null
  function showToast(msg) {
    toast.textContent = msg
    toast.hidden = false
    // 强制重排以触发过渡
    void toast.offsetWidth
    toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toast.classList.remove('show')
      setTimeout(() => { toast.hidden = true }, 200)
    }, 1500)
  }

  function copyHex(hex) {
    let fmt = 'hex'
    if (hex.startsWith('rgb(')) fmt = 'rgb'
    else if (hex.startsWith('hsl(')) fmt = 'hsl'
    track('copy_color', { format: fmt, color: hex })
    const done = () => showToast('Copied ' + hex)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(hex).then(done).catch(done)
    } else {
      const ta = document.createElement('textarea')
      ta.value = hex
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch (e) {}
      ta.remove()
      done()
    }
  }

  /* ---------------- 顶部导航：平滑滚动 + 滚动高亮 (scrollspy) ---------------- */
  const navLinks = Array.from(document.querySelectorAll('#navLinks a'))
  const navMap = {}
  navLinks.forEach(a => { navMap[a.getAttribute('href').slice(1)] = a })

  const NAV_OFFSET = 72 // 补偿 sticky 导航条高度

  // 点击菜单 → 平滑滚动到对应区块
  navLinks.forEach(a => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href').slice(1)
      const target = document.getElementById(id)
      if (!target) return
      e.preventDefault()
      const top = target.getBoundingClientRect().top + window.scrollY - NAV_OFFSET
      window.scrollTo({ top, behavior: 'smooth' })
      track('nav_click', { section: id })
    })
  })

  // 滚动时高亮当前可视区块对应的菜单项
  const spySections = Object.keys(navMap)
    .map(id => document.getElementById(id))
    .filter(Boolean)
  if ('IntersectionObserver' in window && spySections.length) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          navLinks.forEach(l => l.classList.remove('active'))
          const link = navMap[entry.target.id]
          if (link) link.classList.add('active')
        }
      })
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 })
    spySections.forEach(sec => observer.observe(sec))
  }

  // 首屏：按规则自动加载演示图（让访客打开即懂工具能做什么）
  maybeLoadDemo()
})()
