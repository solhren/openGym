import { beforeEach, test, expect, vi } from 'vitest'
const plugin=vi.hoisted(()=>({isSupported:vi.fn(),checkPermissions:vi.fn(),requestPermissions:vi.fn(),isGoogleBarcodeScannerModuleAvailable:vi.fn(),installGoogleBarcodeScannerModule:vi.fn(),scan:vi.fn()}))
vi.mock('./mobile.js',()=>({MOBILE:true}))
vi.mock('@capacitor-mlkit/barcode-scanning',()=>({BarcodeScanner:plugin}))
import {scanCode} from './scan.js'
beforeEach(()=>{
 vi.clearAllMocks();plugin.isSupported.mockResolvedValue({supported:true});plugin.checkPermissions.mockResolvedValue({camera:'granted'});plugin.requestPermissions.mockResolvedValue({camera:'granted'});plugin.isGoogleBarcodeScannerModuleAvailable.mockResolvedValue({available:true});plugin.scan.mockResolvedValue({barcodes:[{rawValue:'0034000470693',format:'EAN_13'}]})
})
test('native product scanner preserves zeros, requests EAN/UPC formats and opens no camera until invoked',async()=>{
 expect(plugin.checkPermissions).not.toHaveBeenCalled();expect(await scanCode({product:true})).toEqual({value:'0034000470693',fmt:'ean13'})
 expect(plugin.scan).toHaveBeenCalledWith({formats:['EAN_13','EAN_8','UPC_A','UPC_E']});expect(plugin.requestPermissions).not.toHaveBeenCalled()
})
test('permission prompt is just-in-time and refusal never starts a scan',async()=>{
 plugin.checkPermissions.mockResolvedValue({camera:'prompt'});await scanCode();expect(plugin.requestPermissions).toHaveBeenCalledOnce()
 plugin.requestPermissions.mockResolvedValue({camera:'denied'});plugin.scan.mockClear();await expect(scanCode()).rejects.toThrow('permission-denied');expect(plugin.scan).not.toHaveBeenCalled()
})
test('cancel is a null result; other scanner failures remain errors and release the lock',async()=>{
 plugin.scan.mockRejectedValueOnce(new Error('scan canceled.'));expect(await scanCode()).toBeNull()
 plugin.scan.mockRejectedValueOnce(new Error('camera hardware failed'));await expect(scanCode()).rejects.toThrow('camera hardware failed');expect((await scanCode()).value).toBe('0034000470693')
})
test('unsupported scanner does not prompt; concurrent calls cannot launch two native UIs',async()=>{
 plugin.isSupported.mockResolvedValueOnce({supported:false});await expect(scanCode()).rejects.toThrow('unsupported');expect(plugin.checkPermissions).not.toHaveBeenCalled()
 let release;plugin.scan.mockImplementationOnce(()=>new Promise(r=>release=r));const first=scanCode();while(!release)await new Promise(r=>setTimeout(r,0));await expect(scanCode()).rejects.toThrow('scan-in-progress');release({barcodes:[]});expect(await first).toBeNull()
})
