import { AxisRange, registeredRange } from './axes'
import { DEFAULT_SHAPE, Settings, Shape, computeValues } from './engine'
import { FontMeta, parseFont } from './fontfile'
import { cachedRanges, detectRanges } from './probe'

const TOOL_ID = 'f5640f22-a592-4f4f-8903-2397d80a7bee'
const KEY = TOOL_ID + ':state'
type FontRange = { start: number; end: number; fontName: FontName }
type Original = { characters: string; ranges: FontRange[] }
type Saved = { version: 2; settings: Settings; original: Original }
type SavedV1 = { version: 1; params: { startWeight?: number; endWeight?: number; mode?: string }; original: Original }
type Glyph = { start: number; end: number }
type Message = { type: string; height?: number; bytes?: number[]; settings?: Settings; id?: string; characters?: string; groups?: Glyph[][]; family?: string; tag?: string; min?: number; max?: number; reset?: boolean }
type Overrides = { [tag: string]: { min: number; max: number } }
type Detection = { status: 'detecting' | 'done' | 'error'; ranges: AxisRange[] | null; progress?: { done: number; total: number; tag: string } }
let uploaded: FontMeta | null = null
let busy = false
const detections = new Map<string, Detection>()
// Manually corrected axis ranges per family, persisted in clientStorage.
const overrides = new Map<string, Overrides>()
const OVERRIDES_KEY = (family: string) => `rangeOverrides:v1:${family}`

// Sanitize settings coming from the UI or from stored plugin data.
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
function normalizeShape(input: unknown): Shape | null {
  const sh = input as Partial<Shape> | null
  if (!sh || typeof sh !== 'object' || !isNum(sh.position) || !isNum(sh.falloff)) return null
  const curve = sh.curve === 'smooth' || sh.curve === 'easeIn' || sh.curve === 'easeOut' ? sh.curve : 'linear'
  const out: Shape = { position: Math.max(0, Math.min(1, sh.position)), falloff: Math.max(0.01, Math.min(1, sh.falloff)), curve }
  const b = sh.bezier
  if (Array.isArray(b) && b.length === 4 && b.every(isNum)) out.bezier = [Math.max(0, Math.min(1, b[0])), b[1], Math.max(0, Math.min(1, b[2])), b[3]]
  return out
}
// Sanitize settings coming from the UI or from stored plugin data.
function normalizeSettings(input: unknown): Settings | null {
  const v = input as Partial<Settings> | null
  if (!v || typeof v !== 'object' || !v.axes || typeof v.axes !== 'object') return null
  const shape = normalizeShape(v.shape)
  if (!shape) return null
  const axes: Settings['axes'] = {}
  for (const [tag, a] of Object.entries(v.axes)) {
    if (!/^[\x20-\x7e]{4}$/.test(tag) || !a || !isNum(a.base) || !isNum(a.peak)) return null
    const own = a.shape === undefined ? null : normalizeShape(a.shape)
    if (a.shape !== undefined && !own) return null
    axes[tag] = own ? { enabled: !!a.enabled, base: a.base, peak: a.peak, shape: own } : { enabled: !!a.enabled, base: a.base, peak: a.peak }
  }
  return { version: 2, axes, shape, mode: v.mode === 'word' ? 'word' : 'text' }
}
function readSaved(node: TextNode): Saved | null {
  try {
    const value = JSON.parse(node.getPluginData(KEY)) as Saved | SavedV1
    const original = value?.original
    if (typeof original?.characters !== 'string' || !Array.isArray(original.ranges)) return null
    const valid = original.ranges.every(r => Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end > r.start && r.end <= original.characters.length && typeof r.fontName?.family === 'string' && typeof r.fontName.style === 'string')
    if (!valid) return null
    if (value.version === 1) {
      // v1 stored a weight ramp: start → end across the text.
      const p = value.params || {}
      const start = typeof p.startWeight === 'number' ? p.startWeight : 100, end = typeof p.endWeight === 'number' ? p.endWeight : 900
      return { version: 2, original, settings: { version: 2, axes: { wght: { enabled: true, base: start, peak: end } }, shape: { ...DEFAULT_SHAPE }, mode: p.mode === 'word' ? 'word' : 'text' } }
    }
    const settings = value.version === 2 ? normalizeSettings(value.settings) : null
    return settings ? { version: 2, original, settings } : null
  } catch { return null }
}
function selected(): TextNode | null {
  const s = figma.currentPage.selection
  return s.length === 1 && s[0].type === 'TEXT' ? s[0] : null
}
function locked(node: SceneNode): boolean {
  let current: BaseNode | null = node
  while (current && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if ('locked' in current && current.locked) return true
    current = current.parent
  }
  return false
}
function canonical(value: string): string { return value.toLowerCase().replace(/[\s_-]+/g, '') }
function fileMatches(family: string): boolean { return !!uploaded && uploaded.families.some(f => canonical(f) === canonical(family)) }

type Info = { node: TextNode | null; family: string; font: FontName | null; axisTags: string[]; error: string }
function selectionInfo(): Info {
  const node = selected()
  const fail = (error: string, family = ''): Info => ({ node, family, font: null, axisTags: [], error })
  if (!node) return fail('Select exactly one text layer.')
  if (locked(node)) return fail('The text layer or a parent layer is locked.')
  if (!node.characters.length) return fail('The selected text is empty.')
  if (node.characters.length > 30000) return fail('Select text with no more than 30,000 characters.')
  if (node.hasMissingFont) return fail('This font is unavailable in Figma. Install or enable it first.')
  const fonts = node.getRangeAllFontNames(0, node.characters.length)
  const families = [...new Set(fonts.map(f => f.family))]
  if (families.length !== 1) return fail('Select text that uses a single font family.')
  const family = families[0]
  let axisTags: string[]
  try {
    const axes = figma.getFontFamilyVariationAxes(family)
    if (!axes) return fail('This is a static font. Choose a variable font.', family)
    axisTags = axes
  } catch { return fail('Could not detect the variable font.', family) }
  const info: Info = { node, family, font: fonts[0], axisTags, error: '' }
  return info
}

// Axis ranges for the selected family: a matching font file wins, then detection,
// then (if detection failed) the spec-wide ranges so the user can still work.
type AxesSource = 'file' | 'detected' | 'fallback'
function baseAxes(info: Info): { axes: AxisRange[]; source: AxesSource } | null {
  if (!info.family) return null
  if (uploaded && fileMatches(info.family)) return { axes: uploaded.axes, source: 'file' }
  const detection = detections.get(info.family)
  if (detection?.status === 'done' && detection.ranges) return { axes: detection.ranges, source: 'detected' }
  if (detection?.status === 'error') return { axes: info.axisTags.map(t => registeredRange(t, info.font?.variationSettings?.[t] ?? 0)), source: 'fallback' }
  return null
}
// Manual corrections win over every other source.
function effectiveAxes(info: Info): { axes: AxisRange[]; source: AxesSource } | null {
  const base = baseAxes(info)
  const own = info.family ? overrides.get(info.family) : undefined
  if (!base || !own) return base
  return { ...base, axes: base.axes.map(a => own[a.tag] && a.source !== 'unavailable' ? { ...a, ...own[a.tag], source: 'manual' as const } : a) }
}
async function loadOverrides(family: string): Promise<void> {
  if (overrides.has(family)) return
  overrides.set(family, {})
  try {
    const stored = await figma.clientStorage.getAsync(OVERRIDES_KEY(family)) as Overrides | undefined
    if (stored && typeof stored === 'object') {
      const clean: Overrides = {}
      for (const [tag, r] of Object.entries(stored)) if (r && isNum(r.min) && isNum(r.max) && r.min < r.max) clean[tag] = { min: r.min, max: r.max }
      overrides.set(family, clean)
      if (Object.keys(clean).length) refresh()
    }
  } catch { /* overrides are optional */ }
}
async function setOverride(msg: Message): Promise<void> {
  const family = msg.family, tag = msg.tag
  if (!family || !tag || selectionInfo().family !== family) return
  await loadOverrides(family)
  const own = { ...(overrides.get(family) || {}) }
  if (msg.reset) delete own[tag]
  else if (isNum(msg.min) && isNum(msg.max) && msg.min < msg.max) own[tag] = { min: msg.min, max: msg.max }
  else { postStatus('The minimum must be smaller than the maximum.', true); return }
  overrides.set(family, own)
  try { await figma.clientStorage.setAsync(OVERRIDES_KEY(family), own) } catch { /* keep in memory */ }
  refresh()
  postStatus(msg.reset ? 'Range reset.' : 'Range saved for ' + family + '.')
}
function adjustableAxes(info: Info): AxisRange[] | null {
  const e = effectiveAxes(info)
  return e ? e.axes.filter(a => a.source !== 'unavailable') : null
}

async function ensureDetection(info: Info): Promise<void> {
  if (!info.family || !info.font || detections.has(info.family)) return
  detections.set(info.family, { status: 'detecting', ranges: null })
  try {
    const cached = await cachedRanges(info.family)
    const usable = cached && info.axisTags.every(t => cached.some(r => r.tag === t))
    const ranges = usable ? cached : await detectRanges(info.font, info.axisTags, (done, total, tag) => {
      detections.set(info.family, { status: 'detecting', ranges: null, progress: { done, total, tag } })
      figma.ui.postMessage({ type: 'detect-progress', family: info.family, done, total, tag })
    })
    detections.set(info.family, { status: 'done', ranges })
  } catch {
    detections.set(info.family, { status: 'error', ranges: null })
  }
  refresh()
}

function refresh(): void {
  try {
    const info = selectionInfo()
    const saved = info.node ? readSaved(info.node) : null
    const fileError = uploaded && info.family && !fileMatches(info.family) ? 'The loaded font file is ' + uploaded.families[0] + ', not ' + info.family + '.' : ''
    const detection = info.family ? detections.get(info.family) : undefined
    if (info.family && info.axisTags.length && !detection) void ensureDetection(info)
    if (info.family && !overrides.has(info.family)) void loadOverrides(info.family)
    const effective = effectiveAxes(info)
    figma.ui.postMessage({
      type: 'selection', id: info.node?.id, characters: info.node?.characters || '', family: info.family, error: info.error, fileError,
      fileName: uploaded ? uploaded.families[0] : '', axisTags: info.axisTags,
      axes: effective?.axes || null, axesSource: effective?.source || null,
      detecting: !!info.axisTags.length && (!detection || detection.status === 'detecting'),
      progress: detection?.progress || null,
      settings: saved?.settings || null, canRestore: !!saved && saved.original.characters === info.node?.characters, busy,
    })
  } catch {
    figma.ui.postMessage({ type: 'selection', error: 'Could not read the text layer. Select it again.', characters: '', settings: null, canRestore: false, busy })
    postStatus('Could not read the text layer.', true)
  }
}
function postStatus(text: string, error = false): void { figma.ui.postMessage({ type: 'status', text, error }) }

async function loadFonts(node: TextNode, extra: FontRange[] = []): Promise<void> {
  const fonts = node.getRangeAllFontNames(0, node.characters.length).concat(extra.map(r => r.fontName))
  const unique = new Map<string, FontName>()
  for (const f of fonts) unique.set(JSON.stringify(f), f)
  await Promise.all([...unique.values()].map(f => figma.loadFontAsync(f)))
}
async function apply(msg: Message): Promise<void> {
  const settings = normalizeSettings(msg.settings)
  const info = selectionInfo(), node = info.node, axes = adjustableAxes(info)
  if (info.error || !node) { postStatus(info.error || 'Select a text layer.', true); return }
  if (!axes) { postStatus('The axis ranges are still being measured.', true); return }
  if (!settings) { postStatus('Invalid settings. Try again.', true); return }
  if (node.id !== msg.id || node.characters !== msg.characters) { refresh(); postStatus('The selection changed. Apply again.', true); return }
  const enabled = Object.entries(settings.axes).filter(([, a]) => a.enabled)
  if (!enabled.length) { postStatus('Turn on at least one axis.', true); return }
  for (const [tag, a] of enabled) {
    const range = axes.find(r => r.tag === tag)
    if (!range) { postStatus(`The ${tag} axis is not adjustable for this font.`, true); return }
    const outside = (v: number) => v < range.min - 1e-6 || v > range.max + 1e-6
    if (outside(a.base) || outside(a.peak)) { postStatus(`${range.name} must stay between ${range.min} and ${range.max}.`, true); return }
  }
  const groups = msg.groups
  if (!groups || groups.length > 30000) { postStatus('Could not split the text into characters.', true); return }
  let last = 0, glyphCount = 0
  for (const group of groups) {
    for (const g of group) {
      if (!Number.isInteger(g.start) || !Number.isInteger(g.end) || g.start < last || g.end <= g.start || g.end > node.characters.length || /\s/.test(node.characters.slice(g.start, g.end))) { postStatus('Invalid character segmentation. Try again.', true); return }
      last = g.end
      glyphCount++
    }
  }
  if (!glyphCount || glyphCount > 10000) { postStatus('Select between 1 and 10,000 visible characters.', true); return }
  const before = node.getStyledTextSegments(['fontName']).map(r => ({ start: r.start, end: r.end, fontName: r.fontName }))
  try { await loadFonts(node) }
  catch { postStatus('Could not load the font. Install or enable it in Figma.', true); return }
  if (selected()?.id !== node.id || node.characters !== msg.characters || locked(node)) { refresh(); postStatus('The selection changed. Apply again.', true); return }
  const saved = readSaved(node)
  const original = saved?.original.characters === node.characters ? saved.original : { characters: node.characters, ranges: before }
  const plan: { start: number; end: number; font: FontName; values: { [tag: string]: number } }[] = []
  for (const group of groups) {
    const values = computeValues(group.length, settings)
    for (let i = 0; i < group.length; i++) {
      const g = group[i]
      for (const r of before) {
        const start = Math.max(r.start, g.start), end = Math.min(r.end, g.end)
        // Merge: only the enabled axes change, every other axis keeps its current value.
        if (start < end) plan.push({ start, end, values: values[i], font: { ...r.fontName, variationSettings: { ...r.fontName.variationSettings, ...values[i] } } })
      }
    }
  }
  try {
    for (const r of plan) node.setRangeFontName(r.start, r.end, r.font)
    for (const r of plan) {
      const actual = node.getRangeFontName(r.start, r.end)
      const ok = actual !== figma.mixed && Object.entries(r.values).every(([tag, v]) => typeof actual.variationSettings?.[tag] === 'number' && Math.abs(actual.variationSettings[tag] - v) <= 0.05)
      if (!ok) {
        for (const old of before) node.setRangeFontName(old.start, old.end, old.fontName)
        postStatus('Figma did not apply the requested values. The text was reset.', true)
        return
      }
    }
    node.setPluginData(KEY, JSON.stringify({ version: 2, settings, original } satisfies Saved))
    node.setRelaunchData({ ...node.getRelaunchData(), [TOOL_ID]: 'Font Axis Gradient' })
    figma.commitUndo()
  } catch (error) {
    for (const r of before) node.setRangeFontName(r.start, r.end, r.fontName)
    throw error
  }
  refresh()
  const names = enabled.map(([tag]) => axes.find(r => r.tag === tag)?.name || tag)
  postStatus(`${glyphCount} ${glyphCount === 1 ? 'character' : 'characters'} updated · ${names.join(', ')}`)
}
async function restore(): Promise<void> {
  const node = selected()
  if (!node || locked(node)) { postStatus('Select an unlocked text layer.', true); return }
  const saved = readSaved(node)
  if (!saved || saved.original.characters !== node.characters) { postStatus('Cannot restore: the text has changed.', true); return }
  try { await loadFonts(node, saved.original.ranges) }
  catch { postStatus('Could not load the original font.', true); return }
  if (selected()?.id !== node.id || saved.original.characters !== node.characters || locked(node)) { refresh(); return }
  for (const r of saved.original.ranges) node.setRangeFontName(r.start, r.end, r.fontName)
  node.setPluginData(KEY, '')
  figma.commitUndo()
  refresh()
  postStatus('Original font settings restored.')
}

figma.showUI(__html__, { width: 300, height: 320, themeColors: true })
figma.on('selectionchange', () => { if (!busy) refresh() })

// Font (or text) changes on the selected layer don't fire selectionchange; watch the page.
let watchedPage: PageNode | null = null
let changeTimer: number | undefined
const WATCHED: NodeChangeProperty[] = ['fontName', 'characters', 'styledTextSegments', 'textStyleId']
function onNodeChange(event: NodeChangeEvent): void {
  if (busy) return
  const node = selected()
  if (!node) return
  const relevant = event.nodeChanges.some(c => c.id === node.id && (c.type !== 'PROPERTY_CHANGE' || c.properties.some(p => WATCHED.includes(p))))
  if (!relevant) return
  if (changeTimer !== undefined) clearTimeout(changeTimer)
  changeTimer = setTimeout(refresh, 120)
}
function watchPage(): void {
  if (watchedPage === figma.currentPage) return
  watchedPage?.off('nodechange', onNodeChange)
  watchedPage = figma.currentPage
  watchedPage.on('nodechange', onNodeChange)
}
watchPage()
figma.on('currentpagechange', () => { watchPage(); if (!busy) refresh() })
figma.ui.onmessage = async (msg: Message) => {
  if (msg.type === 'resize' && typeof msg.height === 'number' && Number.isFinite(msg.height)) { figma.ui.resize(300, Math.max(100, Math.min(760, Math.round(msg.height)))); return }
  if (msg.type === 'ready') { refresh(); return }
  if (busy) return
  if (msg.type === 'range-override') { await setOverride(msg); return }
  if (msg.type === 'file') {
    uploaded = null
    if (!msg.bytes) { refresh(); postStatus('No font file loaded. Detected ranges are used instead.'); return }
    try { uploaded = parseFont(msg.bytes) }
    catch (error) { refresh(); postStatus(error instanceof Error && !(error instanceof RangeError) ? error.message : 'Could not read the font file. It may be invalid or incomplete.', true); return }
    refresh()
    postStatus(`${uploaded.axes.length} ${uploaded.axes.length === 1 ? 'axis' : 'axes'} read from ${uploaded.families[0]}`)
    return
  }
  if (msg.type !== 'apply' && msg.type !== 'restore') return
  busy = true
  figma.ui.postMessage({ type: 'busy', busy: true })
  try { if (msg.type === 'apply') await apply(msg); else await restore() }
  catch (error) { postStatus('Could not complete the change.', true); throw error }
  finally { busy = false; figma.ui.postMessage({ type: 'busy', busy: false }) }
}
refresh()
