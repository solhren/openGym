"""Opt-in local-only reader: no HTTP module, provider fallback or fuzzy path."""
import argparse
import importlib.util
from pathlib import Path
import resource
import sqlite3
import sys
from catalog import CatalogError,canonical,parse_json,require

spec=importlib.util.spec_from_file_location('complement',Path(__file__).with_name('wger-complement.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def serve(base_name,complement_name=None,reference_name=None,index_name=None):
    reader=None
    try:
        for raw in iter(lambda:sys.stdin.buffer.readline(4097),b''):
            if len(raw)>4096 or not raw.endswith(b'\n'):return 2
            identity=None;startup_failed=False
            try:
                msg=parse_json(raw.decode('utf8'))
                require(type(msg) is dict and msg.keys()=={'v','id','op','args'} and type(msg['v']) is int and msg['v']==1 and type(msg['id']) is int and 0<msg['id']<=2**53-1,'invalid-request')
                identity=msg['id'];args=msg['args'];require(type(args) is dict,'invalid-request')
                if reader is None:
                    try:
                        # Refuse absent/mismatched small metadata BEFORE hashing
                        # five GiB. A failed startup exits after its error frame;
                        # the existing supervisor bounds subsequent restarts.
                        complement=module.wger.root_for(complement_name);pin=module.read_manifest(complement)
                        base_root=module.wger.root_for(base_name);metadata=base_root/'current.json'
                        require(not metadata.is_symlink() and metadata.stat().st_size<=65536,'unsafe-base-manifest')
                        manifest=parse_json(metadata.read_text());require(type(manifest) is dict and manifest.get('sha256')==pin['baseSha256'],'complement-base-mismatch')
                        join=None
                        if reference_name is not None:
                            require(index_name is not None,'reference-search-index-required')
                            spec=importlib.util.spec_from_file_location('reference_join',Path(__file__).with_name('wger-off-reference.py'));join=importlib.util.module_from_spec(spec);spec.loader.exec_module(join)
                            refs=join.reference(join.off.root(reference_name),verify=False)
                            join.read_manifest(join.off.root(index_name),manifest['sha256'],pin['sha256'],refs['sha256'])
                        base=module.wger.Reader(base_root,manifest)
                        try:
                            reader=module.Reader(base,complement)
                            if reference_name is not None:
                                reader=join.Reader(reader,join.off.root(reference_name),join.off.root(index_name))
                        except BaseException:base.close();raise
                    except BaseException:startup_failed=True;raise
                if msg['op']=='search':
                    require(set(args)=={'query','page','pageSize','language'},'invalid-arguments')
                    value=reader.search(args['query'],args['page'],args['pageSize'],args['language'])
                elif msg['op']=='product':
                    require(set(args)=={'uid'},'invalid-arguments');value=reader.product(args['uid'])
                elif msg['op']=='barcode':
                    require(set(args)=={'code'},'invalid-arguments');value=reader.barcode(args['code'])
                else:
                    require(msg['op']=='inspect' and not args,'invalid-operation')
                    value={'base':reader.base.manifest,'complement':reader.manifest,'catalogueVersion':reader.version,'localOnly':True,'literalOnly':True}
                response={'v':1,'id':identity,'ok':True,'result':value};require(len(canonical(response).encode())<=256*1024,'response-too-large')
            except (CatalogError,OSError,sqlite3.Error,UnicodeError,ValueError):response={'v':1,'id':identity,'ok':False,'error':'catalogue-unavailable-or-invalid-request'}
            print(canonical(response),flush=True)
            if startup_failed:return 1
    finally:
        if reader:reader.close()
    return 0

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('workspace');p.add_argument('--complement',required=True);p.add_argument('--reference');p.add_argument('--reference-index');a=p.parse_args()
    require((a.reference is None)==(a.reference_index is None),'incomplete-reference-options')
    resource.setrlimit(resource.RLIMIT_AS,(512*1024**2,512*1024**2))
    sys.exit(serve(a.workspace,a.complement,a.reference,a.reference_index))
