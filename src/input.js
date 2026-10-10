// Input for both modes (spec section 7.5).
//   DesktopInput: WASD, mouse look (pointer lock), tool keys.
//   XRInput: Quest controllers via the WebXR Gamepad "xr-standard" mapping.

// Key bindings. Codes are layout-independent (KeyW is W on QWERTY, Z on AZERTY).
export const DESKTOP_KEYS = Object.freeze({
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  flyUp: 'KeyR',
  flyDown: 'KeyF',
  fast: 'ShiftLeft',
  toggleFly: 'KeyV',
  togglePreset: 'KeyG',
  map: 'KeyM',
  compass: 'KeyC',
  bead: 'Space',
  punch: 'KeyE',
  scoreCard: 'Tab',
  help: 'KeyH',
});

export class DesktopInput {
  constructor(element, settings) {
    this.element = element;
    this.settings = settings;
    this.held = new Set();
    this.yaw = 0;   // radians, 0 looks grid north (-Z), positive turns left (Three.js convention)
    this.pitch = 0;
    this.locked = false;
    this.handlers = new Map();

    element.addEventListener('click', () => {
      if (!this.locked) element.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === element;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const k = this.settings.mouseSensitivity;
      this.yaw -= e.movementX * k;
      this.pitch -= e.movementY * k;
      const lim = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    });
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === DESKTOP_KEYS.scoreCard || e.code === DESKTOP_KEYS.bead) e.preventDefault();
      if (!this.held.has(e.code)) this.fire(e.code);
      this.held.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
  }

  // Register a one-shot action for a binding name in DESKTOP_KEYS.
  on(action, fn) {
    this.handlers.set(DESKTOP_KEYS[action], fn);
  }

  fire(code) {
    this.handlers.get(code)?.();
  }

  isDown(action) {
    const code = DESKTOP_KEYS[action];
    return this.held.has(code) || (action === 'fast' && this.held.has('ShiftRight'));
  }

  // Movement intent in camera-relative axes: x right, z forward. Not normalized.
  moveAxes() {
    return {
      x: (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0),
      z: (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0),
      y: (this.isDown('flyUp') ? 1 : 0) - (this.isDown('flyDown') ? 1 : 0),
    };
  }
}

// xr-standard button indices. A/B are on the right controller, X/Y on the left.
export const XR_BUTTONS = Object.freeze({
  trigger: 0,
  grip: 1,
  stick: 3,
  primary: 4,   // A (right) or X (left)
  secondary: 5, // B (right) or Y (left)
});

export class XRInput {
  constructor(renderer, settings) {
    this.renderer = renderer;
    this.settings = settings;
    this.sources = { left: null, right: null };
    this.prev = { left: [], right: [] };
    this.now = { left: [], right: [] };
  }

  // Call once per frame while presenting.
  update() {
    this.sources.left = null;
    this.sources.right = null;
    const session = this.renderer.xr.getSession();
    if (!session) return;
    for (const src of session.inputSources) {
      if (src.gamepad && (src.handedness === 'left' || src.handedness === 'right')) {
        this.sources[src.handedness] = src;
      }
    }
    for (const hand of ['left', 'right']) {
      this.prev[hand] = this.now[hand];
      const gp = this.sources[hand]?.gamepad;
      this.now[hand] = gp ? gp.buttons.map((b) => b.pressed) : [];
    }
  }

  connected(hand) {
    return !!this.sources[hand];
  }

  // Thumbstick as { x, y } with y positive forward (stick pushed away from you).
  // A radial deadzone keeps resting drift from walking you off.
  stick(hand) {
    const gp = this.sources[hand]?.gamepad;
    if (!gp) return { x: 0, y: 0, mag: 0 };
    const a = gp.axes;
    const x = a.length >= 4 ? a[2] : a[0] ?? 0;
    const y = -(a.length >= 4 ? a[3] : a[1] ?? 0);
    const mag = Math.min(1, Math.hypot(x, y));
    const dz = this.settings.stickDeadzone;
    if (mag <= dz) return { x: 0, y: 0, mag: 0 };
    // Rescale so output ramps from 0 at the deadzone edge to 1 at full deflection.
    const scaled = (mag - dz) / (1 - dz);
    return { x: (x / mag) * scaled, y: (y / mag) * scaled, mag: scaled };
  }

  isDown(hand, button) {
    return !!this.now[hand][XR_BUTTONS[button]];
  }

  justPressed(hand, button) {
    const i = XR_BUTTONS[button];
    return !!this.now[hand][i] && !this.prev[hand][i];
  }

  pulse(hand, intensity, ms) {
    const gp = this.sources[hand]?.gamepad;
    if (!gp) return;
    try {
      const actuator = gp.hapticActuators?.[0];
      if (actuator?.pulse) actuator.pulse(intensity, ms);
      else gp.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity });
    } catch {
      // Haptics are best effort; never let them break the frame.
    }
  }
}
