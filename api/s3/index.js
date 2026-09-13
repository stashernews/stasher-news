import { S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { createPresignedPost as s3CreatePresignedPost } from '@aws-sdk/s3-presigned-post'
import { PUBLIC_MEDIA_URL } from '@/lib/constants'

const bucketRegion = 'us-east-1'
const Bucket = process.env.NEXT_PUBLIC_AWS_UPLOAD_BUCKET

// Cache S3Client instances per endpoint. The v3 SDK builds a credential
// provider chain and HTTP handler on construction, so reconstructing on every
// call is wasteful on hot upload paths. Key by endpoint because the
// construction call has endpoint as a param.
const s3ClientCache = new Map()

// Dedicated media-store credentials. The media S3Client must never resolve
// credentials from the default AWS chain: in the production worker the
// env-file chain ends with the offsite-backup file whose generic
// AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are the backup provider's keys —
// the chain silently signed MinIO deletes with those (InvalidAccessKeyId,
// 2026-09-13 incident). Self-hosted stores (custom endpoint) therefore
// REQUIRE these vars; real AWS S3 (no endpoint) keeps the default chain so
// mainnet can use AWS_* env vars or an IAM instance profile unchanged.
function resolveMediaCredentials () {
  const accessKeyId = process.env.MEDIA_AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.MEDIA_AWS_SECRET_ACCESS_KEY
  if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey }
  if (accessKeyId || secretAccessKey) {
    throw new Error('S3 media client: MEDIA_AWS_ACCESS_KEY_ID and MEDIA_AWS_SECRET_ACCESS_KEY must be set together')
  }
  return undefined
}

function getS3Client (endpoint) {
  // Warn if development is configured to use Amazon's S3 (no endpoint given)
  if (process.env.NODE_ENV === 'development' && !endpoint) {
    console.warn('S3 client: no development endpoint configured (NEXT_PUBLIC_MEDIA_URL/MEDIA_URL); requests will target real S3')
  }

  // Imitate v2 SDK behavior and ignore any paths given to the client, to be
  // able to keep the NEXT_PUBLIC_MEDIA_URL usage including paths elsewhere
  let s3Endpoint = endpoint
  if (s3Endpoint) {
    try { s3Endpoint = new URL(s3Endpoint).origin } catch {}
  }

  const cacheKey = s3Endpoint || ''
  const cached = s3ClientCache.get(cacheKey)
  if (cached) return cached

  let credentials
  if (s3Endpoint) {
    credentials = resolveMediaCredentials()
    if (!credentials) {
      throw new Error(
        'S3 media client: custom media endpoint (MEDIA_URL_DOCKER/NEXT_PUBLIC_MEDIA_URL) is configured but ' +
        'MEDIA_AWS_ACCESS_KEY_ID/MEDIA_AWS_SECRET_ACCESS_KEY are not set. The media client no longer reads ambient ' +
        'AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (the offsite-backup env shadows them with the backup provider keys). ' +
        'Set MEDIA_AWS_* to the media store credentials (the MinIO root pair).')
    }
  }

  const client = new S3Client({
    region: bucketRegion,
    // Path-style whenever a custom endpoint is used: MinIO has no bucket
    // subdomains, so virtual-host style (http://uploads.minio:9000/...) is
    // unresolvable. Real AWS S3 (no endpoint) uses virtual-host style.
    forcePathStyle: Boolean(s3Endpoint),
    ...(s3Endpoint && { endpoint: s3Endpoint }),
    ...(credentials && { credentials })
  })
  s3ClientCache.set(cacheKey, client)

  return client
}

// An explicit local S3-compatible store (MEDIA_URL_DOCKER, container-reachable)
// wins in ANY mode — that is what keeps prod-mode/stagenet pointed at MinIO
// instead of real AWS S3. Development falls back to the public media URL;
// production with neither stays undefined = real AWS S3 (mainnet, unchanged).
function resolveS3Endpoint (devFallback) {
  return process.env.MEDIA_URL_DOCKER ||
    (process.env.NODE_ENV === 'development' ? devFallback : undefined)
}

export async function createPresignedPost ({ key, type, size }) {
  const endpoint = resolveS3Endpoint(process.env.NEXT_PUBLIC_MEDIA_URL)
  const client = getS3Client(endpoint)

  const post = await s3CreatePresignedPost(client, {
    Bucket,
    Key: key,
    Expires: 300,
    Conditions: [
      { 'Content-Type': type },
      { 'Cache-Control': 'max-age=31536000' },
      { acl: 'public-read' },
      ['content-length-range', size, size]
    ],
    Fields: { key }
  })

  // Presigned POST signatures are host-agnostic (they cover the policy and
  // fields, not the URL), so the browser can POST to the PUBLIC origin even
  // though we signed against the container endpoint. With no endpoint (real
  // AWS) the SDK's URL is already correct — leave it untouched.
  if (endpoint) {
    const url = new URL(post.url)
    const publicUrl = new URL(PUBLIC_MEDIA_URL)
    url.protocol = publicUrl.protocol
    url.hostname = publicUrl.hostname
    url.port = publicUrl.port
    return { ...post, url: url.toString() }
  }

  return post
}

export async function deleteObjects (keys) {
  const endpoint = resolveS3Endpoint(PUBLIC_MEDIA_URL)
  const client = getS3Client(endpoint)

  // max 1000 keys per request
  // see https://docs.aws.amazon.com/cli/latest/reference/s3api/delete-objects.html
  const batchSize = 1000
  const deleted = []
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize)
    const params = {
      Bucket,
      Delete: {
        Objects: batch.map(key => ({ Key: String(key) }))
      }
    }
    const data = await client.send(new DeleteObjectsCommand(params))
    // S3 also reports per-object failures inside a 200 response (e.g.
    // AccessDenied per key) — treat those as failures too, not silent skips.
    if (data.Errors?.length) {
      const detail = data.Errors.map(({ Key, Code }) => `${Key}:${Code}`).join(', ')
      throw new Error(`deleteObjects: remote reported per-object errors: ${detail}`)
    }
    const confirmed = data.Deleted?.map(({ Key }) => parseInt(Key, 10)) || []
    deleted.push(...confirmed)
  }
  return deleted
}
