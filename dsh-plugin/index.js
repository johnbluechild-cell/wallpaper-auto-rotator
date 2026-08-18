import { readFileSync, existsSync } from 'node:fs'

const SETTINGS_PATH = (process.env.DSH_HOME || 'C:\\Users\\Administrator\\.dsh') + '\\wallpaper-settings.json'
const DEFAULTS = { opacity: 0.28, intervalSec: 180, disabled: [], nextTick: 0 }

const WORKSHOP = 'E:\\steam\\steamapps\\workshop\\content\\431960'
const MYPROJECTS = 'E:\\steam\\steamapps\\common\\wallpaper_engine\\projects\\myprojects'
const IMG_EXT = { jpg: 1, jpeg: 1, png: 1, webp: 1, gif: 1 }
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }
const extOf = (n) => n.slice(n.lastIndexOf('.') + 1).toLowerCase()

function readSettings() {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
      return {
        opacity: typeof parsed.opacity === 'number' ? parsed.opacity : DEFAULTS.opacity,
        intervalSec: typeof parsed.intervalSec === 'number' ? parsed.intervalSec : DEFAULTS.intervalSec,
        disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
        nextTick: typeof parsed.nextTick === 'number' ? parsed.nextTick : 0
      }
    }
  } catch (e) {}
  return { ...DEFAULTS }
}

let cachedFiles = []
let cachedAt = 0

async function scan(fs) {
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

async function getFiles(fs, force) {
  const now = Date.now()
  if (!force && cachedFiles.length && now - cachedAt < 60000) return cachedFiles
  const next = await scan(fs)
  if (next.length) { cachedFiles = next; cachedAt = now }
  return cachedFiles
}

function filtered(files, settings) {
  const disabled = new Set(settings.disabled || [])
  return files.filter((f) => !disabled.has(f.name))
}

const ROTATOR_JS = `(function () {
  var state = { opacity: 0.28, intervalSec: 180 };
  var count = 0, index = 0, nextFireAt = 0, lastTick = 0;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function isDark() { return document.body && document.body.hasAttribute('data-ds-dark-theme'); }

  function applyOpacity() {
    var b = clamp(state.opacity, 0.05, 0.95);
    var rgb = isDark() ? '17,17,21' : '246,246,250';
    var vals = {
      '--dsw-alias-bg-base': b,
      '--dsw-specific-sidebar-fill': clamp(b + 0.04, 0.05, 0.95),
      '--dsw-alias-bg-layer-1': clamp(b + 0.18, 0.05, 0.96),
      '--dsw-alias-bg-layer-2': clamp(b + 0.28, 0.05, 0.97),
      '--dsw-alias-bg-overlay': clamp(b + 0.62, 0.05, 0.98)
    };
    Object.keys(vals).forEach(function (k) {
      document.documentElement.style.setProperty(k, 'rgba(' + rgb + ',' + vals[k].toFixed(2) + ')', 'important');
    });
  }

  function loadSettings() {
    return fetch('/wallpaper/settings').then(function (r) { return r.json(); }).then(function (s) {
      if (!s) return;
      if (typeof s.opacity === 'number') state.opacity = s.opacity;
      if (typeof s.intervalSec === 'number') state.intervalSec = s.intervalSec;
      applyOpacity();
      if (typeof s.nextTick === 'number' && s.nextTick !== lastTick) {
        lastTick = s.nextTick;
        tick();
      }
    }).catch(function () {});
  }

  var style = document.createElement('style');
  style.textContent = 'body{background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important;background-attachment:fixed!important;background-color:#141419!important;}';
  document.head.appendChild(style);

  function refresh() {
    return fetch('/wallpaper/list').then(function (r) { return r.json(); }).then(function (l) { count = (l && l.count) ? l.count : 0; });
  }
  function show(i) {
    if (!count) return;
    var idx = ((i % count) + count) % count;
    fetch('/wallpaper/data?index=' + idx).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.dataUrl) document.body.style.backgroundImage = 'url("' + d.dataUrl + '")';
    }).catch(function () {});
  }
  function tick() {
    refresh().then(function () { show(index); index = count ? (index + 1) % count : 0; });
    nextFireAt = Date.now() + clamp(state.intervalSec, 30, 600) * 1000;
  }

  applyOpacity();
  loadSettings();
  tick();
  setInterval(function () { if (Date.now() >= nextFireAt) tick(); }, 1000);
  setInterval(function () { loadSettings(); applyOpacity(); }, 5000);
})();`

export function apply(ctx) {
  ctx.inject(['webServer'], (httpCtx) => {
    const ws = httpCtx.webServer

    httpCtx.effect(() => ws.register({ kind: 'exact', path: '/wallpaper/list', handler: async (req, res) => {
      try {
        const fs = ctx.get('fs')
        if (!fs) { res.writeHead(500); res.end(JSON.stringify({ count: 0, names: [] })); return }
        const files = filtered(await getFiles(fs, true), readSettings())
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ count: files.length, names: files.map((f) => f.name) }))
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ count: 0, names: [] })) }
    }}), 'wallpaper: list route')

    httpCtx.effect(() => ws.register({ kind: 'exact', path: '/wallpaper/data', handler: async (req, res) => {
      try {
        const fs = ctx.get('fs')
        if (!fs) { res.writeHead(500); res.end('null'); return }
        const u = new URL(req.url || '/', 'http://x')
        const parsed = parseInt(u.searchParams.get('index') || '0', 10)
        const idx = Number.isFinite(parsed) ? parsed : 0
        const files = filtered(await getFiles(fs, false), readSettings())
        if (!files.length) { res.setHeader('Content-Type', 'application/json'); res.end('null'); return }
        const i = ((idx % files.length) + files.length) % files.length
        const item = files[i]
        const bytes = await fs.readBytes(item.target, undefined, 20 * 1024 * 1024)
        const dataUrl = 'data:' + (MIME[extOf(item.name)] || 'image/jpeg') + ';base64,' + Buffer.from(bytes).toString('base64')
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ name: item.name, dataUrl }))
      } catch (e) { res.writeHead(500); res.end('null') }
    }}), 'wallpaper: data route')

    httpCtx.effect(() => ws.register({ kind: 'exact', path: '/wallpaper/settings', handler: (req, res) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(readSettings()))
    }}), 'wallpaper: settings route')

    httpCtx.effect(() => ws.register({ kind: 'exact', path: '/wallpaper/rotator.js', handler: (req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
      res.end(ROTATOR_JS)
    }}), 'wallpaper: rotator script')

    httpCtx.effect(() => ws.tapIndex((html) => {
      const tag = '<script src="/wallpaper/rotator.js"></script>'
      return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
    }), 'wallpaper: index tap')
  })
}
