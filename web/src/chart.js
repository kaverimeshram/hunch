/*
 * YES-share step chart drawn from real stake events. A stake changes the share instantly, so the
 * line holds its value until the next stake. Returns an SVG string; no DOM needed.
 */
import { formatTenths } from './market.js';
import { escapeHTML } from './html.js';

const MIN_SPAN_MS = 60 * 1000;
const when = (ms) => `${new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
const amountText = (yocto) => `${Number(yocto / 10n ** 21n) / 1000} NEAR`;

/** Pixel positions for each stake plus the x where the line ends (now). */
export function layout(series, { width, height, nowMs, mini = false }) {
  const pad = mini ? { l: 2, r: 2, t: 3, b: 3 } : { l: 8, r: 44, t: 14, b: 30 };
  const first = series[0].at;
  const end = Math.max(nowMs, series[series.length - 1].at, first + MIN_SPAN_MS);
  const start = first - (end - first) * 0.05;
  const x = (at) => pad.l + ((at - start) / (end - start)) * (width - pad.l - pad.r);
  const y = (tenths) => pad.t + (1 - tenths / 1000) * (height - pad.t - pad.b);
  return { pad, x, y, endX: x(end), points: series.map((p) => ({ ...p, px: x(p.at), py: y(p.yesTenths) })) };
}

export function chartSvg(series, { width, height = 240, nowMs = Date.now(), mini = false } = {}) {
  if (!series.length) return '';
  const { pad, y, endX, points } = layout(series, { width, height, nowMs, mini });
  const line = points.map((p, i) => (i === 0 ? `M${p.px.toFixed(1)} ${p.py.toFixed(1)}` : `H${p.px.toFixed(1)} V${p.py.toFixed(1)}`)).join(' ') + ` H${endX.toFixed(1)}`;
  const last = points[points.length - 1];
  const label = `YES share of staked NEAR over time: ${formatTenths(points[0].yesTenths)} after the first stake, ${formatTenths(last.yesTenths)} now, ${points.length} ${points.length === 1 ? 'stake' : 'stakes'}.`;
  if (mini) return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHTML(label)}"><path d="${line}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  const bottom = height - pad.b;
  const grid = [0, 250, 500, 750, 1000].map((t) => `<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="grid"/><text x="${width - pad.r + 8}" y="${(y(t) + 4).toFixed(1)}" class="axis">${t / 10}%</text>`).join('');
  const area = `${line} V${bottom} H${points[0].px.toFixed(1)} Z`;
  const dots = points.map((p) => `<circle cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="5" class="dot dot-${p.side === 'Yes' ? 'yes' : 'no'}"><title>${escapeHTML(`${p.side} ${amountText(p.amount)} · YES share ${formatTenths(p.yesTenths)} · ${when(p.at)}`)}</title></circle>`).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeHTML(label)}">
    ${grid}<path d="${area}" class="area"/><path d="${line}" class="line" fill="none"/>${dots}
    <text x="${pad.l}" y="${height - 8}" class="axis">${escapeHTML(when(points[0].at))}</text><text x="${width - pad.r}" y="${height - 8}" text-anchor="end" class="axis">Now</text>
  </svg>`;
}
