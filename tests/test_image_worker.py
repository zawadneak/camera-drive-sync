import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image

SCRIPT = Path(__file__).resolve().parents[1] / 'dashboard' / 'image_worker.py'
SPEC = importlib.util.spec_from_file_location('image_worker', SCRIPT)
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='camera-worker-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.inbox = self.root / 'inbox'
        self.cache = self.root / 'cache'
        self.inbox.mkdir()
        self.cache.mkdir()
        self.original = self.inbox / 'TEST.JPG'
        image = Image.new('RGB', (4000, 2000), '#317557')
        exif = Image.Exif()
        exif[274] = 6
        image.save(self.original, quality=95, exif=exif)
        self.before = self.original.read_bytes()
        self.job = {'id': 1, 'path': str(self.original), 'sha1': hashlib.sha1(self.before).hexdigest(), 'bytes': len(self.before), 'profile': 'grid'}

    def generate(self, **updates):
        return WORKER.preview(self.inbox, self.cache, {**self.job, **updates})

    def test_resizes_rotates_and_preserves_original(self):
        result = self.generate()
        with Image.open(result['path']) as image:
            self.assertEqual(image.size, (320, 640))
            self.assertIsNone(image.getexif().get(274))
        self.assertLess(Path(result['path']).stat().st_size, len(self.before))
        self.assertEqual(self.original.read_bytes(), self.before)

    def test_cache_reused_and_detail_separate(self):
        first = self.generate()
        self.assertFalse(first['cached'])
        self.assertTrue(self.generate()['cached'])
        detail = self.generate(profile='detail')
        self.assertNotEqual(first['path'], detail['path'])
        with Image.open(detail['path']) as image:
            self.assertEqual(image.size, (800, 1600))

    def test_sony_style_mpo_uses_primary_image(self):
        Image.new('RGB', (2400, 1600), 'red').save(self.original, format='MPO', save_all=True, append_images=[Image.new('RGB', (600, 400), 'blue')])
        body = self.original.read_bytes()
        result = self.generate(sha1=hashlib.sha1(body).hexdigest(), bytes=len(body))
        with Image.open(result['path']) as image:
            self.assertLessEqual(max(image.size), 640)
            red, green, blue = image.getpixel((10, 10))
            self.assertGreater(red, blue)

    def test_changed_original_is_not_hidden_by_cache(self):
        self.generate()
        changed = bytearray(self.before)
        changed[50] ^= 1
        self.original.write_bytes(changed)
        timestamp = self.original.stat().st_mtime_ns + 10_000_000
        os.utime(self.original, ns=(timestamp, timestamp))
        with self.assertRaisesRegex(ValueError, 'changed'):
            self.generate()

    def test_outside_archive_and_unknown_size_rejected(self):
        outside = self.root / 'outside.jpg'
        outside.write_bytes(self.before)
        with self.assertRaisesRegex(ValueError, 'outside'):
            self.generate(path=str(outside))
        with self.assertRaisesRegex(ValueError, 'Unknown'):
            self.generate(profile='huge')

    def test_json_protocol_recovers_after_bad_request(self):
        jobs = [{'id': 2, **self.job, 'profile': 'huge'}, {**self.job, 'id': 3}]
        result = subprocess.run([sys.executable, str(SCRIPT), '--inbox', str(self.inbox), '--cache', str(self.cache)], input=''.join(json.dumps(job)+'\n' for job in jobs), text=True, capture_output=True, check=True)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertFalse(responses[0]['ok'])
        self.assertTrue(responses[1]['ok'])
        self.assertEqual(responses[1]['id'], 3)


if __name__ == '__main__':
    unittest.main()
