"""Four-role API authorization, explicit grants and durable company settings."""
from functools import partial
from http.server import ThreadingHTTPServer
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from device_registry import DeviceRegistry
from platform_server import PlatformHandler

ROOT = Path(__file__).resolve().parents[1]


class OrganizationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.registry = DeviceRegistry(Path(self.temp.name) / 'test.sqlite3', ROOT)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), partial(PlatformHandler, monitors={}, directory=str(ROOT)))
        self.server.registry = self.registry
        self.server.sessions, self.server.session_lock = {}, threading.Lock()
        self.server.allowed_hosts = {'127.0.0.1', 'localhost'}
        self.server.device_host, self.server.mqtt_port = '127.0.0.1', 1883
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.cookies = {}
        for username, role, company in [('owner_a', 'company_admin', 'company-a'),
                                        ('owner_b', 'company_admin', 'company-b')]:
            self.registry.accounts.create(username, 'private-password-123', username, role, company)
            self.cookies[username] = self.login(username, 'private-password-123')
        for username in ('admin', 'developer', 'customer', 'customer_b'):
            self.cookies[username] = self.login(username, '123456')

    def request(self, method, path, data=None, actor=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        headers = {'Content-Type': 'application/json'}
        if actor:
            headers['Cookie'] = self.cookies[actor]
        conn.request(method, path, json.dumps(data) if data is not None else None, headers)
        response = conn.getresponse()
        body = json.loads(response.read())
        result = response.status, body, response.getheader('Set-Cookie')
        conn.close()
        return result

    def login(self, username, password):
        status, body, cookie = self.request('POST', '/api/login', {'username': username, 'password': password})
        self.assertEqual(status, 200, body)
        return cookie.split(';')[0]

    def create_device(self, actor='developer', **extra):
        status, body, _ = self.request('POST', '/api/devices',
            {'id': 'org-test', 'name': '温湿度', 'location': '试验区', 'sceneId': 'planting', **extra}, actor)
        self.assertEqual(status, 201, body)
        return body['device']

    def test_grants_apply_to_list_history_and_revoke_immediately(self):
        device = self.create_device()
        self.registry.ingest(device['id'], b'{"temperature":25}')
        start, end = time.time() - 60, time.time() + 60
        history = f'/api/devices/{device["id"]}/history?start={start}&end={end}'
        self.assertEqual(self.request('GET', '/api/devices', actor='customer')[1]['devices'], [])
        self.assertEqual(self.request('GET', history, actor='customer')[0], 403)
        members = self.request('GET', '/api/company/members', actor='owner_a')[1]['members']
        customer = next(m for m in members if m['username'] == 'customer')
        grant = {'userId': customer['id'], 'deviceIds': [device['id']]}
        for actor in ('developer', 'customer', 'owner_b', 'admin'):
            self.assertEqual(self.request('POST', '/api/company/assignments', grant, actor)[0], 403)
        self.assertEqual(self.request('POST', '/api/company/assignments', grant, 'owner_a')[0], 200)
        self.assertEqual(len(self.request('GET', '/api/devices', actor='customer')[1]['devices']), 1)
        self.assertEqual(self.request('GET', history, actor='customer')[0], 200)
        self.assertEqual(self.request('GET', history, actor='customer_b')[0], 403)
        self.assertEqual(self.request('POST', '/api/company/assignments', {**grant, 'deviceIds': []}, 'owner_a')[0], 200)
        self.assertEqual(self.request('GET', history, actor='customer')[0], 403)

    def test_company_scene_and_device_settings_are_persistent(self):
        status, result, _ = self.request('POST', '/api/company/scenes', {'name': '一号仓库'}, 'owner_a')
        self.assertEqual(status, 201)
        scene = result['scene']
        self.assertEqual(self.request('POST', '/api/company/scenes', {'name': '非法'}, 'developer')[0], 403)
        self.assertEqual(self.request('POST', '/api/company/scenes', {'id': scene['id'], 'name': '盗改'}, 'owner_b')[0], 403)
        device = self.create_device(actor='owner_a', sceneId='warehouse-environment', workspaceSceneId=scene['id'])
        settings = {'name': '新名称', 'sampleInterval': 60, 'thresholds': {'temperature': {'min': 0, 'max': 30}}}
        self.assertEqual(self.request('POST', f'/api/devices/{device["id"]}/settings', settings, 'developer')[0], 200)
        self.assertEqual(self.request('POST', f'/api/devices/{device["id"]}/settings', settings, 'owner_b')[0], 403)
        self.assertEqual(self.request('POST', f'/api/devices/{device["id"]}/settings', settings, 'customer')[0], 403)
        self.assertEqual(self.request('POST', '/api/company/scenes/delete', {'id': scene['id']}, 'owner_a')[0], 409)
        restarted = DeviceRegistry(self.registry.database, ROOT)
        user = restarted.accounts.authenticate('owner_a', 'private-password-123')
        saved = restarted.snapshot(user)[0]
        self.assertEqual(saved['name'], '新名称')
        self.assertEqual(saved['thresholds'], settings['thresholds'])
        self.assertEqual(saved['workspaceSceneId'], scene['id'])
        self.assertEqual(restarted.organization.scenes(user)[0]['name'], '一号仓库')

    def test_invite_is_company_bound_and_cannot_elevate(self):
        for actor in ('admin', 'developer', 'customer', 'customer_b'):
            self.assertEqual(self.request('POST', '/api/company/invites', {'role': 'developer'}, actor)[0], 403)
        self.assertEqual(self.request('POST', '/api/company/invites', {'role': 'company_admin'}, 'owner_a')[0], 400)
        status, result, _ = self.request('POST', '/api/company/invites', {'role': 'developer', 'companyId': 'company-b'}, 'owner_a')
        self.assertEqual(status, 201)
        registration = {'username': 'invited_dev', 'name': '新开发者', 'password': 'private-password-123',
                        'inviteCode': result['inviteCode'], 'role': 'admin', 'companyId': 'company-b'}
        status, result, _ = self.request('POST', '/api/register', registration)
        self.assertEqual(status, 201)
        self.assertEqual(result['user']['companyId'], 'company-a')
        self.assertEqual(result['user']['role'], 'developer')
        self.assertEqual(self.request('POST', '/api/register', {**registration, 'username': 'reused'})[0], 400)

    def test_platform_creates_company_and_owner_without_exposing_inventory(self):
        self.assertEqual(self.request('POST', '/api/companies', {'name': '越权公司'}, 'owner_a')[0], 403)
        status, result, _ = self.request('POST', '/api/companies', {'name': '新公司'}, 'admin')
        self.assertEqual(status, 201)
        company_id = result['company']['id']
        data = {'username': 'new_owner', 'password': 'private-password-123', 'name': '公司主管', 'companyId': company_id}
        self.assertEqual(self.request('POST', '/api/company-admins', data, 'owner_a')[0], 403)
        self.assertEqual(self.request('POST', '/api/company-admins', data, 'admin')[0], 201)
        self.cookies['new_owner'] = self.login('new_owner', data['password'])
        workspace = self.request('GET', '/api/workspace', actor='new_owner')[1]
        self.assertEqual([c['id'] for c in workspace['platform']['companies']], [company_id])
        self.assertEqual(self.request('GET', '/api/workspace')[0], 401)
        self.assertEqual(self.request('GET', '/devices.json')[1]['devices'], [])
        self.assertEqual(self.request('GET', '/api/devices', actor='new_owner')[1]['devices'], [])


if __name__ == '__main__':
    unittest.main()
