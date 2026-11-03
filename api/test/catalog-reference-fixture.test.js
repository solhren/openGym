import {test} from 'node:test';
import assert from 'node:assert/strict';
import {referenceCatalogFixture} from './catalog-reference.test-util.js';

test('parallel synthetic catalogue fixtures retain the real exclusive import lock',{timeout:15000},async()=>{
 const results=await Promise.allSettled([referenceCatalogFixture(),referenceCatalogFixture()]);
 try{
  for(const result of results)assert.equal(result.status,'fulfilled',result.reason?.message);
  const [a,b]=results.map(r=>r.value);
  assert.notEqual(a.names.index,b.names.index);
  assert.equal(a.records.length,3);assert.equal(b.records.length,3);
 }finally{for(const result of results)if(result.status==='fulfilled')result.value.cleanup();}
});
