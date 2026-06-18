#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ── Pins ─────────────────────────────────────────────────────
#define LEFT_MOTOR   12
#define RIGHT_MOTOR  14
#define STATUS_LED    2

// ── PWM ──────────────────────────────────────────────────────
#define PWM_FREQ   5000
#define PWM_RES    8
// ERM coin motors require higher duty cycles to overcome static friction
#define INT_LOW    200   // Increased to guarantee the ERMs spin
#define INT_MED    230   // Strong turn buzz
#define INT_HIGH   255   // Sharp/complex max intensity
#define INT_FULL   255   // 100% — arrival/rerouting only

// ── BLE ──────────────────────────────────────────────────────
// Updated UUIDs to match HapNav's script.js Web Bluetooth configuration
#define SERVICE_UUID        "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define CHARACTERISTIC_UUID "6e400002-b5a3-f393-e0a9-e50e24dcca9e"

bool bleConnected = false;
BLECharacteristic* pChar;

// ── Command queue ─────────────────────────────────────────────
// Prevents back-to-back buzzes confusing the rider
uint8_t  cmdQueue[10];
int      qHead = 0, qTail = 0;
unsigned long lastBuzzTime = 0;
#define  MIN_GAP 50     // Minimal gap for instant reaction time before turns

// ── Motor helpers ─────────────────────────────────────────────
void buzzL(int intensity, int ms) {
  ledcWrite(LEFT_MOTOR, intensity);
  delay(ms);
  ledcWrite(LEFT_MOTOR, 0);
}

void buzzR(int intensity, int ms) {
  ledcWrite(RIGHT_MOTOR, intensity);
  delay(ms);
  ledcWrite(RIGHT_MOTOR, 0);
}

void buzzBoth(int intensity, int ms) {
  ledcWrite(LEFT_MOTOR, intensity);
  ledcWrite(RIGHT_MOTOR, intensity);
  delay(ms);
  ledcWrite(LEFT_MOTOR, 0);
  ledcWrite(RIGHT_MOTOR, 0);
}

// ── Execute command ───────────────────────────────────────────
void executeCmd(uint8_t cmd) {
  Serial.print("Executing cmd: 0x");
  Serial.println(cmd, HEX);

  switch(cmd) {

    // ── Slight turns (low intensity, short) ──
    case 0x01:   // slight left
      buzzL(INT_LOW, 150);
      break;
    case 0x02:   // slight right
      buzzR(INT_LOW, 150);
      break;

    // ── Standard turns (medium intensity) ──
    case 0x11:   // left turn — 1 pulse
      buzzL(INT_MED, 300);
      break;
    case 0x12:   // right turn — 1 pulse
      buzzR(INT_MED, 300);
      break;

    // ── Sharp turns (high intensity, 2 pulses) ──
    case 0x21:   // sharp left
      buzzL(INT_HIGH, 350);
      delay(100);
      buzzL(INT_HIGH, 350);
      break;
    case 0x22:   // sharp right
      buzzR(INT_HIGH, 350);
      delay(100);
      buzzR(INT_HIGH, 350);
      break;

    // ── U-turn (both motors, 2 pulses) ──
    case 0x30:
      buzzBoth(INT_HIGH, 350);
      delay(100);
      buzzBoth(INT_HIGH, 350);
      break;

    // ── Highway exit left (3 rapid left pulses) ──
    case 0x31:
      for(int i = 0; i < 3; i++) {
        buzzL(INT_HIGH, 200);
        delay(80);
      }
      break;

    // ── Highway exit right (3 rapid right pulses) ──
    case 0x32:
      for(int i = 0; i < 3; i++) {
        buzzR(INT_HIGH, 200);
        delay(80);
      }
      break;

    // ── Roundabout exits (right N pulses, N = exit number) ──
    case 0x41:   // exit 1
    case 0x42:   // exit 2
    case 0x43:   // exit 3
    case 0x44: { // exit 4
      int n = cmd - 0x40;
      for(int i = 0; i < n; i++) {
        buzzR(INT_MED, 250);
        if(i < n-1) delay(150);
      }
      break;
    }

    // ── Two-stage alert: WARNING (fired at 200-500m) ──
    case 0x51:   // warn left
      buzzL(INT_LOW, 200);
      break;
    case 0x52:   // warn right
      buzzR(INT_LOW, 200);
      break;
    case 0x53:   // warn sharp left
      buzzL(INT_MED, 200);
      delay(80);
      buzzL(INT_MED, 200);
      break;
    case 0x54:   // warn sharp right
      buzzR(INT_MED, 200);
      delay(80);
      buzzR(INT_MED, 200);
      break;
    case 0x55:   // warn U-turn
      buzzBoth(INT_MED, 200);
      delay(80);
      buzzBoth(INT_MED, 200);
      break;
    case 0x56:   // warn highway exit
      for(int i = 0; i < 3; i++) {
        buzzR(INT_MED, 150);
        delay(60);
      }
      break;

    // ── Arrival (full intensity, alternating 3×) ──
    case 0xA0:
      for(int i = 0; i < 3; i++) {
        buzzL(INT_FULL, 400);
        delay(80);
        buzzR(INT_FULL, 400);
        delay(80);
      }
      break;

    // ── Rerouting (L→R wave sweep) ──
    case 0xB0:
      buzzL(INT_MED, 200);
      delay(60);
      buzzL(INT_MED, 200);
      delay(120);
      buzzR(INT_MED, 200);
      delay(60);
      buzzR(INT_MED, 200);
      break;

    default:
      Serial.print("Unknown cmd: 0x");
      Serial.println(cmd, HEX);
      break;
  }

  // Mark time at the END of the buzz so MIN_GAP applies between vibrations
  lastBuzzTime = millis();
}

// ── Queue helpers ─────────────────────────────────────────────
void enqueue(uint8_t cmd) {
  if((qTail + 1) % 10 != qHead) {
    cmdQueue[qTail] = cmd;
    qTail = (qTail + 1) % 10;
  }
}

bool dequeue(uint8_t &cmd) {
  if(qHead == qTail) return false;
  cmd   = cmdQueue[qHead];
  qHead = (qHead + 1) % 10;
  return true;
}

// ── BLE callbacks ─────────────────────────────────────────────
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) {
    bleConnected = true;
    digitalWrite(STATUS_LED, HIGH);
    Serial.println("BLE: phone connected");
  }
  void onDisconnect(BLEServer* s) {
    bleConnected = false;
    digitalWrite(STATUS_LED, LOW);
    Serial.println("BLE: disconnected — restarting advertising");
    BLEDevice::startAdvertising();
  }
};

class CmdCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) {
    String raw = c->getValue(); // Safely retrieve bytes (Updated for ESP32 Core v3.x)
    if(raw.length() == 0) return;

    Serial.print("BLE received ");
    Serial.print(raw.length());
    Serial.println(" bytes");

    // Queue all received bytes as commands
    for(int i = 0; i < (int)raw.length(); i++) {
      uint8_t cmd = (uint8_t)raw[i];
      enqueue(cmd);
      Serial.print("  queued: 0x");
      Serial.println(cmd, HEX);
    }
  }
};

// ── BLE setup ─────────────────────────────────────────────────
void setupBLE() {
  BLEDevice::init("HapticHelmet");
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* svc = server->createService(SERVICE_UUID);
  pChar = svc->createCharacteristic(
    CHARACTERISTIC_UUID,
    BLECharacteristic::PROPERTY_WRITE |
    BLECharacteristic::PROPERTY_NOTIFY |
    BLECharacteristic::PROPERTY_READ);
  pChar->addDescriptor(new BLE2902());
  pChar->setCallbacks(new CmdCallbacks());
  svc->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  adv->setMinPreferred(0x06); // Helps with discoverability on phones
  adv->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
  Serial.println("BLE advertising as 'HapticHelmet'");
}

// ── Status LED ────────────────────────────────────────────────
unsigned long lastBlink = 0;
int blinkState = 0;
void updateLED() {
  if(bleConnected) return;
  if(millis() - lastBlink > 800) {
    blinkState = !blinkState;
    digitalWrite(STATUS_LED, blinkState);
    lastBlink = millis();
  }
}

// ── Self test ─────────────────────────────────────────────────
void selfTest() {
  Serial.println("Self test...");
  buzzL(INT_MED, 200); delay(150);
  buzzR(INT_MED, 200); delay(150);
  buzzBoth(INT_LOW, 200);
  Serial.println("Self test done");
}

// ── Setup & loop ──────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  // PWM configuration for ESP32 Core v3.x
  ledcAttach(LEFT_MOTOR, PWM_FREQ, PWM_RES);
  ledcAttach(RIGHT_MOTOR, PWM_FREQ, PWM_RES);

  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);

  setupBLE();
  selfTest();
  Serial.println("System ready");
}

void loop() {
  // Process one queued command per loop if enough time has passed
  if(qHead != qTail) {
    if(millis() - lastBuzzTime >= MIN_GAP) {
      uint8_t cmd;
      if(dequeue(cmd)) {
        executeCmd(cmd);
      }
    }
  }
  updateLED();
  delay(10);
}