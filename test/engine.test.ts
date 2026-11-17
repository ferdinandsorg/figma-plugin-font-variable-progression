import { describe, expect, it } from 'vitest'
import { applyCurve, computeValues, strengths } from '../src/engine'
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

describe('computeValues', () => {
  it('interpolates every enabled axis and skips disabled ones', () => {
    const v = computeValues(3, {
      shape: linear,
      axes: { wght: { enabled: true, base: 100, peak: 900 }, wdth: { enabled: true, base: 100, peak: 50 }, GRAD: { enabled: false, base: 0, peak: 100 } },
    })
    expect(v).toEqual([{ wght: 100, wdth: 100 }, { wght: 500, wdth: 75 }, { wght: 900, wdth: 50 }])
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
