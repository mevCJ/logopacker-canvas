import { handlePexelsSearch } from './pexels'
import { ROOM_ID_RE } from './captureRoom'

export { CaptureRoom } from './captureRoom'

// PEXELS_API_KEY is provided as a Worker secret (see README / .dev.vars for
// local development). Generated types mark it required (when .dev.vars has
// it), but it can be missing in a deployment, so treat it as optional.
type WorkerEnv = Omit<Env, 'PEXELS_API_KEY'> & { PEXELS_API_KEY?: string }

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/api/pexels/search') {
      return handlePexelsSearch(request, (env as WorkerEnv).PEXELS_API_KEY)
    }

    // Phone capture signaling: /api/capture/<roomId>?role=desktop|phone
    const capture = /^\/api\/capture\/([^/]+)$/.exec(url.pathname)
    if (capture) {
      const roomId = capture[1]!
      if (!ROOM_ID_RE.test(roomId)) return new Response('Bad room id', { status: 400 })
      const stub = env.CAPTURE_ROOM.get(env.CAPTURE_ROOM.idFromName(roomId))
      return stub.fetch(request)
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ name: 'logopacker-canvas' })
    }

    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>
