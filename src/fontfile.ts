import { AxisRange, axisName } from './axes'

export type FontMeta = { families: string[]; axes: AxisRange[] }

// Read the sfnt fvar and name tables locally, without installing or persisting the font.
export function parseFont(bytes: number[]): FontMeta {
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

  const n = view.getUint16(name.offset + 2), strings = name.offset + view.getUint16(name.offset + 4)
  if (name.offset + 6 + n * 12 > name.offset + name.length) throw new Error('The font name table is invalid.')
  // nameID → best string (prefer Windows/Unicode English, then anything readable).
  const names = new Map<number, { value: string; score: number }>()
  for (let i = 0; i < n; i++) {
    const p = name.offset + 6 + i * 12, platform = view.getUint16(p), language = view.getUint16(p + 4), id = view.getUint16(p + 6)
    const length = view.getUint16(p + 8), start = strings + view.getUint16(p + 10)
    if (start + length > name.offset + name.length || start < name.offset) continue
    let value = ''
    if (platform === 0 || platform === 3) {
      for (let j = 0; j + 1 < length; j += 2) value += String.fromCharCode(view.getUint16(start + j))
    } else if (platform === 1) {
      for (let j = 0; j < length; j++) value += String.fromCharCode(view.getUint8(start + j))
    } else continue
    value = value.trim()
    if (!value) continue
    const score = (platform === 3 && language === 0x409) || platform === 0 ? 2 : 1
    if ((names.get(id)?.score || 0) < score) names.set(id, { value, score })
  }
  const families: string[] = []
  for (let i = 0; i < n; i++) {
    const p = name.offset + 6 + i * 12, id = view.getUint16(p + 6)
    if (id !== 1 && id !== 16) continue
    const platform = view.getUint16(p), length = view.getUint16(p + 8), start = strings + view.getUint16(p + 10)
    if (start + length > name.offset + name.length || start < name.offset) continue
    let value = ''
    if (platform === 0 || platform === 3) for (let j = 0; j + 1 < length; j += 2) value += String.fromCharCode(view.getUint16(start + j))
    else if (platform === 1) for (let j = 0; j < length; j++) value += String.fromCharCode(view.getUint8(start + j))
    if (value.trim()) families.push(value.trim())
  }
  if (!families.length) throw new Error('No supported font family name was found in the file.')

  const axisStart = fvar.offset + view.getUint16(fvar.offset + 4)
  const axisCount = view.getUint16(fvar.offset + 8), axisSize = view.getUint16(fvar.offset + 10)
  if (axisSize < 20 || axisStart + axisCount * axisSize > fvar.offset + fvar.length) throw new Error('The variable font axes are invalid.')
  const axes: AxisRange[] = []
  for (let i = 0; i < axisCount; i++) {
    const p = axisStart + i * axisSize, axisTag = tag(p)
    const min = view.getInt32(p + 4) / 65536, defaultValue = view.getInt32(p + 8) / 65536, max = view.getInt32(p + 12) / 65536
    const flags = view.getUint16(p + 16), nameId = view.getUint16(p + 18)
    if (flags & 1) continue // hidden axis
    if (!(min <= defaultValue && defaultValue <= max)) throw new Error(`The ${axisTag} axis has an invalid range.`)
    axes.push({ tag: axisTag, name: names.get(nameId)?.value || axisName(axisTag), min, max, defaultValue, source: 'file' })
  }
  if (!axes.length) throw new Error('The font file has no visible variation axes.')
  return { families: [...new Set(families)], axes }
}
