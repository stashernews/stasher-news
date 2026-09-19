import https from 'node:https'
import http from 'node:http'

// monerod restricted-RPC client (Task 6 / spec §5.5).
//
// monero-lws's /get_address_txs response carries per-tx heights but NO block
// hash (docs/monero-lws-research.md §5.2 / §light_wallet.cpp:494-531), so the
// reorg-safe cursor's `since_tx_block_hash` dimension has to be sourced
// elsewhere. monerod's `get_block_header_by_height` JSON-RPC returns exactly
// that — the hash for a given height — and is a read-only header call the
// restricted RPC permits (docs/specs/2026-07-25-...md:1326 lists MONEROD_URL as
// the restricted RPC endpoint).
//
// This is a SEPARATE daemon from lws (different process, different transport:
// monerod JSON-RPC over plain HTTP vs. lws REST), so it gets its own client
// module rather than growing api/monero/lwsClient.js. The factory mirrors the
// lwsClient DI seam — `createDaemonClient({ transport })` with a default real
// transport on node:http/https — so tests inject a fake transport with the same
// `{status, ok, text()}` shape and never touch the network.
//
// No retry/backoff: a transient failure surfaces as a throw and is retried by
// the indexer's next 20s poll (MONERO_POLL_INTERVAL_MS). Keeping this layer
// single-shot avoids a retry storm against monerod and matches the "small
// helper" remit.

const DEFAULT_TIMEOUT_MS = 15000

// monerod's restricted RPC rejects /get_transactions requests carrying more
// than 100 hashes: HTTP 200, `status: "Too many transactions requested in
// restricted mode"`, and NO `txs` array (verified v0.18.5.1). Batch at 50 —
// comfortably under the cap, and decode_as_json responses stay smaller.
export const MAX_TX_HASHES_PER_REQUEST = 50

class DaemonHttpError extends Error {
  constructor (status) {
    super(`monerod JSON-RPC returned HTTP ${status}`)
    this.name = 'DaemonHttpError'
    this.status = status
  }
}

class DaemonRpcError extends Error {
  constructor (method, rpcError) {
    const code = rpcError && rpcError.code != null ? ` (code ${rpcError.code})` : ''
    super(`monerod ${method} RPC error${code}: ${rpcError && rpcError.message ? rpcError.message : 'unknown'}`)
    this.name = 'DaemonRpcError'
    this.method = method
    this.rpcError = rpcError
  }
}

function readEnv (name, fallback) {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

// Real transport on node:http/https — same shape as lwsClient's real transport
// ({status, ok, text}). Honours an AbortSignal so the client response timeout
// can destroy a hung request.
function makeTransport () {
  return function transport (url, { method = 'POST', headers = {}, body, signal } = {}) {
    return new Promise((resolve, reject) => {
      const lib = url.startsWith('https://') ? https : http
      const reqHeaders = { 'content-type': 'application/json', accept: 'application/json', ...headers }
      if (body !== undefined && body !== null) reqHeaders['content-length'] = Buffer.byteLength(body)
      const req = lib.request(url, {
        method,
        headers: reqHeaders
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            text: async () => text
          })
        })
      })
      req.on('error', reject)
      if (signal) {
        if (signal.aborted) req.destroy(new Error('aborted'))
        else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
      }
      if (body !== undefined && body !== null) req.write(body)
      req.end()
    })
  }
}

function parseJsonText (text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

/**
 * Build a monerod JSON-RPC client.
 *
 * @param {object} [options]
 * @param {string} [options.daemonUrl]   MONEROD_URL. If unset here AND in env, calls throw clearly.
 * @param {number} [options.timeoutMs]   Response timeout (default 15000).
 * @param {function} [options.transport] Injected transport (DI for tests).
 * @returns {object} `{ getBlockHashByHeight, rpc }`
 */
export function createDaemonClient (options = {}) {
  // `undefined` (not a fallback URL) when neither option nor env supplies one,
  // so getBlockHashByHeight can fail clearly instead of silently hitting a
  // fabricated address.
  const daemonUrl = options.daemonUrl !== undefined
    ? options.daemonUrl
    : (readEnv('MONEROD_URL', undefined) || undefined)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const transport = options.transport ?? makeTransport()

  function requireUrl () {
    if (!daemonUrl) {
      throw new Error('monerod: MONEROD_URL is not configured; cannot source block hashes for the reorg cursor')
    }
    return daemonUrl.replace(/\/$/, '')
  }

  async function rpc (method, params) {
    const base = requireUrl()
    const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res
    try {
      res = await transport(`${base}/json_rpc`, { method: 'POST', body, signal: ac.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new DaemonHttpError(res.status)
    const json = parseJsonText(await res.text())
    if (!json) throw new Error(`monerod ${method}: empty/unparseable response`)
    if (json.error) throw new DaemonRpcError(method, json.error)
    return json.result
  }

  /**
   * Fetch a block hash by height via get_block_header_by_height.
   * @param {number} height
   * @returns {Promise<string>} the block hash (hex)
   */
  async function getBlockHashByHeight (height) {
    const result = await rpc('get_block_header_by_height', { height })
    const hash = result && result.block_header && result.block_header.hash
    if (!hash) throw new Error(`monerod get_block_header_by_height(${height}) returned no block_header.hash`)
    return hash
  }

  async function getHeight () {
    const result = await rpc('get_info', {})
    const height = result && result.height
    if (typeof height !== 'number') throw new Error('monerod get_info returned no height')
    return height
  }

  // One ≤MAX_TX_HASHES_PER_REQUEST batch: POST, HTTP/status validation, raw
  // monerod `txs` array back. Any non-OK status (the restricted-mode cap
  // included) throws — a silent [] here would masquerade as "nothing on
  // chain" and let a paid tip expire (mainnet incident 2026-09-15).
  async function fetchTxBatch (base, hashes) {
    const body = JSON.stringify({ txs_hashes: hashes, decode_as_json: true })
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res
    try {
      res = await transport(`${base}/get_transactions`, { method: 'POST', body, signal: ac.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new DaemonHttpError(res.status)
    const json = parseJsonText(await res.text())
    if (!json || json.status !== 'OK') {
      throw new DaemonRpcError('get_transactions', {
        message: `${json && json.status ? json.status : 'empty/unparseable response'} (requested ${hashes.length} hashes)`
      })
    }
    return Array.isArray(json.txs) ? json.txs : []
  }

  /**
   * Fetch raw transactions by hash via the plain (non-json_rpc)
   * /get_transactions endpoint, returning each tx's extra blob plus its vout
   * target keys. The caller (reconcilePendingTips' wrong-pid fallback) needs
   * the tx public key(s) + encrypted payment id from the extra; the vout keys
   * feed the recipient ownership proof (a 0-conf tx is only credited when one
   * of its outputs derives to the claimed recipient). decode_as_json hands
   * back the parsed tx as a JSON string; monerod serializes `extra` as a byte
   * array (older builds: hex string) — both are normalized to a Buffer. vout
   * entries are reduced to their one-time key (legacy `target.key` or v2
   * `target.tagged_key.key`), with null preserved for entries that carry no
   * key. Restricted RPC permits this endpoint but caps a single request at 100
   * hashes, so hashes are batched at MAX_TX_HASHES_PER_REQUEST and a non-OK
   * status throws instead of returning an empty list. Mempool txs are returned
   * too (in_pool). Missed hashes are omitted.
   * @param {string[]} hashes
   * @returns {Promise<Array<{hash: string, extra: Buffer, vout: Array<string|null>}>>}
   */
  async function getTransactions (hashes) {
    if (!Array.isArray(hashes) || hashes.length === 0) return []
    const base = requireUrl()
    const out = []
    for (let i = 0; i < hashes.length; i += MAX_TX_HASHES_PER_REQUEST) {
      const txs = await fetchTxBatch(base, hashes.slice(i, i + MAX_TX_HASHES_PER_REQUEST))
      for (const tx of txs) {
        if (!tx || !tx.tx_hash) continue
        let extra = null
        let vout = []
        if (typeof tx.as_json === 'string' && tx.as_json) {
          try {
            const parsed = JSON.parse(tx.as_json)
            if (Array.isArray(parsed.extra)) extra = Buffer.from(parsed.extra)
            else if (typeof parsed.extra === 'string') extra = Buffer.from(parsed.extra, 'hex')
            if (Array.isArray(parsed.vout)) {
              vout = parsed.vout.map((o) => o?.target?.key ?? o?.target?.tagged_key?.key ?? null)
            }
          } catch {
            // unparseable as_json: omit the tx (caller treats as not-found)
          }
        }
        if (extra != null) out.push({ hash: tx.tx_hash, extra, vout })
      }
    }
    return out
  }

  return { getBlockHashByHeight, getHeight, getTransactions, rpc }
}

// Singleton: constructed once at module load from MONEROD_URL. The worker
// imports this directly; tests inject via createDaemonClient({ transport }).
export const daemonClient = createDaemonClient()
