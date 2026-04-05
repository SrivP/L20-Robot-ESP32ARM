/*
  6-DOF Robot Arm — ESP32 + PCA9685  [WiFi Access Point + WebSocket]
  ─────────────────────────────────────────────────────────────────────────────
  Transport : ESP32 in AP mode → WebSocket server on port 81
  Protocol  : same text commands as before (s1<angle>, SAVE, RUN, etc.)
              plus VOICE_* commands mapped by the web app

  Wiring
    PCA9685  SDA → GPIO 21  |  SCL → GPIO 22
    Servos on channels 0, 2, 4, 6, 8, 10

  Phone / laptop setup
    1. Connect to WiFi "RobotArm6DOF" (password: robotarm123)
    2. Open the Vite web app — it connects to ws://192.168.4.1:81

  Dependencies (Arduino Library Manager)
    • Adafruit PWM Servo Driver Library   ("Adafruit PWMServoDriver")
    • arduinoWebSockets by Markus Sattler ("WebSockets")
  ─────────────────────────────────────────────────────────────────────────────
*/

#include <WiFi.h>
#include <WebSocketsServer.h>
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>

// ── WiFi AP ───────────────────────────────────────────────────────────────────
const char* AP_SSID     = "RobotArm6DOF";
const char* AP_PASSWORD = "robotarm123";   // min 8 chars; use "" for open network

// ── WebSocket ─────────────────────────────────────────────────────────────────
WebSocketsServer webSocket(81);
int8_t activeClient = -1;   // track connected client number (-1 = none)

// ── PCA9685 ───────────────────────────────────────────────────────────────────
Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

#define SERVO_MIN_PULSE  150
#define SERVO_MAX_PULSE  600

#define CH_WAIST    0
#define CH_SHOULDER 2
#define CH_ELBOW    4
#define CH_WRIST_P  6
#define CH_WRIST_R  8
#define CH_GRIPPER  10

// ── Servo state ───────────────────────────────────────────────────────────────
int s1Pos = 90, s2Pos = 150, s3Pos = 35, s4Pos = 140, s5Pos = 85, s6Pos = 80;

#define MAX_STEPS 50
int sp1[MAX_STEPS], sp2[MAX_STEPS], sp3[MAX_STEPS];
int sp4[MAX_STEPS], sp5[MAX_STEPS], sp6[MAX_STEPS];
int stepCount  = 0;
int speedDelay = 20;

// ── Incoming command queue (set from WS callback, consumed in loop) ───────────
volatile bool newData = false;
String        dataIn  = "";

// ── Helpers ───────────────────────────────────────────────────────────────────
uint16_t angleToPulse(int angle) {
  return map(constrain(angle, 0, 180), 0, 180, SERVO_MIN_PULSE, SERVO_MAX_PULSE);
}

void writeServo(uint8_t ch, int angle) {
  pwm.setPWM(ch, 0, angleToPulse(angle));
}

void sweepServo(uint8_t ch, int &prev, int target, int ms) {
  if (prev == target) return;
  int step = (prev < target) ? 1 : -1;
  for (int a = prev; a != target; a += step) {
    writeServo(ch, a);
    delay(ms);
  }
  writeServo(ch, target);
  prev = target;
}

void wsSend(String msg) {
  if (activeClient >= 0)
    webSocket.sendTXT(activeClient, msg);
}

// ── WebSocket event handler ───────────────────────────────────────────────────
void onWebSocketEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      activeClient = num;
      Serial.printf("[WS] Client %u connected\n", num);
      wsSend("CONNECTED:RobotArm6DOF");
      break;

    case WStype_DISCONNECTED:
      Serial.printf("[WS] Client %u disconnected\n", num);
      if (activeClient == num) activeClient = -1;
      break;

    case WStype_TEXT:
      dataIn  = String((char*)payload);
      dataIn.trim();
      newData = true;
      break;

    default: break;
  }
}

// ── Command processor ─────────────────────────────────────────────────────────
void processCommand(const String &cmd) {
  Serial.print("[CMD] "); Serial.println(cmd);

  if (cmd.startsWith("s1")) { sweepServo(CH_WAIST,    s1Pos, cmd.substring(2).toInt(), 20); wsSend("OK:s1"); return; }
  if (cmd.startsWith("s2")) { sweepServo(CH_SHOULDER, s2Pos, cmd.substring(2).toInt(), 50); wsSend("OK:s2"); return; }
  if (cmd.startsWith("s3")) { sweepServo(CH_ELBOW,    s3Pos, cmd.substring(2).toInt(), 30); wsSend("OK:s3"); return; }
  if (cmd.startsWith("s4")) { sweepServo(CH_WRIST_P,  s4Pos, cmd.substring(2).toInt(), 30); wsSend("OK:s4"); return; }
  if (cmd.startsWith("s5")) { sweepServo(CH_WRIST_R,  s5Pos, cmd.substring(2).toInt(), 30); wsSend("OK:s5"); return; }
  if (cmd.startsWith("s6")) { sweepServo(CH_GRIPPER,  s6Pos, cmd.substring(2).toInt(), 30); wsSend("OK:s6"); return; }

  if (cmd.startsWith("ss")) {
    speedDelay = constrain(cmd.substring(2).toInt(), 5, 200);
    wsSend("OK:speed=" + String(speedDelay));
    return;
  }

  if (cmd == "SAVE") {
    if (stepCount < MAX_STEPS) {
      sp1[stepCount]=s1Pos; sp2[stepCount]=s2Pos; sp3[stepCount]=s3Pos;
      sp4[stepCount]=s4Pos; sp5[stepCount]=s5Pos; sp6[stepCount]=s6Pos;
      stepCount++;
      wsSend("SAVED:" + String(stepCount));
    } else {
      wsSend("ERR:buffer_full");
    }
    return;
  }

  if (cmd == "RUN")   { runServo(); return; }

  if (cmd == "RESET") {
    memset(sp1,0,sizeof(sp1)); memset(sp2,0,sizeof(sp2)); memset(sp3,0,sizeof(sp3));
    memset(sp4,0,sizeof(sp4)); memset(sp5,0,sizeof(sp5)); memset(sp6,0,sizeof(sp6));
    stepCount = 0;
    newData   = false;
    wsSend("RESET:OK");
    return;
  }

  // Voice preset commands
  if (cmd == "VOICE_HOME") {
    sweepServo(CH_WAIST,    s1Pos, 90,  20);
    sweepServo(CH_SHOULDER, s2Pos, 150, 30);
    sweepServo(CH_ELBOW,    s3Pos, 35,  30);
    sweepServo(CH_WRIST_P,  s4Pos, 140, 30);
    sweepServo(CH_WRIST_R,  s5Pos, 85,  30);
    sweepServo(CH_GRIPPER,  s6Pos, 80,  30);
    wsSend("OK:home");
    return;
  }
  if (cmd == "VOICE_OPEN")  { sweepServo(CH_GRIPPER, s6Pos, 30,  20); wsSend("OK:open");  return; }
  if (cmd == "VOICE_CLOSE") { sweepServo(CH_GRIPPER, s6Pos, 130, 20); wsSend("OK:close"); return; }

  if (cmd == "VOICE_PICK") {
    sweepServo(CH_SHOULDER, s2Pos, 120, 30);
    sweepServo(CH_ELBOW,    s3Pos, 60,  30);
    sweepServo(CH_GRIPPER,  s6Pos, 30,  20);
    delay(300);
    sweepServo(CH_SHOULDER, s2Pos, 90, 30);
    sweepServo(CH_GRIPPER,  s6Pos, 130, 20);
    wsSend("OK:pick");
    return;
  }
  if (cmd == "VOICE_PLACE") {
    sweepServo(CH_WAIST,    s1Pos, 140, 20);
    sweepServo(CH_SHOULDER, s2Pos, 120, 30);
    sweepServo(CH_GRIPPER,  s6Pos, 30,  20);
    delay(300);
    sweepServo(CH_SHOULDER, s2Pos, 150, 30);
    sweepServo(CH_WAIST,    s1Pos, 90,  20);
    wsSend("OK:place");
    return;
  }

  wsSend("ERR:unknown=" + cmd);
}

// ── Auto-run ──────────────────────────────────────────────────────────────────
void runServo() {
  if (stepCount < 2) { wsSend("ERR:need_2+_steps"); return; }
  wsSend("RUN:start");
  bool running = true;

  while (running) {
    for (int i = 0; i < stepCount - 1 && running; i++) {
      webSocket.loop();   // keep WS alive during long sequences
      if (newData) {
        newData = false;
        if (dataIn == "RESET") { running = false; break; }
        if (dataIn == "PAUSE") {
          wsSend("RUN:paused");
          while (true) {
            webSocket.loop();
            delay(20);
            if (newData) {
              newData = false;
              if (dataIn == "RUN")   { wsSend("RUN:resumed"); break; }
              if (dataIn == "RESET") { running = false; break; }
            }
          }
          if (!running) break;
        }
        if (dataIn.startsWith("ss"))
          speedDelay = constrain(dataIn.substring(2).toInt(), 5, 200);
      }

      auto sweep = [&](uint8_t ch, int from, int to) {
        if (from == to) return;
        int step = (from < to) ? 1 : -1;
        for (int a = from; a != to && running; a += step) {
          writeServo(ch, a);
          delay(speedDelay);
        }
        if (running) writeServo(ch, to);
      };

      sweep(CH_WAIST,    sp1[i], sp1[i+1]);
      sweep(CH_SHOULDER, sp2[i], sp2[i+1]);
      sweep(CH_ELBOW,    sp3[i], sp3[i+1]);
      sweep(CH_WRIST_P,  sp4[i], sp4[i+1]);
      sweep(CH_WRIST_R,  sp5[i], sp5[i+1]);
      sweep(CH_GRIPPER,  sp6[i], sp6[i+1]);
    }
  }
  wsSend("RUN:stopped");
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  // PCA9685
  Wire.begin();
  pwm.begin();
  pwm.setOscillatorFrequency(27000000);
  pwm.setPWMFreq(50);
  delay(10);

  writeServo(CH_WAIST,    s1Pos);
  writeServo(CH_SHOULDER, s2Pos);
  writeServo(CH_ELBOW,    s3Pos);
  writeServo(CH_WRIST_P,  s4Pos);
  writeServo(CH_WRIST_R,  s5Pos);
  writeServo(CH_GRIPPER,  s6Pos);

  // WiFi AP
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.print("[WiFi] AP IP: ");
  Serial.println(WiFi.softAPIP());   // should print 192.168.4.1

  // WebSocket
  webSocket.begin();
  webSocket.onEvent(onWebSocketEvent);
  Serial.println("[WS] Server started on port 81");
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  webSocket.loop();
  if (newData) {
    newData = false;
    processCommand(dataIn);
  }
}
