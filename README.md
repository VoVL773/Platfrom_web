# 物联空间：供应链物联网网页

支持 Python 后端的物联网平台与独立静态演示。通过账号密码登录，按角色和设备授权展示对应入口。

**非技术使用者请先阅读 [零基础接手使用手册](零基础接手使用手册.md)**：按页面操作说明注册、公司管理、设备查看、新闻提交和向 AI 提需求的方法。

**管理员与技术维护人员请阅读 [项目交接与使用指南](项目交接与使用指南.md)**：包含管理员开通、公司创建、设备接入和开发交接。部署到新服务器请继续阅读下节。

## 新服务器、新域名部署与交接

本节适用于接手者在 **Ubuntu 24.04 LTS、Python 3.12、systemd、Nginx** 环境部署完整后端平台。其他发行版请调整安装命令。域名、IP、目录和账号均由新维护者决定；本文示例不绑定原作者服务器。

交接给 AI 时，请先让它阅读 [给AI的提示词和拓展要求.md](给AI的提示词和拓展要求.md)。历史部署脚本 `scripts/deploy_cloud_tls.sh` 和 `config/platform.ip.json`、`config/platform.domain.json` 含旧环境专属值，**不能直接用于新服务器**；本节提供独立部署步骤，无需运行该脚本。`CLOUD_SETUP.md` 中本机 TLS 等内容可作补充参考，新部署以本节为准。

### 1. 准备环境与替换参数

准备一个服务器公网 IP、可管理 DNS 的域名、源码和 SSH 管理权限。网页与 MQTT 各使用一个域名，二者可以指向同一服务器。

| 参数 | 示例 | 用途 |
| --- | --- | --- |
| 服务器公网 IP | `203.0.113.10` | 仅为文档示例，必须替换 |
| `APP_DIR` | `/opt/rd-web` | 可自选的绝对部署路径，本流程使用不含空格的路径 |
| `WEB_DOMAIN` | `iot.example.com` | 浏览器 HTTPS 域名 |
| `MQTT_DOMAIN` | `mqtt.example.com` | 设备 MQTT TLS 域名 |
| `CERT_NAME` | `rd-web` | Certbot 证书名称，与域名可以不同 |
| 系统运行用户 | `rdweb` | 无登录权限的服务用户 |
| 网页内部端口 | `8002` | 仅监听服务器回环地址 |
| MQTT TLS 端口 | `8883` | 对设备开放 TCP |

DNS 中添加两个 A 记录，分别将网页域名和 MQTT 域名指向新公网 IP。仅在服务器确实支持 IPv6 时添加 AAAA。MQTT 域名应使用 DNS 直连；普通网页 CDN 代理通常不转发原生 TCP 8883。所在地区或云厂商要求备案时先完成备案，不将域名访问被拦截直接认定为程序故障。

以下安装、配置命令在**新服务器同一个 root Bash 会话**中执行，先将示例值替换成自己的值。普通 SSH 用户先执行 `sudo -i`。后续重新连接服务器时，可用 `source /etc/rd-web-deploy.conf` 恢复参数。

```bash
set -euo pipefail
export APP_DIR=/opt/rd-web
export WEB_DOMAIN=iot.example.com
export MQTT_DOMAIN=mqtt.example.com
export CERT_NAME=rd-web
export ACME_EMAIL=ops@example.com
apt update
apt install -y python3 python3-venv python3-pip nginx certbot openssl ca-certificates curl dnsutils nodejs rsync
id rdweb >/dev/null 2>&1 || useradd --system --user-group --home-dir "$APP_DIR" --shell /usr/sbin/nologin rdweb
install -d -m 755 "$APP_DIR"
printf 'export APP_DIR=%q\nexport WEB_DOMAIN=%q\nexport MQTT_DOMAIN=%q\nexport CERT_NAME=%q\nexport ACME_EMAIL=%q\n' \
  "$APP_DIR" "$WEB_DOMAIN" "$MQTT_DOMAIN" "$CERT_NAME" "$ACME_EMAIL" > /etc/rd-web-deploy.conf
chmod 600 /etc/rd-web-deploy.conf
```

将项目完整源码上传到 `APP_DIR`，保留 `platform_server.py`、前端文件、`config/`、`content/`、`_news/`、`assets/` 等目录。不要只上传 `dist/`，它是静态演示站，不包含后端。

例如在**自己的开发电脑**执行下面命令，替换本地路径、SSH 用户、IP 与目标目录。该示例适用于目标目录已有写权限的上传账号；普通账号没有 `/opt` 写权限时，先上传到其家目录，再由服务器管理员复制到 `APP_DIR`。不要使用 `--delete` 覆盖既有服务器数据。

```bash
rsync -av --exclude='.git/' --exclude='.venv/' --exclude='__pycache__/' \
  --exclude='data/' --exclude='dist/' --exclude='.agents/' --exclude='.codex/' \
  --exclude='.aws/' --exclude='.pio/' --exclude='secrets.h' --exclude='*.zip' \
  --exclude='config/platform.cloud.json' \
  /你的本地项目目录/ SSH用户@新服务器IP:/opt/rd-web/
```

回到**服务器 root 会话**，安装依赖并收紧数据目录权限：

```bash
cd "$APP_DIR"
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
install -d -o rdweb -g rdweb -m 750 "$APP_DIR/data"
chown -R root:rdweb "$APP_DIR"
chmod -R u=rwX,g=rX,o= "$APP_DIR"
chown -R rdweb:rdweb "$APP_DIR/data"
```

云安全组与主机防火墙都需放行：管理 SSH 端口（建议限制管理来源）、TCP 80（证书签发与续期）、TCP 443（网页）、TCP 8883（设备）。不对公网开放 8002、1883 或数据库。启用主机防火墙前先确认当前 SSH 端口已放行，防止断开管理连接。

### 2. 选择全新部署或迁移原数据

**全新部署：** 创建正式管理员。密码交互输入，要求 12–100 个字符，不会回显。以服务用户运行，保证数据库文件权限正确。

```bash
cd "$APP_DIR"
runuser -u rdweb -- .venv/bin/python manage_accounts.py \
  --database "$APP_DIR/data/platform.sqlite3" \
  --username platform_admin --name '平台管理员' --role admin
```

**迁移旧服务器：** 使用 SQLite 在线备份生成一致性副本，不能直接复制正在写入的数据库文件。以下在旧服务器项目目录执行，若原配置使用其他数据库路径，请同时修改来源路径：

```bash
umask 077
.venv/bin/python - <<'PY'
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
backup = Path('data') / ('handover-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.sqlite3')
with sqlite3.connect('file:data/platform.sqlite3?mode=ro', uri=True) as source:
    with sqlite3.connect(backup) as target:
        source.backup(target)
print(backup)
PY
```

通过受控的 SSH 通道传输该副本。最终切换前停止旧平台服务，重新生成一次最终备份，防止迁移期间遗漏新上报；将最终副本放到新服务器 `data/platform.sqlite3`，再设置属主为 `rdweb:rdweb`、权限为 `640`。替换前确认新服务未运行且目标数据库已备份。不要把旧环境的私钥、Wi-Fi 密码或设备密钥提交到仓库。

迁移保留账号、公司、设备身份、授权和历史；会话不迁移，用户需要重新登录。源文件中的新闻、封面与公司模板也要随源码交接。数据库须包含可用的正式管理员；迁移后通常无需重复创建同名账号。新域名仍需重新签发证书，设备地址变更还要更新板端配置。

### 3. 签发网页和 MQTT 证书

先验证两个域名都指向新服务器（应显示实际公网 IP）：

```bash
dig +short A "$WEB_DOMAIN"
dig +short A "$MQTT_DOMAIN"
```

下面先创建仅供 ACME 验证的 HTTP 站点。在空白服务器使用；已有 Nginx 站点时先检查 `nginx -T`，避免同名站点或端口冲突，不要覆盖他人的配置。

```bash
install -d -m 755 /var/www/rd-web-acme
cat > /etc/nginx/sites-available/rd-web <<EOF
server {
    listen 80;
    server_name ${WEB_DOMAIN} ${MQTT_DOMAIN};
    location /.well-known/acme-challenge/ {
        root /var/www/rd-web-acme;
        try_files \$uri =404;
    }
    location / { return 404; }
}
EOF
ln -sfn /etc/nginx/sites-available/rd-web /etc/nginx/sites-enabled/rd-web
nginx -t
systemctl enable --now nginx
systemctl reload nginx
certbot certonly --webroot -w /var/www/rd-web-acme \
  --cert-name "$CERT_NAME" -d "$WEB_DOMAIN" -d "$MQTT_DOMAIN" \
  --email "$ACME_EMAIL" --agree-tos --non-interactive
```

网页由 Nginx 读取 Certbot 证书；MQTT 服务通过受限副本读取同一证书。设备下载配置还需要**验证当前签发链的根 CA 公钥证书**，不是 `chain.pem`，也不是私钥。以下按系统信任根查找匹配证书链的根，不依赖固定 CA 名称：

```bash
install -d -o root -g rdweb -m 750 "$APP_DIR/data/tls"
CERT_DIR="/etc/letsencrypt/live/$CERT_NAME"
root_found=0
for root_file in /etc/ssl/certs/*.pem; do
  if openssl verify -no-CApath -no-CAstore -CAfile "$root_file" -untrusted "$CERT_DIR/chain.pem" \
    -verify_hostname "$MQTT_DOMAIN" "$CERT_DIR/cert.pem" >/dev/null 2>&1; then
    install -o root -g rdweb -m 640 "$root_file" "$APP_DIR/data/tls/root-ca.pem"
    root_found=1
    break
  fi
done
if [ "$root_found" != 1 ]; then
  echo '未找到匹配的信任根，请检查 CA 与完整证书链，停止后续部署。' >&2
  exit 1
else
  install -o root -g rdweb -m 640 "$CERT_DIR/fullchain.pem" "$APP_DIR/data/tls/mqtt-fullchain.pem"
  install -o root -g rdweb -m 640 "$CERT_DIR/privkey.pem" "$APP_DIR/data/tls/mqtt-key.pem"
fi
```

只有找到信任根且复制成功后才继续。不要通过关闭设备证书校验来绕过问题。

### 4. 写入正式平台配置并设置自启

使用新环境参数生成配置，避免遗漏旧域名。相对路径按配置文件所在目录解析，本例数据库为 `APP_DIR/data/platform.sqlite3`。不配置 IP 回落地址：公开域名证书通常不包含 IP SAN，直接回落 IP 会导致证书校验失败。

```bash
cd "$APP_DIR"
.venv/bin/python - <<'PY'
import json
import os
from pathlib import Path
config = {
    'host': '127.0.0.1', 'port': 8002,
    'public_origin': 'https://' + os.environ['WEB_DOMAIN'],
    'mqtt_bind': '0.0.0.0', 'mqtt_port': 8883,
    'device_host': os.environ['MQTT_DOMAIN'], 'device_port': 8883,
    'mqtt_cert': '../data/tls/mqtt-fullchain.pem',
    'mqtt_key': '../data/tls/mqtt-key.pem',
    'mqtt_ca': '../data/tls/root-ca.pem',
    'database': '../data/platform.sqlite3',
    'retention_days': 90, 'production': True,
}
path = Path(os.environ['APP_DIR']) / 'config/platform.cloud.json'
path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PY
chown root:rdweb config/platform.cloud.json
chmod 640 config/platform.cloud.json
cat > /etc/systemd/system/rd-web.service <<EOF
[Unit]
Description=RD Web IoT Platform
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=rdweb
Group=rdweb
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/.venv/bin/python ${APP_DIR}/platform_server.py --config ${APP_DIR}/config/platform.cloud.json
Restart=on-failure
RestartSec=5
UMask=0027

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now rd-web
systemctl status rd-web --no-pager
```

预期显示 `active (running)`。若重启循环，先看 `journalctl -u rd-web -n 100 --no-pager`，重点检查正式管理员、依赖、证书权限和端口占用。已有同名服务时，还需检查 `systemctl cat rd-web` 中的旧 drop-in 配置，避免其 `ExecStart` 覆盖本节设置。

配置正式 Nginx 反向代理，保留 Host，所有网页/API 请求都转发到后端：

```bash
cat > /etc/nginx/sites-available/rd-web <<EOF
server {
    listen 80;
    server_name ${WEB_DOMAIN} ${MQTT_DOMAIN};
    location /.well-known/acme-challenge/ {
        root /var/www/rd-web-acme;
        try_files \$uri =404;
    }
    location / { return 301 https://${WEB_DOMAIN}\$request_uri; }
}
server {
    listen 443 ssl;
    server_name ${WEB_DOMAIN};
    ssl_certificate /etc/letsencrypt/live/${CERT_NAME}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${CERT_NAME}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {
        proxy_pass http://127.0.0.1:8002;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF
nginx -t
systemctl reload nginx
```

MQTT 不经过这个 HTTP 反向代理，它直接连接平台的 TCP 8883。不要额外启动另一个 Broker 占用相同端口。

### 5. 设置证书续期后的同步

Certbot 更新证书后，MQTT 副本也必须更新，并重启平台让新证书生效。下面钩子会先验证已保存的根 CA 能否验证新证书，再复制，避免静默切换设备不信任的根 CA。

```bash
cat > /usr/local/sbin/rd-web-refresh-cert <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
source /etc/rd-web-deploy.conf
cert_dir="/etc/letsencrypt/live/$CERT_NAME"
if [[ -n "${RENEWED_LINEAGE:-}" && "$RENEWED_LINEAGE" != "$cert_dir" ]]; then exit 0; fi
openssl verify -no-CApath -no-CAstore -CAfile "$APP_DIR/data/tls/root-ca.pem" \
  -untrusted "$cert_dir/chain.pem" -verify_hostname "$MQTT_DOMAIN" "$cert_dir/cert.pem"
cert_pub=$(openssl x509 -in "$cert_dir/cert.pem" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum)
key_pub=$(openssl pkey -in "$cert_dir/privkey.pem" -pubout -outform DER | sha256sum)
[[ "$cert_pub" == "$key_pub" ]] || { echo '证书与私钥不匹配'; exit 1; }
install -o root -g rdweb -m 640 "$cert_dir/fullchain.pem" "$APP_DIR/data/tls/mqtt-fullchain.pem"
install -o root -g rdweb -m 640 "$cert_dir/privkey.pem" "$APP_DIR/data/tls/mqtt-key.pem"
nginx -t
systemctl restart rd-web
systemctl reload nginx
HOOK
chmod 750 /usr/local/sbin/rd-web-refresh-cert
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
ln -sfn /usr/local/sbin/rd-web-refresh-cert /etc/letsencrypt/renewal-hooks/deploy/rd-web
/usr/local/sbin/rd-web-refresh-cert
systemctl enable --now certbot.timer
certbot renew --dry-run
```

手动执行钩子会短暂重启后端，现有登录会话失效、设备需要重连。`renew --dry-run` 主要验证签发续期流程，不能单独证明 MQTT 副本已更新；应结合手动钩子测试和下节握手验证。更换根 CA 时，需要先规划板端信任根更新，不能仅替换服务器 `root-ca.pem`。

### 6. 部署测试与验收

**服务器基础检查：**

```bash
systemctl is-active rd-web nginx
ss -lntp
```

预期 8002 仅绑定 `127.0.0.1`，8883 对设备网络开放，Nginx 监听 80/443。监听成功不代表云安全组已放行，还需从外网测试。

**正式模式检查：**

```bash
curl --fail --silent --show-error "https://$WEB_DOMAIN/api/platform" | \
  "$APP_DIR/.venv/bin/python" -c 'import json,sys; d=json.load(sys.stdin); assert d.get("enabled") is True and d.get("demoAccounts") is False and d.get("mqttTls") is True, d; print("正式模式、禁用体验账号、MQTT TLS：通过")'
```

预期输出“通过”。如果返回 502，检查后端服务；403 检查 `public_origin`、代理 Host 与访问域名是否一致；TLS 错误先检查 DNS、有效期及证书链。不要使用 `curl -k` 作为验收通过依据。

**外网证书检查：** 在另一台装有 OpenSSL 的电脑上执行，将示例域名替换成实际值。

```bash
openssl s_client -connect mqtt.example.com:8883 -servername mqtt.example.com \
  -verify_hostname mqtt.example.com -verify_return_error </dev/null
curl --fail --show-error https://iot.example.com/api/platform
```

预期 MQTT 握手的证书校验结果为 `Verify return code: 0 (ok)`，网页 API 返回 JSON。握手仅验证 TLS，不代表 MQTT 身份认证或上报已通过。

**浏览器、账号与真实设备验收：**

1. 用外网手机或电脑访问新 HTTPS 域名，确认无证书警告，能登录正式管理员，体验账号不能登录。
2. 平台管理员在“公司与管理员”中创建公司与公司管理员；公司管理员创建场景、生成邀请码，用户注册客户或开发者。邀请码应只能成功使用一次。
3. 公司管理员或开发者创建设备，下载新接入配置；核对 MQTT 域名、8883、TLS 与根 CA。密钥仅在创建或重置时显示，妥善交接，勿发到公开文档。
4. 将新配置与 Wi-Fi 参数写入固件并烧录。ESP8266 固件需要能同步网络时间以校验证书，检查串口日志中的时间同步、TLS 和 MQTT 连接结果。
5. 发送实际传感器采样，确认“待激活”转为在线、实时值更新、历史中出现新记录；停止上报并超过离线判定时间后应显示离线。
6. 公司管理员给客户分配设备；确认客户只看见被分配设备、不能修改；撤销分配后不能继续读取详情与历史。用另一公司账号验证不能越权。
7. 打开新闻列表、正文和封面，确认源文件及图片齐全。后端发布新闻是在 `_news/` 新增 Markdown 后重新进入新闻页；静态站另需构建。
8. 记录设备和历史数量，在维护窗口重启 `rd-web`，重新登录后核对数据保留，设备重连后继续上报。

**代码级检查：** 在开发机或独立测试环境运行，避免测试工具和构建产物混入正式部署；它们不能替代外网与硬件验收。

```bash
node tests/portal.test.cjs
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
.venv/bin/python scripts/build_site.py --output /tmp/rd-web-static-check
```

### 7. 只更换域名、只更换服务器与回滚

- **只换服务器、保留域名：** 最终备份数据库并迁移，准备新证书和服务，然后切 DNS。设备仍使用原域名且信任根兼容时通常无需重新烧录；仍需检查 DNS 缓存、CA 与新服务器外网连通性。
- **更换域名：** 同步修改 DNS、`WEB_DOMAIN`、`MQTT_DOMAIN`、证书 SAN、Nginx、`public_origin`、`device_host` 和续期参数文件。网页配置修改不会自动更新硬件中的旧域名；已有设备需要安全更新配置或重新烧录。没有旧设备切换方案前不要提前撤掉旧接入。
- **更换部署目录：** 同步修改配置中的绝对路径、systemd 的工作目录/启动路径、`/etc/rd-web-deploy.conf` 与备份命令；重新检查服务用户对路径及证书的权限。
- **回滚：** 保留旧版本代码、原配置、数据库一致性备份和旧 DNS 信息。若升级迁移了数据库结构，需要恢复匹配版本的代码与数据库。回滚前保存新库，恢复旧备份会丢失备份后的写入，应先决定如何保留这些记录。

交接时记录实际服务器 IP、域名/DNS 管理方、部署目录、服务用户、数据库路径、备份位置、证书到期日和续期方式，并填写每项验收的时间与结果。账号密码和密钥使用受控渠道单独交接，不写入 README。本文为可执行操作指南，不表示已经在接手者的新服务器执行或验证。

## 四角色公司工作空间（后端模式）

平台数据保存在 SQLite。启动 `platform_server.py` 后按四种身份分工：

| 身份 | 权限与入口 |
| --- | --- |
| 平台管理员 `admin` | 平台总览 → 公司与管理员：创建公司、创建公司管理员；跨公司查看设备 |
| 公司管理员 `company_admin` | 公司管理：创建/重命名/删除场景、生成单次邀请码、查看成员、分配客户设备；管理本公司设备 |
| 客户开发者 `developer` | 查看本公司设备和诊断信息，添加/删除/恢复设备，调整设备配置 |
| 公司客户 `customer` | 仅查看明确分配给自己的设备、监测数据及状态；不能修改或查看开发诊断 |

公司可以有多个自定义场景（例如一号温室、加工车间、冷链仓库），设备可以选择场景，设备类型独立选择。空场景表示未分组；有关联设备（含软删除设备）的场景不能删除。设备列表支持按场景筛选。

**升级现有数据库：** 首次启动自动新增公司、场景及客户设备授权表，保留已有账号、设备和历史记录。不自动提升已有账号权限，也不自动授予客户设备访问权；原客户账号升级后设备列表可能为空，需要公司管理员重新分配。部署前请停止服务并备份 SQLite 数据库；回滚需恢复配套代码与数据库备份。

平台管理员登录后进入“公司与管理员”，为已有或新公司创建公司管理员。也可在服务器终端创建（密码交互输入）：

```bash
.venv/bin/python manage_accounts.py --username company_a_admin --name 公司A管理员 --role company_admin --company company-a
```

公司管理员进入“公司管理”，生成客户或开发者邀请码。邀请码绑定本公司和邀请身份、7 天有效、一次使用，不允许邀请平台或公司管理员。客户注册后，由公司管理员勾选设备并保存分配；撤销分配立即限制设备列表和历史接口访问。

真实设备名称、位置、预期上报周期、场景和告警阈值保存到服务器，所有浏览器读取一致配置；预期上报周期只用于离线判断，不会下发修改硬件。后端不加载演示设备，不对访客提供模拟设备列表。后端服务异常会提示错误，不自动降级为演示登录。静态演示必须通过 `scripts/build_site.py` 构建；旧 `serial_server.py` 调试入口继续使用演示模式。

以下旧章节中涉及 `users.json` 登录、localStorage 配置、产业链层级的说明适用于静态演示；后端的角色与设备权限以上述规则为准。

## 云端准备功能

已加入接入地址配置、数据库账号、历史查询和 HTTPS/MQTT TLS。配置、迁移与验证步骤见 [CLOUD_SETUP.md](CLOUD_SETUP.md)。本机原启动方式继续可用。

## 推荐：本机平台设备接入

新增 `platform_server.py`，一次启动网页、设备登记数据库和带设备认证的 MQTT Broker。此模式模拟云端平台的接入流程，不依赖华为云服务，也不需要先启动匿名测试 Broker。

```bash
cd /home/vovl773/rd-web
.venv/bin/pip install -r requirements.txt
.venv/bin/python platform_server.py --port 8002
```

打开 `http://127.0.0.1:8002/`，登录 `developer`（密码 `123456`）→ **设备管理**：

1. 填写名称、设备类型和安装位置；设备 ID 留空可自动生成。
2. 点击“创建设备并生成接入配置”，设备立即归属当前开发者的公司，显示“待激活”。
3. 下载 **secrets.h**，填写 Wi-Fi 名称和密码，放到 `firmware/mega_mqtt_bridge/include/secrets.h`，使用更新后的桥接固件编译、烧录。其他板型可下载 JSON，配置对应的 MQTT 参数。
4. 板子用独立用户名、密钥和 Client ID 连接指定服务器，向专属 Topic 上报。无需扫描 IP 或在网页选择消息；有效数值上报到达后，列表和监测页自动更新。
5. 同一公司的 `customer` 登录后可读取这些设备和数据，其他公司的账号不能通过设备 API 读取。

设备密钥只在创建或重置时显示一次。网页提供“接入配置”入口查看地址、Topic 和身份信息；丢失密钥时选择重置，再更新板端配置。数据库只保存设备密钥摘要，不保存可恢复的原密钥。删除设备会拒绝后续连接及上报，恢复后等待新上报；删除、恢复和重置保留最近采样；恢复或重置后必须收到新上报才会重新显示在线。

### 本机地址与网络

如果仅使用电脑上的软件 MQTT 客户端测试、不接真实板子，可以显式限制为回环地址：

```bash
.venv/bin/python platform_server.py --port 8002 --mqtt-bind 127.0.0.1 --device-host 127.0.0.1
```

此方式不会向其他设备提供 MQTT 接入，网页会提示“仅本机可访问”。要连接真实板子，停止该进程，再使用上面的默认启动命令（或显式配置 `--mqtt-bind 0.0.0.0`）启用局域网监听。


启动时自动选择一个本机 IPv4 地址写入板端配置；多网卡、VPN 或识别错误时显式指定电脑在板子所在局域网中的地址，例如：

```bash
.venv/bin/python platform_server.py --port 8002 --device-host 192.168.1.100
```

`192.168.1.100` 只是示例，需替换为实际电脑 IP。网页默认仅监听本机 `127.0.0.1:8002`；MQTT 默认监听所有网卡的 TCP 1883，板子需要能访问该端口。板子中不能填 `127.0.0.1`，它指向板子自己。两个网络不互通时本机测试不能直接跨网访问，后续云服务器提供公网接入。

若需同一局域网的手机或其他电脑打开网页，可启动：

```bash
.venv/bin/python platform_server.py --host 0.0.0.0 --port 8002 --device-host 192.168.1.100
```

其他终端访问 `http://192.168.1.100:8002/`。默认 MQTT 端口已被旧 Broker 占用时，先停止旧测试 Broker，或指定 `--mqtt-port 1884`；下载的板端配置会使用指定端口。电脑休眠或关闭服务时将停止接收上报。

### 上报协议与数据保存

- MQTT 3.1.1；Client ID 和用户名均为网页生成的设备 ID，密码为设备专属密钥。
- 每台设备只能发布 `rd/devices/<设备ID>/telemetry`，不允许订阅其他设备；每次发布重新校验凭证，旧连接在重置密钥后也无法继续写数据。
- 支持 Mega 原始文本（如 `温度：10 ℃ 湿度：42％`）和下文的 JSON 数值格式；指标按实际消息解析。每条有效上报表示当前完整指标集合。
- 不使用 MQTT 保留消息激活设备。有效采样超过 `max(15 秒, 3 × 预期上报周期)` 未更新即显示离线；无有效数值时保持“待激活”，诊断提示格式问题。
- SQLite 默认保存在 `data/platform.sqlite3`，保存设备、数据库账号和最近 **90 天**实际消息（可配置）。实时快照只返回最近 30 条，设备详情提供时间范围和分页历史查询，服务重启后数据保留。
- 新设备的创建、删除、恢复和采样来自服务端；原有 JSON 演示设备及旧浏览器登记记录仍作为演示内容保留。名称、阈值、采样周期编辑仍沿用浏览器本地配置，不会自动下发硬件。
- 数据库、后端源文件和板端私密配置均不通过网页静态资源接口公开；`data/` 已加入 Git 忽略。

### 本机版边界与后续云端迁移

后端模式使用 SQLite 账号，初次本机启动从 `users.json` 导入体验账号，首次成功登录升级密码摘要为 scrypt。正式账号可由 `manage_accounts.py` 创建，也可生成公司邀请码后由用户在网页登录页注册；网页“我的”可修改密码并令旧会话失效。后端不再对外提供 `users.json`；纯静态站仍保留原有 JSON 演示登录。设备 API、历史查询和 MQTT Topic 均检查公司及设备权限。

默认启动参数使用本机明文 HTTP/MQTT，保留体验账号。已支持 HTTPS/MQTT TLS、域名和对外端口配置；`--production` 拒绝体验账号并要求 HTTPS/MQTT TLS，启动前需创建正式管理员。购买云服务器后迁移后端和 SQLite，配置域名、有效证书、反向代理及备份，再下载 TLS 配置并更新板端固件。完整步骤见 [CLOUD_SETUP.md](CLOUD_SETUP.md)。

`serial_server.py` 和 `mqtt_test_broker.py` 保留为旧 USB／匿名 MQTT 调试方式，不能用旧的匿名连接参数接入新平台。新平台中 USB 原始采集入口仅管理员可用，设备 MQTT 数据直接在设备页查看。GitHub Pages 仍为静态演示，不提供新平台后端；以下原有静态登记与消息发现说明只适用于旧调试模式。

验证命令：

```bash
node tests/portal.test.cjs
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
.venv/bin/python scripts/build_site.py
```

## 页面视觉与交互

客户展示首页参考 Azure IoT 的产品页结构：蓝色渐变首屏、设备监测界面示意、吸顶栏目导航、可折叠的平台概述、农牧链/工业链方案、功能卡片、三步使用流程与登录区域。首页图表数值明确标为界面示意，不代表真实设备采样；登录后进入原有公司工作台。

动态效果包括首屏图表绘制与光环呼吸、连接图数据流、行业切换过渡、内容随滚动出现及悬停反馈。系统启用“减少动态效果”时自动关闭动画。首页支持手机排版，不依赖第三方动画库或远程图片。

## 身份与页面

| 身份 | 登录后入口 | 功能 |
| --- | --- | --- |
| 平台管理员 `admin` | 供应链平台 | 农牧链 / 工业链 / 物流链 / 测试，查看公司，编辑公司 Markdown 页面 |
| 客户开发者 `developer` | 所属公司 | 首页 / 新闻 / 我的，查看设备，添加 / 删除 / 恢复本公司设备，修改阈值、查看报错 |
| 客户 `customer` | 所属公司 | 首页 / 新闻 / 我的，只读设备数据 |

演示账号为 `admin`、`developer`、`customer`、`customer_b`，密码均为 `123456`。`customer` 和 `developer` 属于公司 A；`customer_b` 属于公司 B。

管理员进入农牧链后可选种植园、养殖场；工业链可选生产、维保；物流链可选仓储，云仓物流展示仓库温度、湿度与光照强度的模拟采样。进入场景后选择公司。

公司首页显示设备总数、在线数量、预警数量和设备列表。只有一台预警设备时点击预警直接进入该设备；多台时显示预警列表。离线设备显示最后一次模拟值。

公司工作台使用蓝色运行概览、状态环图、可切换设备的采样曲线，以及包含具体读数的设备卡片；“需要关注”清单可直达预警或离线设备。数据均来自当前公司的 JSON 模拟快照与已有历史采样，不生成实时读数。底部同步显示本公司可见的最新新闻。

客户与客户开发者使用深色侧栏的数据驾驶舱，提供概览、设备管理、数据监测、告警中心、新闻和个人入口。顶部城市背景只用于欢迎区和统计卡片所在区域，图片位于 `assets/workspace/city.jpg`。设备表支持名称、ID、位置搜索；顶部搜索按 Enter 后跳转到设备表。采集点分布是可点击的布局示意，未提供经纬度，因此不代表真实地图位置。

## 账号与公司配置

`users.json` 中的 `role` 支持 `customer`、`developer`、`admin`，省略或不识别时默认客户。`companyId` 指向 `platform.json` 的公司 ID。平台管理员只能在此文件配置，不开放注册。

网页注册默认创建客户，存储于当前浏览器 localStorage，不能跨浏览器共享。若需长期分配开发者身份，应将账号加入 `users.json`，填写 `passwordHash`、`role` 和 `companyId`。JSON 账号优先于同名本地注册账号。密码字段使用 SHA-256，可生成：

```bash
python3 -c "import getpass,hashlib; print(hashlib.sha256(getpass.getpass('密码: ').encode()).hexdigest())"
```

这只是前端身份与路由演示，不是真实身份认证或公司数据隔离。JSON 数据可被访客下载，浏览器存储可被修改；正式部署敏感数据需要后端登录、密码安全散列与服务端权限校验。注册时选择公司也是演示逻辑，正式版本应使用审核或邀请。

## Markdown 自动生成公司首页

`platform.json` 定义产业链、场景与公司。每家公司的 `template` 指向 `content/companies/公司ID.md`。

首页文件包含恰好一个 dashboard 配置块，其余正文支持标题、段落、列表和粗体，HTML 会转义：

````markdown
# 公司首页

```dashboard
{
  "title": "公司 A，欢迎回来",
  "subtitle": "查看设备与预警",
  "accent": "green",
  "widgets": ["total", "online", "alerts"],
  "showDevices": true
}
```

## 运营提示

- 点击预警查看异常设备。
````

`accent` 可选 `green`、`blue`、`purple`、`orange`。`widgets` 控制统计项的显示和顺序；`showDevices` 控制设备列表。

管理员进入公司，点击“配置页面”，可预览、保存、导出 Markdown。网页保存仅影响当前浏览器；导出后替换对应 `.md` 文件并部署才会共享给其他人。阈值修改同样保存在当前浏览器；导出 JSON 可得到完整设备配置，其余公司保留原始配置，不会向真实设备下发指令。

## Markdown 新闻文章

平台管理员在 `_news/` 中新增 `.md` 文件，新闻列表自动按日期倒序排列，点击标题或“阅读全文”打开正文。正文提供目录、返回列表和上一篇/下一篇。

例如 `_news/2026-10-28-example.md`：

```markdown
---
title: 设备巡检通知
date: 2026-10-28
author: 平台管理员
summary: 本周设备巡检安排。
image: assets/news/platform-update.png
companyId: company-a
draft: false
---

## 巡检安排

请检查设备供电和网络连接。

- 查看设备在线状态。
- 点击预警定位异常设备。
```

`title` 必填；日期省略时读取文件名开头的 `YYYY-MM-DD`；摘要省略时自动提取。省略 `companyId` 表示所有公司可见，填写时应使用 `platform.json` 中已有的公司 ID。`draft: true` 不发布。管理员可查看全部文章；这些范围是前端演示规则，静态文章内容仍然公开可下载。

新闻列表使用左文右图卡片，`image` 指定封面路径，例如 `assets/news/platform-update.png`，也支持 HTTPS 图片地址。封面建议横向图片，约 16:10；图片会裁切填满右侧区域。未填写、路径不支持或加载失败时显示默认封面。手机上图片移到正文摘要下方。

支持标题、段落、粗体、斜体、列表、引用、代码块、链接和图片，HTML 会转义。图片放在 `assets/news/`，正文使用 `![图片说明](assets/news/example.jpg)`。暂不支持 Markdown 表格和 Mermaid 渲染。

本地 `serial_server.py` 每次请求都扫描目录，重新进入“新闻”即可读取新文章。普通静态服务器无法扫描目录，需要先构建，并复制生成的索引到根目录：

```bash
.venv/bin/python scripts/build_site.py
cp dist/news-index.json news-index.json
```

### GitHub Pages 自动发布

仓库已包含 `.github/workflows/pages.yml`。在 GitHub 仓库 **Settings → Pages → Source** 选择 **GitHub Actions**，之后推送到 `main` 会自动扫描 `_news/`、生成 `dist/` 并发布。文章格式错误会让构建失败，避免静默漏发；本地新闻页会显示错误文件。本次未在 GitHub 远程执行发布。

## 本地预览与测试

```bash
cd /home/vovl773/rd-web
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python serial_server.py --port 8002
```

打开 http://127.0.0.1:8002/ 。普通静态预览也可使用 `python3 -m http.server 8002`，但不提供采集 API。

登录 `admin` → 测试 → USB 或本地联网。两种源独立维护消息缓冲区；MQTT 也可由客户开发者的设备管理入口启动接收，不烧录固件。

```bash
.venv/bin/python serial_server.py --source both --port 8002 --device /dev/ttyUSB0 --baudrate 9600 --mqtt-host 127.0.0.1 --mqtt-port 1883 --mqtt-topic 'rd-web/test/#'
```

USB 测试按行读取串口。MQTT 测试订阅指定 Broker，Broker 需要单独运行；可用项目中的测试 Broker：

```bash
.venv/bin/python mqtt_test_broker.py
```

设备必须已配置为向对应 Broker / Topic 发消息。页面会显示实际连接错误与原始接收消息，不会伪造设备连接成功。暂停、清空仅影响显示；服务最多保留 500 条。`--source serial` 或 `--source mqtt` 可只启用一种源。

本地采集 API 仅接受 localhost/127.0.0.1 同源访问。服务只提供白名单站点资源，不公开固件、本地配置和 Git 文件；API 本身没有正式账号认证，仅用于本机测试。GitHub Pages 不运行 Python 服务，也不能直接读取 USB 或 TCP 1883。

## 主要文件

- `index.html`、`styles.css`：页面入口与样式。
- `visual.js`：入口页、场景插画、行业标签切换与入场动效。
- `portal.js`：登录注册、身份分流、产业链/公司路由、Markdown 首页。
- `app.js`：设备监测、阈值编辑、预警与采集展示。
- `users.json`：账号、身份、公司关联。
- `platform.json`、`content/companies/*.md`：平台结构与公司页面配置。
- `_news/*.md`、`news.js`：新闻源文件、列表与正文渲染。
- `news_content.py`、`scripts/build_site.py`：自动扫描文章与静态网站构建。
- `devices.json`：公司设备、传感器、模拟快照与诊断数据。
- `serial_server.py`、`mqtt_monitor.py`：本地 USB/MQTT 接收服务。

使用 GitHub Actions 时提交网站源码、`_news`、`content`、构建脚本和工作流即可；手动部署时上传 `dist/` 内全部文件。请勿上传 `.venv`、WiFi 密码、固件私密配置或 Git 凭据。

## 客户开发者设备管理

客户开发者可从侧栏“设备管理”或工作台“管理设备”进入，添加、删除、恢复本公司设备。可选设备类型由 `platform.json` 中业务场景的 `sceneIds` 指定。设备 ID 不区分大小写查重，已删除设备的 ID 保留，可恢复使用。新增设备必须先通过 MQTT 实际上报：打开管理页后自动监听本地接收服务，选择已发现的设备、预览指标，再填写设备名称、安装位置等信息才能添加。页面不扫描 IP；设备需要连接同一局域网可达的 MQTT Broker，并发布到服务订阅的 Topic。场景只决定业务分类，监测卡片和详情指标按实际上报动态生成，不再套用场景的固定传感器列表。

设备增删记录保存于当前浏览器 localStorage，刷新后保留，同一浏览器的客户和管理员读取相同的本地设备列表。管理页可导出完整 `devices.json`（包含本公司新增、删除及配置修改，保留其他公司的设备）；替换项目文件并重新部署后其他浏览器才能读取。删除前需确认，可在“已删除设备”中恢复；不会向硬件发送指令。该功能沿用静态站演示权限，生产部署仍需服务端鉴权和持久化接口。


### MQTT 发现与动态监测

通过本地预览服务启动，替换下面的 Broker 地址及 Topic 为实际配置：

```bash
.venv/bin/python serial_server.py --port 8002 --source mqtt --mqtt-host 192.168.1.100 --mqtt-topic 'sensors/#'
```

浏览器仍访问 `http://127.0.0.1:8002/`，登录客户开发者 → 设备管理。没有收到可识别的有效上报时不能直接添加。可读取以下文本：

```text
温度：10 ℃  湿度：42％
```

温度统一显示 `℃`。也支持 JSON 数值、带单位字符串或 `{value, unit}` 形式；`data`、`metrics`、`values` 对象可作为指标容器：

```json
{
  "device_id": "sensor-001",
  "name": "温湿度终端",
  "data": {
    "temperature": {"value": 10, "unit": "℃"},
    "humidity": {"value": 42, "unit": "%"},
    "光照": {"value": 100, "unit": "lx"}
  }
}
```

设备按 Topic 与 `device_id`（也支持 `deviceId`、`id`）组合识别。未提供 ID 时，一个 Topic 视为一台设备；多个设备共用 Topic 必须带各自 ID。每条上报视为当前完整指标集合，字段增减会更新卡片，最近 30 次实际接收值形成趋势，不推测数据。温湿度以外的数值字段按原名称和单位展示。新指标默认没有告警阈值，可在设备配置中设置。

保留消息可预览但不能据此添加或判定在线。超过 `max(15 秒, 3 × 配置采样周期)` 没有新上报或接收服务断开时显示离线，保留最后接收值。刷新后保留设备绑定，收到数据前显示待接收；请将网页采样周期设置为设备实际周期，该设置不会修改固件。发现列表仅覆盖接收缓冲区和当前打开页面期间收到的消息。GitHub Pages 只展示静态站点，设备发现和实时监测需要本地服务。

### Mega → ESP8266 的真实串口数据接入

新增固件位于 `firmware/mega_mqtt_bridge/`，使用 GPIO3/RX、9600 波特率接收 Mega 的换行文本，并通过 MQTT 发布到 `rd-web/test/mega-<芯片ID>`。温湿度等指标由网页按原始正文识别。接线、私密配置、编译与独立下载器步骤见该目录的 `README.md`。该固件不生成模拟传感器读数；WiFi、Broker 连接信息只输出到串口日志。
