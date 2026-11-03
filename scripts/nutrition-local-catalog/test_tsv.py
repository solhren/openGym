import io
import unittest
from tsv import rows

class TsvTest(unittest.TestCase):
    def test_off_literal_quotes_do_not_merge_rows_or_change_columns(self):
        source=b'code\tproduct_name\tbrands\n00012345\t"Tea\tBrand\n00012346\t"Quoted" name\tBrand\n'
        result=list(rows(io.BytesIO(source)))
        self.assertEqual(len(result),2);self.assertEqual(result[0]['product_name'],'"Tea');self.assertEqual(result[1]['product_name'],'"Quoted" name')
    def test_unknown_large_fields_are_not_serialized(self):
        result=list(rows(io.BytesIO(('code\tproduct_name\tingredients_text\tcreator\n00012345\tLait\t'+'x'*60000+'\tPRIVATE\n').encode())))
        self.assertEqual(result,[{'code':'00012345','product_name':'Lait'}])
    def test_missing_extra_duplicate_unsafe_truncated_or_invalid_utf8(self):
        for text in [b'code\tcode\n',b'code\tproduct_name\n1\tName\textra\n',b'code\tproduct_name\n1\n',b'code\tproduct_name\n1\tName',b'code\tproduct_name\n1\t\xff\n',b'code\tproduct_name\t__proto__\n1\tName\tbad\n']:
            with self.subTest(text=text),self.assertRaises((ValueError,UnicodeError)):list(rows(io.BytesIO(text)))
    def test_crlf_decimals_empty_cells_and_leading_zeroes_are_preserved(self):
        result=list(rows(io.BytesIO(b'code\tproduct_name\tproteins_100g\tfat_100g\r\n00012345\tTest\t0.0000001\t\r\n')))
        self.assertEqual(result[0]['code'],'00012345');self.assertEqual(result[0]['proteins_100g'],'0.0000001');self.assertEqual(result[0]['fat_100g'],'')
    def test_field_and_line_limits(self):
        for length in [65537,1024*1024+1]:
            with self.assertRaises(ValueError):list(rows(io.BytesIO(b'code\tproduct_name\n00012345\t'+b'x'*length+b'\n')))

if __name__=='__main__':unittest.main()
