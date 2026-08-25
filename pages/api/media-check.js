import { rateLimit } from '@/lib/rate-limit'
import { clientIp } from '@/lib/client-ip'

// Same-origin media-type check proxy (audit B-1). The browser used to call the
// capture service directly through the public Caddy /media-check route — an
// unauthenticated, CORS-open internal-network fetch proxy. Now the browser
// calls this route (invite-gated while the gate exists, rate-limited per IP),
// and the app forwards to capture over the docker network with the shared
// token. Always answers 200 with the neutral shape on upstream trouble — the
// editor treats a non-media answer as "unknown", never an error.
export default async function handler (req, res) {
  if (req.method !== 'GET') return res.status(405).end()

  const url = typeof req.query.url === 'string' ? req.query.url : ''
  if (!/^(https?:\/\/)/.test(url)) return res.status(400).json({ error: 'Invalid URL' })

  const rl = rateLimit({
    key: `media-check:${clientIp(req.headers, req.socket?.remoteAddress)}`,
    limit: 60,
    windowMs: 60_000
  })
  if (!rl.allowed) return res.status(429).json({ error: 'Too many requests' })

  const upstream = `${process.env.MEDIA_CHECK_URL_DOCKER || 'http://capture:5678/media'}/${encodeURIComponent(url)}`
  const headers = {}
  if (process.env.CAPTURE_MEDIA_TOKEN) headers['x-capture-token'] = process.env.CAPTURE_MEDIA_TOKEN

  try {
    const r = await fetch(upstream, { headers, signal: AbortSignal.timeout(12_000) })
    if (!r.ok) return res.status(200).json({ mime: null, isImage: false, isVideo: false })
    const data = await r.json().catch(() => ({ mime: null, isImage: false, isVideo: false }))
    return res.status(200).json(data)
  } catch {
    return res.status(200).json({ mime: null, isImage: false, isVideo: false })
  }
}
