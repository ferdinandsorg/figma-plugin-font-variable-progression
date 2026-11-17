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
// Every letter change costs time proportional to the text length, so live editing gets
// quadratically slower. 100 characters keeps a slider step well under a second.
const MAX_CHARS = 100
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
  if (node.characters.length > MAX_CHARS) return fail(`This text is too long (${node.characters.length} characters). Font Axis Gradient works on texts up to ${MAX_CHARS} characters, such as headlines.`)
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

let known: { id?: string; family: string; characters: string; error: string } = { family: '', characters: '', error: '' }
function refresh(): void {
  try {
    const info = selectionInfo()
    known = { id: info.node?.id, family: info.family, characters: info.node?.characters || '', error: info.error }
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
type Prepared = { node: TextNode; settings: Settings; groups: Glyph[][] }
type PlanItem = { start: number; end: number; font: FontName; values: { [tag: string]: number } }

// Validate a live edit against the current selection and axis ranges.
function prepare(msg: Message): Prepared | { error: string; stale?: boolean } {
  const settings = normalizeSettings(msg.settings)
  const info = selectionInfo(), node = info.node, axes = adjustableAxes(info)
  if (info.error || !node) return { error: info.error || 'Select a text layer.' }
  if (!axes) return { error: 'The axis ranges are still being measured.' }
  if (!settings) return { error: 'Invalid settings. Try again.' }
  if (node.id !== msg.id || node.characters !== msg.characters) return { error: 'The selection changed. Apply again.', stale: true }
  const enabled = Object.entries(settings.axes).filter(([, a]) => a.enabled)
  if (!enabled.length) return { error: 'Turn on at least one axis.' }
  for (const [tag, a] of enabled) {
    const range = axes.find(r => r.tag === tag)
    if (!range) return { error: `The ${tag} axis is not adjustable for this font.` }
    const outside = (v: number) => v < range.min - 1e-6 || v > range.max + 1e-6
    if (outside(a.base) || outside(a.peak)) return { error: `${range.name} must stay between ${range.min} and ${range.max}.` }
  }
  const groups = msg.groups
  if (!groups || groups.length > 30000) return { error: 'Could not split the text into characters.' }
  let last = 0, glyphCount = 0
  for (const group of groups) {
    for (const g of group) {
      if (!Number.isInteger(g.start) || !Number.isInteger(g.end) || g.start < last || g.end <= g.start || g.end > node.characters.length || /\s/.test(node.characters.slice(g.start, g.end))) return { error: 'Invalid character segmentation. Try again.' }
      last = g.end
      glyphCount++
    }
  }
  if (!glyphCount) return { error: 'The text has no visible characters.' }
  return { node, settings, groups }
}

// Per-letter font ranges: only the enabled axes change, every other axis keeps its value.
function buildPlan(groups: Glyph[][], settings: Settings, before: FontRange[]): PlanItem[] {
  const plan: PlanItem[] = []
  for (const group of groups) {
    const values = computeValues(group.length, settings)
    for (let i = 0; i < group.length; i++) {
      const g = group[i]
      for (const r of before) {
        const start = Math.max(r.start, g.start), end = Math.min(r.end, g.end)
        if (start < end) plan.push({ start, end, values: values[i], font: { ...r.fontName, variationSettings: { ...r.fontName.variationSettings, ...values[i] } } })
      }
    }
  }
  return plan
}
function fontRanges(node: TextNode): FontRange[] {
  return node.getStyledTextSegments(['fontName']).map(r => ({ start: r.start, end: r.end, fontName: r.fontName }))
}

// Neighbouring letters with identical values become one call: each setRangeFontName costs
// time proportional to the text length, so fewer calls is the only real speed-up.
function mergePlan(plan: PlanItem[]): PlanItem[] {
  const out: PlanItem[] = []
  for (const r of plan) {
    const last = out[out.length - 1]
    if (last && last.end === r.start && JSON.stringify(last.font) === JSON.stringify(r.font)) last.end = r.end
    else out.push({ ...r })
  }
  return out
}

// ---------- live editing ----------
// Changes go straight onto the selected text. They are not committed to the undo history
// until Done, a selection change or closing the plugin, so a whole session is one undo step.
let liveRunning = false
let liveNext: Message | null = null
let liveDirty = false
function requestLive(msg: Message): void {
  if (liveRunning) { liveNext = msg; return }
  liveRunning = true
  applyLive(msg)
    .catch(() => postStatus('Could not update the text.', true))
    .finally(() => {
      liveRunning = false
      const next = liveNext
      liveNext = null
      if (next && !busy) requestLive(next)
    })
}
async function waitForLive(): Promise<void> {
  liveNext = null
  while (liveRunning) await new Promise<void>(resolve => setTimeout(resolve, 10))
}
async function applyLive(msg: Message): Promise<void> {
  const prepared = prepare(msg)
  if ('error' in prepared) { if (prepared.stale) refresh(); else postStatus(prepared.error, true); return }
  const { node, settings, groups } = prepared
  try { await loadFonts(node) }
  catch { postStatus('Could not load the font. Install or enable it in Figma.', true); return }
  if (busy || selected()?.id !== node.id || node.characters !== msg.characters || locked(node)) return
  const before = fontRanges(node)
  const saved = readSaved(node)
  // Remember the state before the first change so Restore can always go back to it.
  const original = saved?.original.characters === node.characters ? saved.original : { characters: node.characters, ranges: before }
  const firstChange = !saved || saved.original.characters !== node.characters
  for (const r of mergePlan(buildPlan(groups, settings, before))) node.setRangeFontName(r.start, r.end, r.font)
  node.setPluginData(KEY, JSON.stringify({ version: 2, settings, original } satisfies Saved))
  if (firstChange) node.setRelaunchData({ ...node.getRelaunchData(), [TOOL_ID]: 'Font Axis Gradient' })
  liveDirty = true
  figma.ui.postMessage({ type: 'live-applied', id: node.id, canRestore: true })
}
function commitLive(): void {
  if (!liveDirty) return
  liveDirty = false
  figma.commitUndo()
}
async function done(): Promise<void> {
  await waitForLive()
  commitLive()
  figma.closePlugin()
}

async function restore(): Promise<void> {
  await waitForLive()
  const node = selected()
  if (!node || locked(node)) { postStatus('Select an unlocked text layer.', true); return }
  const saved = readSaved(node)
  if (!saved || saved.original.characters !== node.characters) { postStatus('Cannot restore: the text has changed.', true); return }
  try { await loadFonts(node, saved.original.ranges) }
  catch { postStatus('Could not load the original font.', true); return }
  if (selected()?.id !== node.id || saved.original.characters !== node.characters || locked(node)) { refresh(); return }
  for (const r of saved.original.ranges) node.setRangeFontName(r.start, r.end, r.fontName)
  node.setPluginData(KEY, '')
  liveDirty = false
  figma.commitUndo()
  refresh()
  postStatus('Original font settings restored.')
}

figma.showUI(__html__, { width: 300, height: 320, themeColors: true })
figma.on('selectionchange', () => { commitLive(); if (!busy) refresh() })

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
  changeTimer = setTimeout(() => {
    // Live edits only change variation values; refresh only when family or text changed.
    const info = selectionInfo()
    if (info.node?.id === known.id && info.family === known.family && info.node?.characters === known.characters && !info.error === !known.error) return
    refresh()
  }, 120)
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
  if (msg.type === 'live') { requestLive(msg); return }
  if (msg.type === 'done') { await done(); return }
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
  if (msg.type !== 'restore') return
  busy = true
  figma.ui.postMessage({ type: 'busy', busy: true })
  try { await restore() }
  catch (error) { postStatus('Could not complete the change.', true); throw error }
  finally { busy = false; figma.ui.postMessage({ type: 'busy', busy: false }) }
}
refresh()
