"""Explicit real-Parquet codec smoke checks; requires isolated requirements-benchmark.
Not silently skipped by the dependency-free prototype suite. No Internet/data users.
"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
try:
    import pyarrow as pa
    import pyarrow.parquet as pq
except ImportError:
    print('{"error":"parquet-reader-missing-install-isolated-pyarrow","realParquetChecksExecuted":0}',file=sys.stderr)
    sys.exit(1)
s=importlib.util.spec_from_file_location('public_parquet',Path(__file__).with_name('public-benchmark-parquet.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

class RealParquetChecks(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.patches=[patch.object(m,'BASE',self.root),patch.object(m.bench,'BASE',self.root),patch.object(m,'resources',return_value={'freeDiskBytes':35*1024**3,'availableMemoryBytes':4*1024**3}),patch.object(m.bench,'resources',return_value={})]
        for p in self.patches:p.start()
    def tearDown(self):
        for p in reversed(self.patches):p.stop()
        self.tmp.cleanup()
    def file(self,table):
        p=self.root/'table.parquet';pq.write_table(table,p,row_group_size=1,write_page_checksum=True);return p
    def table(self):
        return pa.table({'id':[1,2,3,4], 'product_code':['00012345','00012345','00012346',None],
                        'location_osm_address_country_code':['FR','FR','US','FR'], 'category_tag':[None,None,None,'en:bananas'],
                        'owner':['not-exportable']*4, 'proof_file_path':['not-exportable']*4})
    def test_real_codec_scan_and_private_columns_not_decoded(self):
        file=self.file(self.table());m.footer(file);report={};rows=list(m.arrow_rows(file,report))
        self.assertEqual(len(rows),4);self.assertEqual(rows[0]['product_code'],'00012345');self.assertEqual(report['rowGroups'],4)
        self.assertNotIn('owner',report['projectedColumns']);self.assertNotIn('proof_file_path',rows[0]);self.assertEqual(report['readerVersion'],pa.__version__)
    def test_missing_country_is_not_assumed_french(self):
        file=self.file(self.table().drop(['location_osm_address_country_code']))
        with self.assertRaisesRegex(m.CatalogError,'country'):list(m.arrow_rows(file,{}))
    def test_numeric_barcode_schema_is_rejected_instead_of_losing_zeros(self):
        table=self.table().set_column(1,'product_code',pa.array([12345,12345,12346,None],type=pa.int64()));file=self.file(table)
        with self.assertRaisesRegex(m.CatalogError,'column-type'):list(m.arrow_rows(file,{}))
    def test_actual_process_peak_over_budget_is_still_refused(self):
        file=self.file(self.table())
        with patch.object(m,'peak_rss_kib',return_value=600*1024):
            with self.assertRaisesRegex(m.CatalogError,'parquet-batch-memory-budget'):list(m.arrow_rows(file,{}))
    def test_actual_codec_projection_to_existing_benchmark_with_names_absent(self):
        file=self.file(self.table());sha=m.digest_file(file)
        with patch.object(m,'verified_capture',return_value=(file,{'revision':'a'*40,'sha256':sha,'bytes':file.stat().st_size})),patch.object(m,'digest_file',side_effect=lambda p: sha if p.name=='capture.json' else m.bench.digest_file(p)):
            result=m.project('not-network','projection',100)
        self.assertTrue(result['complete']);self.assertEqual(result['eligibleUniqueProducts'],2);self.assertEqual(result['unresolvedUniqueTitles'],2)
        benchmark=m.bench.prepare('projection','benchmark',100)
        self.assertEqual(benchmark['cases'],2);self.assertEqual(benchmark['sourceCounts']['missingQueryLabel'],2)
        self.assertNotIn('not-exportable',(self.root/'projection'/'projection.jsonl').read_text())

if __name__=='__main__':unittest.main()
