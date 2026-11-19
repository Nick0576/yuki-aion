#!/usr/bin/env node
/**
 * Yuki server: serves the built app and proxies the two APIs so the secret
 * keys never reach the browser.
 *
 *   node server.mjs            # http://127.0.0.1:8787
 *   PORT=9000 node server.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { createHash, createHmac, randomBytes } from 'node:crypto'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(ROOT, 'dist')
const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '127.0.0.1'

/* ------------------------------------------------------------------ env */
function loadEnv() {
  const files = ['.env.local', '.env']
  for (const f of files) {
    const p = path.join(ROOT, f)
    if (!fs.existsSync(p)) continue
    for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const i = line.indexOf('=')
      if (i < 0) continue
      const k = line.slice(0, i).trim()
      let v = line.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (!(k in process.env)) process.env[k] = v
    }
  }
}
loadEnv()

const NOMI_BASE = process.env.NOMI_BASE_URL || 'https://api.nomi.ai'
const KB_KEY = process.env.KOOLBASE_SECRET_KEY || process.env.KOOLBASE_API_KEY || ''
const KB_BASE = process.env.KOOLBASE_BASE_URL || 'https://api.koolbase.com'

/* Her voice: Fish Audio, a young anime-girl voice. The key never leaves the
   server (or the APK); the browser only ever talks to /api/tts. */
const FISH_BASE = process.env.FISH_BASE_URL || 'https://api.fish.audio'
const FISH_VOICE = process.env.FISH_VOICE_ID || 'd8f3b4c1199f4568a767ec54112d2b17'
const TTS_CACHE = new Map()

/* Several keys per service can be configured. When one runs out of credit or
   gets revoked, the next one takes its turn. Supported names, for both
   FISH (voice) and NOMI (chat):
     <SERVICE>_API_KEY            (first key)
     <SERVICE>_API_KEY_2 ... _10  (spares)
     <SERVICE>_API_KEYS           (comma/space separated list) */
function makeKeyRing(prefix) {
  const out = []
  const seen = new Set()
  const add = (raw) => {
    if (!raw) return
    for (const part of String(raw).split(/[\s,;]+/)) {
      const key = part.trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push({ key, dead: false, cooldownUntil: 0, label: `key${out.length + 1}` })
    }
  }
  add(process.env[`${prefix}_API_KEY`])
  for (let i = 2; i <= 10; i++) add(process.env[`${prefix}_API_KEY_${i}`])
  add(process.env[`${prefix}_API_KEYS`])
  return out
}

const FISH_KEYS = makeKeyRing('FISH')
const NOMI_KEYS = makeKeyRing('NOMI')


/* ---------------------------------- video ----------------------------------
 * Magic Hour image-to-video — free plan (watermarked, personal use only).
 * The browser/APK never sees the API key; it only talks to /api/video/*.
 * Video spends Magic Hour free credits — nothing here generates without an
 * explicit user action.
 */
const MAGIC_HOUR_KEYS = makeKeyRing('MAGIC_HOUR')
const MAGIC_HOUR_BASE = process.env.MAGIC_HOUR_BASE_URL || 'https://api.magichour.ai'
const MAGIC_HOUR_MODEL = process.env.MAGIC_HOUR_MODEL || 'ltx-2.5'
const MAGIC_HOUR_RES = process.env.MAGIC_HOUR_RESOLUTION || '480p'
const MAGIC_HOUR_CRS = 24   /* ltx-2.5 credits per second at 480p */
const VIDEO_DIR = process.env.VIDEO_CACHE_DIR || path.join(ROOT, '.video-cache')
const VIDEO_ASPECT = '9:16'
/* 24 cr/s — Magic Hour free-plan estimate shown in the app */
const VIDEO_PRICES = { '540p': 24, '720p': 24, '1080p': 24 }
try {
  fs.mkdirSync(VIDEO_DIR, { recursive: true })
} catch {}

function safeClipId(v) {
  const s = String(v || '')
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : ''
}

function clampSeconds(v) {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(10, Math.max(2, Math.round(n))) : 5
}

/* Downloading finished clips. Guarded so two status polls don't write twice. */
const clipDownloads = new Map()

async function downloadClip(file, url) {
  const okUrl =
    typeof url === 'string' &&
    (/^https:\/\//.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url))
  if (okUrl) {
    const r = await fetch(url, { redirect: 'follow' })
    if (!r.ok) throw new Error(`download_${r.status}`)
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
    return
  }
  throw new Error('unsupported_video_url')
}

/* ------------------------- Magic Hour image-to-video ---------------------------
 * Renders clips via api.magichour.ai with the owner's API key and their
 * account's free (watermarked) credits. Never runs without explicit user
 * action; credits are consumed by the provider only when a job succeeds.
 */
async function mh(path, { method = 'GET', body } = {}, byokKey = null) {
  if (byokKey) {
    const res = await fetch(MAGIC_HOUR_BASE + path, {
      method,
      headers: { 'Authorization': `Bearer ${byokKey}`, 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    return { status: res.status, data }
  }
  if (MAGIC_HOUR_KEYS.length === 0) {
    return { status: 503, data: { error: 'not_configured', message: 'Set MAGIC_HOUR_API_KEY in .env.' } }
  }
  const request = (key) =>
    fetch(MAGIC_HOUR_BASE + path, {
      method,
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
    })

  let last = { status: 502, data: { error: 'magichour_unreachable' } }
  for (const entry of keyPool(MAGIC_HOUR_KEYS, true)) {
    try {
      const res = await request(entry.key)
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      // mark keys that ran out of credits / were rejected, try the next key
      if (!markKeyResult(entry, res.status, 'magichour')) {
        return { status: res.status, data }
      }
      last = { status: res.status, data }
    } catch (err) {
      console.warn('[yuki] magichour', entry.label, err instanceof Error ? err.message : err)
      continue
    }
  }
  return last
}

async function magichourUploadImage(buf, name, byokKey = null) {
  const ext = (String(name).split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png'
  const up = await mh('/v1/files/upload-urls', {
    method: 'POST',
    body: { items: [{ type: 'image', extension: ext }] },
  }, byokKey)
  if (up.status >= 400 || !up.data?.items?.[0]) {
    throw new Error(up.data?.message || `upload URL failed (${up.status})`)
  }
  const item = up.data.items[0]
  const put = await fetch(item.upload_url, { method: 'PUT', body: buf })
  if (!put.ok) throw new Error(`upload PUT failed (${put.status})`)
  return item.file_path
}

async function magichourGenerate({ prompt, seconds }, referenceBuffer, byokKey = null) {
  const filePath = await magichourUploadImage(referenceBuffer, 'yuki-reference.png', byokKey)
  const res = await mh('/v1/image-to-video', {
    method: 'POST',
    body: {
      name: 'Yuki POV clip',
      end_seconds: seconds,
      model: MAGIC_HOUR_MODEL,
      resolution: MAGIC_HOUR_RES,
      style: { prompt },
      assets: { image_file_path: filePath },
    },
  }, byokKey)
  if (res.status >= 400 || !res.data?.id) {
    throw new Error(res.data?.message || `job failed (${res.status})`)
  }
  return String(res.data.id)
}

async function magichourPoll(taskId, byokKey = null) {
  const r = await mh(`/v1/video-projects/${encodeURIComponent(taskId)}`, {}, byokKey)
  if (r.status >= 400) {
    return { status: 'error', error: r.data?.message || `Status check failed (${r.status}).` }
  }
  const d = r.data || {}
  const st = String(d.status || '').toLowerCase()
  if (st === 'queued' || st === 'rendering') return { status: 'pending' }
  if (st === 'complete') {
    const url = Array.isArray(d.downloads) && d.downloads[0] && d.downloads[0].url ? String(d.downloads[0].url) : ''
    return { status: 'completed', url: url || undefined, creditsCharged: d.credits_charged }
  }
  if (st === 'canceled') return { status: 'error', error: 'The Magic Hour job was canceled.' }
  if (st === 'error') {
    const msg = d.error && d.error.message ? String(d.error.message) : 'The Magic Hour job failed.'
    return { status: 'error', error: msg }
  }
  return { status: 'pending' }
}

async function magichourCredits() {
  const balances = []
  let total = 0
  let lastError = null
  for (const entry of MAGIC_HOUR_KEYS) {
    try {
      const res = await fetch(MAGIC_HOUR_BASE + '/v1/account', {
        headers: { 'Authorization': `Bearer ${entry.key}`, 'Content-Type': 'application/json' },
      })
      const text = await res.text()
      let data = null
      try { data = JSON.parse(text) } catch {}
      const credits = data && data.credits != null ? Number(data.credits) || 0 : null
      const tier = data && data.tier ? String(data.tier) : null
      balances.push({ label: entry.label, credits, tier })
      if (credits != null) total += credits
      if (!markKeyResult(entry, res.status, 'magichour')) { /* already handled */ }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      balances.push({ label: entry.label, credits: null, tier: null })
    }
  }
  return {
    credits: balances.length ? total : null,
    tier: 'free',
    balances,
    error: balances.length ? null : (lastError || 'no keys configured'),
    keys: MAGIC_HOUR_KEYS.length,
  }
}

/* ============================ signer & users ============================
 * Video endpoints are not anonymous. Koolbase (cloud) accounts authenticate
 * via the app; offline accounts cannot use video generation. Clips are
 * isolated per user, rate-limited, and served through unguessable
 * file-scoped URLs.
 */
const VIDEO_PROVIDER_LABEL = 'Magic Hour — ltx-2.5 · free plan (watermark)'
const YUKI_DEV_NO_AUTH = process.env.YUKI_DEV_NO_AUTH === '1'
if (YUKI_DEV_NO_AUTH) {
  console.warn('[yuki] YUKI_DEV_NO_AUTH=1 — video endpoints do NOT require auth (development only)')
}

/* Signed playback URLs: file-scoped HMAC, safe to persist, cannot be reused
   across files or guessed. Set CLIP_SIGNING_SECRET in production so saved
   clip URLs survive restarts; a random secret is generated otherwise. */
let CLIP_SIGNING_SECRET = process.env.CLIP_SIGNING_SECRET || randomBytes(32).toString('hex')
if (!process.env.CLIP_SIGNING_SECRET) {
  console.warn('[yuki] CLIP_SIGNING_SECRET not set — clip URLs re-sign on restart (set it in production)')
}

const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex')
const userHash = (s) => sha256hex(s).slice(0, 12)
const clipSig = (h, name) =>
  createHmac('sha256', CLIP_SIGNING_SECRET).update(`video/${h}/${name}`).digest('base64url')
const clipUrl = (h, id) => `/video-cache/u_${h}/${id}.mp4?sig=${clipSig(h, `${id}.mp4`)}`

const VIDEO_OWNER_HASH = process.env.VIDEO_OWNER_EMAIL
  ? userHash(String(process.env.VIDEO_OWNER_EMAIL).trim().toLowerCase())
  : ''
const intEnv = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/* ------------------------ couple photo generation -------------------------
 * The user's selfie is used only for the one provider call and never stored;
 * her neutral art is uploaded as a second reference. Provider key stays here.
 */
const COUPLE_KEY = process.env.POLLINATIONS_API_KEY || ''
const COUPLE_BASE = process.env.POLLINATIONS_BASE_URL || 'https://gen.pollinations.ai'
const COUPLE_MODEL = process.env.COUPLE_MODEL || 'black-forest-labs/flux.1-kontext-pro'
const COUPLE_LIMIT_HOURLY = intEnv('COUPLE_LIMIT_HOURLY', 4)
const COUPLE_LIMIT_DAILY = intEnv('COUPLE_LIMIT_DAILY', 20)

const COUPLE_POSES = {
  'romantic-selfie': 'taking a happy selfie together, cheeks touching, laughing softly',
  'hugging': 'a warm full hug, eyes closed, faces close together',
  'holding-hands': 'walking side by side holding hands, looking at each other',
  'walking': 'strolling side by side companionably through the scene',
  'sitting': 'sitting side by side, shoulders touching, relaxed',
  'cute': 'a playful couple pose — head on shoulder, cute smile',
}
const COUPLE_LOCATIONS = {
  'bedroom': 'a cosy bedroom at night, warm lamps, soft blankets',
  'sakura-village': 'a cherry-blossom tree-lined Japanese street, petals drifting in spring light',
  'school': 'a Japanese high-school corridor at lunchtime',
  'beach': 'a sandy beach, bright sea and sky, warm daylight',
  'city': 'a neon-lit modern city street at night, wet pavement, signs glowing',
  'sunset': 'a romantic rooftop at golden hour, city skyline, warm sunset sky',
}
function couplePrompt(pose, loc, note) {
  const extra = typeof note === 'string' && note.trim() ? ` Extra direction: ${String(note).trim().slice(0, 200).replace(/@/g, 'a')}.` : ''
  return [
    'One anime-style illustration containing BOTH characters together, same cel-shaded anime style as the two reference images.',
    `Character A: the person in the first reference image (a selfie) — redraw them as a clean anime character and keep their face structure, eye shape and colour, hair colour, hairstyle, skin tone, and overall look recognizable as the same person.`,
    'Character B: the silver-haired girl in the second reference image — keep her exact face, hair colour, hairstyle, outfit and eye colour identical to the reference.',
    `They are together in ${COUPLE_LOCATIONS[loc]}. ${COUPLE_POSES[pose]}.${extra}`,
    'Both characters drawn in the same cute anime art style with soft cel shading, warm lighting, natural composition and natural scale.',
    'No text, no watermark, no third person, no photo references, no photorealism.',
  ].join(' ')
}

const LIMIT_HOURLY = intEnv('VIDEO_LIMIT_HOURLY', 3)
const LIMIT_DAILY = intEnv('VIDEO_LIMIT_DAILY', 15)
const LIMIT_HOURLY_OWNER = intEnv('VIDEO_LIMIT_OWNER_HOURLY', 12)
const LIMIT_DAILY_OWNER = intEnv('VIDEO_LIMIT_OWNER_DAILY', 60)
const limitsFor = (id) =>
  id === VIDEO_OWNER_HASH
    ? { hourly: LIMIT_HOURLY_OWNER, daily: LIMIT_DAILY_OWNER, owner: true }
    : { hourly: LIMIT_HOURLY, daily: LIMIT_DAILY, owner: false }

/* ------------------------------ usage store ------------------------------ */
const USAGE_FILE = path.join(VIDEO_DIR, '.usage.json')
let usageStore = { users: {} }
try {
  const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'))
  if (parsed && typeof parsed === 'object' && parsed.users && typeof parsed.users === 'object') {
    usageStore = parsed
  }
} catch {}
let usageFlushTimer = null
function usageFlush() {
  if (usageFlushTimer) return
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null
    try {
      fs.writeFileSync(USAGE_FILE, JSON.stringify(usageStore))
    } catch (err) {
      console.warn('[yuki] usage write failed', err instanceof Error ? err.message : err)
    }
  }, 2000)
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/* ------------------------------------------- Aion Labs (shared service) ---
 * The key is read ONLY from the server environment. It is never sent to the
 * app, logged, or included in a response. The app authenticates as a Yuki
 * user; this server is the only holder of the shared Aion credential.
 */
const AION_BASE = String(process.env.AIONLABS_BASE_URL || 'https://api.aionlabs.ai/v1').replace(/\/+$/, '')
const AION_KEY = String(process.env.AIONLABS_API_KEY || '').trim()
const AION_MODEL = String(process.env.AIONLABS_DEFAULT_MODEL || '').trim()
const AION_USER_HOURLY = intEnv('AION_LIMIT_USER_HOURLY', 30)
const AION_USER_DAILY = intEnv('AION_LIMIT_USER_DAILY', 200)
const AION_USER_DAILY_TOKENS = intEnv('AION_LIMIT_USER_DAILY_TOKENS', 120000)
const AION_GLOBAL_HOURLY = intEnv('AION_LIMIT_GLOBAL_HOURLY', 600)
const AION_GLOBAL_DAILY = intEnv('AION_LIMIT_GLOBAL_DAILY', 5000)
const AION_MAX_INPUT_CHARS = intEnv('AION_MAX_INPUT_CHARS', 12000)
const AION_MAX_MSG_CHARS = intEnv('AION_MAX_MSG_CHARS', 4000)
const AION_MAX_OUTPUT_TOKENS = Math.max(64, intEnv('AION_MAX_OUTPUT_TOKENS', 700))
const AION_MODELS_TTL = Math.max(30, intEnv('AION_MODELS_CACHE_SECONDS', 600)) * 1000
const AION_QUOTA_COOLDOWN = Math.max(30, intEnv('AION_QUOTA_COOLDOWN_SECONDS', 300)) * 1000
let aionModelsCache = { at: 0, ids: [] }
let aionQuotaUntil = 0

/* Offline installs cannot use Koolbase, but they still need an authenticated
 * identity for the shared Aion account. The server signs a short-lived,
 * low-limit guest session; the secret never leaves this process. Global Aion
 * caps still apply to every guest and cloud user alike.
 */
const AION_GUEST_SECRET = String(process.env.AION_GUEST_SECRET || randomBytes(32).toString('hex'))
const AION_GUEST_PREFIX = 'ygu1'
const AION_GUEST_TTL = Math.max(3600, intEnv('AION_GUEST_TTL_SECONDS', 7 * 24 * 3600)) * 1000
const AION_GUEST_ISSUE_HOURLY = intEnv('AION_GUEST_ISSUE_HOURLY', 12)
const AION_GUEST_HOURLY = intEnv('AION_LIMIT_GUEST_HOURLY', 6)
const AION_GUEST_DAILY = intEnv('AION_LIMIT_GUEST_DAILY', 30)
const AION_GUEST_DAILY_TOKENS = intEnv('AION_LIMIT_GUEST_DAILY_TOKENS', 18000)
const guestIssues = new Map()

function bearerToken(req) {
  const raw = req.headers.authorization
  if (typeof raw !== 'string') return ''
  const m = /^Bearer\s+(\S+)/i.exec(raw.trim())
  return m ? m[1] : ''
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  const raw = Array.isArray(xff) ? xff[0] : String(xff || req.socket?.remoteAddress || '')
  return userHash(String(raw).split(',')[0].trim())
}

function guestIssueAllowed(req) {
  const ip = clientIp(req)
  const now = Date.now()
  let entry = guestIssues.get(ip)
  if (!entry || now - entry.start >= HOUR_MS) {
    entry = { start: now, count: 0 }
    guestIssues.set(ip, entry)
    if (guestIssues.size > 5000) guestIssues.clear()
  }
  if (entry.count >= AION_GUEST_ISSUE_HOURLY) return false
  entry.count += 1
  return true
}

function issueGuestToken(req) {
  const payload = Buffer.from(JSON.stringify({
    s: randomBytes(12).toString('base64url'),
    e: Date.now() + AION_GUEST_TTL,
    i: clientIp(req),
  })).toString('base64url')
  const signed = `${AION_GUEST_PREFIX}.${payload}`
  const sig = createHmac('sha256', AION_GUEST_SECRET).update(signed).digest('base64url')
  return `${signed}.${sig}`
}

function verifyGuestToken(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3 || parts[0] !== AION_GUEST_PREFIX || !parts[1] || !parts[2]) return null
  const signed = `${parts[0]}.${parts[1]}`
  const expected = createHmac('sha256', AION_GUEST_SECRET).update(signed).digest('base64url')
  const got = Buffer.from(parts[2])
  const want = Buffer.from(expected)
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null
  try {
    const data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!/^[A-Za-z0-9_-]{12,}$/.test(String(data.s || ''))) return null
    if (!Number.isFinite(Number(data.e)) || Number(data.e) <= Date.now()) return null
    return { id: userHash(`guest:${data.s}`), guest: true }
  } catch {
    return null
  }
}

/** Cloud token or server-signed guest token — Aion accepts either. */
async function resolveAionUser(req) {
  const token = bearerToken(req)
  if (!token) return null
  if (token.startsWith(`${AION_GUEST_PREFIX}.`)) return verifyGuestToken(token)
  return resolveUser(req)
}

function aionLimits(user) {
  return user.guest
    ? { hourly: AION_GUEST_HOURLY, daily: AION_GUEST_DAILY, dailyTokens: AION_GUEST_DAILY_TOKENS }
    : { hourly: AION_USER_HOURLY, daily: AION_USER_DAILY, dailyTokens: AION_USER_DAILY_TOKENS }
}

/* ------------------------------------------- Eroq (built-in roleplay AI) ---
 * Same owner-paid shared-service model as Aion. The Eroq key is read only from
 * the server environment, never sent to a client or written to disk.
 */
const EROQ_BASE = String(process.env.EROQ_BASE_URL || 'https://eroq.ai/v1').replace(/\/+$/, '')
const EROQ_KEY = String(process.env.EROQ_API_KEY || '').trim()
const EROQ_ENABLED = process.env.EROQ_ENABLED !== '0' && process.env.EROQ_ENABLED !== 'false'
const EROQ_MODELS = Object.freeze({
  'eroq-rp-mini': { label: 'RP Mini', credits: 1, modes: ['messaging', 'scene'] },
  'eroq-rp-plus': { label: 'RP+', credits: 3, modes: ['messaging', 'scene', 'immersive'] },
})
const EROQ_DEFAULT_MODEL = Object.prototype.hasOwnProperty.call(EROQ_MODELS, process.env.EROQ_DEFAULT_MODEL || '')
  ? process.env.EROQ_DEFAULT_MODEL
  : 'eroq-rp-mini'
const EROQ_MODES = Object.freeze(['messaging', 'scene', 'immersive'])
const EROQ_GUEST_HOURLY = intEnv('EROQ_LIMIT_GUEST_HOURLY', 6)
const EROQ_GUEST_DAILY = intEnv('EROQ_LIMIT_GUEST_DAILY', 30)
const EROQ_USER_HOURLY = intEnv('EROQ_LIMIT_USER_HOURLY', 30)
const EROQ_USER_DAILY = intEnv('EROQ_LIMIT_USER_DAILY', 200)
const EROQ_GLOBAL_DAILY_CREDITS = intEnv('EROQ_GLOBAL_DAILY_CREDITS', 300)
const EROQ_MAX_INPUT_CHARS = intEnv('EROQ_MAX_INPUT_CHARS', 12000)
const EROQ_MAX_MSG_CHARS = intEnv('EROQ_MAX_MSG_CHARS', 4000)
const EROQ_MAX_TEXT_CHARS = intEnv('EROQ_MAX_TEXT_CHARS', 12000)
const EROQ_MAX_OUTPUT_TOKENS = Math.min(1200, Math.max(160, intEnv('EROQ_MAX_OUTPUT_TOKENS', 800)))
const EROQ_TIMEOUT_MS = Math.max(15_000, intEnv('EROQ_TIMEOUT_MS', 90_000))
const EROQ_MAX_CONCURRENT = Math.max(1, intEnv('EROQ_MAX_CONCURRENT', 4))
const EROQ_DUP_TTL = Math.max(10_000, intEnv('EROQ_DUP_TTL_SECONDS', 120) * 1000)
const EROQ_QUOTA_COOLDOWN = Math.max(30_000, intEnv('EROQ_QUOTA_COOLDOWN_SECONDS', 300) * 1000)
const EROQ_ACCOUNT_TTL = Math.max(15_000, intEnv('EROQ_ACCOUNT_CACHE_SECONDS', 60) * 1000)
let eroqQuotaUntil = 0
let eroqInFlight = 0
let eroqAccountCache = { at: 0, credits: null }
const eroqRecent = new Map()

function eroqHeaders() {
  return { Authorization: `Bearer ${EROQ_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' }
}

async function eroqAccount() {
  if (!EROQ_KEY) return { credits: null, error: 'not_configured' }
  if (eroqAccountCache.credits !== null && Date.now() - eroqAccountCache.at < EROQ_ACCOUNT_TTL) {
    return { credits: eroqAccountCache.credits, error: '' }
  }
  try {
    const r = await jsonFetch(`${EROQ_BASE}/account`, { headers: eroqHeaders() }, 15_000)
    if (r.status !== 200) return { credits: null, error: `account_http_${r.status}` }
    const credits = Number(r.data?.credits)
    if (!Number.isFinite(credits)) return { credits: null, error: 'account_bad_response' }
    eroqAccountCache = { at: Date.now(), credits }
    return { credits, error: '' }
  } catch {
    return { credits: null, error: 'account_unreachable' }
  }
}

function eroqLimits(user) {
  return user.guest
    ? { hourly: EROQ_GUEST_HOURLY, daily: EROQ_GUEST_DAILY }
    : { hourly: EROQ_USER_HOURLY, daily: EROQ_USER_DAILY }
}

function eroqUsage(userId) {
  const now = Date.now()
  const u = userUsage(userId)
  for (const [hourKey, dayKey] of [['eHourStart', 'eDayStart']]) {
    if (now - (u[hourKey] || 0) >= HOUR_MS) { u[hourKey] = now; u.eHourCount = 0 }
    if (now - (u[dayKey] || 0) >= DAY_MS) { u[dayKey] = now; u.eDayCount = 0; u.eDayCredits = 0 }
  }
  u.eHourCount = Math.max(0, Number(u.eHourCount) || 0)
  u.eDayCount = Math.max(0, Number(u.eDayCount) || 0)
  u.eDayCredits = Math.max(0, Number(u.eDayCredits) || 0)
  let g = usageStore.eroq
  if (!g || typeof g !== 'object') {
    g = { dayStart: now, dayCredits: 0, dayCount: 0 }
    usageStore.eroq = g
  }
  if (now - (g.dayStart || 0) >= DAY_MS) { g.dayStart = now; g.dayCredits = 0; g.dayCount = 0 }
  return { u, g }
}

function eroqLimitHit(u, g, limits, cost = 0) {
  return (
    u.eHourCount >= limits.hourly ||
    u.eDayCount >= limits.daily ||
    g.dayCredits + cost > EROQ_GLOBAL_DAILY_CREDITS
  )
}

function eroqMessage(status, code) {
  if (code === 'eroq_quota' || status === 402) return 'The shared Eroq balance is too low right now. Requests are paused — please try again later or use Offline AI.'
  if (code === 'eroq_timeout' || status === 504) return 'Eroq took too long to reply. Try again or switch to Offline AI.'
  if (status === 401 || status === 403) return 'The shared Eroq service is misconfigured. Please contact the app owner.'
  if (status === 429) return 'Eroq is rate-limiting requests right now. Try again in a moment.'
  if (status === 404) return 'The selected Eroq model is unavailable. Choose RP Mini or ask the app owner.'
  if (status === 400) return 'Eroq could not understand that request. Try a shorter message.'
  if (status === 413) return 'That message is too long for Eroq. Try a shorter message.'
  if (status >= 500) return 'Eroq is temporarily unavailable. Try again shortly or switch to Offline AI.'
  return 'Could not reach Eroq. Check your connection or switch to Offline AI.'
}

function eroqGuard(user, res) {
  if (!EROQ_ENABLED) {
    send(res, 503, { error: 'eroq_disabled', message: 'Eroq AI is turned off by the app owner.' })
    return false
  }
  if (!EROQ_KEY) {
    send(res, 503, { error: 'eroq_not_configured', message: 'Eroq AI is not configured by the app owner yet.' })
    return false
  }
  if (Date.now() < eroqQuotaUntil) {
    send(res, 503, { error: 'eroq_quota', message: eroqMessage(503, 'eroq_quota') })
    return false
  }
  return true
}

function eroqCleanState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out = {}
  for (const key of ['place', 'outfit', 'activity', 'emotion', 'relationship']) {
    const v = raw[key]
    if (typeof v === 'string' && v.trim()) out[key] = v.trim().slice(0, 200)
  }
  return Object.keys(out).length ? out : null
}

function eroqConversationKey(userId, conversationId) {
  return `${userId}:${conversationId}`
}

function eroqStoredState(userId, conversationId) {
  const store = usageStore.eroqStates || (usageStore.eroqStates = {})
  const value = store[eroqConversationKey(userId, conversationId)]
  return value && typeof value === 'object' ? value : null
}

function eroqRememberState(userId, conversationId, state) {
  const clean = eroqCleanState(state)
  if (!clean || !conversationId) return
  const store = usageStore.eroqStates || (usageStore.eroqStates = {})
  store[eroqConversationKey(userId, conversationId)] = clean
  usageFlush()
}

function eroqDuplicate(reqId, payload) {
  const now = Date.now()
  for (const [k, at] of eroqRecent) if (now - at > EROQ_DUP_TTL) eroqRecent.delete(k)
  const key = reqId || sha256hex(payload)
  if (eroqRecent.has(key)) return true
  eroqRecent.set(key, now)
  return false
}

function eroqValidate(body, user) {
  const blocked = ['apiKey', 'api_key', 'key', 'baseUrl', 'base_url', 'url', 'headers', 'token', 'authorization', 'user', 'private', 'stream']
    .find((k) => Object.prototype.hasOwnProperty.call(body || {}, k))
  if (blocked) return { error: 'eroq_bad_request', message: 'Request contains unsupported fields.' }

  const model = String(body?.model || EROQ_DEFAULT_MODEL)
  if (!Object.prototype.hasOwnProperty.call(EROQ_MODELS, model)) {
    return { error: 'eroq_invalid_model', message: 'Choose RP Mini or RP+.' }
  }
  const mode = String(body?.mode || 'messaging')
  if (!EROQ_MODES.includes(mode) || !EROQ_MODELS[model].modes.includes(mode)) {
    return { error: 'eroq_invalid_mode', message: 'That mode is not available for this model.' }
  }
  const conversationId = String(body?.conversationId || '').trim()
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(conversationId)) {
    return { error: 'eroq_bad_request', message: 'A valid conversation id is required.' }
  }
  const requestId = String(body?.requestId || '').trim()
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) {
    return { error: 'eroq_bad_request', message: 'A valid request id is required.' }
  }

  const context = typeof body?.context === 'string' ? body.context.trim().slice(0, 4000) : ''
  const raw = Array.isArray(body?.messages) ? body.messages.slice(-24) : []
  const messages = []
  let totalChars = context.length
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const role = String(m.role || '')
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue
    const content = typeof m.content === 'string' ? m.content.trim() : ''
    if (!content || content.length > EROQ_MAX_MSG_CHARS) continue
    totalChars += content.length
    messages.push({ role, content })
  }
  if (!messages.some((m) => m.role === 'user') || totalChars > EROQ_MAX_INPUT_CHARS) {
    return { error: 'eroq_bad_request', message: 'A short user message is required.' }
  }

  let state = null
  if (mode === 'immersive') {
    state = eroqCleanState(eroqStoredState(user.id, conversationId) || body?.state)
  }
  const temperatureRaw = Number(body?.temperature)
  const temperature = Number.isFinite(temperatureRaw) ? Math.min(1.5, Math.max(0, temperatureRaw)) : 0.85
  const maxTokens = mode === 'messaging' ? 160 : Math.min(800, EROQ_MAX_OUTPUT_TOKENS)

  const payload = {
    model,
    messages,
    context,
    mode,
    stream: false,
    private: true,
    user: user.id,
    temperature,
    max_tokens: maxTokens,
  }
  if (state) payload.state = state
  if (mode === 'messaging' && body?.reactions === true) payload.reactions = true
  if (mode === 'messaging' && body?.split === true) payload.split = true
  return { payload, model, mode, conversationId, requestId, state }
}

function eroqAcquire(user, res, requestId, payload, cost) {
  if (!eroqGuard(user, res)) return null
  const { u, g } = eroqUsage(user.id)
  if (eroqLimitHit(u, g, eroqLimits(user), cost)) {
    send(res, 429, { error: 'eroq_limit', message: 'Shared Eroq limit reached for now. Try again later or use Offline AI.' })
    return null
  }
  if (eroqInFlight >= EROQ_MAX_CONCURRENT) {
    send(res, 503, { error: 'eroq_busy', message: 'Eroq is busy right now. Try again in a moment.' })
    return null
  }
  if (eroqDuplicate(`${user.id}:${requestId}`, JSON.stringify(payload))) {
    send(res, 409, { error: 'eroq_duplicate', message: 'That message was already sent. Please do not send it twice.' })
    return null
  }
  eroqInFlight += 1
  let released = false
  return () => {
    if (released) return
    released = true
    eroqInFlight -= 1
  }
}

function eroqUpstreamFailure(status) {
  if (status === 402) {
    eroqQuotaUntil = Date.now() + EROQ_QUOTA_COOLDOWN
    return { status: 503, error: 'eroq_quota', message: eroqMessage(status) }
  }
  if (status === 429) {
    eroqQuotaUntil = Date.now() + EROQ_QUOTA_COOLDOWN
    return { status: 429, error: 'eroq_rate_limit', message: eroqMessage(status) }
  }
  if (status === 401 || status === 403) {
    eroqQuotaUntil = Date.now() + EROQ_QUOTA_COOLDOWN
    return { status: 503, error: 'eroq_auth', message: eroqMessage(status) }
  }
  if (status >= 500) return { status: 503, error: 'eroq_upstream', message: eroqMessage(status) }
  return { status: 502, error: `eroq_${status}`, message: eroqMessage(status) }
}

function eroqRecord(usage, user, g, model, mode, conversationId) {
  const { u } = eroqUsage(user.id)
  const spentRaw = Number(usage?.credits_spent)
  const spent = Number.isFinite(spentRaw) && spentRaw >= 0
    ? spentRaw
    : (EROQ_MODELS[model]?.credits || 1)
  u.eHourCount += 1
  u.eDayCount += 1
  u.eDayCredits += spent
  g.dayCredits += spent
  g.dayCount += 1
  const remainingRaw = Number(usage?.credits_remaining)
  if (Number.isFinite(remainingRaw) && remainingRaw >= 0) {
    eroqAccountCache = { at: Date.now(), credits: remainingRaw }
  }
  if (mode === 'immersive') eroqRememberState(user.id, conversationId, usage?.state)
  usageFlush()
  return { spent, remaining: Number.isFinite(remainingRaw) ? remainingRaw : null }
}

function eroqExtractMeta(chunk) {
  const usage = chunk?.usage && typeof chunk.usage === 'object' ? chunk.usage : null
  const message = chunk?.message || chunk?.choices?.[0]?.message || chunk?.choices?.[0]?.delta || null
  return {
    usage,
    state: message?.state || chunk?.state || null,
    reaction: message?.reaction ?? chunk?.reaction ?? null,
    parts: Array.isArray(message?.parts) ? message.parts : Array.isArray(chunk?.parts) ? chunk.parts : null,
  }
}

/** Model IDs come from Aion's catalog; we never assume a model is available. */
async function aionModelIds() {
  if (!AION_KEY) return { ids: [], error: 'not_configured' }
  if (aionModelsCache.ids.length && Date.now() - aionModelsCache.at < AION_MODELS_TTL) {
    return { ids: aionModelsCache.ids, error: '' }
  }
  try {
    const r = await jsonFetch(`${AION_BASE}/models`, { headers: aionHeaders() }, 15_000)
    if (r.status !== 200) return { ids: [], error: `catalog_http_${r.status}` }
    const list = Array.isArray(r.data?.data) ? r.data.data : Array.isArray(r.data?.models) ? r.data.models : []
    const ids = list
      .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
      .filter((x) => typeof x === 'string' && x.length > 0)
    aionModelsCache = { at: Date.now(), ids }
    return { ids, error: '' }
  } catch {
    return { ids: [], error: 'catalog_unreachable' }
  }
}

function aionUsage(userId) {
  const now = Date.now()
  const u = userUsage(userId)
  if (now - (u.aHourStart || 0) >= HOUR_MS) { u.aHourStart = now; u.aHourCount = 0 }
  if (now - (u.aDayStart || 0) >= DAY_MS) { u.aDayStart = now; u.aDayCount = 0; u.aDayTokens = 0 }
  u.aHourCount = Math.max(0, Number(u.aHourCount) || 0)
  u.aDayCount = Math.max(0, Number(u.aDayCount) || 0)
  u.aDayTokens = Math.max(0, Number(u.aDayTokens) || 0)
  let g = usageStore.aion
  if (!g || typeof g !== 'object') {
    g = { hourStart: now, hourCount: 0, dayStart: now, dayCount: 0 }
    usageStore.aion = g
  }
  if (now - (g.hourStart || 0) >= HOUR_MS) { g.hourStart = now; g.hourCount = 0 }
  if (now - (g.dayStart || 0) >= DAY_MS) { g.dayStart = now; g.dayCount = 0 }
  return { u, g }
}

function aionLimitHit(u, g, limits) {
  return (
    u.aHourCount >= limits.hourly ||
    u.aDayCount >= limits.daily ||
    u.aDayTokens >= limits.dailyTokens ||
    g.hourCount >= AION_GLOBAL_HOURLY ||
    g.dayCount >= AION_GLOBAL_DAILY
  )
}

function aionMessage(status, code) {
  if (code === 'aion_quota' || status === 402 || status === 429) {
    return 'The shared Aion account has hit a quota or billing limit. Requests are paused — please try again later or use Offline AI.'
  }
  if (status === 401 || status === 403) return 'The shared Aion service is misconfigured. Please contact the app owner.'
  if (status === 404) return 'The configured Aion model is unavailable. Please contact the app owner.'
  if (status === 400) return 'Aion could not understand that request. Try a shorter message.'
  if (status === 413) return 'That message is too long for Aion. Try a shorter message.'
  if (status >= 500) return 'Aion is temporarily unavailable. Try again shortly or switch to Offline AI.'
  return 'Could not reach Aion. Check your connection or switch to Offline AI.'
}

function userUsage(userId) {
  const now = Date.now()
  let u = usageStore.users[userId]
  if (!u || typeof u !== 'object') {
    u = { hourStart: now, hourCount: 0, dayStart: now, dayCount: 0, totalClips: 0, spentUsd: 0 }
    usageStore.users[userId] = u
  }
  if (now - (u.hourStart || 0) >= HOUR_MS) {
    u.hourStart = now
    u.hourCount = 0
  }
  if (now - (u.dayStart || 0) >= DAY_MS) {
    u.dayStart = now
    u.dayCount = 0
  }
  u.totalClips = Math.max(0, Number(u.totalClips) || 0)
  u.spentUsd = Math.max(0, Number(u.spentUsd) || 0)
  /* couple photos ride the same clock */
  if (now - (u.cHourStart || 0) >= HOUR_MS) {
    u.cHourStart = now
    u.cHourCount = 0
  }
  if (now - (u.cDayStart || 0) >= DAY_MS) {
    u.cDayStart = now
    u.cDayCount = 0
  }
  u.cHourCount = Math.max(0, Number(u.cHourCount) || 0)
  u.cDayCount = Math.max(0, Number(u.cDayCount) || 0)
  u.cTotal = Math.max(0, Number(u.cTotal) || 0)
  return u
}

function usagePayload(u, limit) {
  return {
    hourUsed: u.hourCount,
    dayUsed: u.dayCount,
    totalClips: u.totalClips,
    spentUsd: Math.round(u.spentUsd * 100) / 100,
    hourlyLimit: limit.hourly,
    dailyLimit: limit.daily,
    coupleHourUsed: u.cHourCount,
    coupleDayUsed: u.cDayCount,
    coupleTotal: u.cTotal,
    coupleHourlyLimit: COUPLE_LIMIT_HOURLY,
    coupleDailyLimit: COUPLE_LIMIT_DAILY,
  }
}

/* ------------------------------ job owners ---------------------------------
 * The person who started a job is the only one who may poll its status.
 * Bindings are persisted so a server restart doesn't strand in-flight jobs.
 */
const JOBS_FILE = path.join(VIDEO_DIR, '.jobs.json')
let jobOwners = {}
try {
  const parsed = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'))
  if (parsed && typeof parsed === 'object') jobOwners = parsed
} catch {}
let jobsFlushTimer = null
function jobsFlush() {
  if (jobsFlushTimer) return
  jobsFlushTimer = setTimeout(() => {
    jobsFlushTimer = null
    try {
      fs.writeFileSync(JOBS_FILE, JSON.stringify(jobOwners))
    } catch {}
  }, 1000)
}
function jobOwn(videoId, userId, clipId) {
  jobOwners[String(videoId)] = { user: userId, clipId: clipId || null, at: Date.now() }
  jobsFlush()
}
function jobOwnedBy(videoId, userId) {
  const e = jobOwners[String(videoId)]
  return e && e.user === userId ? e : null
}
function jobDone(videoId) {
  if (jobOwners[String(videoId)]) {
    delete jobOwners[String(videoId)]
    jobsFlush()
  }
}

/* ------------------------------ user auth -------------------------------- */
/** Resolves the Koolbase (cloud) account. Returns { id, email } or null. */
async function resolveUser(req) {
  if (YUKI_DEV_NO_AUTH) return { id: userHash('dev'), dev: true }
  const bearer = req.headers.authorization
  if (!bearer || !/^Bearer\s+\S+/i.test(bearer)) return null
  if (!KB_KEY) return null
  try {
    const r = await jsonFetch(`${KB_BASE}/v1/sdk/auth/me`, {
      headers: { 'x-api-key': KB_KEY, 'Content-Type': 'application/json', Authorization: bearer },
    })
    if (r.status !== 200) return null
    const email = String(
      (r.data && (r.data.email || (r.data.user && r.data.user.email))) || '',
    ).trim().toLowerCase()
    if (!email) return null
    return { id: userHash(email), email }
  } catch (err) {
    console.warn('[yuki] auth check failed', err instanceof Error ? err.message : err)
    return null
  }
}

const userClipDir = (id) => path.join(VIDEO_DIR, `u_${id}`)
const clipFile = (id, clipId) => path.join(userClipDir(id), `${clipId}.mp4`)

let legacyMigrationDone = false
function migrateLegacyClips(userId) {
  if (legacyMigrationDone) return
  legacyMigrationDone = true
  /* One-time move of root-level legacy clips into the owner's folder. */
  if (userId !== VIDEO_OWNER_HASH && !YUKI_DEV_NO_AUTH) return
  try {
    const marker = path.join(VIDEO_DIR, '.migrated')
    if (fs.existsSync(marker)) return
    const target = userClipDir(userId)
    fs.mkdirSync(target, { recursive: true })
    for (const name of fs.readdirSync(VIDEO_DIR)) {
      if (!/^[A-Za-z0-9_-]{1,64}\.mp4$/.test(name)) continue
      try {
        fs.renameSync(path.join(VIDEO_DIR, name), path.join(target, name))
      } catch {}
    }
    fs.writeFileSync(marker, 'migrated')
    console.log('[yuki] legacy clips migrated into user folder')
  } catch (err) {
    console.warn('[yuki] legacy migration', err instanceof Error ? err.message : err)
  }
}

/** Resolves the user or replies 401. Never exposes why beyond a code. */
async function requireUser(req, res) {
  const user = await resolveUser(req)
  if (!user) {
    send(res, 401, {
      error: 'signin_required',
      message: 'Sign in with a cloud account to generate video. Offline accounts cannot generate videos.',
    })
    return null
  }
  migrateLegacyClips(user.id)
  return user
}

const downloadClipJob = (file, url) => downloadClip(file, url)

/* -------------------- image provider: pollinations edit ------------------ */
async function pollinationsGenerate(selfie, yukiPng, prompt, overrides = {}) {
  const base = String(overrides.base || COUPLE_BASE).replace(/\/+$/, '')
  const model = String(overrides.model || COUPLE_MODEL)
  const key = String(overrides.key || COUPLE_KEY)
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', prompt)
  form.append('size', '1024x1024')
  form.append('quality', 'medium')
  if (overrides.provider !== 'openai') form.append('response_format', 'b64_json')
  form.append('image[]', new Blob([selfie], { type: 'image/png' }), 'selfie.png')
  form.append('image[]', new Blob([yukiPng], { type: 'image/png' }), 'yuki.png')
  const res = await fetch(`${base}/v1/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const msg =
      (data && (data.error?.message || data.message || (typeof data.error === 'string' ? data.error : null))) ||
      text.slice(0, 300) ||
      `provider_${res.status}`
    throw new Error(String(msg))
  }
  const images =
    (data && Array.isArray(data.images) && data.images) ||
    (data && Array.isArray(data.data) && data.data) ||
    []
  const first = images[0] || {}
  const b64 = first.b64_json || first.base64 || null
  if (b64) return Buffer.from(String(b64), 'base64')
  if (first.url) {
    const r = await fetch(String(first.url))
    if (r.ok) return Buffer.from(await r.arrayBuffer())
  }
  throw new Error('provider returned no image data')
}

function keyReady(entry, now = Date.now()) {
  return !entry.dead && entry.cooldownUntil <= now
}

/**
 * Keys to try for one request. Dead/cooling keys are skipped.
 *
 * rotate = true (Nomi): keys take turns — key1, key2, key1, … — so each key
 * carries part of the load. rotate = false (Fish): stick with the first
 * working key and only fail over when it runs out.
 */
/** Reads a caller-supplied provider key for this request. Never logged. */
function apiKeyFor(req, provider) {
  try {
    const p = String((req.headers && req.headers['x-yuki-provider']) || '').toLowerCase().trim()
    const k = String((req.headers && req.headers['x-yuki-key']) || '').trim()
    if (p !== provider) return null
    if (k.length < 6 || k.length > 400) return null
    if (/\s/.test(k)) return null
    return k
  } catch {
    return null
  }
}

/** Removes any occurrence of the key from a message before it reaches the client. */
function sanitizeProviderMessage(message, key) {
  const text = String(message == null ? '' : message)
  if (!key) return text.slice(0, 500)
  return text.split(key).join('•••').slice(0, 500)
}

/** Recursively masks the key in any JSON-able provider payload. */
function sanitizeDeep(value, key) {
  if (!key) return value
  if (value == null) return value
  if (typeof value === 'string') return value.split(key).join('•••')
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, key))
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v, key)
    return out
  }
  return value
}

function keyPool(ring, rotate = false) {
  const now = Date.now()
  let usable = ring.filter((k) => keyReady(k, now))
  if (!usable.length) {
    usable = [...ring]
      .filter((k) => !k.dead)
      .sort((a, b) => a.cooldownUntil - b.cooldownUntil)
      .slice(0, 1)
  }
  if (!usable.length) return usable
  if (!rotate || !ring.length) return usable

  const start = ring.cursor || 0
  const ordered = []
  for (let i = 0; i < ring.length; i++) {
    const k = ring[(start + i) % ring.length]
    if (usable.includes(k)) ordered.push(k)
  }
  ring.cursor = (start + 1) % ring.length
  return ordered
}

function markKeyResult(entry, status, service) {
  if (status === 401 || status === 402 || status === 403) {
    entry.dead = true
    console.warn(`[yuki] ${service} ${entry.label} rejected (${status}); trying the next key`)
    return true
  }
  if (status === 429) {
    entry.cooldownUntil = Date.now() + 60_000
    console.warn(`[yuki] ${service} ${entry.label} rate-limited; trying the next key`)
    return true
  }
  return false
}

function sendAudio(res, buf) {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Content-Length': buf.length,
    'Cache-Control': 'private, max-age=86400',
  })
  res.end(buf)
}

/* ---------------------------------------------------------------- types */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body_too_large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('bad_json'))
      }
    })
    req.on('error', reject)
  })
}

async function jsonFetch(url, opts = {}, timeoutMs = 60_000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal })
    const text = await r.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = { raw: text }
    }
    return { status: r.status, data }
  } finally {
    clearTimeout(t)
  }
}

/* ------------------------------------------------------------------ api */
async function api(req, res, url) {
  const route = url.pathname

  if (route === '/api/health') {
    return send(res, 200, {
      ok: true,
      nomi: NOMI_KEYS.some((k) => keyReady(k)),
      nomiKeys: NOMI_KEYS.length,
      nomiKeysAlive: NOMI_KEYS.filter((k) => keyReady(k)).length,
      koolbase: Boolean(KB_KEY),
      tts: FISH_KEYS.some((k) => keyReady(k)),
      ttsKeys: FISH_KEYS.length,
      ttsKeysAlive: FISH_KEYS.filter((k) => keyReady(k)).length,
      video: MAGIC_HOUR_KEYS.length > 0,
      videoProvider: 'magichour',
      videoModel: MAGIC_HOUR_MODEL,
      time: new Date().toISOString(),
    })
  }

  /* ---- video mode ---- */
  if (route === '/api/video/config' && req.method === 'GET') {
    const user = await requireUser(req, res)
    if (!user) return
    const limit = limitsFor(user.id)
    const u = userUsage(user.id)
    const byok = apiKeyFor(req, 'magic-hour')
    return send(res, 200, {
      configured: byok ? true : MAGIC_HOUR_KEYS.length > 0,
      provider: 'magichour',
      providerLabel: byok ? 'Your Magic Hour key' : VIDEO_PROVIDER_LABEL,
      model: MAGIC_HOUR_MODEL,
      aspectRatio: VIDEO_ASPECT,
      resolutions: ['540p', '720p', '1080p'],
      prices: VIDEO_PRICES,
      creditsPerUsd: 0,
      maxSeconds: 10,
      lipSync: false,
      reference: 'fusion',
      limits: usagePayload(u, limit),
      isOwner: limit.owner,
      notes: [
        'Free Magic Hour renders are watermarked and personal-use only; upgrade your plan for watermark-free clips.',
        'Free plan renders at 480p regardless of the quality selected.',
        'Each clip uses about 24 Magic Hour free credits per second at 480p.',
        'Daily and hourly limits apply for fair use.',
      ],
    })
  }

  if (route === '/api/video/credits' && req.method === 'GET') {
    const user = await requireUser(req, res)
    if (!user) return
    const byok = apiKeyFor(req, 'magic-hour')
    if (byok) {
      try {
        const r = await fetch(MAGIC_HOUR_BASE + '/v1/account', {
          headers: { 'Authorization': `Bearer ${byok}`, 'Content-Type': 'application/json' },
        })
        const text = await r.text()
        let data = null
        try { data = JSON.parse(text) } catch {}
        if (!r.ok) {
          return send(res, r.status, {
            configured: false,
            provider: 'magichour',
            providerLabel: 'Your Magic Hour key was rejected',
            message: sanitizeProviderMessage(data && (data.message || (typeof data.error === 'string' ? data.error : null)) || `Provider error ${r.status}`, byok),
            balances: [],
            keys: 1,
          })
        }
        const credits = data && data.credits != null ? Number(data.credits) || 0 : null
        const tier = data && data.tier ? String(data.tier) : null
        return send(res, 200, {
          configured: true,
          provider: 'magichour',
          providerLabel: 'Your Magic Hour key',
          balance: null,
          credits,
          tier,
          balances: [{ label: 'your key', credits, tier }],
          usage: usagePayload(userUsage(user.id), limitsFor(user.id)),
          hourlyLimit: 999,
          dailyLimit: 999,
          keys: 1,
        })
      } catch {
        return send(res, 502, { configured: false, provider: 'magichour', providerLabel: 'Your Magic Hour key unreachable', balances: [], keys: 1 })
      }
    }
    const limit = limitsFor(user.id)
    const u = userUsage(user.id)
    const payload = {
      configured: true,
      provider: 'magichour',
      providerLabel: VIDEO_PROVIDER_LABEL,
      balance: null,
      credits: null,
      usage: usagePayload(u, limit),
      isOwner: limit.owner,
      checkedAt: Date.now(),
    }
    if (limit.owner) {
      const m = await magichourCredits()
      payload.credits = m.credits
      payload.tier = m.tier
      payload.balances = m.balances
      payload.keys = m.keys
      if (m.error) payload.message = m.error
    }
    return send(res, 200, payload)
  }

  if (route === '/api/video/usage' && req.method === 'GET') {
    const user = await requireUser(req, res)
    if (!user) return
    const limit = limitsFor(user.id)
    const u = userUsage(user.id)
    return send(res, 200, { usage: usagePayload(u, limit), isOwner: limit.owner, checkedAt: Date.now() })
  }

  /* Fresh, file-scoped signed URL for a saved clip (used by the app to re-sign). */
  if (route.startsWith('/api/video/clip/') && req.method === 'GET' && route.endsWith('/url')) {
    const user = await requireUser(req, res)
    if (!user) return
    const clipId = safeClipId(route.slice('/api/video/clip/'.length, -'/url'.length))
    if (!clipId) return send(res, 400, { error: 'bad_clip_id' })
    if (!fs.existsSync(clipFile(user.id, clipId))) return send(res, 404, { error: 'clip_not_found' })
    return send(res, 200, { url: clipUrl(user.id, clipId), clipId })
  }

  /* Saves a locally rendered (offline animation) MP4 into the caller's clip
     folder. No provider is involved, so this works with internet off. */
  if (route === '/api/video/save-clip' && req.method === 'POST') {
    const user = await requireUser(req, res)
    if (!user) return
    let body
    try {
      body = await readBody(req, 40_000_000)
    } catch {
      return send(res, 413, { error: 'clip_too_large' })
    }
    const clipId = safeClipId(body.clipId)
    if (!clipId) return send(res, 400, { error: 'bad_clip_id' })
    const b64 = String(body.dataBase64 || '')
    let bytes = null
    try {
      bytes = Buffer.from(b64, 'base64')
    } catch {
      bytes = null
    }
    if (!bytes || bytes.length < 8 || bytes.length > 30 * 1024 * 1024) {
      return send(res, 413, { error: 'clip_too_large' })
    }
    try {
      fs.mkdirSync(userClipDir(user.id), { recursive: true })
      const dst = clipFile(user.id, clipId)
      const tmp = dst + '.tmp-' + process.pid
      fs.writeFileSync(tmp, bytes)
      fs.renameSync(tmp, dst)
      const sha = createHash('sha256').update(bytes).digest('hex')
      return send(res, 200, { ok: true, clipId, url: clipUrl(user.id, clipId), bytes: bytes.length, sha256: sha })
    } catch (err) {
      console.error('[yuki] save-clip failed', err instanceof Error ? err.message : err)
      return send(res, 500, { error: 'save_failed' })
    }
  }

  if (route === '/api/video/start' && req.method === 'POST') {
    const user = await requireUser(req, res)
    if (!user) return
    const byok = apiKeyFor(req, 'magic-hour')
    const limit = byok ? { hourly: 9999, daily: 9999, owner: true } : limitsFor(user.id)
    const u = userUsage(user.id)
    if (!byok && u.hourCount >= limit.hourly) {
      return send(res, 429, {
        error: 'limit_reached',
        message: `Hourly limit reached (${u.hourCount}/${limit.hourly}). Try again in a little while.`,
        retryAt: u.hourStart + HOUR_MS,
      })
    }
    if (!byok && u.dayCount >= limit.daily) {
      return send(res, 429, {
        error: 'limit_reached',
        message: `Daily limit reached (${u.dayCount}/${limit.daily}). Try again tomorrow.`,
        retryAt: u.dayStart + DAY_MS,
      })
    }
    const body = await readBody(req, 200_000)
    const promptRaw = String(body.prompt || '').trim().slice(0, 5000)
    if (promptRaw.length < 10) {
      return send(res, 400, { error: 'prompt_required', message: 'The scene prompt is too short.' })
    }
    const resolution = Object.prototype.hasOwnProperty.call(VIDEO_PRICES, body.resolution)
      ? body.resolution
      : '720p'
    const seconds = clampSeconds(body.seconds)
    const aspectRatio = ['9:16', '16:9', '1:1', '3:4', '4:3', '2:3', '3:2', '21:9'].includes(body.aspectRatio)
      ? body.aspectRatio
      : VIDEO_ASPECT
    const clipId =
      safeClipId(body.clipId) || `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`

    /* Magic Hour accepts any prompt text; neutralise stray @-tokens anyway. */
    const safePrompt = promptRaw.replace(/@(?!yuki\b)[A-Za-z0-9_]+/g, (m) => m.slice(1))
    const prompt =
      `${safePrompt}\n\nCharacter reference: @yuki is the character in the reference image — keep her identical.`.replace(/@yuki/g, '@yuki ').replace(/@yuki  +/g, '@yuki ')

    {
      if (MAGIC_HOUR_KEYS.length === 0 && !byok) {
        return send(res, 503, {
          error: 'video_not_configured',
          message: 'Set MAGIC_HOUR_API_KEY in .env, or connect your own Magic Hour key in Settings → My API keys.',
        })
      }
      const estimateCredits = MAGIC_HOUR_CRS * seconds
      try {
        const ref = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'emotions', 'neutral.png'))
        if (!ref) throw new Error('reference_asset_missing')
        const videoId = await magichourGenerate({ prompt, seconds }, ref, byok)
        if (!byok) {
          u.hourCount += 1
          u.dayCount += 1
          u.totalClips += 1
          usageFlush()
        }
        jobOwn(videoId, user.id, clipId)
        console.log(`[yuki] video ${clipId} → magichour ${videoId} (user ${user.id}, ${seconds}s @${MAGIC_HOUR_RES}, ~${estimateCredits} credits)`)
        return send(res, 200, {
          clipId,
          operation: { videoId, provider: 'magichour' },
          prompt,
          resolution: MAGIC_HOUR_RES,
          seconds,
          aspectRatio,
          estimateCredits,
          estimateUsd: null,
          balance: null,
          usage: usagePayload(u, limit),
        })
      } catch (err) {
        console.error('[yuki] magichour generate', err instanceof Error ? err.message : err)
        return send(res, 502, {
          error: 'magichour_error',
          message: 'Magic Hour could not start the clip. Check your MAGIC_HOUR_API_KEY and that you still have free credits.',
        })
      }
    }
  }

  if (route === '/api/video/status' && req.method === 'POST') {
    const user = await requireUser(req, res)
    if (!user) return
    const byok = apiKeyFor(req, 'magic-hour')
    const body = await readBody(req, 200_000)
    const clipId = safeClipId(body.clipId)
    const op = body.operation && typeof body.operation === 'object' ? body.operation : {}
    const provider = typeof op.provider === 'string' ? op.provider : 'magichour'
    const rawId = op.videoId ?? op.video_id
    const videoId = typeof rawId === 'string' ? rawId : Number.isFinite(Number(rawId)) ? String(rawId) : ''
    if (!clipId || !/^[0-9A-Za-z._-]{1,64}$/.test(videoId)) {
      return send(res, 400, { error: 'bad_request', message: 'Provide clipId and operation.videoId.' })
    }
    const owned = jobOwnedBy(videoId, user.id)
    if (!owned) {
      return send(res, 403, { error: 'not_your_job', message: 'That generation job does not belong to you.' })
    }

    if (provider === 'magichour') {
      const r = await magichourPoll(videoId, byok)
      if (r.status === 'error') {
        jobDone(videoId)
        return send(res, 200, { status: 'error', error: r.error })
      }
      if (r.status !== 'completed') return send(res, 200, { status: 'pending' })
      if (!r.url) {
        jobDone(videoId)
        return send(res, 200, { status: 'error', error: 'The download URL was missing.' })
      }
      const file = clipFile(user.id, clipId)
      try {
        fs.mkdirSync(userClipDir(user.id), { recursive: true })
        if (!fs.existsSync(file)) {
          let p = clipDownloads.get(clipId)
          if (!p) {
            p = downloadClip(file, r.url)
            clipDownloads.set(clipId, p)
          }
          try {
            await p
          } finally {
            if (clipDownloads.get(clipId) === p) clipDownloads.delete(clipId)
          }
        }
      } catch (err) {
        console.error('[yuki] magichour clip download', err instanceof Error ? err.message : err)
        return send(res, 200, {
          status: 'error',
          error: 'The clip finished but could not be downloaded.',
        })
      }
      jobDone(videoId)
      return send(res, 200, {
        status: 'completed',
        clipId,
        url: clipUrl(user.id, clipId),
        bytes: fs.statSync(file).size,
        mediaType: 'video/mp4',
        creditsCharged: r.creditsCharged,
      })
    }
    return send(res, 200, { status: 'pending' })
  }

  if (route.startsWith('/api/video/clip/') && req.method === 'DELETE') {
    const user = await requireUser(req, res)
    if (!user) return
    const clipId = safeClipId(route.slice('/api/video/clip/'.length))
    if (!clipId) return send(res, 400, { error: 'bad_clip_id' })
    try {
      fs.unlinkSync(clipFile(user.id, clipId))
    } catch {}
    return send(res, 200, { deleted: true })
  }

  /* ---- couple photos ---- */
  if (route === '/api/couple/config' && req.method === 'GET') {
    const user = await requireUser(req, res)
    if (!user) return
    const u = userUsage(user.id)
    return send(res, 200, {
      configured: Boolean(apiKeyFor(req, 'pollinations') || apiKeyFor(req, 'openai') || COUPLE_KEY),
      provider: apiKeyFor(req, 'openai') ? 'openai' : apiKeyFor(req, 'pollinations') ? 'pollinations' : 'pollinations',
      providerLabel: 'Pollinations AI — ' + COUPLE_MODEL,
      model: COUPLE_MODEL,
      limits: {
        hourUsed: u.cHourCount,
        dayUsed: u.cDayCount,
        total: u.cTotal,
        hourlyLimit: COUPLE_LIMIT_HOURLY,
        dailyLimit: COUPLE_LIMIT_DAILY,
      },
      notes: [
        'Your selfie is used only for the single generation you confirm — it is never stored by the app.',
        'The image is drawn by Pollinations AI with your own key; the app never promises free images.',
        'Daily and hourly limits apply for fair use.',
      ],
    })
  }

  if (route === '/api/couple/generate' && req.method === 'POST') {
    const user = await requireUser(req, res)
    if (!user) return
    if (!COUPLE_KEY) {
      return send(res, 503, {
        error: 'couple_not_configured',
        message: 'Set POLLINATIONS_API_KEY in .env, or use the offline build.',
      })
    }
    const u = userUsage(user.id)
    const byokCouple = apiKeyFor(req, 'pollinations') || apiKeyFor(req, 'openai')
    if (!byokCouple && u.cHourCount >= COUPLE_LIMIT_HOURLY) {
      return send(res, 429, {
        error: 'limit_reached',
        message: `Hourly couple-photo limit reached (${u.cHourCount}/${COUPLE_LIMIT_HOURLY}). Try again a little later.`,
      })
    }
    if (!byokCouple && u.cDayCount >= COUPLE_LIMIT_DAILY) {
      return send(res, 429, {
        error: 'limit_reached',
        message: `Daily couple-photo limit reached (${u.cDayCount}/${COUPLE_LIMIT_DAILY}). Try again tomorrow.`,
      })
    }

    const body = await readBody(req, 8_000_000)
    const pose = String(body.poseId || body.pose || '')
    const location = String(body.locationId || body.location || '')
    if (!Object.prototype.hasOwnProperty.call(COUPLE_POSES, pose)) {
      return send(res, 400, { error: 'bad_pose', message: 'Unknown pose.' })
    }
    if (!Object.prototype.hasOwnProperty.call(COUPLE_LOCATIONS, location)) {
      return send(res, 400, { error: 'bad_location', message: 'Unknown location.' })
    }
    const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(
      String(body.selfieDataUrl || body.selfie || ''),
    )
    if (!m) return send(res, 400, { error: 'bad_selfie', message: 'Provide the selfie as a base64 data URL.' })
    const selfie = Buffer.from(m[2], 'base64')
    if (selfie.length > 4 * 1024 * 1024) {
      return send(res, 400, { error: 'selfie_too_large', message: 'Selfie must be under 4 MB.' })
    }

    let yuki = null
    try {
      yuki = fs.readFileSync(path.join(ROOT, 'public', 'assets', 'emotions', 'neutral.png'))
    } catch {
      /* reference missing */
    }
    if (!yuki) {
      return send(res, 500, { error: 'reference_missing', message: 'The character reference image is missing.' })
    }

    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : ''
    let png
    try {
      const ownPollinations = apiKeyFor(req, 'pollinations')
      const ownOpenai = apiKeyFor(req, 'openai')
      if (ownOpenai) {
        png = await pollinationsGenerate(selfie, yuki, couplePrompt(pose, location, note), {
          provider: 'openai',
          key: ownOpenai,
          base: String(req.headers['x-yuki-base-url'] || 'https://api.openai.com'),
          model: String(req.headers['x-yuki-model'] || 'gpt-image-1'),
        })
      } else if (ownPollinations) {
        png = await pollinationsGenerate(selfie, yuki, couplePrompt(pose, location, note), {
          provider: 'pollinations',
          key: ownPollinations,
          base: String(req.headers['x-yuki-base-url'] || COUPLE_BASE),
          model: String(req.headers['x-yuki-model'] || COUPLE_MODEL),
        })
      } else {
        png = await pollinationsGenerate(selfie, yuki, couplePrompt(pose, location, note))
      }
    } catch (err) {
      console.error('[yuki] couple generate', err instanceof Error ? err.message : err)
      return send(res, 502, {
        error: 'provider_error',
        message: 'The image provider could not draw the couple photo. Please try again.',
      })
    }

    if (!byokCouple) {
      u.cHourCount += 1
      u.cDayCount += 1
      u.cTotal += 1
      usageFlush()
    }
    console.log(`[yuki] couple photo → ${pose} / ${location} (user ${user.id})`)
    return send(res, 200, {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      model: COUPLE_MODEL,
      pose,
      location,
      ts: Date.now(),
    })
  }

  /* ---- Nomi chat (keys taken in turns) ---- */
  if (route.startsWith('/api/nomi')) {
    if (!NOMI_KEYS.length) {
      return send(res, 503, {
        error: 'nomi_not_configured',
        message: 'Set NOMI_API_KEY (and NOMI_API_KEY_2, …) in .env, or use the offline engine.',
      })
    }
    const headers = (key) => ({ Authorization: key, 'Content-Type': 'application/json' })
    const listNomis = (key) => jsonFetch(`${NOMI_BASE}/v1/nomis`, { headers: headers(key) })

    if (route === '/api/nomi/nomis' && req.method === 'GET') {
      let last = { status: 502, data: { error: 'nomi_failed' } }
      for (const entry of keyPool(NOMI_KEYS, true)) {
        const r = await listNomis(entry.key)
        if (r.status === 200) {
          console.log(`[yuki] nomi ${entry.label} → list`)
          return send(res, 200, r.data)
        }
        last = r
        if (!markKeyResult(entry, r.status, 'nomi')) {
          console.error('[yuki] nomi list', entry.label, r.status)
        }
      }
      return send(res, last.status, last.data)
    }

    if (route === '/api/nomi/chat' && req.method === 'POST') {
      const body = await readBody(req)
      const message = String(body.messageText || '').trim().slice(0, 4000)
      if (!message) return send(res, 400, { error: 'message_required' })
      const wanted = String(body.nomisId || '')
      const payload = JSON.stringify({ messageText: message })
      const byokNomi = apiKeyFor(req, 'nomi')

      let last = { status: 502, data: { error: 'nomi_failed' } }
      const ring = byokNomi
        ? [{ key: byokNomi, label: 'your key', dead: false, cooldownUntil: 0 }]
        : keyPool(NOMI_KEYS, true)
      for (const entry of ring) {
        try {
          let id = wanted
          if (!id) {
            const list = await listNomis(byokNomi || entry.key)
            if (list.status !== 200) {
              last = list
              markKeyResult(entry, list.status, 'nomi')
              continue
            }
            id = String(list.data?.nomis?.[0]?.uuid || '')
            if (!id) {
              last = { status: 400, data: { error: 'no_nomi' } }
              continue
            }
          }

          const post = () =>
            jsonFetch(`${NOMI_BASE}/v1/nomis/${encodeURIComponent(id)}/chat`, {
              method: 'POST',
              headers: headers(entry.key),
              body: payload,
            })

          let r = await post()
          /* The stored id may belong to a different key's account: re-resolve. */
          if ([401, 402, 403, 404, 429].includes(r.status)) {
            const list = await listNomis(entry.key)
            if (list.status === 200) {
              const alt = String(list.data?.nomis?.[0]?.uuid || '')
              if (alt && alt !== id) {
                id = alt
                r = await post()
              }
            }
          }

          if (r.status === 200 || r.status === 201) {
            const reply = r.data?.replyMessage || {}
            const text = String(reply.text ?? reply.messageText ?? '').trim()
            if (text) {
              console.log(`[yuki] nomi ${entry.label} → reply (${text.length} chars)`)
              return send(res, 200, { nomisId: id, text })
            }
            last = { status: 502, data: { error: 'empty_reply' } }
            continue
          }
          last = r
          if (!markKeyResult(entry, r.status, 'nomi')) {
            console.error('[yuki] nomi chat', entry.label, r.status)
          }
        } catch (err) {
          console.error('[yuki] nomi', entry.label, err instanceof Error ? err.message : err)
          continue
        }
      }
      return send(res, last.status, byokNomi ? sanitizeDeep(last.data, byokNomi) : last.data)
    }
    return send(res, 404, { error: 'not_found' })
  }

  /* ---- bring-your-own-key chat (OpenAI-compatible / Anthropic / Gemini / Nomi) ---- */
  if (route === '/api/byok/chat' && req.method === 'POST') {
    const body = await readBody(req, 600_000)
    const provider = String(body.provider || '').toLowerCase().slice(0, 40)
    const apiKey = String(body.apiKey || '').trim()
    const model = String(body.model || '').trim().slice(0, 160)
    const baseUrl = String(body.baseUrl || '').trim().slice(0, 400)
    const nomisId = String(body.nomisId || '').trim()
    const messages = Array.isArray(body.messages)
      ? body.messages
          .slice(-24)
          .map((m) => ({ role: String(m.role || 'user'), content: String(m.content || '').slice(0, 8000) }))
          .filter((m) => m.content)
      : []
    if (!provider || !apiKey || !messages.length) {
      return send(res, 400, { error: 'missing_params', message: 'Provider, API key and a message are required.' })
    }

    const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n').slice(0, 8000)
    const turns = messages.filter((m) => m.role !== 'system')

    const finish = (status, data, key) => {
      if (status < 200 || status >= 300) {
        const raw = (data && (data.error?.message || data.message || (typeof data.error === 'string' ? data.error : null))) || 'Provider request failed'
        return send(res, status, { error: 'provider_error', message: sanitizeProviderMessage(raw, key || apiKey) })
      }
      return send(res, 200, data)
    }

    try {
      if (provider === 'nomi') {
        let id = nomisId
        const headersFor = { Authorization: apiKey, 'Content-Type': 'application/json' }
        if (!id) {
          const list = await jsonFetch(`${NOMI_BASE}/v1/nomis`, { headers: headersFor })
          if (list.status !== 200) return finish(list.status, list.data, apiKey)
          id = String(list.data?.nomis?.[0]?.uuid || '')
          if (!id) return send(res, 400, { error: 'no_nomi', message: 'No Nomi companion found on this key.' })
        }
        const lastUser = [...turns].reverse().find((m) => m.role === 'user')
        const payload = { messageText: String((lastUser && lastUser.content) || messages[messages.length - 1].content).slice(0, 4000) }
        const r = await jsonFetch(`${NOMI_BASE}/v1/nomis/${encodeURIComponent(id)}/chat`, {
          method: 'POST',
          headers: headersFor,
          body: JSON.stringify(payload),
        })
        if (r.status === 200 || r.status === 201) {
          const reply = r.data?.replyMessage || {}
          const text = String(reply.text ?? reply.messageText ?? '').trim()
          if (!text) return finish(502, { message: 'The Nomi API returned an empty reply.' }, apiKey)
          return send(res, 200, { text, nomisId: id })
        }
        return finish(r.status, r.data, apiKey)
      }

      if (provider === 'anthropic') {
        const anthropicBase = (baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')
        const upstream = await fetch(`${anthropicBase}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: model || 'claude-haiku-4-5',
            max_tokens: 700,
            ...(systemText ? { system: systemText } : {}),
            messages: turns.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
          }),
        })
        const data = await upstream.json().catch(() => ({}))
        if (!upstream.ok) return finish(upstream.status, data, apiKey)
        const text = Array.isArray(data.content)
          ? data.content.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('').trim()
          : ''
        if (!text) return finish(502, { message: 'Anthropic returned an empty reply.' }, apiKey)
        return send(res, 200, { text })
      }

      if (provider === 'gemini') {
        const geminiBase = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
        const upstream = await fetch(
          `${geminiBase}/v1beta/models/${encodeURIComponent(model || 'gemini-2.5-flash')}:generateContent`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
              ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
              contents: turns.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
              generationConfig: { maxOutputTokens: 700, temperature: 0.85 },
            }),
          },
        )
        const data = await upstream.json().catch(() => ({}))
        if (!upstream.ok) return finish(upstream.status, data, apiKey)
        const parts = data?.candidates?.[0]?.content?.parts || []
        const text = parts.map((p) => String(p.text || '')).join('').trim()
        if (!text) return finish(502, { message: 'Gemini returned an empty reply.' }, apiKey)
        return send(res, 200, { text })
      }

      // OpenAI-compatible (OpenAI, Groq, DeepSeek, Together, OpenRouter, Ollama, xAI, Mistral, azure-style proxies…)
      const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
      const upstream = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'gpt-4o-mini',
          ...(systemText ? {} : {}),
          messages: [
            ...(systemText ? [{ role: 'system', content: systemText }] : []),
            ...turns.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
          ],
          temperature: 0.85,
          max_tokens: 700,
        }),
      })
      const data = await upstream.json().catch(() => ({}))
      if (!upstream.ok) return finish(upstream.status, data, apiKey)
      const text = String(data?.choices?.[0]?.message?.content || '').trim()
      if (!text) return finish(502, { message: 'The provider returned an empty reply.' }, apiKey)
      return send(res, 200, { text })
    } catch (err) {
      return send(res, 502, {
        error: 'byok_unreachable',
        message: sanitizeProviderMessage(err instanceof Error ? err.message : 'The provider could not be reached', apiKey),
      })
    }
  }

  /* ---- Aion Labs: shared, authenticated, quota-protected ----
   * The app never receives a provider key. It authenticates as a Yuki user,
   * and this server is the only process that holds AIONLABS_API_KEY. */
  if (route === '/api/aion/config' && req.method === 'GET') {
    let user = await resolveAionUser(req)
    let guestToken = ''
    /* No token at all means an offline install. Issue a low-limit guest
     * session automatically; a present-but-invalid token is never downgraded. */
    if (!user && !bearerToken(req)) {
      if (!guestIssueAllowed(req)) {
        return send(res, 429, {
          error: 'aion_guest_busy',
          message: 'Too many guest sessions from this connection. Try again later or use Offline AI.',
        })
      }
      guestToken = issueGuestToken(req)
      user = verifyGuestToken(guestToken)
    }
    if (!user) {
      return send(res, 401, {
        error: 'aion_signin_required',
        message: 'Sign in to Yuki or start a guest Aion session to use the shared Aion Labs AI service.',
      })
    }
    const limits = aionLimits(user)
    const configured = Boolean(AION_KEY && AION_MODEL)
    const catalog = configured ? await aionModelIds() : { ids: [], error: 'not_configured' }
    const modelAvailable = catalog.ids.includes(AION_MODEL)
    let reason = ''
    if (!AION_KEY) reason = 'server_key_missing'
    else if (!AION_MODEL) reason = 'model_not_configured'
    else if (!modelAvailable) reason = catalog.error ? 'catalog_unavailable' : 'model_unavailable'
    else if (Date.now() < aionQuotaUntil) reason = 'quota_paused'
    return send(res, 200, {
      available: configured && modelAvailable && Date.now() >= aionQuotaUntil,
      model: AION_MODEL,
      reason,
      guest: Boolean(user.guest),
      limits,
      ...(guestToken ? { guestToken } : {}),
    })
  }

  if (route === '/api/aion/chat' && req.method === 'POST') {
    const user = await resolveAionUser(req)
    if (!user) {
      return send(res, 401, {
        error: 'aion_signin_required',
        message: 'Sign in to Yuki or start a guest Aion session to use the shared Aion Labs AI service.',
      })
    }
    if (Date.now() < aionQuotaUntil) {
      return send(res, 503, { error: 'aion_quota', message: aionMessage(503, 'aion_quota') })
    }
    let body
    try {
      body = await readBody(req, AION_MAX_INPUT_CHARS + 8192)
    } catch {
      return send(res, 400, { error: 'aion_bad_request', message: 'Request body is too large or malformed.' })
    }
    /* The client may not choose an upstream URL, model, headers or key. */
    const blocked = ['apiKey', 'key', 'baseUrl', 'base_url', 'url', 'headers', 'model', 'token', 'authorization']
      .find((k) => Object.prototype.hasOwnProperty.call(body, k))
    if (blocked) {
      return send(res, 400, { error: 'aion_bad_request', message: 'Request contains unsupported fields.' })
    }
    const raw = Array.isArray(body.messages) ? body.messages.slice(-24) : []
    const messages = []
    let totalChars = 0
    for (const m of raw) {
      if (!m || typeof m !== 'object') continue
      const role = String(m.role || '')
      if (role !== 'system' && role !== 'user' && role !== 'assistant') continue
      const content = String(m.content || '')
      if (!content || content.length > AION_MAX_MSG_CHARS) continue
      totalChars += content.length
      messages.push({ role, content })
    }
    if (!messages.some((m) => m.role === 'user') || totalChars > AION_MAX_INPUT_CHARS) {
      return send(res, 400, { error: 'aion_bad_request', message: 'A user message is required.' })
    }
    if (!AION_KEY || !AION_MODEL) {
      return send(res, 503, { error: 'aion_not_configured', message: 'The shared Aion service is not configured by the app owner.' })
    }
    const catalog = await aionModelIds()
    if (!catalog.ids.includes(AION_MODEL)) {
      return send(res, 503, { error: 'aion_model_unavailable', message: 'The configured Aion model is unavailable. Please contact the app owner.' })
    }
    const { u, g } = aionUsage(user.id)
    if (aionLimitHit(u, g, aionLimits(user))) {
      return send(res, 429, { error: 'aion_limit', message: 'Shared Aion limit reached for now. Try again later or use Offline AI.' })
    }
    const wantsStream = body.stream === true
    const payload = {
      model: AION_MODEL,
      messages,
      max_tokens: AION_MAX_OUTPUT_TOKENS,
      temperature: 0.85,
      stream: wantsStream,
    }
    let upstream
    try {
      upstream = await fetch(`${AION_BASE}/chat/completions`, {
        method: 'POST',
        headers: aionHeaders(),
        body: JSON.stringify(payload),
      })
    } catch {
      return send(res, 502, { error: 'aion_unreachable', message: aionMessage(502) })
    }
    if (!upstream.ok) {
      const status = upstream.status
      try { await upstream.arrayBuffer() } catch { /* drain */ }
      if (status === 402 || status === 429) {
        aionQuotaUntil = Date.now() + AION_QUOTA_COOLDOWN
        /* Deliberately no raw upstream body: it could contain account details. */
        console.warn('[yuki] Aion shared account quota/billing error — pausing shared requests')
      }
      return send(res, status >= 500 ? 503 : status, { error: `aion_${status}`, message: aionMessage(status) })
    }
    if (wantsStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      let buf = ''
      let closed = false
      res.on('close', () => { closed = true })
      try {
        const reader = upstream.body.getReader()
        const dec = new TextDecoder()
        while (!closed) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop()
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (!data || data === '[DONE]') continue
            let piece = ''
            try {
              const ch = JSON.parse(data)?.choices?.[0]?.delta?.content
              if (typeof ch === 'string') piece = ch
            } catch { /* keep-alive line */ }
            if (piece) res.write(`data: ${JSON.stringify({ delta: piece })}\n\n`)
          }
        }
        if (!closed) {
          res.write('data: [DONE]\n\n')
          u.aHourCount += 1; u.aDayCount += 1
          g.hourCount += 1; g.dayCount += 1
          usageFlush()
        }
      } catch {
        if (!closed) res.write('data: [DONE]\n\n')
      }
      res.end()
      return
    }
    let data = null
    try { data = await upstream.json() } catch { /* empty */ }
    const text = String(data?.choices?.[0]?.message?.content || '').trim()
    if (!text) {
      return send(res, 502, { error: 'aion_empty_reply', message: 'Aion returned an empty reply. Try again or use Offline AI.' })
    }
    const tokens = Math.max(0, Number(data?.usage?.total_tokens) || 0)
    u.aHourCount += 1; u.aDayCount += 1; u.aDayTokens += tokens
    g.hourCount += 1; g.dayCount += 1
    usageFlush()
    return send(res, 200, { text, model: AION_MODEL, usage: { totalTokens: tokens } })
  }

  /* ---- Eroq AI: built-in online roleplay brain -------------------------
   * The app never receives the Eroq key. It authenticates as a Yuki cloud
   * user or as a server-signed guest, and this process is the only holder of
   * EROQ_API_KEY. No Eroq account, subscription or key input exists in app.
   */
  if (route === '/api/eroq/status' && req.method === 'GET') {
    let user = await resolveAionUser(req)
    let guestToken = ''
    if (!user && !bearerToken(req)) {
      if (!guestIssueAllowed(req)) {
        return send(res, 429, {
          error: 'eroq_guest_busy',
          message: 'Too many guest sessions from this connection. Try again later or use Offline AI.',
        })
      }
      guestToken = issueGuestToken(req)
      user = verifyGuestToken(guestToken)
    }
    if (!user) {
      return send(res, 401, {
        error: 'eroq_signin_required',
        message: 'Sign in to Yuki or start a guest session to use Eroq AI.',
      })
    }
    const { u, g } = eroqUsage(user.id)
    const account = EROQ_KEY ? await eroqAccount() : { credits: null, error: 'not_configured' }
    let reason = ''
    if (!EROQ_ENABLED) reason = 'disabled'
    else if (!EROQ_KEY) reason = 'not_configured'
    else if (Date.now() < eroqQuotaUntil) reason = 'quota_paused'
    else if (account.error && account.error !== 'account_unreachable') reason = account.error
    else if (account.credits !== null && account.credits < 1) reason = 'insufficient_credits'
    const available = EROQ_ENABLED && Boolean(EROQ_KEY) && Date.now() >= eroqQuotaUntil && reason !== 'insufficient_credits'
    const models = Object.entries(EROQ_MODELS).map(([id, m]) => ({
      id,
      label: m.label,
      credits: m.credits,
      modes: m.modes,
    }))
    return send(res, 200, {
      available,
      enabled: EROQ_ENABLED,
      reason,
      defaultModel: EROQ_DEFAULT_MODEL,
      models,
      modes: EROQ_MODES,
      guest: Boolean(user.guest),
      limits: eroqLimits(user),
      globalDailyCredits: EROQ_GLOBAL_DAILY_CREDITS,
      usage: {
        requestsHour: u.eHourCount,
        requestsDay: u.eDayCount,
        creditsDay: u.eDayCredits,
        globalCreditsDay: g.dayCredits,
      },
      creditsRemaining: account.credits,
      ...(guestToken ? { guestToken } : {}),
    })
  }

  if ((route === '/api/eroq/chat' || route === '/api/eroq/chat/stream') && req.method === 'POST') {
    const user = await resolveAionUser(req)
    if (!user) {
      return send(res, 401, {
        error: 'eroq_signin_required',
        message: 'Sign in to Yuki or start a guest session to use Eroq AI.',
      })
    }
    let body
    try {
      body = await readBody(req, EROQ_MAX_INPUT_CHARS + 16_384)
    } catch {
      return send(res, 400, { error: 'eroq_bad_request', message: 'Request body is too large or malformed.' })
    }
    const valid = eroqValidate(body, user)
    if (valid.error) return send(res, 400, { error: valid.error, message: valid.message })

    const wantsStream = route.endsWith('/stream')
    const payload = { ...valid.payload, stream: wantsStream }
    const release = eroqAcquire(user, res, valid.requestId, payload, EROQ_MODELS[valid.model].credits)
    if (!release) return

    let upstream = null
    let timedOut = false
    const ctrl = new AbortController()
    const timeout = setTimeout(() => { timedOut = true; ctrl.abort() }, EROQ_TIMEOUT_MS)
    try {
      const account = await eroqAccount()
      if (account.credits !== null && account.credits < EROQ_MODELS[valid.model].credits) {
        eroqQuotaUntil = Date.now() + EROQ_QUOTA_COOLDOWN
        return send(res, 503, { error: 'eroq_quota', message: eroqMessage(402) })
      }
      upstream = await fetch(`${EROQ_BASE}/chat/completions`, {
        method: 'POST',
        headers: eroqHeaders(),
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
      if (!upstream.ok) {
        const status = upstream.status
        try { await upstream.arrayBuffer() } catch { /* drain */ }
        const failure = eroqUpstreamFailure(status)
        return send(res, failure.status, { error: failure.error, message: failure.message })
      }
      if (wantsStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        let buf = ''
        let text = ''
        let charged = false
        let aborted = false
        let streamError = ''
        let meta = null
        const abort = () => { aborted = true; ctrl.abort() }
        const recordStream = () => {
          if (charged || !text) return
          const charge = eroqRecord(
            { ...(meta?.usage || {}), state: meta?.state },
            user,
            eroqUsage(user.id).g,
            valid.model,
            valid.mode,
            valid.conversationId,
          )
          charged = true
          meta = { ...(meta || {}), usage: { ...(meta?.usage || {}), credits_spent: charge.spent, credits_remaining: charge.remaining } }
        }
        res.on('close', abort)
        try {
          const reader = upstream.body.getReader()
          const dec = new TextDecoder()
          readLoop: while (!aborted && !streamError && text.length < EROQ_MAX_TEXT_CHARS) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            const events = buf.split('\n\n')
            buf = events.pop() || ''
            for (const event of events) {
              const line = event.split('\n').find((l) => l.trim().startsWith('data:'))
              if (!line) continue
              const data = line.trim().slice(5).trim()
              if (!data || data === '[DONE]') continue
              let chunk = null
              try { chunk = JSON.parse(data) } catch { continue }
              if (chunk?.error) {
                const code = String(chunk.error.code || chunk.error.type || chunk.error.message || '')
                if (code === 'insufficient_credits') eroqQuotaUntil = Date.now() + EROQ_QUOTA_COOLDOWN
                streamError = code === 'insufficient_credits' ? 'eroq_quota' : 'eroq_upstream'
                break readLoop
              }
              const piece = chunk?.choices?.[0]?.delta?.content
              if (typeof piece === 'string' && piece) {
                text += piece
                if (!aborted) res.write(`data: ${JSON.stringify({ delta: piece })}\n\n`)
              }
              const found = eroqExtractMeta(chunk)
              if (found.usage || found.state || found.reaction || found.parts) meta = found
            }
          }
          if (!aborted) {
            recordStream()
            if (streamError) res.write(`data: ${JSON.stringify({ error: streamError })}\n\n`)
            else if (meta) res.write(`data: ${JSON.stringify({ meta })}\n\n`)
            res.write('data: [DONE]\n\n')
          }
        } catch {
          if (!aborted) {
            streamError = timedOut ? 'eroq_timeout' : 'eroq_unreachable'
            res.write(`data: ${JSON.stringify({ error: streamError })}\n\n`)
            res.write('data: [DONE]\n\n')
          }
        } finally {
          res.off('close', abort)
          recordStream()
        }
        res.end()
        return
      }

      let data = null
      try { data = await upstream.json() } catch { /* empty */ }
      const message = data?.choices?.[0]?.message
      const text = String(message?.content || '').trim().slice(0, EROQ_MAX_TEXT_CHARS)
      if (!text) {
        return send(res, 502, { error: 'eroq_empty_reply', message: 'Eroq sent an empty reply. Try again or switch to Offline AI.' })
      }
      const charge = eroqRecord(
        { ...(data?.usage || {}), state: message?.state },
        user,
        eroqUsage(user.id).g,
        valid.model,
        valid.mode,
        valid.conversationId,
      )
      return send(res, 200, {
        text,
        model: valid.model,
        mode: valid.mode,
        usage: { creditsSpent: charge.spent, creditsRemaining: charge.remaining },
      })
    } catch {
      const code = timedOut ? 'eroq_timeout' : 'eroq_unreachable'
      return send(res, timedOut ? 504 : 502, { error: code, message: eroqMessage(timedOut ? 504 : 502) })
    } finally {
      clearTimeout(timeout)
      release()
    }
  }

  /* ---- voice (Fish Audio) ---- */
  if (route === '/api/tts') {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' })
    if (!FISH_KEYS.length) {
      return send(res, 503, {
        error: 'tts_not_configured',
        message: 'Set FISH_API_KEY (and FISH_API_KEY_2, …) in .env on the server.',
      })
    }
    const body = await readBody(req)
    const text = String(body.text || '').trim().slice(0, 600)
    if (!text) return send(res, 400, { error: 'text_required' })

    const byokFish = apiKeyFor(req, 'fish')
    if (byokFish) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 60_000)
      try {
        const r = await fetch(`${FISH_BASE}/v1/tts`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            Authorization: `Bearer ${byokFish}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            format: 'mp3',
            mp3_bitrate: 128,
            latency: 'normal',
            reference_id: String(req.headers['x-yuki-model'] || FISH_VOICE),
          }),
        })
        if (!r.ok) {
          const msg = await r.text().catch(() => '')
          return send(res, r.status, {
            error: 'tts_provider_error',
            message: sanitizeProviderMessage(msg || `Fish Audio error ${r.status}`, byokFish),
          })
        }
        return sendAudio(res, Buffer.from(await r.arrayBuffer()))
      } catch (err) {
        return send(res, 502, { error: 'tts_unreachable', message: err instanceof Error ? err.message : 'Fish Audio unreachable' })
      } finally {
        clearTimeout(timer)
      }
    }

    const hit = TTS_CACHE.get(text)
    if (hit) return sendAudio(res, hit)

    const pool = keyPool(FISH_KEYS, false)
    if (!pool.length) {
      return send(res, 503, {
        error: 'tts_keys_exhausted',
        message: 'Every Fish Audio key ran out or was rejected. Add another FISH_API_KEY_n.',
      })
    }

    let lastStatus = 0
    for (const entry of pool) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 60_000)
      try {
        const r = await fetch(`${FISH_BASE}/v1/tts`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            Authorization: `Bearer ${entry.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            format: 'mp3',
            mp3_bitrate: 128,
            latency: 'normal',
            reference_id: FISH_VOICE,
          }),
        })
        if (!r.ok) {
          lastStatus = r.status
          const detail = await r.text().catch(() => '')
          if (!markKeyResult(entry, r.status, 'fish')) {
            console.error('[yuki] fish tts', entry.label, r.status, detail.slice(0, 200))
          }
          continue
        }
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length < 500) {
          lastStatus = 0
          continue
        }
        if (TTS_CACHE.size >= 24) TTS_CACHE.delete(TTS_CACHE.keys().next().value)
        TTS_CACHE.set(text, buf)
        console.log(`[yuki] fish ${entry.label} → ${buf.length} bytes`)
        return sendAudio(res, buf)
      } catch (err) {
        console.error('[yuki] fish tts', entry.label, err instanceof Error ? err.message : err)
        continue
      } finally {
        clearTimeout(timer)
      }
    }
    return send(res, 502, { error: 'tts_failed', status: lastStatus || undefined })
  }

  /* ---- Koolbase auth ---- */
  if (route.startsWith('/api/auth')) {
    if (!KB_KEY) {
      return send(res, 503, {
        error: 'auth_not_configured',
        message: 'Set KOOLBASE_SECRET_KEY in .env, or use an offline account.',
      })
    }
    const headers = { 'x-api-key': KB_KEY, 'Content-Type': 'application/json' }
    const map = {
      '/api/auth/register': '/v1/sdk/auth/register',
      '/api/auth/login': '/v1/sdk/auth/login',
      '/api/auth/logout': '/v1/sdk/auth/logout',
      '/api/auth/forgot': '/v1/sdk/auth/forgot-password',
      '/api/auth/reset': '/v1/sdk/auth/reset-password',
      '/api/auth/verify-email': '/v1/sdk/auth/verify-email',
      '/api/auth/resend': '/v1/sdk/auth/send-verification',
    }

    if (route === '/api/auth/me' && req.method === 'GET') {
      const bearer = req.headers.authorization
      if (!bearer) return send(res, 401, { error: 'unauthorized' })
      const r = await jsonFetch(`${KB_BASE}/v1/sdk/auth/me`, {
        headers: { ...headers, Authorization: bearer },
      })
      return send(res, r.status, r.data)
    }

    const target = map[route]
    if (target && req.method === 'POST') {
      const body = await readBody(req)
      const r = await jsonFetch(`${KB_BASE}${target}`, {
        method: 'POST',
        headers: { ...headers, ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}) },
        body: JSON.stringify(body),
      })
      return send(res, r.status, r.data)
    }

    return send(res, 404, { error: 'not_found' })
  }

  return send(res, 404, { error: 'not_found' })
}

/* ----------------------------------------------------------- video cache */
function serveVideo(req, res, url) {
  const m = /^\/video-cache\/u_([0-9a-f]{12})\/([A-Za-z0-9_-]{1,64})\.mp4$/.exec(url.pathname)
  if (!m) return send(res, 404, 'Not found')
  const [, h, clipId] = m
  /* Playback uses a file-scoped HMAC signature; no session token involved. */
  const sig = url.searchParams.get('sig') || ''
  if (sig !== clipSig(h, `${clipId}.mp4`)) return send(res, 404, 'Not found')
  const file = path.join(VIDEO_DIR, `u_${h}`, `${clipId}.mp4`)

  let st
  try {
    st = fs.statSync(file)
  } catch {
    return send(res, 404, 'Not found')
  }
  if (!st.isFile()) return send(res, 404, 'Not found')

  const size = st.size
  const method = req.method
  res.setHeader('Content-Type', 'video/mp4')
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, max-age=3600')

  const range = req.headers.range
  if (!range) {
    res.writeHead(200, { 'Content-Length': size })
    if (method === 'HEAD') return res.end()
    fs.createReadStream(file).pipe(res)
    return
  }

  const r = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
  if (!r || (r[1] === '' && r[2] === '')) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` })
    return res.end()
  }
  let start, end
  if (r[1] === '') {
    const suffix = Number(r[2])
    if (!Number.isFinite(suffix) || suffix <= 0) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return res.end()
    }
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(r[1])
    end = r[2] === '' ? size - 1 : Number(r[2])
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` })
    return res.end()
  }
  end = Math.min(end, size - 1)
  res.writeHead(206, {
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
  })
  if (method === 'HEAD') return res.end()
  fs.createReadStream(file, { start, end }).pipe(res)
}

/* --------------------------------------------------------------- static */
function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === '/') pathname = '/index.html'
  const file = path.join(DIST, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''))

  if (!file.startsWith(DIST)) return send(res, 403, 'Forbidden')

  const tryFile = (p) => {
    try {
      return fs.statSync(p).isFile() ? p : null
    } catch {
      return null
    }
  }

  const found = tryFile(file) || (!path.extname(file) ? tryFile(path.join(DIST, 'index.html')) : null)
  if (!found) return send(res, 404, 'Not found')

  const ext = path.extname(found).toLowerCase()
  const immutable = found.includes(`${path.sep}assets${path.sep}`) && ext !== '.html'
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=604800' : 'no-cache',
  })
  fs.createReadStream(found).pipe(res)
}

/* --------------------------------------------------------------- listen */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)
    if (url.pathname.startsWith('/video-cache/')) return serveVideo(req, res, url)
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed')
    return serveStatic(req, res, url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[yuki]', req.method, url.pathname, msg)
    if (!res.headersSent) {
      send(res, 500, {
        error: 'server_error',
        message: msg === 'bad_json' ? 'Invalid JSON body.' : 'Something went wrong.',
      })
    }
  }
})

server.listen(PORT, HOST, () => {
  console.log(`Yuki running at http://${HOST}:${PORT}`)
  console.log(
    `  nomi keys:     ${
      NOMI_KEYS.length ? `${NOMI_KEYS.length} configured` : 'MISSING (offline engine still works)'
    }`,
  )
  console.log(`  koolbase key:  ${KB_KEY ? 'set' : 'MISSING (offline accounts still work)'}`)
  console.log(
    `  fish voice:    ${
      FISH_KEYS.length
        ? `${FISH_KEYS.length} key${FISH_KEYS.length > 1 ? 's' : ''} (${FISH_VOICE.slice(0, 8)}…)`
        : 'MISSING (device voice is used)'
    }`,
  )
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.log('  hint: run "npm run build" first')
  }
  console.log(
    `  video:         ${MAGIC_HOUR_KEYS.length ? `magichour ${MAGIC_HOUR_MODEL} ${MAGIC_HOUR_RES} (free plan — watermarked, ${MAGIC_HOUR_KEYS.length} key${MAGIC_HOUR_KEYS.length > 1 ? 's' : ''} round-robin)` : 'MISSING (video mode shows an empty state)'}`,
  )
})
