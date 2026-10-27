/**
 * Paths, config and overlay upkeep shared by tg-router and the tgt CLI.
 *
 * Code lives in the plugin directory (replaced on every plugin update); data
 * lives in a stable home, ~/.claude/tg-router by default:
 *   config.json, state/ (routes, topics, offset), logs/router.log,
 *   launch-router.ts + start-router.vbs (autostart launchers).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync, renameSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'

export const PLUGIN_ROOT = resolve(import.meta.dir, '..')
export const PLUGIN_VERSION: string = (() => {
  try { return JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '0' } catch { return '0' }
})()

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
export const HOME = process.env.TG_ROUTER_HOME ?? join(CLAUDE_DIR, 'tg-router')
export const CONFIG_FILE = process.env.TG_ROUTER_CONFIG ?? join(HOME, 'config.json')
export const STATE = process.env.TG_ROUTER_STATE ?? join(HOME, 'state')
export const LOG_FILE = process.env.TG_ROUTER_LOG ?? join(HOME, 'logs', 'router.log')
export const SESSION_SETTINGS = join(CLAUDE_DIR, 'telegram-session.settings.json')
export const INSTALLED_PLUGINS = join(CLAUDE_DIR, 'plugins', 'installed_plugins.json')
export const OFFICIAL_KEY = 'telegram@claude-plugins-official'
export const CHANNEL_ARG = `plugin:${OFFICIAL_KEY}`

// ---- Config -----------------------------------------------------------------

export type Config = {
  port: number
  telegramStateDir: string
  topicsRoot: string
  claudeExe: string
  claudeArgs: string[]
  /** wt = Windows Terminal tab, console = separate PowerShell window, command = run `command` directly (tests). */
  launcher: 'wt' | 'console' | 'command'
  wtWindow: string
  command: string[]
  maxSessions: number
  spawnTimeoutSec: number
  queueTtlSec: number
  announceSpawn: boolean
  /** After a reboot / power loss, reopen the sessions that were running (claude --resume). */
  resumeOnStart: boolean
  /** How long the router waits after its start for still-running sessions to reconnect before resuming the rest. */
  resumeGraceSec: number
  dm: { spawn: boolean; dir: string }
  plugin: { autoPatch: boolean; installedPluginsFile: string; pluginKey: string }
}

function detectClaude(): string {
  const native = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  if (existsSync(native)) return native
  return Bun.which('claude') ?? 'claude'
}

function detectLauncher(): Config['launcher'] {
  if (process.platform !== 'win32') return 'command'
  return Bun.which('wt.exe') ? 'wt' : 'console'
}

export function defaultConfig(): Config {
  return {
    port: 8789,
    telegramStateDir: process.env.TELEGRAM_STATE_DIR ?? join(CLAUDE_DIR, 'channels', 'telegram'),
    topicsRoot: join(homedir(), 'tg-topics'),
    claudeExe: detectClaude(),
    claudeArgs: ['--settings', SESSION_SETTINGS, '--channels', CHANNEL_ARG],
    launcher: detectLauncher(),
    wtWindow: 'tg-sessions',
    command: [],
    maxSessions: 8,
    spawnTimeoutSec: 180,
    queueTtlSec: 900,
    announceSpawn: true,
    resumeOnStart: true,
    resumeGraceSec: 45,
    dm: { spawn: true, dir: homedir() },
    plugin: { autoPatch: true, installedPluginsFile: INSTALLED_PLUGINS, pluginKey: OFFICIAL_KEY },
  }
}

export function loadConfig(): Config {
  const d = defaultConfig()
  let user: Partial<Config> = {}
  try {
    user = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`config ${CONFIG_FILE} unreadable, using defaults: ${err}`)
  }
  return {
    ...d,
    ...user,
    dm: { ...d.dm, ...(user.dm ?? {}) },
    plugin: { ...d.plugin, ...(user.plugin ?? {}) },
    telegramStateDir: process.env.TELEGRAM_STATE_DIR ?? user.telegramStateDir ?? d.telegramStateDir,
  }
}

/** Changes a few fields of config.json, keeping everything else the user wrote. */
export function updateConfigFile(patch: Partial<Config>): void {
  let user: Record<string, unknown> = {}
  try { user = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch {}
  mkdirSync(resolve(CONFIG_FILE, '..'), { recursive: true })
  writeFileSync(CONFIG_FILE + '.tmp', JSON.stringify({ ...user, ...patch }, null, 2) + '\n')
  renameSync(CONFIG_FILE + '.tmp', CONFIG_FILE)
}

/** A per-route file in a state subfolder (stop flags, session ids, busy marks). */
export function routeFile(sub: string, route: string, ext = ''): string {
  return join(STATE, sub, route.replace(/[^\w-]/g, '_') + ext)
}

export function routerHttp(cfg: Config): string {
  return `http://127.0.0.1:${cfg.port}`
}

export function secretFile(cfg: Config): string {
  return join(cfg.telegramStateDir, 'router.secret')
}

/** TELEGRAM_BOT_TOKEN from the environment or the channel's .env, or ''. */
export function readToken(cfg: Config): string {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN
  try {
    for (const line of readFileSync(join(cfg.telegramStateDir, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^TELEGRAM_BOT_TOKEN=(.*)$/)
      if (m) return m[1]!.trim()
    }
  } catch {}
  return ''
}

// ---- Official plugin overlay -------------------------------------------------

// Claude Code only runs channels from its approved list without a startup
// confirmation, so tg-topics doesn't ship a channel of its own: it overlays
// the official telegram plugin's server with a router-aware version.
export const OVERLAY_DIR = join(PLUGIN_ROOT, 'overlay')
// bot-ui.ts first: server.ts imports it.
export const OVERLAY_FILES = ['bot-ui.ts', 'server.ts']
const OVERLAY_MARK = /TG-TOPICS-OVERLAY|TG-ROUTER-PATCH/

export type Install = { installPath: string; version?: string; scope?: string; lastUpdated?: string }

export function installsOf(key: string, file = INSTALLED_PLUGINS): Install[] {
  try {
    const reg = JSON.parse(readFileSync(file, 'utf8'))
    return (reg.plugins?.[key] ?? []) as Install[]
  } catch {
    return []
  }
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex')

export type OverlayResult = { dir: string; version?: string; changed: boolean; error?: string }

/** Copy the overlay into every install of the official plugin that lacks it. */
export function applyOverlay(cfg: Config): OverlayResult[] {
  const out: OverlayResult[] = []
  const installs = installsOf(cfg.plugin.pluginKey, cfg.plugin.installedPluginsFile)
  const seen = new Set<string>()
  for (const inst of installs) {
    const dir = inst.installPath
    if (seen.has(dir)) continue
    seen.add(dir)
    if (!existsSync(join(dir, 'server.ts'))) continue
    let changed = false
    try {
      for (const f of OVERLAY_FILES) {
        const ours = readFileSync(join(OVERLAY_DIR, f), 'utf8')
        const target = join(dir, f)
        let current = ''
        try { current = readFileSync(target, 'utf8') } catch {}
        if (current && sha(current) === sha(ours)) continue
        if (f === 'server.ts' && current && !OVERLAY_MARK.test(current)) {
          copyFileSync(target, join(dir, 'server.ts.upstream'))
        }
        writeFileSync(target, ours)
        changed = true
      }
      out.push({ dir, version: inst.version, changed })
    } catch (err) {
      out.push({ dir, version: inst.version, changed, error: String(err) })
    }
  }
  return out
}

export function overlayState(cfg: Config): { dir: string; version?: string; applied: boolean }[] {
  const seen = new Set<string>()
  return installsOf(cfg.plugin.pluginKey, cfg.plugin.installedPluginsFile)
    .filter(i => !seen.has(i.installPath) && seen.add(i.installPath))
    .map(i => {
      const applied = OVERLAY_FILES.every(f => {
        try { return sha(readFileSync(join(i.installPath, f), 'utf8')) === sha(readFileSync(join(OVERLAY_DIR, f), 'utf8')) } catch { return false }
      })
      return { dir: i.installPath, version: i.version, applied }
    })
}

/** Put the upstream server back (tgt unpatch). */
export function removeOverlay(cfg: Config): string[] {
  const restored: string[] = []
  for (const i of installsOf(cfg.plugin.pluginKey, cfg.plugin.installedPluginsFile)) {
    const upstream = join(i.installPath, 'server.ts.upstream')
    if (!existsSync(upstream)) continue
    copyFileSync(upstream, join(i.installPath, 'server.ts'))
    rmSync(join(i.installPath, 'bot-ui.ts'), { force: true })
    restored.push(i.installPath)
  }
  return restored
}

export function writeIfChanged(file: string, content: string): boolean {
  try { if (readFileSync(file, 'utf8') === content) return false } catch {}
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, content)
  return true
}
