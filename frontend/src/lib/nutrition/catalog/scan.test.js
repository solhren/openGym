import { afterEach, test, expect, vi } from 'vitest'
import { productDecoder } from './scan.js'
afterEach(() => vi.unstubAllGlobals())
test('unsupported detector cannot open a camera and has no QR substitution', async () => {
  vi.stubGlobal('BarcodeDetector', undefined); await expect(productDecoder()).rejects.toMatchObject({ code: 'camera-unavailable' })
  vi.stubGlobal('BarcodeDetector', { getSupportedFormats: async () => ['qr_code'] }); await expect(productDecoder()).rejects.toThrow()
})
test('EAN/UPC-only detector preserves zeros and ignores QR/unexpected content', async () => {
  const detect = vi.fn(async () => [{ rawValue: 'https://evil.test', format: 'qr_code' }, { rawValue: '0034000470693', format: 'ean_13' }])
  const Detector = vi.fn(function () { this.detect = detect }); Detector.getSupportedFormats = async () => ['qr_code', 'ean_13', 'upc_a']; vi.stubGlobal('BarcodeDetector', Detector)
  const decode = await productDecoder(); expect(Detector).toHaveBeenCalledWith({ formats: ['ean_13', 'upc_a'] }); expect(await decode('local-frame')).toEqual({ value: '0034000470693', fmt: 'ean_13' })
  detect.mockResolvedValue([{ rawValue: 'bad', format: 'ean_13' }]); expect(await decode('local-frame')).toBeNull()
})

test.each([['04252614', '042100005264'], ['01234531', '012300000451'], ['01234541', '012340000051'], ['01234561', '012345000061']])('UPC-E %s expands only with explicit scanner format', async (value, expected) => {
  const { scannedBarcode } = await import('./scan.js'); expect(scannedBarcode({ value, fmt: 'UPC_E' })).toBe(expected); expect(scannedBarcode({ value, fmt: 'ean_8' })).toBe(value)
})
