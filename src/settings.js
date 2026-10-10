// Every tunable number lives here (spec section 14). User-changeable values persist
// in localStorage when it is available; the app works the same without it.

const STORAGE_KEY = 'landnav.settings.v1';

export const DEFAULTS = Object.freeze({
  // Pace and movement (spec section 6)
  paceCountPer100m: 65,
  baseSpeed: 1.3,             // m/s on flat ground
  timeScale: 1,               // 1, 2 or 3
  slopeEffects: true,
  toblerK: 3.5,
  toblerOffset: 0.05,
  strideUphill: 0.8,
  strideDownhill: 0.4,
  strideMin: 0.6,
  eyeHeight: 1.7,             // m, desktop walk mode (VR uses the headset's real height)
  snapTurn: false,
  snapTurnDeg: 30,
  vignette: 0.5,

  // World
  preset: 'open',             // 'woods' | 'open'
  woodsVisibility: 150,       // m
  boundaryWarn: 50,           // m from the edge
  stakeVisibility: 40,        // m

  // Tools
  units: 'deg',               // 'deg' | 'mils'
  assisted: false,
  compassTiltLimit: 15,       // degrees; dial sticks beyond this
  compassTiltSticks: true,

  // Desktop
  mouseSensitivity: 0.0022,   // rad per pixel
  flySpeed: 40,               // m/s
  flyFastMultiplier: 5,
});

function storage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__landnav_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function loadSettings() {
  const out = { ...DEFAULTS };
  const s = storage();
  if (!s) return out;
  try {
    const saved = JSON.parse(s.getItem(STORAGE_KEY) || '{}');
    for (const k of Object.keys(DEFAULTS)) {
      if (k in saved && typeof saved[k] === typeof DEFAULTS[k]) out[k] = saved[k];
    }
  } catch {
    // Corrupt or unreadable settings: fall back to defaults.
  }
  return out;
}

export function saveSettings(settings) {
  const s = storage();
  if (!s) return false;
  try {
    const diff = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (settings[k] !== DEFAULTS[k]) diff[k] = settings[k];
    }
    s.setItem(STORAGE_KEY, JSON.stringify(diff));
    return true;
  } catch {
    return false;
  }
}

export function paceLength(settings) {
  return 100 / settings.paceCountPer100m;
}
