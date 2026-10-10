// Desktop input: WASD, mouse look (pointer lock), and tool keys (spec section 7.5).
// XR controller input joins this module in M1.

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
      if (e.target instanceof HTMLInputElement) return;
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
