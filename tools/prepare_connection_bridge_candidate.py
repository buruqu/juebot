"""Prepare an isolated source patch, never install or modify a dependency tree."""
from pathlib import Path
import argparse
import difflib
import hashlib
import json

BASE_SHA256 = '0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684'
OLD = '''\t} else request = new Request(url, {
\t\tmethod,
\t\theaders,
\t\tbody: Readable.toWeb(req),
\t\tsignal: abort.signal,
\t\tduplex: "half"
\t});'''
NEW = '''\t} else request = new Request(url, {
\t\tmethod,
\t\theaders,
\t\t...method !== "GET" && method !== "HEAD" ? {
\t\t\tbody: Readable.toWeb(req),
\t\t\tduplex: "half"
\t\t} : {},
\t\tsignal: abort.signal
\t});'''


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fresh_output(path):
    path = path.absolute()
    if 'node_modules' in [part.lower() for part in path.parts]:
        raise RuntimeError('Output must be outside all node_modules directories')
    if path.exists():
        raise RuntimeError('Refusing to overwrite an existing candidate: ' + str(path))
    for parent in [path, *path.parents]:
        if parent.is_symlink() or (parent.exists() and getattr(parent.lstat(), 'st_file_attributes', 0) & 0x400):
            raise RuntimeError('Linked output path forbidden')
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True)
    parser.add_argument('--module-output', required=True)
    parser.add_argument('--patch-dir', required=True)
    args = parser.parse_args()
    source = Path(args.source)
    original = source.read_bytes()
    if sha(original) != BASE_SHA256:
        raise RuntimeError('Unexpected connection baseline; review the new upstream source first')
    text = original.decode('utf-8')
    if text.count(OLD) != 1:
        raise RuntimeError('Bridge source shape drift')
    candidate = text.replace(OLD, NEW).encode('utf-8')
    target = fresh_output(Path(args.module_output))
    patch_dir = Path(args.patch_dir)
    patch_path = fresh_output(patch_dir / 'dsh-client-connection-get-head-body.patch')
    receipt_path = fresh_output(patch_dir / 'patch-receipt.json')
    patch = ''.join(difflib.unified_diff(text.splitlines(keepends=True), candidate.decode('utf-8').splitlines(keepends=True),
        fromfile='a/packages/client/connection/lib/index.js', tofile='b/packages/client/connection/lib/index.js'))
    target.write_bytes(candidate)
    patch_path.write_text(patch, encoding='utf-8', newline='\n')
    receipt = {'package': '@deepseek-ai/dsh-client-connection', 'baseVersion': '0.2.1-rc.3',
        'baseSha256': BASE_SHA256, 'candidateSha256': sha(candidate), 'patchSha256': sha(patch_path.read_bytes()),
        'candidateModule': str(target), 'installed': False, 'released': False, 'versionChanged': False,
        'scope': 'Streaming GET/HEAD omit body; POST branch body, duplex, signal and response handling preserved',
        'deployment': 'Requires reviewed official DSH runtime build/update; not a plugin-manager or live node_modules patch'}
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    if source.read_bytes() != original:
        raise RuntimeError('Original dependency changed during preparation')
    print(json.dumps(receipt, ensure_ascii=False))


if __name__ == '__main__':
    main()
