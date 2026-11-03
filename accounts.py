"""Database accounts, salted password hashes and bounded login attempts."""
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time

from device_registry import RegistryError


def password_hash(password):
    salt = secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return f'scrypt${salt}${digest}'


def password_matches(password, stored):
    try:
        algorithm, salt, digest = stored.split('$')
        if algorithm != 'scrypt':
            return False
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
        return hmac.compare_digest(actual, digest)
    except (ValueError, TypeError):
        return False


class AccountStore:
    def __init__(self, registry, import_demo=True):
        self.registry = registry
        with registry.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                    name TEXT NOT NULL, role TEXT NOT NULL, company TEXT,
                    password_hash TEXT NOT NULL, demo INTEGER NOT NULL DEFAULT 0,
                    disabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
                CREATE TABLE IF NOT EXISTS account_meta (key TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS login_attempts (
                    key TEXT PRIMARY KEY, failures INTEGER NOT NULL, until REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS registration_invites (
                    digest TEXT PRIMARY KEY, company TEXT NOT NULL, role TEXT NOT NULL,
                    expires REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0);
            ''')
            if import_demo and not db.execute("SELECT 1 FROM account_meta WHERE key='demo-imported'").fetchone():
                for user in json.loads((registry.root / 'users.json').read_text())['users']:
                    db.execute('INSERT OR IGNORE INTO accounts(id,username,name,role,company,password_hash,demo) VALUES (?,?,?,?,?,?,1)',
                               (user['id'], user['username'], user['name'], user['role'], user.get('companyId'), 'legacy$'+user['passwordHash']))
                db.execute("INSERT INTO account_meta VALUES ('demo-imported')")

    @staticmethod
    def public(row):
        return {'id': row['id'], 'username': row['username'], 'name': row['name'],
                'role': row['role'], 'companyId': row['company'], 'authVersion': row['version']}

    def user(self, user_id, allow_demo=True):
        with self.registry.connect() as db:
            row = db.execute('SELECT * FROM accounts WHERE id=? AND disabled=0', (user_id,)).fetchone()
        if not row or (row['demo'] and not allow_demo):
            raise RegistryError('账号不可用，请重新登录。', 401)
        return self.public(row)

    def authenticate(self, username, password, address='local', allow_demo=True):
        if not isinstance(username, str) or not isinstance(password, str) or len(username)>40 or len(password)>100:
            raise RegistryError('账号或密码错误。', 401)
        now = time.time()
        keys = ['user:'+hashlib.sha256(username.encode()).hexdigest(), 'ip:'+hashlib.sha256(address.encode()).hexdigest()]
        with self.registry.connect() as db:
            db.execute('DELETE FROM login_attempts WHERE until < ?', (now,))
            for key, maximum in zip(keys, (5, 30)):
                attempt = db.execute('SELECT failures FROM login_attempts WHERE key=?', (key,)).fetchone()
                if attempt and attempt['failures'] >= maximum:
                    raise RegistryError('登录失败次数过多，请在 15 分钟后重试。', 429)
            row = db.execute('SELECT * FROM accounts WHERE username=?', (username,)).fetchone()
        valid = False
        if row and not row['disabled'] and (allow_demo or not row['demo']):
            stored = row['password_hash']
            valid = hmac.compare_digest(stored[7:], hashlib.sha256(password.encode()).hexdigest()) if stored.startswith('legacy$') else password_matches(password, stored)
        if not valid:
            # Record failures outside an exception-rolled-back transaction.
            with self.registry.connect() as db:
                for key in keys:
                    db.execute('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET failures=failures+1', (key, now+900))
            raise RegistryError('账号或密码错误。', 401)
        with self.registry.connect() as db:
            db.execute('DELETE FROM login_attempts WHERE key=?', (keys[0],))
            if row['password_hash'].startswith('legacy$'):
                db.execute('UPDATE accounts SET password_hash=? WHERE id=? AND password_hash=?', (password_hash(password), row['id'], row['password_hash']))
        return self.public(row)

    def create(self, username, password, name, role, company=None):
        with self.registry.connect() as db:
            user_id=self.create_in_db(db,username,password,name,role,company)
        return self.user(user_id)

    def create_in_db(self, db, username, password, name, role, company):
        if not isinstance(username, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{3,40}', username):
            raise RegistryError('账号需为 3–40 位字母、数字或 _ . -。')
        self.validate_password(password)
        companies = self.registry.organization.companies()
        if role not in ('admin','company_admin','developer','customer') or (role!='admin' and (not isinstance(company, str) or company not in {c['id'] for c in companies})):
            raise RegistryError('请选择有效身份和公司。')
        if not isinstance(name,str) or not 1<=len(name.strip())<=40:
            raise RegistryError('姓名需为 1–40 个字符。')
        user_id = 'user-'+secrets.token_hex(12)
        try:
            db.execute('INSERT INTO accounts(id,username,name,role,company,password_hash) VALUES (?,?,?,?,?,?)',
                       (user_id,username,name.strip(),role,company if role!='admin' else None,password_hash(password)))
        except sqlite3.IntegrityError:
            raise RegistryError('账号已存在。',409) from None
        return user_id

    def invite(self, company, role='customer'):
        companies=self.registry.organization.companies()
        if not isinstance(company, str) or company not in {c['id'] for c in companies} or role not in ('customer','developer'):
            raise RegistryError('请选择有效公司，邀请身份仅支持客户或开发者。')
        token=secrets.token_urlsafe(24)
        with self.registry.connect() as db:
            db.execute('INSERT INTO registration_invites VALUES (?,?,?,?,0)',
                       (hashlib.sha256(token.encode()).hexdigest(),company,role,time.time()+7*86400))
        return token

    def register(self, data, address):
        key='register:'+hashlib.sha256(address.encode()).hexdigest()
        now=time.time()
        with self.registry.connect() as db:
            db.execute('DELETE FROM login_attempts WHERE until < ?', (now,))
            attempt=db.execute('SELECT failures FROM login_attempts WHERE key=?',(key,)).fetchone()
            if attempt and attempt['failures']>=10:
                raise RegistryError('注册尝试过多，请在 15 分钟后重试。',429)
            db.execute('INSERT INTO login_attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET failures=failures+1',(key,now+900))
        token=data.get('inviteCode')
        if not isinstance(token,str) or not 1<=len(token)<=128:
            raise RegistryError('请输入管理员提供的公司邀请码。')
        with self.registry.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            invite=db.execute('SELECT * FROM registration_invites WHERE digest=? AND used=0 AND expires>?',
                              (hashlib.sha256(token.strip().encode()).hexdigest(),now)).fetchone()
            if not invite:
                raise RegistryError('邀请码无效、已使用或已过期，请联系公司管理员。')
            user_id=self.create_in_db(db,data.get('username'),data.get('password'),data.get('name'),invite['role'],invite['company'])
            db.execute('UPDATE registration_invites SET used=1 WHERE digest=?',(invite['digest'],))
        return self.user(user_id,allow_demo=False)

    @staticmethod
    def validate_password(password):
        if not isinstance(password,str) or not 12<=len(password)<=100:
            raise RegistryError('密码需为 12–100 个字符。')

    def change_password(self, user, current, new):
        self.validate_password(new)
        with self.registry.connect() as db:
            row = db.execute('SELECT * FROM accounts WHERE id=? AND disabled=0', (user['id'],)).fetchone()
        if not row or row['version']!=user.get('authVersion') or not password_matches(current,row['password_hash']):
            raise RegistryError('当前密码错误或登录已失效。',401)
        with self.registry.connect() as db:
            updated=db.execute('UPDATE accounts SET password_hash=?,version=version+1,demo=0 WHERE id=? AND version=?',
                               (password_hash(new),user['id'],row['version']))
            if updated.rowcount!=1:
                raise RegistryError('登录已失效，请重新登录。',401)
