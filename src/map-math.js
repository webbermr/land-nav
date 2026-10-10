// Conversions between scene metres, map.png pixels and the physical map board.
// Pure functions, no Three.js.
//
// map.png is site.map.px square. site.map.area = [x0, y0, x1, y1] is the terrain
// square inside it, in pixels from the top-left. Scene x runs east (right on the map),
// scene z runs south (down on the map).
// Board coordinates are metres from the board centre, x right and y up.

export const BOARD_SIZE_M = 0.4;

export function sceneToMapPx(site, x, z) {
  const [x0, y0, x1, y1] = site.map.area;
  return { px: x0 + (x / site.size_m) * (x1 - x0), py: y0 + (z / site.size_m) * (y1 - y0) };
}

export function mapPxToScene(site, px, py) {
  const [x0, y0, x1, y1] = site.map.area;
  return { x: ((px - x0) / (x1 - x0)) * site.size_m, z: ((py - y0) / (y1 - y0)) * site.size_m };
}

export function boardToMapPx(site, bx, by, boardSize = BOARD_SIZE_M) {
  return { px: (bx / boardSize + 0.5) * site.map.px, py: (0.5 - by / boardSize) * site.map.px };
}

export function mapPxToBoard(site, px, py, boardSize = BOARD_SIZE_M) {
  return { bx: (px / site.map.px - 0.5) * boardSize, by: (0.5 - py / site.map.px) * boardSize };
}

export function boardToScene(site, bx, by, boardSize = BOARD_SIZE_M) {
  const { px, py } = boardToMapPx(site, bx, by, boardSize);
  return mapPxToScene(site, px, py);
}

export function sceneToBoard(site, x, z, boardSize = BOARD_SIZE_M) {
  const { px, py } = sceneToMapPx(site, x, z);
  return mapPxToBoard(site, px, py, boardSize);
}

// Metres on the ground per metre on the board (the map scale denominator).
export function boardScale(site, boardSize = BOARD_SIZE_M) {
  const [x0, , x1] = site.map.area;
  return site.size_m / (((x1 - x0) / site.map.px) * boardSize);
}

export function insideTerrain(site, x, z) {
  return x >= 0 && z >= 0 && x <= site.size_m && z <= site.size_m;
}
