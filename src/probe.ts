import { AxisRange, axisName, snapOutward, unavailableRange } from './axes'

// Figma stores any variationSettings value without clamping, so ranges can't be read back.
// Instead render a sample and binary-search where the output stops changing: every value
// beyond an axis bound renders exactly like the bound itself.
const CACHE_VERSION = 3
// Caps, ascenders (h d), descenders (g y), bowls, figures: so every vertical-metric axis shows.
const SAMPLE = 'HOhdamgsy0R'
const FAR = 100000
const PRECISION = 0.01
const pending = new Map<string, Promise<AxisRange[]>>()

function cacheKey(family: string): string { return `axisRanges:v${CACHE_VERSION}:${family}` }

export async function cachedRanges(family: string): Promise<AxisRange[] | null> {
  try {
    const value = await figma.clientStorage.getAsync(cacheKey(family))
    return Array.isArray(value) ? value as AxisRange[] : null
  } catch { return null }
}

export type Progress = (done: number, total: number, tag: string) => void

export function detectRanges(font: FontName, axes: string[], onProgress?: Progress): Promise<AxisRange[]> {
  const running = pending.get(font.family)
  if (running) return running
  const job = probe(font, axes, onProgress)
    .then(async ranges => {
      try { await figma.clientStorage.setAsync(cacheKey(font.family), ranges) } catch { /* cache is optional */ }
      return ranges
    })
    .finally(() => pending.delete(font.family))
  pending.set(font.family, job)
  return job
}

async function probe(font: FontName, axes: string[], onProgress?: Progress): Promise<AxisRange[]> {
  const base: FontName = { family: font.family, style: font.style }
  await figma.loadFontAsync(base)
  const node = figma.createText()
  node.name = 'Axis probe (temporary)'
  node.x = -100000
  node.y = -100000
  try {
    node.fontName = base
    node.fontSize = 48
    node.characters = SAMPLE
    const defaults = { ...(node.fontName as FontName).variationSettings }
    const ranges: AxisRange[] = []
    for (const [index, tag] of axes.entries()) {
      onProgress?.(index, axes.length, tag)
      const defaultValue = typeof defaults[tag] === 'number' ? defaults[tag] : 0
      const render = async (value: number): Promise<string> => {
        node.fontName = { ...base, variationSettings: { [tag]: value } }
        return node.exportAsync({ format: 'SVG_STRING' })
      }
      const high = await render(FAR), low = await render(-FAR)
      if (high === low) { ranges.push(unavailableRange(tag, defaultValue)); continue }
      // `inside` renders differently from `ref`; `outside` renders the same.
      const search = async (ref: string, inside: number, outside: number): Promise<number> => {
        if (await render(inside) === ref) return inside
        while (Math.abs(outside - inside) > PRECISION) {
          const mid = (inside + outside) / 2
          if (await render(mid) === ref) outside = mid
          else inside = mid
        }
        return outside
      }
      const rawMax = await search(high, defaultValue, FAR)
      const rawMin = await search(low, defaultValue, -FAR)
      const span = rawMax - rawMin
      ranges.push({
        tag,
        name: axisName(tag),
        min: Math.min(snapOutward(rawMin, 'min', span), defaultValue),
        max: Math.max(snapOutward(rawMax, 'max', span), defaultValue),
        defaultValue,
        source: 'detected',
      })
    }
    return ranges
  } finally {
    node.remove()
  }
}
