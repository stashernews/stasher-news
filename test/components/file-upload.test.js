/* eslint-env jest */
import { uploadToS3 } from '@/components/file-upload'

// piexifjs (imported by the component for EXIF stripping) is irrelevant to the
// pure upload helper; stub it so module load stays light and deterministic.
jest.mock('piexifjs', () => ({ __esModule: true, default: {} }))

const signedPost = {
  url: 'https://stasher.news/uploads/42',
  fields: {
    key: '42',
    Policy: 'POLICY',
    'X-Amz-Signature': 'SIG',
    'Content-Type': 'image/png'
  }
}

const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'testmeme.png', { type: 'image/png' })

function readForm (body) {
  const entries = {}
  body.forEach((value, key) => { entries[key] = value })
  return entries
}

// These tests pin the root-cause-#2 contract: the upload helper must SETTLE on
// every path (reject by throwing), so the editor's ![Uploading …]() placeholder
// is always swapped or cleared by the caller. Previously the network fetch and
// the data-destructure sat outside try/catch inside an async onload handler, so
// a rejection escaped the Promise constructor and the placeholder hung forever.
describe('uploadToS3 — rejects on every failure path instead of hanging', () => {
  test('rejects when the S3 POST fetch fails at the network layer', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.reject(new TypeError('NetworkError when attempting to fetch resource.')))
    await expect(uploadToS3({ file: pngFile, signedPost, fetchImpl }))
      .rejects.toThrow('NetworkError')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('rejects when the mutation returned no signed POST (undefined data)', async () => {
    const fetchImpl = jest.fn()
    await expect(uploadToS3({ file: pngFile, signedPost: undefined, fetchImpl }))
      .rejects.toThrow(/signed POST/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('rejects with statusText on a non-2xx response', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.resolve({ ok: false, status: 403, statusText: 'Forbidden' }))
    await expect(uploadToS3({ file: pngFile, signedPost, fetchImpl }))
      .rejects.toThrow('Forbidden')
  })

  test('posts presigned fields + file and returns { id, url } on success', async () => {
    const fetchImpl = jest.fn(() => Promise.resolve({ ok: true, status: 204 }))
    const { id, url } = await uploadToS3({
      file: pngFile,
      signedPost,
      fetchImpl,
      mediaUrl: 'https://stasher.news/uploads'
    })
    expect(id).toBe('42')
    expect(url).toBe('https://stasher.news/uploads/42')

    const [calledUrl, init] = fetchImpl.mock.calls[0]
    expect(calledUrl).toBe('https://stasher.news/uploads/42')
    expect(init.method).toBe('POST')
    const form = readForm(init.body)
    expect(form.key).toBe('42')
    expect(form.Policy).toBe('POLICY')
    expect(form['Content-Type']).toBe('image/png')
    expect(form['Cache-Control']).toBe('max-age=31536000')
    expect(form.acl).toBe('public-read')
    expect(form.file).toBe(pngFile)
  })
})
