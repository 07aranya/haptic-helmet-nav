/* =========================================================
   HapNav V2 — Smart Haptic Navigation System
   script.js — Application Logic & Riding Cockpit
   ========================================================= */

'use strict';

/* =========================================================
   GLOBAL STATE
   ========================================================= */
const HapNav = {
  map: null,
  tileLayer: null,
  waypoints: [],           // array of { id, coords: {lat, lng, label} | null }
  altRoutes: [],
  favorites: [],

  // Markers / layers
  currentLocationMarker: null,
  currentLocationCircle: null,
  originMarker: null,
  destMarker: null,
  waypointMarkers: [],
  routeLine: null,
  routeShadowLine: null,
  turnMarkers: [],
  nearbyMarkers: [],
  simMarker: null,

  // Coordinates
  originCoords: null,      // {lat, lng, label}
  destCoords: null,        // {lat, lng, label}
  currentPosition: null,   // {lat, lng, accuracy, heading, speed}
  lastBearing: 0,

  // Route data
  route: null,             // OSRM route object
  routeSteps: [],          // flattened steps with coords
  currentStepIndex: 0,

  // Navigation state
  isNavigating: false,
  isSimulating: false,
  followRider: true,
  simInterval: null,
  simProgressIndex: 0,
  simRouteCoords: [],
  lastRerouteAt: 0,

  watchId: null,
  wakeLock: null,

  // BLE
  bleDevice: null,
  bleCharacteristic: null,
  bleServer: null,

  // Settings
  settings: {
    voice: true,
    haptic: true,
    vibrateFallback: true,
    rideFocus: true,
    units: 'metric',
    theme: 'dark'
  },

  // Voice
  speechMuted: false,
  lastSpokenInstruction: null,

  // Misc
  lastHapticCommand: null,
  hapticHudTimer: null,
  offRouteWarningActive: false,
  searchDebounce: null,
  waypointSeq: 0
};

/* =========================================================
   CONSTANTS
   ========================================================= */
const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const OVERPASS_BASE = 'https://overpass-api.de/api/interpreter';

// Keep BLE protocol codes 100% aligned with HapticHelmet ESP32 firmware
const HAPTIC_COMMANDS = {
  SLIGHT_LEFT: 0x01,
  SLIGHT_RIGHT: 0x02,
  LEFT: 0x11,
  RIGHT: 0x12,
  SHARP_LEFT: 0x21,
  SHARP_RIGHT: 0x22,
  UTURN: 0x30,
  HWY_EXIT_LEFT: 0x31,
  HWY_EXIT_RIGHT: 0x32,
  ROUNDABOUT_1: 0x41,
  ROUNDABOUT_2: 0x42,
  ROUNDABOUT_3: 0x43,
  ROUNDABOUT_4: 0x44,
  WARN_LEFT: 0x51,
  WARN_RIGHT: 0x52,
  WARN_SHARP_LEFT: 0x53,
  WARN_SHARP_RIGHT: 0x54,
  WARN_UTURN: 0x55,
  WARN_HWY: 0x56,
  STRAIGHT: 0x00,      // No buzz necessary
  ARRIVED: 0xA0,
  REROUTE: 0xB0
};

// Web Bluetooth — Nordic UART-like service used for "HapticHelmet" ESP32 peripheral
const BLE_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

// BLE Write Queue to prevent GATT overlaps and ensure sequential delivery
let isBleWriting = false;
let bleWriteQueue = [];

const NEARBY_QUERIES = {
  hospital: { tag: 'amenity=hospital', icon: '🏥', label: 'Hospital' },
  police: { tag: 'amenity=police', icon: '🚓', label: 'Police Station' },
  fuel: { tag: 'amenity=fuel', icon: '⛽', label: 'Petrol Pump' },
  charging: { tag: 'amenity=charging_station', icon: '🔌', label: 'Charging Station' }
};

const TURN_ICONS = {
  left: '←',
  right: '→',
  straight: '↑',
  'slight left': '↖',
  'slight right': '↗',
  'sharp left': '↰',
  'sharp right': '↱',
  uturn: '↩',
  roundabout: '↻',
  rotary: '↻',
  'off ramp': '↗',
  arrive: '🏁',
  depart: '↑',
  merge: '↑',
  fork: '⑂',
  'continue': '↑',
  default: '↑'
};

/* =========================================================
   INITIALIZATION
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
  initLoadingSequence();
});

function initLoadingSequence() {
  const statusEl = document.getElementById('loading-status');
  const steps = [
    'Loading map tiles…',
    'Connecting to routing engine…',
    'Calibrating sensors…',
    'Preparing haptic cockpit…',
    'Ready.'
  ];
  let i = 0;
  const interval = setInterval(() => {
    if (statusEl) statusEl.textContent = steps[i] || 'Ready.';
    i++;
    if (i >= steps.length) {
      clearInterval(interval);
      setTimeout(boot, 350);
    }
  }, 340);
}

function boot() {
  const loadingScreen = document.getElementById('loading-screen');
  const app = document.getElementById('app');

  app.classList.remove('hidden');

  if (HapNav && HapNav.map) {
    setTimeout(() => HapNav.map.invalidateSize(), 250);
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      initMap();
      initEventListeners();
      initServiceWorker();
      loadSettingsFromState();
      checkNetworkStatus();
      initKeyboardShortcuts();

      loadingScreen.classList.add('fade-out');
      setTimeout(() => loadingScreen.classList.add('hidden'), 650);

      setTimeout(() => {
        if (HapNav.map) HapNav.map.invalidateSize(true);
      }, 700);

      detectCurrentLocation({ silent: true, center: true });
      showToast('HapNav V2 ready', 'success');
    });
  });
}

/* =========================================================
   MAP INITIALIZATION
   ========================================================= */
function initMap() {
  HapNav.map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true
  }).setView([20.5937, 78.9629], 5);

  HapNav.tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(HapNav.map);

  try {
    const cached = JSON.parse(localStorage.getItem('hapnav_last_view') || 'null');
    if (cached && cached.lat && cached.lng) {
      HapNav.map.setView([cached.lat, cached.lng], cached.zoom || 13);
    }
  } catch (e) { /* ignore */ }

  const refreshMapSize = () => {
    if (!HapNav.map) return;
    HapNav.map.invalidateSize(true);
  };
  window.addEventListener('resize', refreshMapSize);
  window.addEventListener('orientationchange', refreshMapSize);

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(refreshMapSize).observe(document.getElementById('map'));
  }

  // Pause auto-follow when rider manually pans map during navigation/simulation
  HapNav.map.on('dragstart', () => {
    if (HapNav.isNavigating || HapNav.isSimulating) {
      setFollowRider(false);
    }
  });

  HapNav.map.on('moveend', () => {
    try {
      const c = HapNav.map.getCenter();
      localStorage.setItem('hapnav_last_view', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: HapNav.map.getZoom() }));
    } catch (e) { /* storage unavailable */ }
  });
}

/* =========================================================
   EVENT LISTENERS
   ========================================================= */
function initEventListeners() {
  document.getElementById('menu-toggle').addEventListener('click', toggleSidebar);
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // SOS
  document.getElementById('sos-btn').addEventListener('click', openSosModal);
  document.getElementById('sos-close-btn').addEventListener('click', () => closeModal('sos-modal-backdrop'));
  document.getElementById('sos-copy-btn').addEventListener('click', copySosMessage);
  document.getElementById('sos-call-btn').addEventListener('click', () => {
    window.location.href = 'tel:112';
  });

  // Shortcuts modal
  document.getElementById('shortcuts-close-btn').addEventListener('click', () => closeModal('shortcuts-modal-backdrop'));

  // Origin / destination inputs
  const originInput = document.getElementById('origin-input');
  const destInput = document.getElementById('destination-input');

  originInput.addEventListener('input', () => handleAddressInput(originInput, 'origin-suggestions', 'origin'));
  destInput.addEventListener('input', () => handleAddressInput(destInput, 'destination-suggestions', 'destination'));

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.input-group')) {
      hideAllSuggestions();
    }
  });

  // Current location button
  document.getElementById('use-current-location').addEventListener('click', () => {
    detectCurrentLocation({ silent: false, center: true, fillOrigin: true });
  });

  // Swap
  document.getElementById('swap-locations').addEventListener('click', swapOriginDestination);

  // Multi-stop, favorites, 3D pitch
  const addStopBtn = document.getElementById('add-stop-btn');
  if (addStopBtn) addStopBtn.addEventListener('click', addWaypointInput);
  const saveRouteBtn = document.getElementById('save-route-btn');
  if (saveRouteBtn) saveRouteBtn.addEventListener('click', saveCurrentRouteToFavorites);
  const pitchFab = document.getElementById('pitch-fab');
  if (pitchFab) pitchFab.addEventListener('click', toggle3DPitch);

  loadFavorites();

  // Route actions
  document.getElementById('find-route-btn').addEventListener('click', findRoute);
  document.getElementById('clear-route-btn').addEventListener('click', clearRoute);

  // Navigation controls
  document.getElementById('start-navigation-btn').addEventListener('click', startNavigation);
  document.getElementById('stop-navigation-btn').addEventListener('click', stopNavigation);
  document.getElementById('simulate-btn').addEventListener('click', startSimulation);
  document.getElementById('sim-stop-btn').addEventListener('click', stopSimulation);

  // Cockpit recenter & itinerary controls
  document.getElementById('nbb-recenter-btn').addEventListener('click', recenterOnRider);
  document.getElementById('recenter-fab').addEventListener('click', recenterOnRider);
  document.getElementById('nbb-itinerary-btn').addEventListener('click', toggleSidebar);

  // Voice mute
  document.getElementById('mute-btn').addEventListener('click', toggleMute);

  // FABs
  document.getElementById('locate-fab').addEventListener('click', () => {
    detectCurrentLocation({ silent: false, center: true });
  });
  document.getElementById('zoom-in-fab').addEventListener('click', () => HapNav.map.zoomIn());
  document.getElementById('zoom-out-fab').addEventListener('click', () => HapNav.map.zoomOut());

  // BLE
  document.getElementById('ble-connect-btn').addEventListener('click', connectHapticHelmet);
  document.getElementById('ble-disconnect-btn').addEventListener('click', disconnectHapticHelmet);
  document.querySelectorAll('#ble-test-row .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = parseInt(btn.dataset.cmd, 16);
      sendHapticCommand(cmd, true);
    });
  });

  // Nearby filters
  document.querySelectorAll('#nearby-filters .chip-toggle').forEach(btn => {
    btn.addEventListener('click', () => toggleNearbyCategory(btn));
  });

  // Settings toggles
  document.getElementById('voice-toggle').addEventListener('click', (e) => toggleSetting(e.currentTarget, 'voice'));
  document.getElementById('haptic-toggle').addEventListener('click', (e) => toggleSetting(e.currentTarget, 'haptic'));
  document.getElementById('vibrate-toggle').addEventListener('click', (e) => toggleSetting(e.currentTarget, 'vibrateFallback'));
  document.getElementById('ridefocus-toggle').addEventListener('click', (e) => toggleSetting(e.currentTarget, 'rideFocus'));

  // Units segmented control
  document.querySelectorAll('#units-segmented .segment').forEach(btn => {
    btn.addEventListener('click', () => setUnits(btn.dataset.unit));
  });

  // Share route
  document.getElementById('share-route-btn').addEventListener('click', shareRoute);

  // Network status
  window.addEventListener('online', checkNetworkStatus);
  window.addEventListener('offline', checkNetworkStatus);

  // Re-acquire wake lock if returning to tab mid-ride
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (HapNav.isNavigating || HapNav.isSimulating)) {
      requestWakeLock();
    }
  });
}

/* =========================================================
   KEYBOARD SHORTCUTS
   ========================================================= */
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        toggleMute();
        break;
      case 's':
      case 'S':
        if (!HapNav.isNavigating && HapNav.route) startNavigation();
        break;
      case 'f':
      case 'F':
        toggleSidebar();
        break;
      case 'r':
      case 'R':
        recenterOnRider();
        break;
      case 'Escape':
        if (HapNav.isNavigating) stopNavigation();
        if (HapNav.isSimulating) stopSimulation();
        closeModal('sos-modal-backdrop');
        closeModal('shortcuts-modal-backdrop');
        break;
      case 'l':
      case 'L':
        detectCurrentLocation({ silent: false, center: true });
        break;
      case '+':
      case '=':
        HapNav.map.zoomIn();
        break;
      case '-':
      case '_':
        HapNav.map.zoomOut();
        break;
      case '?':
        toggleModal('shortcuts-modal-backdrop');
        break;
    }
  });
}

/* =========================================================
   UI HELPERS — TOASTS, MODALS, SIDEBAR & RIDE FOCUS
   ========================================================= */
function showToast(message, type = 'info', duration = 3400) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

function isMobileViewport() {
  return window.matchMedia('(max-width: 980px)').matches;
}

function setRideFocus(enabled) {
  const app = document.getElementById('app');
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('menu-toggle');

  if (isMobileViewport()) {
    sidebar.classList.toggle('open', !enabled);
    btn.setAttribute('aria-expanded', !enabled ? 'true' : 'false');
  } else {
    app.classList.toggle('ride-focus', enabled);
    btn.setAttribute('aria-expanded', !enabled ? 'true' : 'false');
  }

  setTimeout(() => HapNav.map && HapNav.map.invalidateSize(true), 320);
}

function toggleSidebar() {
  const app = document.getElementById('app');
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('menu-toggle');

  if (isMobileViewport()) {
    const isOpen = sidebar.classList.toggle('open');
    btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  } else {
    const isFocused = app.classList.toggle('ride-focus');
    btn.setAttribute('aria-expanded', !isFocused ? 'true' : 'false');
  }

  setTimeout(() => HapNav.map && HapNav.map.invalidateSize(true), 320);
}

function setFollowRider(follow) {
  HapNav.followRider = follow;
  const active = HapNav.isNavigating || HapNav.isSimulating;
  const showRecenter = active && !follow;
  document.getElementById('nbb-recenter-btn').classList.toggle('hidden', !showRecenter);
  document.getElementById('recenter-fab').classList.toggle('hidden', !showRecenter);
}

function recenterOnRider() {
  setFollowRider(true);
  if (HapNav.isSimulating && HapNav.simMarker) {
    HapNav.map.setView(HapNav.simMarker.getLatLng(), Math.max(HapNav.map.getZoom(), 16), { animate: true });
  } else if (HapNav.currentPosition) {
    HapNav.map.setView([HapNav.currentPosition.lat, HapNav.currentPosition.lng], Math.max(HapNav.map.getZoom(), 16), { animate: true });
  } else {
    detectCurrentLocation({ silent: false, center: true });
  }
}

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}
function toggleModal(id) {
  document.getElementById(id).classList.toggle('hidden');
}

function toggleTheme() {
  const html = document.documentElement;
  const isLight = html.getAttribute('data-theme') === 'light';
  if (isLight) {
    html.removeAttribute('data-theme');
    HapNav.settings.theme = 'dark';
  } else {
    html.setAttribute('data-theme', 'light');
    HapNav.settings.theme = 'light';
  }
  persistSettings();
}

/* =========================================================
   WAKE LOCK (Keep phone awake during rides)
   ========================================================= */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (!HapNav.wakeLock) {
      HapNav.wakeLock = await navigator.wakeLock.request('screen');
      HapNav.wakeLock.addEventListener('release', () => {
        HapNav.wakeLock = null;
      });
    }
  } catch (e) {
    // Non-fatal on browsers/environments that disallow wake lock
  }
}

async function releaseWakeLock() {
  if (HapNav.wakeLock) {
    try {
      await HapNav.wakeLock.release();
    } catch (e) { /* ignore */ }
    HapNav.wakeLock = null;
  }
}

/* =========================================================
   SETTINGS PERSISTENCE
   ========================================================= */
function persistSettings() {
  try {
    localStorage.setItem('hapnav_settings', JSON.stringify(HapNav.settings));
  } catch (e) { /* ignore */ }
}

function loadSettingsFromState() {
  try {
    const saved = JSON.parse(localStorage.getItem('hapnav_settings') || 'null');
    if (saved) {
      HapNav.settings = { ...HapNav.settings, ...saved };
    }
  } catch (e) { /* ignore */ }

  if (HapNav.settings.theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }

  setToggleState('voice-toggle', HapNav.settings.voice);
  setToggleState('haptic-toggle', HapNav.settings.haptic);
  setToggleState('vibrate-toggle', HapNav.settings.vibrateFallback);
  setToggleState('ridefocus-toggle', HapNav.settings.rideFocus);
  HapNav.speechMuted = !HapNav.settings.voice;
  updateMuteIcon();

  document.querySelectorAll('#units-segmented .segment').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === HapNav.settings.units);
  });
}

function setToggleState(id, value) {
  const el = document.getElementById(id);
  if (el) el.setAttribute('aria-checked', value ? 'true' : 'false');
}

function toggleSetting(el, key) {
  const newVal = el.getAttribute('aria-checked') !== 'true';
  el.setAttribute('aria-checked', newVal ? 'true' : 'false');
  HapNav.settings[key] = newVal;

  if (key === 'voice') {
    HapNav.speechMuted = !newVal;
    updateMuteIcon();
  }

  persistSettings();
  const labels = {
    voice: 'Voice guidance',
    haptic: 'Haptic feedback',
    vibrateFallback: 'Phone vibrate fallback',
    rideFocus: 'Auto-focus ride cockpit'
  };
  showToast(`${labels[key] || key} ${newVal ? 'enabled' : 'disabled'}`, 'info', 2000);
}

function setUnits(unit) {
  HapNav.settings.units = unit;
  document.querySelectorAll('#units-segmented .segment').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === unit);
  });
  persistSettings();
  if (HapNav.route) {
    updateRouteSummary(HapNav.route);
    renderTurnItinerary();
  }
}

/* =========================================================
   NETWORK STATUS
   ========================================================= */
function checkNetworkStatus() {
  const online = navigator.onLine;
  const pill = document.getElementById('pill-net');
  const banner = document.getElementById('offline-banner');

  pill.classList.toggle('active', online);
  pill.classList.toggle('error', !online);
  pill.querySelector('.pill-label').textContent = online ? 'Online' : 'Offline';
  banner.classList.toggle('hidden', online);

  if (!online) {
    showToast('You are offline. Showing cached map data where available.', 'warning');
  }
}

/* =========================================================
   GPS — CURRENT LOCATION & LIVE TRACKING
   ========================================================= */
function detectCurrentLocation({ silent = false, center = false, fillOrigin = false } = {}) {
  if (!navigator.geolocation) {
    if (!silent) showToast('Geolocation is not supported by this browser.', 'danger');
    setGpsStatus('error', 'Unsupported');
    return;
  }

  setGpsStatus('pulse', 'Searching…');

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy, heading, speed } = pos.coords;
      const prev = HapNav.currentPosition;
      const computedHeading = resolveHeading(prev, latitude, longitude, heading);
      HapNav.currentPosition = { lat: latitude, lng: longitude, accuracy, heading: computedHeading, speed };

      placeCurrentLocationMarker(latitude, longitude, accuracy, computedHeading);

      if (center) HapNav.map.setView([latitude, longitude], 15);

      if (fillOrigin) {
        HapNav.originCoords = { lat: latitude, lng: longitude, label: 'Current location' };
        document.getElementById('origin-input').value = 'Current location';
        placeOriginMarker(latitude, longitude);
      }

      setGpsStatus('active', 'Active');
      if (!silent) showToast('Location detected', 'success');
    },
    (err) => {
      setGpsStatus('error', 'Denied');
      if (!silent) {
        let msg = 'Unable to retrieve your location.';
        if (err.code === 1) msg = 'Location permission denied. Enable it in your browser settings.';
        else if (err.code === 2) msg = 'Location unavailable. Check your device GPS/network.';
        else if (err.code === 3) msg = 'Location request timed out.';
        showToast(msg, 'danger');
      }
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );
}

function setGpsStatus(state, label) {
  const pill = document.getElementById('pill-gps');
  const widget = document.getElementById('widget-gps');
  pill.classList.remove('active', 'warning', 'error', 'pulse');

  if (state === 'active') pill.classList.add('active');
  else if (state === 'warning') pill.classList.add('warning');
  else if (state === 'error') pill.classList.add('error');
  else if (state === 'pulse') pill.classList.add('pulse');

  widget.textContent = label;
}

function resolveHeading(prevPos, lat, lng, rawHeading) {
  if (rawHeading != null && !Number.isNaN(rawHeading)) {
    HapNav.lastBearing = rawHeading;
    return rawHeading;
  }
  if (prevPos && haversineDistance(prevPos.lat, prevPos.lng, lat, lng) > 3) {
    HapNav.lastBearing = computeBearing(prevPos.lat, prevPos.lng, lat, lng);
  }
  return HapNav.lastBearing;
}

function placeCurrentLocationMarker(lat, lng, accuracy = 0, heading = null) {
  const showArrow = (HapNav.isNavigating || heading != null) && !Number.isNaN(heading);
  const angle = showArrow ? Math.round(heading || 0) : 0;
  const html = showArrow
    ? `<div class="rider-arrow-wrap"><div class="rider-arrow-marker" style="transform: rotate(${angle}deg)"></div></div>`
    : '<div class="pulse-marker"></div>';

  const icon = L.divIcon({
    className: '',
    html,
    iconSize: showArrow ? [28, 28] : [18, 18],
    iconAnchor: showArrow ? [14, 14] : [9, 9]
  });

  if (!HapNav.currentLocationMarker) {
    HapNav.currentLocationMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(HapNav.map);
  } else {
    HapNav.currentLocationMarker.setLatLng([lat, lng]);
    HapNav.currentLocationMarker.setIcon(icon);
  }

  if (!HapNav.currentLocationCircle) {
    HapNav.currentLocationCircle = L.circle([lat, lng], {
      radius: accuracy,
      color: '#00D4FF',
      weight: 1,
      fillColor: '#00D4FF',
      fillOpacity: 0.08
    }).addTo(HapNav.map);
  } else {
    HapNav.currentLocationCircle.setLatLng([lat, lng]);
    HapNav.currentLocationCircle.setRadius(accuracy);
  }
}

/* =========================================================
   LIVE NAVIGATION — watchPosition
   ========================================================= */
function startLiveTracking() {
  if (!navigator.geolocation) return;
  if (HapNav.watchId !== null) return;

  HapNav.watchId = navigator.geolocation.watchPosition(
    onLivePositionUpdate,
    () => {
      setGpsStatus('warning', 'Signal weak');
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function stopLiveTracking() {
  if (HapNav.watchId !== null) {
    navigator.geolocation.clearWatch(HapNav.watchId);
    HapNav.watchId = null;
  }
}

function onLivePositionUpdate(pos) {
  const { latitude, longitude, accuracy, heading, speed } = pos.coords;
  const prev = HapNav.currentPosition;
  const resolvedHeading = resolveHeading(prev, latitude, longitude, heading);
  HapNav.currentPosition = { lat: latitude, lng: longitude, accuracy, heading: resolvedHeading, speed };

  placeCurrentLocationMarker(latitude, longitude, accuracy, resolvedHeading);
  setGpsStatus('active', 'Active');

  if (HapNav.isNavigating) {
    if (HapNav.followRider) {
      HapNav.map.setView([latitude, longitude], Math.max(HapNav.map.getZoom(), 16), { animate: true });
    }
    updateLiveNavStats(latitude, longitude, speed);
    checkRouteDeviation(latitude, longitude);
    updateTurnInstructionFromPosition(latitude, longitude, speed || 0);
  }
}

function updateLiveNavStats(lat, lng, speed) {
  const speedKmh = speed != null && speed >= 0 ? (speed * 3.6) : 0;
  const speedDisplay = formatSpeed(speedKmh);
  document.getElementById('widget-speed').textContent = speedDisplay;
  document.getElementById('nbb-speed').textContent = speedDisplay;

  if (HapNav.route) {
    const remaining = remainingRouteDistance(lat, lng);
    const distDisplay = formatDistance(remaining);
    document.getElementById('widget-distance').textContent = distDisplay;
    document.getElementById('nbb-distance').textContent = distDisplay;

    const avgSpeedMs = speed && speed > 0.5 ? speed : (HapNav.route.distance / Math.max(1, HapNav.route.duration));
    const remainingSeconds = avgSpeedMs > 0 ? remaining / avgSpeedMs : HapNav.route.duration;
    const eta = formatETA(remainingSeconds);
    document.getElementById('widget-eta').textContent = eta;
    document.getElementById('nbb-eta').textContent = eta;

    const progressPct = Math.min(100, Math.max(0, 100 * (1 - remaining / Math.max(1, HapNav.route.distance))));
    setProgress(progressPct);
  }
}

function formatSpeed(kmh) {
  if (HapNav.settings.units === 'imperial') {
    return `${(kmh * 0.621371).toFixed(0)} mph`;
  }
  return `${kmh.toFixed(0)} km/h`;
}

function setProgress(pct) {
  document.getElementById('widget-progress-fill').style.width = `${pct}%`;
  document.getElementById('widget-progress-pct').textContent = `${pct.toFixed(0)}%`;
}

/* =========================================================
   GEOCODING — NOMINATIM AUTOCOMPLETE
   ========================================================= */
function handleAddressInput(inputEl, suggestionsId, role, waypointId = null) {
  const query = inputEl.value.trim();
  clearTimeout(HapNav.searchDebounce);

  if (query.length < 3) {
    hideSuggestions(suggestionsId);
    return;
  }

  HapNav.searchDebounce = setTimeout(() => {
    fetchAddressSuggestions(query, suggestionsId, role, waypointId);
  }, 400);
}

async function fetchAddressSuggestions(query, suggestionsId, role, waypointId = null) {
  try {
    const url = `${NOMINATIM_BASE}/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=6&addressdetails=1`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error(`Nominatim error: ${res.status}`);
    const data = await res.json();
    renderSuggestions(data, suggestionsId, role, waypointId);
  } catch (err) {
    console.error(err);
    showToast('Address search failed. Check your connection.', 'danger', 2500);
    hideSuggestions(suggestionsId);
  }
}

function renderSuggestions(results, suggestionsId, role, waypointId = null) {
  const ul = document.getElementById(suggestionsId);
  if (!ul) return;
  ul.innerHTML = '';

  if (!results.length) {
    hideSuggestions(suggestionsId);
    return;
  }

  results.forEach(item => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    const main = item.display_name.split(',')[0];
    const sub = item.display_name.split(',').slice(1, 4).join(',').trim();
    li.innerHTML = `<span class="sugg-main">${escapeHtml(main)}</span><span class="sugg-sub">${escapeHtml(sub)}</span>`;
    li.addEventListener('click', () => {
      selectAddress({
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
        label: item.display_name
      }, role, waypointId);
      hideSuggestions(suggestionsId);
    });
    ul.appendChild(li);
  });

  ul.hidden = false;
}

function hideSuggestions(id) {
  const ul = document.getElementById(id);
  if (!ul) return;
  ul.hidden = true;
  ul.innerHTML = '';
}

function hideAllSuggestions() {
  document.querySelectorAll('.suggestions').forEach(ul => {
    ul.hidden = true;
    ul.innerHTML = '';
  });
}

function selectAddress(coords, role, waypointId = null) {
  if (role === 'origin') {
    HapNav.originCoords = coords;
    document.getElementById('origin-input').value = coords.label.split(',')[0];
    placeOriginMarker(coords.lat, coords.lng);
  } else if (role === 'waypoint' && waypointId != null) {
    const wp = HapNav.waypoints.find(w => w.id === waypointId);
    if (wp) {
      wp.coords = coords;
      const input = document.getElementById(`wp-input-${waypointId}`);
      if (input) input.value = coords.label.split(',')[0];
      placeWaypointMarkers();
    }
  } else {
    HapNav.destCoords = coords;
    document.getElementById('destination-input').value = coords.label.split(',')[0];
    placeDestMarker(coords.lat, coords.lng);
  }
  fitMapToMarkers();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* =========================================================
   MARKERS — ORIGIN / DESTINATION / WAYPOINTS
   ========================================================= */
function placeOriginMarker(lat, lng) {
  const icon = L.divIcon({
    className: '',
    html: '<div style="width:16px;height:16px;border-radius:50%;background:#10B981;border:3px solid #050505;box-shadow:0 0 10px #10B981;"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
  if (HapNav.originMarker) HapNav.originMarker.remove();
  HapNav.originMarker = L.marker([lat, lng], { icon, zIndexOffset: 800 }).addTo(HapNav.map);
}

function placeDestMarker(lat, lng) {
  const icon = L.divIcon({
    className: '',
    html: '<div style="width:16px;height:16px;border-radius:50%;background:#EF4444;border:3px solid #050505;box-shadow:0 0 10px #EF4444;"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
  if (HapNav.destMarker) HapNav.destMarker.remove();
  HapNav.destMarker = L.marker([lat, lng], { icon, zIndexOffset: 800 }).addTo(HapNav.map);
}

function placeWaypointMarkers() {
  HapNav.waypointMarkers.forEach(m => m.remove());
  HapNav.waypointMarkers = [];

  HapNav.waypoints
    .filter(w => w.coords !== null)
    .forEach((w, idx) => {
      const icon = L.divIcon({
        className: '',
        html: `<div style="width:20px;height:20px;border-radius:50%;background:#F59E0B;color:#050505;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #050505;box-shadow:0 0 10px #F59E0B;">${idx + 1}</div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10]
      });
      const marker = L.marker([w.coords.lat, w.coords.lng], { icon, zIndexOffset: 780 })
        .addTo(HapNav.map)
        .bindPopup(`<strong>Stop ${idx + 1}</strong><br>${escapeHtml(w.coords.label)}`);
      HapNav.waypointMarkers.push(marker);
    });
}

function fitMapToMarkers() {
  const points = [];
  if (HapNav.originMarker) points.push(HapNav.originMarker.getLatLng());
  HapNav.waypointMarkers.forEach(m => points.push(m.getLatLng()));
  if (HapNav.destMarker) points.push(HapNav.destMarker.getLatLng());
  if (points.length >= 2) {
    HapNav.map.fitBounds(L.latLngBounds(points), { padding: [60, 60] });
  } else if (points.length === 1) {
    HapNav.map.setView(points[0], 14);
  }
}

function swapOriginDestination() {
  const tmp = HapNav.originCoords;
  HapNav.originCoords = HapNav.destCoords;
  HapNav.destCoords = tmp;

  const originInput = document.getElementById('origin-input');
  const destInput = document.getElementById('destination-input');
  const tmpVal = originInput.value;
  originInput.value = destInput.value;
  destInput.value = tmpVal;

  if (HapNav.originCoords) placeOriginMarker(HapNav.originCoords.lat, HapNav.originCoords.lng);
  else if (HapNav.originMarker) { HapNav.originMarker.remove(); HapNav.originMarker = null; }

  if (HapNav.destCoords) placeDestMarker(HapNav.destCoords.lat, HapNav.destCoords.lng);
  else if (HapNav.destMarker) { HapNav.destMarker.remove(); HapNav.destMarker = null; }

  if (HapNav.originCoords && HapNav.destCoords) findRoute();
}

/* =========================================================
   ROUTING — OSRM
   ========================================================= */
async function findRoute() {
  if (!HapNav.originCoords) {
    showToast('Please choose a starting point.', 'warning');
    return;
  }
  if (!HapNav.destCoords) {
    showToast('Please choose a destination.', 'warning');
    return;
  }

  setNavStatus('Calculating route…');

  try {
    const o = HapNav.originCoords;
    const d = HapNav.destCoords;
    const wpCoords = HapNav.waypoints.filter(w => w.coords !== null).map(w => w.coords);
    const wpStr = wpCoords.map(w => `${w.lng},${w.lat}`).join(';');
    const coordsStr = wpStr ? `${o.lng},${o.lat};${wpStr};${d.lng},${d.lat}` : `${o.lng},${o.lat};${d.lng},${d.lat}`;
    const url = `${OSRM_BASE}/${coordsStr}?overview=full&geometries=geojson&steps=true&annotations=true&alternatives=3`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM error: ${res.status}`);
    const data = await res.json();

    if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
      throw new Error('No route found');
    }

    HapNav.altRoutes = data.routes;
    applySelectedRoute(HapNav.altRoutes[0]);
    renderAltRoutes();

    document.getElementById('route-summary').classList.remove('hidden');
    document.getElementById('route-controls').classList.remove('hidden');

    setNavStatus('Route ready');
    showToast('Route calculated successfully', 'success');
  } catch (err) {
    console.error(err);
    setNavStatus('Route failed');
    showToast('Could not calculate route. The routing server may be unavailable.', 'danger');
  }
}

function applySelectedRoute(route) {
  HapNav.route = route;
  renderRoute(route);
  buildRouteSteps(route);
  updateRouteSummary(route);
  placeTurnMarkers();
  renderTurnItinerary();
}

function renderRoute(route) {
  const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);

  if (HapNav.routeLine) HapNav.routeLine.remove();
  if (HapNav.routeShadowLine) HapNav.routeShadowLine.remove();

  HapNav.routeShadowLine = L.polyline(latlngs, {
    color: '#0284C7',
    weight: 10,
    opacity: 0.25,
    lineCap: 'round',
    lineJoin: 'round'
  }).addTo(HapNav.map);

  HapNav.routeLine = L.polyline(latlngs, {
    color: '#00D4FF',
    weight: 5,
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round'
  }).addTo(HapNav.map);

  HapNav.map.fitBounds(HapNav.routeLine.getBounds(), { padding: [50, 50] });
}

function buildRouteSteps(route) {
  HapNav.routeSteps = [];
  HapNav.currentStepIndex = 0;

  const legs = route.legs || [];
  legs.forEach((leg, legIdx) => {
    const isLastLeg = legIdx === legs.length - 1;
    (leg.steps || []).forEach(step => {
      const maneuver = step.maneuver;
      // Skip intermediate leg depart steps so multi-stop transitions stay seamless
      if (legIdx > 0 && maneuver.type === 'depart') return;

      const isStopArrival = !isLastLeg && maneuver.type === 'arrive';
      const coords = step.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      HapNav.routeSteps.push({
        type: isStopArrival ? 'waypoint' : maneuver.type,
        modifier: maneuver.modifier || 'straight',
        exit: maneuver.exit || null,
        instruction: isStopArrival
          ? `Arrive at stop ${legIdx + 1}`
          : buildInstructionText(maneuver, step.name),
        location: [maneuver.location[1], maneuver.location[0]],
        distance: step.distance,
        coords,
        hapticSent: false,
        hapticImmediateSent: false,
        voiceNearSent: false,
        voiceSoonSent: false
      });
    });
  });

  // Skip initial "depart" step so navigation doesn't stall if starting >15m from origin
  if (HapNav.routeSteps.length > 1) {
    HapNav.currentStepIndex = 1;
  }
}

function resetStepAlertFlags() {
  HapNav.routeSteps.forEach(s => {
    s.hapticSent = false;
    s.hapticImmediateSent = false;
    s.voiceNearSent = false;
    s.voiceSoonSent = false;
  });
}

function buildInstructionText(maneuver, roadName) {
  const name = roadName ? ` onto ${roadName}` : '';
  switch (maneuver.type) {
    case 'depart':
      return `Head ${maneuver.modifier || ''}${name}`.trim();
    case 'arrive':
      return 'You have arrived at your destination';
    case 'turn':
      return `Turn ${maneuver.modifier}${name}`;
    case 'off ramp':
      return `Take exit ${maneuver.modifier || ''}${name}`.replace(/\s+/g, ' ').trim();
    case 'continue':
      return `Continue straight${name}`;
    case 'merge':
      return `Merge${name}`;
    case 'roundabout':
    case 'rotary': {
      const exitStr = maneuver.exit ? ` (Exit ${maneuver.exit})` : '';
      return `Enter the roundabout${exitStr}${name}`;
    }
    case 'fork':
      return `Take the ${maneuver.modifier || ''} fork${name}`.replace(/\s+/g, ' ').trim();
    case 'new name':
      return `Continue${name}`;
    default:
      return `${capitalize(maneuver.type)}${maneuver.modifier ? ' ' + maneuver.modifier : ''}${name}`;
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function updateRouteSummary(route) {
  const distance = route.distance;
  const duration = route.duration;
  const turnCount = HapNav.routeSteps.filter(s => s.type !== 'depart').length;

  document.getElementById('summary-distance').textContent = formatDistance(distance);
  document.getElementById('summary-duration').textContent = formatDuration(duration);
  document.getElementById('summary-eta').textContent = formatETA(duration);
  document.getElementById('summary-turns').textContent = turnCount;

  document.getElementById('widget-distance').textContent = formatDistance(distance);
  document.getElementById('widget-eta').textContent = formatETA(duration);
}

function formatDistance(meters) {
  if (HapNav.settings.units === 'imperial') {
    const miles = meters / 1609.34;
    return miles < 0.5 ? `${(meters * 3.28084).toFixed(0)} ft` : `${miles.toFixed(1)} mi`;
  }
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function formatDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return `${h}h ${rem}m`;
}

function formatETA(secondsFromNow) {
  const arrival = new Date(Date.now() + secondsFromNow * 1000);
  return arrival.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* =========================================================
   TURN MARKERS & TURN ITINERARY LIST
   ========================================================= */
function placeTurnMarkers() {
  clearTurnMarkers();

  HapNav.routeSteps.forEach((step, idx) => {
    if (step.type === 'depart') return;

    const icon = TURN_ICONS[step.modifier] || TURN_ICONS[step.type] || TURN_ICONS.default;
    const isArrive = step.type === 'arrive';
    const divIcon = L.divIcon({
      className: '',
      html: `<div class="turn-marker-icon"${isArrive ? ' style="border-color:var(--success);"' : ''}>
               ${icon}
               <span class="turn-marker-num">${idx}</span>
             </div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });

    const marker = L.marker(step.location, { icon, zIndexOffset: 500 })
      .addTo(HapNav.map)
      .bindPopup(`<strong>Turn ${idx}: ${escapeHtml(step.instruction)}</strong><br>${formatDistance(step.distance)}`);

    HapNav.turnMarkers.push(marker);
  });

  if (HapNav.turnMarkers.length) {
    showToast(`Marked ${HapNav.turnMarkers.length} turn${HapNav.turnMarkers.length > 1 ? 's' : ''} on the map`, 'info', 2200);
  }
}

function clearTurnMarkers() {
  HapNav.turnMarkers.forEach(m => m.remove());
  HapNav.turnMarkers = [];
}

function renderTurnItinerary() {
  const panel = document.getElementById('turns-panel');
  const list = document.getElementById('turns-list');
  const countEl = document.getElementById('turns-count');
  if (!panel || !list) return;

  const steps = HapNav.routeSteps
    .map((step, index) => ({ step, index }))
    .filter(item => item.step.type !== 'depart');

  if (!steps.length) {
    panel.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');
  countEl.textContent = `${steps.length} turn${steps.length > 1 ? 's' : ''}`;
  list.innerHTML = '';

  steps.forEach(({ step, index }) => {
    const icon = TURN_ICONS[step.modifier] || TURN_ICONS[step.type] || TURN_ICONS.default;
    const spec = getHapticSpecForStep(step);
    const li = document.createElement('li');
    li.className = 'turn-list-item';
    li.dataset.stepIndex = String(index);
    if (index === HapNav.currentStepIndex && (HapNav.isNavigating || HapNav.isSimulating)) {
      li.classList.add('active');
    }

    li.innerHTML = `
      <span class="turn-list-icon">${icon}</span>
      <div class="turn-list-body">
        <span class="turn-list-instr">${escapeHtml(step.instruction)}</span>
        <span class="turn-list-meta">${formatDistance(step.distance)}</span>
      </div>
      ${spec.badge ? `<span class="turn-list-cue">${escapeHtml(spec.badge)}</span>` : ''}
    `;

    li.addEventListener('click', () => {
      setFollowRider(false);
      HapNav.map.setView(step.location, 17, { animate: true });
      const marker = HapNav.turnMarkers[index - 1];
      if (marker) marker.openPopup();
    });

    list.appendChild(li);
  });
}

function updateTurnItineraryActive() {
  const list = document.getElementById('turns-list');
  if (!list) return;
  list.querySelectorAll('.turn-list-item').forEach(li => {
    const idx = Number(li.dataset.stepIndex);
    li.classList.toggle('active', idx === HapNav.currentStepIndex);
    li.classList.toggle('passed', idx < HapNav.currentStepIndex);
    if (idx === HapNav.currentStepIndex) {
      li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

/* =========================================================
   CLEAR ROUTE
   ========================================================= */
function clearRoute() {
  if (HapNav.routeLine) { HapNav.routeLine.remove(); HapNav.routeLine = null; }
  if (HapNav.routeShadowLine) { HapNav.routeShadowLine.remove(); HapNav.routeShadowLine = null; }
  if (HapNav.originMarker) { HapNav.originMarker.remove(); HapNav.originMarker = null; }
  if (HapNav.destMarker) { HapNav.destMarker.remove(); HapNav.destMarker = null; }
  HapNav.waypointMarkers.forEach(m => m.remove());
  HapNav.waypointMarkers = [];
  clearTurnMarkers();

  HapNav.route = null;
  HapNav.altRoutes = [];
  HapNav.routeSteps = [];
  HapNav.originCoords = null;
  HapNav.destCoords = null;
  HapNav.waypoints = [];

  document.getElementById('origin-input').value = '';
  document.getElementById('destination-input').value = '';
  document.getElementById('waypoints-container').innerHTML = '';
  document.getElementById('alt-routes').innerHTML = '';
  document.getElementById('alt-routes').classList.add('hidden');
  document.getElementById('turns-list').innerHTML = '';
  document.getElementById('turns-panel').classList.add('hidden');
  document.getElementById('route-summary').classList.add('hidden');
  document.getElementById('route-controls').classList.add('hidden');

  stopNavigation();
  stopSimulation();
  setNavStatus('Idle');

  document.getElementById('widget-distance').textContent = '—';
  document.getElementById('widget-eta').textContent = '—';
  setProgress(0);

  showToast('Route cleared', 'info', 2000);
}

/* =========================================================
   NAVIGATION FLOW
   ========================================================= */
function startNavigation() {
  if (!HapNav.route) {
    showToast('Calculate a route first.', 'warning');
    return;
  }

  if (HapNav.isSimulating) stopSimulation();

  HapNav.isNavigating = true;
  HapNav.currentStepIndex = HapNav.routeSteps.length > 1 ? 1 : 0;
  resetStepAlertFlags();
  HapNav.lastSpokenInstruction = null;
  HapNav.offRouteWarningActive = false;
  setFollowRider(true);

  document.getElementById('turn-card').classList.remove('hidden');
  document.getElementById('nav-bottombar').classList.remove('hidden');
  setNavStatus('Navigating');

  if (HapNav.settings.rideFocus) {
    setRideFocus(true);
  }

  requestWakeLock();
  startLiveTracking();
  announceCurrentStep(true);
  updateTurnItineraryActive();

  showToast('Ride navigation started', 'success');
}

function stopNavigation() {
  if (HapNav.isSimulating) {
    stopSimulation();
    return;
  }
  if (!HapNav.isNavigating) return;
  HapNav.isNavigating = false;
  stopLiveTracking();
  releaseWakeLock();
  setFollowRider(true);

  document.getElementById('turn-card').classList.add('hidden');
  document.getElementById('nav-bottombar').classList.add('hidden');
  document.getElementById('offroute-banner').classList.add('hidden');
  document.getElementById('nbb-recenter-btn').classList.add('hidden');
  document.getElementById('recenter-fab').classList.add('hidden');

  setRideFocus(false);
  setNavStatus('Idle');
  showToast('Navigation ended', 'info', 2000);
}

function setNavStatus(text) {
  document.getElementById('widget-nav').textContent = text;
}

/* =========================================================
   HAPTIC MAPPING & TWO-STAGE TURN-BY-TURN LOGIC
   ========================================================= */
function getHapticSpecForStep(step) {
  if (!step) return { warnCmd: null, confirmCmd: HAPTIC_COMMANDS.STRAIGHT, badge: '', side: 'none', msg: '' };

  if (step.type === 'arrive') {
    return {
      warnCmd: null,
      confirmCmd: HAPTIC_COMMANDS.ARRIVED,
      badge: 'END',
      side: 'both',
      msg: 'Arrived (Alternating L/R 3×)'
    };
  }

  if (step.type === 'roundabout' || step.type === 'rotary') {
    const exitNum = Math.max(1, Math.min(4, Number(step.exit) || 1));
    return {
      warnCmd: HAPTIC_COMMANDS.WARN_HWY,
      confirmCmd: 0x40 + exitNum,
      badge: `RB #${exitNum}`,
      side: 'right',
      msg: `Roundabout exit ${exitNum} (${exitNum}× R)`
    };
  }

  if (step.type === 'off ramp') {
    const isLeft = (step.modifier || '').includes('left');
    return {
      warnCmd: HAPTIC_COMMANDS.WARN_HWY,
      confirmCmd: isLeft ? HAPTIC_COMMANDS.HWY_EXIT_LEFT : HAPTIC_COMMANDS.HWY_EXIT_RIGHT,
      badge: isLeft ? '3× L' : '3× R',
      side: isLeft ? 'left' : 'right',
      msg: isLeft ? 'Highway exit left (3× L)' : 'Highway exit right (3× R)'
    };
  }

  switch (step.modifier) {
    case 'sharp left':
      return { warnCmd: HAPTIC_COMMANDS.WARN_SHARP_LEFT, confirmCmd: HAPTIC_COMMANDS.SHARP_LEFT, badge: '2× L', side: 'left', msg: 'Sharp left (2× L)' };
    case 'sharp right':
      return { warnCmd: HAPTIC_COMMANDS.WARN_SHARP_RIGHT, confirmCmd: HAPTIC_COMMANDS.SHARP_RIGHT, badge: '2× R', side: 'right', msg: 'Sharp right (2× R)' };
    case 'slight left':
      return { warnCmd: HAPTIC_COMMANDS.WARN_LEFT, confirmCmd: HAPTIC_COMMANDS.SLIGHT_LEFT, badge: '1× L (Low)', side: 'left', msg: 'Slight left (Low L)' };
    case 'slight right':
      return { warnCmd: HAPTIC_COMMANDS.WARN_RIGHT, confirmCmd: HAPTIC_COMMANDS.SLIGHT_RIGHT, badge: '1× R (Low)', side: 'right', msg: 'Slight right (Low R)' };
    case 'left':
      return { warnCmd: HAPTIC_COMMANDS.WARN_LEFT, confirmCmd: HAPTIC_COMMANDS.LEFT, badge: '1× L', side: 'left', msg: 'Turn left (1× L)' };
    case 'right':
      return { warnCmd: HAPTIC_COMMANDS.WARN_RIGHT, confirmCmd: HAPTIC_COMMANDS.RIGHT, badge: '1× R', side: 'right', msg: 'Turn right (1× R)' };
    case 'uturn':
      return { warnCmd: HAPTIC_COMMANDS.WARN_UTURN, confirmCmd: HAPTIC_COMMANDS.UTURN, badge: '2× BOTH', side: 'both', msg: 'U-turn (2× Both)' };
    default:
      if (step.type === 'fork') {
        const isLeft = (step.modifier || '').includes('left');
        return isLeft
          ? { warnCmd: HAPTIC_COMMANDS.WARN_LEFT, confirmCmd: HAPTIC_COMMANDS.SLIGHT_LEFT, badge: '1× L', side: 'left', msg: 'Keep left (Low L)' }
          : { warnCmd: HAPTIC_COMMANDS.WARN_RIGHT, confirmCmd: HAPTIC_COMMANDS.SLIGHT_RIGHT, badge: '1× R', side: 'right', msg: 'Keep right (Low R)' };
      }
      return { warnCmd: null, confirmCmd: HAPTIC_COMMANDS.STRAIGHT, badge: '', side: 'none', msg: '' };
  }
}

function getCommandSide(cmd) {
  const leftCmds = new Set([0x01, 0x11, 0x21, 0x31, 0x51, 0x53]);
  const rightCmds = new Set([0x02, 0x12, 0x22, 0x32, 0x41, 0x42, 0x43, 0x44, 0x52, 0x54, 0x56]);
  if (leftCmds.has(cmd)) return 'left';
  if (rightCmds.has(cmd)) return 'right';
  if (cmd === 0x30 || cmd === 0x55 || cmd === 0xA0 || cmd === 0xB0) return 'both';
  return 'none';
}

function triggerHapticVisual(cmd, labelText = '') {
  const side = getCommandSide(cmd);
  const leftEl = document.getElementById('haptic-edge-left');
  const rightEl = document.getElementById('haptic-edge-right');
  const hud = document.getElementById('haptic-hud');
  const hudText = document.getElementById('haptic-hud-text');

  [leftEl, rightEl].forEach(el => {
    if (!el) return;
    el.classList.remove('pulse-active');
    void el.offsetWidth;
  });

  if (side === 'left' || side === 'both') leftEl?.classList.add('pulse-active');
  if (side === 'right' || side === 'both') rightEl?.classList.add('pulse-active');

  if (hud && hudText && labelText) {
    hudText.textContent = labelText;
    hud.classList.remove('hidden');
    clearTimeout(HapNav.hapticHudTimer);
    HapNav.hapticHudTimer = setTimeout(() => hud.classList.add('hidden'), 2400);
  }
}

function triggerPhoneVibrate(cmd) {
  if (!HapNav.settings.vibrateFallback || !HapNav.settings.haptic) return;
  if (HapNav.bleCharacteristic || !('vibrate' in navigator)) return;

  const patterns = {
    [HAPTIC_COMMANDS.SLIGHT_LEFT]: [100],
    [HAPTIC_COMMANDS.SLIGHT_RIGHT]: [100],
    [HAPTIC_COMMANDS.LEFT]: [220],
    [HAPTIC_COMMANDS.RIGHT]: [220],
    [HAPTIC_COMMANDS.SHARP_LEFT]: [240, 90, 240],
    [HAPTIC_COMMANDS.SHARP_RIGHT]: [240, 90, 240],
    [HAPTIC_COMMANDS.UTURN]: [250, 90, 250],
    [HAPTIC_COMMANDS.HWY_EXIT_LEFT]: [140, 70, 140, 70, 140],
    [HAPTIC_COMMANDS.HWY_EXIT_RIGHT]: [140, 70, 140, 70, 140],
    [HAPTIC_COMMANDS.WARN_LEFT]: [120],
    [HAPTIC_COMMANDS.WARN_RIGHT]: [120],
    [HAPTIC_COMMANDS.WARN_SHARP_LEFT]: [130, 70, 130],
    [HAPTIC_COMMANDS.WARN_SHARP_RIGHT]: [130, 70, 130],
    [HAPTIC_COMMANDS.WARN_UTURN]: [130, 70, 130],
    [HAPTIC_COMMANDS.WARN_HWY]: [100, 60, 100, 60, 100],
    [HAPTIC_COMMANDS.ARRIVED]: [300, 80, 300, 80, 300],
    [HAPTIC_COMMANDS.REROUTE]: [150, 60, 150, 100, 150, 60, 150]
  };
  const pattern = patterns[cmd] || (cmd >= 0x41 && cmd <= 0x44 ? [180, 100, 180] : null);
  if (pattern) {
    try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
  }
}

function updateTurnStageBadge(text, mode = '') {
  const badge = document.getElementById('turn-stage-badge');
  if (!badge) return;
  badge.textContent = text;
  badge.classList.remove('warn', 'now');
  if (mode) badge.classList.add(mode);
}

function updateNextTurnPreview() {
  const pill = document.getElementById('next-turn-pill');
  const iconEl = document.getElementById('next-turn-icon');
  const textEl = document.getElementById('next-turn-text');
  if (!pill) return;

  const nextStep = HapNav.routeSteps[HapNav.currentStepIndex + 1];
  if (!nextStep) {
    pill.classList.add('hidden');
    return;
  }

  const icon = TURN_ICONS[nextStep.modifier] || TURN_ICONS[nextStep.type] || TURN_ICONS.default;
  iconEl.textContent = icon;
  textEl.textContent = `${nextStep.instruction} (${formatDistance(nextStep.distance)})`;
  pill.classList.remove('hidden');
}

function announceCurrentStep(force = false) {
  const step = HapNav.routeSteps[HapNav.currentStepIndex];
  if (!step) return;

  const icon = TURN_ICONS[step.modifier] || TURN_ICONS[step.type] || TURN_ICONS.default;
  const spec = getHapticSpecForStep(step);
  document.getElementById('turn-icon').textContent = icon;
  document.getElementById('turn-instruction').textContent = step.instruction;
  document.getElementById('turn-distance').textContent = formatDistance(step.distance);
  updateTurnStageBadge('NEXT TURN');

  const hapticBadge = document.getElementById('turn-haptic-badge');
  if (hapticBadge) {
    hapticBadge.textContent = spec.badge;
    hapticBadge.classList.toggle('hidden', !spec.badge);
  }

  const proxFill = document.getElementById('turn-proximity-fill');
  if (proxFill) proxFill.style.width = '0%';

  updateNextTurnPreview();
  updateTurnItineraryActive();

  if (force || HapNav.lastSpokenInstruction !== step.instruction) {
    speak(buildVoiceInstruction(step));
    HapNav.lastSpokenInstruction = step.instruction;
  }
}

function buildVoiceInstruction(step) {
  const distText = step.distance >= 1000
    ? `${(step.distance / 1000).toFixed(1)} kilometers`
    : `${Math.round(step.distance)} meters`;

  switch (step.type) {
    case 'depart':
      return `Starting navigation. ${step.instruction}.`;
    case 'arrive':
      return 'You have arrived at your destination.';
    case 'waypoint':
      return `Approaching stop in ${distText}.`;
    case 'roundabout':
    case 'rotary': {
      const exitPart = step.exit ? ` and take exit ${step.exit}` : '';
      return `Enter the roundabout in ${distText}${exitPart}`;
    }
    default:
      if (step.modifier === 'left') return `Turn left in ${distText}`;
      if (step.modifier === 'right') return `Turn right in ${distText}`;
      if (step.modifier === 'sharp left') return `Sharp left in ${distText}`;
      if (step.modifier === 'sharp right') return `Sharp right in ${distText}`;
      if (step.modifier === 'slight left') return `Slight left in ${distText}`;
      if (step.modifier === 'slight right') return `Slight right in ${distText}`;
      if (step.modifier === 'uturn') return `Make a U-turn in ${distText}`;
      return `Continue straight for ${distText}`;
  }
}

function sendHapticForStage(step, stage, distText) {
  if (!HapNav.settings.haptic) return;

  const spec = getHapticSpecForStep(step);
  const cmd = stage === 'warn' ? spec.warnCmd : spec.confirmCmd;

  if (!cmd || cmd === HAPTIC_COMMANDS.STRAIGHT) return;

  sendHapticCommand(cmd);
  const stageLabel = stage === 'warn' ? 'PREPARE' : 'NOW';
  const hudMsg = `${stageLabel}: ${spec.msg}${distText ? ' · ' + distText : ''}`;
  triggerHapticVisual(cmd, hudMsg);

  if (distText) {
    showToast(`Haptic ${hudMsg}`, 'info', 2600);
  }
}

function updateTurnInstructionFromPosition(lat, lng, speedMs = 0) {
  const step = HapNav.routeSteps[HapNav.currentStepIndex];
  if (!step) return;

  const distToManeuver = haversineDistance(lat, lng, step.location[0], step.location[1]);
  document.getElementById('turn-distance').textContent = formatDistance(distToManeuver);

  // Proximity fill (100% as rider reaches 15m before maneuver)
  const proxMax = Math.max(120, Math.min(400, step.distance || 200));
  const proxPct = Math.max(0, Math.min(100, (1 - Math.max(0, distToManeuver - 15) / proxMax) * 100));
  const proxFill = document.getElementById('turn-proximity-fill');
  if (proxFill) proxFill.style.width = `${proxPct.toFixed(0)}%`;

  // Speed-adaptive two-stage haptic distances
  const warnDist = Math.max(80, Math.min(220, (speedMs || 0) * 6));
  const confirmDist = Math.max(30, Math.min(65, (speedMs || 0) * 2.2));

  // Voice cues
  if (distToManeuver <= Math.max(110, warnDist + 20) && !step.voiceNearSent) {
    step.voiceNearSent = true;
    speak(buildVoiceInstruction({ ...step, distance: Math.round(distToManeuver) }));
  }

  // Stage 1: Early warning haptic (0x51–0x56)
  if (distToManeuver <= warnDist && !step.hapticSent) {
    step.hapticSent = true;
    updateTurnStageBadge(`WARN · ${Math.round(distToManeuver)}m`, 'warn');
    sendHapticForStage(step, 'warn', Math.round(distToManeuver) + 'm');
  }

  if (distToManeuver <= Math.max(50, confirmDist + 15) && !step.voiceSoonSent) {
    step.voiceSoonSent = true;
    speak(buildVoiceInstruction({ ...step, distance: Math.round(distToManeuver) }));
  }

  // Stage 2: Immediate turn confirmation haptic (skip arrive here; finishNavigation sends 0xA0)
  if (distToManeuver <= confirmDist && !step.hapticImmediateSent) {
    step.hapticImmediateSent = true;
    updateTurnStageBadge(`NOW · ${Math.round(distToManeuver)}m`, 'now');
    if (step.type !== 'arrive') {
      sendHapticForStage(step, 'confirm', Math.round(distToManeuver) + 'm');
    }
  }

  // Advance to next step
  if (distToManeuver <= 15) {
    if (step.type === 'arrive') {
      finishNavigation();
      return;
    }
    if (step.type === 'waypoint') {
      showToast('Reached intermediate stop!', 'success', 3000);
    }
    HapNav.currentStepIndex = Math.min(HapNav.currentStepIndex + 1, HapNav.routeSteps.length - 1);
    HapNav.lastSpokenInstruction = null;
    announceCurrentStep(true);
  }
}

function finishNavigation() {
  speak('You have arrived at your destination.');
  sendHapticCommand(HAPTIC_COMMANDS.ARRIVED);
  triggerHapticVisual(HAPTIC_COMMANDS.ARRIVED, 'ARRIVED · Alternating L/R');
  setProgress(100);
  showToast('You have arrived!', 'success', 5000);

  if (HapNav.isNavigating) stopNavigation();
  if (HapNav.isSimulating) stopSimulation();
}

/* =========================================================
   ROUTE DEVIATION & RECALCULATION
   ========================================================= */
function checkRouteDeviation(lat, lng) {
  if (!HapNav.route || !HapNav.routeLine) return;

  const threshold = 40; // meters
  const distToRoute = distanceToPolyline(lat, lng, HapNav.routeLine.getLatLngs());
  const banner = document.getElementById('offroute-banner');

  if (distToRoute > threshold) {
    const now = Date.now();
    if (!HapNav.offRouteWarningActive && now - HapNav.lastRerouteAt > 8000) {
      HapNav.offRouteWarningActive = true;
      HapNav.lastRerouteAt = now;
      banner.classList.remove('hidden');
      speak('Recalculating route');
      showToast('You are off route. Recalculating…', 'warning');
      sendHapticCommand(HAPTIC_COMMANDS.REROUTE);
      triggerHapticVisual(HAPTIC_COMMANDS.REROUTE, 'REROUTING · L→R Wave');
      recalculateRouteFromCurrentPosition(lat, lng);
    }
  } else {
    if (HapNav.offRouteWarningActive) {
      HapNav.offRouteWarningActive = false;
      banner.classList.add('hidden');
    }
  }
}

async function recalculateRouteFromCurrentPosition(lat, lng) {
  if (!HapNav.destCoords) return;

  try {
    HapNav.originCoords = { lat, lng, label: 'Current location' };
    placeOriginMarker(lat, lng);

    const o = HapNav.originCoords;
    const d = HapNav.destCoords;
    const wpCoords = HapNav.waypoints.filter(w => w.coords !== null).map(w => w.coords);
    const wpStr = wpCoords.map(w => `${w.lng},${w.lat}`).join(';');
    const coordsStr = wpStr ? `${o.lng},${o.lat};${wpStr};${d.lng},${d.lat}` : `${o.lng},${o.lat};${d.lng},${d.lat}`;
    const url = `${OSRM_BASE}/${coordsStr}?overview=full&geometries=geojson&steps=true&annotations=true&alternatives=3`;

    const res = await fetch(url);
    if (!res.ok) throw new Error('OSRM error');
    const data = await res.json();

    if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
      throw new Error('No route found');
    }

    HapNav.altRoutes = data.routes;
    applySelectedRoute(HapNav.altRoutes[0]);
    renderAltRoutes();

    HapNav.currentStepIndex = HapNav.routeSteps.length > 1 ? 1 : 0;
    HapNav.lastSpokenInstruction = null;
    announceCurrentStep(true);

    document.getElementById('offroute-banner').classList.add('hidden');
    HapNav.offRouteWarningActive = false;
    showToast('Route recalculated', 'success', 2500);
  } catch (err) {
    console.error(err);
    showToast('Recalculation failed. Will retry on next deviation.', 'danger');
    HapNav.offRouteWarningActive = false;
  }
}

/* =========================================================
   GEOMETRY HELPERS
   ========================================================= */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeBearing(lat1, lon1, lat2, lon2) {
  const toRad = deg => (deg * Math.PI) / 180;
  const toDeg = rad => (rad * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLam = toRad(lon2 - lon1);
  const y = Math.sin(dLam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function distanceToPolyline(lat, lng, latlngs) {
  let min = Infinity;
  for (let i = 0; i < latlngs.length - 1; i++) {
    const d = distanceToSegment(lat, lng, latlngs[i].lat, latlngs[i].lng, latlngs[i + 1].lat, latlngs[i + 1].lng);
    if (d < min) min = d;
  }
  return min;
}

function distanceToSegment(lat, lng, lat1, lng1, lat2, lng2) {
  const x = lng, y = lat;
  const x1 = lng1, y1 = lat1, x2 = lng2, y2 = lat2;

  const A = x - x1, B = y - y1, C = x2 - x1, D = y2 - y1;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let t = lenSq !== 0 ? dot / lenSq : -1;
  t = Math.max(0, Math.min(1, t));

  const projX = x1 + t * C;
  const projY = y1 + t * D;

  return haversineDistance(lat, lng, projY, projX);
}

function remainingRouteDistance(lat, lng) {
  if (!HapNav.route) return 0;
  const coords = HapNav.route.geometry.coordinates;

  let nearestIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = distanceToSegment(lat, lng, coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
    if (d < minDist) { minDist = d; nearestIdx = i; }
  }

  let remaining = haversineDistance(lat, lng, coords[nearestIdx + 1][1], coords[nearestIdx + 1][0]);
  for (let i = nearestIdx + 1; i < coords.length - 1; i++) {
    remaining += haversineDistance(coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
  }
  return remaining;
}

/* =========================================================
   ROUTE SIMULATION
   ========================================================= */
function startSimulation() {
  if (!HapNav.route) {
    showToast('Calculate a route first.', 'warning');
    return;
  }
  if (HapNav.isSimulating) return;
  if (HapNav.isNavigating) stopNavigation();

  HapNav.isSimulating = true;
  HapNav.simRouteCoords = HapNav.route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  HapNav.simProgressIndex = 0;
  HapNav.currentStepIndex = HapNav.routeSteps.length > 1 ? 1 : 0;
  resetStepAlertFlags();
  HapNav.lastSpokenInstruction = null;
  setFollowRider(true);

  document.getElementById('sim-bar').classList.remove('hidden');
  document.getElementById('turn-card').classList.remove('hidden');
  document.getElementById('nav-bottombar').classList.remove('hidden');
  setNavStatus('Simulating');

  if (HapNav.settings.rideFocus) {
    setRideFocus(true);
  }
  requestWakeLock();

  const initialBearing = HapNav.simRouteCoords.length > 1
    ? computeBearing(
        HapNav.simRouteCoords[0][0], HapNav.simRouteCoords[0][1],
        HapNav.simRouteCoords[1][0], HapNav.simRouteCoords[1][1]
      )
    : 0;

  const makeSimIcon = (deg) => L.divIcon({
    className: '',
    html: `<div class="rider-arrow-wrap"><div class="rider-arrow-marker sim" style="transform: rotate(${Math.round(deg)}deg)"></div></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });

  if (HapNav.simMarker) HapNav.simMarker.remove();
  HapNav.simMarker = L.marker(HapNav.simRouteCoords[0], { icon: makeSimIcon(initialBearing), zIndexOffset: 900 }).addTo(HapNav.map);

  announceCurrentStep(true);
  updateTurnItineraryActive();

  const totalPoints = HapNav.simRouteCoords.length;
  const baseStepIntervalMs = Math.max(800, Math.min(2000, 60000 / Math.max(1, totalPoints)));

  function simStep() {
    HapNav.simProgressIndex++;

    if (HapNav.simProgressIndex >= totalPoints) {
      finishNavigation();
      return;
    }

    const prevPt = HapNav.simRouteCoords[HapNav.simProgressIndex - 1];
    const [lat, lng] = HapNav.simRouteCoords[HapNav.simProgressIndex];
    const bearing = computeBearing(prevPt[0], prevPt[1], lat, lng);

    HapNav.simMarker.setLatLng([lat, lng]);
    HapNav.simMarker.setIcon(makeSimIcon(bearing));

    if (HapNav.followRider) {
      HapNav.map.panTo([lat, lng], { animate: true });
    }

    const pct = (HapNav.simProgressIndex / Math.max(1, totalPoints - 1)) * 100;
    document.getElementById('sim-progress-fill').style.width = `${pct}%`;
    document.getElementById('sim-progress-text').textContent = `${pct.toFixed(0)}%`;
    setProgress(pct);

    const simSpeedKmh = 40 + Math.sin(HapNav.simProgressIndex / 6) * 10;
    const simSpeedMs = Math.max(0, simSpeedKmh) / 3.6;
    document.getElementById('widget-speed').textContent = formatSpeed(Math.max(0, simSpeedKmh));
    document.getElementById('nbb-speed').textContent = formatSpeed(Math.max(0, simSpeedKmh));

    const remaining = HapNav.route.distance * (1 - pct / 100);
    const eta = formatETA(remaining / Math.max(1, simSpeedMs));
    document.getElementById('widget-eta').textContent = eta;
    document.getElementById('nbb-eta').textContent = eta;
    document.getElementById('widget-distance').textContent = formatDistance(remaining);
    document.getElementById('nbb-distance').textContent = formatDistance(remaining);

    updateTurnInstructionFromPosition(lat, lng, simSpeedMs);

    const speedSelect = document.getElementById('sim-speed-select');
    const multiplier = speedSelect ? parseFloat(speedSelect.value) : 1;
    HapNav.simInterval = setTimeout(simStep, baseStepIntervalMs / multiplier);
  }

  HapNav.simInterval = setTimeout(simStep, baseStepIntervalMs);
  showToast('Simulation started', 'info', 2000);
}

function stopSimulation() {
  if (!HapNav.isSimulating) return;
  HapNav.isSimulating = false;

  clearTimeout(HapNav.simInterval);
  HapNav.simInterval = null;
  releaseWakeLock();
  setFollowRider(true);

  if (HapNav.simMarker) { HapNav.simMarker.remove(); HapNav.simMarker = null; }

  document.getElementById('sim-bar').classList.add('hidden');
  document.getElementById('sim-progress-fill').style.width = '0%';
  document.getElementById('sim-progress-text').textContent = '0%';

  if (!HapNav.isNavigating) {
    document.getElementById('turn-card').classList.add('hidden');
    document.getElementById('nav-bottombar').classList.add('hidden');
    document.getElementById('nbb-recenter-btn').classList.add('hidden');
    document.getElementById('recenter-fab').classList.add('hidden');
    setRideFocus(false);
    setNavStatus('Idle');
  }

  showToast('Simulation stopped', 'info', 2000);
}

/* =========================================================
   VOICE — speechSynthesis
   ========================================================= */
function speak(text) {
  if (HapNav.speechMuted || !HapNav.settings.voice) return;
  if (!('speechSynthesis' in window)) return;

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 1.02;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch (e) {
    console.error('Speech synthesis error:', e);
  }
}

function toggleMute() {
  HapNav.speechMuted = !HapNav.speechMuted;
  HapNav.settings.voice = !HapNav.speechMuted;
  setToggleState('voice-toggle', HapNav.settings.voice);
  updateMuteIcon();
  persistSettings();

  if (HapNav.speechMuted) {
    window.speechSynthesis?.cancel();
    showToast('Voice guidance muted', 'info', 1800);
  } else {
    showToast('Voice guidance unmuted', 'info', 1800);
  }
}

function updateMuteIcon() {
  const icon = document.getElementById('mute-icon');
  const btn = document.getElementById('mute-btn');
  if (!icon || !btn) return;
  if (HapNav.speechMuted) {
    icon.innerHTML = '<path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor"/><line x1="23" y1="9" x2="17" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="17" y1="9" x2="23" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    btn.dataset.tip = 'Unmute voice';
  } else {
    icon.innerHTML = '<path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor"/><path d="M16 8a5 5 0 010 8M19 5a8 8 0 010 14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>';
    btn.dataset.tip = 'Mute voice';
  }
}

/* =========================================================
   HAPTIC HELMET — Web Bluetooth (Protocol Unchanged)
   ========================================================= */
async function connectHapticHelmet() {
  if (!('bluetooth' in navigator)) {
    showToast('Web Bluetooth is not supported in this browser.', 'danger');
    return;
  }

  try {
    setBleStatus('pulse', 'Connecting…');

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }]
    });

    HapNav.bleDevice = device;
    device.addEventListener('gattserverdisconnected', onHelmetDisconnected);

    const server = await device.gatt.connect();
    HapNav.bleServer = server;

    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    const characteristic = await service.getCharacteristic(BLE_CHAR_UUID);
    HapNav.bleCharacteristic = characteristic;

    setBleStatus('active', 'Connected');
    document.getElementById('ble-connect-btn').disabled = true;
    document.getElementById('ble-disconnect-btn').disabled = false;
    document.getElementById('ble-test-row').hidden = false;

    showToast('HapticHelmet connected', 'success');
  } catch (err) {
    console.error(err);
    setBleStatus('error', 'Disconnected');
    if (err.name === 'NotFoundError') {
      showToast('No device selected.', 'info', 2200);
    } else {
      showToast('Could not connect to HapticHelmet.', 'danger');
    }
  }
}

function onHelmetDisconnected() {
  setBleStatus('error', 'Disconnected');
  document.getElementById('ble-connect-btn').disabled = false;
  document.getElementById('ble-disconnect-btn').disabled = true;
  document.getElementById('ble-test-row').hidden = true;
  HapNav.bleCharacteristic = null;
  HapNav.bleServer = null;
  showToast('HapticHelmet disconnected', 'warning', 2500);
}

function disconnectHapticHelmet() {
  if (HapNav.bleDevice && HapNav.bleDevice.gatt.connected) {
    HapNav.bleDevice.gatt.disconnect();
  }
  onHelmetDisconnected();
}

function setBleStatus(state, label) {
  const pill = document.getElementById('pill-ble');
  const widget = document.getElementById('widget-ble');
  pill.classList.remove('active', 'warning', 'error', 'pulse');

  if (state === 'active') pill.classList.add('active');
  else if (state === 'warning') pill.classList.add('warning');
  else if (state === 'error') pill.classList.add('error');
  else if (state === 'pulse') pill.classList.add('pulse');

  widget.textContent = label;
}

async function processBleQueue() {
  if (isBleWriting || bleWriteQueue.length === 0) return;
  isBleWriting = true;

  const cmd = bleWriteQueue.shift();
  try {
    if (HapNav.bleCharacteristic) {
      const data = new Uint8Array([cmd]);
      await HapNav.bleCharacteristic.writeValue(data);
    }
  } catch (err) {
    console.error('BLE write error:', err);
  }

  isBleWriting = false;
  processBleQueue();
}

async function sendHapticCommand(cmd, isTest = false) {
  if (!HapNav.settings.haptic && !isTest) return;

  HapNav.lastHapticCommand = cmd;
  triggerPhoneVibrate(cmd);

  if (isTest) {
    const name = Object.entries(HAPTIC_COMMANDS).find(([, v]) => v === cmd)?.[0] || `0x${cmd.toString(16)}`;
    triggerHapticVisual(cmd, `TEST: ${name}`);
  }

  if (!HapNav.bleCharacteristic) {
    if (isTest) showToast('Previewed cue (connect HapticHelmet for helmet motors).', 'info', 2200);
    return;
  }

  bleWriteQueue.push(cmd);
  processBleQueue();

  if (isTest) {
    const name = Object.entries(HAPTIC_COMMANDS).find(([, v]) => v === cmd)?.[0] || cmd;
    showToast(`Sent ${name} command to helmet`, 'success', 1800);
  }
}

/* =========================================================
   EMERGENCY SOS
   ========================================================= */
function openSosModal() {
  openModal('sos-modal-backdrop');
  const locEl = document.getElementById('sos-location');
  const msgEl = document.getElementById('sos-message');
  const smsBtn = document.getElementById('sos-sms-btn');

  locEl.textContent = 'Fetching location…';
  msgEl.value = '';

  if (!navigator.geolocation) {
    locEl.textContent = 'Location unavailable on this device.';
    msgEl.value = 'I need help. My location could not be determined automatically.';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const mapsLink = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;
      locEl.innerHTML = `Lat: ${latitude.toFixed(6)}, Lng: ${longitude.toFixed(6)}<br>Accuracy: ±${Math.round(accuracy)} m`;

      const message = `EMERGENCY: I need help. My current location is ${latitude.toFixed(6)}, ${longitude.toFixed(6)} (accuracy ±${Math.round(accuracy)}m). Map: ${mapsLink}`;
      msgEl.value = message;
      smsBtn.href = `sms:?body=${encodeURIComponent(message)}`;
    },
    () => {
      locEl.textContent = 'Could not fetch live location. Permission may be denied.';
      msgEl.value = 'EMERGENCY: I need help, but my location could not be retrieved automatically.';
      smsBtn.href = `sms:?body=${encodeURIComponent(msgEl.value)}`;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function copySosMessage() {
  const msgEl = document.getElementById('sos-message');
  msgEl.select();

  try {
    navigator.clipboard?.writeText(msgEl.value).then(() => {
      showToast('Emergency message copied', 'success', 2200);
    }).catch(() => {
      document.execCommand('copy');
      showToast('Emergency message copied', 'success', 2200);
    });
  } catch (e) {
    document.execCommand('copy');
    showToast('Emergency message copied', 'success', 2200);
  }
}

/* =========================================================
   NEARBY SERVICES — Overpass API
   ========================================================= */
async function toggleNearbyCategory(btn) {
  const type = btn.dataset.type;
  const isActive = btn.getAttribute('aria-pressed') === 'true';

  if (isActive) {
    btn.setAttribute('aria-pressed', 'false');
    removeNearbyMarkers(type);
    refreshNearbyList();
    return;
  }

  if (!HapNav.currentPosition) {
    showToast('Detecting your location first…', 'info', 2000);
    detectCurrentLocation({ silent: false, center: false });
    await new Promise(r => setTimeout(r, 1200));
    if (!HapNav.currentPosition) {
      showToast('Location needed to find nearby services.', 'warning');
      return;
    }
  }

  btn.setAttribute('aria-pressed', 'true');
  await fetchNearbyPlaces(type);
}

async function fetchNearbyPlaces(type) {
  const { lat, lng } = HapNav.currentPosition;
  const def = NEARBY_QUERIES[type];
  const radius = 4000;

  const list = document.getElementById('nearby-list');
  list.innerHTML = '<li class="nearby-empty">Searching nearby…</li>';

  try {
    const query = `[out:json][timeout:15];node[${def.tag}](around:${radius},${lat},${lng});out body 12;`;
    const res = await fetch(OVERPASS_BASE, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (!res.ok) throw new Error(`Overpass error: ${res.status}`);
    const data = await res.json();

    renderNearbyMarkers(data.elements || [], type, def);
    refreshNearbyList();
  } catch (err) {
    console.error(err);
    list.innerHTML = '<li class="nearby-empty">Could not load nearby places. Try again later.</li>';
    showToast('Nearby search failed.', 'danger');
  }
}

function renderNearbyMarkers(elements, type, def) {
  removeNearbyMarkers(type);

  elements.forEach(el => {
    if (!el.lat || !el.lon) return;
    const name = el.tags?.name || def.label;

    const icon = L.divIcon({
      className: '',
      html: `<div class="nearby-marker-icon">${def.icon}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    const marker = L.marker([el.lat, el.lon], { icon, zIndexOffset: 400 })
      .addTo(HapNav.map)
      .bindPopup(`<strong>${escapeHtml(name)}</strong><br>${def.label}`);

    marker._hapnavType = type;
    marker._hapnavData = { name, lat: el.lat, lon: el.lon, type };
    HapNav.nearbyMarkers.push(marker);
  });
}

function removeNearbyMarkers(type) {
  HapNav.nearbyMarkers = HapNav.nearbyMarkers.filter(m => {
    if (m._hapnavType === type) {
      m.remove();
      return false;
    }
    return true;
  });
}

function refreshNearbyList() {
  const list = document.getElementById('nearby-list');
  list.innerHTML = '';

  if (!HapNav.nearbyMarkers.length) {
    list.innerHTML = '<li class="nearby-empty">Select a category to find nearby places around your location.</li>';
    return;
  }

  HapNav.nearbyMarkers.slice(0, 20).forEach(marker => {
    const { name, lat, lon, type } = marker._hapnavData;
    const def = NEARBY_QUERIES[type];
    const dist = HapNav.currentPosition
      ? haversineDistance(HapNav.currentPosition.lat, HapNav.currentPosition.lng, lat, lon)
      : 0;

    const li = document.createElement('li');
    li.className = 'nearby-item';
    li.innerHTML = `
      <span class="nearby-item-name">${def.icon} ${escapeHtml(name)}</span>
      <span class="nearby-item-meta">${def.label} · ${formatDistance(dist)} away</span>
    `;
    li.addEventListener('click', () => {
      setFollowRider(false);
      HapNav.map.setView([lat, lon], 16);
      marker.openPopup();
    });
    list.appendChild(li);
  });
}

/* =========================================================
   ROUTE SHARING
   ========================================================= */
async function shareRoute() {
  if (!HapNav.originCoords || !HapNav.destCoords) {
    showToast('Calculate a route first to share it.', 'warning');
    return;
  }

  const o = HapNav.originCoords, d = HapNav.destCoords;
  const url = `https://www.openstreetmap.org/directions?engine=osrm_car&route=${o.lat},${o.lng};${d.lat},${d.lng}`;
  const text = `My route on HapNav: ${o.label || 'Origin'} → ${d.label || 'Destination'}`;

  if (navigator.share) {
    try {
      await navigator.share({ title: 'HapNav Route', text, url });
      showToast('Route shared', 'success', 2000);
    } catch (err) {
      if (err.name !== 'AbortError') showToast('Sharing cancelled or failed.', 'info', 2000);
    }
  } else {
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      showToast('Route link copied to clipboard', 'success', 2500);
    } catch (e) {
      showToast('Could not share or copy route link.', 'danger');
    }
  }
}

/* =========================================================
   PWA — SERVICE WORKER REGISTRATION
   ========================================================= */
function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.warn('Service worker registration failed:', err);
    });
  }
}

/* =========================================================
   ADVANCED NAVIGATION FEATURES (Multi-stop, Favorites, 3D)
   ========================================================= */
function addWaypointInput(initialCoords = null) {
  const container = document.getElementById('waypoints-container');
  const wpId = ++HapNav.waypointSeq;
  HapNav.waypoints.push({ id: wpId, coords: initialCoords });

  const block = document.createElement('div');
  block.className = 'waypoint-block';
  block.id = `wp-row-${wpId}`;

  const suggId = `wp-suggestions-${wpId}`;
  block.innerHTML = `
    <div class="input-icon-row">
      <span class="input-icon" style="background:var(--warning); box-shadow:0 0 6px var(--warning);"></span>
      <input type="text" class="text-input" placeholder="Add stop…" autocomplete="off" aria-label="Waypoint" id="wp-input-${wpId}" />
      <button class="ghost-btn" type="button" data-tip="Remove">×</button>
    </div>
    <ul class="suggestions" id="${suggId}" role="listbox" hidden></ul>
  `;
  container.appendChild(block);

  const input = block.querySelector('input');
  const removeBtn = block.querySelector('button');
  if (initialCoords) {
    input.value = initialCoords.label.split(',')[0];
  }

  input.addEventListener('input', () => {
    handleAddressInput(input, suggId, 'waypoint', wpId);
  });

  removeBtn.addEventListener('click', () => removeWaypoint(wpId, block));
}

function removeWaypoint(wpId, el) {
  HapNav.waypoints = HapNav.waypoints.filter(w => w.id !== wpId);
  if (el) el.remove();
  placeWaypointMarkers();
}

function renderAltRoutes() {
  const container = document.getElementById('alt-routes');
  container.innerHTML = '';
  if (HapNav.altRoutes.length <= 1) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  HapNav.altRoutes.forEach((route, index) => {
    const btn = document.createElement('button');
    btn.className = `alt-route-tab ${index === 0 ? 'active' : ''}`;
    btn.innerHTML = `Route ${index + 1}<br><span style="font-size:0.65rem;font-weight:normal">${formatDuration(route.duration)} · ${formatDistance(route.distance)}</span>`;
    btn.onclick = () => selectAltRoute(index, btn);
    container.appendChild(btn);
  });
}

function selectAltRoute(index, btnEl) {
  document.querySelectorAll('.alt-route-tab').forEach(b => b.classList.remove('active'));
  btnEl.classList.add('active');
  applySelectedRoute(HapNav.altRoutes[index]);
}

function toggle3DPitch() {
  const mapEl = document.getElementById('map');
  mapEl.classList.toggle('map-3d-pitch');
  const is3D = mapEl.classList.contains('map-3d-pitch');

  if (HapNav.currentLocationMarker) {
    HapNav.map.panTo(HapNav.currentLocationMarker.getLatLng(), { animate: true });
  }
  showToast(is3D ? '3D Pitch Enabled' : '3D Pitch Disabled', 'info');
}

function saveCurrentRouteToFavorites() {
  if (!HapNav.originCoords || !HapNav.destCoords) {
    showToast('Plan a route first before saving.', 'warning');
    return;
  }
  const name = prompt('Enter a name for this route (e.g., Home to Work):', 'My Route');
  if (!name) return;

  const routeObj = {
    id: Date.now(),
    name,
    origin: HapNav.originCoords,
    dest: HapNav.destCoords,
    waypoints: HapNav.waypoints.filter(w => w.coords !== null).map(w => w.coords)
  };

  HapNav.favorites.push(routeObj);
  localStorage.setItem('hapnav_favorites', JSON.stringify(HapNav.favorites));
  renderFavoritesList();
  showToast('Route saved to favorites', 'success');
}

function loadFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem('hapnav_favorites') || '[]');
    HapNav.favorites = saved;
    renderFavoritesList();
  } catch (e) { /* ignore */ }
}

function renderFavoritesList() {
  const ul = document.getElementById('favorites-list');
  if (!ul) return;
  ul.innerHTML = '';

  if (!HapNav.favorites.length) {
    ul.innerHTML = '<li class="favorites-empty" style="font-size:0.8rem; color:var(--text-faint);">No saved routes yet.</li>';
    return;
  }

  HapNav.favorites.forEach(fav => {
    const li = document.createElement('li');
    li.className = 'favorite-item';
    li.innerHTML = `
      <div onclick="loadFavoriteRoute(${fav.id})" style="flex:1">
        <div class="favorite-item-title">${escapeHtml(fav.name)}</div>
        <div class="favorite-item-desc">${escapeHtml(fav.origin.label.split(',')[0])} → ${escapeHtml(fav.dest.label.split(',')[0])}</div>
      </div>
      <button class="favorite-delete" onclick="deleteFavoriteRoute(${fav.id})">×</button>
    `;
    ul.appendChild(li);
  });
}

function loadFavoriteRoute(id) {
  const fav = HapNav.favorites.find(f => f.id === id);
  if (!fav) return;

  document.getElementById('waypoints-container').innerHTML = '';
  HapNav.waypoints = [];

  selectAddress(fav.origin, 'origin');
  selectAddress(fav.dest, 'destination');

  if (fav.waypoints && fav.waypoints.length > 0) {
    fav.waypoints.forEach(wpCoords => {
      if (wpCoords) addWaypointInput(wpCoords);
    });
    placeWaypointMarkers();
  }

  showToast(`Loaded ${fav.name}`, 'info');
  findRoute();
}

function deleteFavoriteRoute(id) {
  HapNav.favorites = HapNav.favorites.filter(f => f.id !== id);
  localStorage.setItem('hapnav_favorites', JSON.stringify(HapNav.favorites));
  renderFavoritesList();
}
