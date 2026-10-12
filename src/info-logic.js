// Words and numbers for the Explore info card (src/info-card.js). Pure functions.

export const UNITS = Object.freeze(['us', 'metric']);

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassPoint(deg) {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export function formatTemp(c, units) {
  if (!Number.isFinite(c)) return '--';
  const f = Math.round(c * 9 / 5 + 32);
  return units === 'metric' ? `${Math.round(c)} °C (${f} °F)` : `${f} °F (${Math.round(c)} °C)`;
}

// Wind from a direction, at a speed (m/s): "WSW 9 mph, gusts 18".
export function formatWind(ms, fromDeg, gustMs, units) {
  if (!Number.isFinite(ms)) return '--';
  const conv = units === 'metric' ? (v) => Math.round(v * 3.6) : (v) => Math.round(v * 2.23694);
  const unit = units === 'metric' ? 'km/h' : 'mph';
  if (ms < 0.5) return 'calm';
  const gust = Number.isFinite(gustMs) && gustMs > ms * 1.3 + 1 ? `, gusts ${conv(gustMs)}` : '';
  return `${compassPoint(fromDeg)} ${conv(ms)} ${unit}${gust}`;
}

export function formatDistance(m, units) {
  if (!Number.isFinite(m)) return '--';
  if (units === 'metric') return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m / 10) * 10} m`;
  const mi = m / 1609.344;
  return mi >= 1 ? `${mi.toFixed(mi >= 10 ? 0 : 1)} mi` : `${Math.round(m * 3.28084 / 10) * 10} ft`;
}

export function formatElevation(m, units) {
  if (!Number.isFinite(m)) return '--';
  const ft = Math.round(m * 3.28084);
  return units === 'metric' ? `${Math.round(m)} m (${ft.toLocaleString('en-US')} ft)` : `${ft.toLocaleString('en-US')} ft (${Math.round(m)} m)`;
}

export function formatLatLon(lat, lon) {
  return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`;
}

// "Sunday 11 October 2026" for a date at a UTC offset.
export function formatDay(date, offsetMin) {
  const d = new Date(date.getTime() + offsetMin * 60000);
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// A time zone label from an offset in minutes: "UTC-4".
export function utcLabel(offsetMin) {
  const h = offsetMin / 60;
  return `UTC${h >= 0 ? '+' : '-'}${Math.abs(h) % 1 ? Math.abs(h).toFixed(1) : Math.abs(h)}`;
}
