// Explicit development mode. Public, bounded SQLite reads only: no account,
// provider relay, product cache writer or network dependency is constructed.
import {CatalogHttpError} from './food-catalog.js';
import {isLocalCatalogId} from '../shared/nutrition-catalog-identity.js';

const fail = (ok, status=400, code='catalog-invalid-query') => { if (!ok) throw new CatalogHttpError(status,code,undefined,'local-wger'); };
export const WGER_CAPABILITIES = Object.freeze({schemaVersion:2,textSearch:'local',provider:'wger',selection:'local-only',productIds:true});
export function createWgerRelay({catalog,worker,onEvent=()=>{}}) {
  let closed=false;
  return {
    localSearch:true,capabilities:WGER_CAPABILITIES,
    async read(kind,input,{signal}={}) {
      fail(!closed&&!signal?.aborted,409,'catalog-request-cancelled');
      fail(typeof input==='string'&&input.length<=2048);
      const params=new URL(input,'http://local').searchParams;
      const allowed=kind==='search'?['q','page','lc','staging']:['id','code','lc','staging'];
      fail(['search','product'].includes(kind)&&[...params.keys()].every(k=>allowed.includes(k)&&params.getAll(k).length===1));
      fail(['0',null].includes(params.get('staging'))&&/^[a-z]{2}$/.test(params.get('lc')??'fr'));
      let args;
      if(kind==='search') {
        const q=(params.get('q')??'').normalize('NFC').trim().replace(/\s+/g,' '), page=params.get('page')??'1';
        fail(q.length>=2&&q.length<=120&&!/[\u0000-\u001f\u007f]/.test(q)&&/^[1-9]\d?$/.test(page)&&Number(page)<=20);
        const tokens=q.match(/[\p{L}\p{N}]+/gu)??[];fail(tokens.length>=1&&tokens.length<=8&&tokens.every(t=>t.length<=40));
        args={q,page:Number(page),lc:params.get('lc')??'fr'};
      } else {
        fail(params.has('id')!==params.has('code'));
        fail(params.has('id')?isLocalCatalogId(params.get('id')):/^(?:\d{8}|\d{12,14})$/.test(params.get('code')));
      }
      try {
        let body;
        if(kind==='search')body=await catalog.search(args,{signal});
        else {
          let product;
          if(params.has('id'))product=await catalog.product(params.get('id'),{signal});
          else {
            const variants=await catalog.barcode(params.get('code'),{signal});
            // UUIDs are distinct products. Never silently choose between two
            // addable versions merely because they share a printed barcode.
            const addable=variants.filter(p=>p.food);fail(addable.length<=1 && variants.length<20,409,'catalog-ambiguous-barcode');
            product=addable[0]??variants[0]??null;
          }
          fail(product!==null,404,'catalog-not-found');body={product};
        }
        fail(!closed&&!signal?.aborted,409,'catalog-request-cancelled');
        return {status:200,body:{format:'opengym-local-food-catalog',schemaVersion:1,...body},headers:{'Cache-Control':'no-store','X-openGym-Catalog-Source':'local-wger'}};
      } catch(error) {
        if(error instanceof CatalogHttpError)throw error;
        const cancelled=closed||signal?.aborted;
        try{onEvent({component:'nutrition-local-catalog',event:cancelled?'cancelled':'reader-error',source:'local-wger',category:error.code==='worker-busy'?'overload':'unavailable'});}catch{}
        throw new CatalogHttpError(cancelled?409:error.code==='worker-busy'?429:503,cancelled?'catalog-request-cancelled':error.code==='worker-busy'?'catalog-client-rate-limited':'catalog-local-unavailable',undefined,'local-wger');
      }
    },
    async warm(){return worker.request('inspect',{});},
    async close(){closed=true;await catalog.close();},
  };
}
