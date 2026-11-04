"""Offline instance archives; no Docker, provider requests or credential output."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tarfile

GIB = 1024 ** 3
MAX_ENTRIES = 100000
META = 'opengym-backup.json'


def reserve(directory, additional_bytes=0):
    """Leave the host's disk/RAM reserve untouched, including during backups."""
    available = next(int(line.split()[1]) * 1024 for line in
                     Path('/proc/meminfo').read_text().splitlines()
                     if line.startswith('MemAvailable:'))
    if shutil.disk_usage(directory).free < 20 * GIB + additional_bytes or available < 2 * GIB:
        raise ValueError('At least 20 GiB free disk plus operation size and 2 GiB available RAM required')


def regular_tree(directory):
    root = Path(directory)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Data must be an existing directory, never a symlink')
    entries = []
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            item = Path(base) / name
            info = item.lstat()
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)) or info.st_nlink > 1 and item.is_file():
                raise ValueError('Links and special files are refused')
            entries.append((item, info))
            if len(entries) > MAX_ENTRIES:
                raise ValueError('Archive entry limit exceeded')
    return entries


def private_write(path, data):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def backup(data, output, metadata, guard=reserve):
    """Caller must have stopped the API; archive all account/Nutrition/media data."""
    data, output = Path(data), Path(output)
    entries = regular_tree(data)
    if not (data / 'secret').is_file() or not (data / 'db.json').is_file():
        raise ValueError('An initialized instance with secret and db.json is required')
    if output.exists() or output.with_suffix(output.suffix + '.sha256').exists():
        raise ValueError('Backup and checksum destinations must be new')
    budget = int(sum(info.st_size + 2048 for _, info in entries) * 1.05) + 1024 ** 2
    guard(output.parent, budget)
    partial = output.with_name(output.name + '.partial')
    with open(os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as stream:
        with tarfile.open(fileobj=stream, mode='w:gz', dereference=False) as archive:
            payload = json.dumps({'format': 'opengym-selfhost-backup', 'version': 1,
                                  'origin': metadata['origin'], 'release': metadata['release'],
                                  'catalogue': metadata.get('catalogue', 'none')}).encode()
            item = tarfile.TarInfo(META)
            item.size, item.mode = len(payload), 0o600
            archive.addfile(item, io.BytesIO(payload))
            for index, (path, before) in enumerate(entries):
                if path.lstat() != before:
                    raise ValueError('Data changed while making offline backup')
                archive.add(path, arcname='data/' + path.relative_to(data).as_posix(), recursive=False)
                if index % 100 == 0:
                    guard(output.parent)
        stream.flush()
        os.fsync(stream.fileno())
    with open(partial, 'rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    # A failed operation leaves only .partial, never a valid-looking archive.
    os.link(partial, output)
    partial.unlink()
    private_write(output.with_name(output.name + '.sha256'), (digest + '  ' + output.name + '\n').encode())
    return output


def restore(archive_path, target, origin, guard=reserve):
    """Validate the entire archive before extracting into a new private directory."""
    archive_path, target = Path(archive_path), Path(target)
    if target.exists() or target.is_symlink():
        raise ValueError('Restore destination must be new; existing data is never overwritten')
    checksum = archive_path.with_name(archive_path.name + '.sha256').read_text().split()
    with open(archive_path, 'rb') as stream:
        actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if len(checksum) < 1 or checksum[0] != actual:
        raise ValueError('Backup checksum mismatch')
    with tarfile.open(archive_path, 'r:gz') as archive:
        members, entry_types, required_directories, total = [], {}, set(), 0
        metadata = None
        for item in archive:
            name = PurePosixPath(item.name)
            if (item.name in entry_types or name.is_absolute() or '..' in name.parts or
                    '\\' in item.name or not (item.isfile() or item.isdir()) or
                    item.size < 0 or item.name != name.as_posix()):
                raise ValueError('Unsafe archive entry')
            entry_types[item.name] = 'file' if item.isfile() else 'directory'
            required_directories.update(parent.as_posix() for parent in name.parents if parent.parts)
            if item.name == META:
                if not item.isfile() or item.size > 4096:
                    raise ValueError('Invalid backup metadata')
                metadata = json.load(archive.extractfile(item))
            elif len(name.parts) < 2 or name.parts[0] != 'data':
                raise ValueError('Unexpected archive path')
            else:
                total += item.size
                members.append(item)
            if len(entry_types) > MAX_ENTRIES:
                raise ValueError('Archive entry limit exceeded')
        # Check the complete path graph before creating the destination. This
        # catches a file ancestor in either archive order, including implicit dirs.
        if any(entry_types.get(name) == 'file' for name in required_directories):
            raise ValueError('Archive path has a file ancestor')
        if (not isinstance(metadata, dict) or metadata.get('format') != 'opengym-selfhost-backup' or
                metadata.get('version') != 1 or metadata.get('origin') != origin or
                any(entry_types.get(name) != 'file' for name in ('data/secret', 'data/db.json'))):
            raise ValueError('Backup metadata/origin/required data mismatch')
        guard(target.parent, total + 1024 ** 2)
        target.mkdir(mode=0o700)
        for item in members:
            destination = target.joinpath(*PurePosixPath(item.name).parts[1:])
            if item.isdir():
                destination.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with archive.extractfile(item) as source:
                with open(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                    output.flush()
                    os.fsync(output.fileno())
        regular_tree(target)
    return metadata
