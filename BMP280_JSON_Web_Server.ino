#include <WiFi.h>
#include <Wire.h>
#include "DFRobot_BMP280.h"
#include <WebSocketsClient.h>

typedef DFRobot_BMP280_IIC BMP;
BMP bmp(&Wire, BMP::eSdoLow);   // daca nu merge, incearca BMP::eSdoHigh

const char* ssid = "Cyan";
const char* password = "Adevarat";

// Date Raspberry Pi
const char* ws_host = "10.48.238.33";   // pune IP-ul Raspberry aici
const uint16_t ws_port = 8080;          // pune portul aici
const char* ws_path = "ws://10.48.238.33:8080";              // pune path-ul websocket aici, ex "/" sau "/ws"

WebSocketsClient webSocket;

unsigned long lastSend = 0;
const unsigned long sendInterval = 1000;

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Deconectat");
      break;

    case WStype_CONNECTED:
      Serial.println("[WS] Conectat la Raspberry");
      Serial.printf("[WS] URL: ws://%s:%u%s\n", ws_host, ws_port, ws_path);
      break;

    case WStype_TEXT:
      Serial.printf("[WS] Mesaj de la server: %s\n", payload);
      break;

    case WStype_ERROR:
      Serial.println("[WS] Eroare");
      break;

    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Wire.begin(6, 7);   // ESP32-C6: SDA=GPIO6, SCL=GPIO7

  Serial.println("Initializare BMP280...");
  while (bmp.begin() != BMP::eStatusOK) {
    Serial.println("BMP280 nu a fost gasit");
    delay(2000);
  }
  Serial.println("BMP280 OK");

  Serial.print("Conectare la WiFi");
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("WiFi conectat");
  Serial.print("IP ESP32: ");
  Serial.println(WiFi.localIP());

  webSocket.begin(ws_host, ws_port, ws_path);
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);

  Serial.println("Pornire client WebSocket...");
}

void loop() {
  webSocket.loop();

  if (WiFi.status() == WL_CONNECTED && millis() - lastSend >= sendInterval) {
    lastSend = millis();

    float temp = bmp.getTemperature();
    uint32_t pressPa = bmp.getPressure();
    float presshPa = pressPa / 100.0;

    String json = "{";
    json += "\"temperature\":" + String(temp, 2) + ",";
    json += "\"pressure_pa\":" + String(pressPa) + ",";
    json += "\"pressure_hpa\":" + String(presshPa, 2);
    json += "}";

    webSocket.sendTXT(json);
    Serial.print("[WS] Trimis: ");
    Serial.println(json);
  }
}