/* eslint-env jest */

// Unit tests for the monero-lws REST client (Task 3).
//
// Transport is dependency-injected: every test passes a fake `transport`
// with the same contract the real (node:https-backed) transport honours —
// `{ status, ok, text: async () => string }`. This verifies REAL behaviour
// (exact URL/method/body sent, correct parsing of the real response shape
// including BigInt amounts, omitted mempool fields, the recipient object)
// without touching the network and without adding `nock` (which cannot
// intercept Node 22's undici-backed global fetch).
//
// The account row carries its own encrypted view-key envelope; the client
// decrypts it in-process via decryptViewKey (Task 2). We build a real
// envelope here so the decrypt path is exercised end-to-end.
//
// Run via the node:22.21.1 helper container:
//   docker exec sn-prisma npx jest test/api/monero/lwsClient.test.js

const LWS_MODULE = require.resolve('../../../api/monero/lwsClient')
const VK_MODULE = require.resolve('../../../api/monero/viewkey')

const LWS_URL = 'https://lws.test'
const ADMIN_URL = 'https://lws.test/admin'
const ADMIN_AUTH = 'deadbeefadminauth'
const ADDR = '5' + '1'.repeat(94) // 95-char Monero address placeholder
const VIEWKEY_HEX = '7e3d' + '0'.repeat(60) // 64-hex private view key
const MASTER_B64 = Buffer.from('a'.repeat(32)).toString('base64')

let lws
let vk

beforeEach(() => {
  process.env.VIEWKEY_MASTER_KEY = MASTER_B64
  jest.resetModules()
  lws = require(LWS_MODULE)
  vk = require(VK_MODULE)
})

// ---- mock-transport helpers ------------------------------------------------

function jsonRes (status, obj) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(obj)
  }
}

// A recording transport: pushes every {url, opts} it received and delegates
// to `responder({url, opts}, callNumber)`. callNumber is 1-based so tests can
// vary the response per attempt (e.g. 503 then 200).
function recordingTransport (responder) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    return responder({ url, opts }, calls.length)
  }
  fn.calls = calls
  return fn
}

// A transport that resolves after `delayMs` but rejects on abort — used to
// prove the client arms an AbortController for its response timeout.
function slowTransport (delayMs) {
  return (url, opts) => new Promise((resolve, reject) => {
    const done = () => resolve(jsonRes(200, { updated: [ADDR] }))
    const timer = setTimeout(done, delayMs)
    const signal = opts && opts.signal
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); reject(new Error('aborted')) }
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) })
    }
  })
}

function makeClient (transport, opts = {}) {
  return lws.createLwsClient({
    walletUrl: LWS_URL,
    adminUrl: ADMIN_URL,
    adminAuth: ADMIN_AUTH,
    transport,
    backoffBaseMs: 1, // near-instant retries
    maxRetries: opts.maxRetries ?? 0,
    timeoutMs: opts.timeoutMs ?? 5000,
    insecureTls: false,
    ...opts
  })
}

function makeAccount (id, addr, viewKeyHex) {
  return { id, address: addr, viewKey: vk.encryptViewKey(viewKeyHex) }
}

// ---- getAddressTxs ---------------------------------------------------------

describe('getAddressTxs', () => {
  test('sends {address, decrypted view_key, since_tx_id, since_tx_block_hash} and parses amounts + mempool omissions', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      total_received: '3117324236131',
      scanned_height: 1,
      scanned_block_height: 100,
      start_height: 0,
      transaction_height: 100,
      blockchain_height: 2265961,
      transactions: [
        {
          id: 1234567,
          hash: 'ab',
          total_received: '1000000',
          total_sent: '0',
          fee: '870000',
          unlock_time: 0,
          height: 100,
          mixin: 15,
          coinbase: false,
          mempool: false,
          recipient: { maj_i: 0, min_i: 3 },
          timestamp: '2026-07-25T12:00:00Z'
        },
        {
          id: 1234568,
          hash: 'cd',
          total_received: '5000',
          total_sent: '0',
          fee: '0',
          unlock_time: 0,
          mixin: 0,
          coinbase: false,
          mempool: true,
          recipient: { maj_i: 0, min_i: 7 }
          // height + timestamp intentionally omitted (mempool)
        }
      ]
    }))
    const client = makeClient(t)
    const account = makeAccount(1, ADDR, VIEWKEY_HEX)

    const out = await client.getAddressTxs(account, 5n, 'deadbeef')

    // request shape
    expect(t.calls[0].url).toBe(LWS_URL + '/get_address_txs')
    const body = JSON.parse(t.calls[0].opts.body)
    expect(body.address).toBe(ADDR)
    expect(body.view_key).toBe(VIEWKEY_HEX) // decrypted plaintext reached the wire
    expect(body.since_tx_id).toBe(5) // BigInt normalized to a JSON number
    expect(body.since_tx_block_hash).toBe('deadbeef')

    // response parsing
    expect(out.blockchain_height).toBe(2265961) // plain number, NOT BigInt
    expect(out.total_received).toBe(3117324236131n) // top-level amount -> BigInt
    expect(out.scanned_height).toBe(1)

    const confirmed = out.transactions[0]
    expect(confirmed.total_received).toBe(1000000n)
    expect(confirmed.total_sent).toBe(0n)
    expect(confirmed.fee).toBe(870000n)
    expect(confirmed.id).toBe(1234567) // number, not BigInt
    expect(confirmed.height).toBe(100)
    expect(confirmed.mixin).toBe(15)
    expect(confirmed.recipient).toEqual({ maj_i: 0, min_i: 3 })

    const mempool = out.transactions[1]
    expect(mempool.total_received).toBe(5000n)
    expect(mempool.height).toBeNull() // mempool omits height
    expect(mempool.timestamp).toBeNull() // mempool omits timestamp
    expect(mempool.payment_id).toBeNull() // optional, absent -> null
    expect(mempool.recipient).toEqual({ maj_i: 0, min_i: 7 })
  })

  test('omits since_tx_id / since_tx_block_hash when not supplied', async () => {
    const t = recordingTransport(() => jsonRes(200, { blockchain_height: 1, transactions: [] }))
    const client = makeClient(t)
    await client.getAddressTxs(makeAccount(1, ADDR, VIEWKEY_HEX))
    const body = JSON.parse(t.calls[0].opts.body)
    expect(body).not.toHaveProperty('since_tx_id')
    expect(body).not.toHaveProperty('since_tx_block_hash')
  })
})

// ---- view-key confidentiality ---------------------------------------------

describe('view-key confidentiality', () => {
  test('the decrypted view key reaches the wire but NEVER the thrown error or logs', async () => {
    const t = recordingTransport(() => jsonRes(500, { status: 'internal error' }))
    const client = makeClient(t, { maxRetries: 2 })
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    const account = makeAccount(7, ADDR, VIEWKEY_HEX)
    let thrown
    try { await client.getAddressTxs(account) } catch (e) { thrown = e }

    expect(thrown).toBeDefined()
    expect(t.calls.length).toBe(3) // initial + 2 retries
    // decrypt ran on every attempt (plaintext was sent on the wire)
    t.calls.forEach(c => {
      expect(JSON.parse(c.opts.body).view_key).toBe(VIEWKEY_HEX)
    })
    // the key must not appear anywhere in the thrown error or any console output
    expect(String(thrown.message)).not.toContain(VIEWKEY_HEX)
    expect(String(thrown.stack || '')).not.toContain(VIEWKEY_HEX)
    for (const args of errSpy.mock.calls) expect(String(args)).not.toContain(VIEWKEY_HEX)
    for (const args of logSpy.mock.calls) expect(String(args)).not.toContain(VIEWKEY_HEX)
    for (const args of warnSpy.mock.calls) expect(String(args)).not.toContain(VIEWKEY_HEX)
    errSpy.mockRestore(); logSpy.mockRestore(); warnSpy.mockRestore()
  })
})

// ---- other wallet endpoints -----------------------------------------------

describe('getAddressInfo', () => {
  test('sends {address, view_key} and parses amounts to BigInt', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      locked_funds: '5',
      total_received: '100',
      total_sent: '40',
      scanned_height: 1,
      blockchain_height: 10
    }))
    const client = makeClient(t)
    const out = await client.getAddressInfo(makeAccount(3, ADDR, VIEWKEY_HEX))
    expect(t.calls[0].url).toBe(LWS_URL + '/get_address_info')
    expect(JSON.parse(t.calls[0].opts.body)).toEqual({ address: ADDR, view_key: VIEWKEY_HEX })
    expect(out.locked_funds).toBe(5n)
    expect(out.total_received).toBe(100n)
    expect(out.total_sent).toBe(40n)
    expect(out.blockchain_height).toBe(10)
  })
})

describe('upsertSubaddrs', () => {
  test('sends decrypted view_key + ranges + get_all:true', async () => {
    const t = recordingTransport(() => jsonRes(200, {}))
    const client = makeClient(t)
    await client.upsertSubaddrs(makeAccount(2, ADDR, VIEWKEY_HEX), { 0: [[0, 499]] })
    const body = JSON.parse(t.calls[0].opts.body)
    expect(t.calls[0].url).toBe(LWS_URL + '/upsert_subaddrs')
    expect(body.address).toBe(ADDR)
    expect(body.view_key).toBe(VIEWKEY_HEX)
    expect(body.subaddrs).toEqual({ 0: [[0, 499]] })
    expect(body.get_all).toBe(true)
  })
})

// ---- admin endpoints -------------------------------------------------------

describe('addAccount', () => {
  test('POSTs {auth, params:{address, key}} to /add_account (note: key, not view_key)', async () => {
    const t = recordingTransport(() => jsonRes(200, { updated: [ADDR] }))
    const client = makeClient(t)
    const out = await client.addAccount(ADDR, VIEWKEY_HEX)
    expect(t.calls[0].url).toBe(ADMIN_URL + '/add_account')
    expect(JSON.parse(t.calls[0].opts.body)).toEqual({
      auth: ADMIN_AUTH, params: { address: ADDR, key: VIEWKEY_HEX }
    })
    expect(out).toEqual({ updated: [ADDR] })
  })
})

describe('modifyAccountStatus', () => {
  test('POSTs {auth, params:{status, addresses}} to /modify_account_status', async () => {
    const t = recordingTransport(() => jsonRes(200, { updated: [ADDR] }))
    const client = makeClient(t)
    await client.modifyAccountStatus([ADDR], 'inactive')
    expect(t.calls[0].url).toBe(ADMIN_URL + '/modify_account_status')
    expect(JSON.parse(t.calls[0].opts.body)).toEqual({
      auth: ADMIN_AUTH, params: { status: 'inactive', addresses: [ADDR] }
    })
  })
})

// ---- backoff + timeout -----------------------------------------------------

describe('retry policy', () => {
  test('retries on 503 (transient) and succeeds on the next attempt', async () => {
    const t = recordingTransport((_req, n) => n === 1 ? jsonRes(503, {}) : jsonRes(200, { updated: [ADDR] }))
    const client = makeClient(t, { maxRetries: 2 })
    const out = await client.addAccount(ADDR, VIEWKEY_HEX)
    expect(out).toEqual({ updated: [ADDR] })
    expect(t.calls.length).toBe(2)
  })

  test('retries on 429 (transient) up to maxRetries then throws the HTTP error', async () => {
    const t = recordingTransport(() => jsonRes(429, {}))
    const client = makeClient(t, { maxRetries: 2 })
    await expect(client.addAccount(ADDR, VIEWKEY_HEX)).rejects.toThrow(/returned HTTP 429/)
    expect(t.calls.length).toBe(3) // initial + 2 retries
  })

  test('does NOT retry on 400 (caller bug / auth failure) — throws immediately', async () => {
    const t = recordingTransport(() => jsonRes(400, { status: 'bad request' }))
    const client = makeClient(t, { maxRetries: 3 })
    await expect(client.addAccount(ADDR, VIEWKEY_HEX)).rejects.toThrow(/returned HTTP 400/)
    expect(t.calls.length).toBe(1)
  })

  test('retries on a transport network error then succeeds', async () => {
    const t = recordingTransport((_req, n) => {
      if (n === 1) {
        const e = new Error('connect ECONNREFUSED 127.0.0.1:8443')
        e.code = 'ECONNREFUSED'
        throw e
      }
      return jsonRes(200, { updated: [ADDR] })
    })
    const client = makeClient(t, { maxRetries: 2 })
    const out = await client.addAccount(ADDR, VIEWKEY_HEX)
    expect(out).toEqual({ updated: [ADDR] })
    expect(t.calls.length).toBe(2)
  })

  test('response timeout aborts the request (AbortController) and is surfaced', async () => {
    const client = makeClient(slowTransport(2000), { timeoutMs: 30, maxRetries: 0 })
    await expect(client.addAccount(ADDR, VIEWKEY_HEX)).rejects.toThrow(/timed out/i)
  })
})

// ---- singleton + factory ---------------------------------------------------

describe('module surface', () => {
  test('exports a singleton lwsClient with every endpoint method', () => {
    expect(lws.lwsClient).toBeDefined()
    expect(typeof lws.lwsClient.getAddressTxs).toBe('function')
    expect(typeof lws.lwsClient.getAddressInfo).toBe('function')
    expect(typeof lws.lwsClient.upsertSubaddrs).toBe('function')
    expect(typeof lws.lwsClient.addAccount).toBe('function')
    expect(typeof lws.lwsClient.modifyAccountStatus).toBe('function')
  })

  test('createLwsClient builds a real transport when none is injected (no throw, insecure flag honoured)', () => {
    expect(() => lws.createLwsClient({ insecureTls: false, walletUrl: LWS_URL, adminUrl: ADMIN_URL })).not.toThrow()
    expect(() => lws.createLwsClient({ insecureTls: true, walletUrl: LWS_URL, adminUrl: ADMIN_URL })).not.toThrow()
  })
})
