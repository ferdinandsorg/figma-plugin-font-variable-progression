import type { AxisRange } from '../axes'
import { AxisSetting, Curve, DEFAULT_SHAPE, Settings, computeValues, strengths } from '../engine'

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

let selection: Selection | null = null
let settings: Settings = { version: 2, axes: {}, shape: { ...DEFAULT_SHAPE }, mode: 'text' }
let busy = false, uploading = false, uploadVersion = 0, connected = false
let lastId: string | undefined
let activeAction: 'apply' | 'restore' = 'apply'
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
    row.classList.toggle('on', s.enabled)
    setChecked(row.querySelector<Control>('fig-switch')!, s.enabled)
    row.querySelector<HTMLElement>('.axis-values')!.hidden = !s.enabled
    const [base, peak] = row.querySelectorAll<Control>('fig-input-number')
    if (document.activeElement !== base && !base.contains(document.activeElement)) setControl(base, s.base)
    if (document.activeElement !== peak && !peak.contains(document.activeElement)) setControl(peak, s.peak)
    for (const el of [row.querySelector<Control>('fig-switch')!, base, peak]) el.toggleAttribute('disabled', busy)
  }
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
  title.append(name, tag)
  const range = document.createElement('span'); range.className = 'range'
  if (unavailable) {
    range.textContent = a.tag === 'opsz' ? 'Auto · font size' : 'Not adjustable'
    range.title = a.tag === 'opsz' ? 'Figma sets the optical size automatically from the font size.' : 'Changing this axis has no visible effect in Figma.'
    const spacer = document.createElement('span'); spacer.className = 'axis-switch-spacer'
    head.append(spacer, title, range)
    row.append(head)
    return row
  }
  range.textContent = fmt(a.min) + '–' + fmt(a.max)
  range.title = (a.source === 'registered' ? 'Assumed from the OpenType spec · ' : '') + 'Default ' + fmt(a.defaultValue)
  const toggle = document.createElement('fig-switch') as Control
  toggle.setAttribute('aria-label', 'Use ' + a.name)
  const onToggle = (e: Event) => { const s = settings.axes[a.tag]; if (s) { s.enabled = eventChecked(e); update() } }
  toggle.addEventListener('change', onToggle)
  head.append(toggle, title, range)
  const values = document.createElement('div'); values.className = 'axis-values'; values.hidden = true
  for (const key of ['base', 'peak'] as const) {
    const wrap = document.createElement('div')
    const label = document.createElement('label'); label.textContent = key === 'base' ? 'Edge' : 'Peak'
    const input = document.createElement('fig-input-number') as Control
    for (const [k, v] of Object.entries({ min: a.min, max: a.max, step: a.max - a.min <= 2 ? 0.01 : 1, precision: 2, value: settings.axes[a.tag]?.[key] ?? a.defaultValue })) input.setAttribute(k, String(v))
    input.setAttribute('full', '')
    input.setAttribute('aria-label', `${a.name} ${key === 'base' ? 'edge' : 'peak'} value`)
    const onValue = () => {
      const v = Number(readControl(input)), s = settings.axes[a.tag]
      if (s && readControl(input) !== '' && Number.isFinite(v)) { s[key] = v; update() }
    }
    input.addEventListener('input', onValue)
    input.addEventListener('change', onValue)
    wrap.append(label, input); values.append(wrap)
  }
  row.append(head, values)
  return row
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
function renderShape(): void {
  const sh = settings.shape
  for (const [id, value] of [['position', Math.round(sh.position * 100)], ['falloff', Math.round(sh.falloff * 100)], ['curve', sh.curve], ['mode', settings.mode]] as const) {
    const el = $(id)
    if (!el.contains(document.activeElement) && readControl(el) !== String(value)) setControl(el, value)
    el.toggleAttribute('disabled', busy)
  }
  const ramp = sh.position === 1 && sh.falloff === 1 && sh.curve === 'linear'
  $('shape-help').textContent = ramp
    ? 'Edge value at the first letter, peak value at the last.'
    : `Peak at ${Math.round(sh.position * 100)}%, fading over ${Math.round(sh.falloff * 100)}% of the ${settings.mode === 'word' ? 'word' : 'text'}.`
}
function renderPreview(gs: Glyph[][], valid: boolean): void {
  const bars = $('bars'), group = gs[0] || []
  const show = !!selection && !selection.error && group.length > 0 && !!adjustable().length
  bars.hidden = !show
  $('preview-empty').hidden = show
  $('preview-empty').textContent = !selection || !selection.characters ? 'Select text to see the progression.' : selection.error ? 'Nothing to preview.' : 'Waiting for the axis ranges…'
  if (!show) { bars.replaceChildren(); $('preview-values').textContent = ''; return }
  const n = group.length, visible = group.slice(0, PREVIEW_LIMIT)
  const s = strengths(n, settings.shape)
  const peakIndex = n === 1 ? 0 : Math.round(settings.shape.position * (n - 1))
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
    b.addEventListener('click', () => { settings.shape.position = n === 1 ? 1 : i / (n - 1); update() })
    return b
  })
  if (n > PREVIEW_LIMIT) { const more = document.createElement('span'); more.className = 'bars-more'; more.textContent = `+${n - PREVIEW_LIMIT}`; nodes.push(more) }
  bars.replaceChildren(...nodes)
  const tags = enabledTags()
  if (valid && tags.length) {
    const values = computeValues(n, payload())
    const first = tags[0], name = adjustable().find(a => a.tag === first)?.name || first
    $('preview-values').textContent = name + ': ' + visible.slice(0, 8).map((g, i) => selection!.characters.slice(g.start, g.end) + ' ' + fmt(values[i][first])).join(' · ') + (n > 8 ? ' · …' : '') + (tags.length > 1 ? ` (+${tags.length - 1} more ${tags.length === 2 ? 'axis' : 'axes'})` : '')
  } else $('preview-values').textContent = ''
}
function message(text: string, error = false): void { $('status').textContent = text; $('status').classList.toggle('error', error) }

function update(): void {
  const gs = groups(), count = gs.reduce((n, g) => n + g.length, 0)
  const problem = validation()
  const valid = !problem && enabledTags().length > 0
  renderAxes()
  renderDetection()
  renderShape()
  renderPreview(gs, valid)
  $('validation').hidden = !problem; $('validation').textContent = problem
  $('apply').toggleAttribute('disabled', busy || uploading || !selection || !!selection.error || !!selection.detecting || !valid || count === 0 || count > 10000 || !segmenter)
  $('restore').toggleAttribute('disabled', busy || !selection?.canRestore)
  for (const id of ['fontFile', 'ramp']) $(id).toggleAttribute('disabled', busy)
  $('apply').textContent = busy && activeAction === 'apply' ? 'Applying…' : 'Apply'
  $('restore').textContent = busy && activeAction === 'restore' ? 'Restoring…' : 'Restore'
  $('step-count').textContent = count ? count.toLocaleString('en') + (count === 1 ? ' letter' : ' letters') : ''
  if (selection) {
    $('selection').textContent = selection.error || (selection.family ? selection.family + ' · ' + count.toLocaleString('en') + (count === 1 ? ' letter' : ' letters') : 'Select one text layer to get started.')
    $('selection').classList.toggle('error', !!selection.error)
  }
  if (!segmenter) message('Update Figma to enable reliable letter-by-letter text processing.', true)
}

// ---------- events ----------
$('position').addEventListener('input', e => { const v = Number(readControl(e.currentTarget as Control)); if (Number.isFinite(v)) { settings.shape.position = Math.max(0, Math.min(1, v / 100)); update() } })
$('falloff').addEventListener('input', e => { const v = Number(readControl(e.currentTarget as Control)); if (Number.isFinite(v)) { settings.shape.falloff = Math.max(0.01, Math.min(1, v / 100)); update() } })
$('curve').addEventListener('change', e => { settings.shape.curve = readControl(e.currentTarget as Control) as Curve; update() })
$('mode').addEventListener('change', e => { settings.mode = readControl(e.currentTarget as Control) === 'word' ? 'word' : 'text'; update() })
$('ramp').addEventListener('click', () => { settings.shape = { ...DEFAULT_SHAPE }; update() })
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
    const changed = lastId !== msg.id
    selection = msg as Selection; lastId = msg.id
    if (changed) {
      settings = msg.settings ? JSON.parse(JSON.stringify(msg.settings)) : { version: 2, axes: {}, shape: { ...DEFAULT_SHAPE }, mode: settings.mode }
      message('')
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
for (const tag of ['fig-input-number', 'fig-dropdown', 'fig-input-file', 'fig-button', 'fig-slider', 'fig-switch']) customElements.whenDefined(tag).then(() => update())
window.addEventListener('error', () => { message('Some controls could not load. Close and reopen the plugin to try again.', true) })
