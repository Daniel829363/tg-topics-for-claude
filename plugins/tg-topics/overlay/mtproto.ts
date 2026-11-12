#!/usr/bin/env bun
/**
 * TG-TOPICS big files helper — MTProto as the same bot (gramJS), for what the Bot API can't do:
 *   download > 20 MB and upload > 50 MB (up to 2 GB both ways).
 *
 * Not imported by server.ts: the server copies this file into <STATE_DIR>/mtproto/ (own package.json with
 * the `telegram` dependency, installed on first use) and runs it as a child process only when a big file
 * shows up — normal startup stays as light as before.
 *
 * Input: JSON on stdin. Output: one JSON line on stdout ({ ok: true, ... } | { ok: false, error }).
 *   { op: 'download', fileId, out }                          → { ok, path, size }
 *   { op: 'send', chatId, threadId?, replyTo?, files: [] }    → { ok, ids: [] }
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_API_ID, TELEGRAM_API_HASH. Bot session cached in ./session.txt.
 */
import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { readFileSync, writeFileSync, statSync, chmodSync } from 'fs'
import { join, basename } from 'path'
import bigInt from 'big-integer'

const SESSION_FILE = join(import.meta.dir, 'session.txt')
const out = (o: unknown) => { process.stdout.write(JSON.stringify(o) + '\n') }

/** Bot API file_id -> MTProto document location (TDLib persistent id, versions 4+) */
export function decodeFileId(fid: string) {
  const raw = Buffer.from(fid.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const bytes: number[] = []
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0) { const n = raw[++i] ?? 0; for (let k = 0; k < n; k++) bytes.push(0) } else bytes.push(raw[i])
  }
  const b = Buffer.from(bytes)
  if (b.length < 20) throw new Error('bad file_id')
  let p = 0
  const typeRaw = b.readInt32LE(p); p += 4
  const dc = b.readInt32LE(p); p += 4
  const hasRef = !!(typeRaw & (1 << 25))
  if (typeRaw & (1 << 24)) throw new Error('web file_id is not supported')
  const type = typeRaw & ~((1 << 25) | (1 << 24))
  // 0 thumbnail, 1 profile photo, 2 photo — photos are small, Bot API handles them
  if (type <= 2) throw new Error('photo file_id: use the Bot API')
  let ref = Buffer.alloc(0)
  if (hasRef) {
    let len = b[p], hdr = 1
    if (len === 254) { len = b[p + 1] | (b[p + 2] << 8) | (b[p + 3] << 16); hdr = 4 }
    ref = b.subarray(p + hdr, p + hdr + len)
    p += Math.ceil((hdr + len) / 4) * 4
  }
  const id = b.readBigInt64LE(p); p += 8
  const hash = b.readBigInt64LE(p)
  return { type, dc, ref, id, hash }
}

async function client() {
  let saved = ''
  try { saved = readFileSync(SESSION_FILE, 'utf8').trim() } catch {}
  const sess = new StringSession(saved)
  const c = new TelegramClient(sess, Number(process.env.TELEGRAM_API_ID), String(process.env.TELEGRAM_API_HASH), {
    connectionRetries: 3, receiveUpdates: false,
  } as any)
  c.setLogLevel('none' as any)
  await c.start({ botAuthToken: String(process.env.TELEGRAM_BOT_TOKEN) })
  const now = sess.save()
  if (now && now !== saved) {
    writeFileSync(SESSION_FILE, now)
    try { chmodSync(SESSION_FILE, 0o600) } catch {}
  }
  return c
}

/** Bot API chat id -> input peer (bots may resolve channels/users with access_hash 0) */
async function peerOf(c: TelegramClient, chatId: string): Promise<Api.TypeInputPeer> {
  const s = String(chatId)
  if (s.startsWith('-100')) {
    const r = await c.invoke(new Api.channels.GetChannels({ id: [new Api.InputChannel({ channelId: bigInt(s.slice(4)), accessHash: bigInt(0) })] })) as Api.messages.Chats
    const ch = r.chats[0] as Api.Channel
    if (!ch || !('accessHash' in ch)) throw new Error('chat not found for MTProto')
    return new Api.InputPeerChannel({ channelId: ch.id, accessHash: ch.accessHash! })
  }
  if (s.startsWith('-')) return new Api.InputPeerChat({ chatId: bigInt(s.slice(1)) })
  const u = (await c.invoke(new Api.users.GetUsers({ id: [new Api.InputUser({ userId: bigInt(s), accessHash: bigInt(0) })] })))[0] as Api.User
  if (!u || !('accessHash' in u)) throw new Error('user not found for MTProto')
  return new Api.InputPeerUser({ userId: u.id, accessHash: u.accessHash! })
}

async function main() {
  const req = JSON.parse(readFileSync(0, 'utf8'))
  if (!process.env.TELEGRAM_API_ID || !process.env.TELEGRAM_API_HASH) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH are not set')
  const c = await client()
  try {
    if (req.op === 'download') {
      const d = decodeFileId(String(req.fileId))
      const loc = new Api.InputDocumentFileLocation({
        id: bigInt(d.id.toString()), accessHash: bigInt(d.hash.toString()), fileReference: d.ref, thumbSize: '',
      })
      await c.downloadFile(loc, { dcId: d.dc, outputFile: String(req.out), partSizeKb: 512 } as any)
      out({ ok: true, path: req.out, size: statSync(req.out).size })
    } else if (req.op === 'send') {
      const peer = await peerOf(c, String(req.chatId))
      const ids: number[] = []
      for (const f of req.files as string[]) {
        const m = await c.sendFile(peer, {
          file: f,
          forceDocument: true,
          workers: 4,
          ...(req.replyTo != null ? { replyTo: Number(req.replyTo) } : {}),
          ...(req.threadId != null ? (req.replyTo != null ? { topMsgId: Number(req.threadId) } : { replyTo: Number(req.threadId) }) : {}),
          attributes: [new Api.DocumentAttributeFilename({ fileName: basename(f) })],
        })
        ids.push(m.id)
      }
      out({ ok: true, ids })
    } else throw new Error('unknown op: ' + req.op)
  } finally {
    await c.disconnect().catch(() => {})
    await c.destroy().catch(() => {})
  }
}

main().then(() => process.exit(0), (e) => { out({ ok: false, error: String(e?.message ?? e) }); process.exit(1) })
