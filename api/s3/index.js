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

  const client = new S3Client({
    region: bucketRegion,
    // Path-style whenever a custom endpoint is used: MinIO has no bucket
    // subdomains, so virtual-host style (http://uploads.minio:9000/...) is
    // unresolvable. Real AWS S3 (no endpoint) uses virtual-host style.
    forcePathStyle: Boolean(s3Endpoint),
    ...(s3Endpoint && { endpoint: s3Endpoint })
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
    try {
      const params = {
        Bucket,
        Delete: {
          Objects: batch.map(key => ({ Key: String(key) }))
        }
      }
      const data = await client.send(new DeleteObjectsCommand(params))
      const confirmed = data.Deleted?.map(({ Key }) => parseInt(Key, 10)) || []
      deleted.push(...confirmed)
    } catch (err) {
      console.error(err)
    }
  }
  return deleted
}
