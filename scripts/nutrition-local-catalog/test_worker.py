import io
import json
from pathlib import Path
import tempfile
import unittest
from catalog import build
from test_catalog import record, protocol, preserve_address_space_limit
from worker import serve

class WorkerProtocolTest(unittest.TestCase):
    def setUp(self):
        preserve_address_space_limit(self)
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        build(self.root,io.BytesIO(protocol([record()])))
    def run_requests(self, messages):
        wire=b''.join((json.dumps(m)+'\n').encode() for m in messages)
        output=io.BytesIO(); code=serve(self.root,io.BytesIO(wire),output)
        return code,[json.loads(line) for line in output.getvalue().splitlines()]
    def test_valid_reads_and_write_operation_refused_without_mutation(self):
        before=(self.root/'current.json').read_bytes()
        code, responses=self.run_requests([{'v':1,'id':1,'op':'barcode','args':{'code':'00012345'}},{'v':1,'id':2,'op':'build','args':{}}])
        self.assertEqual(code,0); self.assertEqual(responses[0]['result'],record())
        self.assertFalse(responses[1]['ok']); self.assertEqual(responses[1]['error'],'invalid-worker-operation')
        self.assertEqual((self.root/'current.json').read_bytes(),before)
    def test_null_unknown_fields_poison_and_invalid_arguments_have_structured_errors(self):
        code,responses=self.run_requests([None,{'v':1,'id':2,'op':'inspect','args':{},'extra':1},{'v':1,'id':3,'op':'inspect','args':{'__proto__':{}}},{'v':1,'id':4,'op':'search','args':{'query':'pates','page':1,'pageSize':100}}])
        self.assertEqual(code,0); self.assertTrue(all(r['ok'] is False for r in responses))
        self.assertEqual(responses[-1]['error'],'invalid-pagination')
    def test_oversized_or_unterminated_stream_exits_without_partial_response(self):
        for wire in [b'x'*4097,b'{"v":1}']:
            output=io.BytesIO()
            self.assertEqual(serve(self.root,io.BytesIO(wire),output),2)
            self.assertEqual(output.getvalue(),b'')

if __name__=='__main__': unittest.main()
