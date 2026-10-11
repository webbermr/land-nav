// Site data (sites/...) lives outside the versioned code folder, and GitHub Pages
// lets browsers reuse files for 10 minutes without asking. So a page fresh from a
// deploy could read a stale course list or map. On Pages the code runs from
// v/<commit>/src/, so tag data URLs with that commit: each deploy gets fresh URLs.
// Locally there's no v/ folder and URLs are left alone.
export const DATA_VERSION = (import.meta.url.match(/\/v\/([0-9a-f]+)\/src\//) || [])[1] || '';

export function dataUrl(path) {
  return DATA_VERSION ? `${path}${path.includes('?') ? '&' : '?'}v=${DATA_VERSION}` : path;
}
