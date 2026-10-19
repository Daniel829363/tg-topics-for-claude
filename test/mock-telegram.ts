/**
 * Minimal Telegram Bot API mock for tg-router tests.
 * Control endpoints: POST /_push {update}, GET /_sent, GET /_polls, GET /_commands.
 * GET /_usage stands in for Anthropic's usage endpoint (/limits) and wants the test token.
 * getMe answers per token: "456:NEW" is a second bot (token-change test).
 * Like the real API, a new getUpdates call terminates the one in flight with 409.
 */

const PORT = Number(process.env.MOCK_PORT ?? 18081)
const updates: any[] = []
const sent: any[] = []
let nextUpdateId = 1000
let nextMessageId = 5000
let inflight: { resolve: (r: Response) => void; timer: Timer } | null = null
const pollers: Record<string, number> = {}
const commands: Record<string, unknown[]> = {}
let setCommandsCalls = 0

function ok(result: unknown): Response {
  return Response.json({ ok: true, result })
}

async function params(req: Request): Promise<Record<string, any>> {
  const ct = req.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return (await req.json()) as Record<string, any>
  if (ct.includes('multipart/form-data') || ct.includes('urlencoded')) {
    const fd = await req.formData()
    const out: Record<string, any> = {}
    for (const [k, v] of fd.entries()) out[k] = typeof v === 'string' ? v : '[file]'
    return out
  }
  return {}
}

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/_push') {
      const u = (await req.json()) as any
      u.update_id = nextUpdateId++
      updates.push(u)
      if (inflight) {
        clearTimeout(inflight.timer)
        const r = inflight.resolve
        inflight = null
        r(ok([u]))
      }
      return ok(u.update_id)
    }
    if (url.pathname === '/_sent') return Response.json(sent)
    if (url.pathname === '/_polls') return Response.json(pollers)
    if (url.pathname === '/_commands') return Response.json({ calls: setCommandsCalls, commands })
    if (url.pathname === '/_usage') {
      if (req.headers.get('authorization') !== 'Bearer test-oauth' || !req.headers.get('anthropic-beta')) return new Response('unauthorized', { status: 401 })
      const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString()
      return Response.json({
        five_hour: { utilization: 5, resets_at: at(2) },
        seven_day: { utilization: 56, resets_at: at(90) },
        limits: [
          { kind: 'session', percent: 5, resets_at: at(2), scope: null },
          { kind: 'weekly_all', percent: 56, resets_at: at(90), scope: null },
          { kind: 'weekly_scoped', percent: 93, resets_at: at(90), scope: { model: { id: null, display_name: 'Fable' } } },
        ],
      })
    }

    const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/)
    if (!m) return new Response('not found', { status: 404 })
    const token = m[1]
    const method = m[2]
    const p = await params(req)
    const who = req.headers.get('user-agent') ?? 'unknown'

    switch (method) {
      case 'getMe':
        return token === '456:NEW'
          ? ok({ id: 998, is_bot: true, first_name: 'New', username: 'new_bot' })
          : ok({ id: 999, is_bot: true, first_name: 'Test', username: 'test_bot' })
      case 'setMyCommands':
        setCommandsCalls++
        commands[`${p.scope?.type ?? 'default'}|${p.language_code ?? ''}`] = p.commands
        return ok(true)
      case 'getMyCommands':
        return ok(commands[`${p.scope?.type ?? 'default'}|${p.language_code ?? ''}`] ?? [])
      case 'getUpdates': {
        pollers[who] = (pollers[who] ?? 0) + 1
        const offset = Number(p.offset ?? 0)
        while (updates.length && updates[0].update_id < offset) updates.shift()
        if (inflight) {
          clearTimeout(inflight.timer)
          const r = inflight.resolve
          inflight = null
          r(Response.json({ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }))
        }
        if (updates.length) return ok(updates.slice())
        const wait = Math.min(Number(p.timeout ?? 0), 2) * 1000
        return await new Promise<Response>(resolve => {
          const timer = setTimeout(() => {
            if (inflight?.timer === timer) inflight = null
            resolve(ok([]))
          }, wait)
          inflight = { resolve, timer }
        })
      }
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendDocument': {
        const message_id = nextMessageId++
        sent.push({ method, ...p, message_id })
        return ok({ message_id, date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id), type: 'private' }, text: p.text })
      }
      case 'editMessageText':
        sent.push({ method, ...p })
        return ok(true)
      default:
        // sendChatAction, setMessageReaction, setMyCommands, answerCallbackQuery, ...
        return ok(true)
    }
  },
})
console.log(`mock telegram on ${PORT}`)
