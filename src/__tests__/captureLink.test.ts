import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CaptureSender, CaptureReceiver, candidateType, describeIceFailure } from '@/services/capture/captureLink'

// Fake WebSocket the test drives by hand.
class FakeWS {
  static OPEN = 1
  static last: FakeWS | null = null
  readyState = 1
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { reason: string }) => void) | null = null
  constructor(public url: string) {
    FakeWS.last = this
  }
  send(m: string) {
    this.sent.push(m)
  }
  close() {}
  deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
}

// Fake peer: remote description lands after a delay, and like real browsers
// it rejects candidates added before a remote description exists.
class FakePC {
  static last: FakePC | null = null
  remoteDescription: unknown = null
  added: string[] = []
  rejectedEarly = 0
  connectionState = 'new'
  onicecandidate: unknown = null
  onconnectionstatechange: unknown = null
  ondatachannel: unknown = null
  constructor() {
    FakePC.last = this
  }
  async setRemoteDescription(d: unknown) {
    await new Promise((r) => setTimeout(r, 20))
    this.remoteDescription = d
  }
  async addIceCandidate(c: { candidate: string }) {
    if (!this.remoteDescription) {
      this.rejectedEarly++
      throw new Error('InvalidStateError: remote description is null')
    }
    this.added.push(c.candidate)
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'answer-sdp' }
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer-sdp' }
  }
  async setLocalDescription() {}
  createDataChannel() {
    return { send() {}, close() {} }
  }
  close() {}
}

const cand = (n: number) => ({ candidate: `candidate:${n} 1 udp 2122260223 192.168.0.${n} 5000${n} typ host`, sdpMid: '0' })
const flush = () => new Promise((r) => setTimeout(r, 80))

describe('capture link signaling', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeWS)
    vi.stubGlobal('RTCPeerConnection', FakePC)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('phone applies candidates that arrive right behind the offer', async () => {
    const link = new CaptureSender('a'.repeat(32), () => {}, 'http://x.test')
    link.start()
    const ws = FakeWS.last!
    ws.deliver({ type: 'offer', sdp: 'offer-sdp' })
    ws.deliver({ type: 'ice', candidate: cand(1) })
    ws.deliver({ type: 'ice', candidate: cand(2) })
    await flush()
    const pc = FakePC.last!
    expect(pc.rejectedEarly).toBe(0)
    expect(pc.added).toHaveLength(2)
    expect(ws.sent.map((m) => JSON.parse(m).type)).toContain('answer')
    expect(link.iceStats.remote.host).toBe(2)
    link.close()
  })

  it('desktop applies candidates that arrive right behind the answer', async () => {
    const link = new CaptureReceiver('b'.repeat(32), { onStatus: () => {}, onPhoto: () => {} }, 'http://x.test')
    link.start()
    const ws = FakeWS.last!
    ws.deliver({ type: 'presence', desktop: true, phone: true })
    ws.deliver({ type: 'answer', sdp: 'answer-sdp' })
    ws.deliver({ type: 'ice', candidate: cand(3) })
    await flush()
    expect(FakePC.last!.rejectedEarly).toBe(0)
    expect(FakePC.last!.added).toHaveLength(1)
    link.close()
  })

  it('explains failures from the candidates seen', () => {
    expect(candidateType({ candidate: 'candidate:1 1 udp 1 1.2.3.4 9 typ srflx raddr 0.0.0.0' })).toBe('srflx')
    expect(describeIceFailure({ local: { host: 1 }, remote: {}, rejected: 0 })).toMatch(/never arrived/)
    expect(describeIceFailure({ local: { host: 2, srflx: 1 }, remote: { host: 1, srflx: 1 }, rejected: 0 })).toMatch(
      /client\/AP isolation/,
    )
  })
})
