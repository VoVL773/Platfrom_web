#!/usr/bin/env python3
"""One-command local IoT platform: web, persistent device registry and authenticated MQTT."""
import argparse
import asyncio
from functools import partial
from http.cookies import SimpleCookie
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit, unquote, parse_qs

from device_registry import DeviceRegistry, RegistryError
from serial_server import Handler, SerialMonitor

ROOT = Path(__file__).resolve().parent


class PlatformHandler(Handler):
    def local_origin(self):
        host = self.headers.get('Host', '')
        origin = self.headers.get('Origin')
        public_origins = getattr(self.server, 'public_origins', None) or []
        scheme = 'https' if isinstance(self.connection, ssl.SSLSocket) else 'http'
        allowed = {f'{name}:{self.server.server_port}' for name in self.server.allowed_hosts}
        # Reverse proxies normally forward Host without the backend port, so bare names must pass too.
        allowed |= set(self.server.allowed_hosts)
        allowed |= {urlsplit(item).netloc for item in public_origins}
        expected = {f'{scheme}://{host}'}
        host_name = urlsplit('//' + host).hostname or host
        for item in public_origins:
            parsed = urlsplit(item)
            # Behind a proxy Host has no port; in direct HTTPS mode it does.
            if host == parsed.netloc or (parsed.hostname == host_name and parsed.scheme == scheme):
                expected.add(item)
        if host not in allowed or (origin and origin not in expected):
            raise RegistryError('访问来源不被允许。', 403)

    def cookie(self, token, age=43200):
        secure = getattr(self.server,'secure_cookies',False)
        return f'iot-session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}'+('; Secure' if secure else '')

    def respond(self, payload, status=200, cookie=None):
        content = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Length', str(len(content)))
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(content)

    def body(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                raise ValueError
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError
            return data
        except (ValueError, UnicodeError):
            raise RegistryError('请求应为不超过 16 KB 的 JSON 对象。') from None

    def session_token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
            return cookie['iot-session'].value if 'iot-session' in cookie else ''
        except Exception:
            return ''

    def user(self):
        with self.server.session_lock:
            session = self.server.sessions.get(self.session_token())
            if not session or session[1] < time.time():
                raise RegistryError('请登录本机平台。', 401)
            stored=session[0]
        user=self.server.registry.accounts.user(stored['id'],allow_demo=not getattr(self.server,'production',False))
        if user['authVersion']!=stored.get('authVersion'):
            raise RegistryError('密码已变更，请重新登录。',401)
        return user

    def device_connection(self, config, secret):
        return {'host': self.server.device_host, 'port': getattr(self.server,'device_port',self.server.mqtt_port),
                'fallbackHost': getattr(self.server,'device_host_fallback',None),
                'clientId': config['id'], 'username': config['id'], 'password': secret,
                'topic': self.server.registry.topic(config['id']), 'tls': getattr(self.server,'mqtt_tls',False),
                'caCert': getattr(self.server,'mqtt_ca','')}

    def api(self, method):
        try:
            self.local_origin()
            path = urlsplit(self.path).path
            registry = self.server.registry
            if method == 'GET' and path == '/api/platform':
                self.respond({'enabled': True, 'mqttHost': self.server.device_host,
                              'mqttFallbackHost': getattr(self.server,'device_host_fallback',None),
                              'mqttPort': getattr(self.server,'device_port',self.server.mqtt_port), 'broker': 'running',
                              'mqttTls':getattr(self.server,'mqtt_tls',False),
                              'demoAccounts':not getattr(self.server,'production',False),
                              'retentionDays':registry.retention_days,
                              'localOnly': getattr(self.server, 'mqtt_local_only', False)})
            elif method == 'POST' and path in ('/api/login','/api/register'):
                data = self.body()
                username, password = data.get('username'), data.get('password')
                if not isinstance(username, str) or not isinstance(password, str):
                    raise RegistryError('请输入账号和密码。')
                user = (registry.accounts.register(data,self.client_address[0]) if path=='/api/register' else
                        registry.accounts.authenticate(username,password,self.client_address[0],
                                                       allow_demo=not getattr(self.server,'production',False)))
                token = secrets.token_urlsafe(32)
                with self.server.session_lock:
                    now = time.time()
                    self.server.sessions = {k: v for k, v in self.server.sessions.items() if v[1] > now}
                    self.server.sessions.pop(self.session_token(), None)
                    self.server.sessions[token] = (user, now + 43200)
                self.respond({'user': user}, status=201 if path=='/api/register' else 200, cookie=self.cookie(token))
            elif method == 'GET' and path == '/api/session':
                self.respond({'user': self.user()})
            elif method == 'POST' and path == '/api/logout':
                with self.server.session_lock:
                    self.server.sessions.pop(self.session_token(), None)
                self.respond({'ok': True}, cookie=self.cookie('',0))
            elif method == 'POST' and path == '/api/account/password':
                user=self.user()
                data=self.body()
                current=data.get('currentPassword')
                if not isinstance(current,str) or len(current)>100:
                    raise RegistryError('请输入当前密码。')
                # Apply the same login throttling before checking a current password.
                registry.accounts.authenticate(user['username'],current,self.client_address[0],
                                               allow_demo=not getattr(self.server,'production',False))
                registry.accounts.change_password(user,current,data.get('newPassword'))
                self.respond({'ok':True},cookie=self.cookie('',0))
            elif method == 'GET' and path == '/api/workspace':
                self.respond(registry.organization.workspace(self.user()))
            elif method == 'GET' and path == '/api/company/members':
                self.respond({'members': registry.organization.members(self.user())})
            elif method == 'POST' and path == '/api/companies':
                self.respond({'company': registry.organization.create_company(self.user(), self.body())}, 201)
            elif method == 'POST' and path == '/api/company-admins':
                registry.organization.require(self.user(), 'admin')
                data = self.body()
                self.respond({'user': registry.accounts.create(data.get('username'), data.get('password'),
                    data.get('name'), 'company_admin', data.get('companyId'))}, 201)
            elif method == 'POST' and path == '/api/company/invites':
                user = self.user()
                registry.organization.require(user, 'company_admin')
                data = self.body()
                self.respond({'inviteCode': registry.accounts.invite(user['companyId'], data.get('role', 'customer')),
                              'expiresInDays': 7, 'uses': 1}, 201)
            elif method == 'POST' and path == '/api/company/scenes':
                self.respond({'scene': registry.organization.save_scene(self.user(), self.body())}, 201)
            elif method == 'POST' and path == '/api/company/scenes/delete':
                registry.organization.delete_scene(self.user(), self.body())
                self.respond({'ok': True})
            elif method == 'POST' and path == '/api/company/assignments':
                registry.organization.assign(self.user(), self.body())
                self.respond({'ok': True})
            elif method == 'GET' and path == '/api/devices':
                self.respond({'devices': registry.snapshot(self.user())})
            elif method == 'POST' and path == '/api/devices':
                user = self.user()
                config, secret = registry.create(user, self.body())
                self.respond({'device': config, 'connection': self.device_connection(config, secret)}, 201)
            elif method == 'GET' and path.startswith('/api/devices/') and path.endswith('/history'):
                parts=path.split('/')
                if len(parts)!=5:
                    raise RegistryError('接口不存在。',404)
                query=parse_qs(urlsplit(self.path).query)
                self.respond(registry.history(self.user(),unquote(parts[3]),query.get('start',[None])[0],
                                              query.get('end',[None])[0],query.get('before',[None])[0],query.get('limit',[200])[0]))
            elif method == 'POST' and path.startswith('/api/devices/'):
                parts = path.split('/')
                if len(parts) != 5:
                    raise RegistryError('接口不存在。', 404)
                if parts[4] == 'settings':
                    self.respond({'device': registry.update(self.user(), unquote(parts[3]), self.body())})
                    return
                result = registry.change(self.user(), unquote(parts[3]), parts[4])
                self.respond({'device': result[0], 'connection': self.device_connection(*result)} if result else {'ok': True})
            else:
                raise RegistryError('接口不存在。', 404)
        except RegistryError as error:
            self.respond({'error': str(error)}, error.status)

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/devices.json':
            types = json.loads((self.server.registry.root / 'devices.json').read_text())['scenes']
            self.respond({'scenes': types, 'devices': []})
            return
        if path == '/users.json':
            self.send_error(404)
            return
        if path.startswith('/api/') and path not in ('/api/messages', '/api/serial'):
            self.api('GET')
        elif path in ('/api/messages', '/api/serial'):
            try:
                self.local_origin()
                if self.user().get('role') != 'admin':
                    raise RegistryError('原始采集调试仅向管理员开放。', 403)
            except RegistryError as error:
                self.respond({'error': str(error)}, error.status)
                return
            super().do_GET()
        else:
            super().do_GET()

    def do_POST(self):
        self.api('POST')

    def log_message(self, fmt, *args):
        if not urlsplit(self.path).path.startswith('/api/'):
            super().log_message(fmt, *args)


class LocalBroker:
    def __init__(self, registry, host, port, certfile=None, keyfile=None):
        self.registry, self.host, self.port = registry, host, port
        self.certfile,self.keyfile=certfile,keyfile
        self.ready = threading.Event()
        self.error = None
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        try:
            asyncio.run(self.serve())
        except Exception as error:
            self.error = error
            self.ready.set()

    async def serve(self):
        from amqtt.broker import Broker
        self.loop = asyncio.get_running_loop()
        self.stop = asyncio.Event()
        listener={'type':'tcp','bind':f'{self.host}:{self.port}'}
        if self.certfile:
            listener.update(ssl=True,certfile=str(self.certfile),keyfile=str(self.keyfile))
        broker = Broker({'listeners': {'default': listener},
                         'plugins': {'platform_mqtt.DeviceAccessPlugin': {
                             'database': self.registry.database, 'root': str(self.registry.root),
                             'retention_days':self.registry.retention_days}}})
        await broker.start()
        self.ready.set()
        try:
            await self.stop.wait()
        finally:
            await broker.shutdown()

    def start(self):
        self.thread.start()
        if not self.ready.wait(15):
            raise RuntimeError('MQTT 服务启动超时。')
        if self.error:
            raise RuntimeError(f'MQTT 服务启动失败（端口可能已占用）：{self.error}')

    def close(self):
        if self.thread.is_alive():
            self.loop.call_soon_threadsafe(self.stop.set)
            self.thread.join(timeout=5)


def lan_address():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(('192.0.2.1', 80))  # Select a route; no packet is sent.
            return sock.getsockname()[0]
    except OSError:
        return '127.0.0.1'


def parse_args(argv=None):
    preliminary=argparse.ArgumentParser(add_help=False)
    preliminary.add_argument('--config',type=Path)
    known,_=preliminary.parse_known_args(argv)
    parser = argparse.ArgumentParser(description=__doc__,parents=[preliminary])
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8002)
    parser.add_argument('--mqtt-bind', default='0.0.0.0')
    parser.add_argument('--mqtt-port', type=int, default=1883)
    parser.add_argument('--device-host', help='板子可访问的 IP 或域名，不带协议和端口')
    parser.add_argument('--device-host-fallback',help='主地址连不上时板子回落的 IP 或域名，可选')
    parser.add_argument('--device-port',type=int,help='对外 MQTT 端口，默认等于 mqtt-port')
    parser.add_argument('--public-origin',action='append',help='网页完整地址，例如 https://iot.example.com；可重复或写成数组以同时支持 IP 和域名')
    parser.add_argument('--https-cert',type=Path)
    parser.add_argument('--https-key',type=Path)
    parser.add_argument('--mqtt-cert',type=Path)
    parser.add_argument('--mqtt-key',type=Path)
    parser.add_argument('--mqtt-ca',type=Path,help='供设备信任的根 CA PEM 公钥证书')
    parser.add_argument('--production',action='store_true',help='禁用演示账号，并要求 HTTPS / MQTTS')
    parser.add_argument('--retention-days',type=int,default=90)
    parser.add_argument('--database', type=Path, default=ROOT / 'data' / 'platform.sqlite3')
    parser.add_argument('--device', default='/dev/ttyUSB0')
    parser.add_argument('--baudrate', type=int, default=9600)
    if known.config:
        try:
            config=json.loads(known.config.read_text())
            valid={a.dest for a in parser._actions}-{'help','config'}
            if not isinstance(config,dict) or set(config)-valid:
                raise ValueError('存在未知配置项')
            for key in ['https_cert','https_key','mqtt_cert','mqtt_key','mqtt_ca','database']:
                if config.get(key):
                    config[key]=str((known.config.resolve().parent/config[key]).resolve())
            parser.set_defaults(**config)
        except (OSError,ValueError,TypeError) as error:
            parser.error(f'配置文件无效：{error}')
    args=parser.parse_args(argv)
    if not isinstance(args.production,bool):
        parser.error('production 必须为布尔值')
    for field in ['port','mqtt_port','device_port']:
        value=getattr(args,field)
        if value is not None and (isinstance(value,bool) or not isinstance(value,int) or not 1<=value<=65535):
            parser.error(f'{field} 必须为 1–65535')
    if isinstance(args.retention_days,bool) or not isinstance(args.retention_days,int) or not 1<=args.retention_days<=3650:
        parser.error('retention-days 必须为 1–3650')
    for cert,key in [(args.https_cert,args.https_key),(args.mqtt_cert,args.mqtt_key)]:
        if bool(cert)!=bool(key):
            parser.error('证书和私钥必须成对指定')
        if cert:
            context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version=ssl.TLSVersion.TLSv1_2
            try:
                context.load_cert_chain(cert,key)
            except (OSError,ssl.SSLError):
                parser.error('无法读取证书/私钥，或证书与私钥不匹配')
    if bool(args.mqtt_cert)!=bool(args.mqtt_ca):
        parser.error('MQTT TLS 需要同时配置 mqtt-cert、mqtt-key 和 mqtt-ca')
    if args.mqtt_ca:
        try:
            ssl.create_default_context(cafile=str(args.mqtt_ca))
        except (OSError,ssl.SSLError):
            parser.error('MQTT CA 证书无效')
    for field in ['device_host','device_host_fallback']:
        value=getattr(args,field)
        if value and (not isinstance(value,str) or not __import__('re').fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}',value)):
            parser.error(f'{field.replace("_","-")} 需为 IP 或域名，不带协议、路径和端口')
    origins=args.public_origin
    if origins is None:
        origins=[]
    elif isinstance(origins,str):
        origins=[origins]
    elif not isinstance(origins,(list,tuple)):
        parser.error('public-origin 需为 http(s)://域名[:端口] 或其数组')
    flat=[]
    for item in origins:
        flat.extend(item) if isinstance(item,(list,tuple)) else flat.append(item)
    normalized=[]
    for item in flat:
        try:
            if not isinstance(item,str):
                raise ValueError
            origin=urlsplit(item)
            if origin.scheme not in ('http','https') or not origin.hostname or origin.username or origin.password or origin.path not in ('','/') or origin.query or origin.fragment:
                raise ValueError
            origin.port
        except (ValueError,TypeError):
            parser.error('public-origin 需为 http(s)://域名[:端口]')
        item=item.rstrip('/')
        if item not in normalized:
            normalized.append(item)
    args.public_origins=normalized
    args.public_origin=normalized[0] if normalized else None
    if args.production:
        if not args.public_origins or any(not item.startswith('https://') for item in args.public_origins) or not args.mqtt_cert or not args.device_host:
            parser.error('正式模式需指定 HTTPS public-origin、device-host 和 MQTT TLS 证书')
        if not args.https_cert and args.host not in ('127.0.0.1','localhost'):
            parser.error('由反向代理提供 HTTPS 时，后端 HTTP 只监听本机回环地址')
    return args


def configure_server(server,registry,args):
    server.registry = registry
    server.sessions, server.session_lock = {}, threading.Lock()
    server.production=args.production
    server.public_origins=list(args.public_origins)
    server.public_origin=args.public_origin
    server.secure_cookies=bool(args.https_cert or any(item.startswith('https://') for item in args.public_origins))
    server.mqtt_tls=bool(args.mqtt_cert)
    server.mqtt_ca=Path(args.mqtt_ca).read_text() if args.mqtt_ca else ''
    server.mqtt_local_only = args.mqtt_bind in ('127.0.0.1', 'localhost')
    server.device_host=args.device_host or ('127.0.0.1' if server.mqtt_local_only else lan_address())
    server.device_host_fallback=args.device_host_fallback or None
    server.mqtt_port=args.mqtt_port
    server.device_port=args.device_port or args.mqtt_port
    server.allowed_hosts = {'127.0.0.1', 'localhost', server.device_host}
    if server.device_host_fallback:
        server.allowed_hosts.add(server.device_host_fallback)
    for item in args.public_origins:
        server.allowed_hosts.add(urlsplit(item).hostname)
    if args.host != '0.0.0.0':
        server.allowed_hosts.add(args.host)
    if args.https_cert:
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version=ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.https_cert,args.https_key)
        server.socket=context.wrap_socket(server.socket,server_side=True)


def main():
    args=parse_args()
    registry = DeviceRegistry(args.database.resolve(), ROOT,import_demo=not args.production,retention_days=args.retention_days)
    if args.production:
        with registry.connect() as db:
            if not db.execute("SELECT 1 FROM accounts WHERE role='admin' AND demo=0 AND disabled=0 AND password_hash LIKE 'scrypt$%'").fetchone():
                raise SystemExit('请先使用 manage_accounts.py 在此数据库创建正式管理员。')
    broker = LocalBroker(registry,args.mqtt_bind,args.mqtt_port,args.mqtt_cert,args.mqtt_key)
    broker.start()
    monitors = {'usb': SerialMonitor(args.device, args.baudrate)}
    server=None
    try:
        server = ThreadingHTTPServer((args.host, args.port), partial(PlatformHandler, monitors=monitors, directory=str(ROOT)))
        configure_server(server,registry,args)
        print(f'网页：{args.public_origin or ("https" if args.https_cert else "http")+"://127.0.0.1:"+str(args.port)}/',flush=True)
        print(f'板子接入：{server.device_host}:{server.device_port}（'+('TLS' if server.mqtt_tls else '本机明文 MQTT')+'）',flush=True)
        print(f'历史保留 {args.retention_days} 天；Ctrl+C 停止。',flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server:
            server.server_close()
        broker.close()
        for monitor in monitors.values():
            monitor.close()


if __name__ == '__main__':
    main()
