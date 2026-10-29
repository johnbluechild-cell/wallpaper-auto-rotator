/**
 * wallpaper-rotator-v2 — DSH 壁纸轮换插件（host 端）
 *
 * 集成关系：
 *   壁纸目录来自开源项目 dsh-wallpaper-engine-api（MIT, nishuoyang）——
 *   它在 127.0.0.1:8088 提供只读的 Wallpaper Engine 库清单；
 *   本插件负责「随机顺序 / 满屏不透明渲染 / 应用内小控件」这三件事。
 *
 * 设计要点：
 *   - 每次 DSH 启动都用 Fisher–Yates 重新洗牌，所以「开机即随机」，且不会重复到放完一轮。
 *   - 图片走 /wp/img 流式输出（不转 base64），带长缓存，避免旧实现里 27MB 字符串的问题。
 *   - 客户端通过 dsh.client 模块加载（桌面端与 web 通用），不改 DSH 源码。
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(PLUGIN_DIR, '..')

const WE_BASE = process.env.WP_WE_BASE || 'http://127.0.0.1:8088'
const WORKSHOP = process.env.WP_WORKSHOP || 'C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960'
const MYPROJECTS = process.env.WP_MYPROJECTS || 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\projects\\myprojects'
const STILLS = process.env.WP_STILLS || join(REPO_ROOT, 'stills')

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
const VIDEO_EXT = new Set(['.mp4', '.webm'])
const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
}

const CLIENT_JS = readFileSync(new URL('./client.js', import.meta.url), 'utf8')

/** 一次进程生命周期内的运行状态：洗牌结果在启动时就定下来 */
const state = {
  catalog: [],
  order: [],
  cursor: -1,
  intervalSec: 180,
  scrim: 0.34,
  paused: false,
  sharpOnly: true,
  excluded: [],
  bootId: Math.random().toString(36).slice(2, 8),
  diag: null,
  scannedAt: 0,
}

/** 设置持久化到 DSH_HOME（工作区内），重启后保留间隔/压暗/暂停状态 */
const SETTINGS_FILE = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'wallpaper-rotator-v2.json') : null

function loadSettings() {
  try {
    if (SETTINGS_FILE && existsSync(SETTINGS_FILE)) {
      const j = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
      if (typeof j.intervalSec === 'number') state.intervalSec = Math.min(3600, Math.max(15, j.intervalSec))
      if (typeof j.scrim === 'number') state.scrim = Math.min(0.9, Math.max(0, j.scrim))
      if (typeof j.paused === 'boolean') state.paused = j.paused
      if (typeof j.sharpOnly === 'boolean') state.sharpOnly = j.sharpOnly
      if (Array.isArray(j.excluded)) state.excluded = j.excluded.map(String)
    }
  } catch { /* 配置坏了就用默认值 */ }
}

function saveSettings() {
  try {
    if (SETTINGS_FILE) {
      writeFileSync(SETTINGS_FILE, JSON.stringify({
        intervalSec: state.intervalSec, scrim: state.scrim, paused: state.paused, sharpOnly: state.sharpOnly, excluded: state.excluded,
      }), 'utf8')
    }
  } catch { /* 写不了不影响轮换 */ }
}

function visible() {
  const ban = new Set(state.excluded)
  const pool = state.sharpOnly ? state.catalog.filter((x) => x.sharp) : state.catalog
  return pool.filter((x) => !ban.has(x.id))
}

const PYTHON = process.env.WP_PYTHON || 'python'
const EXTRACTOR = process.env.WP_EXTRACTOR || join(REPO_ROOT, 'tools', 'still-extract.py')

/** 静帧索引：成功记 {w,h}，失败记 {fail:true}，避免无解的场景被反复重试 */
function stillIndex() {
  try { return JSON.parse(readFileSync(join(STILLS, 'index.json'), 'utf8')) } catch { return {} }
}

/** 有多少个场景包还没有静帧（也没有被标记失败） */
function pendingScenes() {
  const idx = stillIndex()
  let n = 0
  try {
    for (const name of readdirSync(WORKSHOP)) {
      if (idx[name]) continue
      const dir = join(WORKSHOP, name)
      if (!existsSync(join(dir, 'scene.pkg'))) continue
      const pj = join(dir, 'project.json')
      if (!existsSync(pj)) continue
      try {
        const j = JSON.parse(readFileSync(pj, 'utf8'))
        const ty = String(j.type || '').toLowerCase()
        if (ty === 'scene' || ty === 'web') n++
      } catch { /* 坏 json 跳过 */ }
    }
  } catch { /* 目录不存在 */ }
  return n
}

/** 有新场景包就在后台跑提取器（脚本自带文件锁，重复触发无害） */
function runExtractor() {
  const pending = pendingScenes()
  if (!pending) return 0
  try {
    const child = spawn(PYTHON, [EXTRACTOR], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch { /* 起不来下次再试 */ }
  return pending
}

function shuffle(list) {
  const a = list.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

/** 场景壁纸如果有离线提取的 4K 静帧，就用静帧替换掉 192px 的预览图 */
function applyStills(items) {
  for (const it of items) {
    if (it.video) continue
    const still = join(STILLS, it.id + '.jpg')
    if (existsSync(still)) { it.path = still; it.still = true }
  }
  return items
}

function isImage(p) {
  return p && IMG_EXT.has(extname(p).toLowerCase())
}

/** 读图片头部拿分辨率，用于判断清晰度（不加载整图） */
function imageSize(file) {
  try {
    const b = readFileSync(file)
    if (b.length < 24) return null
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
    if (b[0] === 0x47 && b[1] === 0x49) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2
      while (i < b.length - 9) {
        if (b[i] !== 0xff) { i++; continue }
        const mk = b[i + 1]
        const len = b.readUInt16BE(i + 2)
        if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
          return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
        }
        i += 2 + len
      }
    }
  } catch { /* 读不到就当未知 */ }
  return null
}

/** 视频型一律视为高清；图片型按宽度判定 */
function markQuality(items) {
  for (const it of items) {
    if (it.video) { it.sharp = true; if (!it.w) { it.w = 0; it.h = 0 } continue }
    const dim = imageSize(it.path)
    it.w = dim ? dim.w : 0
    it.h = dim ? dim.h : 0
    it.sharp = (it.w >= 1280)
  }
  return items
}
/** 视频型壁纸：project.json 的 file 字段指向真实 mp4；找不到就退回目录里第一个视频 */
async function resolveVideo(item) {
  if (!item || item.type !== 'video' || !item.path) return null
  const dir = dirname(item.path)
  try {
    const pj = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    if (pj && pj.file) {
      const candidate = join(dir, pj.file)
      if (existsSync(candidate) && VIDEO_EXT.has(extname(candidate).toLowerCase())) return candidate
    }
  } catch { /* 没有 project.json 就走兜底 */ }
  try {
    const files = await readdir(dir)
    const hit = files.find((f) => VIDEO_EXT.has(extname(f).toLowerCase()))
    if (hit) return join(dir, hit)
  } catch { /* ignore */ }
  return null
}

/** 首选：开源 WE API 的清单；失败则回退到本地目录扫描 */
async function loadCatalog() {
  try {
    const res = await fetch(WE_BASE + '/api/wallpapers', { signal: AbortSignal.timeout(5000) })
    const json = await res.json()
    const items = (json.wallpapers || [])
      .map((w) => {
        const file = w.previewFile || w.thumbnail || ''
        if (!isImage(file)) return null
        return { id: String(w.id), title: w.title || String(w.id), type: w.type || 'scene', path: file }
      })
      .filter(Boolean)
    for (const it of items) it.video = await resolveVideo(it)
    applyStills(items)
    markQuality(items)
    if (items.length) return { items, source: 'api' }
  } catch {
    /* API 未就绪时走下面的兜底 */
  }
  return { items: await scanLocal(), source: 'local' }
}

async function scanLocal() {
  const out = []
  try {
    const dirs = await readdir(WORKSHOP, { withFileTypes: true })
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      try {
        const files = await readdir(join(WORKSHOP, d.name))
        const hit = files.find((f) => /^preview\./i.test(f) && isImage(f))
        if (hit) out.push({ id: d.name, title: d.name, type: 'scene', path: join(WORKSHOP, d.name, hit) })
      } catch { /* 单个订阅读不到就跳过 */ }
    }
  } catch { /* 目录不存在 */ }
  try {
    const dirs = await readdir(MYPROJECTS, { withFileTypes: true })
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      try {
        const files = await readdir(join(MYPROJECTS, d.name))
        const hit = files.find((f) => /^preview\./i.test(f) && isImage(f))
        if (hit) out.push({ id: 'local-' + d.name, title: d.name, type: 'local', path: join(MYPROJECTS, d.name, hit) })
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  for (const it of out) it.video = await resolveVideo(it)
  applyStills(out)
  markQuality(out)
  return out
}

async function ensureCatalog(force = false) {
  const age = Date.now() - state.scannedAt
  const fresh = state.catalog.length && age < 120000
  // 回退清单每 10 秒重试一次真实 API，好把标题/类型换成 WE 里的真值
  const retryLocal = state.source === 'local' && age > 10000
  if (fresh && !force && !retryLocal) return state.catalog
  const next = await loadCatalog()
  const items = next.items || []
  if (items.length) {
    const prevIds = state.catalog.map((x) => x.id).join(',')
    const nextIds = items.map((x) => x.id).join(',')
    state.catalog = items
    state.source = next.source || 'api'
    state.scannedAt = Date.now()
    // 目录变过（新下载了壁纸）就重新洗牌，并把游标放到队首
    if (prevIds !== nextIds) {
      state.order = shuffle(visible().map((x) => x.id))
      state.cursor = -1
    }
  }
  if (!state.order.length) state.order = shuffle(visible().map((x) => x.id))
  return state.catalog
}

function byId(id) {
  return state.catalog.find((x) => x.id === id) || null
}

function current() {
  if (!state.order.length) return null
  const id = state.order[((state.cursor % state.order.length) + state.order.length) % state.order.length]
  return byId(id)
}

function step(delta) {
  if (!state.order.length) return null
  state.cursor = ((state.cursor + delta) % state.order.length + state.order.length) % state.order.length
  return current()
}

function payload(item) {
  const index = state.cursor < 0 ? 0 : state.cursor
  return {
    url: item ? (item.video ? '/wp/video?id=' : '/wp/img?id=') + encodeURIComponent(item.id) : '',
    id: item ? item.id : '',
    kind: item && item.video ? 'video' : 'image',
    w: item ? item.w || 0 : 0,
    h: item ? item.h || 0 : 0,
    sharp: item ? !!item.sharp : false,
    title: item ? item.title : '',
    type: item ? item.type : '',
    index,
    total: state.order.length,
    bootId: state.bootId,
  }
}

function sendJson(res, body, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendImage(req, res, file) {
  let st
  try { st = statSync(file) } catch { sendJson(res, { ok: false }, 404); return }
  const etag = 'W/"' + st.size + '-' + Math.floor(st.mtimeMs) + '"'
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=604800' })
    res.end()
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'public, max-age=604800',
    ETag: etag,
  })
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(file).on('error', () => { try { res.destroy() } catch { /* ignore */ } }).pipe(res)
}
function sendVideo(req, res, file) {
  let st
  try { st = statSync(file) } catch { sendJson(res, { ok: false }, 404); return }
  const total = st.size
  const headers = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=604800',
    ETag: 'W/"v' + total + '-' + Math.floor(st.mtimeMs) + '"',
  }
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    let start = m && m[1] ? parseInt(m[1], 10) : 0
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1
    if (!Number.isFinite(start) || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total })
      res.end()
      return
    }
    end = Math.min(Number.isFinite(end) ? end : total - 1, total - 1)
    res.writeHead(206, Object.assign({}, headers, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Content-Length': end - start + 1,
    }))
    createReadStream(file, { start, end }).on('error', () => { try { res.destroy() } catch { /* ignore */ } }).pipe(res)
    return
  }
  res.writeHead(200, Object.assign({}, headers, { 'Content-Length': total }))
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(file).on('error', () => { try { res.destroy() } catch { /* ignore */ } }).pipe(res)
}

export function apply(ctx) {
  loadSettings()
  ctx.effect(() => {
    const first = setTimeout(() => runExtractor(), 20000)
    const tick = setInterval(() => runExtractor(), 600000)
    return () => { clearTimeout(first); clearInterval(tick) }
  }, 'wallpaper-v2: still watcher')
  void ensureCatalog()

  ctx.inject(['webServer'], (httpCtx) => {
    const ws = httpCtx.webServer

    httpCtx.effect(() => ws.register({
      kind: 'exact',
      path: '/wp/client.js',
      handler: (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
        res.end(CLIENT_JS)
      },
    }), 'wallpaper-v2: client script')

    httpCtx.effect(() => ws.register({
      kind: 'exact',
      path: '/wp/state',
      handler: async (req, res) => {
        await ensureCatalog()
        sendJson(res, {
          ok: true,
          total: state.order.length,
          index: state.cursor < 0 ? 0 : state.cursor,
          intervalSec: state.intervalSec,
          scrim: state.scrim,
          paused: state.paused,
          sharpOnly: state.sharpOnly,
          pendingStills: pendingScenes(),
          excluded: state.excluded.length,
          bootId: state.bootId,
          diag: state.diag,
          current: payload(current()),
        })
      },
    }), 'wallpaper-v2: state')

    httpCtx.effect(() => ws.register({
      kind: 'exact',
      path: '/wp/show',
      handler: async (req, res) => {
        await ensureCatalog()
        const url = new URL(req.url || '/', 'http://x')
        const delta = parseInt(url.searchParams.get('step') || '1', 10)
        const item = step(Number.isFinite(delta) ? delta : 1)
        sendJson(res, payload(item))
      },
    }), 'wallpaper-v2: show')

    httpCtx.effect(() => ws.register({
      kind: 'exact',
      path: '/wp/config',
      handler: async (req, res) => {
        await ensureCatalog()
        const q = new URL(req.url || '/', 'http://x').searchParams
        const iv = parseInt(q.get('interval') || '', 10)
        if (Number.isFinite(iv)) state.intervalSec = Math.min(3600, Math.max(15, iv))
        const sc = parseFloat(q.get('scrim') || '')
        if (Number.isFinite(sc)) state.scrim = Math.min(0.9, Math.max(0, sc))
        if (q.has('paused')) state.paused = q.get('paused') === '1'
        if (q.has('exclude')) {
          const id = String(q.get('exclude') || '')
          if (id && !state.excluded.includes(id)) {
            state.excluded.push(id)
            state.order = state.order.filter((x) => x !== id)
            if (state.cursor >= state.order.length) state.cursor = state.order.length - 1
            if (!state.order.length) state.order = shuffle(visible().map((x) => x.id))
            saveSettings()
          }
        }
        if (q.has('restore')) {
          const id = String(q.get('restore') || '')
          if (id && id !== 'all') state.excluded = state.excluded.filter((x) => x !== id)
          else state.excluded = []
          state.order = shuffle(visible().map((x) => x.id))
          state.cursor = -1
          saveSettings()
        }
        if (q.has('sharp')) {
          state.sharpOnly = q.get('sharp') === '1'
          state.order = shuffle(visible().map((x) => x.id))
          state.cursor = -1
        }
        if (q.has('reshuffle')) {
          state.order = shuffle(state.catalog.map((x) => x.id))
          state.cursor = -1
        }
        if (q.has('refresh')) await ensureCatalog(true)
        if (q.has('interval') || q.has('scrim') || q.has('paused') || q.has('sharp')) saveSettings()
        sendJson(res, {
          ok: true,
          total: state.order.length,
          intervalSec: state.intervalSec,
          scrim: state.scrim,
          paused: state.paused,
          sharpOnly: state.sharpOnly,
          excluded: state.excluded.length,
          current: payload(current()),
        })
      },
    }), 'wallpaper-v2: config')

    httpCtx.effect(() => ws.register({
      kind: 'exact',
      path: '/wp/diag',
      handler: async (req, res) => {
        try {
          const raw = new URL(req.url || '/', 'http://x').searchParams.get('d') || ''
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed === 'object') state.diag = parsed
        } catch { /* 诊断数据坏了忽略 */ }
        sendJson(res, { ok: true })
      },
    }), 'wallpaper-v2: diag')

    httpCtx.effect(() => ws.register({
      kind: 'exact',
      path: '/wp/video',
      handler: async (req, res) => {
        await ensureCatalog()
        const id = new URL(req.url || '/', 'http://x').searchParams.get('id') || ''
        const item = byId(id)
        if (!item || !item.video) { sendJson(res, { ok: false, error: 'no video for this wallpaper' }, 404); return }
        sendVideo(req, res, item.video)
      },
    }), 'wallpaper-v2: video')

    httpCtx.effect(() => ws.register({
      kind: 'exact',
      path: '/wp/img',
      handler: async (req, res) => {
        await ensureCatalog()
        const id = new URL(req.url || '/', 'http://x').searchParams.get('id') || ''
        const item = byId(id)
        if (!item) { sendJson(res, { ok: false, error: 'unknown wallpaper' }, 404); return }
        sendImage(req, res, item.path)
      },
    }), 'wallpaper-v2: image')

    // 客户端通过 dsh.client 模块加载（桌面端与 web 通用），不再依赖 tapIndex 注入

  })
}
