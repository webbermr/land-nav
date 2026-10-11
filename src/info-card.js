// The Explore info card on the left wrist (or the corner of the screen): where
// you are, the time and sun, the weather and season, and what's underfoot. Drawn
// on a canvas, only when what it says changes.
import * as THREE from 'three';

// rows: [[label, value], ...] grouped into sections by null entries.
export function createInfoCard() {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 800;
  const g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.16), new THREE.MeshBasicMaterial({ map: tex }));
  mesh.name = 'info-card';
  mesh.visible = false;
  let lastKey = '';

  const draw = ({ title, subtitle, rows, footer }) => {
    const key = JSON.stringify([title, subtitle, rows, footer]);
    if (key === lastKey) return;
    lastKey = key;
    g.fillStyle = '#16191d';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.strokeStyle = '#ffd27a'; g.lineWidth = 4;
    g.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
    g.textBaseline = 'top';
    g.fillStyle = '#ffd27a';
    g.font = 'bold 36px system-ui, sans-serif';
    g.fillText(title, 28, 24, canvas.width - 56);
    g.fillStyle = '#9aa4ad';
    g.font = '24px system-ui, sans-serif';
    g.fillText(subtitle, 28, 70, canvas.width - 56);
    let y = 116;
    for (const r of rows) {
      if (!r) {
        g.strokeStyle = '#2d343b'; g.lineWidth = 2;
        g.beginPath(); g.moveTo(28, y + 4); g.lineTo(canvas.width - 28, y + 4); g.stroke();
        y += 16;
        continue;
      }
      const [label, value] = r;
      g.fillStyle = '#9aa4ad';
      g.font = '22px system-ui, sans-serif';
      g.fillText(label, 28, y + 4, 150);
      g.fillStyle = '#e9ecef';
      g.font = '27px system-ui, sans-serif';
      g.fillText(value, 186, y, canvas.width - 214);
      y += 40;
    }
    g.fillStyle = '#6c757d';
    g.font = '20px system-ui, sans-serif';
    let line = '';
    let fy = canvas.height - 58;
    for (const w of footer.split(' ')) {
      if (g.measureText(line + w).width > canvas.width - 56) { g.fillText(line, 28, fy); fy += 26; line = ''; }
      line += w + ' ';
    }
    g.fillText(line, 28, fy);
    tex.needsUpdate = true;
  };
  return { mesh, draw };
}
