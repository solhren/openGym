"""OFF's export is literal UTF-8 TSV, not a quoted RFC4180 CSV.

Source exporter sanitizes embedded tabs/newlines and joins cells with tabs. Quotes
are product text. Project selected public columns before JSON serialization so
large ingredients/contributor fields never enter the nutrition normalizer.
"""
import json
import resource
import sys

MAX_LINE = 1024 * 1024
MAX_FIELD = 65536
FIELDS = {'code','product_name','product_name_fr','product_name_en','generic_name','brands','brands_tags','brands_fr','brands_en','countries_tags','last_modified_t',
          'nutrition_data_per','serving_size','serving_quantity','serving_quantity_unit','product_quantity_unit',
          'data_quality_errors_tags','data_quality_warnings_tags','no_nutrition_data'}
NUTRIENTS = ['energy-kcal','energy-kj','energy','proteins','carbohydrates','fat','fiber','sugars','saturated-fat','sodium']
FIELDS.update(k+s for k in NUTRIENTS for s in ('_100g','_serving','_modifier'))


def lines(stream):
    while True:
        value = stream.readline(MAX_LINE + 1)
        if not value: return
        if len(value) > MAX_LINE or not value.endswith(b'\n'): raise ValueError('oversized-or-truncated-tsv-line')
        yield value.decode('utf8', errors='strict').rstrip('\n').removesuffix('\r').split('\t')


def rows(stream):
    reader=iter(lines(stream))
    header=next(reader)
    if not 1<=len(header)<=512 or len(set(header))!=len(header) or 'code' not in header or not any(k in header for k in ('product_name','product_name_fr')):
        raise ValueError('invalid-tsv-header')
    if any(not k or len(k)>120 or any(ord(c)<32 for c in k) or k in ('__proto__','constructor','prototype') for k in header):raise ValueError('unsafe-tsv-header')
    selected=[(index,key) for index,key in enumerate(header) if key in FIELDS]
    for row in reader:
        if len(row)!=len(header):raise ValueError('invalid-tsv-column-count')
        if any(len(cell)>MAX_FIELD for cell in row):raise ValueError('oversized-tsv-field')
        yield {key:row[index] for index,key in selected}


def main():
    soft,hard=resource.getrlimit(resource.RLIMIT_AS)
    resource.setrlimit(resource.RLIMIT_AS,(min(soft,128*1024*1024) if soft!=-1 else 128*1024*1024,hard))
    try:
        for row in rows(sys.stdin.buffer):
            encoded=json.dumps(row,ensure_ascii=False,separators=(',',':'))
            if len(encoded.encode())>MAX_LINE:raise ValueError('oversized-tsv-row')
            print(encoded)
    except (ValueError,StopIteration,UnicodeError,MemoryError):
        print('invalid-or-oversized-tsv',file=sys.stderr);return 1
    return 0

if __name__=='__main__':sys.exit(main())
