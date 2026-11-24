import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { pageFor } from './panel-test-browser.mjs'
import { contrastSnapshot } from './panel-message-contrast.fixture.mjs'

test('communication stays above the shared hatch in both themes and widths without widening short states', async () => {
  for (const width of [1100, 390]) {
    for (const dark of [false, true]) {
      const { page, errors } = await pageFor({ width, height: 700, dark, data: contrastSnapshot })
      try {
        await page.locator('.message-path').first().waitFor({ state: 'attached' })
        const paint = await page.evaluate(() => {
          const style = (selector) => getComputedStyle(document.querySelector(selector))
          const rgb = (value) => {
            const canvas = document.createElement('canvas')
            const context = canvas.getContext('2d')
            context.fillStyle = value
            context.fillRect(0, 0, 1, 1)
            return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
          }
          const over = (front, back, alpha) =>
            front.map((v, i) => v * alpha + back[i] * (1 - alpha))
          const luminance = (color) =>
            color.reduce((sum, value, index) => {
              const v = value / 255
              return (
                sum +
                (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) *
                  [0.2126, 0.7152, 0.0722][index]
              )
            }, 0)
          const contrast = (a, b) => {
            const values = [luminance(a), luminance(b)].sort((a, b) => b - a)
            return (values[0] + 0.05) / (values[1] + 0.05)
          }
          const background = rgb(style('body').backgroundColor)
          const hatch = style('#unobserved-hatch rect')
          const stripe = over(rgb(hatch.fill), background, Number(hatch.fillOpacity))
          const stages = ['attempt', 'accepted', 'received'].map((id) => {
            const path = style(`[data-message="${id}"] .message-path`)
            const color = over(rgb(path.stroke), background, Number(path.opacity))
            const marker = document.querySelector('#message-arrow path')
            return {
              contrast: Math.min(contrast(color, background), contrast(color, stripe)),
              opacity: Number(path.opacity),
              dash: path.strokeDasharray,
              markerMatches: getComputedStyle(marker).stroke === path.stroke
            }
          })
          const short = document.querySelector('[data-agent="sender"] .segment.working[width]')
          const bars = [...document.querySelectorAll('.segment.working')]
          const narrow = bars.find(
            (bar) => Number(bar.getAttribute('width')) > 0 && Number(bar.getAttribute('width')) < 1
          )
          const crossing = document
            .querySelector('[data-message="accepted"] .message-path')
            .getBBox()
          const crossed = document
            .querySelector('[data-agent="crossed"] .segment.unknown')
            .getBBox()
          return {
            stages,
            hatchContrast: contrast(stripe, background),
            legend: style('.legend svg.unknown > rect').fill,
            unknown: style('.segment.unknown').fill,
            done: style('.segment.done').fill,
            bamboo: style('.swatch.working').backgroundColor,
            working: getComputedStyle(short).fill,
            shortWidth: Number(narrow.getAttribute('width')),
            shortHit: Number(
              narrow.parentElement.querySelector('.segment-hit').getAttribute('width')
            ),
            crossesHatch:
              crossing.x >= crossed.x &&
              crossing.x <= crossed.x + crossed.width &&
              crossing.y < crossed.y &&
              crossing.y + crossing.height > crossed.y,
            crossing: [crossing.x, crossing.y, crossing.height],
            crossed: [crossed.x, crossed.y, crossed.width],
            endpoints: [...document.querySelectorAll('.unobserved-endpoint, .mailbox-input')].map(
              (el) => {
                const s = getComputedStyle(el)
                const color = over(rgb(s.stroke), background, Number(s.opacity))
                return Math.min(contrast(color, background), contrast(color, stripe))
              }
            )
          }
        })
        const context = JSON.stringify({ width, dark, paint })
        assert.ok(paint.hatchContrast >= 1.5, context)
        assert.equal(paint.legend, paint.unknown, context)
        assert.notEqual(paint.done, paint.unknown, context)
        assert.equal(paint.working, paint.bamboo, context)
        assert.ok(paint.shortWidth > 0 && paint.shortWidth < 1 && paint.shortHit >= 8, context)
        assert.ok(paint.crossesHatch, context)
        assert.ok(
          paint.stages.every((stage) => stage.contrast >= 3 && stage.markerMatches),
          context
        )
        assert.ok(
          paint.endpoints.length >= 4 && paint.endpoints.every((ratio) => ratio >= 3),
          context
        )
        assert.ok(
          paint.stages[0].opacity < paint.stages[1].opacity &&
            paint.stages[1].opacity < paint.stages[2].opacity,
          context
        )
        assert.notEqual(paint.stages[0].dash, paint.stages[1].dash, context)
        if (process.env.ACTIVITY_SCREENSHOTS) {
          await mkdir(process.env.ACTIVITY_SCREENSHOTS, { recursive: true })
          await page.screenshot({
            path: `${process.env.ACTIVITY_SCREENSHOTS}/messages-${dark ? 'dark' : 'light'}-${width}.png`
          })
        }
        assert.deepEqual(errors, [])
      } finally {
        await page.close()
      }
    }
  }
})
