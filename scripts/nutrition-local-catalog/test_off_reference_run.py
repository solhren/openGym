import importlib.util,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('run','scripts/nutrition-local-catalog/off-reference-run.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class HeadersTests(unittest.TestCase):
 def setUp(self):
  self.expected={'expectedBytes':123,'etag':'"fixture"','sourceVersionId':'version'}
  self.headers={'Content-Length':'123','ETag':'"fixture"','x-amz-version-id':'version'}
 def response(self,status=200):return type('R',(),{'status':status,'headers':self.headers})()
 def test_exact_version_size_and_etag_are_required(self):
  m.verified_headers(self.response(),self.expected)
  for k,value in [('Content-Length','124'),('ETag','changed'),('x-amz-version-id','changed')]:
   old=self.headers[k];self.headers[k]=value
   with self.assertRaises(m.CatalogError):m.verified_headers(self.response(),self.expected)
   self.headers[k]=old
 def test_unknown_or_encoded_body_is_not_accepted_as_the_pinned_archive(self):
  with self.assertRaises(m.CatalogError):m.verified_headers(self.response(206),self.expected)
  self.headers['Content-Encoding']='gzip'
  with self.assertRaises(m.CatalogError):m.verified_headers(self.response(),self.expected)
 def test_missing_source_identity_is_a_failure_not_a_best_effort_download(self):
  del self.headers['x-amz-version-id']
  with self.assertRaises(m.CatalogError):m.verified_headers(self.response(),self.expected)
if __name__=='__main__':unittest.main()
