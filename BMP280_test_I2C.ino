#include "DFRobot_BMP280.h"
#include <Wire.h>

typedef DFRobot_BMP280_IIC BMP;

// incearca mai intai cu eSdoLow = 0x76
BMP bmp(&Wire, BMP::eSdoLow);

#define SEA_LEVEL_PRESSURE 1015.0f

void printLastOperateStatus(BMP::eStatus_t eStatus)
{
  switch(eStatus) {
    case BMP::eStatusOK:
      Serial.println("everything ok");
      break;
    case BMP::eStatusErr:
      Serial.println("unknown error");
      break;
    case BMP::eStatusErrDeviceNotDetected:
      Serial.println("device not detected");
      break;
    case BMP::eStatusErrParameter:
      Serial.println("parameter error");
      break;
    default:
      Serial.println("unknown status");
      break;
  }
}

void setup()
{
  Serial.begin(115200);
  delay(1000);

  Serial.println("bmp read data test");

  // IMPORTANT pentru ESP32-C6
  Wire.begin(6, 7);

  delay(100);

  while (bmp.begin() != BMP::eStatusOK) {
    Serial.println("bmp begin failed");
    printLastOperateStatus(bmp.lastOperateStatus);
    delay(2000);
  }

  Serial.println("bmp begin success");
}

void loop()
{
  float temp = bmp.getTemperature();
  uint32_t press = bmp.getPressure();
  float alti = bmp.calAltitude(SEA_LEVEL_PRESSURE, press / 100.0);

  Serial.println();
  Serial.println("======== start print ========");
  Serial.print("temperature (C): ");
  Serial.println(temp);
  Serial.print("pressure (Pa): ");
  Serial.println(press);
  Serial.print("altitude (m): ");
  Serial.println(alti);
  Serial.println("======== end print ========");

  delay(1000);
}
