// Phone → desktop photo link over WebRTC.
//
// Pairing: the desktop generates an unguessable room id and shows
// `<origin>/capture/<id>` as a QR code. Both sides connect a WebSocket to the
// Worker's CaptureRoom (server/captureRoom.ts), which relays only the WebRTC
// handshake. The desktop offers, the phone answers, and the photo is sent over
// a direct, DTLS-encrypted data channel — it never touches the server.
//
// Transfer protocol on the "photos" data channel (phone → desktop):
//   {type:'meta', id, name, mime, size}   then binary chunks, then
//   {type:'end', id}                      desktop replies {type:'ack', id}

export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]
export const CHUNK_BYTES = 16 * 1024
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024

export type LinkStatus =
  | 'connecting' // opening signaling
  | 'waiting' // signaling up, other device not here yet
  | 'pairing' // WebRTC handshake in progress
  | 'paired' // data channel open
  | 'error'
  | 'closed'

export function newRoomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function signalingUrl(roomId: string, role: 'desktop' | 'phone', origin = location.origin): string {
  const u = new URL(`/api/capture/${roomId}`, origin)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.searchParams.set('role', role)
  return u.toString()
}

export function captureUrl(origin: string, roomId: string): string {
  return new URL(`/capture/${roomId}`, origin).toString()
}

export interface PhotoMeta {
  id: string
  name: string
  mime: string
  size: number
}

// Reassembles one photo at a time from meta / chunk / end messages.
export class ChunkAssembler {
  private meta: PhotoMeta | null = null
  private parts: ArrayBuffer[] = []
  private received = 0

  constructor(private readonly onProgress?: (meta: PhotoMeta, received: number) => void) {}

  // Returns a finished photo on 'end', otherwise null. Throws on protocol
  // violations (oversize, chunks without meta, mismatched ids).
  push(msg: string | ArrayBuffer): { meta: PhotoMeta; blob: Blob } | null {
    if (typeof msg !== 'string') {
      if (!this.meta) throw new Error('Received image data before its header.')
      this.received += msg.byteLength
      if (this.received > this.meta.size || this.received > MAX_PHOTO_BYTES) throw new Error('Photo is larger than announced.')
      this.parts.push(msg)
      this.onProgress?.(this.meta, this.received)
      return null
    }
    const m = JSON.parse(msg) as Partial<PhotoMeta> & { type?: string }
    if (m.type === 'meta') {
      const size = Number(m.size)
      if (!m.id || !Number.isFinite(size) || size <= 0 || size > MAX_PHOTO_BYTES) throw new Error('Photo is too large.')
      if (!/^image\//.test(String(m.mime))) throw new Error('Only images can be sent.')
      this.meta = { id: String(m.id), name: String(m.name || 'sketch'), mime: String(m.mime), size }
      this.parts = []
      this.received = 0
      return null
    }
    if (m.type === 'end') {
      const meta = this.meta
      if (!meta || meta.id !== m.id) throw new Error('Photo ended unexpectedly.')
      if (this.received !== meta.size) throw new Error('Photo arrived incomplete.')
      const blob = new Blob(this.parts, { type: meta.mime })
      this.meta = null
      this.parts = []
      this.received = 0
      return { meta, blob }
    }
    return null
  }
}

type Signal =
  | { type: 'presence'; desktop: boolean; phone: boolean }
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'ice'; candidate: RTCIceCandidateInit }
  | { type: 'hello' | 'bye' }

// How long the direct connection may take before we give up and explain why.
export const CONNECT_TIMEOUT_MS = 20_000

// Candidate type from an ICE candidate line ("… typ host …").
export function candidateType(c: { candidate?: string; type?: string | null } | null | undefined): string | null {
  if (!c) return null
  if (c.type) return c.type
  return /\btyp (\w+)/.exec(c.candidate ?? '')?.[1] ?? null
}

export interface IceStats {
  local: Record<string, number>
  remote: Record<string, number>
  rejected: number
}

// Human summary + likely cause for a failed direct connection.
export function describeIceFailure(stats: IceStats): string {
  const count = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)
  const fmt = (r: Record<string, number>) => {
    const local = r.host ?? 0
    const pub = (r.srflx ?? 0) + (r.prflx ?? 0)
    const relay = r.relay ?? 0
    const parts = [local && `${local} local`, pub && `${pub} public`, relay && `${relay} relay`].filter(Boolean)
    return parts.length ? parts.join(', ') : 'none'
  }
  const summary = `this device: ${fmt(stats.local)} · other device: ${fmt(stats.remote)} route${count(stats.remote) === 1 ? '' : 's'}`
  let hint: string
  if (!count(stats.remote)) {
    hint = 'The other device\u2019s network details never arrived. Reload the phone page to retry.'
  } else if (!count(stats.local)) {
    hint = 'This browser didn\u2019t offer any network routes (a VPN, firewall or privacy extension may block WebRTC).'
  } else {
    hint =
      'Both devices are reachable but can\u2019t reach each other \u2014 the Wi-Fi probably blocks device-to-device traffic (\u201cclient/AP isolation\u201d, common on guest and office networks), or a VPN is on. Try a home network or the phone\u2019s hotspot.'
  }
  return `Couldn\u2019t link the devices directly (${summary}). ${hint}`
}

// Shared signaling + peer plumbing for both ends.
abstract class LinkBase {
  status: LinkStatus = 'connecting'
  protected ws: WebSocket | null = null
  protected pc: RTCPeerConnection | null = null
  protected channel: RTCDataChannel | null = null
  private closed = false
  // Signaling messages are handled strictly in arrival order: an ICE candidate
  // must not be applied while the offer/answer before it is still being set.
  private signalQueue: Promise<void> = Promise.resolve()
  // Remote candidates that arrived before the remote description was set.
  private pendingIce: RTCIceCandidateInit[] = []
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  iceStats: IceStats = { local: {}, remote: {}, rejected: 0 }

  constructor(
    protected readonly roomId: string,
    protected readonly role: 'desktop' | 'phone',
    protected readonly onStatus: (s: LinkStatus, detail?: string) => void,
    protected readonly origin = location.origin,
  ) {}

  start(): void {
    this.setStatus('connecting')
    const ws = new WebSocket(signalingUrl(this.roomId, this.role, this.origin))
    this.ws = ws
    ws.onopen = () => this.setStatus('waiting')
    ws.onmessage = (e) => {
      let msg: Signal
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }
      this.signalQueue = this.signalQueue.then(() => this.onSignal(msg)).catch((err) => this.fail(err))
    }
    ws.onclose = (e) => {
      if (this.closed) return
      // The data channel can outlive signaling; only report if not paired.
      if (this.status !== 'paired') this.fail(new Error(e.reason || 'Lost connection to the pairing service.'))
    }
  }

  close(): void {
    this.closed = true
    try {
      this.send({ type: 'bye' })
    } catch {
      /* noop */
    }
    this.clearConnectTimer()
    this.channel?.close()
    this.pc?.close()
    this.ws?.close()
    this.setStatus('closed')
  }

  protected send(msg: Signal): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  protected setStatus(s: LinkStatus, detail?: string): void {
    this.status = s
    this.onStatus(s, detail)
  }

  protected fail(err: unknown): void {
    if (this.closed) return
    this.setStatus('error', (err as Error)?.message || String(err))
  }

  protected newPeer(): RTCPeerConnection {
    this.pc?.close()
    this.pendingIce = []
    this.iceStats = { local: {}, remote: {}, rejected: 0 }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pc.onicecandidate = (e) => {
      if (!e.candidate) return
      const t = candidateType(e.candidate)
      if (t) this.iceStats.local[t] = (this.iceStats.local[t] ?? 0) + 1
      this.send({ type: 'ice', candidate: e.candidate.toJSON() })
    }
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return
      if (pc.connectionState === 'connected') this.clearConnectTimer()
      if (pc.connectionState === 'failed') this.failIce()
    }
    this.pc = pc
    this.clearConnectTimer()
    this.connectTimer = setTimeout(() => {
      if (pc === this.pc && pc.connectionState !== 'connected') this.failIce()
    }, CONNECT_TIMEOUT_MS)
    return pc
  }

  private failIce(): void {
    this.clearConnectTimer()
    this.fail(new Error(describeIceFailure(this.iceStats)))
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  // Set the remote offer/answer, then apply any candidates that raced ahead.
  protected async setRemote(desc: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.pc
    if (!pc) return
    await pc.setRemoteDescription(desc)
    const queued = this.pendingIce
    this.pendingIce = []
    for (const c of queued) await this.addRemoteIce(c)
  }

  protected async addRemoteIce(c: RTCIceCandidateInit): Promise<void> {
    const pc = this.pc
    if (!pc) return
    if (!pc.remoteDescription) {
      this.pendingIce.push(c)
      return
    }
    const t = candidateType(c)
    if (t) this.iceStats.remote[t] = (this.iceStats.remote[t] ?? 0) + 1
    try {
      await pc.addIceCandidate(c)
    } catch {
      this.iceStats.rejected++
    }
  }

  protected abstract onSignal(msg: Signal): Promise<void>
}

// Desktop end: waits for the phone, offers, and receives photos.
export class CaptureReceiver extends LinkBase {
  private assembler: ChunkAssembler

  constructor(
    roomId: string,
    private readonly handlers: {
      onStatus: (s: LinkStatus, detail?: string) => void
      onPhoto: (blob: Blob, meta: PhotoMeta) => void
      onProgress?: (meta: PhotoMeta, received: number) => void
    },
    origin?: string,
  ) {
    super(roomId, 'desktop', handlers.onStatus, origin)
    this.assembler = new ChunkAssembler(handlers.onProgress)
  }

  protected async onSignal(msg: Signal): Promise<void> {
    if (msg.type === 'presence') {
      // (Re)offer whenever a phone is present and we're not already linked.
      if (msg.phone && this.status !== 'paired') await this.offer()
      if (!msg.phone && this.status !== 'paired') this.setStatus('waiting')
      return
    }
    if (msg.type === 'answer') await this.setRemote({ type: 'answer', sdp: msg.sdp })
    else if (msg.type === 'ice') await this.addRemoteIce(msg.candidate)
  }

  private async offer(): Promise<void> {
    this.setStatus('pairing')
    const pc = this.newPeer()
    const ch = pc.createDataChannel('photos', { ordered: true })
    ch.binaryType = 'arraybuffer'
    ch.onopen = () => this.setStatus('paired')
    ch.onclose = () => {
      if (this.status === 'paired') this.setStatus('waiting')
    }
    ch.onmessage = (e) => {
      try {
        const done = this.assembler.push(e.data as string | ArrayBuffer)
        if (done) {
          ch.send(JSON.stringify({ type: 'ack', id: done.meta.id }))
          this.handlers.onPhoto(done.blob, done.meta)
        }
      } catch (err) {
        ch.send(JSON.stringify({ type: 'nack', message: (err as Error).message }))
        this.fail(err)
      }
    }
    this.channel = ch
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.send({ type: 'offer', sdp: offer.sdp! })
  }
}

// Phone end: answers the desktop's offer and sends photos.
export class CaptureSender extends LinkBase {
  private acks = new Map<string, { resolve: () => void; reject: (e: Error) => void }>()

  constructor(roomId: string, onStatus: (s: LinkStatus, detail?: string) => void, origin?: string) {
    super(roomId, 'phone', onStatus, origin)
  }

  protected async onSignal(msg: Signal): Promise<void> {
    if (msg.type === 'presence') {
      if (!msg.desktop && this.status !== 'paired') this.setStatus('waiting')
      return
    }
    if (msg.type === 'offer') {
      this.setStatus('pairing')
      const pc = this.newPeer()
      pc.ondatachannel = (e) => {
        const ch = e.channel
        ch.binaryType = 'arraybuffer'
        ch.bufferedAmountLowThreshold = CHUNK_BYTES * 8
        ch.onopen = () => this.setStatus('paired')
        ch.onclose = () => {
          if (this.status === 'paired') this.setStatus('waiting')
        }
        ch.onmessage = (ev) => {
          if (typeof ev.data !== 'string') return
          const m = JSON.parse(ev.data) as { type: string; id?: string; message?: string }
          const pending = m.id ? this.acks.get(m.id) : [...this.acks.values()][0]
          if (!pending) return
          if (m.type === 'ack') pending.resolve()
          else if (m.type === 'nack') pending.reject(new Error(m.message || 'The desktop rejected the photo.'))
          if (m.id) this.acks.delete(m.id)
          else this.acks.clear()
        }
        this.channel = ch
        if (ch.readyState === 'open') this.setStatus('paired')
      }
      await this.setRemote({ type: 'offer', sdp: msg.sdp })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      this.send({ type: 'answer', sdp: answer.sdp! })
    } else if (msg.type === 'ice') {
      await this.addRemoteIce(msg.candidate)
    }
  }

  // Send one photo; resolves once the desktop confirms it arrived intact.
  async sendPhoto(blob: Blob, name: string, onProgress?: (sent: number, total: number) => void): Promise<void> {
    const ch = this.channel
    if (!ch || ch.readyState !== 'open') throw new Error('Not connected to the desktop yet.')
    if (blob.size > MAX_PHOTO_BYTES) throw new Error('Photo is too large to send.')
    const id = newRoomId().slice(0, 12)
    const acked = new Promise<void>((resolve, reject) => this.acks.set(id, { resolve, reject }))
    ch.send(JSON.stringify({ type: 'meta', id, name, mime: blob.type || 'image/jpeg', size: blob.size }))
    const buf = await blob.arrayBuffer()
    for (let off = 0; off < buf.byteLength; off += CHUNK_BYTES) {
      // Backpressure: let the buffer drain before queueing more.
      if (ch.bufferedAmount > CHUNK_BYTES * 64) {
        await new Promise<void>((r) => {
          ch.onbufferedamountlow = () => {
            ch.onbufferedamountlow = null
            r()
          }
        })
      }
      ch.send(buf.slice(off, off + CHUNK_BYTES))
      onProgress?.(Math.min(off + CHUNK_BYTES, buf.byteLength), buf.byteLength)
    }
    ch.send(JSON.stringify({ type: 'end', id }))
    await acked
  }
}
