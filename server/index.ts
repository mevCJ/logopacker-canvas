import { handlePexelsSearch } from './pexels'

// PEXELS_API_KEY is provided as a Worker secret (see README / .dev.vars for
// local development). The generated Env type doesn't include secrets, so we
// extend it here.
interface WorkerEnv extends Env {
  PEXELS_API_KEY?: string
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/api/pexels/search') {
      return handlePexelsSearch(request, (env as WorkerEnv).PEXELS_API_KEY)
    }

    if (url.pathname.startsWith('/api/')) {
      return Response.json({ name: 'logopacker-canvas' })
    }

    return new Response(null, { status: 404 })
  },
} satisfies ExportedHandler<Env>
