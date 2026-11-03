"""Schema/evidence inventory, NOT a Food importer or a nutrition calculator.
Only an actual bounded raw capture is accepted; fixtures do not become real data.
"""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import re
import resource
from catalog import BASE,require,parse_json

MACROS=('energy-kcal','proteins','carbohydrates','fat')
def summarize(rows):
    counts=collections.Counter();examples=[]
    for row in rows:
        require(type(row) is dict and type(row.get('code')) is str,'invalid-product')
        counts['rows']+=1
        nutrition=row.get('nutrition');aggregate=nutrition.get('aggregated_set') if type(nutrition) is dict else None
        if row.get('nutrition_data_per') is not None:counts['legacyPerPresent']+=1
        if row.get('product_quantity_unit') is not None:counts['packageUnitPresent']+=1
        if type(aggregate) is dict:
            counts['aggregatePresent']+=1
            per=aggregate.get('per');sold=aggregate.get('preparation')=='as_sold'
            explicit=per in ('100g','100ml') and sold
            if explicit:counts['explicitAsSoldAggregate']+=1;counts['explicitAsSold_'+per]+=1
            else:counts['aggregateNotUsableAsSoldReference']+=1
            nutrients=aggregate.get('nutrients');nutrients=nutrients if type(nutrients) is dict else {}
            energy='energy-kcal' if 'energy-kcal' in nutrients else 'energy-kj' if 'energy-kj' in nutrients else 'energy'
            values=[nutrients.get(key) for key in (energy,'proteins','carbohydrates','fat')]
            numeric=lambda v:type(v) in (int,float) and math.isfinite(v) and v>=0
            declared=all(type(v) is dict and numeric(v.get('value')) for v in values)
            modified=any(type(v) is dict and (v.get('modifier') is not None or v.get('source')=='estimate') for v in values)
            quality=row.get('data_quality_errors_tags') or []
            quality_error=type(quality) is not list or any(type(v) is not str or re.match(r'en:(nutrition-|energy-)',v) for v in quality)
            unit_bad=any(type(v) is dict and v.get('unit') is not None and v['unit']!=('kcal' if i==0 and energy=='energy-kcal' else 'kJ' if i==0 else 'g') for i,v in enumerate(values))
            if declared:counts['aggregateFourDeclaredMacros']+=1
            if modified:counts['aggregateEstimatedOrQualified']+=1
            if unit_bad:counts['aggregateContradictoryUnits']+=1
            if any(type(v) is dict and v.get('source') is None for v in values):counts['aggregateSourceNotSpecified']+=1
            if any(type(v) is dict and v.get('value') is None and v.get('value_computed') is not None for v in values):counts['computedOnlyMacro']+=1
            if explicit and declared and not modified and not unit_bad and not quality_error and row.get('no_nutrition_data') not in ('on','1',1,True):
                counts['candidateForEngineValidation']+=1
                if len(examples)<5:examples.append({'code':row['code'],'name':row.get('product_name_fr') or row.get('product_name'),'per':per,'evidence':'explicit aggregate; engine validation and identity checks still required'})
        else:counts['aggregateMissing']+=1
        sets=nutrition.get('input_sets') if type(nutrition) is dict else None
        if type(sets) is list and any(type(v) is dict and v.get('preparation')=='as_sold' and v.get('per') in ('100g','100ml') and v.get('source') in ('packaging','manufacturer','usda') for v in sets):counts['explicitAsSoldInputSet']+=1
    return {'counts':dict(counts),'examples':examples,'finalValidatedFoods':None,'note':'Field availability is not a passed Food validation or representative French coverage.'}

def run(name):
    require(type(name) is str and re.fullmatch(r'[A-Za-z0-9_-]{1,40}',name),'invalid-workspace')
    root=BASE/name;require(not root.is_symlink() and root.is_dir(),'unsafe-workspace')
    receipt_file=root/'capture.json';require(not receipt_file.is_symlink() and receipt_file.stat().st_size<=65536,'unsafe-receipt');receipt=parse_json(receipt_file.read_text())
    require(receipt.get('format')=='opengym-off-raw-prefix' and receipt.get('complete') is True,'incomplete-or-nonraw-capture')
    file=root/'rows.jsonl';require(not file.is_symlink() and file.stat().st_size==receipt['bytes']<=32*1024**2,'unsafe-capture-file')
    digest=hashlib.sha256()
    def rows():
        with file.open('rb') as source:
            for raw in iter(lambda:source.readline(8*1024**2+1),b''):
                require(len(raw)<=8*1024**2 and raw.endswith(b'\n'),'invalid-raw-line');digest.update(raw)
                yield json.loads(raw,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('nonfinite-json')))
    result=summarize(rows());require(digest.hexdigest()==receipt['sha256'] and result['counts'].get('rows')==receipt['rows'],'capture-hash-or-count-mismatch')
    result.update(realRawCapture=not receipt.get('fixture',False),representative=False,source=receipt['source'],sourceCompressedBytes=receipt.get('sourceCompressedBytes'))
    with (root/'reference-inspection.json').open('x') as f:json.dump(result,f,ensure_ascii=False,indent=2)
    return result

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('workspace');args=p.parse_args();resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2));print(json.dumps(run(args.workspace),ensure_ascii=False,indent=2))
