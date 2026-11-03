# 四角色升级提示

> 接手项目、使用新服务器或新域名时，请先阅读 [README：新服务器、新域名部署与交接](README.md#新服务器新域名部署与交接)。本文保留本机测试与历史迁移背景，下面的历史 IP 配置及部署脚本不能直接用于新环境。

本次新增 `company_admin` 身份和公司管理页面，使用方式见 README 的“四角色公司工作空间”。重启服务前备份 SQLite：新表会自动创建，但已有客户不会自动获得设备授权。请由平台管理员创建公司管理员，再由公司管理员为客户分配设备。公司与自定义场景已保存到数据库，新增公司无需修改 platform.json。

公司管理员也可由服务器终端创建：

```bash
.venv/bin/python manage_accounts.py --username company_a_admin --name 公司A管理员 --role company_admin --company company-a
```

下文的服务器端命令行邀请码仍是运维工具；日常邀请由公司管理员在网页登录后生成。真实设备配置现已统一保存到后端。

# 从本机测试到云端接收

现在已具备：可配置接入域名和端口、数据库账号、按时间分页查询历史、HTTPS、带证书校验的设备 MQTT TLS。先在本机测试；购买云服务器后替换域名和证书即可。现有设备 ID、密钥及接入主题不需要重新创建。

## 1. 当前本机继续使用

在项目目录执行原来的启动命令即可。本机模式仍允许已有体验账号登录，首次成功登录会将其旧密码摘要升级为加盐 scrypt；以后账号修改存入 SQLite，不再修改 users.json。

```bash
.venv/bin/python platform_server.py --port 8002 --mqtt-bind 0.0.0.0 --device-host 你的电脑局域网IP
```

也可使用 JSON 配置文件，命令行参数覆盖文件里的对应项。相对文件路径按配置文件所在目录解析。

```bash
.venv/bin/python platform_server.py --config config/platform.local.example.json
```

注意：上面的示例配置只允许本机 MQTT 客户端接入。要连接真实板子，将配置里的 mqtt_bind 改为 0.0.0.0，device_host 改为板子可访问的电脑局域网 IP。不需要停止、删除或重新创建设备。

## 2. 创建正式账号

账号保存在 data/platform.sqlite3。密码在终端交互输入，不会回显，也不出现在命令行参数中。密码长度为 12–100 个字符。

创建管理员：

```bash
.venv/bin/python manage_accounts.py --username platform_admin --name 平台管理员 --role admin
```

创建公司开发者或客户：

```bash
.venv/bin/python manage_accounts.py --username company_a_dev --name 公司A开发者 --role developer --company company-a
.venv/bin/python manage_accounts.py --username company_a_user --name 公司A客户 --role customer --company company-a
```

网页已提供“登录 / 注册”切换。新用户注册需要公司邀请码，由服务器确定公司和客户/开发者身份，不能自行选择其他公司或注册管理员。管理员在本机生成邀请码：

```bash
.venv/bin/python manage_accounts.py --invite-company company-a --invite-role customer
.venv/bin/python manage_accounts.py --invite-company company-a --invite-role developer
```

每条命令生成一个邀请码，7 天有效、仅可成功注册一次。把对应的邀请码交给该公司的用户；用户填写姓名、账号、至少 12 位密码和邀请码后，注册成功即登录。账号和设备数据保存在服务器，可跨浏览器使用。

使用自定义数据库时，两个程序都要指定同一个 --database 路径。公司 ID 来自 platform.json；开发者管理自己公司的设备，客户只读，管理员可跨公司查看。

登录后在“我的”页面修改密码；修改会令该账号所有会话失效。退出登录立即移除当前会话，会话最长有效 12 小时，重启服务后需重新登录。登录失败超过 5 次会限制该账号 15 分钟，同一来源也有累计限制；失败计数保存在数据库，重启不会清除。

正式模式不会导入或允许体验账号；已有体验账号设置符合长度要求的新密码后，会转为正式账号。正式部署前先创建一个独立的正式管理员。

## 3. 查询历史

进入已登记设备的详情页，下方“历史数据”选择开始和结束时间，点击“查询历史”。

- 默认查询最近 24 小时，每页 200 条；可继续读取更早记录。
- 曲线上的点可查看对应数值和接收时间；表格显示原始上报内容。
- 每次页面最多展示 2000 条，更多数据可缩小时间范围分段查询。曲线每个指标最多均匀选取 200 个原始采样点，保留两端；表格保留全部已读取消息。
- 实时卡片依旧显示最近 30 条；服务器默认保留 90 天，使用 --retention-days 调整。
- 时间按浏览器本地时区显示，来源是服务器接收时间。设备尚未上报自己的采样时间。
- 同一数据库中历史数据跨服务重启保留；更早版本已删除的第 30 条以前的数据无法恢复。
- 过期数据不会被查询返回；上报时最多每小时清理一次过期记录。建议按数据量调整保留天数，定期使用 SQLite 在线备份。

接口（需要有效登录 Cookie，并检查公司归属）：

```text
GET /api/devices/<设备ID>/history?start=<Unix秒>&end=<Unix秒>&limit=200
```

响应包含 readings（按消息序号从新到旧）、nextBefore（下一页游标）、retentionDays。下一页携带 before=nextBefore，保持原来的 start/end。每页最多 500 条，一次时间范围最多 366 天。

## 4. 本机验证 HTTPS 和设备 TLS

生成仅供测试的 CA 和服务器证书；脚本不会安装系统信任根，也不覆盖已有证书目录。

```bash
.venv/bin/python scripts/create_local_tls.py
```

如果让真实板子连接电脑，在生成时把电脑的局域网 IP 加入证书：

```bash
.venv/bin/python scripts/create_local_tls.py --output data/tls-board-test --host 你的电脑局域网IP
```

仅本机客户端的测试启动方式（使用独立数据库和端口，不影响 8002/1883 上的设备）：

```bash
.venv/bin/python platform_server.py --host 127.0.0.1 --port 8443 --mqtt-bind 127.0.0.1 --mqtt-port 8883 --device-host localhost --database data/tls-test.sqlite3 --https-cert data/tls-local/server-cert.pem --https-key data/tls-local/server-key.pem --mqtt-cert data/tls-local/server-cert.pem --mqtt-key data/tls-local/server-key.pem --mqtt-ca data/tls-local/root-ca.pem
```

用指定的 CA 验证 HTTPS，不关闭证书校验：

```bash
curl --cacert data/tls-local/root-ca.pem https://localhost:8443/api/platform
```

根 CA 证书是公钥，可包含在下载的 secrets.h；CA 私钥、服务器私钥只留在服务器端，不能放入板子。浏览器默认不信任自建测试 CA，以上流程通过客户端明确指定 CA 验证。正式网页使用受信任的公开证书。

TLS 模式下载的设备配置会包含 MQTT_USE_TLS=1 和 MQTT_CA_CERT。升级后的 ESP8266 固件会先同步网络时间，再验证服务器域名及证书；没有调用 setInsecure。SNTP 不通或证书不匹配时不会连接 MQTT，串口仍继续收集数据到有限队列。

## 5. 云服务器部署配置

参考 config/platform.cloud.example.json，复制成自己的配置，替换：

| 配置 | 用途 |
| --- | --- |
| public_origin | 网页实际 HTTPS 地址，如 https://iot.example.com；也可写成数组，同时放行 IP 与域名 |
| device_host | 板子优先访问的 MQTT 地址，必须是证书 SAN 中的名字或 IP |
| device_host_fallback | 可选，板子连不上主地址时回落使用的第二个地址 |
| mqtt_port | MQTT 服务监听端口，TLS 通常为 8883 |
| device_port | 板子访问的外部端口；没有端口映射时与 mqtt_port 相同 |
| mqtt_cert / mqtt_key | MQTT 服务器完整证书链和对应私钥 |
| mqtt_ca | 用于板端验证证书链的根 CA 公钥证书 |
| production | true：拒绝体验账号，并要求 HTTPS 与 MQTT TLS |

### 域名备案前的 IP 测试模式

国内云服务器上，未备案域名会在链路上被按 Host 和 SNI 阻断：HTTP 返回 ICP 拦截页，TLS 连接在 ClientHello 之后被重置，改用 IP、端口或代理都无效。备案完成前可以先走 IP，不必买新机器：

```bash
.venv/bin/python scripts/create_local_tls.py --output data/tls-cloud \
  --host 47.96.223.50 --host 你的域名 --host mqtt.你的域名
.venv/bin/python platform_server.py --config config/platform.ip.json
```

`data/tls-cloud/server-cert.pem` 的 SAN 同时包含 IP 和域名，所以**一张证书、一次烧录**就能覆盖两种阶段：

- 现在：板子连 `device_host`（IP），浏览器开 `https://<IP>` 并手动信任自签 CA。
- 备案后：把配置换成 `config/platform.domain.json`，`device_host` 变为 `mqtt.<域名>`，IP 自动成为回落地址；同一块板子不用重烧。
- 板子侧固件用 `MQTT_HOST_FALLBACK` 实现主地址失败后自动回落到 IP，`secrets.h` 由网页下载时自动带上。

`public_origin` 写成数组后，同一份后端同时接受 IP 和域名来源，切换阶段不会出现“访问来源不被允许”。自签证书有效期 90 天，到期前用同一 CA 重签 `server-cert.pem` 即可，板端只需要信任 `root-ca.pem`。

推荐由 Caddy 等反向代理提供网页 HTTPS，后端仅监听 127.0.0.1:8002。配置 public_origin 后，后端会正确接受该域名的同源请求，并为登录 Cookie 添加 Secure；代理必须保留原始 Host。后端不依赖客户端可伪造的 X-Forwarded-Proto 判断是否启用 Secure。

Caddyfile 示例：

```text
iot.example.com {
    reverse_proxy 127.0.0.1:8002
}
```

网页 HTTPS 证书和 MQTT 证书可分别签发。MQTT 域名需要在 MQTT 证书的 SAN 中；完整链放 mqtt_cert，信任根放 mqtt_ca。证书续期后需重载服务；更换根 CA 时也需更新板端配置。

准备好正式账号、域名和证书后启动：

```bash
.venv/bin/python platform_server.py --config config/你的云端配置.json
```

服务器对外开放网页 HTTPS 入口及 MQTT TLS 端口；8002 和数据库留在本机内部。之后下载新 secrets.h、填写 Wi-Fi 并烧录板子，再用不同网络的手机打开网页验证。

切换到云端时可迁移当前 SQLite 数据库，保留设备身份和历史。用 SQLite backup API 做一致性备份，限制数据库和私钥文件权限；不要直接复制正在写入的 SQLite 文件。正式模式不会影响已有设备密钥，但当前明文固件需要重新烧录为 TLS 版本。

## 验证与回滚

```bash
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
node tests/portal.test.cjs
.venv/bin/python scripts/build_site.py
```

修改启动配置前保留原命令和数据库在线备份。恢复原来的本机启动参数，可继续使用原来的明文 MQTT 固件；数据库账号和历史表兼容原设备登记记录。公开服务不要退回明文连接。
