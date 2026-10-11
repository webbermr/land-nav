// Every tunable number lives here (spec section 14). User-changeable values persist
// in localStorage when it is available; the app works the same without it.

const STORAGE_KEY = 'landnav.settings.v1';

export const DEFAULTS = Object.freeze({
  // Pace and movement (spec section 6)
  paceCountPer100m: 65,
  baseSpeed: 1.3,             // m/s on flat ground
  jogPaceCountPer100m: 52,    // longer strides when jogging, so fewer paces
  jogSpeed: 2.7,              // m/s on flat ground, about a 10-minute mile
  jogMaxGrade: 0.25,          // steeper than this, up or down, and you walk
  timeScale: 1,               // 1, 2 or 3
  slopeEffects: true,
  toblerK: 3.5,
  toblerOffset: 0.05,
  strideUphill: 0.8,
  strideDownhill: 0.4,
  strideMin: 0.6,
  eyeHeight: 1.7,             // m, desktop walk mode (VR uses the headset's real height)
  footfallVolume: 0.8,        // 0..1
  hapticStrength: 0.8,        // 0..1, left controller pulse per left footfall
  hapticMs: 45,
  stickDeadzone: 0.15,
  snapTurn: false,
  snapTurnDeg: 30,
  vignette: 0.5,

  // World
  preset: 'open',             // 'woods' | 'open'
  woodsVisibility: 150,       // m
  boundaryWarn: 50,           // m from the edge
  stakeVisibility: 40,        // m
  night: false,               // set per course or with N; not a saved preference
  nightVisibility: 60,        // m: tree silhouettes against the sky, no more
  nightStakeVisibility: 10,   // m
  vegetation: 'medium',       // 'off' | 'low' | 'medium' | 'high': how far trees are drawn
  collisions: true,           // trunks, logs, rocks and buildings block you (shrubs don't)
  collisionRadius: 0.25,      // m, the walker's body

  // Tools
  units: 'deg',               // 'deg' | 'mils'
  assisted: false,
  lostHelp: true,             // allow "show my position" (logged, shown on the score card)
  lostHelpSec: 15,            // how long the "you are here" mark stays on the map
  compassTiltLimit: 15,       // degrees; dial sticks beyond this
  compassTiltSticks: true,
  bezelRepeatSec: 0.18,       // hold the stick to keep clicking the bezel

  // Where the tools sit in the hands, metres and degrees. Tune on the headset.
  // Compass: in the right controller's pointing (target-ray) space, so its sighting
  // axis is where you point. Map: in the left controller's grip space.
  compassOffsetY: 0.03,
  compassOffsetZ: -0.07,
  mapOffsetY: 0.13,
  mapOffsetZ: -0.1,
  mapTiltDeg: 50,             // board tipped back toward you
  pencilRayLength: 0.6,
  eraseHoldSec: 0.6,          // hold the trigger on a dot this long to erase it

  // Desktop
  mouseSensitivity: 0.0022,   // rad per pixel
  flySpeed: 40,               // m/s
  flyFastMultiplier: 5,
});

export function storage() {
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
      if (!TRANSIENT.has(k) && k in saved && typeof saved[k] === typeof DEFAULTS[k]) out[k] = saved[k];
    }
  } catch {
    // Corrupt or unreadable settings: fall back to defaults.
  }
  return out;
}

// Set per course or per session, never remembered.
const TRANSIENT = new Set(['night']);

export function saveSettings(settings) {
  const s = storage();
  if (!s) return false;
  try {
    const diff = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (!TRANSIENT.has(k) && settings[k] !== DEFAULTS[k]) diff[k] = settings[k];
    }
    s.setItem(STORAGE_KEY, JSON.stringify(diff));
    return true;
  } catch {
    return false;
  }
}
