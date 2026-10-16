#!/usr/bin/env bun
/**
 * tg-router — the single Telegram poller for all Claude Code sessions.
 *
 * Telegram allows one getUpdates consumer per bot token. tg-router is that
 * consumer: it polls, works out which session each update belongs to, and
 * pushes it over a local WebSocket to the overlaid telegram plugin running
 * inside that session. Outbound calls (sendMessage etc.) still go straight
 * from each session to Telegram.
 *
 * Routes:  "dm"                     — private chats → the main session
 *          "<chat_id>:<thread_id>"  — one forum topic → its own session
 *          "<chat_id>:main"         — a non-forum group / the General topic
 *
 * When a message arrives for a route nobody serves, tg-router prepares that
 * topic's workspace (CLAUDE.md, INSTRUCTIONS.md, MEMORY.md), opens a new
 * Windows Terminal tab running claude there, queues the message and flushes
 * it once the session connects.
 *
 * Bot commands (/start /help /setup /id /status /sessions) are answered here,
 * so they work without waking a session. The bot's command menu is written
 * on first connect and whenever the token switches to another bot.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, renameSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
import { spawn } from 'child_process'
import type { ServerWebSocket } from 'bun'
import { loadConfig, applyOverlay, readToken, secretFile, PLUGIN_VERSION, STATE, LOG_FILE, CONFIG_FILE } from '../lib/common.ts'
import { parseCommand, handleCommand, ensureBotCommands, type AccessLike, type SessionItem } from '../overlay/bot-ui.ts'

const TEMPLATES = join(import.meta.dir, 'templates')
const cfg = loadConfig()
mkdirSync(STATE, { recursive: true })
mkdirSync(dirname(LOG_FILE), { recursive: true })

function log(...parts: unknown[]): void {
  const line = `${new Date().toISOString()} ${parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`
  console.log(line)
  try {
    try { if (statSync(LOG_FILE).size > 5 * 1024 * 1024) renameSync(LOG_FILE, LOG_FILE + '.1') } catch {}
    appendFileSync(LOG_FILE, line + '\n')
  } catch {}
}

// ---- Telegram ---------------------------------------------------------------

let TOKEN = readToken(cfg)
if (!TOKEN) {
  log(`FATAL: TELEGRAM_BOT_TOKEN not found (env or ${join(cfg.telegramStateDir, '.env')}) — run /telegram:configure <token>`)
  process.exit(1)
}
const API_ROOT = (process.env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org').replace(/\/+$/, '')

class TgError extends Error {
  constructor(message: string, public code: number) { super(message) }
}

async function tg<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
  const res = await fetch(`${API_ROOT}/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = (await res.json()) as { ok: boolean; result: T; error_code: number; description: string }
  if (!j.ok) throw new TgError(`${method}: ${j.error_code} ${j.description}`, j.error_code)
  return j.result
}

/** Best-effort notice into a chat/topic. Never throws. */
function notify(chat_id: string, thread: number | undefined, text: string, html = false): void {
  void tg('sendMessage', {
    chat_id,
    text,
    ...(thread != null ? { message_thread_id: thread } : {}),
    ...(html ? { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } : {}),
  }).catch(err => log('notify failed:', String(err)))
}

// ---- Persistent state -------------------------------------------------------

function loadJson<T>(name: string, fallback: T): T {
  try { return JSON.parse(readFileSync(join(STATE, name), 'utf8')) as T } catch { return fallback }
}
function saveJson(name: string, value: unknown): void {
  const file = join(STATE, name)
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n')
  renameSync(file + '.tmp', file)
}

type TopicInfo = { topic?: string; chat_title?: string }
type RouteEntry = { dir: string; created: string }
type ChatEntry = { title?: string; type: string; is_forum?: boolean; seen: string }

const topics = loadJson<Record<string, TopicInfo>>('topics.json', {})
const routes = loadJson<Record<string, RouteEntry>>('routes.json', {})
const chats = loadJson<Record<string, ChatEntry>>('chats.json', {})

// Shared secret so random local processes can't register as a session.
const SECRET_FILE = secretFile(cfg)
const SECRET = (() => {
  try {
    const s = readFileSync(SECRET_FILE, 'utf8').trim()
    if (s) return s
  } catch {}
  const s = randomBytes(24).toString('hex')
  mkdirSync(cfg.telegramStateDir, { recursive: true })
  writeFileSync(SECRET_FILE, s)
  return s
})()

// ---- Access (mirror of the plugin's gate, used to decide on spawning) -------

type Access = AccessLike & { mentionPatterns?: string[] }

function loadAccess(): Access {
  try {
    const a = JSON.parse(readFileSync(join(cfg.telegramStateDir, 'access.json'), 'utf8'))
    return {
      dmPolicy: a.dmPolicy ?? 'pairing',
      allowFrom: a.allowFrom ?? [],
      groups: a.groups ?? {},
      pending: a.pending ?? {},
      mentionPatterns: a.mentionPatterns,
    }
  } catch {
    return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} }
  }
}

let botUsername = ''

function isMentioned(msg: any, patterns: string[] | undefined): boolean {
  const entities = msg.entities ?? msg.caption_entities ?? []
  const text: string = msg.text ?? msg.caption ?? ''
  for (const e of entities) {
    if (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${botUsername}`.toLowerCase()) return true
    if (e.type === 'text_mention' && e.user?.is_bot && e.user.username === botUsername) return true
  }
  const r = msg.reply_to_message
  if (r && !r.forum_topic_created && r.from?.username === botUsername) return true
  for (const p of patterns ?? []) {
    try { if (new RegExp(p, 'i').test(text)) return true } catch {}
  }
  return false
}

function hasContent(msg: any): boolean {
  return Boolean(msg.text || msg.caption || msg.photo || msg.document || msg.voice || msg.audio || msg.video || msg.video_note || msg.sticker)
}

/** Would the plugin deliver this message to Claude? Only then is it worth opening a session. */
function wouldDeliver(route: string, msg: any): boolean {
  const access = loadAccess()
  if (access.dmPolicy === 'disabled' || !msg.from || !hasContent(msg)) return false
  const sender = String(msg.from.id)
  if (route === 'dm') return access.allowFrom.includes(sender)
  const policy = access.groups[String(msg.chat.id)]
  if (!policy) return false
  const allow = policy.allowFrom ?? []
  if (allow.length > 0 && !allow.includes(sender)) return false
  if ((policy.requireMention ?? true) && !isMentioned(msg, access.mentionPatterns)) return false
  return true
}

// ---- Routing ----------------------------------------------------------------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

function threadOf(msg: any): number | undefined {
  return msg.chat?.is_forum && msg.is_topic_message ? msg.message_thread_id : undefined
}

function routeOf(msg: any): string | null {
  const type = msg.chat?.type
  if (type === 'private') return 'dm'
  if (type === 'group' || type === 'supergroup') return `${msg.chat.id}:${threadOf(msg) ?? 'main'}`
  return null
}

function parseRoute(route: string): { chat_id?: string; thread?: number } {
  if (route === 'dm') return {}
  const [chat_id, t] = route.split(':')
  return { chat_id, thread: t && t !== 'main' ? Number(t) : undefined }
}

function infoFor(route: string): TopicInfo | undefined {
  return topics[route]
}

/** Track chat titles and topic names — the Bot API can't look a topic name up later. */
function learn(msg: any): void {
  const chat = msg.chat
  if (!chat || chat.type === 'private') return
  const chat_id = String(chat.id)
  const prevChat = chats[chat_id]
  if (!prevChat || prevChat.title !== chat.title || prevChat.is_forum !== chat.is_forum) {
    chats[chat_id] = { title: chat.title, type: chat.type, is_forum: chat.is_forum, seen: new Date().toISOString() }
    saveJson('chats.json', chats)
    if (!prevChat) log(`new chat seen: ${chat_id} "${chat.title}" (${chat.type}${chat.is_forum ? ', forum' : ''})`)
  }
  const route = `${chat_id}:${threadOf(msg) ?? 'main'}`
  const name: string | undefined =
    msg.forum_topic_created?.name ??
    msg.forum_topic_edited?.name ??
    msg.reply_to_message?.forum_topic_created?.name ??
    (chat.is_forum && threadOf(msg) == null ? 'General' : undefined)
  const prev = topics[route] ?? {}
  const next: TopicInfo = { topic: name ?? prev.topic, chat_title: chat.title ?? prev.chat_title }
  if (next.topic !== prev.topic || next.chat_title !== prev.chat_title) {
    topics[route] = next
    saveJson('topics.json', topics)
    clients.get(route)?.ws.send(JSON.stringify({ t: 'topic', key: route, info: next }))
  }
}

// ---- Sessions ---------------------------------------------------------------

type WsData = { route?: string }
type Client = { ws: ServerWebSocket<WsData>; route: string; pid?: number; dir?: string; since: number }

const clients = new Map<string, Client>()
const pending = new Map<string, { at: number; chat_id?: string; thread?: number }>()
const queues = new Map<string, { at: number; payload: string }[]>()

function send(route: string, payload: string): boolean {
  const c = clients.get(route)
  if (!c) return false
  c.ws.send(payload)
  return true
}

function broadcast(payload: string): void {
  for (const c of clients.values()) c.ws.send(payload)
}

function enqueue(route: string, payload: string): void {
  const q = queues.get(route) ?? []
  q.push({ at: Date.now(), payload })
  queues.set(route, q)
}

function flush(route: string): void {
  const q = queues.get(route)
  if (!q) return
  queues.delete(route)
  const fresh = q.filter(i => Date.now() - i.at < cfg.queueTtlSec * 1000)
  for (const i of fresh) send(route, i.payload)
  if (fresh.length) log(`flushed ${fresh.length} queued update(s) to ${route}`)
}

function sessionList(): SessionItem[] {
  return [
    ...[...clients.values()].map(c => ({ route: c.route, ...infoFor(c.route), since: c.since })),
    ...[...pending.keys()].map(route => ({ route, ...infoFor(route), starting: true })),
  ]
}

/** Answer a bot command here. Returns true when the message was a command (handled or ignored). */
function handleBotCommand(msg: any, route: string): boolean {
  const cmd = parseCommand(msg, botUsername)
  if (!cmd) return false
  const text = handleCommand(cmd, msg, { access: loadAccess(), topicName: infoFor(route)?.topic, sessions: sessionList() })
  if (text) notify(String(msg.chat.id), threadOf(msg), text, true)
  log(`command /${cmd} from ${msg.from?.id} in ${route}: ${text ? 'answered' : 'ignored'}`)
  return true
}

function handleUpdate(u: any): void {
  // Permission buttons: only the session that asked knows the request id.
  if (u.callback_query) {
    broadcast(JSON.stringify({ t: 'update', update: u }))
    return
  }
  if (u.my_chat_member) {
    const m = u.my_chat_member
    log(`bot membership in ${m.chat.id} "${m.chat.title ?? ''}": ${m.old_chat_member?.status} → ${m.new_chat_member?.status}`)
    learn({ chat: m.chat })
    return
  }
  const msg = u.message
  if (!msg) return
  learn(msg)
  const route = routeOf(msg)
  if (!route) return

  if (handleBotCommand(msg, route)) return
  if (route === 'dm' && typeof msg.text === 'string' && PERMISSION_REPLY_RE.test(msg.text)) {
    broadcast(JSON.stringify({ t: 'update', update: u }))
    return
  }

  const payload = JSON.stringify({ t: 'update', key: route, info: infoFor(route), update: u })
  if (send(route, payload)) return

  // Nobody serves this route. Queue while a session is starting; otherwise
  // start one — but only for messages the plugin would actually deliver, so
  // chatter that doesn't mention the bot never opens a terminal.
  if (pending.has(route)) {
    enqueue(route, payload)
    return
  }
  if (!wouldDeliver(route, msg)) return
  enqueue(route, payload)
  startSession(route, msg)
}

// ---- Workspaces -------------------------------------------------------------

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ү: 'u', ө: 'o', ң: 'n', ә: 'a', ғ: 'g', қ: 'k', һ: 'h', і: 'i',
}

/** ASCII folder name — keeps PowerShell launchers and paths free of encoding trouble. */
function slug(s: string | undefined, fallback: string): string {
  const out = (s ?? '')
    .toLowerCase()
    .split('')
    .map(ch => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return out || fallback
}

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '')
}

function readTemplate(name: string): string {
  // A user override in <topicsRoot>/_template/ wins over the bundled one.
  const override = join(cfg.topicsRoot, '_template', name)
  return readFileSync(existsSync(override) ? override : join(TEMPLATES, name), 'utf8')
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * Older tg-router versions put the MEMORY.md Stop hook into each topic's
 * .claude/settings.json; tg-topics ships it as a plugin hook now. Drop the
 * old entry so it doesn't fire twice (or point at a deleted script).
 */
function dropLegacyTopicHook(dir: string): void {
  const file = join(dir, '.claude', 'settings.json')
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    const stop: any[] | undefined = s.hooks?.Stop
    if (!stop) return
    const kept = stop.filter(g => !(g.hooks ?? []).some((h: any) => String(h.command ?? '').includes('memory-reminder')))
    if (kept.length === stop.length) return
    if (kept.length) s.hooks.Stop = kept
    else delete s.hooks.Stop
    if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks
    writeFileSync(file, JSON.stringify(s, null, 2) + '\n')
  } catch {}
}

type Workspace = { dir: string; launcher: string; title: string; env: Record<string, string> }

function prepareWorkspace(route: string): Workspace {
  const routerUrl = `ws://127.0.0.1:${cfg.port}/ws`
  const env: Record<string, string> = { TELEGRAM_ROUTE: route, TELEGRAM_ROUTER_URL: routerUrl }
  if (process.env.TELEGRAM_API_ROOT) env.TELEGRAM_API_ROOT = process.env.TELEGRAM_API_ROOT
  if (process.env.TELEGRAM_STATE_DIR) env.TELEGRAM_STATE_DIR = process.env.TELEGRAM_STATE_DIR

  let dir: string
  let title: string
  let sessionName: string
  let launcher: string

  if (route === 'dm') {
    // The main session lives in dm.dir — no generated files there.
    dir = cfg.dm.dir
    title = 'TG · DM'
    sessionName = 'TG: DM'
    launcher = join(STATE, 'launch', 'dm.ps1')
  } else {
    const { chat_id, thread } = parseRoute(route)
    const info = infoFor(route) ?? {}
    const topicName = info.topic ?? (thread != null ? `Тема ${thread}` : 'Чат')
    const chatTitle = info.chat_title ?? chat_id!
    let entry = routes[route]
    if (!entry) {
      const base = join(cfg.topicsRoot, slug(chatTitle, `chat${chat_id}`))
      let candidate = join(base, `${slug(info.topic, 'topic')}-${thread ?? 'main'}`)
      for (let n = 2; Object.values(routes).some(r => r.dir === candidate); n++) candidate = `${candidate}-${n}`
      entry = { dir: candidate, created: new Date().toISOString() }
      routes[route] = entry
      saveJson('routes.json', routes)
    }
    dir = entry.dir
    env.TELEGRAM_TOPIC_DIR = dir
    title = `TG · ${topicName}`
    sessionName = `TG: ${chatTitle} / ${topicName}`
    launcher = join(dir, '.tg', 'start.ps1')

    mkdirSync(join(dir, '.tg'), { recursive: true })
    const vars = {
      TOPIC: topicName,
      CHAT_TITLE: chatTitle,
      CHAT_ID: chat_id!,
      THREAD_ID: thread != null ? String(thread) : 'main',
      ROUTE: route,
      DIR: dir,
    }
    // CLAUDE.md is regenerated every start (names may change);
    // INSTRUCTIONS.md and MEMORY.md belong to the user/Claude and are kept.
    writeFileSync(join(dir, 'CLAUDE.md'), render(readTemplate('CLAUDE.topic.md'), vars))
    if (!existsSync(join(dir, 'INSTRUCTIONS.md'))) writeFileSync(join(dir, 'INSTRUCTIONS.md'), render(readTemplate('INSTRUCTIONS.md'), vars))
    if (!existsSync(join(dir, 'MEMORY.md'))) writeFileSync(join(dir, 'MEMORY.md'), render(readTemplate('MEMORY.md'), vars))
    dropLegacyTopicHook(dir)
    writeFileSync(join(dir, '.tg', 'topic.json'), JSON.stringify({ route, chat_id, thread_id: thread ?? null, topic: topicName, chat_title: chatTitle }, null, 2) + '\n')
  }

  const args = [...cfg.claudeArgs, '-n', sessionName].map(psQuote).join(' ')
  const ps1 = [
    '# Generated by tg-router on every start — edits are overwritten.',
    'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}',
    `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}`,
    ...Object.entries(env).map(([k, v]) => `$env:${k} = ${psQuote(v)}`),
    `Set-Location -LiteralPath ${psQuote(dir)}`,
    `& ${psQuote(cfg.claudeExe)} ${args}`,
  ].join('\r\n')
  mkdirSync(dirname(launcher), { recursive: true })
  // BOM so Windows PowerShell 5.1 reads non-ASCII topic names as UTF-8.
  writeFileSync(launcher, '﻿' + ps1 + '\r\n')
  return { dir, launcher, title, env }
}

// Detached: on Windows a plain child joins the router's kill-on-close job
// object, so restarting the router would take every session down with it.
function spawnDetached(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): void {
  const child = spawn(cmd[0]!, cmd.slice(1), { ...opts, detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', err => log(`launch failed (${cmd[0]}):`, String(err)))
  child.unref()
}

function launch(ws: Workspace): void {
  const psArgs = ['-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ws.launcher]
  if (cfg.launcher === 'command') {
    spawnDetached(cfg.command, { cwd: ws.dir, env: { ...process.env, ...ws.env } })
  } else if (cfg.launcher === 'wt') {
    // wt treats ';' as its own command separator.
    const title = ws.title.replace(/;/g, ',')
    spawnDetached(['wt.exe', '-w', cfg.wtWindow, 'new-tab', '--title', title, '--suppressApplicationTitle', '-d', ws.dir, 'powershell.exe', ...psArgs])
  } else {
    const list = psArgs.map(psQuote).join(',')
    spawnDetached(['powershell.exe', '-NoProfile', '-Command', `Start-Process powershell.exe -WorkingDirectory ${psQuote(ws.dir)} -ArgumentList ${list}`])
  }
}

function startSession(route: string, msg: any): void {
  const { chat_id, thread } = parseRoute(route)
  const target = route === 'dm' ? String(msg.chat.id) : chat_id!
  if (route === 'dm' && !cfg.dm.spawn) return
  if (clients.size + pending.size >= cfg.maxSessions) {
    log(`not starting ${route}: session limit ${cfg.maxSessions} reached`)
    notify(target, thread, `⚠️ Лимит параллельных сессий (${cfg.maxSessions}) исчерпан — закрой ненужные вкладки или увеличь maxSessions в ${CONFIG_FILE}.`)
    queues.delete(route)
    return
  }
  pending.set(route, { at: Date.now(), chat_id: target, thread })
  try {
    const ws = prepareWorkspace(route)
    launch(ws)
    log(`starting session for ${route} in ${ws.dir}`)
    if (cfg.announceSpawn && route !== 'dm') {
      notify(target, thread, `🚀 Запускаю отдельную сессию для темы «${infoFor(route)?.topic ?? route}» — первый ответ через ~20–30 сек.`)
    }
  } catch (err) {
    pending.delete(route)
    queues.delete(route)
    log(`failed to start session for ${route}:`, String(err))
    notify(target, thread, `⚠️ Не удалось запустить сессию: ${err}`)
  }
}

// Sessions that never connected: tell the topic once, keep the queue for a
// late connect until it expires.
setInterval(() => {
  const now = Date.now()
  for (const [route, p] of pending) {
    if (now - p.at > cfg.spawnTimeoutSec * 1000) {
      pending.delete(route)
      log(`session for ${route} did not connect within ${cfg.spawnTimeoutSec}s`)
      if (p.chat_id) notify(p.chat_id, p.thread, `⚠️ Сессия не подключилась за ${cfg.spawnTimeoutSec} сек. Проверь окно Windows Terminal «${cfg.wtWindow}». Следующее сообщение попробует запустить её снова.`)
    }
  }
  for (const [route, q] of queues) {
    const fresh = q.filter(i => now - i.at < cfg.queueTtlSec * 1000)
    if (fresh.length) queues.set(route, fresh)
    else queues.delete(route)
  }
}, 15_000)

// ---- Plugin overlay upkeep --------------------------------------------------

// An update of the official plugin replaces our server.ts with upstream's —
// which would poll on its own and fight the router. Re-apply the overlay.
function ensureOverlay(): void {
  if (!cfg.plugin.autoPatch) return
  for (const r of applyOverlay(cfg)) {
    if (r.error) log(`overlay failed for ${r.dir}: ${r.error}`)
    else if (r.changed) log(`applied tg-topics overlay to ${r.dir} — restart Telegram sessions to load it`)
  }
}

// ---- Bot identity and command menu -----------------------------------------

async function connectBot(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const me = await tg<{ id: number; username: string }>('getMe')
      botUsername = me.username
      log(`polling as @${botUsername}`)
      void syncCommands(me)
      return
    } catch (err) {
      log('getMe failed:', String(err))
      await Bun.sleep(Math.min(2000 * attempt, 30_000))
    }
  }
}

async function syncCommands(me?: { id: number; username: string }, force = false): Promise<void> {
  try {
    const r = await ensureBotCommands(tg, cfg.telegramStateDir, { me, force })
    if (r.changed) log(`bot command menu set for @${r.username} (${r.reason})`)
  } catch (err) {
    log('command menu sync failed:', String(err))
  }
}

/** The channel's .env may get a new token (/telegram:configure). Follow it. */
async function checkTokenChange(): Promise<boolean> {
  if (process.env.TELEGRAM_BOT_TOKEN) return false
  const next = readToken(cfg)
  if (!next || next === TOKEN) return false
  TOKEN = next
  botUsername = ''
  log('bot token changed — switching bots (restart the Claude Telegram sessions so they send as the new bot too)')
  await connectBot()
  return true
}

// ---- Server -----------------------------------------------------------------

const server = (() => {
  try {
    return Bun.serve<WsData>({
      hostname: '127.0.0.1',
      port: cfg.port,
      fetch(req, srv) {
        const url = new URL(req.url)
        if (url.pathname === '/ws') {
          if (srv.upgrade(req, { data: {} })) return undefined
          return new Response('upgrade failed', { status: 400 })
        }
        if (url.pathname === '/health') return Response.json({ ok: true, version: PLUGIN_VERSION, pid: process.pid, bot: botUsername })
        if (url.pathname === '/shutdown' && req.method === 'POST') {
          if (req.headers.get('x-tg-router-secret') !== SECRET) return new Response('forbidden', { status: 403 })
          log('shutdown requested')
          setTimeout(() => process.exit(0), 200)
          return new Response('bye')
        }
        if (url.pathname === '/status') {
          return Response.json({
            version: PLUGIN_VERSION,
            bot: botUsername,
            sessions: [...clients.values()].map(c => ({ route: c.route, ...infoFor(c.route), dir: c.dir, pid: c.pid, since: new Date(c.since).toISOString() })),
            starting: [...pending.keys()],
            queued: Object.fromEntries([...queues].map(([k, q]) => [k, q.length])),
            chats,
            routes,
          })
        }
        return new Response('tg-router', { status: 404 })
      },
      websocket: {
        message(ws, raw) {
          let m: any
          try { m = JSON.parse(String(raw)) } catch { return }
          if (m.t !== 'hello') return
          if (m.secret !== SECRET) {
            ws.send(JSON.stringify({ t: 'rejected', reason: 'bad secret' }))
            ws.close()
            log('rejected a client with a bad secret')
            return
          }
          const route = String(m.route || 'dm')
          const old = clients.get(route)
          if (old && old.ws !== ws) {
            old.ws.send(JSON.stringify({ t: 'superseded' }))
            old.ws.close()
          }
          ws.data.route = route
          clients.set(route, { ws, route, pid: m.pid, dir: m.dir, since: Date.now() })
          pending.delete(route)
          ws.send(JSON.stringify({ t: 'welcome', route, info: infoFor(route) }))
          log(`session connected: ${route}${old ? ' (replaced previous)' : ''} pid=${m.pid} dir=${m.dir}`)
          flush(route)
        },
        close(ws) {
          const route = ws.data.route
          if (route && clients.get(route)?.ws === ws) {
            clients.delete(route)
            log(`session disconnected: ${route}`)
          }
        },
      },
    })
  } catch (err) {
    log(`cannot listen on 127.0.0.1:${cfg.port} — another tg-router running? (${err})`)
    process.exit(1)
  }
})()

// ---- Poll loop --------------------------------------------------------------

async function main(): Promise<void> {
  log(`tg-router ${PLUGIN_VERSION} listening on ${server.url} (config ${CONFIG_FILE})`)
  try { ensureOverlay() } catch (err) { log('overlay check failed:', String(err)) }
  setInterval(() => { try { ensureOverlay() } catch {} }, 10 * 60_000)
  // Re-check the menu now and then: an unpatched upstream server overwrites it.
  setInterval(() => void syncCommands(), 6 * 3600_000)

  await connectBot()

  let offset = loadJson<{ offset?: number }>('offset.json', {}).offset
  let conflictLogged = false
  for (let attempt = 1; ; ) {
    if (await checkTokenChange()) {
      // update_ids belong to the old bot.
      offset = undefined
      saveJson('offset.json', {})
    }
    try {
      const updates = await tg<any[]>(
        'getUpdates',
        { offset, timeout: 25, allowed_updates: ['message', 'callback_query', 'my_chat_member'] },
        40_000,
      )
      attempt = 1
      if (conflictLogged) log('poll slot acquired')
      conflictLogged = false
      for (const u of updates) {
        offset = u.update_id + 1
        try { handleUpdate(u) } catch (err) { log('update handling failed:', String(err)) }
      }
      if (updates.length) saveJson('offset.json', { offset })
    } catch (err) {
      if (err instanceof TgError && err.code === 409) {
        // A session started before the router is still polling; the overlaid
        // plugin notices the router within ~10s and hands the slot over.
        if (!conflictLogged) log('409: another poller holds the token — waiting for it to hand over')
        conflictLogged = true
        await Bun.sleep(3000)
      } else if (err instanceof TgError && err.code === 401) {
        log('401: the bot token was rejected — fix it with /telegram:configure <token>')
        await Bun.sleep(15_000)
      } else {
        log('getUpdates failed:', String(err))
        await Bun.sleep(Math.min(1000 * attempt++, 15_000))
      }
    }
  }
}

process.on('unhandledRejection', err => log('unhandled rejection:', String(err)))
void main()
