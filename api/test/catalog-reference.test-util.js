// Synthetic, disposable source/index fixtures. No catalogue or user file reused.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {normalizeWger} from '../../scripts/nutrition-local-catalog/wger-normalize.mjs';
import {referenceFixture} from '../../scripts/nutrition-local-catalog/off-integration-fixtures.mjs';
const scripts=path.resolve(import.meta.dirname,'../../scripts/nutrition-local-catalog'),artifacts=path.join(scripts,'artifacts');
export async function referenceCatalogFixture(){
 fs.mkdirSync(artifacts,{recursive:true,mode:0o700});
 fs.mkdirSync(path.join(scripts,'runtime'),{recursive:true,mode:0o700});
 // Parallel HTTP tests coordinate only their synthetic builds (five seconds
 // maximum). The production import lock and all validation remain untouched;
 // m.build runs exactly once and a genuine import in progress still fails it.
 const prefix='int-'+randomBytes(5).toString('hex'),names={base:prefix+'-base',quality:prefix+'-quality',reference:prefix+'-ref',index:prefix+'-index'},roots=Object.values(names).map(n=>path.join(artifacts,n));
 const cleanup=()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});};
 try{
  for(const kind of ['base','quality','reference'])fs.mkdirSync(path.join(artifacts,names[kind]),{mode:0o700});
  const context={languages:[{id:1,short_name:'fr'},{id:2,short_name:'en'}],licenses:[{id:1,url:'https://creativecommons.org/publicdomain/zero/1.0/'},{id:2,url:'https://opendatacommons.org/licenses/odbl/1-0/'}]};
  const legacy=await normalizeWger({uuid:'12345678-1234-1234-1234-123456789abc',name:'Nutella',brand:'Ferrero',code:'3017620422003',source_name:'Open Food Facts',source_url:'https://world.openfoodfacts.org/api/v2/product/3017620422003',license:2,language:1,energy:539,protein:6.3,carbohydrates:57.5,fat:30.9},context);
  const duplicate=await normalizeWger({uuid:'12345678-1234-1234-1234-123456789abd',name:'Nutella',brand:'Ferrero',code:'03017620422003',source_name:'Open Food Facts',source_url:'https://world.openfoodfacts.org/api/v2/product/3017620422003',license:2,language:2,energy:539,protein:6.3,carbohydrates:57.5,fat:30.9},context);
  const native=await normalizeWger({uuid:'12345678-1234-1234-1234-123456789abe',name:'Rice raw',brand:'',source_name:'USDA',license:1,language:2,energy:350,protein:7,carbohydrates:75,fat:1},context);
  const unresolved=await normalizeWger({uuid:'12345678-1234-1234-1234-123456789abf',name:'Coca',brand:'',code:'12345678',source_name:'Open Food Facts',license:2,language:1,energy:40,protein:0,carbohydrates:10,fat:0},context);
  const references=await Promise.all(['spread','drink','milk'].map(referenceFixture));
  const program=`import sys,json,io,sqlite3,uuid,hashlib,importlib.util,time,fcntl,os\nfrom pathlib import Path\nfrom unittest.mock import patch\nsys.path.insert(0,sys.argv[1])\ns=importlib.util.spec_from_file_location('join',Path(sys.argv[1])/'wger-off-reference.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\np=json.load(sys.stdin);n=p['names'];rows=p['rows']\nwire=[{'header':{'format':m.quality.wger.FORMAT,'version':1,'sourceSha256':'f'*64,'sourceBytes':1,'expectedRows':len(rows),'registry':{'verified':True,'fixture':True}}}]+[{'record':r,'sourceLine':i+1}for i,r in enumerate(rows)]+[{'finish':{'scanned':len(rows),'rejected':0,'gzipCrcVerified':True,'sourceHashVerified':True}}]\nm.quality.wger.build(m.off.root(n['base']),io.BytesIO(''.join(json.dumps(v)+'\\n'for v in wire).encode()))\nb=m.quality.wger.Reader(m.off.root(n['base']))\ntry:m.quality.build(b,m.off.root(n['quality']),{'baseSha256':b.manifest['sha256'],'aliases':[{'uid':rows[2]['id'],'label':'Riz cru','terms':'riz','expectedName':'Rice raw'}]})\nfinally:b.close()\nr=m.off.root(n['reference']);file=r/('reference-'+uuid.uuid4().hex+'.sqlite');c=sqlite3.connect(file);c.execute('CREATE TABLE records(key TEXT PRIMARY KEY,code TEXT,flags INTEGER,status TEXT,payload TEXT,signature TEXT)')\nfor v in p['references']:\n raw=m.canonical(v);c.execute('INSERT INTO records VALUES(?,?,3,\"accepted\",?,?)',(m.off.ids.canonical(v['code']),v['code'],raw,hashlib.sha256(raw.encode()).hexdigest()))\nc.commit();c.close()\na={'run':'fixture','reportSha256':'a'*64,'stagingSha256':'b'*64,'compressedSha256':'b'*64,'source':{'versionId':'fixture'},'lines':len(p['references'])}\nmanifest={'format':m.off.FORMAT,'version':1,'complete':True,'fullDumpVerified':True,'productionAllowed':False,'sourceAttestation':a,'stagedCapture':'fixture','targetsSha256':'d'*64,'rows':len(p['references']),'accepted':len(p['references']),'acceptedObservedInFrance':len(p['references']),'file':file.name,'bytes':file.stat().st_size,'sha256':m.digest_file(file)}\nm.off.write(r,'current.json',manifest)\n# Only producer attestation is a test fixture; runtime hashes, SQL, FTS, DTOs and calculations are real.\nfixture_fd=os.open(Path(sys.argv[1])/'runtime'/'.api-reference-fixture.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)\nwith os.fdopen(fixture_fd,'ab')as fixture_lock:\n deadline=time.monotonic()+5\n while True:\n  try:fcntl.flock(fixture_lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break\n  except BlockingIOError:\n   if time.monotonic()>=deadline:raise\n   time.sleep(0.02)\n with patch.object(m.off,'attest_source',return_value=a):result=m.build(n['base'],n['quality'],n['reference'],n['index'])\nprint(json.dumps({'complete':True,'rows':result['rows']}))`;
  await new Promise((resolve,reject)=>{
   const child=spawn('python3',['-c',program,scripts],{stdio:['pipe','pipe','pipe']});let output='',error='';const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
   child.stdout.on('data',b=>{output+=b;if(output.length>65536)child.kill();});child.stderr.on('data',b=>{error+=b;if(error.length>65536)child.kill();});child.stdin.on('error',()=>{});child.on('error',reject);
   child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error(error||output||'reference-fixture-build-failed'));});child.stdin.end(JSON.stringify({names,rows:[legacy,duplicate,native,unresolved],references:references.map(r=>r.result)}));
  });
  return {names,roots,records:references.map(r=>r.record),legacyId:legacy.id,cleanup};
 }catch(e){cleanup();throw e;}
}
