#!/usr/bin/env node
// Deploy docs/user/*.md documentation items (FAQ, guide, legal) as meta-turf
// admin items with the fixed ids baked into next.config.js rewrites and
// lib/constants.js ADMIN_ITEMS.
//
// Direct Prisma writes are used because the GraphQL upsertDiscussion path cannot
// create these items: an id-based upsert requires the item to already exist, and
// a create charges a posting fee. The item_path and item_subnames DB triggers
// (migration 20260802200000) maintain Item.path and Item.subNames automatically.
//
// Usage (run from repo root against a live, migrated stack):
//   SN_DOCS_AUTHOR_ID=616 tsx --tsconfig jsconfig.json scripts/deploy_user_documentation.js
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { loadEnvConfig } from '@next/env'
import { PrismaClient } from '@prisma/client'

loadEnvConfig('.', process.env.NODE_ENV === 'development')

const prisma = new PrismaClient()

const DOCS_DIR = path.join(process.cwd(), 'docs/user')
// ids are baked into next.config.js rewrites + lib/constants.js ADMIN_ITEMS
const DOCS = ['faq.md', 'guide.md', 'tos.md', 'privacy.md', 'copyright.md']
// must be in SN_ADMIN_IDS (lib/constants.js); defaults to USER_ID.untraceable (616)
const AUTHOR_ID = Number(process.env.SN_DOCS_AUTHOR_ID ?? 616)

export function parseFrontMatter (content) {
  const lines = content.split('\n')
  if (lines[0] !== '---') {
    throw new Error('failed to parse front matter: start delimiter not found')
  }

  const endIndex = lines.findIndex((line, i) => i > 0 && line === '---')
  if (endIndex === -1) {
    throw new Error('failed to parse front matter: end delimiter not found')
  }

  const meta = {}
  for (let i = 1; i < endIndex; i++) {
    const line = lines[i]
    const [key, ...valueParts] = line.split(':')
    if (key && valueParts.length) {
      meta[key.trim()] = valueParts.join(':').trim()
    }
  }

  return meta
}

export function readDoc (name) {
  const content = fs.readFileSync(path.join(DOCS_DIR, name), 'utf8')
  const lines = content.split('\n')
  const startIndex = lines.findIndex((line, i) => i > 0 && line.startsWith('---')) + 1
  return {
    ...parseFrontMatter(content),
    text: lines.slice(startIndex).join('\n')
  }
}

export async function upsertDoc ({ id, title, sub, text }) {
  const itemId = Number(id)
  if (!Number.isInteger(itemId) || !title || !sub || !text) {
    throw new Error(`doc ${id} missing valid id/title/sub/text`)
  }

  await prisma.item.upsert({
    where: { id: itemId },
    update: { title, text },
    create: {
      id: itemId,
      userId: AUTHOR_ID,
      title,
      text,
      status: 'ACTIVE',
      feeStatus: 'FEE_NOT_REQUIRED'
    }
  })

  // the item_subnames trigger recomputes Item.subNames from this join row
  await prisma.itemSub.upsert({
    where: { itemId_subName: { itemId, subName: sub } },
    update: {},
    create: { itemId, subName: sub }
  })

  console.log(`deployed "${title}" (id ${itemId})`)
}

async function main () {
  for (const name of DOCS) {
    await upsertDoc(readDoc(name))
  }
  await prisma.$disconnect()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
