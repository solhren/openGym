// Public catalogue lookup identity is separate from a versioned snapshot Food ID.
export const isWgerId = v => typeof v === 'string' && /^wger:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v)
export const isCiqualId = v => typeof v === 'string' && /^ciqual:\d{1,8}$/.test(v)
export const isLocalCatalogId = v => isWgerId(v) || isCiqualId(v) || typeof v === 'string' && /^off:(?:\d{14}|exact:(?:\d{8}|\d{12,14}))$/.test(v)
export function catalogBarcodeKey(code) {
  if(typeof code!=='string'||!/^(?:\d{8}|\d{12,14})$/.test(code)||/^0+$/.test(code))return null
  const valid=[...code.slice(0,-1)].reverse().reduce((s,d,i)=>s+Number(d)*(i%2?1:3),0)%10===(10-Number(code.at(-1)))%10
  return valid?code.padStart(14,'0'):'exact:'+code
}
export const sameCatalogBarcode = (a,b) => a===b || catalogBarcodeKey(a)!==null&&catalogBarcodeKey(a)===catalogBarcodeKey(b)
