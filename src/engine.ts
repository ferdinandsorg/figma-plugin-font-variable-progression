// Pure progression math, shared by the plugin (apply) and the UI (preview).

export type Curve = 'linear' | 'smooth' | 'easeIn' | 'easeOut'
export type Mode = 'text' | 'word'

export type AxisSetting = {
  enabled: boolean
  /** Value at the edges, i.e. farthest from the peak. */
  base: number
  /** Value at the peak letter. */
  peak: number
  /** Own progression; when absent the axis follows the shared one. */
  shape?: Shape
}

export type Shape = {
  /** Peak position along the letters, 0 = first, 1 = last. */
  position: number
  /** How far the effect reaches from the peak, as a share of the text length (0.01–1). */
  falloff: number
  curve: Curve
  /** Custom cubic-bezier (x1, y1, x2, y2); overrides `curve` when set. */
  bezier?: Bezier
}

export type Bezier = [number, number, number, number]

/** Bezier equivalents of the named curves, for the curve editor. */
export const CURVE_BEZIER: { [c in Curve]: Bezier } = {
  linear: [0, 0, 1, 1],
  smooth: [0.42, 0, 0.58, 1],
  easeIn: [0.42, 0, 1, 1],
  easeOut: [0, 0, 0.58, 1],
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

/** y for a given x on a cubic-bezier from (0,0) to (1,1), clamped to 0–1. */
export function evalBezier([x1, y1, x2, y2]: Bezier, x: number): number {
  const at = (a: number, b: number, t: number) => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t
  if (x <= 0) return 0
  if (x >= 1) return 1
  // x(t) is monotonic for x1, x2 in [0, 1]: bisection is robust and fast enough.
  let lo = 0, hi = 1, t = x
  for (let i = 0; i < 40; i++) {
    t = (lo + hi) / 2
    if (at(x1, x2, t) < x) lo = t
    else hi = t
  }
  return Math.max(0, Math.min(1, at(y1, y2, t)))
}

export function isLinearBezier(b: Bezier): boolean {
  return Math.abs(b[0] - b[1]) < 1e-6 && Math.abs(b[2] - b[3]) < 1e-6
}

function shapeCurve(shape: Shape, t: number): number {
  return shape.bezier ? evalBezier(shape.bezier, Math.max(0, Math.min(1, t))) : applyCurve(shape.curve, t)
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
    out.push(shapeCurve(shape, 1 - Math.min(1, distance)))
  }
  return out
}

/** Axis values for each letter: `[{ wght: 700, wdth: 90 }, …]`, enabled axes only. */
export function computeValues(count: number, settings: Pick<Settings, 'axes' | 'shape'>): { [tag: string]: number }[] {
  const enabled = Object.entries(settings.axes).filter(([, a]) => a.enabled)
  const shared = strengths(count, settings.shape)
  const perAxis = enabled.map(([tag, a]) => [tag, a, a.shape ? strengths(count, a.shape) : shared] as const)
  return shared.map((_, i) => {
    const values: { [tag: string]: number } = {}
    for (const [tag, a, s] of perAxis) values[tag] = round(a.base + (a.peak - a.base) * s[i])
    return values
  })
}

/** The progression an axis actually uses. */
export function shapeOf(settings: Pick<Settings, 'axes' | 'shape'>, tag: string | null): Shape {
  return (tag && settings.axes[tag]?.shape) || settings.shape
}

export function isRamp(shape: Shape): 'forward' | 'reverse' | null {
  const linear = shape.bezier ? isLinearBezier(shape.bezier) : shape.curve === 'linear'
  if (shape.falloff !== 1 || !linear) return null
  return shape.position === 1 ? 'forward' : shape.position === 0 ? 'reverse' : null
}

function round(value: number): number { return Math.round(value * 100) / 100 }
