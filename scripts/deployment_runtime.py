#!/usr/bin/env python3
"""Start an installed platform, opening a browser only for local deployments."""
import http.client
import json
from pathlib import Path
import ssl
import subprocess
import sys
import threading
import time
import webbrowser
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


def wait_and_open(process, state):
    # Verify our own backend locally; DNS/NAT is not needed for the readiness probe.
    config = json.loads((ROOT / 'config/platform.installed.json').read_text(encoding='utf-8'))
    context = ssl.create_default_context(cafile=str(ROOT / 'data/tls/root-ca.pem'))
    address = urlsplit(state['url'])
    # The connection goes to loopback, but SNI and certificate verification use the public name.
    for _ in range(120):
        if process.poll() is not None:
            return
        connection = http.client.HTTPSConnection(address.hostname, address.port, context=context, timeout=1)
        try:
            import socket
            connection.sock = context.wrap_socket(socket.create_connection(('127.0.0.1', config['port']), timeout=1),
                                                 server_hostname=address.hostname)
            connection.request('GET', '/api/platform', headers={'Host': address.netloc})
            response = connection.getresponse()
            payload = json.loads(response.read())
            if response.status == 200 and payload.get('demoAccounts') is False:
                webbrowser.open(state['url'])
                return
        except (OSError, ValueError, http.client.HTTPException):
            pass
        finally:
            connection.close()
        time.sleep(0.5)
    print('未能确认平台已就绪，请检查上面的服务日志。', flush=True)


def main():
    state = json.loads((ROOT / 'data/deployment.json').read_text(encoding='utf-8'))
    print(f'平台访问地址：{state["url"]}\n按 Ctrl+C 停止平台。', flush=True)
    process = subprocess.Popen([sys.executable, str(ROOT / 'platform_server.py'),
                                '--config', str(ROOT / 'config/platform.installed.json')], cwd=ROOT)
    if state['mode'] == '1':
        threading.Thread(target=wait_and_open, args=(process, state), daemon=True).start()
    try:
        return process.wait()
    except KeyboardInterrupt:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        return 0


if __name__ == '__main__':
    sys.exit(main())
