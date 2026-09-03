// Pexels proxy helpers for the Cloudflare Worker. Kept separate from the fetch
// handler so the normalization logic is easy to reason about and test.

export const PEXELS_SEARCH_URL = 'https://api.pexels.com/v1/search'

export interface PexelsResult {
  id: number
  alt: string
  thumb: string
  src: string
  width: number
  height: number
  photographer: string
  url: string
}

interface RawPexelsPhoto {
  id: number
  alt?: string
  width: number
  height: number
  photographer?: string
  url?: string
  src?: {
    tiny?: string
    small?: string
    medium?: string
    large?: string
    large2x?: string
    original?: string
  }
}

interface RawPexelsResponse {
  photos?: RawPexelsPhoto[]
  total_results?: number
}

export function normalizePexelsResponse(raw: RawPexelsResponse | null | undefined): PexelsResult[] {
  const photos = (raw && raw.photos) || []
  return photos.map((p) => ({
    id: p.id,
    alt: p.alt || '',
    thumb: p.src?.medium || p.src?.small || p.src?.tiny || '',
    src: p.src?.large || p.src?.large2x || p.src?.original || p.src?.medium || '',
    width: p.width,
    height: p.height,
    photographer: p.photographer || '',
    url: p.url || '',
  }))
}

export function buildPexelsQuery({
  query,
  perPage = 8,
  page = 1,
  orientation,
}: {
  query: string
  perPage?: number | string
  page?: number | string
  orientation?: string
}): URLSearchParams {
  const params = new URLSearchParams()
  params.set('query', String(query || '').trim())
  params.set('per_page', String(Math.min(Math.max(Number(perPage) || 8, 1), 24)))
  params.set('page', String(Math.max(Number(page) || 1, 1)))
  if (orientation && ['landscape', 'portrait', 'square'].includes(orientation)) {
    params.set('orientation', orientation)
  }
  return params
}

// Handle a GET /api/pexels/search request. Reads the API key from the Worker
// env so it never reaches the client.
export async function handlePexelsSearch(
  request: Request,
  apiKey: string | undefined,
): Promise<Response> {
  if (!apiKey) {
    return Response.json({ error: 'Pexels API key not configured' }, { status: 500 })
  }

  const url = new URL(request.url)
  const query = (url.searchParams.get('query') || url.searchParams.get('q') || '').trim()
  if (!query) {
    return Response.json({ error: 'Missing query' }, { status: 400 })
  }

  const params = buildPexelsQuery({
    query,
    perPage: url.searchParams.get('perPage') || url.searchParams.get('per_page') || undefined,
    page: url.searchParams.get('page') || undefined,
    orientation: url.searchParams.get('orientation') || undefined,
  })

  let raw: RawPexelsResponse
  try {
    const upstream = await fetch(`${PEXELS_SEARCH_URL}?${params.toString()}`, {
      headers: { Authorization: apiKey },
    })
    if (!upstream.ok) {
      return Response.json(
        { error: 'Pexels request failed', status: upstream.status },
        { status: 502 },
      )
    }
    raw = (await upstream.json()) as RawPexelsResponse
  } catch (e) {
    return Response.json(
      { error: 'Pexels request failed', message: (e as Error)?.message },
      { status: 502 },
    )
  }

  const results = normalizePexelsResponse(raw)
  return Response.json({ query, total: raw?.total_results ?? results.length, results })
}
