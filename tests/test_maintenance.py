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
import time
import urllib.request
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class ProcessControlTests(unittest.TestCase):
    def test_unrelated_pid_is_preserved(self):
        """Reject PID files pointing to unrelated live processes."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            shutil.copy(ROOT / 'scripts/process.sh', root / 'scripts/process.sh')
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
        """Start a detached web fixture, reuse its PID, and confirm shutdown."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            shutil.copy(ROOT / 'scripts/process.sh', root / 'scripts/process.sh')
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            (root / 'scripts/process.sh').write_text((ROOT / 'scripts/process.sh').read_text().replace('5173', str(port)))
            vite = root / 'web/server.js'
            vite.parent.mkdir(parents=True)
            (root / 'web/dist').mkdir()
            (root / 'web/dist/index.html').write_text('fixture')
            vite.write_text("require('http').createServer((req,res)=>res.end('ready')).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');")
            for script in ['start-web.sh', 'stop-web.sh']:
                (root / script).write_text((ROOT / script).read_text().replace('5173', str(port)))
            try:
                start = subprocess.run(['bash', str(root / 'start-web.sh'), '-d'], capture_output=True, timeout=15)
                self.assertEqual(start.returncode, 0, start.stderr)
                self.assertFalse((root / 'web-control.lock').exists())
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

    def test_foreground_web_releases_lock_after_readiness(self):
        """Keep foreground chat stoppable after startup releases its control lock."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            shutil.copy(ROOT / 'scripts/process.sh', root / 'scripts/process.sh')
            with socket.socket() as listener:
                listener.bind(('127.0.0.1', 0))
                port = listener.getsockname()[1]
            (root / 'scripts/process.sh').write_text((ROOT / 'scripts/process.sh').read_text().replace('5173', str(port)))
            vite = root / 'web/server.js'
            vite.parent.mkdir(parents=True)
            (root / 'web/dist').mkdir()
            (root / 'web/dist/index.html').write_text('fixture')
            vite.write_text("require('http').createServer((req,res)=>res.end('ready')).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');")
            for script in ['start-web.sh', 'stop-web.sh']:
                (root / script).write_text((ROOT / script).read_text().replace('5173', str(port)))
            process = subprocess.Popen(['bash', str(root / 'start-web.sh')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(100):
                    if (root / 'web.pid').exists() and not (root / 'web-control.lock').exists():
                        break
                    time.sleep(0.05)
                self.assertIsNone(process.poll())
                self.assertFalse((root / 'web-control.lock').exists())
                with urllib.request.urlopen(f'http://127.0.0.1:{port}', timeout=2) as response:
                    self.assertEqual(response.read(), b'ready')
                stopped = subprocess.run(['bash', str(root / 'stop-web.sh')], capture_output=True, timeout=15)
                self.assertEqual(stopped.returncode, 0, stopped.stderr)
                process.wait(timeout=5)
                self.assertFalse((root / 'web.pid').exists())
            finally:
                if (root / 'web.pid').exists():
                    os.kill(int((root / 'web.pid').read_text()), 15)
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)

    def test_overlapping_commands_are_rejected(self):
        """Every service rejects overlapping control commands without replacing its PID."""
        for service, scripts in [('web', ['start-web.sh', 'stop-web.sh']),
                                 ('server', ['start.sh', 'stop.sh']),
                                 ('tunnel', ['share.sh', 'stop-share.sh'])]:
            with self.subTest(service=service), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / 'scripts').mkdir()
                shutil.copy(ROOT / 'scripts/process.sh', root / 'scripts/process.sh')
                (root / f'{service}-control.lock').mkdir()
                (root / f'{service}.pid').write_text('4242')
                for script in scripts:
                    shutil.copy(ROOT / script, root / script)
                    result = subprocess.run(['bash', str(root / script)], capture_output=True)
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertIn(f'Another {service} control command'.encode(), result.stderr)
                    self.assertEqual((root / f'{service}.pid').read_text(), '4242')
                    self.assertTrue((root / f'{service}-control.lock').exists())

    def test_shutdown_states(self):
        """Check zombies, delayed exit, and timeout without signaling live services."""
        for script, pidfile in [('stop-web.sh', 'web.pid'), ('stop-share.sh', 'tunnel.pid'), ('stop.sh', 'server.pid')]:
            for mode in ['zombie', 'delayed', 'timeout']:
                with self.subTest(script=script, mode=mode), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    (root / 'scripts').mkdir()
                    shutil.copy(ROOT / 'scripts/process.sh', root / 'scripts/process.sh')
                    commands = root / 'commands'
                    commands.mkdir()
                    (root / script).write_text((ROOT / script).read_text())
                    (root / pidfile).write_text('4242')
                    command = (f'node {root}/web/server.js --port 5173'
                               if script == 'stop-web.sh' else f'{root}/bin/cloudflared tunnel --url fixture'
                               if script == 'stop-share.sh' else f'{root}/runtime/bin/mac/llama-server --model fixture')
                    (commands / 'ps').write_text(f"#!/bin/bash\nif [ \"$4\" = stat= ]; then\n"
                                                f" if [ '{mode}' = zombie ]; then echo Z; "
                                                f"elif [ '{mode}' = delayed ] && [ -f '{root}/slept' ]; then exit 1; "
                                                f"else echo S; fi\nelse echo '{command}'; fi\n")
                    (commands / 'sleep').write_text(f"#!/bin/bash\ntouch '{root}/slept'\n")
                    for path in commands.iterdir():
                        path.chmod(0o755)
                    env = dict(os.environ, PATH=f'{commands}:{os.environ["PATH"]}')
                    # Override Bash's kill builtin only inside the fixture subprocess.
                    result = subprocess.run(['bash', '-c', 'kill() { return 0; }; source "$0"',
                                             str(root / script)], env=env, capture_output=True, timeout=5)
                    self.assertEqual(result.returncode, 1 if mode == 'timeout' else 0, result.stderr)
                    self.assertEqual((root / pidfile).exists(), mode == 'timeout')
                    self.assertEqual((root / 'slept').exists(), mode != 'zombie')

    def test_stale_pid_is_removed(self):
        """Remove records for processes that have already exited."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            shutil.copy(ROOT / 'scripts/process.sh', root / 'scripts/process.sh')
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


class SetupTests(unittest.TestCase):
    def test_unsupported_platform_stops_before_downloads(self):
        """Reject unsupported systems before invoking any installation step."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copy(ROOT / 'setup.sh', root / 'setup.sh')
            (root / 'uname').write_text('#!/bin/bash\necho Linux\n')
            (root / 'uname').chmod(0o755)
            env = dict(os.environ, PATH=f'{root}:{os.environ["PATH"]}')
            result = subprocess.run(['bash', str(root / 'setup.sh')], env=env, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn(b'requires macOS on Apple Silicon', result.stderr)
            self.assertFalse((root / 'runtime').exists())

    def test_missing_prerequisite_stops_before_downloads(self):
        """Report missing npm before fetching the model or runtime."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copy(ROOT / 'setup.sh', root / 'setup.sh')
            for tool in ['dirname', 'python3', 'node']:
                (root / tool).symlink_to(shutil.which(tool))
            (root / 'uname').write_text('#!/bin/bash\nif [ "$1" = -s ]; then echo Darwin; else echo arm64; fi\n')
            (root / 'uname').chmod(0o755)
            result = subprocess.run(['/bin/bash', str(root / 'setup.sh')], env=dict(os.environ, PATH=str(root)), capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn(b'Missing prerequisite: npm', result.stderr)
            self.assertFalse((root / 'runtime').exists())

    def test_wrong_runtime_is_rejected_without_replacing_it(self):
        """Leave an existing incompatible runtime intact and explain the mismatch."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'scripts').mkdir()
            shutil.copy(ROOT / 'scripts/download_runtime.sh', root / 'scripts/download_runtime.sh')
            binary = root / 'runtime/bin/mac/llama-server'
            binary.parent.mkdir(parents=True)
            binary.write_text('#!/bin/bash\necho "version: wrong build"\n')
            binary.chmod(0o755)
            result = subprocess.run(['bash', str(root / 'scripts/download_runtime.sh')], capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn(b'does not match prism-b10709-9a9394a', result.stderr)
            self.assertTrue(binary.exists())


class DownloadTests(unittest.TestCase):
    def run_download(self, wrong_range=False):
        """Download mocked byte ranges and check publication and descriptor cleanup."""
        spec = importlib.util.spec_from_file_location('download_model', ROOT / 'scripts/download_model.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        data = b'abcdefgh' * 8
        descriptors = []
        real_open = os.open

        def track_open(*args):
            """Record descriptors so the test can check closure after download."""
            fd = real_open(*args)
            descriptors.append(fd)
            return fd

        def response(request, timeout):
            """Return model bytes with valid or deliberately incorrect range headers."""
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
        """Replace an oversized partial file with the verified model bytes."""
        self.run_download()

    def test_wrong_range_is_rejected_and_descriptor_closed(self):
        """Reject incorrect range headers without publishing or leaking descriptors."""
        self.run_download(wrong_range=True)


if __name__ == '__main__':
    unittest.main()
