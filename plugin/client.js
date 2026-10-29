/* wallpaper-rotator-v2 — DSH 客户端插件
 * 由 client module loader 加载（桌面端与 dsh web 都用同一份）。
 *
 * 视觉策略（对齐参考效果）：
 *   1. 壁纸层铺满整个窗口（固定定位、cover、不缩放不转码）
 *   2. 壁纸层上方叠一层可调压暗层（保证文字可读）
 *   3. 把应用里所有「大块不透明容器」的背景放行，让壁纸透到侧栏/标题栏/输入框
 *   4. 右下角 26px 圆钮控制一切
 */
window.__ModuleLoader__.load({
  id: 'wallpaper-rotator-v2',
  factory: () => {
    var module = { exports: {} }
    var exports = module.exports

    var API = '/wp'

    function apply(ctx) {
      if (window.__wpv2) return
      window.__wpv2 = true

      var st = { total: 0, index: 0, intervalSec: 180, scrim: 0.28, paused: false }
      var nextAt = 0
      var front = 0
      var busy = false
      var mounted = false
      var slots = []
      var theme = 'dark'
      var timers = []
      var neutral = { count: 0, names: [] }

      var el = function (tag, css, html) {
        var n = document.createElement(tag)
        if (css) n.style.cssText = css
        if (html != null) n.innerHTML = html
        return n
      }

      /* ---------------- 背景层 ---------------- */
      var stage = el('div', [
        'position:fixed', 'inset:0', 'z-index:0', 'pointer-events:none',
        'background:#0a0c10', 'overflow:hidden', 'opacity:0',
        'transition:opacity .6s ease',
      ].join(';'))
      stage.id = 'wpv2-stage'
      stage.setAttribute('aria-hidden', 'true')

      for (var i = 0; i < 2; i++) {
        var layer = el('div', [
          'position:absolute', 'inset:0', 'background-size:cover',
          'background-position:center center', 'background-repeat:no-repeat',
          'opacity:' + (i === 0 ? 1 : 0), 'transition:opacity .55s ease',
          'will-change:opacity', 'transform:translateZ(0)',
        ].join(';'))
        slots.push(layer)
        stage.appendChild(layer)
      }

      // 压暗层：壁纸之上、界面之下
      var scrim = el('div', 'position:absolute;inset:0;background:rgba(8,10,14,0.28);transition:background-color .25s ease;')
      stage.appendChild(scrim)

      function detectTheme() {
        try {
          var frame = document.querySelector('[class*="frame"]')
          if (frame) {
            var c = getComputedStyle(frame).backgroundColor || ''
            var m = c.match(/rgba?\(([^)]+)\)/)
            if (m) {
              var p = m[1].split(',').map(Number)
              var lum = (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255
              theme = lum > 0.5 ? 'light' : 'dark'
              return
            }
          }
        } catch (e) { /* 忽略 */ }
        try {
          theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
        } catch (e) { theme = 'dark' }
      }

      function baseRgb() {
        return theme === 'light' ? [248, 249, 251] : [8, 10, 14]
      }

      function paintTokens() {
        if (!document.body) return
        var rgb = baseRgb()
        var a = st.scrim
        var tint = function (extra) {
          return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' +
            Math.min(0.98, Math.max(0, a + extra)).toFixed(3) + ')'
        }
        var vars = {
          '--dsw-alias-bg-base': tint(0),
          '--dsw-alias-bg-layer-1': tint(0.05),
          '--dsw-alias-bg-layer-2': tint(0.12),
          '--dsw-alias-bg-layer-3': tint(0.20),
          '--dsw-alias-bg-layer-4': tint(0.28),
          '--dsw-alias-bg-mask-1': theme === 'light' ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)',
          '--dsw-alias-bg-module-platform': tint(0.08),
          // 这两个变量同时决定：app 自绘的 40px 标题栏伪元素 + 原生 titleBarOverlay 颜色
          '--dsw-specific-sidebar-fill': 'rgba(0,0,0,0)',
          '--dsh-windows-titlebar-height': '40px',
        }
        var applyTo = function (node) {
          Object.keys(vars).forEach(function (k) { node.style.setProperty(k, vars[k], 'important') })
        }
        applyTo(document.documentElement)
        applyTo(document.body)
        document.documentElement.style.setProperty('background-color', 'transparent', 'important')
        document.body.style.setProperty('background-color', 'transparent', 'important')
        scrim.style.background = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a.toFixed(3) + ')'
      }

      /* 把大块不透明容器放行：这是「铺满所有、不只工作区」的关键 */
      var DIALOG_SEL = '[role="dialog"],[aria-modal="true"],[class*="modal"],[class*="Modal"],[class*="popover"],[class*="Popover"],[class*="dropdown"],[class*="Dropdown"],[class*="menu"],[class*="Menu"],[class*="toast"],[class*="Toast"]'

      function neutralize(force) {
        if (!document.body) return
        var vw = window.innerWidth || 1
        var vh = window.innerHeight || 1
        var area = vw * vh
        var nodes = document.querySelectorAll('div,aside,nav,section,main,header,footer,menu,[class*="titlebar"],[class*="TitleBar"],[class*="tabBar"],[class*="menuBar"],[class*="statusBar"]')
        var count = 0
        var names = []
        for (var i = 0; i < nodes.length; i++) {
          var node = nodes[i]
          if (node.id === 'wpv2-stage' || (node.closest && node.closest('#wpv2-stage'))) continue
          if (node.closest && node.closest(DIALOG_SEL)) continue
          var r = node.getBoundingClientRect()
          var bigBlock = r.width * r.height >= area * 0.06
          // 顶部/底部的「全宽矮条」（标题栏、菜单栏、状态栏）面积占比很小，单独判据
          var wideBar = r.width >= vw * 0.45 && r.height >= 14 && r.height <= 200
          if (!bigBlock && !wideBar) continue
          var cs = getComputedStyle(node)
          var bg = cs.backgroundColor
          if (!bg || bg === 'transparent') continue
          var m = bg.match(/rgba?\(([^)]+)\)/)
          if (!m) continue
          var parts = m[1].split(',').map(Number)
          var alpha = parts.length > 3 ? parts[3] : 1
          if (alpha < 0.85) continue
          if (!force && node.getAttribute('data-wpv2') === '1') continue
          node.style.setProperty('background-color', 'transparent', 'important')
          node.setAttribute('data-wpv2', '1')
          count++
          if (names.length < 8) {
            var cls = (node.className || '').toString().slice(0, 42)
            names.push({ c: cls || node.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), bg: bg })
          }
        }
        // 顶部/底部全宽条：不看透明度，一律清掉底色/背景图/毛玻璃/投影
        var all = document.body.querySelectorAll('*')
        for (var j = 0; j < all.length; j++) {
          var e = all[j]
          if (e.id === 'wpv2-stage' || (e.closest && e.closest('#wpv2-stage'))) continue
          var er = e.getBoundingClientRect()
          if (!er.width || !er.height) continue
          var nearTop = er.top <= 8 && er.height <= 200
          var nearBottom = er.bottom >= vh - 8 && er.height <= 200
          if (!(nearTop || nearBottom)) continue
          if (er.width < vw * 0.8) continue
          if (e.closest && e.closest('#wpv2-fab, #wpv2-panel')) continue
          e.style.setProperty('background-color', 'transparent', 'important')
          e.style.setProperty('background-image', 'none', 'important')
          e.style.setProperty('backdrop-filter', 'none', 'important')
          e.style.setProperty('-webkit-backdrop-filter', 'none', 'important')
          e.style.setProperty('box-shadow', 'none', 'important')
          e.setAttribute('data-wpv2-strip', '1')
          count++
          if (names.length < 8) {
            names.push({ c: 'STRIP:' + ((e.className || '').toString().slice(0, 34) || e.tagName.toLowerCase()), w: Math.round(er.width), h: Math.round(er.height), bg: getComputedStyle(e).backgroundColor })
          }
        }
        if (count || force) neutral = { count: count, names: names }
      }

      /* ---------------- 控件 ---------------- */
      var fab, panel, counter, ivRange, scRange, pauseBtn, metaLine, sharpBtn
      st.currentId = ''

      function mkBtn(label, handler) {
        var b = el('button', [
          'flex:1', 'height:26px', 'border-radius:7px', 'cursor:pointer',
          'background:rgba(255,255,255,.07)', 'border:1px solid rgba(255,255,255,.12)',
          'color:#dfe9e7', 'font-size:12px', 'padding:0',
        ].join(';'), label)
        b.type = 'button'
        b.onclick = function (ev) { ev.stopPropagation(); handler() }
        b.onmouseenter = function () { b.style.background = 'rgba(255,255,255,.13)' }
        b.onmouseleave = function () { b.style.background = 'rgba(255,255,255,.07)' }
        return b
      }

      function buildControl() {
        fab = el('button', [
          'position:fixed', 'right:14px', 'bottom:14px', 'width:26px', 'height:26px',
          'border-radius:50%', 'display:flex', 'align-items:center', 'justify-content:center',
          'background:rgba(18,21,28,.52)', 'border:1px solid rgba(255,255,255,.16)',
          'color:#cfe8e3', 'cursor:pointer', 'z-index:2147483000',
          'backdrop-filter:blur(10px)', '-webkit-backdrop-filter:blur(10px)',
          'opacity:.62', 'transition:opacity .18s ease,transform .18s ease',
          'box-shadow:0 2px 10px rgba(0,0,0,.28)', 'padding:0',
        ].join(';'),
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
          '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16l-4.5-4.5L7 21"/></svg>')
        fab.title = '壁纸轮换'
        fab.type = 'button'
        fab.onmouseenter = function () { fab.style.opacity = '1'; fab.style.transform = 'scale(1.08)' }
        fab.onmouseleave = function () { fab.style.opacity = '.62'; fab.style.transform = 'scale(1)' }

        panel = el('div', [
          'position:fixed', 'right:14px', 'bottom:50px', 'width:236px',
          'background:rgba(14,17,23,.92)', 'border:1px solid rgba(255,255,255,.14)',
          'border-radius:12px', 'padding:11px 12px 10px', 'z-index:2147483000',
          'backdrop-filter:blur(16px)', '-webkit-backdrop-filter:blur(16px)',
          'box-shadow:0 12px 32px rgba(0,0,0,.45)', 'color:#dfe9e7',
          'font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
          'display:none', 'user-select:none',
        ].join(';'))

        var head = el('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;')
        head.appendChild(el('span', 'font-weight:600;letter-spacing:.02em;', '壁纸轮换'))
        counter = el('span', 'color:#7f9a9a;font-variant-numeric:tabular-nums;', '– / –')
        head.appendChild(counter)
        panel.appendChild(head)

        metaLine = el('div', 'display:flex;justify-content:space-between;color:#8fa8a6;margin:-2px 0 8px;font-variant-numeric:tabular-nums;', '–')
        panel.appendChild(metaLine)

        var row = el('div', 'display:flex;gap:6px;margin-bottom:9px;')
        row.appendChild(mkBtn('上一张', function () { advance(-1) }))
        row.appendChild(mkBtn('下一张', function () { advance(1) }))
        pauseBtn = mkBtn('暂停', function () { togglePause() })
        row.appendChild(pauseBtn)
        panel.appendChild(row)

        var mkSlider = function (label, min, max, step, value, fmt, onChange) {
          var wrap = el('div', 'margin-bottom:8px;')
          var top = el('div', 'display:flex;justify-content:space-between;color:#9db3b1;margin-bottom:2px;')
          top.appendChild(el('span', '', label))
          var val = el('span', 'color:#cfe8e3;font-variant-numeric:tabular-nums;', fmt(value))
          top.appendChild(val)
          wrap.appendChild(top)
          var input = el('input', 'width:100%;accent-color:#3fe0c8;height:14px;cursor:pointer;')
          input.type = 'range'
          input.min = min; input.max = max; input.step = step; input.value = value
          input.oninput = function () {
            var v = Number(input.value)
            val.textContent = fmt(v)
            onChange(v)
          }
          wrap.appendChild(input)
          panel.appendChild(wrap)
          return { input: input, label: val, fmt: fmt }
        }

        ivRange = mkSlider('轮换间隔', 30, 600, 30, 180, function (v) {
          return v >= 60 ? Math.round(v / 60) + ' 分钟' : v + ' 秒'
        }, function (v) {
          st.intervalSec = v
          nextAt = Date.now() + v * 1000
          post('/config?interval=' + v)
        })

        scRange = mkSlider('压暗程度', 0, 85, 1, 28, function (v) { return Math.round(v) + '%' },
          function (v) {
            st.scrim = v / 100
            paintTokens()
            neutralize(true)
            post('/config?scrim=' + (v / 100).toFixed(2))
          })

        var row2 = el('div', 'display:flex;gap:6px;margin-bottom:6px;')
        row2.appendChild(mkBtn('剔除当前', function () {
          if (!st.currentId) return
          post('/config?exclude=' + encodeURIComponent(st.currentId)).then(function () { advance(1) })
        }))
        row2.appendChild(mkBtn('恢复全部', function () {
          post('/config?restore=all').then(function (d) { syncState(d); advance(1) })
        }))
        panel.appendChild(row2)

        var foot = el('div', 'display:flex;gap:6px;margin-top:2px;')
        sharpBtn = mkBtn('仅高清：开', function () {
          st.sharpOnly = !(st.sharpOnly !== false)
          sharpBtn.textContent = '仅高清：' + (st.sharpOnly ? '开' : '关')
          post('/config?sharp=' + (st.sharpOnly ? '1' : '0')).then(function (d) {
            syncState(d)
            advance(1)
          })
        })
        foot.appendChild(sharpBtn)
        foot.appendChild(mkBtn('重排', function () {
          post('/config?reshuffle=1').then(function () { advance(1) })
        }))
        foot.appendChild(mkBtn('关闭', function () { panel.style.display = 'none' }))
        panel.appendChild(foot)

        fab.onclick = function (ev) {
          ev.stopPropagation()
          panel.style.display = panel.style.display === 'none' ? 'block' : 'none'
        }
        panel.onclick = function (ev) { ev.stopPropagation() }
        document.addEventListener('click', function () { if (panel) panel.style.display = 'none' })

        var stripStyle = document.createElement('style')
        stripStyle.id = 'wpv2-strip-style'
        stripStyle.textContent = '[data-wpv2-strip="1"]::before,[data-wpv2-strip="1"]::after{background:transparent!important;background-image:none!important;box-shadow:none!important;border-color:transparent!important}'
        if (!document.getElementById('wpv2-strip-style')) document.head.appendChild(stripStyle)

        var tbStyle = document.createElement('style')
        tbStyle.id = 'wpv2-titlebar-style'
        tbStyle.textContent = [
          'html{--dsw-specific-sidebar-fill:rgba(0,0,0,0)!important}',
          '[data-windows-titlebar] [class*="frame"]::before{background:transparent!important;background-color:transparent!important}',
          '[data-windows-titlebar] [class*="sidebarCol"]{background:transparent!important}',
        ].join('\n')
        if (!document.getElementById('wpv2-titlebar-style')) document.head.appendChild(tbStyle)
        document.body.appendChild(fab)
        document.body.appendChild(panel)
      }

      /* ---------------- 数据 ---------------- */
      function post(qs) {
        return fetch(API + qs, { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .catch(function () { return null })
      }

      function syncState(d) {
        if (!d) return
        if (typeof d.total === 'number') st.total = d.total
        if (typeof d.index === 'number') st.index = d.index
        if (typeof d.intervalSec === 'number') st.intervalSec = d.intervalSec
        if (typeof d.scrim === 'number') st.scrim = d.scrim
        if (typeof d.paused === 'boolean') st.paused = d.paused
        if (d.id) st.currentId = String(d.id)
        if (typeof d.sharpOnly === 'boolean') {
          st.sharpOnly = d.sharpOnly
          if (sharpBtn) sharpBtn.textContent = '仅高清：' + (st.sharpOnly ? '开' : '关')
        }
        if (counter) counter.textContent = (st.index + 1) + ' / ' + st.total
        if (ivRange) {
          ivRange.input.value = st.intervalSec
          ivRange.label.textContent = ivRange.fmt(st.intervalSec)
        }
        if (scRange) {
          var pct = Math.round(st.scrim * 100)
          scRange.input.value = pct
          scRange.label.textContent = scRange.fmt(pct)
        }
        if (pauseBtn) pauseBtn.textContent = st.paused ? '继续' : '暂停'
      }

      function clearSlot(slot) {
        if (!slot) return
        if (slot.__video) {
          try {
            slot.__video.pause()
            slot.__video.removeAttribute('src')
            slot.__video.load()
          } catch (e) { /* 忽略 */ }
          slot.__video = null
        }
        while (slot.firstChild) slot.removeChild(slot.firstChild)
        slot.style.backgroundImage = 'none'
      }

      function render(url, kind) {
        if (!url) return
        var incoming = slots[1 - front]
        var outgoing = slots[front]
        var revealed = false
        var reveal = function () {
          if (revealed) return
          revealed = true
          incoming.style.opacity = '1'
          outgoing.style.opacity = '0'
          front = 1 - front
          stage.style.opacity = '1'
          var stale = outgoing
          setTimeout(function () { if (stale !== slots[front]) clearSlot(stale) }, 900)
        }

        if (kind === 'video') {
          var v = document.createElement('video')
          v.muted = true
          v.loop = true
          v.autoplay = true
          v.playsInline = true
          v.setAttribute('muted', '')
          v.setAttribute('playsinline', '')
          v.preload = 'auto'
          v.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;'
          v.src = url
          clearSlot(incoming)
          incoming.appendChild(v)
          incoming.__video = v
          v.addEventListener('canplay', reveal)
          v.addEventListener('playing', reveal)
          setTimeout(reveal, 2600)
          var pr = v.play()
          if (pr && pr.catch) pr.catch(function () { /* 等 canplay */ })
          return
        }

        var img = new Image()
        img.onload = function () {
          clearSlot(incoming)
          incoming.style.backgroundImage = 'url("' + url + '")'
          reveal()
        }
        img.src = url
      }

      function advance(delta) {
        if (busy) return
        busy = true
        post('/show?step=' + (delta || 1))
          .then(function (d) {
            busy = false
            if (!d || !d.url) return
            syncState(d)
            if (metaLine) {
              var desc = d.kind === 'video'
                ? '视频 · 原始 mp4'
                : (d.w ? (d.w + '×' + d.h + (d.sharp ? ' · 高清' : ' · 低清')) : '图片')
              metaLine.textContent = desc
              metaLine.style.color = d.sharp === false ? '#d19a6a' : '#8fa8a6'
            }
            render(d.url, d.kind)
            nextAt = Date.now() + st.intervalSec * 1000
          })
          .catch(function () { busy = false })
      }

      function togglePause() {
        st.paused = !st.paused
        post('/config?paused=' + (st.paused ? '1' : '0')).then(syncState)
        if (pauseBtn) pauseBtn.textContent = st.paused ? '继续' : '暂停'
        if (!st.paused) nextAt = Date.now() + st.intervalSec * 1000
      }

      /* ---------------- 自检回传 ---------------- */
      function reportDiag() {
        try {
          var sb = document.querySelector('[class*="sidebarCol"]') || document.querySelector('[class*="sidebar"]')
          var frame = document.querySelector('[class*="frame"]')
          var payload = {
            vw: window.innerWidth, vh: window.innerHeight,
            stageOpacity: stage ? getComputedStyle(stage).opacity : null,
            video: !!document.querySelector('#wpv2-stage video'),
            hasImage: !!(slots[0].style.backgroundImage || slots[1].style.backgroundImage),
            theme: theme,
            scrim: st.scrim,
            neutralized: neutral.count,
            samples: neutral.names,
            sidebarBg: sb ? getComputedStyle(sb).backgroundColor : null,
            frameBg: frame ? getComputedStyle(frame).backgroundColor : null,
            bodyBg: getComputedStyle(document.body).backgroundColor,
            topAt10: (function () {
              var e = document.elementFromPoint(Math.round(window.innerWidth / 2), 10)
              if (!e) return null
              var r = e.getBoundingClientRect()
              var cs = getComputedStyle(e)
              return { c: (e.className || '').toString().slice(0, 50) || e.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, img: cs.backgroundImage.slice(0, 30) }
            })(),
            strips: document.querySelectorAll('[data-wpv2-strip="1"]').length,
            index: st.index, total: st.total,
          }
          fetch(API + '/diag?d=' + encodeURIComponent(JSON.stringify(payload)), { cache: 'no-store' })
        } catch (e) { /* 忽略 */ }
      }

      /* ---------------- 启动 ---------------- */
      function mount() {
        if (mounted) return
        if (!document.body) {
          timers.push(setTimeout(mount, 60))
          return
        }
        mounted = true
        document.body.insertBefore(stage, document.body.firstChild)
        buildControl()
        detectTheme()
        paintTokens()
        neutralize(true)

        try {
          window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
            theme = e.matches ? 'dark' : 'light'
            paintTokens()
            neutralize(true)
          })
        } catch (e) { /* 忽略 */ }

        post('/state').then(function (d) {
          syncState(d)
          advance(1)
          nextAt = Date.now() + st.intervalSec * 1000
        })

        timers.push(setInterval(function () {
          if (!st.paused && Date.now() >= nextAt) advance(1)
        }, 1000))
        timers.push(setInterval(function () {
          paintTokens()
          neutralize(false)
        }, 2500))
        // preload 只监听 body 的 childList，用一个 0 尺寸节点反复「敲」它，
        // 使原生标题栏颜色跟着 --dsw-specific-sidebar-fill 一起变透明
        var nudge = function () {
          try {
            var d = document.createElement('i')
            d.setAttribute('data-wpv2-nudge', '1')
            d.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
            document.body.appendChild(d)
            setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d) }, 40)
          } catch (e) { /* 忽略 */ }
        }
        nudge()
        timers.push(setInterval(nudge, 2000))
        timers.push(setInterval(reportDiag, 6000))
        reportDiag()
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount)
      } else {
        mount()
      }

      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            timers.forEach(function (t) { clearTimeout(t); clearInterval(t) })
            if (stage && stage.parentNode) stage.parentNode.removeChild(stage)
            if (fab && fab.parentNode) fab.parentNode.removeChild(fab)
            if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
            window.__wpv2 = false
          }
        })
      }
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
