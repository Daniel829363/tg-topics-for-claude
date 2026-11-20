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
 * Bot commands (/start /help /setup /id /status /sessions /stop /maxsessions
 * /limits) are answered here, so they work without waking a session. The bot's command menu is written
 * on first connect and whenever the token switches to another bot.
 *
 * Crash recovery: the routes with a running session are kept in live.json.
 * After a reboot or power loss the router reopens them with
 * `claude --resume <id>`, and the ones that were mid-task get a message
 * asking them to carry on.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, renameSync, statSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
import { spawn } from 'child_process'
import type { ServerWebSocket } from 'bun'
import { loadConfig, applyOverlay, readToken, secretFile, updateConfigFile, routeFile, PLUGIN_VERSION, STATE, LOG_FILE, CONFIG_FILE } from '../lib/common.ts'
import { parseCommand, handleCommand, ensureBotCommands, MAX_SESSIONS_CAP, IDLE_MIN, IDLE_MAX, fmtIdle, type AccessLike, type SessionItem, type RouterControl } from '../overlay/bot-ui.ts'

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

// Messages waiting for a starting session are on disk too (state/queue.json): Telegram already
// counts them as delivered, so a router restart (a tg-topics update, a hand-over to a new router)
// must not drop them. A pending start survives only while its session can still connect.
type QueueFile = { pending?: Record<string, { at: number; chat_id?: string; thread?: number }>; queues?: Record<string, { at: number; payload: string }[]> }
{
  const saved = loadJson<QueueFile>('queue.json', {})
  const now = Date.now()
  for (const [r, p] of Object.entries(saved.pending ?? {})) if (now - p.at < cfg.spawnTimeoutSec * 1000) pending.set(r, p)
  for (const [r, items] of Object.entries(saved.queues ?? {})) {
    const fresh = (items ?? []).filter(i => now - i.at < cfg.queueTtlSec * 1000)
    if (fresh.length) queues.set(r, fresh)
  }
}
function saveQueue(): void {
  try { saveJson('queue.json', { pending: Object.fromEntries(pending), queues: Object.fromEntries(queues) } satisfies QueueFile) } catch (err) { log('cannot save queue.json:', String(err)) }
}

function send(route: string, payload: string): boolean {
  const c = clients.get(route)
  if (!c) return false
  c.ws.send(payload)
  lastActive.set(route, Date.now())
  return true
}

// ---- Auto-close of idle sessions (/idle) ------------------------------------
// A topic session is idle when it got no message and showed no work (busy mark: a turn running,
// or background shells/agents) for cfg.idleCloseMin minutes. It is then closed like /stop; the
// next message in the topic starts it again. The main DM session is never closed.
const lastActive = new Map<string, number>()
const MINUTE_MS = Number(process.env.TG_TEST_MINUTE_MS) || 60_000

async function closeIdleSessions(): Promise<void> {
  if (!cfg.idleCloseMin) return
  const now = Date.now()
  const idle: string[] = []
  for (const route of clients.keys()) {
    if (isBusy(route)) { lastActive.set(route, now); continue }
    if (!lastActive.has(route)) lastActive.set(route, now)
    if (route !== 'dm' && now - lastActive.get(route)! >= cfg.idleCloseMin * MINUTE_MS) idle.push(route)
  }
  if (!idle.length) return
  const closed = await stopSessions(idle)
  for (const route of closed) {
    lastActive.delete(route)
    log(`closed idle session ${route} (no messages or work for ${cfg.idleCloseMin} min)`)
    const { chat_id, thread } = parseRoute(route)
    if (chat_id) void tg('sendMessage', {
      chat_id, disable_notification: true, ...(thread != null ? { message_thread_id: thread } : {}),
      text: `💤 Сессия закрыта: ${fmtIdle(cfg.idleCloseMin, 'ru')} без сообщений и работы. Следующее сообщение в теме запустит её снова.`,
    }).catch(err => log('notify failed:', String(err)))
  }
}
setInterval(() => { void closeIdleSessions().catch(err => log('idle check failed:', String(err))) }, Math.min(60_000, MINUTE_MS)).unref?.()

function setIdleClose(min: number): void {
  const old = cfg.idleCloseMin
  cfg.idleCloseMin = min
  updateConfigFile({ idleCloseMin: min })
  // Count from now: sessions that sat unused before the change get the full time.
  const now = Date.now()
  for (const route of clients.keys()) lastActive.set(route, Math.max(lastActive.get(route) ?? 0, now))
  log(`idle auto-close ${old || 'off'} → ${min || 'off'} min`)
}

function broadcast(payload: string): void {
  for (const c of clients.values()) c.ws.send(payload)
}

function enqueue(route: string, payload: string): void {
  const q = queues.get(route) ?? []
  q.push({ at: Date.now(), payload })
  queues.set(route, q)
  saveQueue()
}

function flush(route: string): void {
  const q = queues.get(route)
  if (!q) return
  queues.delete(route)
  saveQueue()
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

const control: RouterControl = {
  get maxSessions() { return cfg.maxSessions },
  get idleCloseMin() { return cfg.idleCloseMin },
  setIdleClose,
  stop: routes => stopSessions(routes),
  setMaxSessions,
}

/** Answer a bot command here. Returns true when the message was a command (handled or ignored). */
function handleBotCommand(msg: any, route: string): boolean {
  const cmd = parseCommand(msg, botUsername)
  if (!cmd) return false
  void handleCommand(cmd, msg, { access: loadAccess(), topicName: infoFor(route)?.topic, sessions: sessionList(), control })
    .then(text => {
      if (text) notify(String(msg.chat.id), threadOf(msg), text, true)
      log(`command /${cmd} from ${msg.from?.id} in ${route}: ${text ? 'answered' : 'ignored'}`)
    })
    .catch(err => log(`command /${cmd} failed:`, String(err)))
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
  if (send(route, payload)) {
    markBusy(route, String(msg.chat.id))
    return
  }

  // Nobody serves this route. Queue while a session is starting; otherwise
  // start one — but only for messages the plugin would actually deliver, so
  // chatter that doesn't mention the bot never opens a terminal.
  if (pending.has(route)) {
    enqueue(route, payload)
    markBusy(route, String(msg.chat.id))
    return
  }
  if (!wouldDeliver(route, msg)) return
  enqueue(route, payload)
  startSession(route, msg)
  if (pending.has(route)) markBusy(route, String(msg.chat.id))
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

function launcherPath(route: string): string | undefined {
  if (route === 'dm') return join(STATE, 'launch', 'dm.ps1')
  const entry = routes[route]
  return entry && join(entry.dir, '.tg', 'start.ps1')
}

/** resume: a session id for `--resume`, or 'continue' for `--continue`. */
function prepareWorkspace(route: string, resume?: string): Workspace {
  const routerUrl = `ws://127.0.0.1:${cfg.port}/ws`
  const env: Record<string, string> = { TELEGRAM_ROUTE: route, TELEGRAM_ROUTER_URL: routerUrl }
  if (resume) env.TELEGRAM_RESUME = resume
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
    launcher = launcherPath(route)!
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
    launcher = launcherPath(route)!

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

  const resumeArgs = !resume ? [] : resume === 'continue' ? ['--continue'] : ['--resume', resume]
  const args = [...cfg.claudeArgs, '-n', sessionName, ...resumeArgs].map(psQuote).join(' ')
  const ps1 = [
    '# Generated by tg-router on every start — edits are overwritten.',
    'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}',
    `$Host.UI.RawUI.WindowTitle = ${psQuote(title)}`,
    ...Object.entries(env).map(([k, v]) => `$env:${k} = ${psQuote(v)}`),
    `Set-Location -LiteralPath ${psQuote(dir)}`,
    `& ${psQuote(cfg.claudeExe)} ${args}`,
    '# Closed with /stop: close the tab too (exit code 0, so Windows Terminal does).',
    `$stopFlag = ${psQuote(stopFlag(route))}`,
    'if (Test-Path -LiteralPath $stopFlag) { Remove-Item -LiteralPath $stopFlag -Force; [Environment]::Exit(0) }',
  ].join('\r\n')
  mkdirSync(dirname(launcher), { recursive: true })
  rmSync(stopFlag(route), { force: true })
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
  spawnRoute(route, route === 'dm' ? String(msg.chat.id) : parseRoute(route).chat_id!)
}

/**
 * Opens a session for a route nobody serves. Returns '' when it is starting,
 * otherwise why not. quiet: no Telegram notices (a hand-off from another
 * session reports to its sender instead).
 */
function spawnRoute(route: string, target: string | undefined, quiet = false): string {
  const { thread } = parseRoute(route)
  if (route === 'dm' && !cfg.dm.spawn) return 'the main (dm) session is not started by the router (dm.spawn is off)'
  if (clients.size + pending.size >= cfg.maxSessions) {
    log(`not starting ${route}: session limit ${cfg.maxSessions} reached`)
    if (!quiet && target) notify(target, thread, `⚠️ Лимит параллельных сессий (${cfg.maxSessions}) исчерпан. Закрой ненужную: /sessions → /stop N, или подними лимит: /maxsessions ${Math.min(cfg.maxSessions + 4, MAX_SESSIONS_CAP)}. Потом повтори сообщение.`)
    queues.delete(route)
    saveQueue()
    return `the parallel session limit (${cfg.maxSessions}) is reached — the user can close one with /stop N or raise it with /maxsessions`
  }
  // A topic whose session was cut off (reboot, power loss) gets its old
  // conversation back, even when a message beats the startup resume.
  const resume = live[route] ? resumeArg(route) : undefined
  if (resume) resuming.set(route, { busy: isBusy(route), chat_id: target, thread })
  if (!openSession(route, target, thread, resume)) return 'the session could not be launched (see the router log)'
  if (!quiet && cfg.announceSpawn && route !== 'dm' && target) {
    notify(target, thread, resume
      ? `♻️ Восстанавливаю сессию темы «${infoFor(route)?.topic ?? route}» после перезапуска — ответ через ~20–30 сек.`
      : `🚀 Запускаю отдельную сессию для темы «${infoFor(route)?.topic ?? route}» — первый ответ через ~20–30 сек.`)
  }
  return ''
}

// ---- Hand-offs between sessions ----------------------------------------------
// A session gives another one a task with its send_to_session tool (or the
// terminal with `tgt send`). The router delivers it like a Telegram message:
// straight away when the target runs, queued while it starts, and it starts a
// closed one itself — so the user doesn't have to write in that topic.

const PEER_TEXT_MAX = 20_000
const PEER_WINDOW_MS = 10 * 60_000
const PEER_MAX_PER_WINDOW = 12
const peerSent = new Map<string, number[]>()

/** The owner's DM — where the main session reports. */
function ownerChat(): string | undefined {
  return live.dm?.chat_id ?? loadAccess().allowFrom[0]
}

/** Routes a hand-off may go to: the main session and the topics of connected groups. */
function knownRoutes(): string[] {
  const access = loadAccess()
  const all = new Set<string>(['dm', ...Object.keys(routes), ...Object.keys(topics), ...clients.keys()])
  return [...all].filter(r => r === 'dm' || Boolean(access.groups[parseRoute(r).chat_id!]))
}

function stateOf(route: string): 'running' | 'starting' | 'closed' {
  return clients.has(route) ? 'running' : pending.has(route) ? 'starting' : 'closed'
}

function peerList(from?: string): { route: string; label: string; chat_title?: string; topic?: string; state: string; you?: boolean }[] {
  return knownRoutes()
    .map(route => ({ route, label: labelOf(route), ...infoFor(route), state: stateOf(route), ...(route === from ? { you: true } : {}) }))
    .sort((a, b) => Number(b.route === 'dm') - Number(a.route === 'dm') || a.label.localeCompare(b.label))
}

const DM_ALIASES = new Set(['dm', 'личка', 'лс', 'основная', 'главная', 'main session'])

/** "Видео монтаж", "Группа / Видео монтаж", "-100123:45" or "dm" → a route. */
function resolvePeer(query: string): { route?: string; error?: string } {
  const q = query.trim()
  const low = q.toLowerCase().replace(/^«|»$/g, '')
  const all = knownRoutes()
  if (all.includes(q)) return { route: q }
  if (DM_ALIASES.has(low)) return { route: 'dm' }
  const names = (r: string) => [labelOf(r).toLowerCase(), (infoFor(r)?.topic ?? '').toLowerCase()].filter(Boolean)
  let hits = all.filter(r => names(r).some(n => n === low))
  if (!hits.length && low) hits = all.filter(r => names(r).some(n => n.includes(low)))
  if (hits.length === 1) return { route: hits[0] }
  const list = (rs: string[]) => rs.map(r => `«${labelOf(r)}» (${r})`).join(', ')
  if (!hits.length) return { error: `no session matches "${q}". Known: ${list(all)}` }
  return { error: `"${q}" matches several sessions: ${list(hits)} — pass the route instead` }
}

type PeerResult = { route: string; label: string; state: 'delivered' | 'queued' | 'started' }

function handOff(from: string | undefined, fromLabel: string, to: string, text: string, files: string[]): PeerResult {
  if (to === from) throw new Error('that is this session itself')
  const now = Date.now()
  const key = `${from ?? 'terminal'}→${to}`
  const recent = (peerSent.get(key) ?? []).filter(t => now - t < PEER_WINDOW_MS)
  if (recent.length >= PEER_MAX_PER_WINDOW) throw new Error(`too many hand-offs to «${labelOf(to)}» in 10 minutes (${PEER_MAX_PER_WINDOW}) — wait for its answer instead of sending more`)
  const { thread } = parseRoute(to)
  const chat_id = to === 'dm' ? ownerChat() : parseRoute(to).chat_id
  if (!chat_id) throw new Error('the main session has no owner chat yet — the owner has to DM the bot once')

  const payload = JSON.stringify({ t: 'peer', from: from ?? 'terminal', from_label: fromLabel, text, files, chat_id, thread, info: infoFor(to), ts: new Date().toISOString() })
  let state: PeerResult['state']
  if (send(to, payload)) state = 'delivered'
  else if (pending.has(to)) { enqueue(to, payload); state = 'queued' }
  else {
    enqueue(to, payload)
    const why = spawnRoute(to, chat_id, true)
    if (why) {
      queues.delete(to)
      saveQueue()
      throw new Error(why)
    }
    state = 'started'
  }
  recent.push(now)
  peerSent.set(key, recent)
  markBusy(to, chat_id)
  log(`hand-off ${from ?? 'terminal'} → ${to}: ${state} (${text.length} chars${files.length ? `, ${files.length} file(s)` : ''})`)
  if (cfg.peerEcho) {
    const short = text.length > 3000 ? text.slice(0, 3000) + '…' : text
    notify(chat_id, thread, [
      `📨 Задача от «${fromLabel}»:`,
      short,
      ...(files.length ? [`📎 Файлы: ${files.map(f => f.split(/[\\/]/).pop()).join(', ')}`] : []),
      ...(state === 'started' ? ['', '🚀 Запускаю сессию этой темы — она возьмётся за задачу через ~20–30 сек.'] : []),
    ].join('\n'))
  }
  return { route: to, label: labelOf(to), state }
}

async function handleRpc(from: string, op: string, args: any): Promise<unknown> {
  if (op === 'sessions') return { you: from, sessions: peerList(from) }
  if (op === 'send') {
    const text = String(args.text ?? '').trim()
    if (!text) throw new Error('text is empty')
    if (text.length > PEER_TEXT_MAX) throw new Error(`text is too long (${text.length} > ${PEER_TEXT_MAX}) — put it in a file and pass its path in files`)
    const files = Array.isArray(args.files) ? args.files.map(String) : []
    const r = resolvePeer(String(args.to ?? ''))
    if (!r.route) throw new Error(r.error)
    return handOff(from, labelOf(from), r.route, text, files)
  }
  throw new Error(`unknown op "${op}" — update tg-topics`)
}

function openSession(route: string, chat_id: string | undefined, thread: number | undefined, resume?: string): boolean {
  pending.set(route, { at: Date.now(), chat_id, thread })
  saveQueue()
  try {
    const ws = prepareWorkspace(route, resume)
    launch(ws)
    log(`${resume ? 'resuming' : 'starting'} session for ${route} in ${ws.dir}${resume ? ` (${resume})` : ''}`)
    return true
  } catch (err) {
    pending.delete(route)
    queues.delete(route)
    resuming.delete(route)
    saveQueue()
    log(`failed to start session for ${route}:`, String(err))
    if (chat_id) notify(chat_id, thread, `⚠️ Не удалось запустить сессию: ${err}`)
    return false
  }
}

// ---- Crash recovery ---------------------------------------------------------

type LiveEntry = { since: string; chat_id?: string }

/** Routes whose session is running — what to reopen after a reboot. */
const live = loadJson<Record<string, LiveEntry>>('live.json', {})
const dropTimers = new Map<string, Timer>()
/** Sessions being reopened; busy ones get RESUME_PROMPT once they connect. */
const resuming = new Map<string, { busy: boolean; chat_id?: string; thread?: number }>()

// A tab closed by hand drops out of live.json after this delay. During a
// Windows shutdown the router dies before it, so those sessions come back.
const LIVE_DROP_MS = 30_000
// A busy mark this old is a leftover (the Stop hook never ran), not a task.
const BUSY_MAX_AGE_MS = 24 * 3600_000

const RESUME_PROMPT =
  '⚡ Компьютер выключился или перезагрузился, пока ты работал над задачей. Сессию восстановили ' +
  '(это сообщение прислал роутер tg-topics, а не пользователь). Посмотри в истории, на чём остановился, ' +
  'и проверь, что из начатого уже сделано: команда, которая шла в момент отключения, прервалась, ' +
  'её результат может быть неполным. Фоновые процессы и помощники (расшифровка, рендер, выгрузка, агенты) ' +
  'тоже остановились — проверь, какие не доработали, и перезапусти их. ' +
  'Потом продолжи задачу и коротко сообщи в этот чат, что продолжаешь.'

function markLive(route: string): void {
  clearTimeout(dropTimers.get(route))
  dropTimers.delete(route)
  live[route] = { ...live[route], since: new Date().toISOString() }
  saveJson('live.json', live)
}

function dropLive(route: string): void {
  clearTimeout(dropTimers.get(route))
  dropTimers.delete(route)
  rmSync(routeFile('busy', route), { force: true })
  if (!live[route]) return
  delete live[route]
  saveJson('live.json', live)
}

/** A message went to this route's session: it has work to finish after a reboot. */
function markBusy(route: string, chat_id: string): void {
  try {
    mkdirSync(join(STATE, 'busy'), { recursive: true })
    writeFileSync(routeFile('busy', route), new Date().toISOString())
  } catch {}
  // The main session's chat isn't part of its route — remember where to report.
  if (route === 'dm' && live[route] && live[route].chat_id !== chat_id) {
    live[route].chat_id = chat_id
    saveJson('live.json', live)
  }
}

function isBusy(route: string): boolean {
  try { return Date.now() - statSync(routeFile('busy', route)).mtimeMs < BUSY_MAX_AGE_MS } catch { return false }
}

/** --resume <id> from the SessionStart hook; a topic folder holds one conversation, so --continue finds it too. */
function resumeArg(route: string): string | undefined {
  try {
    const id = JSON.parse(readFileSync(routeFile('sessions', route, '.json'), 'utf8')).session_id
    if (id) return String(id)
  } catch {}
  return route === 'dm' ? undefined : 'continue'
}

function labelOf(route: string): string {
  if (route === 'dm') return 'Личка'
  const i = infoFor(route)
  return i ? `${i.chat_title ?? route} / ${i.topic ?? route}` : route
}

/** Reopens the sessions that were running when the router (or the computer) went down. */
function resumeSessions(): void {
  const todo = Object.keys(live)
    .filter(r => !clients.has(r) && !pending.has(r))
    .map(route => ({ route, busy: isBusy(route) }))
    .sort((a, b) => Number(b.busy) - Number(a.busy))
  if (!todo.length) return
  const owner = live.dm?.chat_id ?? loadAccess().allowFrom[0]
  const restored: { route: string; busy: boolean }[] = []
  for (const { route, busy } of todo) {
    const resume = resumeArg(route)
    const why = !resume ? 'no session id' : route === 'dm' && !cfg.dm.spawn ? 'dm.spawn is off'
      : clients.size + pending.size >= cfg.maxSessions ? `session limit ${cfg.maxSessions}` : ''
    if (why) {
      log(`not resuming ${route}: ${why}`)
      dropLive(route)
      continue
    }
    const { chat_id, thread } = route === 'dm' ? { chat_id: owner, thread: undefined } : parseRoute(route)
    resuming.set(route, { busy, chat_id, thread })
    if (openSession(route, chat_id, thread, resume)) restored.push({ route, busy })
  }
  if (!restored.length || !owner) return
  const busyOnes = restored.filter(r => r.busy)
  notify(owner, undefined, [
    `♻️ Компьютер перезапускался — восстанавливаю сессии (${restored.length}): ${restored.map(r => labelOf(r.route)).join(', ')}.`,
    busyOnes.length ? `Продолжат прерванную работу: ${busyOnes.map(r => labelOf(r.route)).join(', ')}.` : 'Незаконченных задач не было.',
  ].join('\n'))
}

// ---- Closing sessions and the session limit ---------------------------------

type Proc = { pid: number; ppid: number; name: string; cmd: string }

/** Marker the launcher looks for once claude exits: present = closed by /stop. */
function stopFlag(route: string): string {
  return routeFile('stop', route)
}

async function processTable(): Promise<Map<number, Proc>> {
  const table = new Map<number, Proc>()
  try {
    if (process.platform === 'win32') {
      const p = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { stdout: 'pipe', stderr: 'ignore' })
      for (const r of JSON.parse(await new Response(p.stdout).text()) as any[]) {
        table.set(r.ProcessId, { pid: r.ProcessId, ppid: r.ParentProcessId, name: String(r.Name ?? ''), cmd: String(r.CommandLine ?? '') })
      }
    } else {
      const p = Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,comm='], { stdout: 'pipe', stderr: 'ignore' })
      for (const line of (await new Response(p.stdout).text()).split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
        if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!.split('/').pop()!, cmd: m[3]! })
      }
    }
  } catch (err) {
    log('process list failed:', String(err))
  }
  return table
}

/** The claude process that runs a session's channel server (a few bun wrappers up). */
function claudeOf(table: Map<number, Proc>, pid: number): Proc | undefined {
  for (let p = table.get(pid), i = 0; p && i < 6; p = table.get(p.ppid), i++) {
    if (/^claude(\.exe)?$/i.test(p.name)) return p
  }
  return undefined
}

async function killTree(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') await Bun.spawn(['taskkill', '/PID', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' }).exited
    else process.kill(pid, 'SIGTERM')
  } catch {}
}

/**
 * Closes sessions: kills each one's claude process (or, when it can't be
 * found, the channel server, which at least frees the route). The launcher
 * then sees its stop flag and closes the terminal tab. Resolves to the routes
 * whose session disconnected.
 */
async function stopSessions(list: string[]): Promise<string[]> {
  const targets = list.map(r => clients.get(r)).filter((c): c is Client => !!c)
  if (!targets.length) return []
  const table = await processTable()
  for (const c of targets) {
    const claude = c.pid ? claudeOf(table, c.pid) : undefined
    const pid = claude?.pid ?? c.pid
    if (!pid) continue
    mkdirSync(dirname(stopFlag(c.route)), { recursive: true })
    writeFileSync(stopFlag(c.route), new Date().toISOString())
    dropLive(c.route)
    log(`closing session ${c.route}: ${claude ? `claude pid ${pid}` : `channel server pid ${pid} (no claude process found)`}`)
    await killTree(pid)
    // Tabs opened by an older launcher have no stop-flag check and would sit
    // at a PowerShell prompt: close that shell — only if it runs our launcher.
    const shell = claude && table.get(claude.ppid)
    const launcher = launcherPath(c.route)
    if (shell && launcher && /^(powershell|pwsh)(\.exe)?$/i.test(shell.name) && shell.cmd.toLowerCase().includes(launcher.toLowerCase())) {
      setTimeout(() => {
        if (!existsSync(stopFlag(c.route))) return
        rmSync(stopFlag(c.route), { force: true })
        void killTree(shell.pid)
      }, 4000)
    }
  }
  const gone = (c: Client) => clients.get(c.route)?.ws !== c.ws
  for (const end = Date.now() + 10_000; Date.now() < end && !targets.every(gone); ) await Bun.sleep(200)
  return targets.filter(gone).map(c => c.route)
}

function setMaxSessions(n: number): void {
  const old = cfg.maxSessions
  cfg.maxSessions = n
  updateConfigFile({ maxSessions: n })
  log(`session limit ${old} → ${n}`)
}

// Sessions that never connected: tell the topic once, keep the queue for a
// late connect until it expires.
setInterval(() => {
  const now = Date.now()
  const before = JSON.stringify([[...pending.keys()], [...queues].map(([k, q]) => [k, q.length])])
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
  if (JSON.stringify([[...pending.keys()], [...queues].map(([k, q]) => [k, q.length])]) !== before) saveQueue()
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
        if (url.pathname === '/control' && req.method === 'POST') {
          if (req.headers.get('x-tg-router-secret') !== SECRET) return new Response('forbidden', { status: 403 })
          return (async () => {
            const body = (await req.json().catch(() => ({}))) as { stop?: string[]; maxSessions?: number; idleCloseMin?: number; send?: { to?: string; text?: string; files?: string[] }; peers?: boolean }
            if (Array.isArray(body.stop)) return Response.json({ closed: await stopSessions(body.stop.map(String)) })
            if (body.peers) return Response.json({ sessions: peerList() })
            if (body.send) {
              // From the terminal (tgt send): same delivery as a session's hand-off.
              try {
                const text = String(body.send.text ?? '').trim()
                if (!text) throw new Error('text is empty')
                const r = resolvePeer(String(body.send.to ?? ''))
                if (!r.route) throw new Error(r.error)
                return Response.json(handOff(undefined, 'Терминал', r.route, text, (body.send.files ?? []).map(String)))
              } catch (err) {
                return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
              }
            }
            if (body.idleCloseMin !== undefined) {
              const v = body.idleCloseMin
              if (!Number.isInteger(v) || (v !== 0 && (v < IDLE_MIN || v > IDLE_MAX))) return Response.json({ error: `idleCloseMin: 0 or ${IDLE_MIN}..${IDLE_MAX}` }, { status: 400 })
              const old = cfg.idleCloseMin
              setIdleClose(v)
              return Response.json({ idleCloseMin: v, old })
            }
            const n = body.maxSessions
            if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_SESSIONS_CAP) {
              const old = cfg.maxSessions
              setMaxSessions(n)
              return Response.json({ maxSessions: n, old })
            }
            return Response.json({ error: 'expected {stop: [routes]} or {maxSessions: 1..' + MAX_SESSIONS_CAP + '}' }, { status: 400 })
          })()
        }
        if (url.pathname === '/status') {
          return Response.json({
            version: PLUGIN_VERSION,
            bot: botUsername,
            maxSessions: cfg.maxSessions,
            idleCloseMin: cfg.idleCloseMin,
            sessions: [...clients.values()].map(c => ({ route: c.route, ...infoFor(c.route), dir: c.dir, pid: c.pid, since: new Date(c.since).toISOString() })),
            starting: [...pending.keys()],
            live: Object.keys(live),
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
          if (m.t === 'rpc') {
            // Only a registered session (it passed the secret in hello) may call.
            const from = ws.data.route
            const answer = (body: Record<string, unknown>) => { try { ws.send(JSON.stringify({ t: 'rpc_result', id: m.id, ...body })) } catch {} }
            if (!from || clients.get(from)?.ws !== ws) return answer({ error: 'this session is not registered with the router' })
            void handleRpc(from, String(m.op), m.args ?? {}).then(
              result => answer({ result }),
              err => answer({ error: err instanceof Error ? err.message : String(err) }),
            )
            return
          }
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
          lastActive.set(route, Date.now())
          if (pending.delete(route)) saveQueue()
          ws.send(JSON.stringify({ t: 'welcome', route, info: infoFor(route) }))
          log(`session connected: ${route}${old ? ' (replaced previous)' : ''} pid=${m.pid} dir=${m.dir}`)
          markLive(route)
          const r = resuming.get(route)
          resuming.delete(route)
          if (r?.busy && r.chat_id) {
            ws.send(JSON.stringify({ t: 'resume', text: RESUME_PROMPT, chat_id: r.chat_id, thread: r.thread, info: infoFor(route) }))
            log(`asked ${route} to continue its interrupted task`)
          }
          flush(route)
        },
        close(ws) {
          const route = ws.data.route
          if (route && clients.get(route)?.ws === ws) {
            clients.delete(route)
            log(`session disconnected: ${route}`)
            clearTimeout(dropTimers.get(route))
            dropTimers.set(route, setTimeout(() => { if (!clients.has(route) && !pending.has(route)) dropLive(route) }, LIVE_DROP_MS))
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
  // Sessions that survived (only the router restarted) reconnect within
  // seconds; whatever is still missing afterwards went down with the computer.
  if (cfg.resumeOnStart) setTimeout(() => { try { resumeSessions() } catch (err) { log('resume failed:', String(err)) } }, cfg.resumeGraceSec * 1000)

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
