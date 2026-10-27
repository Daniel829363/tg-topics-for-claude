#!/usr/bin/env bun
/**
 * Session bookkeeping for crash recovery, in Telegram sessions only
 * (TELEGRAM_ROUTE is set by the tg-router launcher):
 *   start — SessionStart: remember the session id, so after a reboot the
 *           router reopens exactly this conversation (claude --resume <id>)
 *   busy  — UserPromptSubmit: a turn is running
 *   idle  — Stop: the turn finished, nothing to continue after a reboot
 * The router itself marks a route busy when it delivers a message to it.
 */

import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { dirname } from 'path'
import { routeFile } from '../lib/common.ts'

async function main(): Promise<void> {
  const route = process.env.TELEGRAM_ROUTE?.trim()
  if (!route) return
  const mode = process.argv[2]
  if (mode === 'start') {
    const input = JSON.parse(await Bun.stdin.text())
    if (!input.session_id) return
    const file = routeFile('sessions', route, '.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ route, session_id: input.session_id, source: input.source, cwd: input.cwd, at: new Date().toISOString() }, null, 2) + '\n')
  } else if (mode === 'busy') {
    const file = routeFile('busy', route)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, new Date().toISOString())
  } else if (mode === 'idle') {
    rmSync(routeFile('busy', route), { force: true })
  }
}

// Top-level await: with a floating promise bun can exit before stdin is read.
try {
  await main()
} catch {}
