// The runtime supports variable font axes; bundled compiler declarations lag behind.
interface FontName { readonly variationSettings?: { readonly [axis: string]: number } }
type VariableFontApi = PluginAPI & { getFontFamilyVariationAxes(family: string): string[] | null }
const variableFontApi = figma as VariableFontApi
const TOOL_ID = 'f5640f22-a592-4f4f-8903-2397d80a7bee'
const KEY = TOOL_ID + ':state'
type Params = { startWeight: number; endWeight: number; mode: 'text' | 'word'; source: 'manual' | 'file' }
type FontRange = { start: number; end: number; fontName: FontName }
type Saved = { version: 1; params: Params; original: { characters: string; ranges: FontRange[] } }
type FontMeta = { families: string[]; min: number; max: number; defaultValue: number; axes: string[] }
type Glyph = { start: number; end: number }
type Message = { type: string; height?: number; bytes?: number[]; params?: Partial<Params>; id?: string; characters?: string; groups?: Glyph[][] }
const DEFAULTS: Params = { startWeight: 100, endWeight: 900, mode: 'text', source: 'manual' }
let uploaded: FontMeta | null = null
let busy = false

function normalizeParams(input?: Partial<Params>): Params {
  return {
    startWeight: typeof input?.startWeight === 'number' && Number.isFinite(input.startWeight) ? input.startWeight : 100,
    endWeight: typeof input?.endWeight === 'number' && Number.isFinite(input.endWeight) ? input.endWeight : 900,
    mode: input?.mode === 'word' ? 'word' : 'text',
    source: input?.source === 'file' ? 'file' : 'manual',
  }
}
function readSaved(node: TextNode): Saved | null {
  try {
    const value = JSON.parse(node.getPluginData(KEY)) as Saved
    if (value.version !== 1 || typeof value.original?.characters !== 'string' || !Array.isArray(value.original.ranges)) return null
    const valid = value.original.ranges.every(r => Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end > r.start && r.end <= value.original.characters.length && typeof r.fontName?.family === 'string' && typeof r.fontName.style === 'string')
    return valid ? { ...value, params: normalizeParams({ ...value.params, source: value.params.source || 'file' }) } : null
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
function selectionInfo(source: 'manual' | 'file' = 'manual'): { node: TextNode | null; family: string; error: string } {
  const node = selected()
  if (!node) return { node: null, family: '', error: 'Select exactly one text layer.' }
  if (locked(node)) return { node, family: '', error: 'The text layer or a parent layer is locked.' }
  if (!node.characters.length) return { node, family: '', error: 'The selected text is empty.' }
  if (node.characters.length > 30000) return { node, family: '', error: 'Select text with no more than 30,000 characters.' }
  if (node.hasMissingFont) return { node, family: '', error: 'This font is unavailable in Figma. Install or enable it first.' }
  const fonts = node.getRangeAllFontNames(0, node.characters.length)
  const families = [...new Set(fonts.map(f => f.family))]
  if (families.length !== 1) return { node, family: '', error: 'Select text that uses a single font family.' }
  const family = families[0]
  try {
    const axes = typeof variableFontApi.getFontFamilyVariationAxes === 'function' ? variableFontApi.getFontFamilyVariationAxes(family) : null
    if (!axes?.includes('wght') && !fonts.some(f => typeof f.variationSettings?.wght === 'number')) return { node, family, error: 'This font has no variable weight axis. Choose a variable font or update Figma.' }
  } catch { return { node, family, error: 'Could not detect the variable font.' } }
  if (source === 'file' && uploaded && !uploaded.families.some(f => canonical(f) === canonical(family))) return { node, family, error: 'The font file does not match the selected font family.' }
  return { node, family, error: '' }
}
function refresh(): void {
  try {
    const info = selectionInfo()
    const saved = info.node ? readSaved(info.node) : null
    const fileError = uploaded && !uploaded.families.some(f => canonical(f) === canonical(info.family)) ? 'The font file does not match the selected font family.' : ''
    figma.ui.postMessage({ type: 'selection', id: info.node?.id, characters: info.node?.characters || '', family: info.family, error: info.error, fileError, meta: uploaded, params: saved?.params || DEFAULTS, canRestore: !!saved && saved.original.characters === info.node?.characters, busy })
  } catch {
    figma.ui.postMessage({ type: 'selection', error: 'Could not read the text layer. Select it again.', characters: '', params: DEFAULTS, meta: uploaded, canRestore: false, busy })
    postStatus('Could not read the text layer.', true)
  }
}
function postStatus(text: string, error = false): void { figma.ui.postMessage({ type: 'status', text, error }) }

// Read the actual sfnt fvar and name tables, without installing or persisting the font.
function parseFont(bytes: number[]): FontMeta {
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('Upload a TTF or OTF file up to 20 MB.')
  const view = new DataView(new Uint8Array(bytes).buffer)
  const tag = (p: number): string => String.fromCharCode(view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3))
  if (view.byteLength < 12 || (view.getUint32(0) !== 0x00010000 && tag(0) !== 'OTTO' && tag(0) !== 'true')) throw new Error('Only uncompressed variable TTF and OTF files are supported.')
  const count = view.getUint16(4)
  if (12 + count * 16 > view.byteLength) throw new Error('The font file is corrupted.')
  const tables: { [key: string]: { offset: number; length: number } } = {}
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16, offset = view.getUint32(p + 8), length = view.getUint32(p + 12)
    if (offset + length > view.byteLength) throw new Error('The font file contains an invalid table length.')
    tables[tag(p)] = { offset, length }
  }
  const fvar = tables.fvar, name = tables.name
  if (!fvar || fvar.length < 16) throw new Error('This is not a variable font: the fvar table is missing or incomplete.')
  if (!name || name.length < 6) throw new Error('Could not read the font family.')
  const axisStart = fvar.offset + view.getUint16(fvar.offset + 4)
  const axisCount = view.getUint16(fvar.offset + 8), axisSize = view.getUint16(fvar.offset + 10)
  if (axisSize < 20 || axisStart + axisCount * axisSize > fvar.offset + fvar.length) throw new Error('The variable font axes are invalid.')
  let weight: { min: number; max: number; defaultValue: number } | null = null
  const axes: string[] = []
  for (let i = 0; i < axisCount; i++) {
    const p = axisStart + i * axisSize, axis = tag(p)
    axes.push(axis)
    if (axis === 'wght') weight = { min: view.getInt32(p + 4) / 65536, defaultValue: view.getInt32(p + 8) / 65536, max: view.getInt32(p + 12) / 65536 }
  }
  if (!weight || weight.min >= weight.max || weight.defaultValue < weight.min || weight.defaultValue > weight.max) throw new Error('The font has no valid variable weight axis (wght).')
  const n = view.getUint16(name.offset + 2), strings = name.offset + view.getUint16(name.offset + 4)
  if (name.offset + 6 + n * 12 > name.offset + name.length) throw new Error('The font name table is invalid.')
  const families: string[] = []
  for (let i = 0; i < n; i++) {
    const p = name.offset + 6 + i * 12, platform = view.getUint16(p), id = view.getUint16(p + 6)
    if (id !== 1 && id !== 16) continue
    const length = view.getUint16(p + 8), start = strings + view.getUint16(p + 10)
    if (start + length > name.offset + name.length || start < name.offset) continue
    let value = ''
    if (platform === 0 || platform === 3) {
      for (let j = 0; j + 1 < length; j += 2) value += String.fromCharCode(view.getUint16(start + j))
    } else if (platform === 1) {
      for (let j = 0; j < length; j++) value += String.fromCharCode(view.getUint8(start + j))
    }
    if (value.trim()) families.push(value.trim())
  }
  if (!families.length) throw new Error('No supported font family name was found in the file.')
  return { families: [...new Set(families)], ...weight, axes }
}
async function loadFonts(node: TextNode, extra: FontRange[] = []): Promise<void> {
  const fonts = node.getRangeAllFontNames(0, node.characters.length).concat(extra.map(r => r.fontName))
  const unique = new Map<string, FontName>()
  for (const f of fonts) unique.set(JSON.stringify(f), f)
  await Promise.all([...unique.values()].map(f => figma.loadFontAsync(f)))
}
async function apply(msg: Message): Promise<void> {
  const params = normalizeParams(msg.params)
  const info = selectionInfo(params.source), node = info.node, meta = params.source === 'file' ? uploaded : null
  if (info.error || !node || (params.source === 'file' && !meta)) { postStatus(info.error || 'Upload the matching font file or switch to Manual.', true); return }
  if (node.id !== msg.id || node.characters !== msg.characters) { refresh(); postStatus('The selection changed. Apply again.', true); return }
  const min = meta ? meta.min : 1, max = meta ? meta.max : 1000
  if (typeof msg.params?.startWeight !== 'number' || !Number.isFinite(msg.params.startWeight) || typeof msg.params.endWeight !== 'number' || !Number.isFinite(msg.params.endWeight) || params.startWeight < min || params.startWeight > max || params.endWeight < min || params.endWeight > max) { postStatus(`Weights must be between ${min} and ${max}.`, true); return }
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
  const plan: { start: number; end: number; font: FontName }[] = []
  for (const group of groups) {
    for (let i = 0; i < group.length; i++) {
      const g = group[i], weight = params.startWeight + (params.endWeight - params.startWeight) * (group.length === 1 ? 0 : i / (group.length - 1))
      for (const r of before) {
        const start = Math.max(r.start, g.start), end = Math.min(r.end, g.end)
        if (start < end) plan.push({ start, end, font: { ...r.fontName, variationSettings: { ...r.fontName.variationSettings, wght: weight } } })
      }
    }
  }
  try {
    for (const r of plan) node.setRangeFontName(r.start, r.end, r.font)
    for (const r of plan) {
      const actual = node.getRangeFontName(r.start, r.end)
      if (actual === figma.mixed || typeof actual.variationSettings?.wght !== 'number' || Math.abs(actual.variationSettings.wght - (r.font.variationSettings?.wght || 0)) > 0.05) {
        for (const old of before) node.setRangeFontName(old.start, old.end, old.fontName)
        postStatus('The font did not accept the requested weights. Use supported values or load the range from the font file. The text was reset.', true)
        return
      }
    }
    node.setPluginData(KEY, JSON.stringify({ version: 1, params, original }))
    node.setRelaunchData({ ...node.getRelaunchData(), [TOOL_ID]: 'Font weight gradient' })
    figma.commitUndo()
  } catch (error) {
    for (const r of before) node.setRangeFontName(r.start, r.end, r.fontName)
    throw error
  }
  refresh()
  postStatus(`${glyphCount} characters updated · ${params.startWeight} → ${params.endWeight}`)
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
  postStatus('Original font weights restored.')
}

const initial = selected(), initialParams = initial ? readSaved(initial)?.params || DEFAULTS : DEFAULTS
let html = __html__
html = html.replace(/(id="startWeight"[^>]*\bvalue=")[^"]*(")/g, '$1' + String(initialParams.startWeight) + '$2')
html = html.replace(/(id="endWeight"[^>]*\bvalue=")[^"]*(")/g, '$1' + String(initialParams.endWeight) + '$2')
html = html.replace(/(id="mode"[^>]*\bvalue=")[^"]*(")/g, '$1' + initialParams.mode + '$2')
html = html.replace(/(id="source"[^>]*\bvalue=")[^"]*(")/g, '$1' + initialParams.source + '$2')
figma.showUI(html, { width: 280, height: 320, themeColors: true })
figma.on('selectionchange', () => { if (!busy) refresh() })
figma.ui.onmessage = async (msg: Message) => {
  if (msg.type === 'resize' && typeof msg.height === 'number' && Number.isFinite(msg.height)) { figma.ui.resize(280, Math.max(100, Math.min(900, Math.round(msg.height)))); return }
  if (msg.type === 'ready') { refresh(); return }
  if (busy) return
  if (msg.type === 'file') {
    uploaded = null
    if (!msg.bytes) { refresh(); postStatus('No font file loaded. You can enter start and end weights manually.'); return }
    try { uploaded = parseFont(msg.bytes) }
    catch (error) { refresh(); postStatus(error instanceof Error && !(error instanceof RangeError) ? error.message : 'Could not read the font file. It may be invalid or incomplete.', true); return }
    refresh()
    postStatus(`Weight range: ${uploaded.min}–${uploaded.max}`)
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
