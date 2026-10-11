// 2D page UI: the Enter VR button and the settings panel. On the Quest this is the
// page you see before entering VR; in-headset menus come with the tools in M2.
import { saveSettings } from './settings.js';

// Each field: settings key, label, and the input to build.
const FIELDS = [
  { key: 'paceCountPer100m', label: 'Pace count per 100 m', type: 'number', min: 30, max: 120, step: 1 },
  { key: 'timeScale', label: 'Time compression', type: 'select', options: [[1, '1x'], [2, '2x'], [3, '3x']] },
  { key: 'slopeEffects', label: 'Slope effects', type: 'checkbox' },
  { key: 'footfallVolume', label: 'Footstep volume', type: 'range', min: 0, max: 1, step: 0.05 },
  { key: 'hapticStrength', label: 'Left-foot haptic strength', type: 'range', min: 0, max: 1, step: 0.05 },
  { key: 'vignette', label: 'Comfort vignette', type: 'range', min: 0, max: 1, step: 0.05 },
  { key: 'snapTurn', label: 'Snap turn (right stick)', type: 'checkbox' },
  { key: 'units', label: 'Compass lens units', type: 'select', options: [['deg', 'Degrees'], ['mils', 'Mils']], text: true },
  { key: 'compassTiltSticks', label: 'Dial sticks when tilted', type: 'checkbox' },
  { key: 'assisted', label: 'Assisted map readout', type: 'checkbox' },
  { key: 'lostHelp', label: "Allow 'show my position' (K / hold left stick)", type: 'checkbox' },
];

export function buildSettingsPanel(container, settings, onChange) {
  container.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = 'Settings';
  container.append(title);
  for (const f of FIELDS) {
    const row = document.createElement('label');
    row.className = 'row';
    const span = document.createElement('span');
    span.textContent = f.label;
    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const [v, text] of f.options) {
        const o = document.createElement('option');
        o.value = String(v);
        o.textContent = text;
        input.append(o);
      }
      input.value = String(settings[f.key]);
    } else {
      input = document.createElement('input');
      input.type = f.type;
      if (f.type === 'checkbox') input.checked = settings[f.key];
      else {
        input.min = f.min; input.max = f.max; input.step = f.step;
        input.value = settings[f.key];
      }
    }
    input.addEventListener('change', () => {
      let v;
      if (f.type === 'checkbox') v = input.checked;
      else if (f.text) v = input.value;
      else v = Number(input.value);
      if (f.type === 'number') {
        if (!Number.isFinite(v)) return;
        v = Math.min(f.max, Math.max(f.min, Math.round(v)));
        input.value = v;
      }
      settings[f.key] = v;
      saveSettings(settings);
      onChange?.(f.key, v);
    });
    row.append(span, input);
    container.append(row);
  }
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = 'Count a pace each time your left foot lands. In VR that is the pulse in your left hand.';
  container.append(note);
}

// Shows "Enter VR" when an immersive-vr session is possible, otherwise explains why not.
export async function setupVRButton(button, { onRequest }) {
  const xr = navigator.xr;
  let supported = false;
  try {
    supported = !!xr && (await xr.isSessionSupported('immersive-vr'));
  } catch {
    supported = false;
  }
  if (!supported) {
    button.textContent = window.isSecureContext ? 'VR not available on this device' : 'VR needs HTTPS';
    button.disabled = true;
    return;
  }
  button.textContent = 'Enter VR';
  button.disabled = false;
  button.addEventListener('click', onRequest);
}
