// Portable Docker/host smoke: no network, no writes, actual reader lifecycle.
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {CatalogWorker} from './worker-client.mjs'
const worker=new CatalogWorker(process.argv[2]||'trial')
try {
  if(process.env.CATALOG_EXPECT_UNAVAILABLE==='1') {
    await assert.rejects(worker.request('inspect'))
    console.log(JSON.stringify({unavailable:true,expected:true,node:process.version}))
  }else{
    const manifest=await worker.request('inspect')
    assert.ok(manifest.products>0)
    const parallel=await Promise.all(Array.from({length:4},()=>worker.request('search',{query:'pâte',page:1,pageSize:20})))
    assert.ok(parallel.every(r=>r.catalogueVersion===manifest.sha256))
    const child=worker.child,ended=once(child,'close');child.kill('SIGKILL');await ended
    assert.equal((await worker.request('inspect')).sha256,manifest.sha256)
    console.log(JSON.stringify({products:manifest.products,version:manifest.version,restarted:true,readOnly:true,node:process.version}))
  }
}finally{await worker.close()}
