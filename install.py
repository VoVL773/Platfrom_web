#!/usr/bin/env python3
"""物联空间交互式安装器（Python 3.11+，无需预装项目依赖）。"""
import getpass
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import shlex
import ssl
import subprocess
import sys
import venv

SOURCE = Path(__file__).resolve().parent
EXCLUDED = {'.git', '.venv', '.agents', '.codex', '.aws', 'data', 'dist',
            'node_modules', '__pycache__', '.pio', '.pytest_cache'}


def ask(label, default=None, validate=None):
    while True:
        value = input(label + (f' [{default}]' if default is not None else '') + '：').strip()
        value = value or default
        try:
            if value is None:
                raise ValueError('此项不能为空')
            return validate(value) if validate else value
        except ValueError as error:
            print(f'输入无效：{error}')


def choice(value):
    if value not in ('1', '2'):
        raise ValueError('请选择 1 或 2')
    return value


def host(value):
    try:
        parsed = ipaddress.ip_address(value)
        if parsed.version != 4 or parsed.is_unspecified or parsed.is_multicast:
            raise ValueError('请使用可访问的 IPv4 地址')
        return str(parsed)
    except ValueError:
        if not re.fullmatch(r'(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', value):
            raise ValueError('请填写 IPv4 或域名，不带协议、端口、路径') from None
        if re.fullmatch(r'[0-9.]+', value):
            raise ValueError('IPv4 地址无效')
        return value.lower()


def ipv4(value):
    parsed = ipaddress.IPv4Address(value)
    if parsed.is_unspecified or parsed.is_multicast:
        raise ValueError('请使用可访问的 IPv4 地址')
    return str(parsed)


def port(value):
    number = int(value)
    if not 1024 <= number <= 65535:
        raise ValueError('端口范围为 1024–65535')
    return number


def python_path(root):
    return root / '.venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def ignore_files(directory, names):
    return [name for name in names if name in EXCLUDED or name.startswith('.env')
            or name == 'secrets.h' or name.endswith(('.pyc', '.log', '.zip'))
            or (Path(directory).name == 'config' and name.startswith('platform.')
                and name.endswith('.json') and not name.endswith('.example.json'))]


def write_private(path, content):
    with path.open('w', encoding='utf-8', newline='\n') as output:
        os.chmod(path, 0o600)
        output.write(content)


def generate_launchers(root, url, mode):
    # The access script is deliberately self-contained so it can be copied to a client PC.
    access = ('#!/usr/bin/env python3\nimport webbrowser\n'
              f'URL = {url!r}\nprint("平台访问地址：", URL)\n'
              'if not webbrowser.open(URL):\n    print("请将上面的地址复制到浏览器。")\n')
    (root / 'open-platform.py').write_text(access, encoding='utf-8')
    for action in ('start', 'open'):
        target = 'scripts/deployment_runtime.py' if action == 'start' else 'open-platform.py'
        shell = ('#!/usr/bin/env bash\nset -euo pipefail\n'
                 'ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"\n')
        if action == 'start':
            shell += f'exec "$ROOT/.venv/bin/python" "$ROOT/{target}"\n'
        else:
            shell += 'if command -v python3 >/dev/null 2>&1; then\n'
            shell += f'  exec python3 "$ROOT/{target}"\n'
            shell += f'elif command -v xdg-open >/dev/null 2>&1; then exec xdg-open {shlex.quote(url)}\n'
            shell += f'elif command -v open >/dev/null 2>&1; then exec open {shlex.quote(url)}\n'
            shell += f'else echo {shlex.quote(url)}; fi\n'
        script = root / f'{action}-platform.sh'
        script.write_text(shell, encoding='utf-8')
        script.chmod(0o755)
        command = ('@echo off\r\ncd /d "%~dp0"\r\n'
                   f'"%~dp0.venv\\Scripts\\python.exe" "%~dp0scripts\\deployment_runtime.py"\r\npause\r\n'
                   if action == 'start' else f'@echo off\r\nstart "" "{url}"\r\n')
        (root / f'{action}-platform.cmd').write_bytes(command.encode('utf-8'))
    (root / '部署结果.txt').write_text(
        f'部署类型：{"本机" if mode == "1" else "服务器"}\n平台地址：{url}\n'
        '启动：Linux/macOS 运行 ./start-platform.sh；Windows 双击 start-platform.cmd。\n'
        '停止：启动终端按 Ctrl+C。服务器需要持续运行时请使用进程管理器。\n'
        '访问：运行 open-platform.py、open-platform.sh 或 open-platform.cmd。\n'
        '服务器模式可把 open-platform.py 或 open-platform.cmd 单独复制到自己的电脑。\n'
        '仅复制访问脚本不会启动服务器；服务器必须先启动平台。\n'
        '自签名证书：请通过可信渠道导入 data/tls/root-ca.pem 为信任根，私钥不可分发。\n'
        '自签名服务器证书有效期 90 天，正式长期部署请导入有效公有证书并安排续期。\n'
        '域名需解析到服务器 IP，防火墙/云安全组需放行所选网页和 MQTT TCP 端口。\n'
        '数据备份：data/ 和 config/platform.installed.json；密码仅以加盐哈希保存在数据库。\n',
        encoding='utf-8')


def install():
    if sys.version_info < (3, 11):
        raise ValueError('请先安装 Python 3.11 或更新版本')
    print('物联空间首次安装：请在最终运行平台的电脑或服务器执行。')
    mode = ask('部署位置：1 本机 / 2 服务器', '1',
               choice)
    root = Path(ask('安装目录', str(Path.home() / 'iot-platform'))).expanduser().resolve()
    state = root / 'data/deployment.json'
    if state.exists():
        saved = json.loads(state.read_text(encoding='utf-8'))
        generate_launchers(root, saved['url'], saved['mode'])
        print(f'已安装，已恢复启动和访问脚本：{root}\n访问地址：{saved["url"]}\n未修改账号或数据库。')
        return
    if root == SOURCE or root.is_relative_to(SOURCE) or SOURCE.is_relative_to(root):
        raise ValueError('请选择源码目录之外的独立安装目录，避免递归复制或覆盖源码')
    if root.exists() and any(root.iterdir()):
        raise ValueError('目标目录非空。请使用新的空目录；失败安装可检查备份后另选目录重试')
    ip = '127.0.0.1' if mode == '1' else ask('服务器 IPv4（不是你当前电脑的 IP）', validate=ipv4)
    domain = ask('访问域名（不带协议；没有则留空）', '', host_optional)
    address = domain or ip
    web_port = ask('网页 HTTPS 端口', '8443', port)
    mqtt_port = ask('设备 MQTT TLS 端口', '8883', port)
    if web_port == mqtt_port:
        raise ValueError('网页和 MQTT 端口不能相同')
    certificate = ask('证书方式：1 自动生成自签名 / 2 导入现有证书', '1',
                      choice)
    if not shutil.which('openssl'):
        raise ValueError('证书生成与校验需要 OpenSSL，请先安装并加入 PATH 后重试')
    cert_files = None
    if certificate == '2':
        cert_files = [Path(ask(label)).expanduser().resolve() for label in
                      ('服务器完整证书链 PEM 路径（同时用于网页和 MQTT）', '未加密私钥 PEM 路径', '设备信任的根 CA PEM 路径')]
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(*cert_files[:2])
        ssl.create_default_context(cafile=str(cert_files[2]))
        if not all(path.is_file() for path in cert_files):
            raise ValueError('证书文件不存在')
        verification = '-verify_ip' if address == ip else '-verify_hostname'
        subprocess.run(['openssl', 'verify', '-CAfile', str(cert_files[2]),
                        '-untrusted', str(cert_files[0]), verification, address,
                        str(cert_files[0])], check=True)
    username = ask('平台管理员账号', 'platform_admin',
                   lambda value: value if re.fullmatch(r'[A-Za-z0-9_.-]{3,40}', value)
                   else (_ for _ in ()).throw(ValueError('账号需为 3–40 位字母、数字或 _ . -')))
    name = ask('管理员显示名称', '平台管理员',
               lambda value: value if 1 <= len(value) <= 40 else (_ for _ in ()).throw(ValueError('名称需为 1–40 字符')))
    while True:
        password = getpass.getpass('管理员密码（12–100 字符，不回显）：')
        repeated = getpass.getpass('再次输入密码：')
        if 12 <= len(password) <= 100 and password == repeated:
            break
        print('密码长度不符合要求或两次密码不一致，请重新输入。')
    print(f'安装到 {root}，正在复制程序并安装依赖……')
    shutil.copytree(SOURCE, root, ignore=ignore_files, dirs_exist_ok=True)
    data = root / 'data'
    data.mkdir(mode=0o700)
    venv.EnvBuilder(with_pip=True).create(root / '.venv')
    executable = python_path(root)
    subprocess.run([str(executable), '-m', 'pip', 'install', '-r', str(root / 'requirements.txt')], check=True)
    tls = data / 'tls'
    if cert_files:
        tls.mkdir(mode=0o700)
        for source, filename in zip(cert_files, ('server-cert.pem', 'server-key.pem', 'root-ca.pem')):
            write_private(tls / filename, source.read_text(encoding='utf-8'))
    else:
        subprocess.run([str(executable), str(root / 'scripts/create_local_tls.py'), '--output', str(tls),
                        '--host', ip, '--host', address], check=True)
    url = f'https://{address}:{web_port}'
    origins = [url]
    if domain and not cert_files:
        origins.append(f'https://{ip}:{web_port}')
    config = {'host': '127.0.0.1' if mode == '1' else '0.0.0.0', 'port': web_port,
              'public_origin': origins, 'mqtt_bind': '127.0.0.1' if mode == '1' else '0.0.0.0',
              'mqtt_port': mqtt_port, 'device_host': address, 'device_port': mqtt_port,
              'https_cert': '../data/tls/server-cert.pem', 'https_key': '../data/tls/server-key.pem',
              'mqtt_cert': '../data/tls/server-cert.pem', 'mqtt_key': '../data/tls/server-key.pem',
              'mqtt_ca': '../data/tls/root-ca.pem', 'database': '../data/platform.sqlite3',
              'retention_days': 90, 'production': True}
    config_path = root / 'config/platform.installed.json'
    write_private(config_path, json.dumps(config, ensure_ascii=False, indent=2) + '\n')
    # Validate using the deployed interpreter before creating the administrator.
    subprocess.run([str(executable), '-c', 'from platform_server import parse_args; parse_args()',
                    '--config', str(config_path)], cwd=root, check=True)
    # Send the password over stdin, never as a process argument or a saved file.
    subprocess.run([str(executable), '-c',
                    'import json,sys; from pathlib import Path; from device_registry import DeviceRegistry; '
                    'd=json.load(sys.stdin); r=DeviceRegistry(Path("data/platform.sqlite3"),Path.cwd(),import_demo=False); '
                    'r.accounts.create(d["username"],d["password"],d["name"],"admin")'],
                   input=json.dumps({'username': username, 'password': password, 'name': name}),
                   text=True, cwd=root, check=True)
    os.chmod(data / 'platform.sqlite3', 0o600)
    generate_launchers(root, url, mode)
    write_private(state, json.dumps({'url': url, 'mode': mode}, ensure_ascii=False) + '\n')
    print(f'安装完成！管理员：{username}\n启动：{root / ("start-platform.cmd" if os.name == "nt" else "start-platform.sh")}\n访问：{url}\n详细说明：{root / "部署结果.txt"}')
    if certificate == '1':
        print('已生成自签名证书，浏览器首次访问需要信任根 CA；服务器证书有效期 90 天。')


def host_optional(value):
    return host(value) if value else ''


if __name__ == '__main__':
    try:
        install()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'安装未完成：{error}\n原源码保持完整；请检查目标目录后重试。', file=sys.stderr)
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        print('\n安装已取消。', file=sys.stderr)
        sys.exit(1)
