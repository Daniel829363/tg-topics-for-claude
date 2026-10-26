/**
 * tg-topics — the bot's command menu and the texts behind /start, /help,
 * /setup, /id, /status, /sessions, /stop, /maxsessions and /limits.
 *
 * Shared by tg-router (which answers commands itself while it runs) and the
 * overlaid telegram channel server (which answers them when no router is
 * running). This file is copied next to the official plugin's server.ts, so
 * it must stay self-contained: node built-ins only, no imports from tg-topics.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'

export type Lang = 'ru' | 'en'

// Telegram app languages that get the Russian menu and texts; others get English.
const RU_LANGS = ['ru', 'uk', 'be', 'kk', 'uz']

export function langOf(code: string | undefined): Lang {
  if (!code) return 'ru'
  return RU_LANGS.includes(code.slice(0, 2).toLowerCase()) ? 'ru' : 'en'
}

// ---- Command menu -------------------------------------------------------------

type MenuItem = { command: string; ru: string; en: string }

const PRIVATE_MENU: MenuItem[] = [
  { command: 'start', ru: 'Начало работы', en: 'Get started' },
  { command: 'help', ru: 'Подробная справка', en: 'Detailed help' },
  { command: 'setup', ru: 'Команды для терминала: группы, люди, токен', en: 'Terminal commands: groups, people, token' },
  { command: 'id', ru: 'Мой Telegram ID', en: 'My Telegram ID' },
  { command: 'status', ru: 'Есть ли у меня доступ', en: 'My access status' },
  { command: 'sessions', ru: 'Запущенные сессии Claude', en: 'Running Claude sessions' },
  { command: 'stop', ru: 'Закрыть сессию: /stop N или /stop all', en: 'Close a session: /stop N or /stop all' },
  { command: 'maxsessions', ru: 'Лимит сессий: /maxsessions 12', en: 'Session limit: /maxsessions 12' },
  { command: 'limits', ru: 'Лимиты Claude: сессия и неделя', en: 'Claude usage limits: session and week' },
]

const GROUP_MENU: MenuItem[] = [
  { command: 'help', ru: 'Справка', en: 'Help' },
  { command: 'id', ru: 'ID группы и темы + команда подключения', en: 'Group and topic ID + connect command' },
  { command: 'setup', ru: 'Команды для терминала', en: 'Terminal commands' },
  { command: 'sessions', ru: 'Запущенные сессии Claude', en: 'Running Claude sessions' },
  { command: 'stop', ru: 'Закрыть сессию этой темы', en: "Close this topic's session" },
  { command: 'maxsessions', ru: 'Лимит параллельных сессий', en: 'Parallel session limit' },
  { command: 'limits', ru: 'Лимиты Claude', en: 'Claude usage limits' },
]

export const KNOWN_COMMANDS = new Set(['start', 'help', 'setup', 'id', 'status', 'sessions', 'stop', 'maxsessions', 'limits'])

/** Upper bound for /maxsessions — every session is a full Claude Code process. */
export const MAX_SESSIONS_CAP = 50

function menu(items: MenuItem[], lang: Lang): { command: string; description: string }[] {
  return items.map(i => ({ command: i.command, description: i[lang] }))
}

export function commandsHash(): string {
  return createHash('sha1').update(JSON.stringify({ PRIVATE_MENU, GROUP_MENU, RU_LANGS })).digest('hex').slice(0, 12)
}

export type ApiCall = (method: string, params: Record<string, unknown>) => Promise<any>

/** Minimal Bot API caller for code that doesn't have grammy at hand. */
export function apiCaller(apiRoot: string, token: string): ApiCall {
  return async (method, params) => {
    const res = await fetch(`${apiRoot}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000),
    })
    const j = (await res.json()) as { ok: boolean; result: unknown; description?: string }
    if (!j.ok) throw new Error(`${method}: ${j.description}`)
    return j.result
  }
}

export const COMMANDS_MARKER = 'bot-commands.json'

/**
 * Keeps the bot's command menu in sync. The full menu is (re)written for a
 * bot we haven't set up yet — first connect, or the token now belongs to a
 * different bot — and when this version's menu differs from the one written.
 * Otherwise it costs one getMyCommands call, which also catches an unpatched
 * upstream server having overwritten the menu.
 */
export async function ensureBotCommands(
  call: ApiCall,
  stateDir: string,
  opts: { force?: boolean; me?: { id: number; username: string } } = {},
): Promise<{ changed: boolean; reason: string; username: string }> {
  const me = opts.me ?? ((await call('getMe', {})) as { id: number; username: string })
  const hash = commandsHash()
  const markerFile = join(stateDir, COMMANDS_MARKER)
  let marker: { bot_id?: number; hash?: string } = {}
  try { marker = JSON.parse(readFileSync(markerFile, 'utf8')) } catch {}

  let reason = opts.force ? 'forced' : ''
  if (!reason && marker.bot_id == null) reason = 'first connect'
  if (!reason && marker.bot_id !== me.id) reason = 'new bot'
  if (!reason && marker.hash !== hash) reason = 'menu changed'
  if (!reason) {
    const current = (await call('getMyCommands', { scope: { type: 'all_private_chats' } })) as { command: string; description: string }[]
    if (JSON.stringify(current) !== JSON.stringify(menu(PRIVATE_MENU, 'en'))) reason = 'menu was overwritten'
  }
  if (!reason) return { changed: false, reason: 'up to date', username: me.username }

  // "default" covers chats with no narrower scope and wipes menus a reused
  // bot may still carry from an earlier life.
  const scopes: [string, MenuItem[]][] = [['all_private_chats', PRIVATE_MENU], ['all_group_chats', GROUP_MENU], ['default', GROUP_MENU]]
  for (const [type, items] of scopes) {
    await call('setMyCommands', { scope: { type }, commands: menu(items, 'en') })
    for (const language_code of RU_LANGS) {
      await call('setMyCommands', { scope: { type }, language_code, commands: menu(items, 'ru') })
    }
  }
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(markerFile, JSON.stringify({ bot_id: me.id, username: me.username, hash, at: new Date().toISOString() }, null, 2) + '\n')
  return { changed: true, reason, username: me.username }
}

// ---- Command handling ------------------------------------------------------------

/** The text of a known command addressed to this bot, or null. */
export function parseCommand(msg: any, botUsername: string): string | null {
  const text: unknown = msg?.text
  if (typeof text !== 'string' || !text.startsWith('/')) return null
  const ent = msg.entities?.[0]
  if (!ent || ent.type !== 'bot_command' || ent.offset !== 0) return null
  const [name, target] = text.slice(1, ent.length).split('@')
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return null
  const cmd = name!.toLowerCase()
  return KNOWN_COMMANDS.has(cmd) ? cmd : null
}

export type AccessLike = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, { requireMention?: boolean; allowFrom?: string[] }>
  pending?: Record<string, { senderId: string; expiresAt?: number }>
}

export type SessionItem = { route: string; chat_title?: string; topic?: string; since?: number; starting?: boolean }

/** What the router lets /stop and /maxsessions do. Absent when no router runs. */
export type RouterControl = {
  maxSessions: number
  /** Closes the sessions of these routes; resolves to the routes actually closed. */
  stop(routes: string[]): Promise<string[]>
  setMaxSessions(n: number): void
}

export type CommandEnv = {
  access: AccessLike
  /** Topic name if known (the Bot API can't look it up). */
  topicName?: string
  /** Router's session list; undefined when no router runs (single session). */
  sessions?: SessionItem[]
  control?: RouterControl
}

/** The command's argument: "/stop 2" → "2". */
function argOf(msg: any): string {
  const text: string = msg?.text ?? ''
  const len: number = msg?.entities?.[0]?.length ?? text.split(/\s/)[0]!.length
  return text.slice(len).trim().toLowerCase()
}

/** The router's name for the chat/topic a message came from. */
function routeOfMsg(msg: any): string {
  if (msg.chat.type === 'private') return 'dm'
  const thread = msg.chat.is_forum && msg.is_topic_message ? msg.message_thread_id : undefined
  return `${msg.chat.id}:${thread ?? 'main'}`
}

/**
 * /stop — "/stop N" closes session N of the /sessions list, "/stop all" every
 * topic session (the main DM session stays), a bare "/stop" in a topic closes
 * that topic's session. A closed topic starts again on its next message.
 */
async function stopCommand(msg: any, env: CommandEnv, t: Texts): Promise<string> {
  const list = env.sessions
  if (!list || !env.control) return t.sessions(undefined)
  const arg = argOf(msg)
  let targets: SessionItem[]
  if (!arg) {
    if (msg.chat.type === 'private') return t.stopUsage(list)
    const here = list.find(s => s.route === routeOfMsg(msg))
    if (!here) return t.stopNone()
    targets = [here]
  } else if (arg === 'all') {
    targets = list.filter(s => s.route !== 'dm')
    if (!targets.length) return t.stopNone()
  } else if (/^\d+$/.test(arg) && list[Number(arg) - 1]) {
    targets = [list[Number(arg) - 1]!]
  } else {
    return t.stopUsage(list)
  }
  const running = targets.filter(s => !s.starting)
  if (!running.length) return t.stopStarting()
  const closed = new Set(await env.control.stop(running.map(s => s.route)))
  return t.stopped(running.filter(s => closed.has(s.route)), running.filter(s => !closed.has(s.route)))
}

/** /maxsessions — show the limit, or "/maxsessions 12" to change it. */
function maxSessionsCommand(msg: any, env: CommandEnv, t: Texts): string {
  if (!env.sessions || !env.control) return t.sessions(undefined)
  const arg = argOf(msg)
  const used = env.sessions.length
  if (!arg) return t.maxShow(env.control.maxSessions, used)
  const n = Number(arg)
  if (!Number.isInteger(n) || n < 1 || n > MAX_SESSIONS_CAP) return t.maxBad(env.control.maxSessions)
  const old = env.control.maxSessions
  env.control.setMaxSessions(n)
  return t.maxSet(n, old, used)
}

/**
 * HTML reply for a known command, or null to stay silent. Same rules as the
 * channel's gate: strangers get nothing in allowlist mode and in groups that
 * weren't added; in pairing mode they only learn how to ask for access.
 * Async because /limits asks Anthropic for the numbers and /stop waits for
 * the sessions to close.
 */
export async function handleCommand(cmd: string, msg: any, env: CommandEnv): Promise<string | null> {
  const from = msg?.from
  if (!from || !msg.chat) return null
  const a = env.access
  if (a.dmPolicy === 'disabled') return null
  const sender = String(from.id)
  const owner = a.allowFrom.includes(sender)
  const lang = langOf(from.language_code)
  const t = TEXTS[lang]

  if (msg.chat.type === 'private') {
    if (!owner && a.dmPolicy !== 'pairing') return null
    const pending = Object.entries(a.pending ?? {}).find(([, p]) => p.senderId === sender && (p.expiresAt ?? Infinity) > Date.now())
    switch (cmd) {
      case 'start': return owner ? t.startOwner() : t.startGuest()
      case 'help': return owner ? t.help(env.sessions !== undefined) : t.startGuest()
      case 'setup': return owner ? t.setup(a) : t.startGuest()
      case 'id': return t.idPrivate(sender, from.username, owner ? 'yes' : pending ? 'pending' : 'no')
      case 'status': return owner ? t.statusOwner(from.username ?? sender, a) : t.statusGuest(pending?.[0])
      case 'sessions': return owner ? t.sessions(env.sessions, env.control?.maxSessions) : null
      case 'stop': return owner ? stopCommand(msg, env, t) : null
      case 'maxsessions': return owner ? maxSessionsCommand(msg, env, t) : null
      case 'limits': return owner ? limitsText(lang) : null
    }
    return null
  }

  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    const chatId = String(msg.chat.id)
    const policy = a.groups[chatId]
    const member = !!policy && (!policy.allowFrom?.length || policy.allowFrom.includes(sender))
    if (!owner && !member) return null
    const thread = msg.chat.is_forum && msg.is_topic_message ? msg.message_thread_id : undefined
    switch (cmd) {
      case 'id':
      case 'status':
        return t.idGroup({
          chatId,
          title: msg.chat.title,
          forum: !!msg.chat.is_forum,
          thread,
          topic: env.topicName ?? (msg.chat.is_forum && thread == null ? 'General' : undefined),
          sender,
          username: from.username,
          policy,
        })
      case 'start':
      case 'help':
        return t.help(env.sessions !== undefined)
      case 'setup':
        return owner ? t.setup(a) : t.help(env.sessions !== undefined)
      case 'sessions':
        return owner ? t.sessions(env.sessions, env.control?.maxSessions) : null
      case 'stop':
        return owner ? stopCommand(msg, env, t) : null
      case 'maxsessions':
        return owner ? maxSessionsCommand(msg, env, t) : null
      case 'limits':
        return owner ? limitsText(lang) : null
    }
  }
  return null
}

// ---- Claude usage limits ------------------------------------------------------------

// The endpoint behind Claude Code's /usage screen. It isn't a documented API,
// so an answer without the expected fields is reported, not guessed at.
// The token only ever goes to this URL and is never logged (tests point
// TG_TOPICS_USAGE_URL at their mock).
const USAGE_URL = process.env.TG_TOPICS_USAGE_URL ?? 'https://api.anthropic.com/api/oauth/usage'

type Creds = { accessToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string }
type LimitRow = { kind: string; percent: number; resets_at?: string; model?: string }

/** Claude Code's own login (Windows/Linux keep it in a file; macOS uses the Keychain). */
function readCreds(): Creds | null {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  try { return JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')).claudeAiOauth ?? null } catch { return null }
}

function planName(c: Creds): string {
  const tier = c.rateLimitTier?.match(/max_(\d+x)/)
  if (tier) return `Max ${tier[1]}`
  const s = c.subscriptionType ?? ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** The rows of the usage answer: the `limits` list, or the older five_hour / seven_day fields. */
function limitRows(u: any): LimitRow[] {
  if (Array.isArray(u?.limits)) {
    return u.limits
      .filter((l: any) => typeof l?.percent === 'number')
      .map((l: any) => ({ kind: String(l.kind), percent: l.percent, resets_at: l.resets_at ?? undefined, model: l.scope?.model?.display_name ?? undefined }))
  }
  const rows: LimitRow[] = []
  const add = (kind: string, w: any, model?: string) => {
    if (typeof w?.utilization === 'number') rows.push({ kind, percent: w.utilization, resets_at: w.resets_at ?? undefined, model })
  }
  add('session', u?.five_hour)
  add('weekly_all', u?.seven_day)
  add('weekly_scoped', u?.seven_day_opus, 'Opus')
  add('weekly_scoped', u?.seven_day_sonnet, 'Sonnet')
  return rows
}

/** The /limits reply. Never throws: problems come back as a readable message. */
export async function limitsText(lang: Lang): Promise<string> {
  const t = TEXTS[lang]
  const creds = readCreds()
  if (!creds?.accessToken) return t.limitsError('login')
  if (creds.expiresAt && creds.expiresAt < Date.now()) return t.limitsError('expired')
  try {
    const res = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${creds.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000),
    })
    if (res.status === 401) return t.limitsError('expired')
    if (!res.ok) return t.limitsError('failed', `HTTP ${res.status}`)
    const rows = limitRows(await res.json())
    if (!rows.length) return t.limitsError('failed', lang === 'ru' ? 'в ответе нет лимитов' : 'no limits in the answer')
    return t.limits(planName(creds), rows)
  } catch (err) {
    return t.limitsError('failed', String(err))
  }
}

/** The /setup guide as plain text — for the terminal (tgt guide). */
export function setupGuide(lang: Lang, access?: AccessLike): string {
  return toPlain(TEXTS[lang].setup(access))
}

export function toPlain(html: string): string {
  return html
    .replace(/<\/?(b|i|code|pre)>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// ---- Texts --------------------------------------------------------------------------

function esc(s: string | number | undefined): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const code = (s: string | number) => `<code>${esc(s)}</code>`

type GroupInfo = {
  chatId: string
  title?: string
  forum: boolean
  thread?: number
  topic?: string
  sender: string
  username?: string
  policy?: { requireMention?: boolean; allowFrom?: string[] }
}

type Texts = {
  startOwner(): string
  startGuest(): string
  help(router: boolean): string
  setup(access?: AccessLike): string
  idPrivate(id: string, username: string | undefined, access: 'yes' | 'pending' | 'no'): string
  idGroup(g: GroupInfo): string
  statusOwner(name: string, a: AccessLike): string
  statusGuest(code?: string): string
  sessions(list?: SessionItem[], max?: number): string
  stopUsage(list: SessionItem[]): string
  stopNone(): string
  stopStarting(): string
  stopped(closed: SessionItem[], failed: SessionItem[]): string
  maxShow(max: number, used: number): string
  maxSet(max: number, old: number, used: number): string
  maxBad(max: number): string
  limits(plan: string, rows: LimitRow[]): string
  limitsError(kind: 'login' | 'expired' | 'failed', detail?: string): string
}

function sessionName(s: SessionItem, lang: Lang): string {
  if (s.route === 'dm') return lang === 'ru' ? 'Личка (основная)' : 'Direct messages (main)'
  return esc(`${s.chat_title ?? ''} / ${s.topic ?? s.route}`)
}

/** "1. 🟢 Group / Topic — since 10:40" — the numbers /stop takes. */
function sessionLines(list: SessionItem[], lang: Lang): string[] {
  return list.map((s, i) => `${i + 1}. ${s.starting
    ? `⏳ ${sessionName(s, lang)} — ${lang === 'ru' ? 'запускается' : 'starting'}`
    : `🟢 ${sessionName(s, lang)} — ${lang === 'ru' ? 'с' : 'since'} ${time(s.since, lang)}`}`)
}

function time(ms: number | undefined, lang: Lang): string {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString(lang === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' })
}

const bar = (p: number) => '▰'.repeat(Math.min(10, Math.round(p / 10))) + '▱'.repeat(10 - Math.min(10, Math.round(p / 10)))
const dot = (p: number) => (p >= 90 ? '🔴' : p >= 70 ? '🟡' : '🟢')

/** "at 11:40 (in 1 h 54 min)" or "Oct 23, 09:00 (in 4 d 4 h)", in the computer's time zone. */
function resetAt(iso: string, lang: Lang): string {
  const at = new Date(Math.round(Date.parse(iso) / 60000) * 60000) // the API sometimes says 09:59:59.9 for 10:00
  const min = Math.max(0, Math.round((at.getTime() - Date.now()) / 60000))
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60
  const [D, H, M] = lang === 'ru' ? ['дн', 'ч', 'мин'] : ['d', 'h', 'min']
  const left = d ? `${d} ${D} ${h} ${H}` : h ? `${h} ${H} ${m} ${M}` : `${m} ${M}`
  const clock = time(at.getTime(), lang)
  if (at.toDateString() === new Date().toDateString()) return lang === 'ru' ? `в ${clock} (через ${left})` : `at ${clock} (in ${left})`
  const day = at.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', lang === 'ru' ? { day: '2-digit', month: '2-digit' } : { day: 'numeric', month: 'short' })
  return lang === 'ru' ? `${day} в ${clock} (через ${left})` : `${day}, ${clock} (in ${left})`
}

function limitLines(rows: LimitRow[], lang: Lang, name: (r: LimitRow) => string): string[] {
  return rows.flatMap(r => [
    '',
    `${dot(r.percent)} ${esc(name(r))}: <b>${Math.round(r.percent)}%</b>`,
    bar(r.percent) + (r.resets_at ? `  ${lang === 'ru' ? 'сброс' : 'resets'} ${resetAt(r.resets_at, lang)}` : ''),
  ])
}

const RU: Texts = {
  startOwner: () => [
    '👋 <b>Claude Code в Telegram</b>',
    'Пиши сюда задачи — их выполняет Claude Code на твоём компьютере, ответы приходят сюда же. Можно слать текст, фото, файлы и голосовые.',
    '',
    '/help — подробная справка',
    '/setup — что вводить в терминал: группы, люди, токен',
    '/id — твой ID',
    '/sessions — запущенные сессии',
    '/stop — закрыть сессию',
    '/maxsessions — лимит сессий',
    '/limits — лимиты Claude',
  ].join('\n'),

  startGuest: () => [
    '👋 Этот бот связывает Telegram с Claude Code на компьютере владельца.',
    '',
    '<b>Как получить доступ</b>',
    '1. Отправь /id и передай свой ID владельцу бота — он добавит тебя командой в терминале.',
    '2. Или напиши боту любое сообщение — придёт код подтверждения (если у владельца запущена основная сессия). Владелец вводит:',
    code('/telegram:access pair КОД'),
  ].join('\n'),

  help: router => [
    '📖 <b>Справка</b>',
    '',
    '<b>Как это работает</b>',
    '• Личка с ботом — основная сессия Claude Code на компьютере.',
    router
      ? '• Группа с темами — у каждой темы своя сессия со своими правилами (INSTRUCTIONS.md) и памятью (MEMORY.md). Первое сообщение в новой теме запускает её сессию — ответ через 20–30 сек.'
      : '• Роутер тем сейчас не запущен — все чаты обслуживает одна сессия. Запуск в терминале: ' + code('/tg-topics:router start'),
    '• Принимаются текст, фото, файлы и голосовые. Ответы, файлы и реакции приходят сюда.',
    '• Истории чата у бота нет — он видит только новые сообщения. Нужен контекст — перешли или перескажи.',
    '• Правила темы меняются прямо в ней: «измени инструкцию: …».',
    '• В группе бот отвечает на все сообщения или только на @упоминание — как настроено при подключении (/id покажет).',
    '',
    '<b>Разрешения</b>',
    `Если Claude просит разрешение на действие — нажми ✅/❌ под его сообщением или ответь ${code('yes код')} / ${code('no код')}.`,
    '',
    '<b>Команды бота</b>',
    '/start — начало',
    '/help — эта справка',
    '/setup — команды для терминала: подключить группу, человека, сменить токен',
    '/id — ID твой, группы и темы',
    '/status — есть ли у тебя доступ',
    '/sessions — запущенные сессии Claude (с номерами)',
    '/stop N — закрыть сессию N из /sessions; /stop all — все темы; /stop в теме — её сессию',
    '/maxsessions — лимит параллельных сессий; /maxsessions 12 — поменять',
    '/limits — сколько лимита Claude израсходовано и когда сброс',
    '',
    'Текст в рамке копируется нажатием.',
  ].join('\n'),

  setup: a => [
    '🛠 <b>Команды для терминала Claude Code</b>',
    'Вводятся в окне Claude Code на компьютере (где запущен бот), а не в этот чат. Нажми на команду — она скопируется.',
    ...(a ? ['', `Сейчас: личка — ${policyRu(a.dmPolicy)}, людей с доступом: ${a.allowFrom.length}, групп: ${Object.keys(a.groups).length}.`] : []),
    '',
    '<b>Бот и токен</b>',
    `${code('/telegram:configure ТОКЕН')} — сохранить или сменить токен от @BotFather. Роутер сам переключится на нового бота и настроит ему меню команд; открытые сессии Claude перезапусти`,
    `${code('/telegram:configure')} — проверить настройки`,
    `${code('/tg-topics:router commands --force')} — заново записать меню команд бота`,
    '',
    '<b>Люди (личка)</b>',
    `${code('/telegram:access pair КОД')} — подключить по коду, который бот прислал человеку`,
    `${code('/telegram:access allow ID')} — добавить по ID (свой ID человек узнаёт командой /id)`,
    `${code('/telegram:access remove ID')} — убрать доступ`,
    `${code('/telegram:access policy allowlist')} — закрыть бота: новые люди больше не получают коды`,
    `${code('/telegram:access policy pairing')} — снова выдавать коды новым людям`,
    '',
    '<b>Группа</b>',
    '1. Добавь бота в группу и сделай админом. Чтобы у каждой темы была своя сессия, включи в группе «Темы».',
    '2. Напиши в группе /id — бот пришлёт готовую команду с ID группы.',
    `${code('/telegram:access group add ID_ГРУППЫ')} — отвечать только на @упоминание`,
    `   + ${code('--no-mention')} — отвечать на все сообщения`,
    `   + ${code('--allow ID1,ID2')} — слушать только этих людей`,
    `${code('/telegram:access group rm ID_ГРУППЫ')} — отключить группу`,
    '',
    '<b>Сессии и роутер</b>',
    `${code('/tg-topics:router status')} — роутер, сессии, автозапуск`,
    `${code('/tg-topics:router restart')} — перезапуск роутера (сессии переподключатся сами)`,
    `${code('/tg-topics:router close N')} — закрыть сессию N (${code('close all')} — все темы)`,
    `${code('/tg-topics:router max 12')} — лимит параллельных сессий`,
    `${code('/tg-topics:help')} — эта справка в терминале`,
    '',
    '<b>Прочее</b>',
    `${code('/telegram:access')} — кто имеет доступ`,
    `${code('/telegram:access set ackReaction 👀')} — реакция «принял» на входящие`,
  ].join('\n'),

  idPrivate: (id, username, access) => [
    `🆔 Твой Telegram ID: ${code(id)}${username ? ` (@${esc(username)})` : ''}`,
    `Доступ: ${access === 'yes' ? '✅ есть' : access === 'pending' ? '⏳ ждёт подтверждения' : '❌ нет'}`,
    ...(access === 'yes' ? [] : ['', 'Владелец бота добавляет по ID в терминале Claude Code:', code(`/telegram:access allow ${id}`)]),
  ].join('\n'),

  idGroup: g => {
    const lines = [`🆔 <b>Группа «${esc(g.title ?? '')}»</b>: ${code(g.chatId)}`]
    if (g.thread != null || g.topic) lines.push(`Тема «${esc(g.topic ?? '?')}»: ${code(g.thread ?? 'main')}`)
    lines.push(`Ты: ${code(g.sender)}${g.username ? ` (@${esc(g.username)})` : ''}`, '')
    if (g.policy) {
      const allow = g.policy.allowFrom ?? []
      lines.push(
        `Статус: ✅ подключена · ${(g.policy.requireMention ?? true) ? 'отвечает только на @упоминание' : 'отвечает на все сообщения'} · ${allow.length ? `слушает: ${allow.map(esc).join(', ')}` : 'слушает всех участников'}`,
      )
    } else {
      lines.push('Статус: ❌ не подключена — бот её игнорирует')
    }
    if (!g.forum) lines.push('', 'ℹ️ Темы в группе выключены — вся группа будет одной сессией. Чтобы у каждой темы была своя, включи «Темы» в настройках группы.')
    lines.push(
      '',
      'Команды для терминала Claude Code:',
      `${code(`/telegram:access group add ${g.chatId} --no-mention --allow ${g.sender}`)} — отвечать на все сообщения, только тебе`,
      `${code(`/telegram:access group add ${g.chatId}`)} — отвечать на @упоминание, всем участникам`,
    )
    if (g.policy) lines.push(`${code(`/telegram:access group rm ${g.chatId}`)} — отключить`)
    return lines.join('\n')
  },

  statusOwner: (name, a) =>
    `✅ Доступ есть — ${esc(name)}.\nЛичка: ${policyRu(a.dmPolicy)}. Людей с доступом: ${a.allowFrom.length}. Групп подключено: ${Object.keys(a.groups).length}.`,

  statusGuest: c => c
    ? `⏳ Ждёт подтверждения. Владелец вводит в терминале Claude Code:\n${code(`/telegram:access pair ${c}`)}`
    : '❌ Доступа нет. Отправь /id и передай ID владельцу бота или напиши любое сообщение — придёт код подтверждения.',

  sessions: (list, max) => {
    if (!list) return `Роутер тем не запущен — все чаты обслуживает одна сессия.\nЗапуск в терминале: ${code('/tg-topics:router start')}`
    const limit = max ? ` · ${list.length} из ${max}` : ''
    if (!list.length) return `Нет запущенных сессий${limit}. Сессия запустится сама на первое сообщение.`
    return [`🖥 <b>Сессии Claude</b>${limit}`, ...sessionLines(list, 'ru'), '', `Закрыть: ${code('/stop N')} · все темы: ${code('/stop all')}`].join('\n')
  },

  stopUsage: list => list.length
    ? ['Какую сессию закрыть? Отправь номер:', '', ...sessionLines(list, 'ru'), '', `${code('/stop 2')} — сессию №2 · ${code('/stop all')} — все темы (личка остаётся) · ${code('/stop')} в теме — её сессию`].join('\n')
    : 'Нет запущенных сессий.',

  stopNone: () => 'Здесь нет запущенной сессии — закрывать нечего.',

  stopStarting: () => 'Сессия ещё запускается — подожди, пока она подключится, и повтори /stop.',

  stopped: (closed, failed) => [
    ...(closed.length ? [`⏹ Закрыл: ${closed.map(s => sessionName(s, 'ru')).join(', ')}.`, 'Новое сообщение в теме снова запустит её сессию — память и инструкции сохранены.'] : []),
    ...(failed.length ? [`⚠️ Не удалось закрыть: ${failed.map(s => sessionName(s, 'ru')).join(', ')} — закрой вкладку в окне Windows Terminal вручную.`] : []),
  ].join('\n'),

  maxShow: (max, used) => [
    `🔢 Лимит параллельных сессий: <b>${max}</b>, занято: ${used}.`,
    `Поменять: ${code('/maxsessions 12')} (от 1 до ${MAX_SESSIONS_CAP}). Каждая сессия — отдельный Claude Code: больше памяти компьютера и быстрее расходуются лимиты Claude.`,
  ].join('\n'),

  maxSet: (max, old, used) => [
    `✅ Лимит сессий: ${old} → <b>${max}</b>. Занято сейчас: ${used}.`,
    ...(used > max ? [`Лишние сессии работают дальше, новые не запустятся, пока их не станет меньше ${max}. Закрыть: /stop N.`] : []),
  ].join('\n'),

  maxBad: max => `Нужно число от 1 до ${MAX_SESSIONS_CAP}, например ${code('/maxsessions 12')}. Сейчас лимит: ${max}.`,

  limits: (plan, rows) => [
    `📊 <b>Лимиты Claude</b>${plan ? ` · ${esc(plan)}` : ''}`,
    ...limitLines(rows, 'ru', r =>
      r.kind === 'session' ? 'Сессия (5 ч)' : r.kind === 'weekly_all' ? 'Неделя, все модели' : r.kind === 'weekly_scoped' ? `Неделя, ${r.model ?? 'модель'}` : r.kind),
  ].join('\n'),

  limitsError: (kind, detail) =>
    kind === 'login'
      ? 'Не нашёл вход в Claude Code на этом компьютере (.credentials.json в папке .claude). Войди в Claude Code командой /login. На macOS вход хранится в связке ключей — там /limits пока не работает.'
      : kind === 'expired'
        ? 'Токен входа Claude Code устарел. Он обновится, когда любая сессия Claude Code сделает запрос: дай ей задачу и повтори /limits.'
        : `Не удалось получить лимиты: ${esc(detail)}`,
}

function policyRu(p: AccessLike['dmPolicy']): string {
  return p === 'pairing' ? 'по кодам (pairing)' : p === 'allowlist' ? 'только из списка (allowlist)' : 'выключена'
}

function policyEn(p: AccessLike['dmPolicy']): string {
  return p === 'pairing' ? 'pairing codes' : p === 'allowlist' ? 'allowlist only' : 'disabled'
}

const EN: Texts = {
  startOwner: () => [
    '👋 <b>Claude Code in Telegram</b>',
    'Send tasks here — Claude Code runs them on your computer and replies here. Text, photos, files and voice messages all work.',
    '',
    '/help — detailed help',
    '/setup — terminal commands: groups, people, token',
    '/id — your ID',
    '/sessions — running sessions',
    '/stop — close a session',
    '/maxsessions — session limit',
    '/limits — Claude usage limits',
  ].join('\n'),

  startGuest: () => [
    "👋 This bot connects Telegram to Claude Code on its owner's computer.",
    '',
    '<b>How to get access</b>',
    '1. Send /id and give your ID to the bot owner — they add you with a terminal command.',
    "2. Or send the bot any message — you'll get a pairing code (if the owner's main session is running). The owner types:",
    code('/telegram:access pair CODE'),
  ].join('\n'),

  help: router => [
    '📖 <b>Help</b>',
    '',
    '<b>How it works</b>',
    '• Direct messages go to the main Claude Code session on the computer.',
    router
      ? '• In a group with topics, every topic gets its own session with its own rules (INSTRUCTIONS.md) and memory (MEMORY.md). The first message in a new topic starts its session — the reply takes 20–30 s.'
      : '• The topic router is not running — one session serves every chat. Start it in the terminal: ' + code('/tg-topics:router start'),
    '• Text, photos, files and voice messages are accepted. Replies, files and reactions come back here.',
    '• The bot has no chat history — it only sees new messages. Forward or summarize earlier context.',
    '• Change a topic\'s rules right in it: "change the instruction: …".',
    '• In a group the bot answers every message or only @mentions — as set when the group was added (/id shows it).',
    '',
    '<b>Permissions</b>',
    `When Claude asks for permission, tap ✅/❌ under its message or reply ${code('yes code')} / ${code('no code')}.`,
    '',
    '<b>Bot commands</b>',
    '/start — start',
    '/help — this help',
    '/setup — terminal commands: add a group or a person, change the token',
    '/id — your, group and topic IDs',
    '/status — your access status',
    '/sessions — running Claude sessions (numbered)',
    '/stop N — close session N from /sessions; /stop all — every topic; /stop in a topic — its session',
    '/maxsessions — parallel session limit; /maxsessions 12 — change it',
    '/limits — how much of the Claude usage limits is used and when they reset',
    '',
    'Tap any boxed text to copy it.',
  ].join('\n'),

  setup: a => [
    '🛠 <b>Claude Code terminal commands</b>',
    'Type these in the Claude Code window on the computer running the bot, not in this chat. Tap a command to copy it.',
    ...(a ? ['', `Now: DMs — ${policyEn(a.dmPolicy)}, people with access: ${a.allowFrom.length}, groups: ${Object.keys(a.groups).length}.`] : []),
    '',
    '<b>Bot and token</b>',
    `${code('/telegram:configure TOKEN')} — save or change the token from @BotFather. The router switches to the new bot and sets up its command menu by itself; restart open Claude sessions`,
    `${code('/telegram:configure')} — check the setup`,
    `${code('/tg-topics:router commands --force')} — rewrite the bot's command menu`,
    '',
    '<b>People (DMs)</b>',
    `${code('/telegram:access pair CODE')} — approve the code the bot sent someone`,
    `${code('/telegram:access allow ID')} — add by ID (people get their ID with /id)`,
    `${code('/telegram:access remove ID')} — remove access`,
    `${code('/telegram:access policy allowlist')} — lock the bot: no more pairing codes`,
    `${code('/telegram:access policy pairing')} — hand out pairing codes again`,
    '',
    '<b>Group</b>',
    '1. Add the bot to the group and make it an admin. Turn on Topics in the group for one session per topic.',
    '2. Send /id in the group — the bot replies with a ready command containing the group ID.',
    `${code('/telegram:access group add GROUP_ID')} — answer @mentions only`,
    `   + ${code('--no-mention')} — answer every message`,
    `   + ${code('--allow ID1,ID2')} — listen to these people only`,
    `${code('/telegram:access group rm GROUP_ID')} — remove the group`,
    '',
    '<b>Sessions and router</b>',
    `${code('/tg-topics:router status')} — router, sessions, autostart`,
    `${code('/tg-topics:router restart')} — restart the router (sessions reconnect on their own)`,
    `${code('/tg-topics:router close N')} — close session N (${code('close all')} — every topic)`,
    `${code('/tg-topics:router max 12')} — parallel session limit`,
    `${code('/tg-topics:help')} — this guide in the terminal`,
    '',
    '<b>Other</b>',
    `${code('/telegram:access')} — who has access`,
    `${code('/telegram:access set ackReaction 👀')} — "got it" reaction on incoming messages`,
  ].join('\n'),

  idPrivate: (id, username, access) => [
    `🆔 Your Telegram ID: ${code(id)}${username ? ` (@${esc(username)})` : ''}`,
    `Access: ${access === 'yes' ? '✅ yes' : access === 'pending' ? '⏳ waiting for approval' : '❌ no'}`,
    ...(access === 'yes' ? [] : ['', 'The bot owner adds you by ID in the Claude Code terminal:', code(`/telegram:access allow ${id}`)]),
  ].join('\n'),

  idGroup: g => {
    const lines = [`🆔 <b>Group "${esc(g.title ?? '')}"</b>: ${code(g.chatId)}`]
    if (g.thread != null || g.topic) lines.push(`Topic "${esc(g.topic ?? '?')}": ${code(g.thread ?? 'main')}`)
    lines.push(`You: ${code(g.sender)}${g.username ? ` (@${esc(g.username)})` : ''}`, '')
    if (g.policy) {
      const allow = g.policy.allowFrom ?? []
      lines.push(
        `Status: ✅ added · ${(g.policy.requireMention ?? true) ? 'answers @mentions only' : 'answers every message'} · ${allow.length ? `listens to: ${allow.map(esc).join(', ')}` : 'listens to everyone'}`,
      )
    } else {
      lines.push('Status: ❌ not added — the bot ignores it')
    }
    if (!g.forum) lines.push('', 'ℹ️ Topics are off in this group — the whole group is one session. Turn on Topics in the group settings to get one session per topic.')
    lines.push(
      '',
      'Claude Code terminal commands:',
      `${code(`/telegram:access group add ${g.chatId} --no-mention --allow ${g.sender}`)} — answer every message, only you`,
      `${code(`/telegram:access group add ${g.chatId}`)} — answer @mentions, everyone`,
    )
    if (g.policy) lines.push(`${code(`/telegram:access group rm ${g.chatId}`)} — remove`)
    return lines.join('\n')
  },

  statusOwner: (name, a) =>
    `✅ You have access — ${esc(name)}.\nDMs: ${policyEn(a.dmPolicy)}. People with access: ${a.allowFrom.length}. Groups added: ${Object.keys(a.groups).length}.`,

  statusGuest: c => c
    ? `⏳ Waiting for approval. The owner types in the Claude Code terminal:\n${code(`/telegram:access pair ${c}`)}`
    : "❌ No access. Send /id and give the ID to the bot owner, or send any message to get a pairing code.",

  sessions: (list, max) => {
    if (!list) return `The topic router is not running — one session serves every chat.\nStart it in the terminal: ${code('/tg-topics:router start')}`
    const limit = max ? ` · ${list.length} of ${max}` : ''
    if (!list.length) return `No running sessions${limit}. One starts on the first message.`
    return [`🖥 <b>Claude sessions</b>${limit}`, ...sessionLines(list, 'en'), '', `Close: ${code('/stop N')} · every topic: ${code('/stop all')}`].join('\n')
  },

  stopUsage: list => list.length
    ? ['Which session should I close? Send its number:', '', ...sessionLines(list, 'en'), '', `${code('/stop 2')} — session #2 · ${code('/stop all')} — every topic (DMs stay) · ${code('/stop')} in a topic — its session`].join('\n')
    : 'No running sessions.',

  stopNone: () => 'No session is running here — nothing to close.',

  stopStarting: () => 'That session is still starting — wait for it to connect and send /stop again.',

  stopped: (closed, failed) => [
    ...(closed.length ? [`⏹ Closed: ${closed.map(s => sessionName(s, 'en')).join(', ')}.`, 'A new message in the topic starts its session again — memory and instructions are kept.'] : []),
    ...(failed.length ? [`⚠️ Could not close: ${failed.map(s => sessionName(s, 'en')).join(', ')} — close its tab in Windows Terminal by hand.`] : []),
  ].join('\n'),

  maxShow: (max, used) => [
    `🔢 Parallel session limit: <b>${max}</b>, in use: ${used}.`,
    `Change it: ${code('/maxsessions 12')} (1 to ${MAX_SESSIONS_CAP}). Each session is a separate Claude Code: more memory on the computer and faster use of the Claude limits.`,
  ].join('\n'),

  maxSet: (max, old, used) => [
    `✅ Session limit: ${old} → <b>${max}</b>. In use now: ${used}.`,
    ...(used > max ? [`The extra sessions keep running; new ones won't start until fewer than ${max} are open. Close one: /stop N.`] : []),
  ].join('\n'),

  maxBad: max => `Send a number from 1 to ${MAX_SESSIONS_CAP}, e.g. ${code('/maxsessions 12')}. The limit now: ${max}.`,

  limits: (plan, rows) => [
    `📊 <b>Claude usage limits</b>${plan ? ` · ${esc(plan)}` : ''}`,
    ...limitLines(rows, 'en', r =>
      r.kind === 'session' ? 'Session (5 h)' : r.kind === 'weekly_all' ? 'Week, all models' : r.kind === 'weekly_scoped' ? `Week, ${r.model ?? 'one model'}` : r.kind),
  ].join('\n'),

  limitsError: (kind, detail) =>
    kind === 'login'
      ? 'No Claude Code login found on this computer (.credentials.json in the .claude folder). Log in to Claude Code with /login. On macOS the login lives in the Keychain, where /limits does not work yet.'
      : kind === 'expired'
        ? 'The Claude Code login token is stale. It renews as soon as any Claude Code session makes a request: give one a task and send /limits again.'
        : `Could not get the limits: ${esc(detail)}`,
}

const TEXTS: Record<Lang, Texts> = { ru: RU, en: EN }
