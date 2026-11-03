import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import select
import signal
import tempfile
import sys
import unittest
from unittest.mock import patch
from test_wger_generation import wire,row

s=importlib.util.spec_from_file_location('wc',Path(__file__).with_name('wger-complement.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class ComplementTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.base=Path(self.tmp.name)/'base';self.base.mkdir();self.root=Path(self.tmp.name)/'aliases';self.root.mkdir()
        self.guards=patch.object(m.wger,'guard',return_value={'availableMemoryBytes':4*1024**3,'freeDiskBytes':40*1024**3});self.guards.start()
        original=row(name='Pasta, dry');original['brand']='';original['sourceKind']='usda';original['food']={'reference':{'amount':100,'unit':'g'},'nutrients':{'kcal':350,'protein':7.123,'carbs':75.5,'fat':1.25}}
        bad=row('12345678-1234-1234-1234-123456789abd','Pâtes');bad['food']=None
        m.wger.build(self.base,wire([original,bad]));self.reader=m.wger.Reader(self.base)
        self.config={'baseSha256':self.reader.manifest['sha256'],'aliases':[{'uid':original['id'],'label':'Pâtes sèches','terms':'pâtes','expectedName':original['name']}]}
    def tearDown(self):self.reader.close();self.guards.stop();self.tmp.cleanup()
    def build(self,config=None):return m.build(self.reader,self.root,config or self.config)
    def read(self):return m.Reader(m.wger.Reader(self.base),self.root)
    def test_aliases_preserve_nutrition_source_name_and_uuid(self):
        self.build();r=self.read()
        try:
            p=r.search('pates')['products'][0];self.assertEqual(p['name'],'Pâtes sèches');self.assertEqual(p['food']['nutrients']['protein'],7.123)
            self.assertEqual(p['translation']['originalName'],'Pasta, dry');self.assertEqual(p['id'],self.config['aliases'][0]['uid']);self.assertEqual(r.search('patez')['count'],0)
            self.assertEqual(r.search('Pasta')['count'],1);self.assertEqual(r.search('Pasta',page=2)['products'],[])
        finally:r.close()
    def test_unusable_exact_matches_cannot_displace_usable_alias(self):
        self.build();r=self.read()
        try:self.assertEqual(r.search('pâtes')['count'],1);self.assertTrue(all(p['food'] for p in r.search('pâtes')['products']));self.assertIsNone(r.product('wger:12345678-1234-1234-1234-123456789abd')['food'])
        finally:r.close()
    def test_wrong_source_pin_name_and_duplicate_identity_rejected(self):
        for mutate in [lambda v:v.update(baseSha256='a'*64),lambda v:v['aliases'][0].update(expectedName='Other'),lambda v:v['aliases'].append(copy.deepcopy(v['aliases'][0]))]:
            v=copy.deepcopy(self.config);mutate(v)
            with self.assertRaises(Exception):self.build(v)
            self.assertFalse((self.root/'current.json').exists())
    def test_crash_before_manifest_preserves_previous_reader_and_rollback(self):
        old=self.build();r=self.read();v=copy.deepcopy(self.config);v['aliases'][0]['label']='Autres pâtes'
        real=m.atomic
        def fail(root,name,value):
            if name=='current.json':raise OSError('simulated disk full before publication')
            return real(root,name,value)
        try:
            with patch.object(m,'atomic',side_effect=fail):
                with self.assertRaises(OSError):self.build(v)
            self.assertEqual(m.read_manifest(self.root),old);self.assertEqual(r.search('pates')['products'][0]['name'],'Pâtes sèches')
            new=self.build(v);self.assertNotEqual(new['sha256'],old['sha256']);self.assertEqual(r.search('pates')['products'][0]['name'],'Pâtes sèches')
            self.assertEqual(m.rollback(self.reader,self.root)['sha256'],old['sha256'])
        finally:r.close()
    def test_corrupt_db_bad_manifest_and_base_mismatch_fail_closed(self):
        self.build();p=self.root/'current.json';value=json.loads(p.read_text());value['baseSha256']='b'*64;p.write_text(json.dumps(value))
        with self.assertRaisesRegex(Exception,'base-mismatch'):self.read()
        value['file']='../../outside';p.write_text(json.dumps(value))
        with self.assertRaisesRegex(Exception,'unsafe'):m.read_manifest(self.root)
    def test_disk_memory_and_reader_query_limits(self):
        with patch.object(m.wger,'guard',side_effect=Exception('insufficient-free-disk')):
            with self.assertRaisesRegex(Exception,'disk'):self.build()
        self.build();r=self.read()
        try:
            for query,page in [('x'*121,1),('a b c d e f g h i',1),('pâtes',21),('pâtes',True)]:
                with self.assertRaises(Exception):r.search(query,page=page)
            for query in ['" OR 1=1 --','pâtes; DROP TABLE aliases','patez']:
                result=r.search(query);self.assertIsInstance(result['count'],int)
        finally:r.close()
    def test_four_zeros_are_a_review_state_not_proof_of_complete_nutrition(self):
        self.reader.close()
        # A new base only, not an alteration of an already sealed generation.
        other=Path(self.tmp.name)/'zero-base';other.mkdir();original=row(name='Pasta, dry');original['brand']='';original['sourceKind']='usda';original['food']={'reference':{'amount':100,'unit':'g'},'nutrients':{'kcal':350,'protein':7,'carbs':75,'fat':1}}
        zero=copy.deepcopy(original);zero['id']='wger:12345678-1234-1234-1234-123456789abe';zero['name']='Coca-Cola Can';zero['food']['nutrients']={k:0 for k in ('kcal','protein','carbs','fat')}
        m.wger.build(other,wire([original,zero]));self.reader=m.wger.Reader(other);self.config['baseSha256']=self.reader.manifest['sha256'];manifest=self.build()
        self.assertEqual(manifest['excludedRows'],1)
        r=m.Reader(m.wger.Reader(other),self.root)
        try:
            self.assertEqual(r.search('Coca-Cola')['count'],0);self.assertIsNone(r.product(zero['id'])['food']);self.assertEqual(r.product(zero['id'])['validationStatus'],'needs-verification')
            self.assertEqual(self.reader.product(zero['id'])['food']['nutrients']['kcal'],0)
        finally:r.close()
    def test_sigkill_after_sealing_and_writer_exclusion_preserve_published_generation(self):
        old=self.build();reader=self.read();value=copy.deepcopy(self.config);value['aliases'][0]['label']='Nouvelles pâtes'
        receive,send=os.pipe();child=os.fork()
        if child==0:
            os.close(receive)
            try:
                base=m.wger.Reader(self.base);real=m.atomic
                def stop(root,name,data):
                    if name=='current.json':os.write(send,b'ready');os.kill(os.getpid(),signal.SIGSTOP)
                    return real(root,name,data)
                m.atomic=stop;m.build(base,self.root,value)
            except BaseException:os.write(send,b'error')
            finally:os._exit(0)
        os.close(send)
        try:
            self.assertTrue(select.select([receive],[],[],10)[0],'writer did not reach prepared phase');self.assertEqual(os.read(receive,16),b'ready')
            with self.assertRaises(BlockingIOError):self.build(value)
            os.kill(child,signal.SIGKILL);os.waitpid(child,0);child=None
            self.assertEqual(m.read_manifest(self.root),old);self.assertEqual(reader.search('pâtes')['products'][0]['name'],'Pâtes sèches')
            published=self.build(value);self.assertNotEqual(published['sha256'],old['sha256']);self.assertGreaterEqual(len(list(self.root.glob('aliases-*.sqlite'))),3)
        finally:
            if child is not None:os.kill(child,signal.SIGKILL);os.waitpid(child,0)
            os.close(receive);reader.close()
    def test_startup_refuses_mismatched_metadata_before_large_base_hash_and_exits(self):
        self.build()
        spec=importlib.util.spec_from_file_location('v1_reader',Path(__file__).with_name('wger-v1-reader.py'));worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)
        file=self.base/'current.json';value=json.loads(file.read_text());value['sha256']='b'*64;file.write_text(json.dumps(value))
        request=json.dumps({'v':1,'id':1,'op':'inspect','args':{}})+'\n';output=io.StringIO()
        with patch.object(worker.module.wger,'root_for',side_effect=lambda name:self.base if name=='base' else self.root),patch.object(worker.module.wger,'Reader',side_effect=AssertionError('large hash must not run')) as full_reader,patch.object(sys,'stdin',io.TextIOWrapper(io.BytesIO(request.encode()))),patch.object(sys,'stdout',output):
            status=worker.serve('base','quality')
        self.assertEqual(status,1);self.assertFalse(json.loads(output.getvalue())['ok']);self.assertEqual(full_reader.call_count,0)

if __name__=='__main__':unittest.main()
