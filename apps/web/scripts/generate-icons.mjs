#!/usr/bin/env bun
/**
 * Generates the PWA icon PNGs in `apps/web/public/icons/` from scratch —
 * no image library, no external assets. Pure pixel math (a "Y" monogram on
 * a solid brand-blue square) encoded straight to PNG bytes using only
 * `node:zlib` (for the IDAT deflate stream) and a hand-rolled CRC32, both
 * of which ship with Bun/Node.
 *
 * Re-run after a brand-color change: `bun run apps/web/scripts/generate-icons.mjs`
 * It is intentionally NOT wired into any package.json script (hard rule:
 * this module may not edit package.json) — run it by hand when needed.
 */
import { deflateSync } from "node:zlib"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons")

// --primary from apps/web/app/globals.css (hsl(221 83% 53%)) as sRGB.
const BRAND = { r: 0x25, g: 0x63, b: 0xeb }
const WHITE = { r: 0xff, g: 0xff, b: 0xff }

/** Shortest distance from point (px,py) to segment (x1,y1)-(x2,y2). */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

/** Render a `size x size` RGBA buffer: brand-blue square with a white "Y" mark. */
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const stroke = size * 0.13
  // "Y" monogram, normalized 0..1 coords, kept inside a ~62% safe zone so
  // it survives being cropped to a circle (maskable icon requirement).
  const arms = [
    [0.24, 0.2, 0.5, 0.52],
    [0.76, 0.2, 0.5, 0.52],
  ]
  const stem = [0.5, 0.52, 0.5, 0.82]

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / size
      const ny = y / size
      let minDist = distToSegment(nx, ny, ...stem)
      for (const arm of arms) {
        minDist = Math.min(minDist, distToSegment(nx, ny, ...arm))
      }
      const distPx = minDist * size
      // 1px feathered edge so the mark isn't jagged at small sizes.
      const markCoverage = Math.max(0, Math.min(1, stroke / 2 + 1 - distPx))
      const r = Math.round(BRAND.r + (WHITE.r - BRAND.r) * markCoverage)
      const g = Math.round(BRAND.g + (WHITE.g - BRAND.g) * markCoverage)
      const b = Math.round(BRAND.b + (WHITE.b - BRAND.b) * markCoverage)
      const i = (y * size + x) * 4
      pixels[i] = r
      pixels[i + 1] = g
      pixels[i + 2] = b
      pixels[i + 3] = 255
    }
  }
  return pixels
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

/** Encode an RGBA pixel buffer as a minimal 8-bit truecolor+alpha PNG. */
function encodePng(size, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(size, 0)
  ihdrData.writeUInt32BE(size, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 6 // color type: RGBA
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0
  const ihdr = chunk("IHDR", ihdrData)

  // Each scanline prefixed with filter byte 0 (none).
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = chunk("IDAT", deflateSync(raw, { level: 9 }))

  const iend = chunk("IEND", Buffer.alloc(0))

  return Buffer.concat([signature, ihdr, idat, iend])
}

mkdirSync(OUT_DIR, { recursive: true })

const targets = [
  { size: 192, file: "icon-192.png" },
  { size: 512, file: "icon-512.png" },
  { size: 180, file: "apple-touch-icon.png" },
]

for (const { size, file } of targets) {
  const png = encodePng(size, renderIcon(size))
  writeFileSync(join(OUT_DIR, file), png)
  console.log(`wrote ${file} (${png.length} bytes)`)
}
