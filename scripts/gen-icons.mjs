import sharp from 'sharp'
import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const ORANGE = '#FF6600'
const DARK_BG = '#121214'
const LIGHT_BG = '#fcfcff'

// s-monogram.svg has explicit fills for tile, glyph, and dot.
// For legacy sn.svg (no fill attribute, CSS drives it) we baked in orange —
// the root-level fill attr below is harmless as a fallback for either source.
const svgRaw = readFileSync(resolve(root, process.argv[2] || 'svgs/s-monogram.svg'), 'utf8')
const svgFilled = svgRaw.replace('<svg', `<svg fill="${ORANGE}"`)

const SIZES = [48, 72, 96, 128, 192, 384, 512]

async function genIcon (size, outPath, { maskable = false } = {}) {
  const dim = size
  if (maskable) {
    // maskable icons need padding (~20% safe zone) + solid background
    const logoSize = Math.round(dim * 0.6)
    const logo = await sharp(Buffer.from(svgFilled))
      .resize(logoSize, logoSize)
      .png()
      .toBuffer()
    await sharp({
      create: { width: dim, height: dim, channels: 4, background: DARK_BG }
    })
      .composite([{ input: logo, gravity: 'center' }])
      .png()
      .toFile(outPath)
  } else {
    await sharp(Buffer.from(svgFilled))
      .resize(dim, dim)
      .png()
      .toFile(outPath)
  }
}

// Packs PNG frames into an .ico container (ICO directory + embedded PNGs).
function packIco (frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  const entries = []
  let offset = 6 + 16 * frames.length
  for (const frame of frames) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(frame.width === 256 ? 0 : frame.width, 0)
    entry.writeUInt8(frame.height === 256 ? 0 : frame.height, 1)
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bit depth
    entry.writeUInt32LE(frame.data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += frame.data.length
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.data)])
}

async function genFaviconIco () {
  const frames = []
  for (const s of [16, 32, 48, 64]) {
    const data = await sharp(Buffer.from(svgFilled)).resize(s, s).png().toBuffer()
    frames.push({ width: s, height: s, data })
  }
  writeFileSync(resolve(root, 'public/favicon.ico'), packIco(frames))
}

// Notification/comments badge overlays, drawn on a 256px monogram canvas.
// notify: solid orange dot at the top-right; comments: speech bubble (rounded
// rect + down-left tail) at the bottom-left; combined: both.
const NOTIFY_BADGE = '<circle cx="212" cy="32" r="18" fill="#FF6600"/>'
const COMMENTS_BADGE = '<path d="M14 164 H54 A8 8 0 0 1 62 172 V200 A8 8 0 0 1 54 208 H14 A8 8 0 0 1 6 200 V172 A8 8 0 0 1 14 164 Z M11 208 L14 224 L29 208 Z" fill="#FF6600"/>'

async function genBadgeVariant (outPath, badgeSvg) {
  const base = await sharp(Buffer.from(svgFilled)).resize(256, 256).png().toBuffer()
  const badge = await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${badgeSvg}</svg>`
  )).png().toBuffer()
  await sharp(base).composite([{ input: badge }]).png().toFile(outPath)
}

// iOS launch splash: solid background + centered monogram tile.
// Light: 40% of the short side on off-white; dark: ~24.2% on #121214.
// Sizes are derived from the existing files so the set stays in sync with the
// apple-touch-startup-image links in pages/_document.js.
async function genSplash (filePath, dark) {
  const { width, height } = await sharp(readFileSync(filePath)).metadata()
  const min = Math.min(width, height)
  const tile = Math.round((dark ? 0.2422 : 0.4) * min)
  const logo = await sharp(Buffer.from(svgFilled)).resize(tile, tile).png().toBuffer()
  await sharp({
    create: { width, height, channels: 4, background: dark ? DARK_BG : LIGHT_BG }
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toFile(filePath)
}

async function genSplashSet () {
  const splashDir = resolve(root, 'public/splash')
  const files = readdirSync(splashDir).filter((f) => f.endsWith('.png'))
  for (const f of files) {
    const dark = f.includes('_dark')
    await genSplash(resolve(splashDir, f), dark)
  }
}

const tasks = []
for (const s of SIZES) {
  tasks.push(genIcon(s, resolve(root, `public/icons/icon_x${s}.png`)))
  tasks.push(genIcon(s, resolve(root, `public/maskable/icon_x${s}.png`), { maskable: true }))
}
// favicon + apple-touch-icon
tasks.push(genIcon(64, resolve(root, 'public/favicon.png')))
tasks.push(genIcon(180, resolve(root, 'public/apple-touch-icon.png')))
// favicon.ico (16/32/48/64)
tasks.push(genFaviconIco())
// notification/comment favicon variants
tasks.push(genBadgeVariant(resolve(root, 'public/favicon-notify.png'), NOTIFY_BADGE))
tasks.push(genBadgeVariant(resolve(root, 'public/favicon-comments.png'), COMMENTS_BADGE))
tasks.push(genBadgeVariant(resolve(root, 'public/favicon-notify-with-comments.png'), NOTIFY_BADGE + COMMENTS_BADGE))
// iOS launch splash set (sizes derived from the existing files)
tasks.push(genSplashSet())

await Promise.all(tasks)
console.log('icons, ico, notify variants, and splash generated')
