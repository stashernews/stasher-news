/* eslint-env jest */
import { getServerSideProps } from '@/pages/admin'

test('the page guard ignores sessions and uses the gate header, with no-store responses', async () => {
  const secret = process.env.ADMIN_GATE_SECRET
  process.env.ADMIN_GATE_SECRET = 'a'.repeat(32)
  const res = { setHeader: jest.fn() }
  try {
    expect(await getServerSideProps({ req: { headers: { cookie: 'valid-session', 'x-api-key': 'anything' } }, res })).toEqual({ notFound: true })
    expect(await getServerSideProps({ req: { headers: { 'x-admin-gate': 'a'.repeat(32) } }, res })).toEqual({ props: {} })
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
  } finally {
    if (secret === undefined) delete process.env.ADMIN_GATE_SECRET
    else process.env.ADMIN_GATE_SECRET = secret
  }
})
