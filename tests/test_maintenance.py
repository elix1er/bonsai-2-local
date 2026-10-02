import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class ProcessControlTests(unittest.TestCase):
    def test_unrelated_pid_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process = subprocess.Popen(['sleep', '60'])
            try:
                for script, pidfile in [('stop-web.sh', 'web.pid'),
                                        ('stop.sh', 'server.pid'),
                                        ('stop-share.sh', 'tunnel.pid')]:
                    shutil.copy(ROOT / script, root / script)
                    (root / pidfile).write_text(str(process.pid))
                    result = subprocess.run(['bash', str(root / script)], capture_output=True)
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertIsNone(process.poll())
                    self.assertTrue((root / pidfile).exists())
            finally:
                process.terminate()
                process.wait()

    def test_background_web_lifecycle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            vite = root / 'web/node_modules/vite/bin/vite.js'
            vite.parent.mkdir(parents=True)
            vite.write_text("require('http').createServer((req,res)=>res.end('ready')).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');")
            for script in ['start-web.sh', 'stop-web.sh']:
                (root / script).write_text((ROOT / script).read_text().replace('5173', str(port)))
            try:
                start = subprocess.run(['bash', str(root / 'start-web.sh'), '-d'], capture_output=True, timeout=15)
                self.assertEqual(start.returncode, 0, start.stderr)
                pid = (root / 'web.pid').read_text()
                again = subprocess.run(['bash', str(root / 'start-web.sh'), '-d'], capture_output=True)
                self.assertEqual(again.returncode, 0, again.stderr)
                self.assertEqual((root / 'web.pid').read_text(), pid)
                stopped = subprocess.run(['bash', str(root / 'stop-web.sh')], capture_output=True, timeout=15)
                self.assertEqual(stopped.returncode, 0, stopped.stderr)
                self.assertFalse((root / 'web.pid').exists())
            finally:
                if (root / 'web.pid').exists():
                    os.kill(int((root / 'web.pid').read_text()), 15)

    def test_stale_pid_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process = subprocess.Popen(['true'])
            process.wait()
            for script, pidfile in [('stop-web.sh', 'web.pid'),
                                    ('stop.sh', 'server.pid'),
                                    ('stop-share.sh', 'tunnel.pid')]:
                shutil.copy(ROOT / script, root / script)
                (root / pidfile).write_text(str(process.pid))
                result = subprocess.run(['bash', str(root / script)], capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse((root / pidfile).exists())


class DownloadTests(unittest.TestCase):
    def run_download(self, wrong_range=False):
        spec = importlib.util.spec_from_file_location('download_model', ROOT / 'scripts/download_model.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        data = b'abcdefgh' * 8
        descriptors = []
        real_open = os.open

        def track_open(*args):
            fd = real_open(*args)
            descriptors.append(fd)
            return fd

        def response(request, timeout):
            start, end = map(int, request.headers['Range'].removeprefix('bytes=').split('-'))
            stream = io.BytesIO(data[start:end + 1])
            stream.status = 206
            stream.headers = {'Content-Range': 'bytes 0-0/64' if wrong_range
                              else f'bytes {start}-{end}/{len(data)}'}
            return stream

        with tempfile.TemporaryDirectory() as directory:
            module.MODELS_DIR = Path(directory)
            module.TARGET_FILE = Path(directory) / 'model.gguf'
            module.PART_FILE = Path(directory) / 'model.part'
            module.PART_FILE.write_bytes(b'x' * 100)
            module.EXPECTED_SIZE = len(data)
            module.EXPECTED_SHA256 = hashlib.sha256(data).hexdigest()
            with patch.object(module.urllib.request, 'urlopen', response), \
                 patch.object(module.time, 'sleep'), \
                 patch.object(module.os, 'open', track_open), \
                 contextlib.redirect_stdout(io.StringIO()):
                if wrong_range:
                    with self.assertRaisesRegex(IOError, 'requested byte range'):
                        module.main()
                    self.assertFalse(module.TARGET_FILE.exists())
                else:
                    module.main()
                    self.assertEqual(module.TARGET_FILE.read_bytes(), data)
            for fd in descriptors:
                with self.assertRaises(OSError):
                    os.fstat(fd)

    def test_verified_download_replaces_oversized_partial_file(self):
        self.run_download()

    def test_wrong_range_is_rejected_and_descriptor_closed(self):
        self.run_download(wrong_range=True)


if __name__ == '__main__':
    unittest.main()
