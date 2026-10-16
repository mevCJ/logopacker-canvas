// Signaling for phone → desktop sketch capture.
//
// The desktop opens a room (an unguessable id it generates) and shows it as a
// QR code; the phone joins the same room. This Durable Object only relays the
// small WebRTC handshake messages (SDP offer/answer + ICE candidates) between
// the two sockets — the photo itself travels over a direct, encrypted WebRTC
// data channel and never passes through the server.
//
// Guard rails so the room can't be used as a general-purpose relay: at most
// one desktop and one phone, messages are capped in size and must be JSON
// signaling envelopes, and the room closes itself after ROOM_TTL_MS.
import { DurableObject } from 'cloudflare:workers'

export type CaptureRole = 'desktop' | 'phone'

const ROOM_TTL_MS = 15 * 60 * 1000
// SDP with many candidates stays well under this; images never come here.
const MAX_MESSAGE_BYTES = 32 * 1024
const ALLOWED_TYPES = new Set(['offer', 'answer', 'ice', 'hello', 'bye'])

// Room ids are 32 hex chars (128 bits), generated client-side.
export const ROOM_ID_RE = /^[0-9a-f]{32}$/

export class CaptureRoom extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 })
    }
    const role = new URL(request.url).searchParams.get('role')
    if (role !== 'desktop' && role !== 'phone') {
      return new Response('Unknown role', { status: 400 })
    }
    // One socket per role; a reconnect replaces the stale one.
    for (const old of this.ctx.getWebSockets(role)) old.close(4000, 'Replaced by a new connection')

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server, [role])

    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS)
    }
    // Tell both sides who is present so the desktop knows when to offer.
    this.broadcastPresence()
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) {
      ws.close(1009, 'Signaling messages only')
      return
    }
    let parsed: { type?: unknown }
    try {
      parsed = JSON.parse(message)
    } catch {
      return
    }
    if (!parsed || typeof parsed.type !== 'string' || !ALLOWED_TYPES.has(parsed.type)) return
    const from = this.ctx.getTags(ws)[0] as CaptureRole | undefined
    const to: CaptureRole = from === 'desktop' ? 'phone' : 'desktop'
    for (const peer of this.ctx.getWebSockets(to)) peer.send(message)
  }

  async webSocketClose(): Promise<void> {
    this.broadcastPresence()
  }

  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, 'Capture session expired')
    await this.ctx.storage.deleteAll()
  }

  private broadcastPresence(): void {
    const sockets = this.ctx.getWebSockets()
    const roles = new Set(sockets.flatMap((s) => this.ctx.getTags(s)))
    const msg = JSON.stringify({ type: 'presence', desktop: roles.has('desktop'), phone: roles.has('phone') })
    for (const s of sockets) {
      try {
        s.send(msg)
      } catch {
        /* closing */
      }
    }
  }
}
