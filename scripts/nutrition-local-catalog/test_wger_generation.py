import copy
import gzip
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import shutil
import time
import unittest
from unittest.mock import patch

def module(name,file):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
m=module('full_generation','wger-generation.py');audit=module('full_audit','wger-full-audit.py')

def row(uid='12345678-1234-1234-1234-123456789abc',name='Riz complet'):
    return {'id':'wger:'+uid,'barcode':'0034000470693','name':name,'nameFr':name,'brand':'Marque','language':'fr','sourceKind':'wger','provenance':{'license':{'id':'CC-BY-SA-4.0'}},'food':{'nutrients':{'kcal':350}},'complete':True,'nutritionValuesValid':True,'issues':[],'warnings':[]}

def wire(rows,verified=True,finish=True):
    header={'format':m.FORMAT,'version':1,'sourceSha256':'a'*64,'sourceBytes':10,'expectedRows':len(rows),'registry':{'verified':verified}}
    values=[{'header':header}]+[{'record':v,'sourceLine':i+1} for i,v in enumerate(rows)]
    if finish:values.append({'finish':{'scanned':len(rows),'rejected':0,'gzipCrcVerified':True,'sourceHashVerified':True}})
    return io.BytesIO(b''.join((json.dumps(v)+'\n').encode() for v in values))

class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.guard=patch.object(m,'guard',return_value={'availableMemoryBytes':4*1024**3,'freeDiskBytes':40*1024**3});self.guard.start()
    def tearDown(self):self.guard.stop();self.tmp.cleanup()
    def reader(self):return m.Reader(self.root)
    def test_complete_generation_integrity_literal_accents_brand_and_no_fuzzy(self):
        result=m.build(self.root,wire([row(name='Pâtes complètes'),row('12345678-1234-1234-1234-123456789abd','Nutella')]))
        self.assertTrue(result['complete']);self.assertEqual(result['counts']['directlyAddable'],2)
        r=self.reader()
        try:
            self.assertEqual(r.search('pates')['count'],1);self.assertEqual(r.search('nute')['count'],1);self.assertEqual(r.search('nutela')['count'],0);self.assertEqual(r.search('Marque')['count'],2)
            self.assertEqual(r.search('pates',language='pl')['count'],1)
            self.assertEqual(len(r.barcode('0034000470693')),2);self.assertEqual(r.product('wger:12345678-1234-1234-1234-123456789abc')['validationStatus'],'validated')
        finally:r.close()
    def test_provisional_registry_never_exposes_food(self):
        report=m.build(self.root,wire([row()],verified=False));self.assertEqual(report['counts']['directlyAddable'],0)
        r=self.reader()
        try:self.assertIsNone(r.search('riz')['products'][0]['food']);self.assertTrue(r.search('riz')['products'][0]['technicallyAddable'])
        finally:r.close()
    def test_missing_finish_and_partial_line_never_publish(self):
        with self.assertRaisesRegex(Exception,'interrupted'):m.build(self.root,wire([row()],finish=False))
        self.assertFalse((self.root/'current.json').exists());self.assertTrue((self.root/'interrupted.json').exists())
    def test_hash_or_crc_receipt_failure_never_publishes(self):
        data=wire([row()]).getvalue().replace(b'"gzipCrcVerified": true',b'"gzipCrcVerified": false')
        with self.assertRaisesRegex(Exception,'invalid-end'):m.build(self.root,io.BytesIO(data))
        self.assertFalse((self.root/'current.json').exists())
    def test_duplicate_identity_does_not_invent_extra_product(self):
        report=m.build(self.root,wire([row(),row()]));self.assertEqual(report['counts']['indexed'],1);self.assertEqual(report['counts']['duplicates'],1)
    def test_divergent_uuid_preserves_both_versions_and_blocks_addition(self):
        report=m.build(self.root,wire([row(),row(name='Autre riz')]))
        self.assertEqual(report['counts']['incompatibleDuplicates'],1);self.assertEqual(report['counts']['directlyAddable'],0)
        r=self.reader()
        try:self.assertIsNone(r.search('riz')['products'][0]['food']);self.assertEqual(r.c.execute('SELECT count(*) FROM collisions').fetchone()[0],2)
        finally:r.close()
    def test_invalid_pagination_and_fts_input_are_bounded(self):
        m.build(self.root,wire([row()]));r=self.reader()
        try:
            for args in [('riz',0,20),('riz',1,21),('riz',51,20),('x'*121,1,20)]:
                with self.assertRaises(Exception):r.search(*args)
            self.assertEqual(r.search("x' OR 1=1")['count'],0)
        finally:r.close()
    def test_corrupted_database_is_not_opened(self):
        m.build(self.root,wire([row()]));p=next(self.root.glob('catalog-*.sqlite'));p.chmod(0o600)
        with p.open('r+b') as f:f.seek(100);f.write(b'corrupt')
        with self.assertRaisesRegex(Exception,'corrupt-generation'):self.reader()
    def test_manifest_path_traversal_rejected(self):
        m.build(self.root,wire([row()]));p=self.root/'current.json';data=json.loads(p.read_text());data['file']='../catalog.sqlite';p.write_text(json.dumps(data))
        with self.assertRaisesRegex(Exception,'unsafe-generation'):self.reader()
    def test_existing_generation_cannot_be_overwritten_and_pinned_reader_survives(self):
        m.build(self.root,wire([row()]));before=(self.root/'current.json').read_bytes();r=self.reader()
        try:
            with self.assertRaisesRegex(Exception,'generation-exists'):m.build(self.root,wire([row(name='New')]))
            self.assertEqual((self.root/'current.json').read_bytes(),before);self.assertEqual(r.search('riz')['count'],1)
        finally:r.close()
    def test_full_disk_guard_failure_never_publishes(self):
        self.guard.stop()
        with patch.object(m,'guard',side_effect=m.CatalogError('insufficient-free-disk')):
            with self.assertRaisesRegex(Exception,'insufficient-free-disk'):m.build(self.root,wire([row()]))
        self.guard.start();self.assertFalse((self.root/'current.json').exists())
    def test_sigkill_during_real_writer_leaves_no_sealed_generation(self):
        m.BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix='wger-kill-',dir=m.BASE) as tmp:
            root=Path(tmp);data=wire([row()],finish=False).getvalue()
            proc=subprocess.Popen([sys.executable,str(Path(m.__file__)),'build',root.name],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                proc.stdin.write(data);proc.stdin.flush();deadline=time.monotonic()+5
                while not list(root.glob('catalog-*.sqlite')) and proc.poll() is None and time.monotonic()<deadline:time.sleep(.01)
                self.assertIsNone(proc.poll());self.assertTrue(list(root.glob('catalog-*.sqlite')))
                proc.kill();proc.wait(timeout=5);self.assertFalse((root/'current.json').exists())
            finally:
                if proc.poll() is None:proc.kill();proc.wait(timeout=5)
                proc.stdin.close();proc.stdout.close();proc.stderr.close()
    def test_partial_and_unusable_fiches_remain_searchable(self):
        a=row();a['complete']=False;b=row('12345678-1234-1234-1234-123456789abd');b['food']=None;b['sourceKind']='off-derived';b['issues']=['off-100g-or-100ml-reference-lost']
        report=m.build(self.root,wire([a,b]));self.assertEqual(report['counts']['technicallyAddablePartial'],1);self.assertEqual(report['counts']['needsVerification'],1)
    def test_verified_replay_checks_every_payload_and_keeps_original_generation(self):
        rows=[row(),row('12345678-1234-1234-1234-123456789abd','Nutella')];m.build(self.root,wire(rows));before=(self.root/'current.json').read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=next(self.root.glob('catalog-*.sqlite'));shutil.copyfile(source,root/source.name)
            report=m.build(root,wire(rows),replay=True);self.assertEqual(report['buildMode'],'verified-source-replay');self.assertEqual(report['counts']['indexed'],2)
        self.assertEqual((self.root/'current.json').read_bytes(),before)
    def test_changed_payload_cannot_be_blessed_by_replay(self):
        m.build(self.root,wire([row()]))
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=next(self.root.glob('catalog-*.sqlite'));shutil.copyfile(source,root/source.name)
            with self.assertRaisesRegex(Exception,'replay-payload-mismatch'):m.build(root,wire([row(name='Wrong')]),replay=True)
            self.assertFalse((root/'current.json').exists())
    def test_replay_cannot_transplant_a_different_registry(self):
        m.build(self.root,wire([row()]))
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=next(self.root.glob('catalog-*.sqlite'));shutil.copyfile(source,root/source.name)
            with self.assertRaisesRegex(Exception,'incompatible-replay-source'):m.build(root,wire([row()],verified=False),replay=True)
    def test_known_food_precedes_unusable_same_name_without_invented_popularity(self):
        a=row(name='Rice');a['food']=None;b=row('12345678-1234-1234-1234-123456789abd','Rice');b['language']='en'
        m.build(self.root,wire([a,b]));r=self.reader()
        try:self.assertEqual(r.search('rice')['products'][0]['id'],b['id'])
        finally:r.close()

class AuditTests(unittest.TestCase):
    def test_crc_and_streaming_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'wger-full-source';source.mkdir();file=source/'ingredients.jsonl.gz';file.write_bytes(gzip.compress(b'{"uuid":"one"}\n{"uuid":"two"}\n'))
            with patch.object(audit,'BASE',root),patch.object(audit,'resources',return_value={}):
                result=audit.inventory(file,root/'audit.json');self.assertEqual(result['rows'],2);self.assertTrue(result['gzipCrcVerified'])
    def test_truncated_gzip_never_writes_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'wger-full-source';source.mkdir();file=source/'ingredients.jsonl.gz';file.write_bytes(gzip.compress(b'{"uuid":"one"}\n')[:-5])
            with patch.object(audit,'BASE',root),patch.object(audit,'resources',return_value={}):
                with self.assertRaises(EOFError):audit.inventory(file,root/'audit.json')
            self.assertFalse((root/'audit.json').exists())
