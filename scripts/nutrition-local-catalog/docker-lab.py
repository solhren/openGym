"""Copy only a validated public generation into a NEW read-only Docker lab.
Never changes source permissions or files. Optional corruption targets the copy.
"""
import argparse
import contextlib
import json
import os
import re
import shutil
import sys
from catalog import Catalog, CatalogError, canonical, digest_file, resources, workspace, require

def prepare(source, name, corrupt=False):
    require(source != name, 'lab-source-equals-destination')
    source_root = workspace(source, create=False)
    # workspace() is not exclusive; explicitly refuse every existing destination.
    from catalog import BASE
    require(type(name) is str and re.fullmatch('[a-zA-Z0-9_-]{1,40}',name), 'invalid-workspace')
    target = BASE/name
    target.mkdir(mode=0o700)
    resources(target)
    with contextlib.closing(Catalog(source_root)) as reader:
        manifest = reader.manifest
        file = target/manifest['file']
        shutil.copyfile(source_root/manifest['file'],file)
        require(digest_file(file) == manifest['sha256'], 'lab-copy-changed-during-copy')
        (target/'current.json').write_text(canonical(manifest)+'\n',encoding='utf8')
    if corrupt:
        with file.open('r+b') as handle:
            handle.write(b'BAD_CATALOG');handle.flush();os.fsync(handle.fileno())
    for item in target.iterdir(): item.chmod(0o444)
    target.chmod(0o755) # Public catalogue only, lets fixed unprivileged Docker UID read.
    return {'directory':str(target),'expectedUnavailable':corrupt,'bytes':file.stat().st_size,'sourceUnchanged':True}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True);parser.add_argument('--name',required=True);parser.add_argument('--corrupt',action='store_true')
    args=parser.parse_args()
    try: print(canonical(prepare(args.source,args.name,args.corrupt)))
    except (CatalogError,OSError) as error:
        print(canonical({'error':str(error) if isinstance(error,CatalogError) else 'lab-storage-error'}),file=sys.stderr);raise SystemExit(1)
