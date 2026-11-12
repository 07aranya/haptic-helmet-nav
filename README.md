# HapNav V2 — Smart Haptic Helmet Navigation System

HapNav V2 is a rider-focused turn-by-turn navigation web application paired with an **ESP32 BLE haptic helmet controller**. It delivers two-stage left/right vibration cues, voice guidance, live speed and trip telemetry, nearby pit-stop discovery, and emergency SOS tools from a Progressive Web App (PWA) cockpit.

---

## Features

### Rider Cockpit UI & UX
- **Tabbed Rider Drawer**: Organized into four thumb-friendly sections — **Route**, **Helmet**, **Pit Stops**, and **Setup**.
- **OLED Dark & High-Contrast Daylight Modes**: Switchable dark cockpit (`#070A10`) and daylight themes (`#F1F5F9`) with un-dimmed map tiles in daylight mode.
- **Auto-Focus Ride Mode**: Automatically collapses the sidebar when a ride or simulation starts to maximize map area (toggleable anytime via menu button or `F`).
- **Glanceable Turn HUD**:
  - Oversized directional arrow and tabular countdown distance.
  - Stage-colored turn card (**Next Turn** cyan → **Warn** amber → **Now** emerald) with haptic pattern badge (e.g., `1× L`, `2× R`, `RB #2`) and proximity fill bar.
  - **Then** next-turn preview pill showing the subsequent maneuver.
- **Instrument Cluster Bottom Bar**: Trip progress ribbon, live speedometer, remaining distance, ETA, and glove-friendly **Recenter**, **Voice Mute**, **Itinerary**, and **End** controls.
- **Visual Haptic Feedback & Phone Fallback**: Screen-edge cyan flash bars, floating haptic cue badge, left/right helmet zone preview in the **Helmet** tab, and optional phone vibration (`navigator.vibrate`) when no BLE helmet is paired.
- **Mobile & Ride Resilience**: Screen Wake Lock (`navigator.wakeLock`) prevents screen sleep mid-ride; dragging the map pauses auto-follow until **Recenter** (`R`) is tapped.

### Navigation, Routing & Safety
- **Multi-Stop & Alternative Routes**: Nominatim address autocomplete, OSRM driving directions with up to 3 selectable route alternatives, dynamic pit-stop waypoints, and an interactive turn-by-turn itinerary list.
- **Directional Rider Marker**: Bearing-aware arrow icon rotated from GPS `heading` or computed from consecutive coordinates during live rides and simulations.
- **Two-Stage Speed-Adaptive Haptics**:
  - **Stage 1 (Early Warning)**: Speed-adaptive trigger between **80 m – 220 m** (`0x51`–`0x56`).
  - **Stage 2 (Confirm / Execute)**: Speed-adaptive trigger between **30 m – 65 m** (`0x01`–`0x44`).
- **Off-Route Detection**: Automatically detects deviation (> 40 m from route polyline), fires the `0xB0` reroute wave cue, speaks `"Recalculating route"`, and fetches a new route (with an 8 s cooldown).
- **Route Simulation**: Replay any planned route at `1×`, `2×`, `4×`, or `10×` speed to test voice and haptic cues indoors.
- **Voice Guidance**: Web Speech API (`speechSynthesis`) alerts at route start, ~110 m, ~50 m, and arrival.
- **Nearby Pit Stops**: Queries Overpass API (4 km radius) for **Petrol**, **EV Charging**, **Hospitals**, and **Police**, with one-tap **Route here** and **+ Pit Stop** buttons.
- **Saved Rides & Sharing**: Persist multi-stop favorite routes in `localStorage` and share routes via Web Share API or clipboard.
- **Emergency SOS**: Fetches live GPS coordinates and accuracy, formats an OpenStreetMap emergency message, and offers one-tap copy, SMS prefill, and `tel:112`.
- **PWA Support**: Includes [manifest.json](templates/manifest.json) and [sw.js](templates/sw.js) for mobile home-screen installation and offline app-shell caching.

---

## Architecture & Repository Structure

```text
haptic_nav/
├── app.py                      # Flask server (static host, /health, optional ORS endpoints)
├── requirements.txt            # Python dependencies
├── Procfile                    # Process definition (web: python app.py)
├── .gitignore
├── haptic_helmet.ino           # Base ESP32 BLE haptic firmware sketch
└── templates/
    ├── index.html              # Rider cockpit HTML shell
    ├── style.css               # OLED dark / daylight rider theme & HUD styles
    ├── script.js               # Navigation, OSRM/Nominatim/Overpass, Web BLE & HUD logic
    ├── manifest.json           # PWA manifest
    ├── sw.js                   # Service worker for app-shell caching
    └── haptic_helmet.ino       # Updated ESP32 Core v3.x firmware tuned for ERM coin motors
```

### Frontend vs. Backend Data Flow
- **Browser Client ([templates/script.js](templates/script.js))**: Handles map rendering (Leaflet `1.9.4` + OSM tiles), address search (Nominatim), routing (OSRM), nearby POI search (Overpass), speech synthesis, and direct Web Bluetooth communication with the ESP32 helmet.
- **Flask Server ([app.py](app.py))**: Serves the PWA files from `templates/` at `/` and provides `/health`, plus optional OpenRouteService-backed `/autocomplete` and `/route` endpoints (configured via `ORS_API_KEY`).

---

## Hardware & ESP32 Firmware

### Wiring & Pinout
Defined in both `.ino` sketches for **ESP32 (Arduino ESP32 Core v3.x `ledcAttach`)**:

| Signal | GPIO Pin | Details |
| :--- | :--- | :--- |
| `LEFT_MOTOR` | `GPIO 12` | Left helmet vibration motor (PWM `5000 Hz`, 8-bit) |
| `RIGHT_MOTOR` | `GPIO 14` | Right helmet vibration motor (PWM `5000 Hz`, 8-bit) |
| `STATUS_LED` | `GPIO 2` | Onboard LED (blinks every 800 ms while advertising; solid HIGH when connected) |

> **Hardware Note**: Use MOSFET/transistor driver stages with flyback protection between the ESP32 GPIOs and the ERM coin motors rather than driving motors directly from GPIO pins.

### Firmware Variants in Repository
- [templates/haptic_helmet.ino](templates/haptic_helmet.ino) *(recommended for ERM coin motors)*:
  - Uses higher PWM duty cycles (`INT_LOW = 200`, `INT_MED = 230`, `INT_HIGH = 255`, `INT_FULL = 255`) to overcome coin-motor static friction.
  - `MIN_GAP = 50` ms (stamped at the end of `executeCmd`) for responsive turns.
  - Uses `String raw = c->getValue();` for ESP32 Core v3.x and `BLEDevice::startAdvertising()`.
- [haptic_helmet.ino](haptic_helmet.ino):
  - Earlier PWM levels (`INT_LOW = 77`, `INT_MED = 166`, `INT_HIGH = 217`, `INT_FULL = 255`), `MIN_GAP = 3000` ms, and `std::string raw = c->getValue();`.

Both sketches queue incoming bytes into a 10-slot circular command buffer (`cmdQueue`) and run a brief L → R → Both `selfTest()` on boot.

---

## BLE Protocol & Haptic Command Dictionary

- **Device Name**: `HapticHelmet`
- **Service UUID**: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- **Characteristic UUID**: `6e400002-b5a3-f393-e0a9-e50e24dcca9e` (`WRITE | NOTIFY | READ`)
- **Payload**: Single 1-byte command (`uint8_t`) queued sequentially by the web client (`bleWriteQueue`).

| Hex Byte | Command | Stage | Motor Pattern |
| :--- | :--- | :--- | :--- |
| `0x00` | `STRAIGHT` | — | No vibration |
| `0x01` | `SLIGHT_LEFT` | Now | Left motor, 1× short pulse (150 ms, Low) |
| `0x02` | `SLIGHT_RIGHT` | Now | Right motor, 1× short pulse (150 ms, Low) |
| `0x11` | `LEFT` | Now | Left motor, 1× solid pulse (300 ms, Med) |
| `0x12` | `RIGHT` | Now | Right motor, 1× solid pulse (300 ms, Med) |
| `0x21` | `SHARP_LEFT` | Now | Left motor, 2× long pulses (350 ms each, High) |
| `0x22` | `SHARP_RIGHT` | Now | Right motor, 2× long pulses (350 ms each, High) |
| `0x30` | `UTURN` | Now | Both motors, 2× pulses (350 ms each, High) |
| `0x31` | `HWY_EXIT_LEFT` | Now | Left motor, 3× rapid pulses (200 ms each, High) |
| `0x32` | `HWY_EXIT_RIGHT` | Now | Right motor, 3× rapid pulses (200 ms each, High) |
| `0x41`–`0x44` | `ROUNDABOUT_1`–`4` | Now | Right motor, `N` pulses (`N = 1..4` exit number, Med) |
| `0x51` | `WARN_LEFT` | Early Warn | Left motor, 1× prepare pulse (200 ms, Low) |
| `0x52` | `WARN_RIGHT` | Early Warn | Right motor, 1× prepare pulse (200 ms, Low) |
| `0x53` | `WARN_SHARP_LEFT` | Early Warn | Left motor, 2× prepare pulses (200 ms each, Med) |
| `0x54` | `WARN_SHARP_RIGHT` | Early Warn | Right motor, 2× prepare pulses (200 ms each, Med) |
| `0x55` | `WARN_UTURN` | Early Warn | Both motors, 2× prepare pulses (200 ms each, Med) |
| `0x56` | `WARN_HWY` | Early Warn | Right motor, 3× prepare pulses (150 ms each, Med) |
| `0xA0` | `ARRIVED` | Arrival | Alternating Left / Right, 3× cycles (400 ms each, Full) |
| `0xB0` | `REROUTE` | Off-Route | Left-to-Right wave sweep (`L-L-R-R`, 200 ms each, Med) |

---

## Getting Started

### Prerequisites
- Python 3.9+
- A browser supporting **Web Bluetooth** and **Geolocation** (Chrome, Edge, or Chrome on Android)
- **HTTPS** (required for Web Bluetooth and GPS on mobile/remote hosts; `http://localhost` works for local desktop testing)
- Arduino IDE / PlatformIO with **ESP32 Arduino Core v3.x** (to flash the helmet firmware)

### 1. Run the Web App Locally

```bash
cd haptic_nav
pip install -r requirements.txt
python app.py
```

Open `http://localhost:5000` in Chrome or Edge.

### 2. Optional Environment Variables (`.env`)

Create a `.env` file in `haptic_nav/` if using the optional OpenRouteService endpoints or a custom port:

```env
ORS_API_KEY=your_openrouteservice_api_key
PORT=5000
```

### 3. Flash the ESP32 Firmware

1. Open [templates/haptic_helmet.ino](templates/haptic_helmet.ino) in Arduino IDE.
2. Select your ESP32 board (Arduino ESP32 Core v3.x).
3. Connect the left/right motor drivers to **GPIO 12** and **GPIO 14** (status LED on **GPIO 2**).
4. Upload the sketch and verify serial output (`115200` baud) prints `BLE advertising as 'HapticHelmet'` and `System ready`.
5. In the web app, open the **Helmet** tab (or tap the **Helmet** pill in the top bar) and click **Pair helmet**.

---

## Flask API Endpoints (`app.py`)

| Method | Path | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Renders the HapNav V2 PWA cockpit (`index.html`) |
| `GET` | `/health` | Returns `{"status": "ok", "ors_configured": true|false}` |
| `GET` | `/autocomplete?q=...` | Proxies OpenRouteService `/geocode/autocomplete` (requires `ORS_API_KEY`) |
| `POST` | `/route` | Accepts `{"origin": "...", "destination": "..."}` and returns ORS route geometry + two-stage haptic waypoints (requires `ORS_API_KEY`) |

---

## Keyboard Shortcuts

| Key | Action |
| :--- | :--- |
| `Space` | Mute / unmute voice guidance |
| `S` | Start ride navigation (when route is ready) |
| `F` | Toggle ride cockpit focus / sidebar |
| `R` | Recenter map on rider |
| `L` | Detect & center on current GPS location |
| `+` / `-` | Zoom in / out |
| `Esc` | Stop navigation / simulation or close modals |
| `?` | Open keyboard shortcuts modal |

---

## Browser & Deployment Notes

- **Deployment**: [Procfile](Procfile) (`web: python app.py`) supports PaaS deployment (e.g., Heroku / Render / Railway). Make sure HTTPS is enabled so mobile browsers allow Web Bluetooth and GPS permissions.
- **Web Bluetooth Availability**: Supported on desktop Chrome/Edge and Android Chrome; iOS Safari does not expose `navigator.bluetooth` (use a WebBLE browser on iOS or phone vibrate/voice guidance).
- **Public API Fair Use**: Client-side geocoding, routing, and POI lookups use public OpenStreetMap Nominatim, OSRM, and Overpass instances; avoid excessive automated requests.
