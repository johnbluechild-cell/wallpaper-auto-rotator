return {
  apply(ctx) {
    const theme = ctx.get('theme')
    const timer = ctx.get('timer')

    let opacity = 0.28
    let intervalSec = 180
    let lastTick = 0

    function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }
    function rgba(r, g, b, a) { return 'rgba(' + r + ',' + g + ',' + b + ',' + clamp(a, 0.05, 0.98).toFixed(2) + ')' }
    function alphas(base) {
      return {
        '--dsw-alias-bg-base': { light: rgba(246,246,250,base), dark: rgba(17,17,21,base) },
        '--dsw-specific-sidebar-fill': { light: rgba(240,240,245,base+0.04), dark: rgba(19,19,24,base+0.04) },
        '--dsw-alias-bg-layer-1': { light: rgba(255,255,255,base+0.18), dark: rgba(26,26,31,base+0.18) },
        '--dsw-alias-bg-layer-2': { light: rgba(255,255,255,base+0.28), dark: rgba(33,33,39,base+0.28) },
        '--dsw-alias-bg-overlay': { light: rgba(255,255,255,base+0.62), dark: rgba(26,26,32,base+0.62) }
      }
    }
    function applyOpacity() {
      if (theme && typeof theme.overrideTokens === 'function') {
        theme.overrideTokens('wallpaper-rotator', alphas(opacity))
      }
    }

    ctx.effect(() => styles.insert(
      'body { background-size: cover !important; background-position: center !important; background-repeat: no-repeat !important; background-attachment: fixed !important; background-color: #141419 !important; }'
    ))

    ctx.effect(() => {
      let bgDisposer = null
      let stopped = false
      let count = 0
      let index = 0
      let lastRotate = Date.now()
      const disposers = []

      async function refresh() {
        try { const l = await host.call('wallpaper:list'); if (l && typeof l.count === 'number') count = l.count } catch (e) {}
      }
      async function show(i) {
        try {
          if (!count) return
          const idx = ((i % count) + count) % count
          const res = await host.call('wallpaper:at', { index: idx })
          if (stopped || !res || !res.dataUrl) return
          if (bgDisposer) { bgDisposer(); bgDisposer = null }
          bgDisposer = styles.insert('body { background-image: url("' + res.dataUrl + '") !important; }')
        } catch (e) {}
      }
      async function rotate() {
        lastRotate = Date.now()
        await refresh()
        await show(index)
        index = count ? (index + 1) % count : 0
      }
      async function pollSettings() {
        try {
          const s = await host.call('wallpaper:settings')
          if (s && typeof s.opacity === 'number' && Math.abs(s.opacity - opacity) > 0.001) { opacity = s.opacity; applyOpacity() }
          if (s && typeof s.intervalSec === 'number') intervalSec = Math.max(30, s.intervalSec)
          if (s && typeof s.nextTick === 'number' && s.nextTick !== lastTick) { lastTick = s.nextTick; rotate() }
        } catch (e) {}
      }

      if (timer && typeof timer.interval === 'function') {
        disposers.push(timer.interval(() => { if (Date.now() - lastRotate >= intervalSec * 1000) rotate() }, 1000))
        disposers.push(timer.interval(pollSettings, 4000))
      }

      rotate()
      applyOpacity()

      return () => {
        stopped = true
        disposers.forEach((d) => { try { d() } catch (e) {} })
        if (bgDisposer) bgDisposer()
      }
    })
  }
}
