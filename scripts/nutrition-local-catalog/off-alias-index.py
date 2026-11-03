"""Seven-row alias benchmark only; the base catalogue is never opened writable."""
import json
import re
import resource
import sqlite3
import sys
import time
from catalog import BASE,parse_json,require,resources

def run(root,wire):
    require(root.parent.resolve()==BASE.resolve() and not root.is_symlink() and not (root/'aliases.sqlite').exists(),'unsafe-alias-workspace')
    resources(root);require(len(wire)<=65536,'alias-input-too-large');aliases=parse_json(wire.decode('utf8'));require(type(aliases) is list and len(aliases)==7,'invalid-alias-input')
    require(len({v['id'] for v in aliases})==7 and all(set(v)=={'id','label','terms','foodId','license'} and type(v['label']) is str and 0<len(v['label'])<=300 and type(v['terms']) is str and 0<len(v['terms'])<=80 for v in aliases),'invalid-alias-fields')
    c=sqlite3.connect(root/'aliases.sqlite')
    try:
        c.executescript("CREATE TABLE aliases(id INTEGER PRIMARY KEY,uid TEXT,label TEXT,food_id TEXT,license TEXT);CREATE VIRTUAL TABLE aliases_fts USING fts5(label,terms,tokenize='unicode61 remove_diacritics 2');")
        for p in aliases:
            c.execute('INSERT INTO aliases(uid,label,food_id,license) VALUES(?,?,?,?)',(p['id'],p['label'],p['foodId'],json.dumps(p['license'])))
            key=c.execute('SELECT last_insert_rowid()').fetchone()[0];c.execute('INSERT INTO aliases_fts(rowid,label,terms) VALUES(?,?,?)',(key,p['label'],p['terms']))
        c.commit();require(c.execute('PRAGMA integrity_check').fetchone()[0]=='ok','alias-integrity');c.execute('PRAGMA query_only=ON');results={}
        for query in ('banane','oeufs','lait','riz','pâtes','yaourt','poulet'):
            times=[]
            for _ in range(30):
                tick=time.perf_counter();rows=c.execute('SELECT a.uid,a.label,a.food_id FROM aliases_fts JOIN aliases a ON a.id=aliases_fts.rowid WHERE aliases_fts MATCH ? ORDER BY bm25(aliases_fts,1,10) LIMIT 1',('"'+query+'"*',)).fetchall();times.append((time.perf_counter()-tick)*1000)
            expected=next(p['id'] for p in aliases if query in p['terms'].split())
            require(len(rows)==1 and rows[0][0]==expected,'alias-semantic-ranking-failed')
            results[query]={'count':len(rows),'label':rows[0][1],'p95Ms':sorted(times)[28]}
        return {'queries':results,'bytes':(root/'aliases.sqlite').stat().st_size,'peakRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
    finally:c.close()

if __name__=='__main__':
    require(len(sys.argv)==2 and re.fullmatch(r'[A-Za-z0-9_-]{1,40}',sys.argv[1]),'invalid-workspace')
    print(json.dumps(run(BASE/sys.argv[1],sys.stdin.buffer.read(65537))))
