import type { AxisRange } from '../axes'
import { AxisSetting, Bezier, CURVE_BEZIER, DEFAULT_SHAPE, Settings, Shape, computeValues, isRamp, strengths } from '../engine'

type Glyph = { start: number; end: number }
type Selection = {
  id?: string
  characters: string
  family?: string
  error?: string
  fileError?: string
  axisTags?: string[]
  axes?: AxisRange[] | null
  axesSource?: 'file' | 'detected' | 'fallback' | null
  detecting?: boolean
  progress?: { done: number; total: number; tag: string } | null
  settings?: Settings | null
  canRestore?: boolean
}
// FigUI3 custom elements expose `value` / `checked`; keep access loose.
type Control = HTMLElement & { value?: string; checked?: boolean }

const $ = <T extends HTMLElement = Control>(id: string) => document.getElementById(id) as T
const send = (msg: object) => parent.postMessage({ pluginMessage: msg }, '*')
const fmt = (v: number) => Number(v.toFixed(2)).toLocaleString('en')
const PREVIEW_LIMIT = 24
const ICON_LINK = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M6.5 9.5l3-3M7 4.8l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.2l-1 1a2.5 2.5 0 01-3.5-3.5l1-1"/></svg>'
const ICON_UNLINK = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M7 4.8l1-1a2.5 2.5 0 013.5 3.5l-1 1M9 11.2l-1 1a2.5 2.5 0 01-3.5-3.5l1-1M3 3l1.5 1.5M13 13l-1.5-1.5"/></svg>'
const ICON_EDIT = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M10.5 3.5l2 2L6 12H4v-2z"/></svg>'

let selection: Selection | null = null
let settings: Settings = { version: 2, axes: {}, shape: { ...DEFAULT_SHAPE }, mode: 'text' }
let busy = false, uploading = false, uploadVersion = 0, connected = false
let lastId: string | undefined, lastFamily: string | undefined
let showValues = false
let activeAction: 'apply' | 'restore' = 'apply'
/** Which progression the controls edit: null = shared, otherwise a detached axis tag. */
let target: string | null = null
let editingRange: string | null = null
let segmenter: Intl.Segmenter | null = null
try { segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' }) } catch { /* older engines */ }

// ---------- controls ----------
function setControl(el: Control, value: string | number): void {
  el.setAttribute('value', String(value))
  if (customElements.get(el.localName)) el.value = String(value)
}
function readControl(el: Control): string {
  return customElements.get(el.localName) ? String(el.value ?? '') : el.getAttribute('value') || ''
}
function setChecked(el: Control, on: boolean): void {
  el.toggleAttribute('checked', on)
  if (customElements.get(el.localName)) el.checked = on
}
function eventChecked(event: Event): boolean {
  const detail = (event as CustomEvent).detail
  if (detail && typeof detail.checked === 'boolean') return detail.checked
  return !!(event.currentTarget as Control).checked
}

// ---------- model ----------
function adjustable(): AxisRange[] {
  return (selection?.axes || []).filter(a => a.source !== 'unavailable')
}
function clamp(v: number, a: AxisRange): number { return Math.max(a.min, Math.min(a.max, v)) }
function defaultSetting(a: AxisRange, firstAxis: boolean): AxisSetting {
  if (a.tag === 'wght') return { enabled: firstAxis, base: a.min, peak: a.max }
  return { enabled: false, base: a.defaultValue, peak: a.max === a.defaultValue ? a.min : a.max }
}
// Fill missing axes with defaults and keep stored values inside the known ranges.
function reconcile(): void {
  const axes = adjustable()
  const anyEnabled = Object.values(settings.axes).some(a => a.enabled)
  const hasWeight = axes.some(a => a.tag === 'wght')
  for (const a of axes) {
    const s = settings.axes[a.tag]
    if (!s) settings.axes[a.tag] = defaultSetting(a, !anyEnabled && (a.tag === 'wght' || (!hasWeight && a === axes[0])))
    else settings.axes[a.tag] = { ...s, base: clamp(s.base, a), peak: clamp(s.peak, a) }
  }
  if (!anyEnabled && !hasWeight && axes[0] && settings.axes[axes[0].tag]) settings.axes[axes[0].tag].enabled = true
}
function enabledTags(): string[] {
  const known = new Set(adjustable().map(a => a.tag))
  return Object.entries(settings.axes).filter(([t, a]) => a.enabled && known.has(t)).map(([t]) => t)
}
function payload(): Settings {
  const known = new Set(adjustable().map(a => a.tag))
  const axes: Settings['axes'] = {}
  for (const [t, a] of Object.entries(settings.axes)) if (known.has(t)) axes[t] = a
  return { ...settings, axes }
}
function groups(): Glyph[][] {
  if (!selection || !segmenter) return []
  const result: Glyph[][] = [], all: Glyph[] = []
  let word: Glyph[] = []
  for (const g of segmenter.segment(selection.characters)) {
    if (/\s/.test(g.segment)) { if (word.length) result.push(word); word = []; continue }
    const glyph = { start: g.index, end: g.index + g.segment.length }
    all.push(glyph); word.push(glyph)
  }
  if (word.length) result.push(word)
  return settings.mode === 'word' ? result : (all.length ? [all] : [])
}
function detachedTags(): string[] { return enabledTags().filter(t => !!settings.axes[t]?.shape) }
function validTarget(): string | null {
  if (target && settings.axes[target]?.enabled && settings.axes[target]?.shape) return target
  const linked = enabledTags().some(t => !settings.axes[t].shape)
  return linked ? null : detachedTags()[0] ?? null
}
/** The shape object the controls currently edit (mutable). */
function editedShape(): Shape {
  const t = validTarget()
  return (t && settings.axes[t]?.shape) || settings.shape
}
function axisName(tag: string): string { return selection?.axes?.find(a => a.tag === tag)?.name || tag }
function validation(): string {
  const tags = enabledTags()
  if (!adjustable().length) return ''
  if (!tags.length) return 'Turn on at least one axis.'
  for (const t of tags) {
    const a = adjustable().find(r => r.tag === t)!, s = settings.axes[t]
    if (s.base < a.min || s.base > a.max || s.peak < a.min || s.peak > a.max) return `${a.name}: use values between ${fmt(a.min)} and ${fmt(a.max)}.`
  }
  return ''
}

// ---------- rendering ----------
function renderAxes(): void {
  const box = $('axes')
  const axes = selection?.error ? [] : selection?.axes || []
  const key = JSON.stringify(axes)
  if (box.dataset.key !== key) {
    box.dataset.key = key
    box.replaceChildren(...axes.map(axisElement))
  }
  for (const a of adjustable()) {
    const row = box.querySelector<HTMLElement>(`[data-tag="${a.tag}"]`)
    const s = settings.axes[a.tag]
    if (!row || !s) continue
    const own = !!s.shape
    row.classList.toggle('on', s.enabled)
    setChecked(row.querySelector<Control>('fig-switch')!, s.enabled)
    row.querySelector<HTMLElement>(':scope > .axis-values')!.hidden = !s.enabled
    const link = row.querySelector<HTMLButtonElement>('[data-action="link"]')!
    link.hidden = !s.enabled
    link.innerHTML = own ? ICON_UNLINK : ICON_LINK
    link.setAttribute('aria-pressed', String(own))
    link.title = own ? 'Own progression · click to follow the shared one' : 'Follows the shared progression · click to give this axis its own'
    link.setAttribute('aria-label', (own ? 'Link ' : 'Detach ') + a.name)
    row.querySelector<HTMLElement>('.own')!.hidden = !(own && s.enabled)
    const edit = row.querySelector<HTMLButtonElement>('[data-action="edit"]')!
    edit.setAttribute('aria-pressed', String(editingRange === a.tag))
    row.querySelector<HTMLElement>('.range-editor')!.hidden = editingRange !== a.tag
    const [base, peak] = row.querySelectorAll<Control>(':scope > .axis-values fig-input-number')
    for (const [el, v] of [[base, s.base], [peak, s.peak]] as const) {
      el.setAttribute('min', String(a.min)); el.setAttribute('max', String(a.max))
      if (!el.contains(document.activeElement)) setControl(el, v)
    }
    for (const el of [row.querySelector<Control>('fig-switch')!, base, peak]) el.toggleAttribute('disabled', busy)
    link.disabled = busy; edit.disabled = busy
  }
}
function iconButton(action: string, html: string, label: string): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'; b.className = 'icon-button'; b.dataset.action = action
  b.innerHTML = html; b.title = label; b.setAttribute('aria-label', label)
  return b
}
function axisElement(a: AxisRange): HTMLElement {
  const unavailable = a.source === 'unavailable'
  const row = document.createElement('div')
  row.className = 'axis' + (unavailable ? ' unavailable' : '')
  row.dataset.tag = a.tag
  const head = document.createElement('div'); head.className = 'axis-head'
  const title = document.createElement('div'); title.className = 'title'
  const name = document.createElement('span'); name.textContent = a.name
  const tag = document.createElement('code'); tag.textContent = a.tag
  const own = document.createElement('em'); own.className = 'own'; own.textContent = 'own'; own.hidden = true
  title.append(name, tag, own)
  const range = document.createElement('span'); range.className = 'range'
  if (unavailable) {
    range.textContent = a.tag === 'opsz' ? 'Auto · font size' : 'Not adjustable'
    range.title = a.tag === 'opsz' ? 'Figma sets the optical size automatically from the font size.' : 'Changing this axis has no visible effect in Figma.'
    const spacer = document.createElement('span'); spacer.className = 'axis-switch-spacer'
    head.append(spacer, title, range, document.createElement('span'))
    row.append(head)
    return row
  }
  range.textContent = fmt(a.min) + '–' + fmt(a.max)
  range.title = (a.source === 'registered' ? 'Assumed from the OpenType spec · ' : a.source === 'manual' ? 'Set manually · ' : '') + 'Default ' + fmt(a.defaultValue)
  const toggle = document.createElement('fig-switch') as Control
  toggle.setAttribute('aria-label', 'Use ' + a.name)
  toggle.addEventListener('change', e => { const s = settings.axes[a.tag]; if (s) { s.enabled = eventChecked(e); update() } })
  const actions = document.createElement('div'); actions.className = 'axis-actions'
  const link = iconButton('link', ICON_LINK, 'Detach progression')
  link.addEventListener('click', () => {
    const s = settings.axes[a.tag]; if (!s) return
    if (s.shape) { delete s.shape; if (target === a.tag) target = null }
    else { s.shape = { ...settings.shape }; target = a.tag }
    update()
  })
  const edit = iconButton('edit', ICON_EDIT, 'Correct the range of ' + a.name)
  edit.addEventListener('click', () => { editingRange = editingRange === a.tag ? null : a.tag; update() })
  actions.append(link, edit)
  head.append(toggle, title, range, actions)
  const values = document.createElement('div'); values.className = 'axis-values'; values.hidden = true
  for (const key of ['base', 'peak'] as const) {
    const wrap = document.createElement('div')
    const label = document.createElement('label'); label.textContent = key === 'base' ? 'Edge' : 'Peak'
    const input = numberInput(settings.axes[a.tag]?.[key] ?? a.defaultValue, a.max - a.min <= 2 ? 0.01 : 1, `${a.name} ${key === 'base' ? 'edge' : 'peak'} value`)
    const onValue = () => {
      const v = Number(readControl(input)), s = settings.axes[a.tag]
      if (s && readControl(input) !== '' && Number.isFinite(v)) { s[key] = v; update() }
    }
    input.addEventListener('input', onValue)
    input.addEventListener('change', onValue)
    wrap.append(label, input); values.append(wrap)
  }
  row.append(head, rangeEditor(a), values)
  return row
}
function numberInput(value: number, step: number, label: string): Control {
  const input = document.createElement('fig-input-number') as Control
  for (const [k, v] of Object.entries({ step, precision: 2, value })) input.setAttribute(k, String(v))
  input.setAttribute('full', '')
  input.setAttribute('aria-label', label)
  return input
}
function rangeEditor(a: AxisRange): HTMLElement {
  const box = document.createElement('div'); box.className = 'range-editor'; box.hidden = true
  const values = document.createElement('div'); values.className = 'axis-values'
  const step = a.max - a.min <= 2 ? 0.01 : 1
  const inputs = (['min', 'max'] as const).map(key => {
    const wrap = document.createElement('div')
    const label = document.createElement('label'); label.textContent = key === 'min' ? 'Minimum' : 'Maximum'
    const input = numberInput(a[key], step, `${a.name} ${key}imum`)
    wrap.append(label, input); values.append(wrap)
    return input
  })
  const row = document.createElement('div'); row.className = 'row'
  if (a.source === 'manual') {
    const reset = document.createElement('fig-button'); reset.setAttribute('variant', 'ghost'); reset.textContent = 'Reset'
    reset.addEventListener('click', () => { editingRange = null; send({ type: 'range-override', family: selection?.family, tag: a.tag, reset: true }) })
    row.append(reset)
  }
  const save = document.createElement('fig-button'); save.setAttribute('variant', 'secondary'); save.textContent = 'Save range'
  save.addEventListener('click', () => {
    const [min, max] = inputs.map(i => Number(readControl(i)))
    if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) { message('The minimum must be smaller than the maximum.', true); return }
    editingRange = null
    send({ type: 'range-override', family: selection?.family, tag: a.tag, min, max })
  })
  row.append(save)
  const hint = document.createElement('p'); hint.className = 'helper'
  hint.textContent = 'Overrides the measured range for ' + a.name + ' in this font.'
  box.append(values, hint, row)
  return box
}
function renderDetection(): void {
  const detecting = !!selection?.detecting && !selection.error
  $('detecting').hidden = !detecting
  if (detecting) {
    const p = selection!.progress
    $('detecting-text').textContent = p ? `Measuring axis ranges… ${p.done + 1} of ${p.total} · ${p.tag}` : 'Measuring axis ranges…'
    $('progress-bar').style.width = p ? Math.round((p.done / p.total) * 100) + '%' : '0%'
  }
  const source = selection?.axesSource
  $('axes-badge').textContent = detecting ? '' : source === 'file' ? 'From font file' : source === 'detected' ? 'Measured' : source === 'fallback' ? 'Assumed' : ''
  const help = source === 'fallback' ? 'The ranges could not be measured. Spec defaults are shown; use the font file for exact values.' : ''
  $('axes-help').hidden = !help; $('axes-help').textContent = help
  $('file-notice').hidden = !selection?.fileError; $('file-notice').textContent = selection?.fileError || ''
  const fileOpen = !$('file-panel').hidden || source === 'file' || source === 'fallback' || !!selection?.fileError
  $('file-panel').hidden = !fileOpen
  $('show-file').hidden = fileOpen
  $('show-file').setAttribute('aria-expanded', String(fileOpen))
}
function curveOf(sh: Shape): Bezier { return sh.bezier || CURVE_BEZIER[sh.curve] }
function parseBezier(value: unknown): Bezier | null {
  const parts = typeof value === 'string' ? value.split(',').map(Number) : null
  return parts && parts.length === 4 && parts.every(Number.isFinite) ? parts as Bezier : null
}
function sameBezier(a: Bezier | null, b: Bezier): boolean { return !!a && a.every((v, i) => Math.abs(v - b[i]) < 0.005) }
function linkedTags(): string[] { return enabledTags().filter(t => !settings.axes[t].shape) }
/** Name of the shared progression, spelled out by the axes that follow it. */
function sharedLabel(): string {
  const names = linkedTags().map(axisName)
  if (names.length <= 2) return names.join(' + ')
  return `${names[0]}, ${names[1]} +${names.length - 2}`
}
function renderTargets(): void {
  const t = validTarget(), detached = detachedTags(), linked = linkedTags()
  const box = $('targets')
  box.hidden = detached.length === 0
  // A shared group with one member is just that axis; with several it gets a link icon.
  const options: { tag: string | null; label: string; group: boolean; title: string }[] = [
    ...(linked.length ? [{ tag: null, label: sharedLabel(), group: linked.length > 1, title: linked.length > 1 ? `Linked axes share one progression: ${linked.map(axisName).join(', ')}` : `Edit the progression of ${axisName(linked[0])}` }] : []),
    ...detached.map(tag => ({ tag, label: axisName(tag), group: false, title: `Edit the progression of ${axisName(tag)}` })),
  ]
  const key = JSON.stringify(options) + '|' + t + '|' + busy
  if (box.dataset.key === key) return
  box.dataset.key = key
  box.replaceChildren(...options.map(o => {
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'chip' + (o.group ? ' group' : ''); b.disabled = busy
    if (o.group) b.insertAdjacentHTML('beforeend', ICON_LINK)
    const text = document.createElement('span'); text.textContent = o.label
    b.append(text)
    b.setAttribute('aria-pressed', String(o.tag === t))
    b.title = o.title
    b.addEventListener('click', () => { target = o.tag; update() })
    return b
  }))
}
function renderShape(): void {
  const sh = editedShape()
  for (const [id, value] of [['position', Math.round(sh.position * 100)], ['falloff', Math.round(sh.falloff * 100)], ['mode', settings.mode]] as const) {
    const el = $(id)
    if (!el.contains(document.activeElement) && readControl(el) !== String(value)) setControl(el, value)
    el.toggleAttribute('disabled', busy)
  }
  const curve = $('curve'), bezier = curveOf(sh)
  if (!curve.contains(document.activeElement) && !sameBezier(parseBezier(readControl(curve)), bezier)) setControl(curve, bezier.join(', '))
  curve.toggleAttribute('disabled', busy)
  const ramp = isRamp(sh)
  $('direction').textContent = ramp === 'reverse' ? 'End → Start' : 'Start → End'
  $('direction').title = ramp === 'forward' ? 'Reverse: ramp from the last to the first letter' : ramp === 'reverse' ? 'Reverse: ramp from the first to the last letter' : 'Ramp from the first to the last letter'
  $('direction').toggleAttribute('selected', !!ramp)
  const t = validTarget()
  const unit = settings.mode === 'word' ? 'word' : 'text'
  const text = ramp === 'forward' ? 'edge value at the first letter, peak value at the last.'
    : ramp === 'reverse' ? 'peak value at the first letter, edge value at the last.'
    : `peak at ${Math.round(sh.position * 100)}%, fading over ${Math.round(sh.falloff * 100)}% of the ${unit}.`
  const who = t ? axisName(t) : detachedTags().length ? sharedLabel() : ''
  $('shape-help').textContent = who ? `${who}: ${text}` : text[0].toUpperCase() + text.slice(1)
}
function renderPreview(gs: Glyph[][], valid: boolean): void {
  const bars = $('bars'), group = gs[0] || []
  const show = !!selection && !selection.error && group.length > 0 && !!adjustable().length
  bars.hidden = !show
  $('preview-empty').hidden = show
  $('preview-empty').textContent = !selection || !selection.characters ? 'Select text to see the progression.' : selection.error ? 'Nothing to preview.' : 'Waiting for the axis ranges…'
  if (!show) { bars.replaceChildren(); renderValues([], false); return }
  const n = group.length, visible = group.slice(0, PREVIEW_LIMIT)
  const shape = editedShape()
  const s = strengths(n, shape)
  const peakIndex = n === 1 ? 0 : Math.round(shape.position * (n - 1))
  const nodes: HTMLElement[] = visible.map((g, i) => {
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'bar' + (i === peakIndex ? ' peak' : '')
    const letter = selection!.characters.slice(g.start, g.end)
    b.title = `${letter}: ${Math.round(s[i] * 100)}% · click to set the peak here`
    b.setAttribute('aria-label', `${letter}, ${Math.round(s[i] * 100)} percent. Set peak here.`)
    const fill = document.createElement('i'); fill.style.height = Math.max(2, s[i] * 40) + 'px'
    const label = document.createElement('span'); label.textContent = letter
    b.append(fill, label)
    b.disabled = busy
    b.addEventListener('click', () => { editedShape().position = n === 1 ? 1 : i / (n - 1); update() })
    return b
  })
  if (n > PREVIEW_LIMIT) { const more = document.createElement('span'); more.className = 'bars-more'; more.textContent = `+${n - PREVIEW_LIMIT}`; nodes.push(more) }
  bars.replaceChildren(...nodes)
  renderValues(group, valid)
}
function renderValues(group: Glyph[], valid: boolean): void {
  const box = $('values-table'), toggle = $('toggle-values')
  const tags = enabledTags()
  const available = valid && tags.length > 0 && group.length > 0
  toggle.hidden = !available
  toggle.textContent = showValues ? 'Hide values' : 'Show values'
  toggle.setAttribute('aria-expanded', String(showValues && available))
  box.hidden = !(showValues && available)
  if (box.hidden) { box.replaceChildren(); return }
  const values = computeValues(group.length, payload())
  const peakIndex = group.length === 1 ? 0 : Math.round(editedShape().position * (group.length - 1))
  const table = document.createElement('table')
  const head = table.createTHead().insertRow()
  for (const label of ['Letter', ...tags.map(axisName)]) { const th = document.createElement('th'); th.textContent = label; head.append(th) }
  const body = table.createTBody()
  group.forEach((g, i) => {
    const row = body.insertRow()
    if (i === peakIndex) row.className = 'peak'
    row.insertCell().textContent = selection!.characters.slice(g.start, g.end)
    for (const t of tags) row.insertCell().textContent = fmt(values[i][t])
  })
  box.replaceChildren(table)
}
function message(text: string, error = false): void { $('status').textContent = text; $('status').classList.toggle('error', error) }

function update(): void {
  const gs = groups(), count = gs.reduce((n, g) => n + g.length, 0)
  const problem = validation()
  const valid = !problem && enabledTags().length > 0
  renderAxes()
  renderDetection()
  renderTargets()
  renderShape()
  renderPreview(gs, valid)
  $('validation').hidden = !problem; $('validation').textContent = problem
  $('apply').toggleAttribute('disabled', busy || uploading || !selection || !!selection.error || !!selection.detecting || !valid || count === 0 || count > 10000 || !segmenter)
  $('restore').toggleAttribute('disabled', busy || !selection?.canRestore)
  for (const id of ['fontFile', 'direction']) $(id).toggleAttribute('disabled', busy)
  $('apply').textContent = busy && activeAction === 'apply' ? 'Applying…' : 'Apply'
  $('restore').textContent = busy && activeAction === 'restore' ? 'Restoring…' : 'Restore'
  if (selection) {
    $('selection').textContent = selection.error || (selection.family ? selection.family + ' · ' + count.toLocaleString('en') + (count === 1 ? ' letter' : ' letters') : 'Select one text layer')
    $('selection').classList.toggle('error', !!selection.error)
  }
  if (!segmenter) message('Update Figma to enable reliable letter-by-letter text processing.', true)
}

// ---------- events ----------
$('position').addEventListener('input', e => { const v = Number(readControl(e.currentTarget as Control)); if (Number.isFinite(v)) { editedShape().position = Math.max(0, Math.min(1, v / 100)); update() } })
$('falloff').addEventListener('input', e => { const v = Number(readControl(e.currentTarget as Control)); if (Number.isFinite(v)) { editedShape().falloff = Math.max(0.01, Math.min(1, v / 100)); update() } })
const onCurve = (e: Event) => {
  const detail = (e as CustomEvent).detail
  const b = parseBezier(detail?.value ?? readControl(e.currentTarget as Control))
  if (b) { editedShape().bezier = b; update() }
}
$('curve').addEventListener('input', onCurve)
$('curve').addEventListener('change', onCurve)
$('toggle-values').addEventListener('click', () => { showValues = !showValues; update() })
$('mode').addEventListener('change', e => { settings.mode = readControl(e.currentTarget as Control) === 'word' ? 'word' : 'text'; update() })
// Toggle: Start → End ↔ End → Start; from any other shape it starts a Start → End ramp.
$('direction').addEventListener('click', () => {
  const sh = editedShape()
  const position = isRamp(sh) === 'forward' ? 0 : 1
  delete sh.bezier
  Object.assign(sh, DEFAULT_SHAPE, { position })
  update()
})
$('show-file').addEventListener('click', () => { $('file-panel').hidden = false; update() })
$('fontFile').addEventListener('change', async event => {
  const version = ++uploadVersion
  const file: File | undefined = (event as CustomEvent).detail?.files?.[0] || ($('fontFile') as unknown as { files?: FileList }).files?.[0]
  uploading = !!file; update()
  if (!file) { send({ type: 'file' }); return }
  if (file.size > 20 * 1024 * 1024) { uploading = false; send({ type: 'file' }); message('Choose a font file smaller than 20 MB.', true); update(); return }
  try {
    message('Reading the font file…')
    const buffer = await Promise.race([file.arrayBuffer(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))])
    if (version !== uploadVersion) return
    send({ type: 'file', bytes: Array.from(new Uint8Array(buffer)) })
  } catch { if (version === uploadVersion) { uploading = false; send({ type: 'file' }); message('Could not read this font file. Try another file.', true); update() } }
})
$('apply').addEventListener('click', () => {
  if ($('apply').hasAttribute('disabled') || !selection) return
  activeAction = 'apply'; busy = true; message('Applying…')
  send({ type: 'apply', id: selection.id, characters: selection.characters, settings: payload(), groups: groups() }); update()
})
$('restore').addEventListener('click', () => {
  if ($('restore').hasAttribute('disabled')) return
  activeAction = 'restore'; busy = true; message('Restoring the original font settings…'); send({ type: 'restore' }); update()
})
window.addEventListener('message', event => {
  const msg = event.data?.pluginMessage
  if (!msg) return
  if (msg.type === 'selection') {
    connected = true; uploading = false
    const newLayer = lastId !== msg.id
    // Same layer, different font: the axes no longer match, so start over with this font's
    // axes but keep the progression the user has dialled in.
    const newFont = !newLayer && !!msg.family && !!lastFamily && lastFamily !== msg.family
    selection = msg as Selection; lastId = msg.id; lastFamily = msg.family || lastFamily
    if (newLayer) {
      target = null; editingRange = null
      settings = msg.settings ? JSON.parse(JSON.stringify(msg.settings)) : { version: 2, axes: {}, shape: { ...DEFAULT_SHAPE }, mode: settings.mode }
      message('')
    } else if (newFont) {
      target = null; editingRange = null
      settings = { version: 2, axes: {}, shape: settings.shape, mode: settings.mode }
      message('Font changed to ' + msg.family + '. Axes reloaded.')
    }
    reconcile()
    update()
  } else if (msg.type === 'detect-progress') {
    if (selection && selection.family === msg.family) { selection.detecting = true; selection.progress = { done: msg.done, total: msg.total, tag: msg.tag }; renderDetection() }
  } else if (msg.type === 'status') message(msg.text, msg.error)
  else if (msg.type === 'busy') { busy = msg.busy; update() }
})
let lastHeight = 0
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
  const height = Math.ceil($('plugin-root').getBoundingClientRect().height)
  if (height !== lastHeight) { lastHeight = height; send({ type: 'resize', height }) }
}).observe($('plugin-root'))
// Start independently of component registration: one missing control must never block selection detection.
send({ type: 'ready' })
update()
for (const delay of [100, 500, 1500, 4000]) setTimeout(() => { if (!connected) send({ type: 'ready' }) }, delay)
setTimeout(() => { if (!connected) message('Could not connect to the selected text. Close and reopen the plugin to try again.', true) }, 6000)
for (const tag of ['fig-input-number', 'fig-dropdown', 'fig-input-file', 'fig-button', 'fig-slider', 'fig-switch', 'fig-easing-curve']) customElements.whenDefined(tag).then(() => update())
window.addEventListener('error', () => { message('Some controls could not load. Close and reopen the plugin to try again.', true) })
