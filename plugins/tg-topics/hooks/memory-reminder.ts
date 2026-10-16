#!/usr/bin/env bun
/**
 * Stop hook for topic sessions: if the turn that just ended did real work
 * (tools beyond Telegram/read-only ones) and MEMORY.md wasn't touched, block
 * the stop once and ask Claude to fold the outcome into MEMORY.md.
 * `stop_hook_active` guards against loops — the second stop always passes.
 */

import { openSync, readSync, fstatSync, closeSync } from 'fs'

const PASSIVE = new Set(['Read', 'Glob', 'Grep', 'ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'WebSearch', 'WebFetch'])

function tail(path: string, bytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString('utf8')
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text
  } finally {
    closeSync(fd)
  }
}

function isRealPrompt(entry: any): boolean {
  if (entry.type !== 'user' || entry.isMeta) return false
  const c = entry.message?.content
  if (typeof c === 'string') return true
  return Array.isArray(c) && c.some((b: any) => b.type !== 'tool_result')
}

async function main(): Promise<void> {
  // Plugin hooks fire in every session; only topic sessions (started by
  // tg-router with TELEGRAM_TOPIC_DIR set) keep a MEMORY.md.
  if (!process.env.TELEGRAM_TOPIC_DIR) return
  const input = JSON.parse(await Bun.stdin.text())
  if (input.stop_hook_active || !input.transcript_path) return

  const entries = tail(input.transcript_path, 1024 * 1024)
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)

  let start = entries.length - 1
  while (start >= 0 && !isRealPrompt(entries[start])) start--

  let worked = false
  for (const e of entries.slice(start + 1)) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue
    for (const b of e.message.content) {
      if (b.type !== 'tool_use') continue
      const name: string = b.name ?? ''
      const file: string = String(b.input?.file_path ?? b.input?.path ?? '')
      if (/MEMORY\.md$/i.test(file) && /^(Write|Edit|MultiEdit)$/.test(name)) return // already updated
      if (name.startsWith('mcp__plugin_telegram') || PASSIVE.has(name)) continue
      worked = true
    }
  }
  if (!worked) return

  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason:
      'Перед завершением: если эта задача дала что-то долговечное (результат, решение, договорённость, ' +
      'предпочтение, состояние незавершённой работы, важные пути) — сожми это в MEMORY.md этой темы ' +
      '(переписывай и объединяй, до ~150 строк). Если сохранять нечего — просто завершай без ответа.',
  }))
}

// Top-level await: with a floating promise bun can exit before stdin is read.
try {
  await main()
} catch {}
