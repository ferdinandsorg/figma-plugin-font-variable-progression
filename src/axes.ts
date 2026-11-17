export type AxisSource = 'detected' | 'file' | 'registered' | 'unavailable'

export type AxisRange = {
  tag: string
  name: string
  min: number
  max: number
  defaultValue: number
  source: AxisSource
}

// Registered OpenType axes: readable names and the widest spec range, used as fallback
// when an axis has no visible effect on the probe sample.
const REGISTERED: { [tag: string]: { name: string; min: number; max: number } } = {
  wght: { name: 'Weight', min: 1, max: 1000 },
  wdth: { name: 'Width', min: 1, max: 1000 },
  opsz: { name: 'Optical size', min: 1, max: 1000 },
  slnt: { name: 'Slant', min: -90, max: 90 },
  ital: { name: 'Italic', min: 0, max: 1 },
}

// Common custom axes (Google Fonts axis registry) – names only.
const KNOWN_NAMES: { [tag: string]: string } = {
  GRAD: 'Grade', ROND: 'Roundness', CASL: 'Casual', CRSV: 'Cursive', MONO: 'Monospace',
  SOFT: 'Softness', WONK: 'Wonky', XOPQ: 'Thick stroke', YOPQ: 'Thin stroke', XTRA: 'Counter width',
  YTAS: 'Ascender height', YTDE: 'Descender depth', YTFI: 'Figure height', YTLC: 'Lowercase height',
  YTUC: 'Uppercase height', FILL: 'Fill', FLAR: 'Flare', VOLM: 'Volume', SHRP: 'Sharpness',
  BNCE: 'Bounce', INFM: 'Informality', SPAC: 'Spacing', ELSH: 'Element shape', ELXP: 'Element expansion',
  CTGR: 'Counter grade', CTRS: 'Contrast', EDPT: 'Extrusion depth', EHLT: 'Edge highlight',
  HGHT: 'Height', MORF: 'Morph', BLED: 'Bleed', SCAN: 'Scanlines', XELA: 'Horizontal element alignment',
  YELA: 'Vertical element alignment', SZP1: 'Size 1', SZP2: 'Size 2', WMX2: 'Weight max 2',
}

export function axisName(tag: string): string {
  return REGISTERED[tag]?.name || KNOWN_NAMES[tag] || tag
}

// Spec-wide fallback when nothing could be measured (e.g. detection failed).
export function registeredRange(tag: string, defaultValue: number): AxisRange {
  const r = REGISTERED[tag] || { min: defaultValue, max: defaultValue }
  return { tag, name: axisName(tag), min: Math.min(r.min, defaultValue), max: Math.max(r.max, defaultValue), defaultValue, source: 'registered' }
}

// The axis exists but changing it has no visible effect in Figma. opsz is driven by
// Figma's automatic optical sizing (follows font size), so plugin values are ignored.
export function unavailableRange(tag: string, defaultValue: number): AxisRange {
  return { tag, name: axisName(tag), min: defaultValue, max: defaultValue, defaultValue, source: 'unavailable' }
}

// Probed bounds are where the rendering stops changing, which sits slightly inside the
// real bound. Snap outward to a clean value: whole numbers for wide axes, 0.1 for narrow ones.
export function snapOutward(raw: number, direction: 'min' | 'max', span: number): number {
  // The search stops within 0.01 beyond the bound, so drop that noise first.
  const value = Math.round(raw * 100) / 100
  const step = span >= 10 ? 1 : 0.1
  const tolerance = span >= 10 ? 1 : 0.05
  const snapped = (direction === 'min' ? Math.floor(value / step + 1e-9) : Math.ceil(value / step - 1e-9)) * step
  const clean = Math.round(snapped * 1000) / 1000
  return Math.abs(clean - value) <= tolerance ? clean : Math.round(value * 100) / 100
}
