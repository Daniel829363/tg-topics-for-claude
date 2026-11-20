#!/usr/bin/env bun
/**
 * Session bookkeeping for crash recovery, in Telegram sessions only
 * (TELEGRAM_ROUTE is set by the tg-router launcher):
 *   start   — SessionStart: remember the session id, so after a reboot the
 *             router reopens exactly this conversation (claude --resume <id>)
 *   busy    — UserPromptSubmit: a turn is running
 *   bgagent — PostToolUse(Agent): a background subagent was launched
 *   idle    — Stop: the turn finished. The busy mark is removed only when no
 *             background work is left: background shells (Bash/PowerShell
 *             tool, run_in_background) still running under this claude
 *             process, or a background subagent launched in the last few hours.
 *             Otherwise the mark stays and a reboot gets the session a
 *             "carry on" message.
 * The router itself marks a route busy when it delivers a message to it.
 */

import { writeFileSync, mkdirSync, rmSync, statSync } from 'fs'
import { dirname } from 'path'
import { routeFile } from '../lib/common.ts'

// A background subagent counts as running for this long after its launch
// (there is no hook for "a background agent finished").
const BG_AGENT_MS = 3 * 3600_000

type Proc = { pid: number; ppid: number; name: string; cmd: string }

async function processTable(): Promise<Map<number, Proc>> {
  const table = new Map<number, Proc>()
  if (process.platform === 'win32') {
    const p = Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { stdout: 'pipe', stderr: 'ignore' })
    for (const r of JSON.parse(await new Response(p.stdout).text()) as any[]) {
      table.set(r.ProcessId, { pid: r.ProcessId, ppid: r.ParentProcessId, name: String(r.Name ?? ''), cmd: String(r.CommandLine ?? '') })
    }
  } else {
    const p = Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,comm=,args='], { stdout: 'pipe', stderr: 'ignore' })
    for (const line of (await new Response(p.stdout).text()).split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)
      if (m) table.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!.split('/').pop()!, cmd: m[4] ?? '' })
    }
  }
  return table
}

/** Background tool shells still running under this session's claude process. */
async function backgroundShells(): Promise<string[]> {
  const table = await processTable()
  const mine = new Set<number>()
  let claude: Proc | undefined
  for (let p = table.get(process.pid), i = 0; p && i < 8; p = table.get(p.ppid), i++) {
    mine.add(p.pid)
    if (/^claude(\.exe)?$/i.test(p.name)) { claude = p; break }
  }
  if (!claude) return []
  return [...table.values()]
    .filter(p => p.ppid === claude!.pid && !mine.has(p.pid))
    .filter(p => /^(bash|sh|zsh|powershell|pwsh)(\.exe)?$/i.test(p.name))
    // tool shells, not MCP servers or hooks: Claude Code wraps them in its shell snapshot
    .filter(p => /shell-snapshots|claude-.*-cwd/i.test(p.cmd) || /powershell|pwsh/i.test(p.name))
    .map(p => `${p.pid} ${p.name}`)
}

function touch(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

async function main(): Promise<void> {
  const route = process.env.TELEGRAM_ROUTE?.trim()
  if (!route) return
  const mode = process.argv[2]
  if (mode === 'start') {
    const input = JSON.parse(await Bun.stdin.text())
    if (!input.session_id) return
    touch(routeFile('sessions', route, '.json'),
      JSON.stringify({ route, session_id: input.session_id, source: input.source, cwd: input.cwd, at: new Date().toISOString() }, null, 2) + '\n')
  } else if (mode === 'busy') {
    touch(routeFile('busy', route), new Date().toISOString())
  } else if (mode === 'bgagent') {
    const input = JSON.parse(await Bun.stdin.text())
    if (input.tool_input?.run_in_background) touch(routeFile('bgagent', route), new Date().toISOString())
  } else if (mode === 'idle') {
    let why: string[] = []
    try { why = await backgroundShells() } catch {}
    try { if (Date.now() - statSync(routeFile('bgagent', route)).mtimeMs < BG_AGENT_MS) why.push('background agent') } catch {}
    if (why.length) touch(routeFile('busy', route), `${new Date().toISOString()} background: ${why.join(', ')}`)
    else rmSync(routeFile('busy', route), { force: true })
  }
}

// Top-level await: with a floating promise bun can exit before stdin is read.
try {
  await main()
} catch {}
