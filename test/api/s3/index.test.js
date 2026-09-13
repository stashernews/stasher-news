/* eslint-env jest */

// Unit tests for api/s3 endpoint resolution. Prod mode (`next start`) must
// keep presigned POSTs and object deletes pointed at the local S3-compatible
// store (MinIO) when MEDIA_URL_DOCKER is set, and must leave mainnet (no
// endpoint configured) routing to real AWS untouched. All AWS SDK calls are
// mocked — no network, no DB.

const ENV_KEYS = [
  'NODE_ENV',
  'MEDIA_URL_DOCKER',
  'NEXT_PUBLIC_MEDIA_URL',
  'NEXT_PUBLIC_MEDIA_DOMAIN',
  'NEXT_PUBLIC_AWS_UPLOAD_BUCKET',
  'MEDIA_AWS_ACCESS_KEY_ID',
  'MEDIA_AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY'
]

const savedEnv = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  jest.resetModules()
  jest.clearAllMocks()
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(function (opts) {
    this.opts = opts
    // mirror a real S3 delete response: confirm every key we asked for
    this.send = jest.fn(async (command) => ({
      Deleted: (command.params?.Delete?.Objects || []).map(({ Key }) => ({ Key }))
    }))
  }),
  DeleteObjectsCommand: jest.fn(function (params) {
    this.params = params
  })
}))

jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: jest.fn(async (client, params) => {
    // mirror the v3 SDK's host composition: path-style for custom endpoints
    // (endpoint/bucket/key), virtual-host style for real AWS
    const url = client.opts.endpoint
      ? `${client.opts.endpoint}/${params.Bucket}/${params.Key}?X-Amz-Signature=test`
      : `https://${params.Bucket}.s3.us-east-1.amazonaws.com/${params.Key}?X-Amz-Signature=test`
    return { url, fields: { key: params.Key } }
  })
}))

// api/s3/index.js reads env at import/call time; re-import everything after
// resetModules so Bucket and PUBLIC_MEDIA_URL are fresh per test.
async function loadS3 () {
  const s3 = await import('@/api/s3')
  const { S3Client, DeleteObjectsCommand } = await import('@aws-sdk/client-s3')
  return { ...s3, S3Client, DeleteObjectsCommand }
}

describe('createPresignedPost — endpoint selection', () => {
  test('development without MEDIA_URL_DOCKER signs against NEXT_PUBLIC_MEDIA_URL and keeps the URL', async () => {
    process.env.NODE_ENV = 'development'
    process.env.NEXT_PUBLIC_MEDIA_URL = 'http://localhost:4566/uploads'
    process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET = 'uploads'
    process.env.MEDIA_AWS_ACCESS_KEY_ID = 'media-root-key'
    process.env.MEDIA_AWS_SECRET_ACCESS_KEY = 'media-root-secret'

    const { createPresignedPost, S3Client } = await loadS3()
    const post = await createPresignedPost({ key: '1', type: 'image/png', size: 1024 })

    expect(S3Client).toHaveBeenCalledTimes(1)
    const [clientArgs] = S3Client.mock.calls[0]
    expect(clientArgs.endpoint).toBe('http://localhost:4566')
    expect(clientArgs.forcePathStyle).toBe(true)
    expect(clientArgs.credentials).toEqual({ accessKeyId: 'media-root-key', secretAccessKey: 'media-root-secret' })
    expect(post.url).toBe('http://localhost:4566/uploads/1?X-Amz-Signature=test')
    expect(post.fields).toEqual({ key: '1' })
  })

  test('production with MEDIA_URL_DOCKER signs against the docker endpoint and rewrites the POST url to the public origin', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MEDIA_URL_DOCKER = 'http://minio:9000/uploads'
    process.env.NEXT_PUBLIC_MEDIA_URL = 'https://stasher.news/uploads'
    process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET = 'uploads'
    process.env.MEDIA_AWS_ACCESS_KEY_ID = 'media-root-key'
    process.env.MEDIA_AWS_SECRET_ACCESS_KEY = 'media-root-secret'

    const { createPresignedPost, S3Client } = await loadS3()
    const post = await createPresignedPost({ key: '123', type: 'image/png', size: 1024 })

    expect(S3Client).toHaveBeenCalledTimes(1)
    const [clientArgs] = S3Client.mock.calls[0]
    expect(clientArgs.endpoint).toBe('http://minio:9000') // getS3Client strips the path
    expect(clientArgs.forcePathStyle).toBe(true)
    expect(clientArgs.credentials).toEqual({ accessKeyId: 'media-root-key', secretAccessKey: 'media-root-secret' })
    expect(post.url).toBe('https://stasher.news/uploads/123?X-Amz-Signature=test')
    expect(post.fields).toEqual({ key: '123' })
  })

  test('production rewrite falls back to NEXT_PUBLIC_MEDIA_DOMAIN when NEXT_PUBLIC_MEDIA_URL is unset', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MEDIA_URL_DOCKER = 'http://minio:9000/uploads'
    process.env.NEXT_PUBLIC_MEDIA_DOMAIN = 'm.stasher.news'
    process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET = 'uploads'
    process.env.MEDIA_AWS_ACCESS_KEY_ID = 'media-root-key'
    process.env.MEDIA_AWS_SECRET_ACCESS_KEY = 'media-root-secret'

    const { createPresignedPost } = await loadS3()
    const post = await createPresignedPost({ key: '7', type: 'image/png', size: 1024 })

    expect(post.url).toBe('https://m.stasher.news/uploads/7?X-Amz-Signature=test')
  })

  test('production without MEDIA_URL_DOCKER keeps the real AWS URL untouched', async () => {
    process.env.NODE_ENV = 'production'
    process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET = 'snuploads'

    const { createPresignedPost, S3Client } = await loadS3()
    const post = await createPresignedPost({ key: '9', type: 'image/png', size: 1024 })

    expect(S3Client).toHaveBeenCalledTimes(1)
    const [clientArgs] = S3Client.mock.calls[0]
    expect(clientArgs.endpoint).toBeUndefined()
    expect(clientArgs.forcePathStyle).toBe(false)
    expect(clientArgs.credentials).toBeUndefined()
    expect(post.url).toBe('https://snuploads.s3.us-east-1.amazonaws.com/9?X-Amz-Signature=test')
  })
})

describe('deleteObjects — endpoint selection', () => {
  test('production with MEDIA_URL_DOCKER deletes via the docker endpoint', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MEDIA_URL_DOCKER = 'http://minio:9000/uploads'
    process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET = 'uploads'
    process.env.MEDIA_AWS_ACCESS_KEY_ID = 'media-root-key'
    process.env.MEDIA_AWS_SECRET_ACCESS_KEY = 'media-root-secret'

    const { deleteObjects, S3Client, DeleteObjectsCommand } = await loadS3()
    const deleted = await deleteObjects([1, 2])

    expect(S3Client).toHaveBeenCalledTimes(1)
    const [clientArgs] = S3Client.mock.calls[0]
    expect(clientArgs.endpoint).toBe('http://minio:9000')
    expect(clientArgs.forcePathStyle).toBe(true)
    expect(clientArgs.credentials).toEqual({ accessKeyId: 'media-root-key', secretAccessKey: 'media-root-secret' })
    expect(DeleteObjectsCommand).toHaveBeenCalledWith({
      Bucket: 'uploads',
      Delete: { Objects: [{ Key: '1' }, { Key: '2' }] }
    })
    expect(deleted).toEqual([1, 2])
  })

  test('production without MEDIA_URL_DOCKER deletes via real AWS', async () => {
    process.env.NODE_ENV = 'production'
    process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET = 'snuploads'

    const { deleteObjects, S3Client } = await loadS3()
    const deleted = await deleteObjects([1, 2])

    expect(S3Client).toHaveBeenCalledTimes(1)
    const [clientArgs] = S3Client.mock.calls[0]
    expect(clientArgs.endpoint).toBeUndefined()
    expect(clientArgs.forcePathStyle).toBe(false)
    expect(clientArgs.credentials).toBeUndefined()
    expect(deleted).toEqual([1, 2])
  })
})

describe('media credential selection', () => {
  test('client gets dedicated MEDIA_AWS_* credentials, never ambient AWS_* (offsite-backup shadowing regression)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MEDIA_URL_DOCKER = 'http://minio:9000/uploads'
    process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET = 'uploads'
    process.env.MEDIA_AWS_ACCESS_KEY_ID = 'media-root-key'
    process.env.MEDIA_AWS_SECRET_ACCESS_KEY = 'media-root-secret'
    process.env.AWS_ACCESS_KEY_ID = 'backup-provider-key'
    process.env.AWS_SECRET_ACCESS_KEY = 'backup-provider-secret'

    const { deleteObjects, S3Client } = await loadS3()
    await deleteObjects([1])

    const [clientArgs] = S3Client.mock.calls[0]
    expect(clientArgs.credentials).toEqual({ accessKeyId: 'media-root-key', secretAccessKey: 'media-root-secret' })
  })

  test('self-hosted endpoint without MEDIA_AWS_* fails fast with a descriptive error', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MEDIA_URL_DOCKER = 'http://minio:9000/uploads'
    process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET = 'uploads'

    const { deleteObjects } = await loadS3()
    await expect(deleteObjects([1])).rejects.toThrow(/MEDIA_AWS_ACCESS_KEY_ID/)
  })

  test('one-sided MEDIA_AWS_* config fails fast', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MEDIA_URL_DOCKER = 'http://minio:9000/uploads'
    process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET = 'uploads'
    process.env.MEDIA_AWS_ACCESS_KEY_ID = 'media-root-key'

    const { createPresignedPost } = await loadS3()
    await expect(createPresignedPost({ key: '1', type: 'image/png', size: 10 })).rejects.toThrow(/must be set together/)
  })
})

describe('deleteObjects — failure loudness', () => {
  test('a credential error from the store rejects instead of being swallowed', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MEDIA_URL_DOCKER = 'http://minio:9000/uploads'
    process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET = 'uploads'
    process.env.MEDIA_AWS_ACCESS_KEY_ID = 'media-root-key'
    process.env.MEDIA_AWS_SECRET_ACCESS_KEY = 'media-root-secret'

    const { deleteObjects } = await loadS3()
    const { S3Client } = await import('@aws-sdk/client-s3')
    S3Client.mockImplementationOnce(function () {
      this.send = jest.fn(async () => {
        throw new Error('The AWS Access Key Id you provided does not exist in our records. (InvalidAccessKeyId)')
      })
    })
    await expect(deleteObjects([1, 2])).rejects.toThrow(/InvalidAccessKeyId/)
  })

  test('per-object errors inside a 200 response reject the whole call', async () => {
    process.env.NODE_ENV = 'production'
    process.env.MEDIA_URL_DOCKER = 'http://minio:9000/uploads'
    process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET = 'uploads'
    process.env.MEDIA_AWS_ACCESS_KEY_ID = 'media-root-key'
    process.env.MEDIA_AWS_SECRET_ACCESS_KEY = 'media-root-secret'

    const { deleteObjects } = await loadS3()
    const { S3Client } = await import('@aws-sdk/client-s3')
    S3Client.mockImplementationOnce(function () {
      this.send = jest.fn(async () => ({
        Deleted: [{ Key: '1' }],
        Errors: [{ Key: '2', Code: 'AccessDenied', Message: 'Access Denied' }]
      }))
    })
    await expect(deleteObjects([1, 2])).rejects.toThrow(/AccessDenied/)
  })
})
