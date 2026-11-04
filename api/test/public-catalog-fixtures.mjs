// Tiny synthetic SQLite catalogue. No acquisition, real catalogue or user state is reused.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../../scripts/nutrition-local-catalog/', import.meta.url));
export async function publicCatalogFixture(t) {
  const runtime = path.join(scripts, 'runtime'); fs.mkdirSync(runtime, { recursive: true });
  const root = fs.mkdtempSync(path.join(runtime, 'public-install-fixture-'));
  const directory = path.join(root, 'catalogues', 'catalogue'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const specsFile = path.join(root, 'fixture-specs.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const program = String.raw`
import sys,importlib.util,json,sqlite3,hashlib,copy
from pathlib import Path
spec=importlib.util.spec_from_file_location('public_bootstrap_fixture',Path(sys.argv[1])/'public-bootstrap.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
root=Path(sys.argv[2]);specs=copy.deepcopy(m.SOURCES)
for spec,body in zip(specs,[b'synthetic-xlsx-source',b'synthetic-xml-source']):spec.update(bytes=len(body),md5=hashlib.md5(body).hexdigest(),sha256=hashlib.sha256(body).hexdigest())
Path(sys.argv[3]).write_text(m.canonical(specs))
names={'99900001':{'fr':'Riz cru de test','en':'Test raw rice'},'99900002':{'fr':'Lait de test','en':'Test milk'},'99900003':{'fr':'Riz inconnu de test','en':'Test unknown rice'},'99900004':{'fr':'Riz','en':'Rice'}}
rows=[{'G':'99900001','H':names['99900001']['fr'],'K':'350','P':'7','Q':'75','R':'1'},{'G':'99900002','H':names['99900002']['fr'],'K':'60','P':'3','Q':'5','R':'3'},{'G':'99900003','H':names['99900003']['fr'],'K':'-','P':'-','Q':'-','R':'-'},{'G':'99900004','H':'Riz','K':'350','P':'7','Q':'75','R':'1'}]
for code,fr,en in [('99900005','Lait entier','Milk, whole'),('99900006','Laitance','Milkshake'),('99900007','Œuf cru','Egg, raw'),('99900008','Aubergine','Eggplant')]:
 names[code]={'fr':fr,'en':en};rows.append({'G':code,'H':fr,'K':'60','P':'3','Q':'5','R':'3'})
records=[m.normalize_row(row,names,specs[0]['sha256'],specs[1]['sha256'])for row in rows]
file=root/'staged.sqlite';c=sqlite3.connect(file)
c.executescript("CREATE TABLE foods(rowid INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,folded TEXT NOT NULL,payload TEXT NOT NULL,complete INTEGER NOT NULL,addable INTEGER NOT NULL);CREATE VIRTUAL TABLE foods_fts USING fts5(folded,content='foods',content_rowid='rowid',tokenize='unicode61 remove_diacritics 2',prefix='3 4');")
for record in records:c.execute('INSERT INTO foods(id,name,folded,payload,complete,addable)VALUES(?,?,?,?,?,?)',(record['id'],record['name'],m.fold_text(record['source']['names']['fr']+' '+record['source']['names']['en']),m.canonical(record),int(record['validationStatus']=='validated'),int(record['food']is not None)))
c.execute("INSERT INTO foods_fts(foods_fts)VALUES('rebuild')");c.commit();c.close()
sha=m.digest_file(file);final=root/('catalog-'+sha+'.sqlite');file.rename(final)
(root/'NOTICE.txt').write_text('Synthetic test catalogue. Not publisher data.\n');(root/'receipt.json').write_text('{"fixture":true}')
manifest={'format':m.FORMAT,'schemaVersion':1,'provider':'ciqual','sourceVersion':'2025','file':final.name,'sha256':sha,'bytes':final.stat().st_size,'rows':len(records),'usableFoodCount':sum(record['food']is not None for record in records),'completeFoodCount':sum(record['validationStatus']=='validated'for record in records),'englishNameCount':len(records),'rejectedFoodCount':sum(record['food']is None for record in records),'literalOnly':True,'reference':{'amount':100,'unit':'g'},'languages':['fr','en'],'license':m.LICENSE,'source':{k:v for k,v in specs[0].items()if k!='name'},'namesSource':{k:v for k,v in specs[1].items()if k!='name'},'noticeSha256':m.digest_file(root/'NOTICE.txt'),'receiptSha256':m.digest_file(root/'receipt.json')}
(root/'current.json').write_text(m.canonical(manifest));m.inspect_generation(root,expected_specs=specs)
print(m.canonical({'sha256':sha,'rows':len(records)}))`;
  const summary = await new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', program, scripts, directory, specsFile], { stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' } });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 16384) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16384) child.kill(); });
    child.on('error', reject); child.on('close', code => {
      clearTimeout(timer);
      if (code) reject(new Error(stderr || 'synthetic catalogue fixture failed'));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
  });
  return { root, directory, specsFile, ...summary };
}

// Only test callers select this spawn function. The production CLI and service have no source
// pin override. Hashes, SQL, source DTO validation and supervision remain the real code paths.
export function fixtureCatalogSpawn(specsFile) {
  const program = String.raw`import sys,json,importlib.util,resource
resource.setrlimit(resource.RLIMIT_AS,(128*1024**2,128*1024**2))
spec=importlib.util.spec_from_file_location('public_reader_fixture',sys.argv[3]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
specs=json.load(open(sys.argv[2]))
m.serve(sys.argv[1],inspector=lambda directory:m.bootstrap.inspect_generation(directory,expected_specs=specs))`;
  return (command, args, options) => spawn(command, ['-u', '-c', program, args.at(-1), specsFile, args.at(-2)], options);
}
