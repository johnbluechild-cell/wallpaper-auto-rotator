return {
  apply(ctx) {
    const fs = ctx.get('fs')
    if (!fs) { console.error('wallpaper: fs service unavailable'); return }

    const WORKSHOP = 'E:\\steam\\steamapps\\workshop\\content\\431960'
    const MYPROJECTS = 'E:\\steam\\steamapps\\common\\wallpaper_engine\\projects\\myprojects'
    const SETTINGS_PATH = 'C:\\Users\\Administrator\\.dsh\\wallpaper-settings.json'
    const IMG_EXT = { jpg: 1, jpeg: 1, png: 1, webp: 1, gif: 1 }
    const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
    const extOf = (n) => n.slice(n.lastIndexOf('.') + 1).toLowerCase()

    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const toBase64 = (bytes) => {
      let out = ''
      for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i]
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
        out += B64.charAt(b0 >> 2)
        out += B64.charAt(((b0 & 3) << 4) | (b1 >> 4))
        out += i + 1 < bytes.length ? B64.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '='
        out += i + 2 < bytes.length ? B64.charAt(b2 & 63) : '='
      }
      return out
    }

    let files = []
    let scannedAt = 0
    const dataCache = {}

    async function scan() {
      const out = []
      try {
        const wdir = await fs.resolve(WORKSHOP)
        const subs = await fs.listDir(wdir)
        for (const sub of subs) {
          if (sub.type !== 'directory') continue
          try {
            const entries = await fs.listDir(sub.target)
            for (const e of entries) {
              if (e.type === 'file' && /^preview\./i.test(e.name) && IMG_EXT[extOf(e.name)]) {
                out.push({ name: 'workshop/' + sub.name + '/' + e.name, target: e.target })
                break
              }
            }
          } catch (err) {}
        }
      } catch (err) {}
      try {
        const mdir = await fs.resolve(MYPROJECTS)
        const projects = await fs.listDir(mdir)
        for (const proj of projects) {
          if (proj.type !== 'directory') continue
          try {
            const entries = await fs.listDir(proj.target)
            for (const e of entries) {
              if (e.type === 'file' && /^preview\./i.test(e.name) && IMG_EXT[extOf(e.name)]) {
                out.push({ name: 'local/' + proj.name + '/' + e.name, target: e.target })
              } else if (e.type === 'directory' && e.name.toLowerCase() === 'materials') {
                try {
                  const mats = await fs.listDir(e.target)
                  for (const m of mats) {
                    if (m.type === 'file' && IMG_EXT[extOf(m.name)]) {
                      out.push({ name: 'local/' + proj.name + '/materials/' + m.name, target: m.target })
                    }
                  }
                } catch (err) {}
              }
            }
          } catch (err) {}
        }
      } catch (err) {}
      return out
    }

    async function getFiles(force) {
      const now = Date.now()
      if (!force && files.length && now - scannedAt < 60000) return files
      const next = await scan()
      if (next.length) { files = next; scannedAt = now }
      return files
    }

    async function readSettings() {
      try {
        const target = await fs.resolve(SETTINGS_PATH)
        const text = await fs.readText(target)
        const parsed = JSON.parse(text)
        return {
          opacity: typeof parsed.opacity === 'number' ? parsed.opacity : 0.28,
          intervalSec: typeof parsed.intervalSec === 'number' ? parsed.intervalSec : 180,
          disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
          nextTick: typeof parsed.nextTick === 'number' ? parsed.nextTick : 0
        }
      } catch (e) { return { opacity: 0.28, intervalSec: 180, disabled: [], nextTick: 0 } }
    }

    async function getFiltered(force) {
      const f = await getFiles(force)
      const st = await readSettings()
      const set = new Set(st.disabled || [])
      return f.filter((x) => !set.has(x.name))
    }

    ctx.effect(() => harness.handle('wallpaper:list', async () => {
      const f = await getFiltered(true)
      return { count: f.length, names: f.map((x) => x.name) }
    }))

    ctx.effect(() => harness.handle('wallpaper:at', async (args) => {
      const f = await getFiltered(false)
      if (!f.length) return null
      const n = f.length
      let idx = (args && typeof args.index === 'number') ? args.index : 0
      idx = ((idx % n) + n) % n
      const item = f[idx]
      const key = item.target.displayPath || item.name
      if (dataCache[key]) return dataCache[key]
      const bytes = await fs.readBytes(item.target, undefined, 20 * 1024 * 1024)
      const dataUrl = 'data:' + (MIME[extOf(item.name)] || 'image/jpeg') + ';base64,' + toBase64(bytes)
      dataCache[key] = { name: item.name, dataUrl: dataUrl }
      return dataCache[key]
    }))

    ctx.effect(() => harness.handle('wallpaper:settings', async () => readSettings()))
  }
}
