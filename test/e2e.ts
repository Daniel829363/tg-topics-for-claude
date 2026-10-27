/**
 * End-to-end test: mock Bot API + real router + the overlaid official plugin
 * in fake sessions. Needs the official telegram plugin installed (its
 * node_modules are reused).
 *   bun test/e2e.ts
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync } from 'fs'
import { join } from 'path'
import { installsOf, OFFICIAL_KEY, OVERLAY_DIR, OVERLAY_FILES } from '../plugins/tg-topics/lib/common.ts'

const T = import.meta.dir
const PLUGIN = join(T, '..', 'plugins', 'tg-topics')
const TMP = join(T, 'tmp')
const MOCK = 'http://127.0.0.1:18081'
const ROUTER = 'http://127.0.0.1:18789'

rmSync(TMP, { recursive: true, force: true })

// The official plugin with our overlay on top, as tgt setup would leave it.
const official = installsOf(OFFICIAL_KEY).find(i => existsSync(join(i.installPath, 'node_modules')))
if (!official) {
  console.error(`${OFFICIAL_KEY} with node_modules not found — install it and start a Telegram session once`)
  process.exit(2)
}
const PLUGIN_COPY = join(TMP, 'plugin-copy')
cpSync(official.installPath, PLUGIN_COPY, { recursive: true, filter: src => !src.includes('.in_use') })
for (const f of OVERLAY_FILES) cpSync(join(OVERLAY_DIR, f), join(PLUGIN_COPY, f))

const STATE_TG = join(TMP, 'tg-state')
mkdirSync(STATE_TG, { recursive: true })
writeFileSync(join(STATE_TG, '.env'), 'TELEGRAM_BOT_TOKEN=123:TEST\n')
writeFileSync(join(STATE_TG, 'access.json'), JSON.stringify({
  dmPolicy: 'allowlist',
  allowFrom: ['111'],
  groups: { '-1001': { requireMention: false, allowFrom: [] }, '-1002': { requireMention: true, allowFrom: [] } },
  pending: {},
}))
writeFileSync(join(TMP, 'config.json'), JSON.stringify({
  port: 18789,
  topicsRoot: join(TMP, 'topics'),
  launcher: 'command',
  command: ['bun', join(T, 'fake-session.ts')],
  dm: { spawn: true, dir: join(TMP, 'dm') },
  plugin: { autoPatch: false },
  resumeGraceSec: 30,
}))
mkdirSync(join(TMP, 'dm'), { recursive: true })
// A Claude Code login for /limits, which then asks the mock instead of Anthropic.
mkdirSync(join(TMP, 'claude'), { recursive: true })
writeFileSync(join(TMP, 'claude', '.credentials.json'), JSON.stringify({
  claudeAiOauth: { accessToken: 'test-oauth', expiresAt: Date.now() + 86400_000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' },
}))

const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: join(TMP, 'claude'),
  TG_TOPICS_USAGE_URL: `${MOCK}/_usage`,
  TELEGRAM_API_ROOT: MOCK,
  TELEGRAM_STATE_DIR: STATE_TG,
  TG_ROUTER_HOME: join(TMP, 'home'),
  TG_ROUTER_CONFIG: join(TMP, 'config.json'),
  TG_ROUTER_STATE: join(TMP, 'router-state'),
  TG_ROUTER_LOG: join(TMP, 'router.log'),
  TG_TEST_PLUGIN: PLUGIN_COPY,
  TG_TEST_OUT: TMP,
  TG_TEST_TOPICS: PLUGIN,
}
delete (env as any).TELEGRAM_ROUTE
delete (env as any).TELEGRAM_TOPIC_DIR
delete (env as any).TELEGRAM_BOT_TOKEN

let failures = 0
function check(cond: unknown, label: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms: number, label: string): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v as T
    await Bun.sleep(250)
  }
  console.log(`  (timeout waiting for: ${label})`)
  return undefined
}

const sent = async (): Promise<any[]> => (await fetch(`${MOCK}/_sent`)).json() as Promise<any[]>
const menus = async (): Promise<{ calls: number; commands: Record<string, { command: string; description: string }[]> }> => (await fetch(`${MOCK}/_commands`)).json() as any
const status = async (): Promise<any> => { try { return await (await fetch(`${ROUTER}/status`)).json() } catch { return null } }
const sessions = (): any[] => existsSync(join(TMP, 'sessions.jsonl'))
  ? readFileSync(join(TMP, 'sessions.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : []
const marker = () => { try { return JSON.parse(readFileSync(join(STATE_TG, 'bot-commands.json'), 'utf8')) } catch { return {} } }

let msgId = 1
const user = (id: number, lang = 'ru') => ({ id, is_bot: false, first_name: 'U', username: `user${id}`, language_code: lang })
function groupMsg(chat: number, thread: number | undefined, text: string, extra: any = {}): any {
  return {
    message: {
      message_id: msgId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chat, type: 'supergroup', title: chat === -1001 ? 'Тест группа' : chat === -1002 ? 'Вторая' : 'Чужая', is_forum: true },
      from: user(111),
      ...(thread != null ? { message_thread_id: thread, is_topic_message: true } : {}),
      text,
      ...extra,
    },
  }
}
function dm(from: number, text: string, lang = 'ru'): any {
  return { message: { message_id: msgId++, date: 0, chat: { id: from, type: 'private' }, from: user(from, lang), text } }
}
/** A command message, with the bot_command entity Telegram adds. */
function cmd(u: any): any {
  const t: string = u.message.text
  u.message.entities = [{ type: 'bot_command', offset: 0, length: t.split(' ')[0]!.length }]
  return u
}
const topicRoot = (thread: number, name: string) => ({
  message_id: thread, date: 0, chat: { id: -1001, type: 'supergroup', is_forum: true },
  from: { id: 111, is_bot: false, first_name: 'U' }, message_thread_id: thread, is_topic_message: true,
  forum_topic_created: { name, icon_color: 0 },
})
const push = (u: any) => fetch(`${MOCK}/_push`, { method: 'POST', body: JSON.stringify(u) })
const replyTo = async (chat: number, re: RegExp, ms = 8000) =>
  waitFor(async () => (await sent()).find(m => Number(m.chat_id) === chat && re.test(String(m.text ?? ''))), ms, `reply ${re} in ${chat}`)

const procs: Bun.Subprocess[] = []
const mock = Bun.spawn(['bun', join(T, 'mock-telegram.ts')], { env, stdout: 'ignore', stderr: 'inherit' })
procs.push(mock)
await Bun.sleep(500)
const startRouter = () => Bun.spawn(['bun', join(PLUGIN, 'router', 'router.ts')], { env, stdout: 'ignore', stderr: 'inherit' })
let router = startRouter()
await waitFor(status, 5000, 'router up')

try {
  // ---- A: one session per topic, queued delivery, replies in the right thread
  await push({ message: { ...topicRoot(10, 'Видео монтаж'), chat: { id: -1001, type: 'supergroup', title: 'Тест группа', is_forum: true } } })
  await push(groupMsg(-1001, 10, 'задача A', { reply_to_message: topicRoot(10, 'Видео монтаж') }))
  await push(groupMsg(-1001, 20, 'задача B', { reply_to_message: topicRoot(20, 'Сценарии') }))
  await push(groupMsg(-1002, 5, 'без упоминания'))
  await push(groupMsg(-1002, 5, '@test_bot привет', { entities: [{ type: 'mention', offset: 0, length: 9 }] }))
  await push(dm(111, 'привет в личку'))
  await push(groupMsg(-1001, 10, 'задача A2'))

  const echoes = await waitFor(async () => {
    const s = (await sent()).filter(m => String(m.text ?? '').startsWith('echo['))
    return s.length >= 5 ? s : undefined
  }, 60_000, '5 echo replies')
  const byText = (t: string) => echoes?.find(m => m.text.endsWith(t))
  check(byText('задача A')?.message_thread_id == 10 && byText('задача A')?.text.startsWith('echo[-1001:10]'), 'topic 10 answered by its own session, in thread 10')
  check(byText('задача A2')?.text.startsWith('echo[-1001:10]'), 'second topic-10 message went to the same session (queued while starting)')
  check(byText('задача B')?.message_thread_id == 20 && byText('задача B')?.text.startsWith('echo[-1001:20]'), 'topic 20 → separate session, thread 20')
  check(byText('@test_bot привет')?.message_thread_id == 5, 'mention-gated group: mentioned message answered in thread 5')
  check(!echoes?.some(m => m.text.endsWith('без упоминания')), 'unmentioned message did not spawn / was not delivered')
  check(byText('привет в личку') && byText('привет в личку').message_thread_id == null && byText('привет в личку').text.startsWith('echo[dm]'), 'DM → main (dm) session, no thread')

  const spawned = sessions().filter(s => s.kind === 'spawned')
  check(spawned.length === 4, `exactly 4 sessions spawned (got ${spawned.length}: ${spawned.map(s => s.route).join(', ')})`)

  const inbound = sessions().filter(s => s.kind === 'inbound' && s.route === '-1001:10')
  const meta = inbound[0]?.data.meta ?? {}
  check(meta.topic === 'Видео монтаж' && meta.thread_id === '10' && meta.chat_title === 'Тест группа', `meta carries topic/thread/chat_title (${JSON.stringify(meta)})`)
  const inbound20 = sessions().find(s => s.kind === 'inbound' && s.route === '-1001:20')
  check(inbound20?.data.meta.topic === 'Сценарии', 'topic name learned from reply_to_message.forum_topic_created')

  const notices = (await sent()).filter(m => String(m.text ?? '').startsWith('🚀'))
  check(notices.some(n => n.message_thread_id == 10 && n.text.includes('Видео монтаж')), 'spawn notice posted into topic 10')

  const ws = join(TMP, 'topics', 'test-gruppa', 'video-montazh-10')
  check(['CLAUDE.md', 'INSTRUCTIONS.md', 'MEMORY.md', '.tg/start.ps1', '.tg/topic.json'].every(f => existsSync(join(ws, f))), `workspace files created in ${ws}`)
  check(readFileSync(join(ws, 'CLAUDE.md'), 'utf8').includes('«Видео монтаж»') && readFileSync(join(ws, 'CLAUDE.md'), 'utf8').includes('@MEMORY.md'), 'CLAUDE.md rendered with topic name and memory import')
  const hist = existsSync(join(ws, 'history.jsonl')) ? readFileSync(join(ws, 'history.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  check(hist.some(h => h.dir === 'in' && h.text === 'задача A') && hist.some(h => h.dir === 'out'), 'history.jsonl records inbound and outbound')

  // ---- M: command menu written on first connect
  const m1 = await menus()
  const ruPrivate = m1.commands['all_private_chats|ru']?.map(c => c.command) ?? []
  check(['start', 'help', 'setup', 'id', 'status', 'sessions', 'stop', 'maxsessions', 'limits'].every(c => ruPrivate.includes(c)), `private menu (ru) set on first connect: ${ruPrivate.join(' ')}`)
  check(m1.commands['all_group_chats|']?.some(c => c.command === 'id') && m1.commands['default|']?.length, 'group and default menus set (old menus of a reused bot overwritten)')
  check(marker().bot_id === 999, 'menu marker remembers the bot it was written for')
  const callsAfterFirst = m1.calls

  // ---- K: bot commands answered by the router, never forwarded to Claude
  await push(cmd(dm(111, '/help')))
  const help = await replyTo(111, /Справка/)
  check(help?.parse_mode === 'HTML' && help.text.includes('/setup'), '/help in DM answered by the router (HTML, lists /setup)')
  await push(cmd(dm(111, '/setup')))
  const setup = await replyTo(111, /Команды для терминала/)
  check(setup?.text.includes('/telegram:access group add') && setup.text.includes('<code>'), '/setup lists terminal commands in copyable <code>')
  await push(cmd(dm(111, '/help', 'en')))
  check(await replyTo(111, /^📖 <b>Help<\/b>/), '/help for an English-language user comes in English')
  await push(cmd(groupMsg(-1003, 7, '/id')))
  const idReply = await replyTo(-1003, /group add -1003/)
  check(idReply?.message_thread_id == 7 && idReply.text.includes('не подключена') && idReply.text.includes('--allow 111'), '/id in an unconnected group (owner) → status + ready group add command, in its thread')
  await push(cmd(groupMsg(-1003, 7, '/id', { from: user(222) })))
  await push(cmd(dm(333, '/start')))
  await push(cmd(groupMsg(-1001, 10, '/sessions')))
  const sess = await replyTo(-1001, /Сессии Claude/)
  check(sess?.text.includes('Тест группа / Видео монтаж') && sess.text.includes('Личка (основная)'), '/sessions lists running sessions with topic names')
  await push(cmd(dm(111, '/limits')))
  const lim = await replyTo(111, /Лимиты Claude/)
  check(lim?.parse_mode === 'HTML' && lim.text.includes('Max 5x') && lim.text.includes('Неделя, все модели: <b>56%</b>') && lim.text.includes('🔴 Неделя, Fable: <b>93%</b>'),
    '/limits in DM: plan, usage per limit with a red mark near the cap')
  await push(cmd(groupMsg(-1001, 20, '/limits', { from: user(222) })))
  await Bun.sleep(1500)
  const all = await sent()
  check(!all.some(m => Number(m.chat_id) === -1001 && String(m.text).includes('Лимиты Claude')), '/limits from a non-owner group member gets no reply')
  check(!all.some(m => Number(m.chat_id) === -1003 && String(m.text).includes('user222')), 'stranger in an unconnected group gets no reply')
  check(!all.some(m => Number(m.chat_id) === 333), 'stranger DM in allowlist mode: /start ignored')
  check(!sessions().some(s => s.kind === 'inbound' && String(s.data.content).startsWith('/')), 'commands never reach a Claude session')
  check(!sessions().some(s => s.kind === 'spawned' && s.route === '-1003:7'), 'command in an unconnected group did not spawn a session')

  // ---- B: router restart — sessions reconnect, routing keeps working, menu not rewritten
  router.kill()
  await router.exited
  router = startRouter()
  const st = await waitFor(async () => { const s = await status(); return s?.sessions?.length === 4 ? s : undefined }, 20_000, '4 sessions reconnect')
  check(st, 'all 4 sessions reconnected after router restart')
  await push(groupMsg(-1001, 10, 'после рестарта'))
  const after = await waitFor(async () => (await sent()).find(m => String(m.text).endsWith('после рестарта')), 15_000, 'reply after restart')
  check(after?.text.startsWith('echo[-1001:10]') && after?.message_thread_id == 10, 'after restart topic 10 still served by its session')
  check(sessions().filter(s => s.kind === 'spawned').length === 4, 'no new session spawned for an already-active topic')
  check((await menus()).calls === callsAfterFirst, 'same bot after restart → command menu not rewritten')

  // ---- C: router down → dm session polls itself; router back → hands over
  router.kill()
  await router.exited
  await Bun.sleep(36_000)
  await push(dm(111, 'роутер лежит'))
  const fallback = await waitFor(async () => (await sent()).find(m => String(m.text).endsWith('роутер лежит')), 15_000, 'dm fallback reply')
  check(fallback?.text.startsWith('echo[dm]'), 'with router down, main session falls back to polling')
  await push(cmd(dm(111, '/sessions')))
  check(await replyTo(111, /Роутер тем не запущен/), 'polling mode: the channel server answers commands itself')
  await push(cmd(dm(111, '/limits', 'en')))
  check(await replyTo(111, /Claude usage limits.*Session \(5 h\): <b>5%<\/b>/s), 'polling mode: /limits answered by the channel server too')

  router = startRouter()
  await waitFor(async () => { const s = await status(); return s?.sessions?.some((c: any) => c.route === 'dm') ? s : undefined }, 25_000, 'dm hands over to router')
  await Bun.sleep(2000)
  await push(groupMsg(-1001, 20, 'роутер вернулся'))
  const back = await waitFor(async () => (await sent()).find(m => String(m.text).endsWith('роутер вернулся')), 15_000, 'reply after handover')
  check(back?.text.startsWith('echo[-1001:20]'), 'after router returns, topic messages go to topic session again')

  // ---- D: token switched to another bot → menu rewritten for it
  writeFileSync(join(STATE_TG, '.env'), 'TELEGRAM_BOT_TOKEN=456:NEW\n')
  const switched = await waitFor(() => marker().bot_id === 998, 15_000, 'menu for the new bot')
  check(switched && (await menus()).calls > callsAfterFirst, 'new bot token → command menu written for the new bot')
  const health = await (await fetch(`${ROUTER}/health`)).json() as any
  check(health.bot === 'new_bot', `router now polls as the new bot (@${health.bot})`)

  // ---- E: /stop closes sessions, /maxsessions changes the limit
  await push(cmd(dm(111, '/sessions')))
  const numbered = await replyTo(111, /Сессии Claude<\/b> · 4 из 8/)
  check(numbered?.text.includes('1. 🟢') && numbered.text.includes('/stop N'), '/sessions numbers the sessions and shows "4 of 8"')
  await push(cmd(groupMsg(-1001, 20, '/stop')))
  const stopped = await replyTo(-1001, /Закрыл: Тест группа \/ Сценарии/, 20_000)
  check(stopped?.message_thread_id == 20, '/stop in a topic closes that topic\'s session, reply in its thread')
  check(!(await status())?.sessions?.some((s: any) => s.route === '-1001:20'), 'the closed session is gone from the router')
  await push(cmd(dm(111, '/stop 99')))
  check(await replyTo(111, /Какую сессию закрыть/), '/stop with a wrong number shows the numbered list')
  await push(cmd(groupMsg(-1001, 10, '/stop', { from: user(222) })))
  await push(cmd(dm(111, '/maxsessions 0')))
  check(await replyTo(111, /Нужно число от 1 до 50/), '/maxsessions rejects 0')
  await push(cmd(dm(111, '/maxsessions 3')))
  check(await replyTo(111, /Лимит сессий: 8 → <b>3<\/b>/), '/maxsessions 3 changes the limit')
  const savedCfg = JSON.parse(readFileSync(join(TMP, 'config.json'), 'utf8'))
  check(savedCfg.maxSessions === 3 && savedCfg.port === 18789, 'new limit saved to config.json, other settings kept')
  await push(groupMsg(-1001, 30, 'новая тема при лимите'))
  const limitNotice = await replyTo(-1001, /Лимит параллельных сессий \(3\) исчерпан.*\/maxsessions 7/s)
  check(limitNotice?.message_thread_id == 30, 'at the limit a new topic gets a notice with /stop and /maxsessions')
  check(!sessions().some(s => s.kind === 'spawned' && s.route === '-1001:30'), 'no session spawned over the limit')
  check((await status())?.sessions?.some((s: any) => s.route === '-1001:10'), 'a non-owner\'s /stop closed nothing')

  const tgt = (...args: string[]) => {
    const r = Bun.spawnSync(['bun', join(PLUGIN, 'scripts', 'tgt.ts'), ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
  }
  const tmax = tgt('max', '5')
  check(tmax.code === 0 && (await status())?.maxSessions === 5, `terminal: tgt max 5 → router limit 5 (${tmax.out.trim()})`)
  const tclose = tgt('close', '-1001:10')
  check(tclose.code === 0 && tclose.out.includes('закрыта') && !(await status())?.sessions?.some((s: any) => s.route === '-1001:10'), `terminal: tgt close <route> (${tclose.out.trim()})`)
  check((await fetch(`${ROUTER}/control`, { method: 'POST', body: JSON.stringify({ maxSessions: 9 }) })).status === 403, '/control without the secret is refused')
  await push(groupMsg(-1001, 20, 'тема снова'))
  const again = await waitFor(async () => (await sent()).find(m => String(m.text).endsWith('тема снова')), 60_000, 'closed topic restarts')
  check(again?.text.startsWith('echo[-1001:20]'), 'a closed topic starts a new session on its next message')
  const reopened = sessions().filter(s => s.kind === 'spawned' && s.route === '-1001:20').at(-1)
  check(reopened && !reopened.data.resume, 'a topic closed with /stop starts fresh, not resumed')

  // ---- F: power loss — router and all sessions die at once; the router reopens them
  const busyFile = (route: string) => join(TMP, 'router-state', 'busy', route.replace(/[^\w-]/g, '_'))
  await push(groupMsg(-1001, 20, 'долгая задача'))
  await waitFor(async () => (await sent()).find(m => String(m.text).endsWith('долгая задача')), 15_000, 'long task delivered')
  const before = await status()
  const liveBefore: string[] = [...(before?.live ?? [])].sort()
  check(liveBefore.join() === ['-1001:20', '-1002:5', 'dm'].join(), `live.json lists the running sessions (${liveBefore.join(', ')})`)
  check(existsSync(busyFile('-1001:20')) && !existsSync(busyFile('-1002:5')), 'the route mid-task is marked busy, finished ones are not')
  check(JSON.parse(readFileSync(join(TMP, 'router-state', 'sessions', '-1001_20.json'), 'utf8')).session_id === 'fake--1001:20', 'SessionStart hook saved the session id')
  router.kill()
  await router.exited
  for (const s of sessions().filter(s => s.kind === 'spawned')) { try { process.kill(s.pid) } catch {} }
  await Bun.sleep(3000)
  const spawnedBefore = sessions().filter(s => s.kind === 'spawned').length
  router = startRouter()
  const back2 = await waitFor(async () => { const s = await status(); return s?.sessions?.length === liveBefore.length ? s : undefined }, 70_000, 'sessions resumed')
  const resumed = sessions().filter(s => s.kind === 'spawned').slice(spawnedBefore)
  check(back2 && resumed.map(s => s.route).sort().join() === liveBefore.join(), `after the "power loss" every live session was reopened (${resumed.map(s => s.route).join(', ')})`)
  check(resumed.every(s => s.data.resume === `fake-${s.route}`), 'each one resumed its own conversation (--resume <saved id>)')
  const cont = await waitFor(async () => (await sent()).find(m => String(m.text).startsWith('echo[-1001:20]: ⚡')), 15_000, 'resume prompt answered')
  check(cont?.message_thread_id == 20, 'the session that was mid-task got the "continue" prompt and answered in its topic')
  await Bun.sleep(1500)
  check(!sessions().some(s => s.kind === 'inbound' && s.route !== '-1001:20' && String(s.data.content).startsWith('⚡')), 'idle sessions were reopened without a prompt')
  check(await replyTo(111, /♻️.*восстанавливаю сессии \(3\).*Продолжат прерванную работу: Тест группа \/ Сценарии/s), 'the owner gets one DM listing the restored sessions')
} finally {
  router.kill()
  for (const s of sessions().filter(s => s.kind === 'spawned')) { try { process.kill(s.pid) } catch {} }
  for (const p of procs) p.kill()
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
console.log(`router log: ${join(TMP, 'router.log')}`)
process.exit(failures ? 1 : 0)
