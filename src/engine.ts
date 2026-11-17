// Pure progression math, shared by the plugin (apply) and the UI (preview).

export type Curve = 'linear' | 'smooth' | 'easeIn' | 'easeOut'
export type Mode = 'text' | 'word'

export type AxisSetting = {
  enabled: boolean
  /** Value at the edges, i.e. farthest from the peak. */
  base: number
  /** Value at the peak letter. */
  peak: number
}

export type Shape = {
  /** Peak position along the letters, 0 = first, 1 = last. */
  position: number
  /** How far the effect reaches from the peak, as a share of the text length (0.01–1). */
  falloff: number
  curve: Curve
}

export type Settings = {
  version: 2
  axes: { [tag: string]: AxisSetting }
  shape: Shape
  mode: Mode
}

export const DEFAULT_SHAPE: Shape = { position: 1, falloff: 1, curve: 'linear' }

export function applyCurve(curve: Curve, t: number): number {
  const x = Math.max(0, Math.min(1, t))
  switch (curve) {
    case 'smooth': return x * x * (3 - 2 * x)
    case 'easeIn': return x * x
    case 'easeOut': return 1 - (1 - x) * (1 - x)
    default: return x
  }
}

/**
 * Strength (0 = base, 1 = peak) for each of `count` letters.
 * With position 1, falloff 1 and a linear curve this is the classic start → end ramp.
 * A single letter sits on the peak.
 */
export function strengths(count: number, shape: Shape): number[] {
  if (count <= 0) return []
  if (count === 1) return [1]
  const position = Math.max(0, Math.min(1, shape.position))
  const falloff = Math.max(0.01, Math.min(1, shape.falloff))
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const distance = Math.abs(i / (count - 1) - position) / falloff
    out.push(applyCurve(shape.curve, 1 - Math.min(1, distance)))
  }
  return out
}

/** Axis values for each letter: `[{ wght: 700, wdth: 90 }, …]`, enabled axes only. */
export function computeValues(count: number, settings: Pick<Settings, 'axes' | 'shape'>): { [tag: string]: number }[] {
  const enabled = Object.entries(settings.axes).filter(([, a]) => a.enabled)
  return strengths(count, settings.shape).map(s => {
    const values: { [tag: string]: number } = {}
    for (const [tag, a] of enabled) values[tag] = round(a.base + (a.peak - a.base) * s)
    return values
  })
}

function round(value: number): number { return Math.round(value * 100) / 100 }
