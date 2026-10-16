/**
 * Stands in for an interactive `claude` session in tests: runs the patched
 * plugin as an MCP server over stdio, records every channel notification and
 * answers each one with reply (without thread_id — the plugin must route it).
 */

import { appendFileSync } from 'fs'
import { join } from 'path'

const PLUGIN = process.env.TG_TEST_PLUGIN!
const OUT = process.env.TG_TEST_OUT!
const route = process.env.TELEGRAM_ROUTE ?? 'dm'
const record = (kind: string, data: unknown) =>
  appendFileSync(join(OUT, 'sessions.jsonl'), JSON.stringify({ kind, route, pid: process.pid, data }) + '\n')

record('spawned', { cwd: process.cwd() })

const child = Bun.spawn(['bun', join(PLUGIN, 'server.ts')], {
  cwd: PLUGIN,
  env: process.env,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
})

let id = 1
function rpc(method: string, params: unknown): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) + '\n')
}
function notify(method: string, params: unknown = {}): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

;(async () => {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of child.stderr) {
    for (const line of dec.decode(chunk).split('\n')) if (line.trim()) record('stderr', line.trim())
  }
})()

;(async () => {
  const dec = new TextDecoder()
  let buf = ''
  for await (const chunk of child.stdout) {
    buf += dec.decode(chunk)
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.id === 1 && msg.result) notify('notifications/initialized')
      if (msg.method === 'notifications/claude/channel') {
        record('inbound', msg.params)
        const meta = msg.params.meta
        rpc('tools/call', { name: 'reply', arguments: { chat_id: meta.chat_id, text: `echo[${route}]: ${msg.params.content}` } })
      }
      if (msg.result?.content) record('tool_result', msg.result.content[0]?.text)
    }
  }
})()

rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } })
