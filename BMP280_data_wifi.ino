#include <WiFi.h>
#include <WebServer.h>
#include <Wire.h>
#include "DFRobot_BMP280.h"

typedef DFRobot_BMP280_IIC BMP;
BMP bmp(&Wire, BMP::eSdoLow);

// WiFi
const char* ssid = "Cyan";
const char* password = "Adevarat";

// Server pe port 8080
WebServer server(8080);

void setup() {
  Serial.begin(115200);
  delay(1000);

  // I2C
  Wire.begin(6, 7);

  // Init BMP280
  while (bmp.begin() != BMP::eStatusOK) {
    Serial.println("BMP280 nu a fost gasit!");
    delay(2000);
  }
  Serial.println("BMP280 OK");

  // Conectare WiFi
  Serial.print("Conectare la WiFi...");
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nConectat!");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());

  // Ruta web
  server.on("/", []() {
    float temp = bmp.getTemperature();
    float press = bmp.getPressure() / 100.0;

    String html = "<html><body>";
    html += "<h1>ESP32-C6 BMP280</h1>";
    html += "<p>Temperatura: " + String(temp) + " C</p>";
    html += "<p>Presiune: " + String(press) + " hPa</p>";
    html += "</body></html>";

    server.send(200, "text/html", html);
  });

  server.begin();
  Serial.println("Server pornit pe port 8080");
}

void loop() {
  server.handleClient();
}