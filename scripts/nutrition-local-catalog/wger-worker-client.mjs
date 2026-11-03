import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {CatalogWorker} from './worker-client.mjs'

/** Reuse the existing supervisor, queue, cancellation, crash/restart bounds and
 * framing. This reader has no network path and pins one immutable generation.
 * Constructing it does not enable or register any application HTTP route.
 */
export class WgerCatalogWorker extends CatalogWorker {
 constructor(workspace,{spawnProcess=spawn,timeoutMs=30000,localV1=false,complement=null,reference=null,referenceIndex=null,startupTimeoutMs=reference===null?timeoutMs:90000,...options}={}){
  // A measured full-generation integrity hash takes ~13 s at first start. The
  // legacy 10 s startup budget would kill/restart a healthy full reader. SQL
  // searches retain their independent 2 s execution deadline.
  if(typeof localV1!=='boolean'||(localV1&&complement===null)||(complement!==null&&(!localV1||typeof complement!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(complement))))throw Error('invalid-complement-options')
  if((reference===null)!==(referenceIndex===null)||[reference,referenceIndex].some(v=>v!==null&&(!localV1||typeof v!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(v))))throw Error('invalid-reference-options')
  super(workspace,{...options,timeoutMs,startupTimeoutMs,spawnProcess:(command,args,opts)=>spawnProcess(command,localV1
   ? ['-u',fileURLToPath(new URL('./wger-v1-reader.py',import.meta.url)),args.at(-1),...(complement?['--complement',complement]:[]),...(reference?['--reference',reference,'--reference-index',referenceIndex]:[])]
   : ['-u',fileURLToPath(new URL('./wger-generation.py',import.meta.url)),'serve',args.at(-1)],opts)})
 }
}
