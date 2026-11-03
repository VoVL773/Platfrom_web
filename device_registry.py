"""Persistent device identities and bounded real telemetry for the local platform."""
from contextlib import contextmanager
import hashlib
import hmac
import json
import math
from pathlib import Path
import re
import secrets
import sqlite3
import time


class RegistryError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class DeviceRegistry:
    def __init__(self, database, root, import_demo=True, retention_days=90):
        self.database = str(database)
        self.root = Path(root)
        self.retention_days = retention_days
        self.last_cleanup = 0
        Path(database).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS devices (
                    id TEXT PRIMARY KEY COLLATE NOCASE, company TEXT NOT NULL,
                    config TEXT NOT NULL, secret_hash TEXT NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS readings (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    device TEXT NOT NULL COLLATE NOCASE, received REAL NOT NULL,
                    payload TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS readings_device ON readings(device, sequence);
                CREATE INDEX IF NOT EXISTS readings_time ON readings(device, received);
                CREATE INDEX IF NOT EXISTS readings_retention ON readings(received);
            ''')
        from organization import OrganizationStore
        self.organization = OrganizationStore(self)
        from accounts import AccountStore
        self.accounts = AccountStore(self, import_demo=import_demo)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def digest(secret):
        return hashlib.sha256(secret.encode()).hexdigest()

    def account(self, username, password):
        return self.accounts.authenticate(username, password)

    def authorize(self, user, row=None, write=False):
        if not user:
            raise RegistryError('请重新登录本机平台。', 401)
        if write and user.get('role') not in ('developer', 'company_admin'):
            raise RegistryError('仅本公司管理员或开发者可以管理设备。', 403)
        if row and not (user.get('role') == 'admin' and not write) and row['company'] != user.get('companyId'):
            raise RegistryError('无权访问该设备。', 403)
        if row and user.get('role') == 'customer':
            with self.connect() as db:
                grant = db.execute('SELECT 1 FROM device_grants WHERE user=? AND device=?', (user['id'], row['id'])).fetchone()
            if not grant or row['deleted']:
                raise RegistryError('该设备未分配给你。', 403)

    def row(self, db, device_id):
        row = db.execute('SELECT * FROM devices WHERE id = ?', (device_id,)).fetchone()
        if not row:
            raise RegistryError('设备不存在。', 404)
        return row

    def create(self, user, data):
        self.authorize(user, write=True)
        device_id = data.get('id', '').strip() if isinstance(data.get('id', ''), str) else ''
        if not device_id:
            device_id = 'dev-' + secrets.token_hex(6)
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{2,39}', device_id):
            raise RegistryError('设备 ID 应为 3–40 位字母、数字、短横线或下划线。')
        config = {'id': device_id, 'companyId': user.get('companyId'), 'sceneId': data.get('sceneId')}
        types = json.loads((self.root / 'devices.json').read_text())['scenes']
        if not isinstance(config['sceneId'], str) or config['sceneId'] not in {t['id'] for t in types}:
            raise RegistryError('请选择有效的设备类型。')
        if config['companyId'] not in {c['id'] for c in self.organization.companies()}:
            raise RegistryError('公司不存在。')
        config['workspaceSceneId'] = data.get('workspaceSceneId') or None
        for key, limit in [('name', 40), ('location', 80)]:
            value = data.get(key)
            if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
                raise RegistryError(f'请填写有效的设备名称和安装位置（最多 {limit} 字）。')
            config[key] = value.strip()
        interval = data.get('sampleInterval', 30)
        try:
            number = float(interval)
            if isinstance(interval, bool) or not number.is_integer() or not 1 <= number <= 3600:
                raise ValueError
        except (TypeError, ValueError, OverflowError):
            raise RegistryError('采样周期应为 1–3600 秒的整数。') from None
        config['sampleInterval'] = int(number)
        base = json.loads((self.root / 'devices.json').read_text())['devices']
        if any(d['id'].lower() == device_id.lower() for d in base):
            raise RegistryError('设备 ID 已存在，请更换。', 409)
        secret = secrets.token_urlsafe(32)
        try:
            with self.connect() as db:
                self.organization.validate_scene(db, config['companyId'], config['workspaceSceneId'])
                db.execute('INSERT INTO devices(id, company, config, secret_hash) VALUES (?, ?, ?, ?)',
                           (device_id, config['companyId'], json.dumps(config, ensure_ascii=False), self.digest(secret)))
        except sqlite3.IntegrityError:
            raise RegistryError('设备 ID 已存在（含已删除设备）。', 409) from None
        return config, secret

    def change(self, user, device_id, action):
        self.authorize(user, write=True)
        with self.connect() as db:
            row = self.row(db, device_id)
            self.authorize(user, row, write=True)
            if action == 'reset-secret':
                if row['deleted']:
                    raise RegistryError('请先恢复设备。')
                secret = secrets.token_urlsafe(32)
                db.execute('UPDATE devices SET secret_hash = ? WHERE id = ?', (self.digest(secret), device_id))
                config = json.loads(row['config'])
                config['activationAfter'] = time.time()
                db.execute('UPDATE devices SET config = ? WHERE id = ?', (json.dumps(config, ensure_ascii=False), device_id))
                return config, secret
            if action not in ('delete', 'restore'):
                raise RegistryError('未知设备操作。')
            db.execute('UPDATE devices SET deleted = ? WHERE id = ?', (int(action == 'delete'), device_id))
            # Preserve history, but require a fresh report after restore or credential rotation.
            config = json.loads(row['config'])
            config['activationAfter'] = time.time()
            db.execute('UPDATE devices SET config = ? WHERE id = ?', (json.dumps(config, ensure_ascii=False), device_id))
        return None

    def update(self, user, device_id, data):
        self.authorize(user, write=True)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = self.row(db, device_id)
            self.authorize(user, row, write=True)
            config = json.loads(row['config'])
            for key in ('name', 'location'):
                if key in data:
                    value = data[key]
                    if not isinstance(value, str) or not 1 <= len(value.strip()) <= (40 if key == 'name' else 80):
                        raise RegistryError('设备名称或安装位置无效。')
                    config[key] = value.strip()
            if 'sampleInterval' in data:
                interval = data['sampleInterval']
                if isinstance(interval, bool) or not isinstance(interval, (int, float)) or not float(interval).is_integer() or not 1 <= interval <= 3600:
                    raise RegistryError('预期上报周期应为 1–3600 秒的整数。')
                config['sampleInterval'] = int(interval)
            if 'thresholds' in data:
                thresholds = data['thresholds']
                if not isinstance(thresholds, dict) or len(thresholds) > 32:
                    raise RegistryError('告警阈值无效。')
                for key, value in thresholds.items():
                    if len(key) > 200 or not isinstance(value, dict):
                        raise RegistryError('告警阈值无效。')
                    low, high = value.get('min'), value.get('max')
                    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or abs(v) > 100000 for v in (low, high)) or low >= high:
                        raise RegistryError('告警阈值必须为有效数值，且最小值小于最大值。')
                config['thresholds'] = thresholds
            if 'workspaceSceneId' in data:
                scene_id = data['workspaceSceneId'] or None
                self.organization.validate_scene(db, row['company'], scene_id)
                config['workspaceSceneId'] = scene_id
            db.execute('UPDATE devices SET config=? WHERE id=?', (json.dumps(config, ensure_ascii=False), row['id']))
        return config

    def authenticate_device(self, device_id, secret):
        if not isinstance(device_id, str) or not isinstance(secret, str):
            return False
        with self.connect() as db:
            row = db.execute('SELECT * FROM devices WHERE id = ? AND deleted = 0', (device_id,)).fetchone()
        return bool(row and row['id'] == device_id and hmac.compare_digest(row['secret_hash'], self.digest(secret)))

    @staticmethod
    def topic(device_id):
        return f'rd/devices/{device_id}/telemetry'

    def ingest(self, device_id, payload, retained=False):
        if retained or not payload or len(payload) > 8192:
            return
        try:
            text = bytes(payload).decode('utf-8')
        except UnicodeDecodeError:
            return
        with self.connect() as db:
            row = db.execute('SELECT id FROM devices WHERE id = ? AND deleted = 0', (device_id,)).fetchone()
            if not row:
                return
            db.execute('INSERT INTO readings(device, received, payload) VALUES (?, ?, ?)', (device_id, time.time(), text))
            now=time.time()
            if now-self.last_cleanup>=3600:
                db.execute('DELETE FROM readings WHERE received < ?', (now-self.retention_days*86400,))
                self.last_cleanup=now

    def history(self, user, device_id, start, end, before=None, limit=200):
        self.authorize(user)
        try:
            start, end, limit = float(start), float(end), int(limit)
            before = int(before) if before is not None else None
            if not all(map(math.isfinite,(start,end))) or start<0 or end<=start or end-start>366*86400 or not 1<=limit<=500 or (before is not None and before<1):
                raise ValueError
        except (ValueError,TypeError,OverflowError):
            raise RegistryError('请选择有效时间范围（最多 366 天），每页 1–500 条。') from None
        with self.connect() as db:
            row = self.row(db,device_id)
            self.authorize(user,row)
            rows = [dict(r) for r in db.execute(
                'SELECT sequence,received,payload FROM readings WHERE device=? AND received>=? AND received<=? '
                'AND received>=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT ?',
                (device_id,start,end,time.time()-self.retention_days*86400,before,before,limit+1))]
        return {'readings':rows[:limit], 'nextBefore':rows[limit-1]['sequence'] if len(rows)>limit else None,
                'retentionDays':self.retention_days}

    def snapshot(self, user):
        self.authorize(user)
        with self.connect() as db:
            rows = db.execute('SELECT * FROM devices ORDER BY rowid').fetchall() if user.get('role') == 'admin' else db.execute(
                'SELECT * FROM devices WHERE company = ? ORDER BY rowid', (user.get('companyId', ''),)).fetchall()
            result = []
            for row in rows:
                if user.get('role') == 'customer':
                    if row['deleted'] or not db.execute('SELECT 1 FROM device_grants WHERE user=? AND device=?', (user['id'], row['id'])).fetchone():
                        continue
                item = json.loads(row['config'])
                item.update(provisioned=True, deleted=bool(row['deleted']), online=False,
                            mqtt={'topic': self.topic(row['id']), 'key': json.dumps([self.topic(row['id']), ''], separators=(',', ':'))},
                            metrics=[], values={}, history={}, diagnostics=[])
                item['readings'] = [dict(r) for r in db.execute(
                    'SELECT sequence, received, payload FROM readings WHERE device = ? AND received >= ? ORDER BY sequence DESC LIMIT 30',
                    (row['id'],time.time()-self.retention_days*86400))][::-1]
                result.append(item)
        return result
