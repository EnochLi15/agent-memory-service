#!/usr/bin/env python3
"""Verify ZIP identity and run the packaged source in a clean temporary tree."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', nargs='?', type=Path, default=ROOT / 'delivery-output/solution.zip')
    parser.add_argument('--check-only', action='store_true', help='Only validate archive paths, hashes and layout')
    parser.add_argument('--include-enhanced', action='store_true', help='Also run the optional enhanced model-outage lifecycle check; see documented limitations')
    parser.add_argument('--logs', type=Path, default=ROOT / 'delivery-output/verification')
    args = parser.parse_args()
    archive_path=args.archive.resolve()
    digest=hashlib.sha256(archive_path.read_bytes()).hexdigest()
    sidecar=archive_path.with_suffix('.zip.sha256')
    if not sidecar.exists() or sidecar.read_text().split()[0] != digest:
        raise ValueError('External archive SHA-256 is missing or differs')
    with tempfile.TemporaryDirectory(prefix='agent-memory-delivery-') as temporary:
        with zipfile.ZipFile(archive_path) as archive:
            infos=archive.infolist()
            names=[item.filename for item in infos]
            if len(names) != len(set(names)):
                raise ValueError('Duplicate ZIP entries')
            for item in infos:
                p=PurePosixPath(item.filename)
                if (not p.parts or p.parts[0] != 'solution' or p.is_absolute()
                        or '..' in p.parts or '\\' in item.filename
                        or stat.S_ISLNK(item.external_attr >> 16) or item.is_dir()):
                    raise ValueError(f'Unsafe or unsupported entry: {item.filename}')
            manifest=json.loads(archive.read('solution/MANIFEST.json'))
            entries=manifest['files']
            expected={'solution/'+entry['path'] for entry in entries}
            if len(entries) != len(expected) or set(names) != expected | {'solution/MANIFEST.json'}:
                raise ValueError('Manifest and ZIP membership differ')
            for entry in entries:
                data=archive.read('solution/'+entry['path'])
                if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                    raise ValueError(f"Manifest hash mismatch: {entry['path']}")
            for required in ('INSTRUCTION.md','SDD.md','Dockerfile','docker-compose.yml',
                             'code/src/server.ts','code/package-lock.json','code/configs/release-offline.env'):
                if 'solution/'+required not in names:
                    raise ValueError(f'Missing required file: {required}')
            archive.extractall(temporary)
        result={'archive':str(archive_path),'sha256':digest,'files':len(names),'archive_integrity':'passed',
                'runtime_validation':'not_run','checks':[],'docker_cold_start':'not_run_by_this_script'}
        if not args.check_only:
            args.logs.mkdir(parents=True,exist_ok=True)
            env={key:value for key,value in os.environ.items() if not key.startswith('MEMORY_') and key not in ('HOST','PORT','NODE_OPTIONS','NODE_ENV')}
            code=Path(temporary)/'solution/code'
            commands=[('install',['npm','ci']),('typecheck',['npm','run','typecheck']),
                                   ('build',['npm','run','build']),('tests',['npm','test']),
                                   ('smoke',['npm','run','smoke:self'])]
            if args.include_enhanced:
                commands.append(('enhanced-degraded',['node','scripts/smoke.mjs','--self','--dead-models']))
            for label, command in commands:
                start=time.monotonic()
                print(f'Running packaged {label}; log: {args.logs / (label + ".log")}',flush=True)
                with (args.logs/(label+'.log')).open('w') as log:
                    run=subprocess.run(command,cwd=code,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=900)
                result['checks'].append({'name':label,'exit_code':run.returncode,'seconds':round(time.monotonic()-start,3)})
                if run.returncode:
                    result['runtime_validation']='failed'
                    (args.logs/'result.json').write_text(json.dumps(result,indent=2)+'\n')
                    raise RuntimeError(f'Packaged {label} failed; see {args.logs / (label + ".log")}')
            result['runtime_validation']='passed'
            result['node']=subprocess.check_output(['node','--version'],text=True).strip()
            (args.logs/'result.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result,ensure_ascii=False))


if __name__ == '__main__':
    main()
