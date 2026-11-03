#!/usr/bin/env bash
# Run as root on the Ubuntu server after Certbot and the formal admin are ready.
# 历史部署脚本，仅作参考：example.com / mqtt.example.com 是占位域名，使用前必须
# 全部替换成自己的域名（含 /etc/letsencrypt/live 下的证书目录名）。
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo '请以 root 运行。'; exit 1; }
cd /opt/rd-web
cert_dir=/etc/letsencrypt/live/example.com
tls_dir=/opt/rd-web/data/tls
for required in "$cert_dir/fullchain.pem" "$cert_dir/privkey.pem" "$cert_dir/cert.pem" "$cert_dir/chain.pem"; do
  [[ -s "$required" ]] || { echo "缺少证书文件：$required"; exit 1; }
done
id rdweb >/dev/null
.venv/bin/python - <<'PY'
import sqlite3
with sqlite3.connect('file:data/platform.sqlite3?mode=ro', uri=True) as db:
    assert db.execute("SELECT 1 FROM accounts WHERE role='admin' AND demo=0 AND disabled=0 AND password_hash LIKE 'scrypt$%'").fetchone(), '请先创建正式管理员'
PY
backup_dir=$(mktemp -d /root/rd-web-before-tls-XXXXXXXX)
for existing in /etc/nginx/sites-available/rd-web /etc/systemd/system/rd-web.service.d/access.conf /opt/rd-web/config/platform.cloud.json; do
  if [[ -f "$existing" ]]; then cp --parents "$existing" "$backup_dir/"; fi
done
echo "原配置备份：$backup_dir"
install -d -o root -g rdweb -m 750 "$tls_dir"
# Select a system trust root that validates the actual issued chain.
root_found=0
for root_name in ISRG_Root_X1 ISRG_Root_X2; do
  root_file="/etc/ssl/certs/${root_name}.pem"
  if [[ -s "$root_file" ]] && openssl verify -CAfile "$root_file" -untrusted "$cert_dir/chain.pem" -verify_hostname mqtt.example.com "$cert_dir/cert.pem" >/dev/null 2>&1; then
    install -o root -g rdweb -m 640 "$root_file" "$tls_dir/root-ca.pem"
    root_found=1
    break
  fi
done
[[ "$root_found" == 1 ]] || { echo '未找到可验证当前证书链的 ISRG 根证书，请停止并检查。'; exit 1; }
cat > /usr/local/sbin/rd-web-refresh-cert <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
cert_dir=/etc/letsencrypt/live/example.com
tls_dir=/opt/rd-web/data/tls
if [[ -n "${RENEWED_LINEAGE:-}" && "$RENEWED_LINEAGE" != "$cert_dir" ]]; then exit 0; fi
openssl verify -CAfile "$tls_dir/root-ca.pem" -untrusted "$cert_dir/chain.pem" -verify_hostname mqtt.example.com "$cert_dir/cert.pem"
cert_pub=$(openssl x509 -in "$cert_dir/cert.pem" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
key_pub=$(openssl pkey -in "$cert_dir/privkey.pem" -pubout -outform DER | sha256sum)
[[ "$cert_pub" == "$key_pub" ]] || { echo '证书与私钥不匹配'; exit 1; }
install -o root -g rdweb -m 640 "$cert_dir/fullchain.pem" "$tls_dir/mqtt-fullchain.pem"
install -o root -g rdweb -m 640 "$cert_dir/privkey.pem" "$tls_dir/mqtt-key.pem"
if [[ "${1:-}" != '--copy-only' ]]; then
  nginx -t
  systemctl restart rd-web
  systemctl reload nginx
fi
HOOK
chmod 750 /usr/local/sbin/rd-web-refresh-cert
/usr/local/sbin/rd-web-refresh-cert --copy-only
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
ln -sfn /usr/local/sbin/rd-web-refresh-cert /etc/letsencrypt/renewal-hooks/deploy/rd-web
cat > config/platform.cloud.json <<'JSON'
{
  "host": "127.0.0.1",
  "port": 8002,
  "public_origin": "https://example.com",
  "mqtt_bind": "0.0.0.0",
  "mqtt_port": 8883,
  "device_host": "mqtt.example.com",
  "device_port": 8883,
  "mqtt_cert": "../data/tls/mqtt-fullchain.pem",
  "mqtt_key": "../data/tls/mqtt-key.pem",
  "mqtt_ca": "../data/tls/root-ca.pem",
  "database": "../data/platform.sqlite3",
  "retention_days": 90,
  "production": true
}
JSON
chmod 644 config/platform.cloud.json
install -d -m 755 /etc/systemd/system/rd-web.service.d
cat > /etc/systemd/system/rd-web.service.d/access.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/opt/rd-web/.venv/bin/python /opt/rd-web/platform_server.py --config /opt/rd-web/config/platform.cloud.json
UNIT
systemctl daemon-reload
systemctl restart rd-web
# Do not publish the website until the backend confirms formal mode and MQTT TLS.
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 \
  -H 'Host: example.com' http://127.0.0.1:8002/api/platform | .venv/bin/python -c \
  'import sys,json; d=json.load(sys.stdin); assert d.get("enabled") is True and d.get("demoAccounts") is False and d.get("mqttTls") is True; print("正式模式与 MQTT TLS 已确认")'
cat > /etc/nginx/sites-available/rd-web <<'NGINX'
server {
    listen 80;
    server_name example.com mqtt.example.com;
    location /.well-known/acme-challenge/ {
        root /var/www/rd-web-acme;
        try_files $uri =404;
    }
    location / { return 301 https://example.com$request_uri; }
}
server {
    listen 443 ssl;
    server_name example.com;
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {
        proxy_pass http://127.0.0.1:8002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
NGINX
ln -sfn /etc/nginx/sites-available/rd-web /etc/nginx/sites-enabled/rd-web
nginx -t
systemctl reload nginx
systemctl enable --now certbot.timer
curl --fail --silent --show-error --resolve example.com:443:127.0.0.1 \
  https://example.com/api/platform
printf '\n部署完成。请从自己的电脑访问 https://example.com 并用正式账号登录。\n'
printf '续期检查：certbot renew --dry-run\n'
