#!/usr/bin/env node
// Detach an UNPAID upload from a live item: drop the ItemUpload row, remove the
// media reference from Item.text and Item.imgproxyUrls, then delete the S3
// object and the Upload row. Used to remediate post 351432 (a fee-bearing edit
// attached an 18MB video whose upload fee was never paid — the deferred-edit
// fix now prevents new occurrences).
//
// Usage (run from repo root against a live, migrated stack):
//   docker exec -w /app -u apprunner app npx tsx --tsconfig jsconfig.json \
//     scripts/detach-unpaid-upload.js <itemId> <uploadId>
import { pathToFileURL } from 'url'
import { PrismaClient } from '@prisma/client'
import { deleteObjects } from '../api/s3'

// Removes markdown media/link references and bare occurrences of
// .../uploads/<id> (host-agnostic) while keeping surrounding prose.
export function stripUploadFromText (text, uploadId) {
  if (!text) return text
  const id = String(uploadId)
  const mediaOrLink = new RegExp(`!?\\[[^\\]]*\\]\\([^)]*\\/uploads\\/${id}(?![0-9])[^)]*\\)`, 'g')
  const bare = new RegExp(`\\S*\\/uploads\\/${id}(?![0-9])`, 'g')
  return text
    .replace(mediaOrLink, '')
    .replace(bare, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function stripUploadFromImgproxyUrls (imgproxyUrls, uploadId) {
  if (!imgproxyUrls || typeof imgproxyUrls !== 'object') return imgproxyUrls
  const matches = new RegExp(`\\/uploads\\/${uploadId}(?![0-9])`)
  const next = { ...imgproxyUrls }
  for (const key of Object.keys(next)) {
    if (matches.test(key)) delete next[key]
  }
  return next
}

export async function detachUnpaidUpload ({ models, itemId, uploadId }) {
  const itemUpload = await models.itemUpload.findUnique({
    where: { itemId_uploadId: { itemId, uploadId } }
  })
  if (!itemUpload) throw new Error(`upload ${uploadId} is not attached to item ${itemId}`)

  const upload = await models.upload.findUnique({ where: { id: uploadId } })
  if (!upload) throw new Error(`upload ${uploadId} not found`)
  if (upload.paid) throw new Error(`upload ${uploadId} is paid — refusing to detach`)

  const item = await models.item.findUnique({ where: { id: itemId } })
  if (!item) throw new Error(`item ${itemId} not found`)

  const text = stripUploadFromText(item.text, uploadId)
  const imgproxyUrls = stripUploadFromImgproxyUrls(item.imgproxyUrls, uploadId)

  await models.$transaction(async tx => {
    await tx.itemUpload.delete({ where: { itemId_uploadId: { itemId, uploadId } } })
    await tx.item.update({ where: { id: itemId }, data: { text, imgproxyUrls } })
  })

  // Remove the now-orphaned object + row immediately; the daily
  // deleteUnusedImages sweep would otherwise reap them after 24h.
  await deleteObjects([uploadId])
  await models.upload.delete({ where: { id: uploadId } })

  return { itemId, uploadId, text }
}

async function main () {
  const [itemId, uploadId] = process.argv.slice(2).map(Number)
  if (!Number.isInteger(itemId) || !Number.isInteger(uploadId)) {
    console.error('usage: detach-unpaid-upload.js <itemId> <uploadId>')
    process.exit(1)
  }

  const { loadEnvConfig } = await import('@next/env')
  loadEnvConfig('.', process.env.NODE_ENV === 'development')

  const models = new PrismaClient()
  try {
    const out = await detachUnpaidUpload({ models, itemId, uploadId })
    console.log(JSON.stringify(out, null, 2))
  } finally {
    await models.$disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
