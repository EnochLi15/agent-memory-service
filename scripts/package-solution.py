#!/usr/bin/env python3
"""Build the standalone judge archive from an explicit source allowlist."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ['INSTRUCTION.md', 'SDD.md', 'README.md', 'UPSTREAM.md', 'Dockerfile',
         'docker-compose.yml', 'docker-compose.enhanced.yml', '.dockerignore', '.gitignore', '.env.example',
         '.node-version', 'package.json', 'package-lock.json', 'tsconfig.json']
TREES = ['src', 'tests', 'contracts', 'upstream', '.github']
DOCUMENTS = ['docs/VALIDATION.md', 'docs/CONFIGURATION.md', 'docs/DELIVERY-CHECKLIST.md']
SCRIPTS = ['scripts/build.mjs', 'scripts/dev.mjs', 'scripts/smoke.mjs',
           'scripts/package-solution.py', 'scripts/verify-solution.py']
EXCLUDED = {'.git', 'node_modules', 'dist', '.data', 'artifacts', 'delivery-output',
            '__pycache__', '.coverage', '.DS_Store'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def skip(path):
    return (any(p in EXCLUDED or p.startswith('.data-') for p in path.parts)
            or path.name == '.env' or path.name.startswith('.env.') and path.name != '.env.example'
            or any(path.name.endswith(s) for s in ('.log', '.pyc', '.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.zip')))


def git(*args):
    result = subprocess.run(['git', *args], cwd=ROOT, text=True, capture_output=True)
    return result.stdout.strip() if result.returncode == 0 else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'delivery-output/solution.zip')
    args = parser.parse_args()
    output = args.output.resolve()
    if output.suffix != '.zip':
        parser.error('--output must end with .zip')
    paths = [ROOT / name for name in FILES + DOCUMENTS + SCRIPTS]
    paths += [ROOT / 'configs' / f'release-{mode}.env' for mode in ('offline', 'enhanced')]
    paths.append(ROOT / 'configs/models.env.example')
    for tree in TREES:
        for path in (ROOT / tree).rglob('*'):
            relative = path.relative_to(ROOT)
            if not skip(relative) and path.is_symlink():
                raise ValueError(f'Symlinks are not packaged: {relative}')
            if path.is_file() and not skip(relative):
                paths.append(path)
    payload = {}
    for path in sorted(set(paths)):
        if path.is_symlink():
            raise ValueError(f'Symlink: {path.relative_to(ROOT)}')
        payload['code/' + path.relative_to(ROOT).as_posix()] = path.read_bytes()
    # Root documents retain working links in both repository and archive forms.
    for name in ('INSTRUCTION.md', 'SDD.md'):
        payload[name] = (payload['code/' + name].decode()
                         .replace('](docs/', '](code/docs/')
                         .replace('](UPSTREAM.md)', '](code/UPSTREAM.md)')).encode()
    dockerfile = payload['code/Dockerfile'].decode()
    if dockerfile.count('ARG SOURCE_DIR=.') != 2:
        raise ValueError('Dockerfile source-directory declarations changed; review archive layout')
    payload['Dockerfile'] = dockerfile.replace('ARG SOURCE_DIR=.', 'ARG SOURCE_DIR=code').encode()
    for name in ('docker-compose.yml', 'docker-compose.enhanced.yml'):
        payload[name] = payload['code/' + name].replace(b'- configs/', b'- code/configs/')
    payload['.dockerignore'] = payload['code/.dockerignore']
    # Block recognizable private keys/tokens without ever printing matched values.
    credential = re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|\bgh[pousr]_[A-Za-z0-9]{30,}')
    for name, data in payload.items():
        if credential.search(data):
            raise ValueError(f'Possible credential in {name}; inspect locally before packaging')
    manifest = {
        'format': 'agent-memory-solution-v1',
        'created_at': datetime.now(timezone.utc).isoformat(),
        'source_commit': git('rev-parse', 'HEAD'),
        'source_dirty': bool(git('status', '--porcelain')),
        'source_identity': 'SHA-256 file manifest',
        'default_profile': 'code/configs/release-offline.env',
        'files': [{'path': name, 'bytes': len(data), 'sha256': sha(data)} for name, data in sorted(payload.items())],
    }
    payload['MANIFEST.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.zip.partial')
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(payload.items()):
                info = zipfile.ZipInfo('solution/' + name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
        with zipfile.ZipFile(temporary) as archive:
            if archive.testzip() is not None:
                raise ValueError('ZIP CRC verification failed')
            for name, data in payload.items():
                if archive.read('solution/' + name) != data:
                    raise ValueError(f'ZIP readback mismatch: {name}')
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    digest = sha(output.read_bytes())
    output.with_suffix('.zip.sha256').write_text(f'{digest}  {output.name}\n')
    print(json.dumps({'archive': str(output), 'bytes': output.stat().st_size,
                      'files': len(payload), 'sha256': digest}, ensure_ascii=False))


if __name__ == '__main__':
    main()
