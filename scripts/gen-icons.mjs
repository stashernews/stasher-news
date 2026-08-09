import sharp from 'sharp'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const ORANGE = '#FF6600'

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
      create: { width: dim, height: dim, channels: 4, background: '#121214' }
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

const tasks = []
for (const s of SIZES) {
  tasks.push(genIcon(s, resolve(root, `public/icons/icon_x${s}.png`)))
  tasks.push(genIcon(s, resolve(root, `public/maskable/icon_x${s}.png`), { maskable: true }))
}
// favicon + apple-touch-icon
tasks.push(genIcon(64, resolve(root, 'public/favicon.png')))
tasks.push(genIcon(180, resolve(root, 'public/apple-touch-icon.png')))

await Promise.all(tasks)
console.log('icons generated')
