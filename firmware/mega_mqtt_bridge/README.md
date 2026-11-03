# Mega → ESP-01 → MQTT 转发

该固件保留用户现有的 GPIO3/RX 接线，使用 UART0 硬件串口接收 Mega 的实际数据，不再占用 GPIO8。每条消息以换行结束，经 WiFi 转发到本机 MQTT Broker；不产生模拟读数。

## 新平台接入（推荐）

先运行 `platform_server.py`，网页使用开发者账号进入设备管理，创建设备并下载 `secrets.h`。将它放到本固件的 `include/secrets.h`，填好 Wi-Fi 名称与密码后编译。生成文件包含 `MQTT_DEVICE_ID`、`MQTT_USERNAME`、`MQTT_PASSWORD` 和 `MQTT_TOPIC`，固件将自动使用独立身份认证和专属 Topic，继续原样转发 Mega 的真实串口文本。

平台生成配置中的地址应为板子可访问的电脑局域网 IP。可用 `--device-host` 显式指定；不能使用 `127.0.0.1`。新平台已内置认证 Broker，不需要再运行下面的匿名测试 Broker。烧录后直接在设备列表和监测详情查看读数，设备无需再次从发现列表添加。

本机测试使用明文 MQTT；迁移云端后需另行配置 TLS，不应直接使用当前固件连接公开的明文服务。密钥不能共享到仓库或运行日志，下载的配置只在本机保存。

## 配置（旧匿名调试模式）

复制 `include/secrets.example.h` 为 `include/secrets.h`，填写实际 WiFi 和 Broker。私密文件已被仓库忽略；不要分享编译后的固件，它也包含连接凭据。

- Mega 串口和 ESP 接收波特率：9600。
- Mega TX1 → ESP GPIO3/RX；Mega 为 5V 逻辑时需降至 3.3V，两板共地。
- GPIO1/TX → 下载器 RX，输出运行日志。
- 发布话题：`rd-web/test/mega-<芯片ID>`，每台板子独立。
- 网页订阅：`rd-web/test/#`；诊断时可在本机使用 `#`。
- MQTT 消息不保留，正文为 Mega 的原始行文本。
- 单行最多 512 字节；离线缓冲最近 4 条，队列满时丢弃最旧条并输出日志。
- 新行必须以 LF（`\n`）结尾，兼容 CRLF；超过长度的整行丢弃，避免将半条数据当作读数。

例如 Mega 发送以下真实测量结果后，网页自动显示温度和湿度：

```text
温度：10 ℃  湿度：42％
```

## 编译

已通过 esptool 读取本次模块为 ESP8266EX、4MB Flash（Flash ID `0x16405e`），因此使用 4MB ESP8266 编译配置。用于其他模块前必须重新读取容量并调整配置。

在仓库根目录执行：

```bash
PLATFORMIO_CORE_DIR="$PWD/.venv/platformio-core" PLATFORMIO_SETTING_ENABLE_TELEMETRY=no .venv/bin/python -m platformio run --project-dir firmware/mega_mqtt_bridge
```

输出位于 `.pio/build/esp8266/firmware.bin`。

## 独立下载器与验证

1. 暂时断开 Mega TX1 到 ESP RX 的线，避免与下载器 TX 同时驱动 GPIO3。
2. 下载器 TX → ESP RX（GPIO3），下载器 RX ← ESP TX（GPIO1），GND 共地。使用稳定的 3.3V 供电，EN/CH_PD 为高；ESP 引脚不可直接接 5V。
3. GPIO0 拉低后重新上电进入下载模式；有 PROG/UART 开关的下载器按其说明切到下载档。上电时 GPIO2 应为高。
4. 先确认 esptool 能读取芯片和容量，再备份完整 Flash，最后烧录。若握手无应答，不擦写 Flash。
5. 烧录后释放 GPIO0，切回运行档并复位。USB 串口应输出 WiFi IP、Broker、发布话题和 MQTT 连接结果。
6. 断开下载器 TX 与 ESP RX 的连接后，再接回 Mega TX1；GPIO1 到下载器 RX 可保留以只读日志。
7. 让 Mega 发送真实测量数据，查看网页 MQTT 测试页，再由客户开发者在设备管理中选择已发现的设备。

仅在本机启动 Broker 和网页接收服务：

```bash
.venv/bin/python mqtt_test_broker.py
```

另一个终端：

```bash
.venv/bin/python serial_server.py --port 8765 --source mqtt --mqtt-host 127.0.0.1 --mqtt-topic 'rd-web/test/#'
```

浏览器访问 `http://127.0.0.1:8765/`。电脑应与板子在同一可互通局域网，电脑 IP 改变后需要更新固件中的 Broker 地址。服务连接 Broker 成功并不表示板子已连接，必须以实际设备消息验证。

## 加密 MQTT

平台开启 MQTT TLS 后，重新下载 secrets.h 并使用更新后的固件。配置包含 MQTT_USE_TLS=1 与 MQTT_CA_CERT（根 CA 公钥）；板子联网后先同步网络时间，再校验服务器证书和域名。时间未同步或证书验证失败时不会连接，不关闭证书验证。原配置未定义 MQTT_USE_TLS 时继续使用本机明文 MQTT。Arduino 工程与 src/main.cpp 保持同步；不要把服务器私钥烧到板子里。

配置说明见项目根目录 CLOUD_SETUP.md。
