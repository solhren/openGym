import { CatalogError, fail, inspectExternal } from './normalize.js'

// Installation-wide: switching sessions cannot accumulate abandoned bridge sockets.
let outstanding = 0
const abortError = () => new DOMException('Aborted','AbortError')
/** Paired mobile public catalogue only. No bearer token, cookie, user data or
 * arbitrary upstream URL. Native sockets cannot be cancelled; their late results
 * are ignored and at most two may be outstanding until bounded bridge timeouts. */
export function createPublicCatalogRelay(origin, { loadNative = () => import('@capacitor/core'), webFetch = (...args) => fetch(...args) } = {}) {
  const base = new URL(origin)
  fail(base.origin === origin && !base.username && !base.password && ['https:','http:'].includes(base.protocol), 'invalid-query')
  const get = async (path, {signal} = {}) => {
    fail(typeof path==='string' && path.length<=2048 && /^\/api\/nutrition\/catalog\/(?:capabilities|search|product)(?:\?[^#]*)?$/.test(path),'invalid-query')
    const local=new URL(path,base.origin),kind=local.pathname.split('/').at(-1)
    const allowed=kind==='capabilities'?[]:kind==='search'?['q','page','lc','staging','local']:['id','code','lc','staging']
    fail([...local.searchParams.keys()].every(k=>allowed.includes(k)&&local.searchParams.getAll(k).length===1),'invalid-query')
    if(signal?.aborted) throw abortError()
    const {Capacitor,CapacitorHttp} = await loadNative()
    if(signal?.aborted) throw abortError()
    if(!Capacitor.isNativePlatform()) return webFetch(base.origin+path,{signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json'}}).then(response=>({catalogRelay:true,status:response.status,headers:response.headers,body:response.body,text:()=>response.text()}))
    fail(outstanding < 2,'request-in-progress'); outstanding++
    const pending = Promise.resolve().then(()=>{ if(signal?.aborted)throw abortError();return CapacitorHttp.get({url:base.origin+path,headers:{Accept:'application/json'},responseType:'text',readTimeout:15000,connectTimeout:10000,disableRedirects:true})})
    pending.then(()=>outstanding--,()=>outstanding--)
    let listener
    const cancelled=new Promise((_,reject)=>{listener=()=>reject(abortError());signal?.addEventListener('abort',listener,{once:true});if(signal?.aborted)listener()})
    try{
      const response=await Promise.race([pending,cancelled]);if(signal?.aborted)throw abortError()
      let data=''
      if(response.status===200){
        if(typeof response.data==='string') data=response.data
        else {
          inspectExternal(response.data); let bytes=0; const encoder=new TextEncoder()
          data=JSON.stringify(response.data,(key,value)=>{
            bytes+=encoder.encode(JSON.stringify(key)).length+(typeof value==='string'?encoder.encode(JSON.stringify(value)).length:24)+2
            fail(bytes<=1024*1024,'response-too-large');return value
          })
        }
        fail(typeof data==='string' && new TextEncoder().encode(data).length<=1024*1024,'response-too-large')
      } else {
        // Only known safe error code; no native error-page content is echoed.
        if(response.status===503)data='{"code":"catalog-local-unavailable"}'
        else if(response.status===429)data='{"code":"catalog-client-rate-limited"}'
        else if(response.status===409){
          // Keep the actionable local conflict on Android/iOS too. Native error
          // pages remain untrusted: inspect only a bounded own data property,
          // never serialize/echo arbitrary error objects or invoke a getter.
          let value=response.data
          if(typeof value==='string'){
            try{value=value.length<=1024?JSON.parse(value):null}catch{value=null}
          }
          const descriptor=value&&typeof value==='object'?Object.getOwnPropertyDescriptor(value,'code'):null
          data=JSON.stringify({code:descriptor?.value==='catalog-ambiguous-barcode'?'catalog-ambiguous-barcode':'catalog-request-cancelled'})
        }
      }
      return {catalogRelay:true,status:response.status,headers:{get:key=>Object.entries(response.headers??{}).find(([name])=>name.toLowerCase()===key.toLowerCase())?.[1]??null},text:async()=>data}
    }catch(error){if(error instanceof CatalogError||error.name==='AbortError')throw error;throw new CatalogError('network-error')}
    finally{signal?.removeEventListener('abort',listener)}
  }
  return {
    localRequest:(path,options)=>get(path,options),
    capabilities:(_,options)=>get('/api/nutrition/catalog/capabilities',options),
    transport(url,options){
      const target=new URL(url)
      fail(target.origin==='https://world.openfoodfacts.org' && !target.username && !target.password,'invalid-query')
      const product=/^\/api\/v3\/product\/\d{8,14}$/.test(target.pathname)
      fail(product||target.pathname==='/cgi/search.pl','invalid-query')
      const params=new URLSearchParams({lc:target.searchParams.get('lc')||'fr',staging:'0'})
      if(product)params.set('code',target.pathname.split('/').at(-1))
      else{params.set('q',target.searchParams.get('search_terms')||'');params.set('page',target.searchParams.get('page')||'1');if(options?.localOnly)params.set('local','1')}
      return get(`/api/nutrition/catalog/${product?'product':'search'}?${params}`,options)
    },
  }
}
