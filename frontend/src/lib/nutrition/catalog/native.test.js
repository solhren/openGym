import { test, expect, vi, beforeEach } from 'vitest'
vi.mock('../../mobile.js', () => ({ MOBILE: true }))
const scanner = vi.hoisted(() => ({ isSupported: vi.fn(async () => ({ supported: true })), checkPermissions: vi.fn(async () => ({ camera: 'granted' })), requestPermissions: vi.fn(async () => ({ camera: 'granted' })), scan: vi.fn(async () => ({ barcodes: [{ rawValue: '0034000470693', format: 'EAN_13' }] })) }))
vi.mock('@capacitor-mlkit/barcode-scanning', () => ({ BarcodeScanner: scanner }))
import { scanCode } from '../../scan.js'
beforeEach(() => vi.clearAllMocks())
test('native Nutrition scan restricts EAN/UPC, reuses permission handling and preserves zeros', async () => {
  expect(await scanCode({ product: true })).toEqual({ value: '0034000470693', fmt: 'ean13' })
  expect(scanner.scan).toHaveBeenCalledWith({ formats: ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E'] }); expect(scanner.requestPermissions).not.toHaveBeenCalled()
})
test('existing native gym scanner keeps unrestricted default behavior', async () => { await scanCode(); expect(scanner.scan).toHaveBeenCalledWith(undefined) })
test('denied permission never starts scanner', async () => {
  scanner.checkPermissions.mockResolvedValueOnce({ camera: 'denied' }); scanner.requestPermissions.mockResolvedValueOnce({ camera: 'denied' })
  await expect(scanCode({ product: true })).rejects.toThrow('permission-denied'); expect(scanner.scan).not.toHaveBeenCalled()
})
test('native scanner cancellation returns no invented barcode', async () => { scanner.scan.mockResolvedValueOnce({ barcodes: [] }); expect(await scanCode({ product: true })).toBeNull() })
