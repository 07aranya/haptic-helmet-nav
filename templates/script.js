/* =========================================================
   HapNav V2 — Smart Haptic Navigation System
   script.js — Application Logic
   ========================================================= */

'use strict';

/* =========================================================
   GLOBAL STATE
   ========================================================= */
const HapNav = {
  map: null,
  tileLayer: null,

  // Markers / layers
  currentLocationMarker: null,
  currentLocationCircle: null,
  originMarker: null,
  destMarker: null,
  routeLine: null,
  routeShadowLine: null,
  turnMarkers: [],
  nearbyMarkers: [],
  simMarker: null,

  // Coordinates
  originCoords: null,      // {lat, lng, label}
  destCoords: null,        // {lat, lng, label}
  currentPosition: null,   // {lat, lng, accuracy, heading, speed}

  // Route data
  route: null,             // OSRM route object
  routeSteps: [],          // flattened steps with coords
  currentStepIndex: 0,

  // Navigation state
  isNavigating: false,
  isSimulating: false,
  simInterval: null,
  simProgressIndex: 0,
  simRouteCoords: [],

  watchId: null,

  // BLE
  bleDevice: null,
  bleCharacteristic: null,
  bleServer: null,

  // Settings
  settings: {
    voice: true,
    haptic: true,
    units: 'metric',
    theme: 'dark'
  },

  // Voice
  speechMuted: false,
  lastSpokenInstruction: null,

  // Misc
  lastHapticCommand: null,
  offRouteWarningActive: false,
  searchDebounce: null
};

/* =========================================================
   CONSTANTS
   ========================================================= */
const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const OVERPASS_BASE = 'https://overpass-api.de/api/interpreter';

const HAPTIC_COMMANDS = {
  SLIGHT_LEFT: 0x01,
  SLIGHT_RIGHT: 0x02,
  LEFT: 0x11,
  RIGHT: 0x12,
  SHARP_LEFT: 0x21,
  SHARP_RIGHT: 0x22,
  UTURN: 0x30,
  STRAIGHT: 0x00,      // No buzz necessary
  ARRIVED: 0xA0,
  REROUTE: 0xB0
};

// Web Bluetooth — Nordic UART-like service used as a generic example
// for a custom "HapticHelmet" ESP32 peripheral.
const BLE_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const BLE_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

// BLE Write Queue to prevent GATT overlaps and ensure real-time delivery
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
    'Preparing haptic interface…',
    'Ready.'
  ];
  let i = 0;
  const interval = setInterval(() => {
    if (statusEl) statusEl.textContent = steps[i] || 'Ready.';
    i++;
    if (i >= steps.length) {
      clearInterval(interval);
      setTimeout(boot, 400);
    }
  }, 380);
}

function boot() {
  const loadingScreen = document.getElementById('loading-screen');
  const app = document.getElementById('app');

  // Step 1 — Make #app visible BEFORE Leaflet touches the DOM.
  // We use visibility:hidden (not display:none) so the map container
  // has real pixel dimensions when Leaflet reads them.
  app.classList.remove('hidden');

  // Forces Leaflet to stretch to full screen right after visibility changes
  if (HapNav && HapNav.map) {
    setTimeout(() => {
      HapNav.map.invalidateSize();
    }, 250); // Gives the browser 250ms to render the layout before recalculating map size
  }

  // Step 2 — Wait TWO animation frames so the browser has fully
  // computed layout (grid rows/columns, sidebar width, topbar height)
  // before we create the Leaflet map instance.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      initMap();
      initEventListeners();
      initServiceWorker();
      loadSettingsFromState();
      checkNetworkStatus();
      initKeyboardShortcuts();

      // Step 3 — Fade out loading screen
      loadingScreen.classList.add('fade-out');
      setTimeout(() => loadingScreen.classList.add('hidden'), 650);

      // Step 4 — Force Leaflet to re-measure its container after the
      // loading screen is gone (layout may shift slightly).
      setTimeout(() => {
        if (HapNav.map) {
          HapNav.map.invalidateSize(true);
        }
      }, 700);

      // Step 5 — GPS fix (non-blocking)
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
  }).setView([20.5937, 78.9629], 5); // Default: India centroid

  HapNav.tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(HapNav.map);

  // Try to recover a cached "last view" for offline-first feel
  try {
    const cached = JSON.parse(localStorage.getItem('hapnav_last_view') || 'null');
    if (cached && cached.lat && cached.lng) {
      HapNav.map.setView([cached.lat, cached.lng], cached.zoom || 13);
    }
  } catch (e) { /* ignore */ }

  // Keep map sized correctly whenever the window or sidebar changes.
  const refreshMapSize = () => {
    if (!HapNav.map) return;
    HapNav.map.invalidateSize(true);
  };
  window.addEventListener('resize', refreshMapSize);
  window.addEventListener('orientationchange', refreshMapSize);

  // ResizeObserver watches the actual map div — fires whenever the
  // grid cell resizes (sidebar toggle, window resize, etc.)
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(refreshMapSize).observe(document.getElementById('map'));
  }

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
  // Menu toggle (mobile sidebar)
  document.getElementById('menu-toggle').addEventListener('click', toggleSidebar);

  // Theme toggle
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
      hideSuggestions('origin-suggestions');
      hideSuggestions('destination-suggestions');
    }
  });

  // Current location button
  document.getElementById('use-current-location').addEventListener('click', () => {
    detectCurrentLocation({ silent: false, center: true, fillOrigin: true });
  });

  // Swap
  document.getElementById('swap-locations').addEventListener('click', swapOriginDestination);

  // Route actions
  document.getElementById('find-route-btn').addEventListener('click', findRoute);
  document.getElementById('clear-route-btn').addEventListener('click', clearRoute);

  // Navigation controls
  document.getElementById('start-navigation-btn').addEventListener('click', startNavigation);
  document.getElementById('stop-navigation-btn').addEventListener('click', stopNavigation);
  document.getElementById('simulate-btn').addEventListener('click', startSimulation);
  document.getElementById('sim-stop-btn').addEventListener('click', stopSimulation);

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

  // Units segmented control
  document.querySelectorAll('#units-segmented .segment').forEach(btn => {
    btn.addEventListener('click', () => setUnits(btn.dataset.unit));
  });

  // Share route
  document.getElementById('share-route-btn').addEventListener('click', shareRoute);

  // Network status
  window.addEventListener('online', checkNetworkStatus);
  window.addEventListener('offline', checkNetworkStatus);
}

/* =========================================================
   KEYBOARD SHORTCUTS
   ========================================================= */
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts while typing
    const tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
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
   UI HELPERS — TOASTS, MODALS, SIDEBAR
   ========================================================= */
function showToast(message, type = 'info', duration = 3800) {
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

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('menu-toggle');
  const isOpen = sidebar.classList.toggle('open');
  btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  // Sidebar toggling changes the map cell width — tell Leaflet
  setTimeout(() => HapNav.map && HapNav.map.invalidateSize(true), 320);
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

  // Apply theme
  if (HapNav.settings.theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  }

  // Apply toggles
  setToggleState('voice-toggle', HapNav.settings.voice);
  setToggleState('haptic-toggle', HapNav.settings.haptic);
  HapNav.speechMuted = !HapNav.settings.voice;
  updateMuteIcon();

  // Units
  document.querySelectorAll('#units-segmented .segment').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === HapNav.settings.units);
  });
}

function setToggleState(id, value) {
  const el = document.getElementById(id);
  el.setAttribute('aria-checked', value ? 'true' : 'false');
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
  showToast(`${key === 'voice' ? 'Voice guidance' : 'Haptic feedback'} ${newVal ? 'enabled' : 'disabled'}`, 'info', 2000);
}

function setUnits(unit) {
  HapNav.settings.units = unit;
  document.querySelectorAll('#units-segmented .segment').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === unit);
  });
  persistSettings();
  // Refresh displayed values if a route exists
  if (HapNav.route) updateRouteSummary(HapNav.route);
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
      HapNav.currentPosition = { lat: latitude, lng: longitude, accuracy, heading, speed };

      placeCurrentLocationMarker(latitude, longitude, accuracy, heading);

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

function placeCurrentLocationMarker(lat, lng, accuracy = 0, heading = null) {
  const icon = L.divIcon({
    className: '',
    html: '<div class="pulse-marker"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });

  if (!HapNav.currentLocationMarker) {
    HapNav.currentLocationMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(HapNav.map);
  } else {
    HapNav.currentLocationMarker.setLatLng([lat, lng]);
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
    (err) => {
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
  HapNav.currentPosition = { lat: latitude, lng: longitude, accuracy, heading, speed };

  placeCurrentLocationMarker(latitude, longitude, accuracy, heading);
  setGpsStatus('active', 'Active');

  if (HapNav.isNavigating) {
    HapNav.map.setView([latitude, longitude], HapNav.map.getZoom(), { animate: true });
    updateLiveNavStats(latitude, longitude, speed);
    checkRouteDeviation(latitude, longitude);
    updateTurnInstructionFromPosition(latitude, longitude);
  }
}

function updateLiveNavStats(lat, lng, speed) {
  // Speed
  const speedKmh = speed != null && speed >= 0 ? (speed * 3.6) : 0;
  const speedDisplay = formatSpeed(speedKmh);
  document.getElementById('widget-speed').textContent = speedDisplay;
  document.getElementById('nbb-speed').textContent = speedDisplay;

  // Remaining distance along route (approx: distance to end via nearest point)
  if (HapNav.route) {
    const remaining = remainingRouteDistance(lat, lng);
    const distDisplay = formatDistance(remaining);
    document.getElementById('widget-distance').textContent = distDisplay;
    document.getElementById('nbb-distance').textContent = distDisplay;

    // ETA based on remaining distance & average speed (fallback to route average)
    const avgSpeedMs = speed && speed > 0.5 ? speed : (HapNav.route.distance / HapNav.route.duration);
    const remainingSeconds = avgSpeedMs > 0 ? remaining / avgSpeedMs : HapNav.route.duration;
    const eta = formatETA(remainingSeconds);
    document.getElementById('widget-eta').textContent = eta;
    document.getElementById('nbb-eta').textContent = eta;

    // Progress
    const progressPct = Math.min(100, Math.max(0, 100 * (1 - remaining / HapNav.route.distance)));
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
function handleAddressInput(inputEl, suggestionsId, role) {
  const query = inputEl.value.trim();
  clearTimeout(HapNav.searchDebounce);

  if (query.length < 3) {
    hideSuggestions(suggestionsId);
    return;
  }

  HapNav.searchDebounce = setTimeout(() => {
    fetchAddressSuggestions(query, suggestionsId, role);
  }, 400);
}

async function fetchAddressSuggestions(query, suggestionsId, role) {
  try {
    const url = `${NOMINATIM_BASE}/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=6&addressdetails=1`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error(`Nominatim error: ${res.status}`);
    const data = await res.json();
    renderSuggestions(data, suggestionsId, role);
  } catch (err) {
    console.error(err);
    showToast('Address search failed. Check your connection.', 'danger', 2500);
    hideSuggestions(suggestionsId);
  }
}

function renderSuggestions(results, suggestionsId, role) {
  const ul = document.getElementById(suggestionsId);
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
      }, role);
      hideSuggestions(suggestionsId);
    });
    ul.appendChild(li);
  });

  ul.hidden = false;
}

function hideSuggestions(id) {
  const ul = document.getElementById(id);
  ul.hidden = true;
  ul.innerHTML = '';
}

function selectAddress(coords, role) {
  if (role === 'origin') {
    HapNav.originCoords = coords;
    document.getElementById('origin-input').value = coords.label.split(',')[0];
    placeOriginMarker(coords.lat, coords.lng);
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
   MARKERS — ORIGIN / DESTINATION
   ========================================================= */
function placeOriginMarker(lat, lng) {
  const icon = L.divIcon({
    className: '',
    html: '<div style="width:16px;height:16px;border-radius:50%;background:#00E5A0;border:3px solid #0A0E17;box-shadow:0 0 10px #00E5A0;"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
  if (HapNav.originMarker) HapNav.originMarker.remove();
  HapNav.originMarker = L.marker([lat, lng], { icon, zIndexOffset: 800 }).addTo(HapNav.map);
}

function placeDestMarker(lat, lng) {
  const icon = L.divIcon({
    className: '',
    html: '<div style="width:16px;height:16px;border-radius:50%;background:#FF4D6D;border:3px solid #0A0E17;box-shadow:0 0 10px #FF4D6D;"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
  if (HapNav.destMarker) HapNav.destMarker.remove();
  HapNav.destMarker = L.marker([lat, lng], { icon, zIndexOffset: 800 }).addTo(HapNav.map);
}

function fitMapToMarkers() {
  const points = [];
  if (HapNav.originMarker) points.push(HapNav.originMarker.getLatLng());
  if (HapNav.destMarker) points.push(HapNav.destMarker.getLatLng());
  if (points.length === 2) {
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
    const o = HapNav.originCoords, d = HapNav.destCoords;
    const url = `${OSRM_BASE}/${o.lng},${o.lat};${d.lng},${d.lat}?overview=full&geometries=geojson&steps=true&annotations=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM error: ${res.status}`);
    const data = await res.json();

    if (data.code !== 'Ok' || !data.routes || !data.routes.length) {
      throw new Error('No route found');
    }

    const route = data.routes[0];
    HapNav.route = route;
    renderRoute(route);
    buildRouteSteps(route);
    updateRouteSummary(route);
    placeTurnMarkers();

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

function renderRoute(route) {
  const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);

  if (HapNav.routeLine) HapNav.routeLine.remove();
  if (HapNav.routeShadowLine) HapNav.routeShadowLine.remove();

  // Shadow/glow line beneath main line
  HapNav.routeShadowLine = L.polyline(latlngs, {
    color: '#007BFF',
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

  const leg = route.legs[0];
  leg.steps.forEach(step => {
    const maneuver = step.maneuver;
    const coords = step.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    HapNav.routeSteps.push({
      type: maneuver.type,
      modifier: maneuver.modifier || 'straight',
      instruction: buildInstructionText(maneuver, step.name),
      location: [maneuver.location[1], maneuver.location[0]],
      distance: step.distance,
      coords,
      hapticSent: false,
      voiceNearSent: false,
      voiceSoonSent: false
    });
  });

  // Skip "depart" step so navigation doesn't get stuck if starting >25m from origin
  if (HapNav.routeSteps.length > 1) {
    HapNav.currentStepIndex = 1;
  }
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
    case 'continue':
      return `Continue straight${name}`;
    case 'merge':
      return `Merge${name}`;
    case 'roundabout':
    case 'rotary':
      return `Enter the roundabout${name}`;
    case 'fork':
      return `Take the ${maneuver.modifier} fork${name}`;
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
  const distance = route.distance; // meters
  const duration = route.duration; // seconds

  document.getElementById('summary-distance').textContent = formatDistance(distance);
  document.getElementById('summary-duration').textContent = formatDuration(duration);
  document.getElementById('summary-eta').textContent = formatETA(duration);
  document.getElementById('summary-turns').textContent = HapNav.routeSteps.length
    ? (HapNav.routeSteps.length - 1)
    : route.legs[0].steps.length - 1;

  document.getElementById('widget-distance').textContent = formatDistance(distance);
  document.getElementById('widget-eta').textContent = formatETA(duration);
}

function formatDistance(meters) {
  if (HapNav.settings.units === 'imperial') {
    const miles = meters / 1609.34;
    return miles < 0.5 ? `${(meters * 3.28084).toFixed(0)} ft` : `${miles.toFixed(1)} mi`;
  }
  return meters < 1000 ? `${meters.toFixed(0)} m` : `${(meters / 1000).toFixed(1)} km`;
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
   TURN MARKERS
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

    const marker = L.marker(step.location, { icon: divIcon, zIndexOffset: 500 })
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

/* =========================================================
   CLEAR ROUTE
   ========================================================= */
function clearRoute() {
  if (HapNav.routeLine) { HapNav.routeLine.remove(); HapNav.routeLine = null; }
  if (HapNav.routeShadowLine) { HapNav.routeShadowLine.remove(); HapNav.routeShadowLine = null; }
  if (HapNav.originMarker) { HapNav.originMarker.remove(); HapNav.originMarker = null; }
  if (HapNav.destMarker) { HapNav.destMarker.remove(); HapNav.destMarker = null; }
  clearTurnMarkers();

  HapNav.route = null;
  HapNav.routeSteps = [];
  HapNav.originCoords = null;
  HapNav.destCoords = null;

  document.getElementById('origin-input').value = '';
  document.getElementById('destination-input').value = '';
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

  HapNav.isNavigating = true;
  if (HapNav.routeSteps.length > 1) HapNav.currentStepIndex = 1;
  HapNav.routeSteps.forEach(s => s.hapticSent = false);
  HapNav.lastSpokenInstruction = null;
  HapNav.offRouteWarningActive = false;

  document.getElementById('turn-card').classList.remove('hidden');
  document.getElementById('nav-bottombar').classList.remove('hidden');
  setNavStatus('Navigating');

  startLiveTracking();
  announceCurrentStep(true);

  showToast('Navigation started', 'success');
}

function stopNavigation() {
  if (!HapNav.isNavigating) return;
  HapNav.isNavigating = false;
  stopLiveTracking();

  document.getElementById('turn-card').classList.add('hidden');
  document.getElementById('nav-bottombar').classList.add('hidden');
  document.getElementById('offroute-banner').classList.add('hidden');

  setNavStatus('Idle');
  showToast('Navigation ended', 'info', 2000);
}

function setNavStatus(text) {
  document.getElementById('widget-nav').textContent = text;
}

/* =========================================================
   TURN-BY-TURN LOGIC (live & simulated)
   ========================================================= */
function announceCurrentStep(force = false) {
  const step = HapNav.routeSteps[HapNav.currentStepIndex];
  if (!step) return;

  const icon = TURN_ICONS[step.modifier] || TURN_ICONS[step.type] || TURN_ICONS.default;
  document.getElementById('turn-icon').textContent = icon;
  document.getElementById('turn-instruction').textContent = step.instruction;
  document.getElementById('turn-distance').textContent = formatDistance(step.distance);

  if (force || HapNav.lastSpokenInstruction !== step.instruction) {
    speak(buildVoiceInstruction(step));
    HapNav.lastSpokenInstruction = step.instruction;
        // REMOVED sendHapticForStep(step) from here! 
        // We only want it to trigger exactly at the 80m mark, not when the step starts.
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
    default:
      if (step.modifier === 'left') return `Turn left in ${distText}`;
      if (step.modifier === 'right') return `Turn right in ${distText}`;
      if (step.modifier === 'slight left') return `Slight left in ${distText}`;
      if (step.modifier === 'slight right') return `Slight right in ${distText}`;
      if (step.modifier === 'uturn') return `Make a U-turn in ${distText}`;
      if (step.type === 'roundabout' || step.type === 'rotary') return `Enter the roundabout in ${distText}`;
      return `Continue straight for ${distText}`;
  }
}

function sendHapticForStep(step) {
  if (!HapNav.settings.haptic) return;

  let cmd = HAPTIC_COMMANDS.STRAIGHT; // Default (no buzz)
  if (step.modifier === 'sharp left') cmd = HAPTIC_COMMANDS.SHARP_LEFT;
  else if (step.modifier === 'sharp right') cmd = HAPTIC_COMMANDS.SHARP_RIGHT;
  else if (step.modifier === 'slight left') cmd = HAPTIC_COMMANDS.SLIGHT_LEFT;
  else if (step.modifier === 'slight right') cmd = HAPTIC_COMMANDS.SLIGHT_RIGHT;
  else if (step.modifier === 'left') cmd = HAPTIC_COMMANDS.LEFT;
  else if (step.modifier === 'right') cmd = HAPTIC_COMMANDS.RIGHT;
  else if (step.modifier === 'uturn') cmd = HAPTIC_COMMANDS.UTURN;

  // Only send a command to the helmet if an actual action is required
  if (cmd !== HAPTIC_COMMANDS.STRAIGHT) {
    sendHapticCommand(cmd);
  }
}

/* Advance turn-by-turn based on a moving point (live GPS or simulation) */
function updateTurnInstructionFromPosition(lat, lng) {
  const step = HapNav.routeSteps[HapNav.currentStepIndex];
  if (!step) return;

  const distToManeuver = haversineDistance(lat, lng, step.location[0], step.location[1]);
  document.getElementById('turn-distance').textContent = formatDistance(distToManeuver);

  // Voice cues at thresholds
  if (distToManeuver <= 110 && !step.voiceNearSent) {
    step.voiceNearSent = true;
    speak(buildVoiceInstruction({ ...step, distance: 100 }));
  }

  // Exact 80m Haptic trigger
  if (distToManeuver <= 80 && !step.hapticSent) {
    step.hapticSent = true;
    sendHapticForStep(step);
  }

  if (distToManeuver <= 50 && !step.voiceSoonSent) {
    step.voiceSoonSent = true;
    speak(buildVoiceInstruction({ ...step, distance: 50 }));
  }

  // Advance to next step
  if (distToManeuver < 25) {
    if (step.type === 'arrive') {
      finishNavigation();
      return;
    }
    HapNav.currentStepIndex = Math.min(HapNav.currentStepIndex + 1, HapNav.routeSteps.length - 1);
    HapNav.lastSpokenInstruction = null;
    announceCurrentStep(true);
  }
}

function finishNavigation() {
  speak('You have arrived at your destination.');
  sendHapticCommand(HAPTIC_COMMANDS.ARRIVED);
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
    if (!HapNav.offRouteWarningActive) {
      HapNav.offRouteWarningActive = true;
      banner.classList.remove('hidden');
      speak('Recalculating route');
      showToast('You are off route. Recalculating…', 'warning');
      sendHapticCommand(HAPTIC_COMMANDS.REROUTE); // Triggers the Wave Sweep
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

    const d = HapNav.destCoords;
    const url = `${OSRM_BASE}/${lng},${lat};${d.lng},${d.lat}?overview=full&geometries=geojson&steps=true&annotations=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('OSRM error');
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes.length) throw new Error('No route');

    const route = data.routes[0];
    HapNav.route = route;
    renderRoute(route);
    buildRouteSteps(route);
    updateRouteSummary(route);
    placeTurnMarkers();

    HapNav.currentStepIndex = 0;
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

function distanceToPolyline(lat, lng, latlngs) {
  let min = Infinity;
  for (let i = 0; i < latlngs.length - 1; i++) {
    const d = distanceToSegment(lat, lng, latlngs[i].lat, latlngs[i].lng, latlngs[i + 1].lat, latlngs[i + 1].lng);
    if (d < min) min = d;
  }
  return min;
}

function distanceToSegment(lat, lng, lat1, lng1, lat2, lng2) {
  // Approximate using equirectangular projection for short segments
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
  const coords = HapNav.route.geometry.coordinates; // [lng, lat]

  // Find nearest segment index
  let nearestIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const d = distanceToSegment(lat, lng, coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
    if (d < minDist) { minDist = d; nearestIdx = i; }
  }

  // Sum distances from nearest point to end
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

  HapNav.isSimulating = true;
  HapNav.simRouteCoords = HapNav.route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  HapNav.simProgressIndex = 0;
  if (HapNav.routeSteps.length > 1) HapNav.currentStepIndex = 1;
  HapNav.routeSteps.forEach(s => s.hapticSent = false);
  HapNav.lastSpokenInstruction = null;

  document.getElementById('sim-bar').classList.remove('hidden');
  document.getElementById('turn-card').classList.remove('hidden');
  document.getElementById('nav-bottombar').classList.remove('hidden');
  setNavStatus('Simulating');

  const icon = L.divIcon({
    className: '',
    html: '<div class="sim-marker"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });
  if (HapNav.simMarker) HapNav.simMarker.remove();
  HapNav.simMarker = L.marker(HapNav.simRouteCoords[0], { icon, zIndexOffset: 900 }).addTo(HapNav.map);

  announceCurrentStep(true);

  const totalPoints = HapNav.simRouteCoords.length;
  
  // Slow down simulation to prevent flooding the ESP32 Bluetooth command queue.
  // Targets ~45-60 seconds total, moving at a realistic pace (800ms - 2000ms per step).
  const stepIntervalMs = Math.max(800, Math.min(2000, 60000 / totalPoints));

  HapNav.simInterval = setInterval(() => {
    HapNav.simProgressIndex++;

    if (HapNav.simProgressIndex >= totalPoints) {
      finishNavigation();
      return;
    }

    const [lat, lng] = HapNav.simRouteCoords[HapNav.simProgressIndex];
    HapNav.simMarker.setLatLng([lat, lng]);
    HapNav.map.panTo([lat, lng], { animate: true });

    const pct = (HapNav.simProgressIndex / (totalPoints - 1)) * 100;
    document.getElementById('sim-progress-fill').style.width = `${pct}%`;
    document.getElementById('sim-progress-text').textContent = `${pct.toFixed(0)}%`;
    setProgress(pct);

    // Simulated speed (assume ~40 km/h average)
    const simSpeedKmh = 40 + Math.sin(HapNav.simProgressIndex / 6) * 10;
    document.getElementById('widget-speed').textContent = formatSpeed(Math.max(0, simSpeedKmh));
    document.getElementById('nbb-speed').textContent = formatSpeed(Math.max(0, simSpeedKmh));

    const remaining = HapNav.route.distance * (1 - pct / 100);
    document.getElementById('widget-distance').textContent = formatDistance(remaining);
    document.getElementById('nbb-distance').textContent = formatDistance(remaining);

    const remainingSeconds = HapNav.route.duration * (1 - pct / 100);
    document.getElementById('widget-eta').textContent = formatETA(remainingSeconds);
    document.getElementById('nbb-eta').textContent = formatETA(remainingSeconds);

    updateTurnInstructionFromPosition(lat, lng);
  }, stepIntervalMs);

  showToast('Simulation started', 'info', 2000);
}

function stopSimulation() {
  if (!HapNav.isSimulating) return;
  HapNav.isSimulating = false;

  clearInterval(HapNav.simInterval);
  HapNav.simInterval = null;

  if (HapNav.simMarker) { HapNav.simMarker.remove(); HapNav.simMarker = null; }

  document.getElementById('sim-bar').classList.add('hidden');
  document.getElementById('sim-progress-fill').style.width = '0%';
  document.getElementById('sim-progress-text').textContent = '0%';

  if (!HapNav.isNavigating) {
    document.getElementById('turn-card').classList.add('hidden');
    document.getElementById('nav-bottombar').classList.add('hidden');
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
  if (HapNav.speechMuted) {
    icon.innerHTML = '<path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor"/><line x1="23" y1="9" x2="17" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="17" y1="9" x2="23" y2="15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
    btn.dataset.tip = 'Unmute voice';
  } else {
    icon.innerHTML = '<path d="M11 5L6 9H2v6h4l5 4V5z" fill="currentColor"/><path d="M16 8a5 5 0 010 8M19 5a8 8 0 010 14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>';
    btn.dataset.tip = 'Mute voice';
  }
}

/* =========================================================
   HAPTIC HELMET — Web Bluetooth
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
  processBleQueue(); // Process next command instantly
}

async function sendHapticCommand(cmd, isTest = false) {
  if (!HapNav.settings.haptic && !isTest) return;

  HapNav.lastHapticCommand = cmd;

  if (!HapNav.bleCharacteristic) {
    if (isTest) showToast('Connect the HapticHelmet first.', 'warning');
    return;
  }

  // Queue the command to guarantee sequential execution and prevent GATT dropouts
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
    (err) => {
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
    // Give it a brief moment
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
      HapNav.map.setView([lat, lon], 16);
      marker.openPopup();
    });
    list.appendChild(li);
  });
}

/* =========================================================
   AI OBSTACLE DETECTION — INTEGRATION HOOKS


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