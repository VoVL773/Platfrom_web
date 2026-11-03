"""Company ownership, custom scenes and explicit customer device grants."""
import json
import secrets
from device_registry import RegistryError


class OrganizationStore:
    def __init__(self, registry):
        self.registry = registry
        with registry.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, config TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS company_scenes (
                    id TEXT PRIMARY KEY, company TEXT NOT NULL, name TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS device_grants (
                    user TEXT NOT NULL, device TEXT NOT NULL COLLATE NOCASE,
                    PRIMARY KEY(user, device));
            ''')
            for company in json.loads((registry.root / 'platform.json').read_text())['companies']:
                db.execute('INSERT OR IGNORE INTO companies VALUES (?,?)',
                           (company['id'], json.dumps(company, ensure_ascii=False)))

    @staticmethod
    def require(user, role):
        if not user or user.get('role') != role:
            raise RegistryError('无权执行此操作。', 403)

    def companies(self):
        with self.registry.connect() as db:
            return [json.loads(r['config']) for r in db.execute('SELECT config FROM companies ORDER BY rowid')]

    def create_company(self, user, data):
        self.require(user, 'admin')
        name = self.name(data.get('name'))
        company = {'id': 'company-' + secrets.token_hex(6), 'name': name,
                   'description': '', 'categoryId': None, 'template': ''}
        with self.registry.connect() as db:
            db.execute('INSERT INTO companies VALUES (?,?)', (company['id'], json.dumps(company, ensure_ascii=False)))
        return company

    @staticmethod
    def name(value):
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= 40:
            raise RegistryError('名称需为 1–40 个字符。')
        return value.strip()

    def scenes(self, user):
        with self.registry.connect() as db:
            if user['role'] == 'admin':
                rows = db.execute('SELECT * FROM company_scenes ORDER BY rowid')
            else:
                rows = db.execute('SELECT * FROM company_scenes WHERE company=? ORDER BY rowid', (user['companyId'],))
            return [dict(r) for r in rows]

    def save_scene(self, user, data):
        self.require(user, 'company_admin')
        name = self.name(data.get('name'))
        scene_id = data.get('id') or 'scene-' + secrets.token_hex(8)
        if not isinstance(scene_id, str):
            raise RegistryError('场景无效。')
        with self.registry.connect() as db:
            if data.get('id'):
                row = db.execute('SELECT * FROM company_scenes WHERE id=? AND company=?', (scene_id, user['companyId'])).fetchone()
                if not row:
                    raise RegistryError('场景不存在或无权访问。', 403)
                db.execute('UPDATE company_scenes SET name=? WHERE id=?', (name, scene_id))
            else:
                db.execute('INSERT INTO company_scenes VALUES (?,?,?)', (scene_id, user['companyId'], name))
        return {'id': scene_id, 'company': user['companyId'], 'name': name}

    def delete_scene(self, user, data):
        self.require(user, 'company_admin')
        if not isinstance(data.get('id'), str):
            raise RegistryError('场景无效。')
        with self.registry.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            scene = db.execute('SELECT * FROM company_scenes WHERE id=? AND company=?', (data.get('id'), user['companyId'])).fetchone()
            if not scene:
                raise RegistryError('场景不存在或无权访问。', 403)
            for row in db.execute('SELECT config FROM devices WHERE company=?', (user['companyId'],)):
                if json.loads(row['config']).get('workspaceSceneId') == scene['id']:
                    raise RegistryError('场景仍有关联设备，请先调整设备场景（含已删除设备）。', 409)
            db.execute('DELETE FROM company_scenes WHERE id=?', (scene['id'],))

    def validate_scene(self, db, company, scene_id):
        if scene_id is not None and (not isinstance(scene_id, str) or not db.execute(
                'SELECT 1 FROM company_scenes WHERE id=? AND company=?', (scene_id, company)).fetchone()):
            raise RegistryError('请选择本公司的场景。', 403)

    def members(self, user):
        self.require(user, 'company_admin')
        with self.registry.connect() as db:
            result = []
            for row in db.execute('SELECT * FROM accounts WHERE company=? AND disabled=0 ORDER BY name', (user['companyId'],)):
                member = self.registry.accounts.public(row)
                member['deviceIds'] = [r['device'] for r in db.execute('SELECT device FROM device_grants WHERE user=?', (row['id'],))]
                result.append(member)
            return result

    def assign(self, user, data):
        self.require(user, 'company_admin')
        ids = data.get('deviceIds')
        if not isinstance(data.get('userId'), str) or not isinstance(ids, list) or len(ids) > 1000 or any(not isinstance(i, str) for i in ids):
            raise RegistryError('设备列表无效。')
        with self.registry.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            member = db.execute("SELECT * FROM accounts WHERE id=? AND company=? AND role='customer' AND disabled=0",
                                (data.get('userId'), user['companyId'])).fetchone()
            if not member:
                raise RegistryError('只能向本公司客户分配设备。', 403)
            canonical = []
            for device_id in ids:
                device = self.registry.row(db, device_id)
                if device['company'] != user['companyId'] or device['deleted']:
                    raise RegistryError('只能分配本公司未删除的设备。', 403)
                canonical.append(device['id'])
            db.execute('DELETE FROM device_grants WHERE user=?', (member['id'],))
            db.executemany('INSERT OR IGNORE INTO device_grants VALUES (?,?)', [(member['id'], i) for i in canonical])

    def workspace(self, user):
        platform = json.loads((self.registry.root / 'platform.json').read_text())
        platform['companies'] = [c for c in self.companies() if user['role'] == 'admin' or c['id'] == user['companyId']]
        return {'platform': platform, 'companyScenes': self.scenes(user)}
