#pragma once
// Copy to ignored secrets.h and fill in the actual local connection settings.
#define WIFI_SSID "YOUR_2_4_GHZ_WIFI"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define MQTT_HOST "YOUR_COMPUTER_LAN_IP"
#define MQTT_PORT 1883
// A unique chip ID is appended so every board uses its own telemetry topic.
#define MQTT_TOPIC_PREFIX "rd-web/test/mega-"

// Use the downloaded platform config for TLS and per-device credentials.
#define MQTT_USE_TLS 0
// TLS config includes: MQTT_USE_TLS 1 and MQTT_CA_CERT (root CA PEM).
