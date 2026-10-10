// Minimal fake WebXR device for automated checks in desktop Chromium. Injected as an
// init script before the app loads. It covers only what three.js and the app use:
// one immersive-vr session, a stereo viewer pose, two controllers with gamepads and
// haptic actuators. Tests drive it through window.__xr.
(() => {
  const state = {
    head: { x: 0, y: 1.6, z: 0, yaw: 0 },  // in the local-floor space; yaw radians, + turns left
    axes: { left: [0, 0, 0, 0], right: [0, 0, 0, 0] },
    pulses: [],
    session: null,
  };
  window.__xr = state;

  // Column-major 4x4: rotate about Y by yaw, then translate.
  function poseMatrix(x, y, z, yaw) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1]);
  }
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }

  class Emitter {
    constructor() { this._l = {}; }
    addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
    removeEventListener(t, fn) { this._l[t] = (this._l[t] || []).filter((f) => f !== fn); }
    dispatchEvent(ev) { for (const fn of this._l[ev.type] || []) fn(ev); return true; }
  }

  const W = 640, H = 360;
  class XRWebGLLayer {
    constructor() {
      this.framebuffer = null;
      this.framebufferWidth = W;
      this.framebufferHeight = H;
      this.ignoreDepthValues = true;
      this.fixedFoveation = 0;
    }
    getViewport(view) {
      return { x: view.eye === 'left' ? 0 : W / 2, y: 0, width: W / 2, height: H };
    }
  }
  window.XRWebGLLayer = XRWebGLLayer;
  window.XRWebGLBinding = undefined; // force the XRWebGLLayer path in three.js
  // Chrome's real makeXRCompatible rejects when no device is attached.
  WebGL2RenderingContext.prototype.makeXRCompatible = async () => {};

  function makeSource(hand) {
    const buttons = Array.from({ length: 7 }, () => ({ pressed: false, touched: false, value: 0 }));
    return {
      handedness: hand,
      targetRaySpace: { hand, kind: 'ray' },
      gripSpace: { hand, kind: 'grip' },
      profiles: ['oculus-touch-v3', 'generic-trigger-squeeze-thumbstick'],
      gamepad: {
        mapping: 'xr-standard',
        get axes() { return state.axes[hand]; },
        buttons,
        hapticActuators: [{
          pulse(intensity, ms) {
            state.pulses.push({ hand, intensity, ms, t: performance.now() });
            return Promise.resolve(true);
          },
        }],
      },
    };
  }

  function makeSession() {
    const session = new Emitter();
    const sources = [makeSource('left'), makeSource('right')];
    session.inputSources = sources;
    session.renderState = {};
    session.enabledFeatures = ['local-floor'];
    session.environmentBlendMode = 'opaque';
    session.updateRenderState = (s) => Object.assign(session.renderState, s);
    session.requestReferenceSpace = async () => ({ kind: 'local-floor' });
    const proj = perspective(1.6, (W / 2) / H, 0.05, 9000);
    const frame = {
      session,
      getViewerPose() {
        const h = state.head;
        const m = poseMatrix(h.x, h.y, h.z, h.yaw);
        const eye = (dx) => poseMatrix(h.x + Math.cos(h.yaw) * dx, h.y, h.z - Math.sin(h.yaw) * dx, h.yaw);
        return {
          transform: { matrix: m },
          views: [
            { eye: 'left', projectionMatrix: proj, transform: { matrix: eye(-0.032) } },
            { eye: 'right', projectionMatrix: proj, transform: { matrix: eye(0.032) } },
          ],
        };
      },
      getPose(space) {
        const h = state.head;
        const side = space.hand === 'left' ? -0.2 : 0.2;
        const x = h.x + Math.cos(h.yaw) * side - Math.sin(h.yaw) * 0.3;
        const z = h.z - Math.sin(h.yaw) * side - Math.cos(h.yaw) * 0.3;
        return { transform: { matrix: poseMatrix(x, h.y - 0.45, z, h.yaw) }, emulatedPosition: false };
      },
    };
    session.requestAnimationFrame = (cb) => window.requestAnimationFrame((t) => cb(t, frame));
    session.cancelAnimationFrame = (id) => window.cancelAnimationFrame(id);
    session.end = async () => {
      state.session = null;
      session.dispatchEvent({ type: 'end' });
    };
    setTimeout(() => session.dispatchEvent({ type: 'inputsourceschange', added: sources, removed: [] }), 50);
    return session;
  }

  Object.defineProperty(navigator, 'xr', {
    configurable: true,
    value: {
      isSessionSupported: async (mode) => mode === 'immersive-vr',
      requestSession: async (mode) => {
        if (mode !== 'immersive-vr') throw new Error('unsupported');
        state.session = makeSession();
        return state.session;
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });
})();
