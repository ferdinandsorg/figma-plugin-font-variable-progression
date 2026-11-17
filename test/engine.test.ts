import { describe, expect, it } from 'vitest'
import { CURVE_BEZIER, applyCurve, computeValues, evalBezier, isRamp, strengths } from '../src/engine'
import { snapOutward } from '../src/axes'

const linear = { position: 1, falloff: 1, curve: 'linear' as const }

describe('strengths', () => {
  it('reproduces the classic start → end ramp', () => {
    strengths(4, linear).forEach((v, i) => expect(v).toBeCloseTo([0, 1 / 3, 2 / 3, 1][i]))
  })
  it('peaks on the "r" of "Wort": o and t equal, W lowest', () => {
    const [w, o, r, t] = strengths(4, { position: 2 / 3, falloff: 1, curve: 'linear' })
    expect(r).toBe(1)
    expect(o).toBeCloseTo(t)
    expect(w).toBeLessThan(o)
  })
  it('is symmetric around a centred peak', () => {
    const s = strengths(5, { position: 0.5, falloff: 1, curve: 'smooth' })
    expect(s[0]).toBeCloseTo(s[4]); expect(s[1]).toBeCloseTo(s[3]); expect(s[2]).toBe(1)
  })
  it('limits the reach with a small falloff', () => {
    const s = strengths(5, { position: 0.5, falloff: 0.25, curve: 'linear' })
    expect(s).toEqual([0, 0, 1, 0, 0])
  })
  it('handles one and zero letters', () => {
    expect(strengths(1, linear)).toEqual([1])
    expect(strengths(0, linear)).toEqual([])
  })
  it('clamps out-of-range shape values', () => {
    expect(strengths(3, { position: 5, falloff: 0, curve: 'linear' })).toEqual([0, 0, 1])
  })
})

describe('applyCurve', () => {
  it('keeps the endpoints', () => {
    for (const c of ['linear', 'smooth', 'easeIn', 'easeOut'] as const) {
      expect(applyCurve(c, 0)).toBe(0); expect(applyCurve(c, 1)).toBe(1)
    }
  })
  it('bends as expected', () => {
    expect(applyCurve('easeIn', 0.5)).toBeLessThan(0.5)
    expect(applyCurve('easeOut', 0.5)).toBeGreaterThan(0.5)
    expect(applyCurve('smooth', 0.5)).toBe(0.5)
  })
})

describe('bezier curves', () => {
  it('matches linear and keeps endpoints', () => {
    for (const x of [0, 0.25, 0.5, 0.9, 1]) expect(evalBezier([0, 0, 1, 1], x)).toBeCloseTo(x, 5)
  })
  it('bends like the named curves', () => {
    expect(evalBezier(CURVE_BEZIER.easeIn, 0.5)).toBeLessThan(0.5)
    expect(evalBezier(CURVE_BEZIER.easeOut, 0.5)).toBeGreaterThan(0.5)
    expect(evalBezier(CURVE_BEZIER.smooth, 0.5)).toBeCloseTo(0.5, 5)
  })
  it('clamps overshooting curves', () => {
    const b = [0.3, 1.6, 0.7, -0.6] as [number, number, number, number]
    for (let x = 0; x <= 1; x += 0.05) { const y = evalBezier(b, x); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(1) }
  })
  it('drives strengths and ramp detection', () => {
    const s = strengths(3, { position: 1, falloff: 1, curve: 'linear', bezier: CURVE_BEZIER.easeIn })
    expect(s[1]).toBeLessThan(0.5)
    expect(isRamp({ position: 0, falloff: 1, curve: 'smooth', bezier: [0.2, 0.2, 0.8, 0.8] })).toBe('reverse')
    expect(isRamp({ position: 1, falloff: 1, curve: 'linear', bezier: CURVE_BEZIER.easeIn })).toBe(null)
  })
})

describe('computeValues', () => {
  it('interpolates every enabled axis and skips disabled ones', () => {
    const v = computeValues(3, {
      shape: linear,
      axes: { wght: { enabled: true, base: 100, peak: 900 }, wdth: { enabled: true, base: 100, peak: 50 }, GRAD: { enabled: false, base: 0, peak: 100 } },
    })
    expect(v).toEqual([{ wght: 100, wdth: 100 }, { wght: 500, wdth: 75 }, { wght: 900, wdth: 50 }])
  })
})

describe('detached axes', () => {
  it('lets an axis follow its own progression', () => {
    const v = computeValues(3, {
      shape: linear,
      axes: {
        wght: { enabled: true, base: 100, peak: 900 },
        ROND: { enabled: true, base: 0, peak: 100, shape: { position: 0, falloff: 1, curve: 'linear' } },
      },
    })
    expect(v.map(x => x.wght)).toEqual([100, 500, 900])
    expect(v.map(x => x.ROND)).toEqual([100, 50, 0])
  })
  it('recognises forward and reverse ramps', () => {
    expect(isRamp(linear)).toBe('forward')
    expect(isRamp({ ...linear, position: 0 })).toBe('reverse')
    expect(isRamp({ ...linear, position: 0.5 })).toBe(null)
    expect(isRamp({ ...linear, curve: 'smooth' })).toBe(null)
  })
})

describe('snapOutward', () => {
  it('snaps probe noise to clean bounds', () => {
    expect(snapOutward(-10.004, 'min', 10)).toBe(-10)
    expect(snapOutward(24.996, 'min', 126)).toBe(25)
    expect(snapOutward(100.87, 'min', 800)).toBe(100)
    expect(snapOutward(899.26, 'max', 800)).toBe(900)
    expect(snapOutward(0.995, 'max', 1)).toBe(1)
  })
})
