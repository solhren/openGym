"""Eight explicit maintenance-only OFF v3.5 schema probes, not an app dependency.
Curated contrasting cases, not a population sample. No retries or product crawl.
"""
import argparse,datetime,hashlib,json,os,re,sys,time,urllib.request,urllib.error
from catalog import BASE,CatalogError,canonical,require,resources
from sample import NoRedirect,network_error
CASES=[('3017620422003','curated spread'),('5449000000996','curated soda'),('3068320110013','curated water'),('3250392190484','frozen price milk'),('3760295170051','frozen price coconut oil'),('3531150222020','frozen price pastry'),('3770011205004','frozen price yoghurt'),('3506770002017','frozen price nonfood control')]
FIELDS='code,product_name,product_name_fr,brands,schema_version,nutrition,nutriments,nutrition_data_per,product_quantity_unit,serving_size,serving_quantity,serving_quantity_unit,no_nutrition_data,data_quality_errors_tags,last_modified_t,countries_tags,product_type'
def capture(name):
 require(type(name)is str and re.fullmatch('[A-Za-z0-9_-]{1,40}',name) and not BASE.is_symlink(),'unsafe-workspace');resources(BASE);root=BASE/name;root.mkdir(mode=0o700)
 receipt={'format':'opengym-off-reference-api-probe','version':1,'complete':False,'representative':False,'license':'ODbL-1.0','contentLicense':'DbCL-1.0','attribution':'Open Food Facts contributors','rows':[],'maxBytes':2*1024**2,'maxRequests':8,'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtimeDependency':False}
 opener=urllib.request.build_opener(NoRedirect());used=0;start=time.monotonic()
 try:
  for i,(code,reason) in enumerate(CASES):
   if i:time.sleep(1.1)
   resources(root);require(time.monotonic()-start<180,'reference-probe-deadline')
   url='https://world.openfoodfacts.org/api/v3.5/product/'+code+'?fields='+FIELDS
   try:
    with opener.open(urllib.request.Request(url,headers={'User-Agent':'openGym-catalog-reference-proof/1.4.1 (https://github.com/solhren/openGym)','Accept-Encoding':'identity'}),timeout=15) as r:
     require(r.status==200,'reference-probe-http-status');data=r.read(256*1024+1)
     require(len(data)<=256*1024,'reference-probe-size');used+=len(data);require(used<=2*1024**2,'reference-probe-size')
    value=json.loads(data);require(type(value)is dict and type(value.get('product'))is dict and value['product'].get('code')==code,'reference-probe-identity')
    file=code+'.json'
    with (root/file).open('xb') as f:os.chmod(root/file,0o600);f.write(data);f.flush();os.fsync(f.fileno())
    receipt['rows'].append({'code':code,'reason':reason,'file':file,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'source':url})
   except urllib.error.HTTPError as e:
    status=e.code;e.close();receipt['rows'].append({'code':code,'reason':reason,'error':'http-'+str(status)})
    require(status==404,'reference-probe-http-'+str(status))
  receipt.update(complete=True,bytes=used)
 except (CatalogError,urllib.error.URLError,OSError,ValueError) as e:
  receipt['error']=str(e) if isinstance(e,CatalogError) else network_error(e);raise CatalogError(receipt['error']) from None
 finally:
  receipt['seconds']=time.monotonic()-start
  with (root/'capture.json').open('x') as f:os.chmod(root/'capture.json',0o600);f.write(canonical(receipt));f.flush();os.fsync(f.fileno())
 return receipt
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--workspace',required=True);p.add_argument('--fetch',action='store_true');a=p.parse_args()
 try:print(canonical(capture(a.workspace) if a.fetch else {'requests':CASES,'networkRequests':0,'maxBytes':2*1024**2}))
 except (CatalogError,OSError)as e:print(canonical({'error':str(e)}),file=sys.stderr);sys.exit(1)
