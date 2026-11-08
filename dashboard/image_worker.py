"""Private, sequential preview worker. JSON lines on stdin/stdout; no network."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import warnings

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 60_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)
PROFILES = {'grid': 640, 'detail': 1600}
CACHE_LIMIT = 512 * 1024 * 1024


def preview(inbox, cache, job):
    source = Path(job['path']).resolve(strict=True)
    if not source.is_relative_to(inbox) or source == inbox:
        raise ValueError('The saved photo is outside the configured archive')
    expected = job['sha1']
    if not re.fullmatch('[a-f0-9]{40}', expected):
        raise ValueError('A verified original checksum is required')
    profile = job['profile']
    if profile not in PROFILES:
        raise ValueError('Unknown preview size')
    with source.open('rb') as original:
        before = os.fstat(original.fileno())
        if before.st_size != job['bytes']:
            raise ValueError('The saved photo changed')
        identity = f'v1:{expected}:{before.st_size}:{before.st_mtime_ns}:{before.st_ctime_ns}:{profile}'
        target = cache / (hashlib.sha256(identity.encode()).hexdigest() + '.jpg')
        if target.is_file():
            os.utime(target, None)
            return {'path': str(target), 'cached': True}
        digest = hashlib.sha1()
        for chunk in iter(lambda: original.read(1024 * 1024), b''):
            digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError('The saved photo changed')
        original.seek(0)
        with Image.open(original) as image:
            # Sony JPEGs can contain an MPO secondary image; use the primary frame.
            if image.format not in ('JPEG', 'PNG', 'MPO'):
                raise ValueError('The saved file is not a supported photo')
            image.draft('RGB', (PROFILES[profile], PROFILES[profile]))
            oriented = ImageOps.exif_transpose(image)
            oriented.thumbnail((PROFILES[profile], PROFILES[profile]), Image.Resampling.LANCZOS)
            if oriented.mode in ('RGBA', 'LA') or 'transparency' in oriented.info:
                rgba = oriented.convert('RGBA')
                output = Image.new('RGB', rgba.size, 'white')
                output.paste(rgba, mask=rgba.getchannel('A'))
            else:
                output = oriented.convert('RGB')
            after = os.fstat(original.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('The saved photo changed during processing')
            fd, temporary = tempfile.mkstemp(prefix='preview-', suffix='.tmp', dir=cache)
            try:
                with os.fdopen(fd, 'wb') as destination:
                    output.save(destination, format='JPEG', quality=82, optimize=True)
                os.replace(temporary, target)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
    # Only generated previews in this dedicated cache are eligible for eviction.
    entries = sorted((p for p in cache.glob('*.jpg') if re.fullmatch('[a-f0-9]{64}\\.jpg', p.name)), key=lambda p: p.stat().st_mtime_ns)
    total = sum(p.stat().st_size for p in entries)
    for entry in entries:
        if total <= CACHE_LIMIT:
            break
        if entry != target:
            size = entry.stat().st_size
            entry.unlink()
            total -= size
    return {'path': str(target), 'cached': False, 'width': output.width, 'height': output.height}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--inbox', required=True)
    parser.add_argument('--cache', required=True)
    args = parser.parse_args()
    inbox = Path(args.inbox).resolve(strict=True)
    cache = Path(args.cache).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    if os.name == 'nt':
        import ctypes
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
    for line in sys.stdin:
        job = {}
        try:
            if len(line) > 32_768:
                raise ValueError('Preview request too large')
            job = json.loads(line)
            if not isinstance(job, dict):
                job = {}
                raise ValueError('A preview request object is required')
            result = {'id': job['id'], 'ok': True, **preview(inbox, cache, job)}
        except Exception as error:
            message = str(error) if isinstance(error, ValueError) else 'The photo preview could not be generated'
            result = {'id': job.get('id'), 'ok': False, 'error': message}
        print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
