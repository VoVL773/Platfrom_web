#!/usr/bin/env python3
"""Serve the website and a local, read-only MQTT or USB serial monitor."""
import argparse
from collections import deque
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
from urllib.parse import parse_qs, urlsplit, unquote

import serial


class SerialMonitor:
    def __init__(self, device='/dev/ttyUSB0', baudrate=9600):
        self.device = device
        self.baudrate = baudrate
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.lines = deque(maxlen=500)
        self.sequence = 0
        self.status = 'connecting'
        self.error = ''
        self.thread = None

    def start(self):
        with self.lock:
            if self.thread is None:
                self.thread = threading.Thread(target=self.run, daemon=True)
                self.thread.start()

    def set_status(self, status, error=''):
        with self.lock:
            self.status, self.error = status, error

    def run(self):
        while not self.stop_event.is_set():
            self.set_status('connecting')
            try:
                with serial.Serial(self.device, self.baudrate, timeout=1, exclusive=True) as port:
                    self.set_status('connected')
                    while not self.stop_event.is_set():
                        text = port.readline(4096).decode('utf-8', errors='replace').strip()
                        if text:
                            with self.lock:
                                self.sequence += 1
                                self.lines.append({'id': self.sequence, 'time': datetime.now().astimezone().isoformat(timespec='seconds'), 'text': text})
            except (serial.SerialException, OSError) as error:
                self.set_status('error', str(error))
                self.stop_event.wait(2)
        self.set_status('stopped')

    def snapshot(self, after=0):
        with self.lock:
            return {
                'source': 'serial', 'device': self.device, 'baudrate': self.baudrate,
                'status': self.status, 'error': self.error,
                'total': self.sequence,
                'dropped': bool(self.lines and after and after < self.lines[0]['id'] - 1),
                'lines': [line.copy() for line in self.lines if line['id'] > after],
            }

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, monitors, **kwargs):
        self.monitors = monitors
        super().__init__(*args, **kwargs)

    def do_GET(self):
        path = urlsplit(self.path)
        if path.path in ('/', '/index.html') and not hasattr(self.server, 'registry'):
            content = (Path(self.directory) / 'index.html').read_text().replace(
                'name="platform-mode" content="backend"', 'name="platform-mode" content="demo"').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        if path.path in ('/api/messages', '/api/serial'):
            # Keep the hardware endpoint on the local preview origin.
            host = self.headers.get('Host', '')
            allowed = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
            origin = self.headers.get('Origin')
            if host not in allowed or (origin and origin not in {f'http://{h}' for h in allowed}):
                self.send_error(403, 'Local preview only')
                return
            try:
                after = max(0, int(parse_qs(path.query).get('after', ['0'])[0]))
            except ValueError:
                self.send_error(400, 'Invalid cursor')
                return
            source = 'usb' if path.path == '/api/serial' else parse_qs(path.query).get('source', ['mqtt'])[0]
            if source not in ('usb', 'mqtt'):
                self.send_error(400, 'Invalid source')
                return
            monitor = self.monitors.get(source)
            if monitor is None:
                self.send_error(503, 'Source not enabled; start with --source both')
                return
            monitor.start()
            payload = json.dumps(monitor.snapshot(after), ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if path.path == '/news-index.json':
            from news_content import collect_news
            payload = json.dumps(collect_news(Path(self.directory)), ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        # Only site assets are served, never local credentials, source or Git files.
        root = Path(self.directory)
        try:
            config = json.loads((root / 'platform.json').read_text())
            templates = {'/' + c['template'] for c in config['companies']
                         if c['template'].startswith('content/companies/')
                         and '..' not in c['template'] and c['template'].endswith('.md')}
        except (OSError, ValueError, KeyError):
            templates = set()
        asset = (root / unquote(path.path).lstrip('/')).resolve()
        news_image = path.path.startswith('/assets/news/') and asset.is_relative_to((root / 'assets/news').resolve()) and asset.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'}
        if path.path not in templates | {'/', '/index.html', '/app.js', '/telemetry.js', '/provisioning.js', '/platform_features.js', '/organization.js', '/visual.js', '/news.js', '/portal.js', '/styles.css', '/assets/workspace/city.jpg', '/users.json', '/platform.json', '/devices.json', '/favicon.ico', '/favicon.svg', '/favicon.png'} and not news_image:
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        self.send_error(405, 'Use GET for preview assets')

    def log_message(self, fmt, *args):
        if urlsplit(self.path).path not in ('/api/serial', '/api/messages'):
            super().log_message(fmt, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', default='/dev/ttyUSB0')
    parser.add_argument('--baudrate', type=int, default=9600)
    parser.add_argument('--port', type=int, default=8001)
    parser.add_argument('--source', choices=['serial', 'mqtt', 'both'], default='both')
    parser.add_argument('--mqtt-host', default='127.0.0.1')
    parser.add_argument('--mqtt-port', type=int, default=1883)
    parser.add_argument('--mqtt-topic', default='rd-web/test/#')
    args = parser.parse_args()
    monitors = {}
    if args.source in ('mqtt', 'both'):
        from mqtt_monitor import MQTTMonitor
        monitors['mqtt'] = MQTTMonitor(args.mqtt_host, args.mqtt_port, args.mqtt_topic)
    if args.source in ('serial', 'both'):
        monitors['usb'] = SerialMonitor(args.device, args.baudrate)
    handler = partial(Handler, monitors=monitors, directory=str(Path(__file__).resolve().parent))
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    print(f'本地预览：http://127.0.0.1:{args.port}/', flush=True)
    print('进入设备管理或 MQTT 测试后启动 MQTT 接收；USB 接收在 USB 测试中启动；Ctrl+C 停止。', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        for monitor in monitors.values():
            monitor.close()


if __name__ == '__main__':
    main()
