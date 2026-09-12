/* eslint-env jest */

// Unit tests for the monerod restricted-RPC client (Task 6 / spec §5.5).
//
// monero-lws returns no block hash in its /get_address_txs response, so the
// indexer sources the cursor's `since_tx_block_hash` from monerod's
// `get_block_header_by_height` JSON-RPC instead. Transport is dependency-
// injected (same DI seam + {status, ok, text} contract the lwsClient tests use)
// so these tests exercise the REAL request/response behaviour without touching
// the network.
//
// Run via the node:22.21.1 helper container:
//   docker exec sn-prisma npx jest test/api/monero/daemonClient.test.js

const DAEMON_MODULE = require.resolve('../../../api/monero/daemonClient')

const MONEROD_URL = 'http://monerod:38081'

let daemon

beforeEach(() => {
  jest.resetModules()
  delete process.env.MONEROD_URL
  daemon = require(DAEMON_MODULE)
})

// ---- mock-transport helpers (same shape as lwsClient tests) ----------------

function jsonRes (status, obj) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(obj)
  }
}

function recordingTransport (responder) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts })
    return responder({ url, opts }, calls.length)
  }
  fn.calls = calls
  return fn
}

function makeClient (transport, opts = {}) {
  return daemon.createDaemonClient({ daemonUrl: MONEROD_URL, transport, ...opts })
}

// ---- getBlockHashByHeight --------------------------------------------------

describe('getBlockHashByHeight', () => {
  test('POSTs a JSON-RPC get_block_header_by_height and returns result.block_header.hash', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      id: '0',
      jsonrpc: '2.0',
      result: { block_header: { hash: 'deadbeef', height: 195, depth: 10 } }
    }))
    const client = makeClient(t)

    const hash = await client.getBlockHashByHeight(195)

    expect(t.calls[0].url).toBe(MONEROD_URL + '/json_rpc')
    expect(t.calls[0].opts.method).toBe('POST')
    const body = JSON.parse(t.calls[0].opts.body)
    expect(body).toEqual({ jsonrpc: '2.0', id: '0', method: 'get_block_header_by_height', params: { height: 195 } })
    expect(hash).toBe('deadbeef')
  })

  test('throws a clear error when monerod returns an RPC-level error', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      id: '0',
      jsonrpc: '2.0',
      error: { code: -26, message: 'block not found' }
    }))
    const client = makeClient(t)
    await expect(client.getBlockHashByHeight(999999)).rejects.toThrow(/get_block_header_by_height/)
  })

  test('throws on a non-2xx HTTP status', async () => {
    const t = recordingTransport(() => jsonRes(500, {}))
    const client = makeClient(t)
    await expect(client.getBlockHashByHeight(195)).rejects.toThrow(/HTTP 500/)
  })

  test('throws when the response is missing block_header.hash', async () => {
    const t = recordingTransport(() => jsonRes(200, { id: '0', jsonrpc: '2.0', result: {} }))
    const client = makeClient(t)
    await expect(client.getBlockHashByHeight(195)).rejects.toThrow(/block_header/)
  })
})

// ---- config fail-closed ----------------------------------------------------

describe('configuration', () => {
  test('throws a clear error when MONEROD_URL is unset (never silently skip block-hash sourcing)', async () => {
    const client = daemon.createDaemonClient({ transport: recordingTransport(() => jsonRes(200, {})) })
    await expect(client.getBlockHashByHeight(195)).rejects.toThrow(/MONEROD_URL/)
  })

  test('uses MONEROD_URL from the env for the singleton', async () => {
    process.env.MONEROD_URL = 'http://env-monerod:38081'
    jest.resetModules()
    const fresh = require(DAEMON_MODULE)
    const t = recordingTransport(() => jsonRes(200, {
      id: '0', jsonrpc: '2.0', result: { block_header: { hash: 'cafe', height: 1 } }
    }))
    const client = fresh.createDaemonClient({ transport: t }) // daemonUrl read from env when omitted
    delete process.env.MONEROD_URL
    await client.getBlockHashByHeight(1)
    expect(t.calls[0].url).toBe('http://env-monerod:38081/json_rpc')
  })
})

// ---- getTransactions --------------------------------------------------------

describe('getTransactions', () => {
  test('POSTs to the plain /get_transactions endpoint with decode_as_json and returns extras', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      txs: [{
        tx_hash: 'abc123',
        as_json: JSON.stringify({ version: 2, extra: [1, 2, 3, 4] })
      }],
      missed_txs: []
    }))
    const client = makeClient(t)
    const out = await client.getTransactions(['abc123', 'missing'])
    expect(t.calls[0].url).toBe(`${MONEROD_URL}/get_transactions`)
    expect(JSON.parse(t.calls[0].opts.body)).toEqual({ txs_hashes: ['abc123', 'missing'], decode_as_json: true })
    expect(out).toEqual([{ hash: 'abc123', extra: Buffer.from([1, 2, 3, 4]) }])
  })

  test('normalizes a hex-string extra (older monerod builds) to a Buffer', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      txs: [{ tx_hash: 'abc', as_json: JSON.stringify({ extra: 'deadbeef' }) }]
    }))
    const client = makeClient(t)
    const out = await client.getTransactions(['abc'])
    expect(out[0].extra).toEqual(Buffer.from('deadbeef', 'hex'))
  })

  test('omits txs with unparseable as_json rather than throwing', async () => {
    const t = recordingTransport(() => jsonRes(200, {
      txs: [
        { tx_hash: 'bad', as_json: '{not json' },
        { tx_hash: 'none' },
        { tx_hash: 'good', as_json: JSON.stringify({ extra: [9] }) }
      ]
    }))
    const client = makeClient(t)
    const out = await client.getTransactions(['bad', 'none', 'good'])
    expect(out).toEqual([{ hash: 'good', extra: Buffer.from([9]) }])
  })

  test('throws a DaemonHttpError on a non-2xx status', async () => {
    const t = recordingTransport(() => jsonRes(500, {}))
    const client = makeClient(t)
    await expect(client.getTransactions(['abc'])).rejects.toThrow(/HTTP 500/)
  })
})

// ---- module surface --------------------------------------------------------

describe('module surface', () => {
  test('exports a singleton daemonClient with getBlockHashByHeight and getTransactions', () => {
    expect(daemon.daemonClient).toBeDefined()
    expect(typeof daemon.daemonClient.getBlockHashByHeight).toBe('function')
    expect(typeof daemon.daemonClient.getTransactions).toBe('function')
  })

  test('createDaemonClient builds a real transport when none is injected (no throw)', () => {
    expect(() => daemon.createDaemonClient({ daemonUrl: MONEROD_URL })).not.toThrow()
  })
})
