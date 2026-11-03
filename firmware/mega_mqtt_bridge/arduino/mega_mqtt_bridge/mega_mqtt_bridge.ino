#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include "secrets.h"
#ifndef MQTT_USE_TLS
#define MQTT_USE_TLS 0
#endif
#if MQTT_USE_TLS
#include <WiFiClientSecureBearSSL.h>
#include <time.h>
#ifndef MQTT_CA_CERT
#error "TLS requires MQTT_CA_CERT in secrets.h"
#endif
BearSSL::WiFiClientSecure network;
BearSSL::X509List trustAnchor(MQTT_CA_CERT);
#else
WiFiClient network;
#endif

// UART0: GPIO3/RX receives Mega TX1; GPIO1/TX prints logs to the USB adapter.
// No software TX pin is needed, and GPIO8 remains reserved for flash memory.
PubSubClient mqtt(network);
String clientId, topic, incoming;
constexpr size_t MAX_LINE = 512;
constexpr uint8_t QUEUE_SIZE = 4;
String pending[QUEUE_SIZE];
uint8_t queueHead = 0, queueCount = 0;
bool discardLine = false, wifiWasConnected = false;
unsigned long lastWifiAttempt = 0, lastMqttAttempt = 0;
#if MQTT_USE_TLS
unsigned long lastTimeNotice = 0;
bool timeWasReady = false;
#endif

const char *mqttError(int state) {
  switch (state) {
    case -4: return "server response timed out";
    case -3: return "connection lost";
    case -2: return "TCP/TLS connection failed";
    case -1: return "disconnected";
    case 1: return "unsupported MQTT version";
    case 2: return "client ID rejected";
    case 3: return "server unavailable";
    case 4: return "device username/password rejected";
    case 5: return "device not authorized";
    default: return "unknown error";
  }
}

void readMega() {
  while (Serial.available()) {
    const char byte = static_cast<char>(Serial.read());
    if (byte == '\r') continue;
    if (byte == '\n') {
      if (discardLine) {
        Serial.println("[SERIAL] Line exceeded 512 bytes; discarded.");
      } else {
        incoming.trim();
        if (!incoming.isEmpty()) {
          Serial.print("[MEGA] "); Serial.println(incoming);
          if (queueCount == QUEUE_SIZE) {
            queueHead = (queueHead + 1) % QUEUE_SIZE;
            --queueCount;
            Serial.println("[MQTT] Queue full; oldest line discarded.");
          }
          pending[(queueHead + queueCount) % QUEUE_SIZE] = incoming;
          ++queueCount;
        }
      }
      incoming = "";
      discardLine = false;
    } else if (!discardLine) {
      if (incoming.length() < MAX_LINE) incoming += byte;
      else { incoming = ""; discardLine = true; }
    }
  }
}

void setup() {
  Serial.setRxBufferSize(2048);
  Serial.begin(9600);
  delay(100);
  incoming.reserve(MAX_LINE);
#ifdef MQTT_DEVICE_ID
  clientId = MQTT_DEVICE_ID;
  topic = MQTT_TOPIC;
#else
  clientId = "mega-bridge-" + String(ESP.getChipId(), HEX);
  topic = String(MQTT_TOPIC_PREFIX) + String(ESP.getChipId(), HEX);
#endif
  Serial.println("\n--- Mega -> ESP8266 -> MQTT ---");
  Serial.println("Mega RX: GPIO3, 9600 baud; newline terminates each message.");
  Serial.print("Broker: "); Serial.print(MQTT_HOST); Serial.print(':'); Serial.println(MQTT_PORT);
  Serial.print("Publish topic: "); Serial.println(topic);
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
#if MQTT_USE_TLS
  network.setTrustAnchors(&trustAnchor);
  network.setSSLVersion(BR_TLS12, BR_TLS12);
  configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
  Serial.println("[TLS] Waiting for network time; server certificate will be verified.");
#endif
  lastWifiAttempt = millis();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(1024);
  mqtt.setSocketTimeout(5);
  mqtt.setKeepAlive(20);
  lastMqttAttempt = millis() - 3000;
}

void loop() {
  readMega();
  const unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiWasConnected) {
      Serial.println("[WiFi] Disconnected.");
      mqtt.disconnect();
      wifiWasConnected = false;
    }
    if (now - lastWifiAttempt >= 10000) {
      lastWifiAttempt = now;
      Serial.println("[WiFi] Retrying connection...");
      WiFi.reconnect();
    }
  } else {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Serial.print("[WiFi] Connected, IP: "); Serial.println(WiFi.localIP());
    }
#if MQTT_USE_TLS
    // Keep reading UART while SNTP starts. Never disable certificate checks.
    if (time(nullptr) < 1700000000) {
      if (now - lastTimeNotice >= 10000) {
        lastTimeNotice = now;
        Serial.println("[TLS] Waiting for SNTP time; check Internet/NTP access.");
      }
      yield();
      return;
    }
    if (!timeWasReady) {
      timeWasReady = true;
      Serial.printf("[TLS] Network time ready: %ld. TLS 1.2; certificate verification enabled.\n", static_cast<long>(time(nullptr)));
    }
#endif
    if (!mqtt.connected() && now - lastMqttAttempt >= 3000) {
      lastMqttAttempt = now;
      IPAddress brokerIP;
      if (WiFi.hostByName(MQTT_HOST, brokerIP) != 1) {
        Serial.println("[DNS] Cannot resolve MQTT server; check DNS/Internet access.");
        yield();
        return;
      }
      Serial.print("[MQTT] Connecting to "); Serial.print(MQTT_HOST);
      Serial.print(" ("); Serial.print(brokerIP); Serial.print("):"); Serial.println(MQTT_PORT);
#ifdef MQTT_DEVICE_ID
      const bool connected = mqtt.connect(clientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD);
#else
      const bool connected = mqtt.connect(clientId.c_str());
#endif
      if (connected) {
        Serial.print("[MQTT] Connected. Publishing to "); Serial.println(topic);
      } else {
        Serial.print("[MQTT] Connection failed, state: "); Serial.print(mqtt.state());
        Serial.print(" ("); Serial.print(mqttError(mqtt.state())); Serial.println(')');
#if MQTT_USE_TLS
        char tlsError[128] = {};
        const int tlsCode = network.getLastSSLError(tlsError, sizeof(tlsError));
        Serial.printf("[TLS] Last error: %d (%s); free heap: %u bytes\n", tlsCode, tlsError, ESP.getFreeHeap());
#endif
      }
    }
    if (mqtt.connected()) {
      mqtt.loop();
      if (queueCount) {
        const String &line = pending[queueHead];
        // Forward actual Mega text unchanged. Never fabricate sensor values.
        if (mqtt.publish(topic.c_str(), line.c_str(), false)) {
          Serial.print("[MQTT] Published: "); Serial.println(line);
          pending[queueHead] = "";
          queueHead = (queueHead + 1) % QUEUE_SIZE;
          --queueCount;
        }
      }
    }
  }
  yield();
}
