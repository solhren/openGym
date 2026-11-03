import { CatalogError } from './normalize.js'
const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e']
/** Browser QR fallback cannot decode EAN. Check capability before camera permission;
 * unsupported browsers keep manual entry available. Frames never leave the device. */
export async function productDecoder() {
  const Detector = globalThis.BarcodeDetector
  if (!Detector?.getSupportedFormats) throw new CatalogError('camera-unavailable')
  const supported = (await Detector.getSupportedFormats()).filter(f => formats.includes(f))
  if (!supported.length) throw new CatalogError('camera-unavailable')
  const detector = new Detector({ formats: supported })
  return async source => {
    const values = await detector.detect(source)
    const found = values.find(v => supported.includes(v.format) && /^\d{8}$|^\d{12,14}$/.test(v.rawValue))
    return found ? { value: found.rawValue, fmt: found.format } : null
  }
}

/** UPC-E encodes a compressed UPC-A. Format information is essential: an EAN-8
 * string must never be expanded just because it has eight digits. */
export function scannedBarcode({ value, fmt }) {
  if (String(fmt).replace(/[^a-z0-9]/gi, '').toLowerCase() !== 'upce') return value
  if (typeof value !== 'string' || !/^[01]\d{7}$/.test(value)) throw new CatalogError('invalid-barcode')
  const [system, a, b, c, d, e, last, check] = value
  const body = last <= '2' ? `${a}${b}${last}0000${c}${d}${e}` : last === '3' ? `${a}${b}${c}00000${d}${e}` : last === '4' ? `${a}${b}${c}${d}00000${e}` : `${a}${b}${c}${d}${e}0000${last}`
  return `${system}${body}${check}`
}
