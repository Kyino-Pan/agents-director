// Render only synthetic artwork. No running Orca sessions or source logs are read.
// npm ci && npx playwright install chromium
// ORCA_BACKGROUND_LAUNCH=1 node scripts/render-cover.mjs
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH may select an existing headless Chromium.
import assert from 'node:assert/strict'
import { writeFile, stat } from 'node:fs/promises'
import { chromium } from 'playwright'
import { harnessIcons } from '../assets/orca-harness-icons.mjs'

const root = new URL('../', import.meta.url)
const width = 1600
const height = 1000
const previewWidth = 360

// Orca preview-theme.css surfaces/ink and panel.css's 55% working-state mix.
// This is one activity series, not a categorical palette: identity uses named lanes.
const ink = '#0a0a0a'
const secondary = '#696969'
const activity = '#787878'
const surface = '#ffffff'
const focusSurface = '#f5f5f5'
const border = '#e5e5e5'
const plot = { x: 535, right: 1480, top: 420, bottom: 827 }
const timeX = (minute) => plot.x + (minute / 30) * (plot.right - plot.x)

// Every name, timestamp, interval and relationship is authored for this illustration.
const groups = [
  {
    name: 'Atlas / checkout',
    y: 443,
    lanes: [
      {
        name: 'Coordinator',
        harness: 'claude',
        y: 500,
        intervals: [
          [0, 8],
          [12, 19],
          [24, 29]
        ]
      },
      {
        name: 'API builder',
        harness: 'codex',
        y: 582,
        intervals: [
          [5, 18],
          [20, 27]
        ]
      }
    ]
  },
  {
    name: 'Beacon / search',
    y: 653,
    lanes: [
      {
        name: 'Reviewer',
        harness: 'claude',
        y: 710,
        intervals: [
          [2, 9],
          [13, 23]
        ]
      },
      {
        name: 'Test runner',
        harness: 'codex',
        y: 792,
        intervals: [
          [7, 15],
          [18, 28]
        ]
      }
    ]
  }
]

function text(x, y, value, size, options = '') {
  return `<text x="${x}" y="${y}" font-size="${size}" ${options}>${value}</text>`
}

function icon(harness, y) {
  const markup = harnessIcons[harness].markup
    .replace('width="14"', 'width="34"')
    .replace('height="14"', 'height="34"')
  return `<g transform="translate(112 ${y - 17})">${markup}</g>`
}

function bar(start, end, y) {
  return `<rect x="${timeX(start)}" y="${y - 10}" width="${timeX(end) - timeX(start)}" height="20" rx="4" fill="${activity}"/>`
}

function connection(minute, fromY, toY, type) {
  const x = timeX(minute)
  const endX = x + 38
  const turnY = toY - Math.sign(toY - fromY) * 14
  const dashed = type === 'message' ? 'stroke-dasharray="8 7"' : ''
  return `<g fill="none" stroke="${ink}" stroke-width="3" ${dashed}>
    <path d="M ${x} ${fromY} V ${turnY} Q ${x} ${toY} ${x + 14} ${toY} H ${endX}" marker-end="url(#arrow)"/>
    <circle cx="${x}" cy="${fromY}" r="6" fill="${surface}" stroke-width="3"/>
  </g>`
}

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">Agents Director — your agents in one timeline</title>
  <desc id="description">Synthetic timeline illustration, not a product screenshot. Coordinator, API builder, Reviewer and Test runner are grouped under Atlas / checkout and Beacon / search. Gray bars show observed activity between 10:00 and 10:30. Solid spawn and dashed message arrows link agents. The focus interval is 10:10 to 10:25. Agents Director lets you focus on agents active in a time window and jump to their Chat or terminal.</desc>
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="strokeWidth" viewBox="0 0 8 6">
      <path d="M 0 0 L 6 3 L 0 6" fill="none" stroke="${ink}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; fill: ${ink}; }
    .secondary { fill: ${secondary}; }
    .time { font-variant-numeric: tabular-nums; }
  </style>
  <rect width="${width}" height="${height}" fill="${surface}"/>
  ${text(80, 144, 'Agents Director', 104, 'font-weight="700" letter-spacing="-4"')}
  ${text(84, 222, 'Your agents. One timeline.', 52, 'class="secondary" letter-spacing="-1"')}

  <rect x="80" y="286" width="1440" height="590" rx="20" fill="${surface}" stroke="${border}" stroke-width="2"/>
  ${text(112, 345, 'Across projects &amp; worktrees', 34, 'font-weight="600"')}
  <rect x="1025" y="307" width="455" height="54" rx="10" fill="#171717"/>
  ${text(1252.5, 345, 'Focus 10:10–10:25', 34, 'text-anchor="middle" style="fill:#fafafa" font-weight="600"')}

  <rect x="${timeX(10)}" y="${plot.top}" width="${timeX(25) - timeX(10)}" height="${plot.bottom - plot.top}" fill="${focusSurface}"/>
  ${[0, 10, 20, 30]
    .map(
      (minute) => `
    ${text(timeX(minute), 401, `10:${String(minute).padStart(2, '0')}`, 30, `class="secondary time" text-anchor="${minute === 0 ? 'start' : minute === 30 ? 'end' : 'middle'}"`)}
    <path d="M ${timeX(minute)} ${plot.top} V ${plot.bottom}" fill="none" stroke="${border}" stroke-width="1"/>`
    )
    .join('')}
  ${[10, 25].map((minute) => `<path d="M ${timeX(minute)} ${plot.top} V ${plot.bottom}" fill="none" stroke="#a1a1a1" stroke-width="2"/>`).join('')}
  ${groups
    .map(
      (group) => `
    ${text(112, group.y, group.name, 30, 'class="secondary" font-weight="500"')}
    ${group.lanes
      .map(
        (lane) => `
      <path d="M ${plot.x} ${lane.y} H ${plot.right}" stroke="${border}" stroke-width="1"/>
      ${icon(lane.harness, lane.y)}
      ${text(164, lane.y + 13, lane.name, 38, 'font-weight="600" letter-spacing="-.5"')}
      ${lane.intervals.map(([start, end]) => bar(start, end, lane.y)).join('')}
    `
      )
      .join('')}
  `
    )
    .join('')}

  ${connection(5, 500, 582, 'spawn')}
  ${connection(17, 582, 500, 'message')}
  ${connection(21, 710, 582, 'message')}

  <rect x="112" y="845" width="36" height="10" rx="3" fill="${activity}"/>
  ${text(163, 859, 'Activity', 26, 'class="secondary"')}
  <path d="M 377 850 H 425" stroke="${ink}" stroke-width="3" marker-end="url(#arrow)"/>
  ${text(449, 859, 'Spawn', 26, 'class="secondary"')}
  <path d="M 620 850 H 668" stroke="${ink}" stroke-width="3" stroke-dasharray="8 7" marker-end="url(#arrow)"/>
  ${text(692, 859, 'Message', 26, 'class="secondary"')}

  ${text(84, 939, 'Focus a window. Jump to Chat or terminal.', 43, 'font-weight="500" letter-spacing="-.6"')}
  ${text(84, 978, 'Synthetic illustration · Community plugin for Orca', 24, 'class="secondary"')}
</svg>`.replace(/ +$/gm, '')

// An intentionally static SVG: no tooltips or UI controls that pretend to be the app.
// The original detailed light/dark screenshots remain the in-use evidence.
await writeFile(new URL('assets/cover.svg', root), svg)
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
})
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${surface}}
    svg{display:block;width:100%;height:auto}
  </style></head><body>${svg}</body></html>`)
  await page.evaluate(() => document.fonts.ready)
  const overflow = await page.locator('text').evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const box = node.getBBox()
        return box.x < 0 || box.y < 0 || box.x + box.width > 1600 || box.y + box.height > 1000
      })
      .map((node) => node.textContent)
  )
  assert.deepEqual(overflow, [], 'Cover text must fit the canvas')
  assert.deepEqual(errors, [], 'Cover must render without browser errors')
  const full = await page.screenshot({ path: new URL('assets/cover.png', root).pathname })
  assert.equal(full.readUInt32BE(16), width)
  assert.equal(full.readUInt32BE(20), height)
  assert.ok(full.length <= 1024 * 1024, 'Cover must be at most 1024 KiB')

  const previewHeight = (height / width) * previewWidth
  await page.setViewportSize({ width: previewWidth, height: previewHeight })
  const preview = await page.screenshot({
    path: new URL('assets/cover-preview-360.png', root).pathname
  })
  assert.equal(preview.readUInt32BE(16), previewWidth)
  assert.equal(preview.readUInt32BE(20), previewHeight)
  console.log(`Cover: assets/cover.png (${width}×${height}, ${Math.ceil(full.length / 1024)} KiB)`)
  console.log(`Catalog preview: assets/cover-preview-360.png (${previewWidth}×${previewHeight})`)
  console.log(
    `Vector: assets/cover.svg (${(await stat(new URL('assets/cover.svg', root))).size} bytes)`
  )
} finally {
  await browser.close()
}
