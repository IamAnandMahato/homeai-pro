/* HomeAI Pro - ESP8266 / NodeMCU ESP-12E
   Four relay controller + local authenticated HTTP endpoints + outbound MQTT TLS.
   Configure all credentials below before flashing. Keep relay supply wiring safe.
*/
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <WiFiClientSecureBearSSL.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* AP_SSID = "HomeAI-Setup";
const char* AP_PASSWORD = "ChangeThisAPPassword"; // at least 8 characters
const char* WEB_USERNAME = "admin";
const char* WEB_PASSWORD = "CHANGE_THIS_LONG_PASSWORD";

// Use the TLS hostname shown by your MQTT provider. Do not include mqtts://
const char* MQTT_HOST = "YOUR_CLUSTER.s1.eu.hivemq.cloud";
const uint16_t MQTT_PORT = 8883;
const char* MQTT_USERNAME = "YOUR_MQTT_USERNAME";
const char* MQTT_PASSWORD = "YOUR_MQTT_PASSWORD";
const char* MQTT_COMMAND_TOPIC = "homeai/your-random-device-id/cmd";
const char* MQTT_STATUS_TOPIC = "homeai/your-random-device-id/status";

// Paste the CA certificate supplied by your MQTT broker here (PEM format).
// TLS certificate verification is intentionally required; an empty value prevents MQTT connection.
static const char MQTT_ROOT_CA[] PROGMEM = R"CERT(
PASTE_BROKER_ROOT_CA_PEM_HERE
)CERT";

const bool RELAY_ACTIVE_LOW = true;
const unsigned long AUTO_OFF_MINUTES = 30;
const uint8_t RELAY_COUNT = 4;
const uint8_t relayPins[RELAY_COUNT] = { D1, D2, D5, D6 };
const char* deviceNames[RELAY_COUNT] = { "Light 1", "Fan", "Light 2", "Appliance 4" };

ESP8266WebServer server(80);
BearSSL::WiFiClientSecure secureClient;
PubSubClient mqtt(secureClient);
BearSSL::X509List* rootCA = nullptr;
bool relayState[RELAY_COUNT] = { false, false, false, false };
unsigned long relayStartedAt[RELAY_COUNT] = { 0, 0, 0, 0 };
unsigned long lastMqttAttempt = 0;

bool auth() {
  if (server.authenticate(WEB_USERNAME, WEB_PASSWORD)) return true;
  server.requestAuthentication(BASIC_AUTH, "HomeAI ESP8266");
  return false;
}
void writeRelay(uint8_t i, bool on) {
  if (i >= RELAY_COUNT) return;
  digitalWrite(relayPins[i], (RELAY_ACTIVE_LOW ? !on : on) ? HIGH : LOW);
  relayState[i] = on;
  relayStartedAt[i] = on ? millis() : 0;
  Serial.printf("%s: %s\n", deviceNames[i], on ? "ON" : "OFF");
}
void allOff() { for (uint8_t i = 0; i < RELAY_COUNT; i++) writeRelay(i, false); }
void checkAutoOff() {
  const unsigned long timeout = AUTO_OFF_MINUTES * 60UL * 1000UL;
  for (uint8_t i = 0; i < RELAY_COUNT; i++) {
    if (relayState[i] && (unsigned long)(millis() - relayStartedAt[i]) >= timeout) writeRelay(i, false);
  }
}
void publishStatus() {
  if (!mqtt.connected()) return;
  StaticJsonDocument<160> doc;
  JsonArray states = doc.createNestedArray("states");
  for (uint8_t i = 0; i < RELAY_COUNT; i++) states.add(relayState[i]);
  char out[200]; size_t n = serializeJson(doc, out, sizeof(out));
  mqtt.publish(MQTT_STATUS_TOPIC, out, n, true);
}
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (String(topic) != MQTT_COMMAND_TOPIC || length > 256) return;
  StaticJsonDocument<256> doc;
  if (deserializeJson(doc, payload, length)) return;
  const char* action = doc["action"] | "";
  if (strcmp(action, "alloff") == 0) { allOff(); publishStatus(); return; }
  if (strcmp(action, "relay") != 0 || !doc["id"].is<int>() || !doc["state"].is<bool>()) return;
  int id = doc["id"].as<int>();
  if (id < 0 || id >= RELAY_COUNT) return;
  writeRelay((uint8_t)id, doc["state"].as<bool>());
  publishStatus();
}
void connectMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  if (strlen(MQTT_ROOT_CA) < 100 || strstr(MQTT_ROOT_CA, "PASTE_BROKER") != nullptr) {
    Serial.println("MQTT blocked: paste the broker root CA certificate into MQTT_ROOT_CA.");
    return;
  }
  if (!rootCA) { rootCA = new BearSSL::X509List(MQTT_ROOT_CA); secureClient.setTrustAnchors(rootCA); }
  secureClient.setTimeout(15000);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(512);
  String clientId = "homeai-esp-" + String(ESP.getChipId(), HEX);
  if (mqtt.connect(clientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD)) {
    mqtt.subscribe(MQTT_COMMAND_TOPIC, 1);
    publishStatus();
    Serial.println("Secure MQTT connected.");
  } else Serial.printf("MQTT connect failed: %d\n", mqtt.state());
}
void sendState() {
  if (!auth()) return;
  StaticJsonDocument<200> doc; JsonArray a = doc.createNestedArray("states");
  for (uint8_t i = 0; i < RELAY_COUNT; i++) a.add(relayState[i]);
  String out; serializeJson(doc, out); server.send(200, "application/json", out);
}
void handleRelay() {
  if (!auth()) return;
  if (!server.hasArg("id") || !server.hasArg("state")) { server.send(400, "text/plain", "Missing id/state"); return; }
  int id = server.arg("id").toInt(); String s = server.arg("state");
  if (id < 0 || id >= RELAY_COUNT || (s != "0" && s != "1")) { server.send(400, "text/plain", "Invalid command"); return; }
  writeRelay((uint8_t)id, s == "1"); publishStatus(); server.send(200, "text/plain", "OK");
}
void handleAllOff() { if (!auth()) return; allOff(); publishStatus(); server.send(200, "text/plain", "All relays OFF"); }
void handleRoot() {
  if (!auth()) return;
  server.send(200, "text/html", "<!doctype html><meta name='viewport' content='width=device-width'><h2>HomeAI ESP8266</h2><p>Local controller online. Use the secured HomeAI cloud dashboard for chat and remote control.</p><p><a href='/api/state'>Relay state JSON</a></p>");
}
void setup() {
  Serial.begin(115200); delay(150);
  // Initialise outputs OFF before Wi-Fi/network setup.
  for (uint8_t i = 0; i < RELAY_COUNT; i++) { digitalWrite(relayPins[i], RELAY_ACTIVE_LOW ? HIGH : LOW); pinMode(relayPins[i], OUTPUT); digitalWrite(relayPins[i], RELAY_ACTIVE_LOW ? HIGH : LOW); }
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi"); unsigned long started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 18000UL) { delay(250); yield(); Serial.print('.'); }
  Serial.println(); Serial.print("Setup AP IP: "); Serial.println(WiFi.softAPIP());
  if (WiFi.status() == WL_CONNECTED) { Serial.print("HomeAI local IP: "); Serial.println(WiFi.localIP()); }
  server.on("/", HTTP_GET, handleRoot); server.on("/api/state", HTTP_GET, sendState);
  server.on("/api/relay", HTTP_POST, handleRelay); server.on("/api/alloff", HTTP_POST, handleAllOff); server.begin();
  Serial.println("Local HTTP server started. Replace all default credentials before use.");
}
void loop() {
  server.handleClient();
  checkAutoOff();
  if (!mqtt.connected() && millis() - lastMqttAttempt > 5000UL) { lastMqttAttempt = millis(); connectMqtt(); }
  mqtt.loop();
  yield();
}
