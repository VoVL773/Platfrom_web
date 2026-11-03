"""Installer integration: real certificates, deployed backend, login and safe reruns."""
import http.client
import json
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install
from scripts import deployment_runtime


class InstallerTest(unittest.TestCase):
    def test_installed_server_login_and_rerun(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'installed space'
            sockets = [socket.socket(), socket.socket()]
            for item in sockets:
                item.bind(('127.0.0.1', 0))
            web_port, mqtt_port = [item.getsockname()[1] for item in sockets]
            for item in sockets:
                item.close()
            inputs = ['2', str(target), '127.0.0.1', '', str(web_port), str(mqtt_port),
                      '1', 'new_admin', '平台管理员']
            real_run = subprocess.run

            def run(command, **kwargs):
                if command[1:4] == ['-m', 'pip', 'install']:
                    return subprocess.CompletedProcess(command, 0)
                return real_run(command, **kwargs)

            with patch('builtins.input', side_effect=inputs), \
                    patch('getpass.getpass', return_value='installation-test-password'), \
                    patch.object(install.venv.EnvBuilder, 'create'), \
                    patch.object(install, 'python_path', return_value=Path(sys.executable)), \
                    patch.object(install.subprocess, 'run', side_effect=run):
                install.install()
            config = json.loads((target / 'config/platform.installed.json').read_text())
            self.assertTrue(config['production'])
            self.assertFalse((target / '.git').exists())
            self.assertFalse((target / 'data/tls').stat().st_mode & 0o077)
            for filename in ['start-platform.sh', 'open-platform.sh']:
                subprocess.run(['bash', '-n', str(target / filename)], check=True)
            process = subprocess.Popen([sys.executable, str(target / 'scripts/deployment_runtime.py')],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                context = ssl.create_default_context(cafile=str(target / 'data/tls/root-ca.pem'))
                for _ in range(100):
                    if process.poll() is not None:
                        self.fail('安装后的平台提前退出')
                    try:
                        connection = http.client.HTTPSConnection('127.0.0.1', web_port, context=context, timeout=1)
                        connection.request('GET', '/api/platform')
                        response = connection.getresponse()
                        payload = json.loads(response.read())
                        self.assertFalse(payload['demoAccounts'])
                        connection.close()
                        break
                    except OSError:
                        time.sleep(0.1)
                else:
                    self.fail('安装后的平台未就绪')
                connection = http.client.HTTPSConnection('127.0.0.1', web_port, context=context)
                connection.request('POST', '/api/login', json.dumps({'username': 'new_admin',
                                   'password': 'installation-test-password'}), {'Content-Type': 'application/json'})
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())['user']['role'], 'admin')
                connection.close()
                with patch.object(deployment_runtime, 'ROOT', target), \
                        patch('webbrowser.open', return_value=True) as browser:
                    deployment_runtime.wait_and_open(process, {'url': f'https://localhost:{web_port}'})
                    browser.assert_called_once_with(f'https://localhost:{web_port}')
            finally:
                # Signal the foreground launcher as a terminal Ctrl+C would.
                import signal
                process.send_signal(signal.SIGINT)
                process.wait(timeout=15)
            original = (target / 'data/platform.sqlite3').read_bytes()
            (target / 'open-platform.py').unlink()
            with patch('builtins.input', side_effect=['2', str(target)]):
                install.install()
            self.assertEqual(original, (target / 'data/platform.sqlite3').read_bytes())
            self.assertIn(f'https://127.0.0.1:{web_port}', (target / 'open-platform.py').read_text())

    def test_reject_nonempty_destination_and_invalid_addresses(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / 'keep.txt'
            marker.write_text('keep')
            with patch('builtins.input', side_effect=['1', temporary]):
                with self.assertRaises(ValueError):
                    install.install()
            self.assertEqual(marker.read_text(), 'keep')
        for value in ['https://example.com', 'example.com/path', '999.999.1.1', '0.0.0.0']:
            with self.assertRaises(ValueError, msg=value):
                install.host(value)

    def test_local_access_script_is_portable(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary)
            install.generate_launchers(target, 'https://127.0.0.1:8443', '1')
            code = (target / 'open-platform.py').read_text()
            with patch('webbrowser.open', return_value=True) as browser:
                exec(compile(code, 'open-platform.py', 'exec'), {})
            browser.assert_called_once_with('https://127.0.0.1:8443')


if __name__ == '__main__':
    unittest.main()
