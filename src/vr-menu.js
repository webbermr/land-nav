// The in-headset menu: settings you'd otherwise only reach on the page or the
// keyboard (woods/open, day/night, fly, pace counts ...). Hold X to open it; point
// with the right controller and pull the trigger. A panel floating in front of
// you, drawn on a canvas, so it costs one draw call.
//
// Pages: [{ title, items }], shown one at a time with tabs along the top.
// Items: { label, value() -> string, press(dir) where dir is -1 (left half of
// the value box) or +1 (right half), enabled?() -> bool, repeat?: true }
import * as THREE from 'three';

const W = 1024, HEADER = 96, ROW = 62, PAD = 28;
const PANEL_W = 0.56; // metres
const VALUE_X0 = 0.56; // value box, as a fraction of the width
const VALUE_X1 = 0.97;

export function createVrMenu(pages, { title = 'Menu', hint = '' } = {}) {
  if (!pages[0]?.items) pages = [{ title, items: pages }];
  let page = 0;
  let items = pages[0].items;
  const tabs = pages.length > 1;
  const TOP = HEADER + (tabs ? ROW + 8 : 0); // first item row
  const rows = Math.max(...pages.map((p) => p.items.length));
  const H = TOP + rows * ROW + 64;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const panelH = (PANEL_W * H) / W;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, panelH), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  mesh.name = 'vr-menu';
  mesh.visible = false;
  mesh.renderOrder = 10;

  let hover = null; // { row, dir }

  function draw() {
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(22, 26, 31, 0.94)';
    roundRect(g, 0, 0, W, H, 28); g.fill();
    g.fillStyle = '#ffd27a'; g.font = '600 44px system-ui, sans-serif'; g.textBaseline = 'middle';
    g.fillText(title, PAD, HEADER / 2);
    if (tabs) {
      const tw = (W - PAD * 2) / pages.length;
      pages.forEach((p, k) => {
        const x = PAD + k * tw;
        g.fillStyle = k === page ? '#ffd27a' : hover?.tab === k ? '#3a424a' : '#2d343b';
        roundRect(g, x + 4, HEADER, tw - 8, ROW - 6, 12); g.fill();
        g.fillStyle = k === page ? '#16191d' : '#e9ecef';
        g.font = '600 32px system-ui, sans-serif'; g.textAlign = 'center';
        g.fillText(p.title, x + tw / 2, HEADER + (ROW - 6) / 2, tw - 24);
        g.textAlign = 'left';
      });
    }
    items.forEach((it, i) => {
      const y = TOP + i * ROW;
      const on = it.enabled ? it.enabled() : true;
      if (hover?.row === i && on) { g.fillStyle = 'rgba(255, 210, 122, 0.16)'; g.fillRect(8, y + 3, W - 16, ROW - 6); }
      g.fillStyle = on ? '#e9ecef' : '#6c757d';
      g.font = '34px system-ui, sans-serif';
      g.fillText(it.label, PAD, y + ROW / 2, W * VALUE_X0 - PAD * 2);
      const v = it.value?.();
      if (v === undefined) return;
      const x0 = W * VALUE_X0, x1 = W * VALUE_X1;
      g.fillStyle = on ? '#2d343b' : '#24292e';
      roundRect(g, x0, y + 8, x1 - x0, ROW - 16, 10); g.fill();
      g.fillStyle = on ? '#ffd27a' : '#6c757d';
      g.font = '600 34px system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText(v, (x0 + x1) / 2, y + ROW / 2, x1 - x0 - 90);
      g.fillStyle = on ? '#9aa4ad' : '#4a5057';
      g.fillText('‹', x0 + 24, y + ROW / 2);
      g.fillText('›', x1 - 24, y + ROW / 2);
      g.textAlign = 'left';
    });
    g.fillStyle = '#9aa4ad'; g.font = '26px system-ui, sans-serif';
    g.fillText(hint, PAD, H - 32, W - PAD * 2);
    tex.needsUpdate = true;
  }

  // Which row and which half of its value box a uv point on the panel is over.
  function at(uv) {
    const py = (1 - uv.y) * H;
    if (tabs && py >= HEADER && py < HEADER + ROW) {
      const k = Math.floor(((uv.x * W) - PAD) / ((W - PAD * 2) / pages.length));
      return k >= 0 && k < pages.length ? { tab: k } : null;
    }
    const row = Math.floor((py - TOP) / ROW);
    if (row < 0 || row >= items.length) return null;
    return { row, dir: uv.x < (VALUE_X0 + VALUE_X1) / 2 ? -1 : 1 };
  }

  function showPage(k) {
    page = k;
    items = pages[k].items;
    hover = null;
    held = null;
    draw();
  }

  const raycaster = new THREE.Raycaster();
  const hits = [];
  let held = null; // { row, dir, next, frames } for repeating presses

  return {
    mesh,
    get open() { return mesh.visible; },
    draw,
    // head: eye position; dir: horizontal facing (unit vector).
    show(head, dir) {
      mesh.position.set(head.x + dir.x * 0.62, head.y - 0.12, head.z + dir.z * 0.62);
      mesh.rotation.set(0, Math.atan2(-dir.x, -dir.z), 0, 'YXZ');
      mesh.rotateX(-0.25);
      mesh.visible = true;
      hover = null;
      draw();
    },
    hide() { mesh.visible = false; held = null; },
    // A row's point in world space, dir -1/+1 picking the half of the value box.
    rowPoint(row, dir = 1) {
      const u = dir < 0 ? VALUE_X0 + 0.05 : VALUE_X1 - 0.05;
      const v = 1 - (TOP + (row + 0.5) * ROW) / H;
      mesh.updateMatrixWorld(true);
      return new THREE.Vector3((u - 0.5) * PANEL_W, (v - 0.5) * panelH, 0).applyMatrix4(mesh.matrixWorld);
    },
    // The middle of a tab, in world space.
    tabPoint(k) {
      const u = (PAD + (k + 0.5) * ((W - PAD * 2) / pages.length)) / W;
      const v = 1 - (HEADER + ROW / 2) / H;
      mesh.updateMatrixWorld(true);
      return new THREE.Vector3((u - 0.5) * PANEL_W, (v - 0.5) * panelH, 0).applyMatrix4(mesh.matrixWorld);
    },
    get page() { return page; },
    showPage,
    // Which page an item is on, and its row there.
    pageOf(label) { return pages.findIndex((p) => p.items.some((it) => it.label === label)); },
    indexOf(label) { return items.findIndex((it) => it.label === label); },
    // One frame: aim with `ray` (an Object3D pointing down its -Z), press with
    // `down` (trigger held). Returns the distance to the panel, or null.
    update(ray, down, now) {
      if (!mesh.visible) return null;
      ray.updateMatrixWorld(true);
      raycaster.ray.origin.setFromMatrixPosition(ray.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).transformDirection(ray.matrixWorld);
      hits.length = 0;
      raycaster.intersectObject(mesh, false, hits);
      const h = hits[0] ? at(hits[0].uv) : null;
      if (h?.row !== hover?.row || h?.tab !== hover?.tab) { hover = h; draw(); }
      if (!down) { held = null; return hits[0]?.distance ?? null; }
      if (!held && h?.tab !== undefined) {
        showPage(h.tab);
        held = { tab: true, frames: 0 };
        return hits[0]?.distance ?? null;
      }
      if (held?.tab) return hits[0]?.distance ?? null;
      const fire = (row, dir) => {
        const it = items[row];
        if (it.enabled && !it.enabled()) return;
        it.press?.(dir);
        draw();
      };
      if (!held && h && h.row !== undefined) {
        fire(h.row, h.dir);
        held = { row: h.row, dir: h.dir, next: now + 0.45, frames: 0 };
      } else if (held && ++held.frames >= 8 && items[held.row].repeat && now >= held.next && h?.row === held.row) {
        // Repeat only on a real hold: time alone isn't enough, since one slow frame
        // (trees rebuilding, say) would turn a quick pull into a repeat.
        fire(held.row, held.dir);
        held.next = now + 0.09;
      }
      return hits[0]?.distance ?? null;
    },
  };
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Step through a list of choices: cycle(['woods','open'], 'woods', 1) -> 'open'.
export function cycle(list, current, dir) {
  const i = list.indexOf(current);
  return list[(((i < 0 ? 0 : i) + dir) % list.length + list.length) % list.length];
}
