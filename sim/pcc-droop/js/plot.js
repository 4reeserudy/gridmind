// Lightweight canvas plotting for real-time traces and static characteristics.

export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

export function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 10);
  const h = Math.max(rect.height, 10);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const MONO = "'JetBrains Mono', ui-monospace, monospace";

function niceTicks(min, max, count) {
  const span = max - min;
  if (span <= 0) return [min];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : norm >= 1 ? 1 : 0.5) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  }
  return out;
}

/**
 * Generic 2-D plot.
 * opts: { xDomain, yDomain, series:[{x:[],y:[],color,width,dash,fillTo,label}],
 *         markers:[{x,y,color,label}], bands:[{y0,y1,color}], vlines:[{x,color,label}],
 *         xLabel, yLabel, fmtX, fmtY, yTicks, xTicks, legend }
 */
export function plot(canvas, opts) {
  const { ctx, w, h } = fitCanvas(canvas);
  const pad = { l: 52, r: 12, t: 14, b: 26, ...(opts.pad || {}) };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  if (iw <= 0 || ih <= 0) return;

  const [x0, x1] = opts.xDomain;
  const [y0, y1] = opts.yDomain;
  const sx = (v) => pad.l + ((v - x0) / (x1 - x0 || 1)) * iw;
  const sy = (v) => pad.t + ih - ((v - y0) / (y1 - y0 || 1)) * ih;

  const grid = cssVar('--c-grid');
  const gridStrong = cssVar('--c-grid-strong');
  const text = cssVar('--c-text-faint');

  // plot frame
  ctx.save();
  ctx.fillStyle = cssVar('--c-plot-bg');
  ctx.fillRect(pad.l, pad.t, iw, ih);

  // shaded bands (e.g. deadband, ride-through limits)
  for (const b of opts.bands || []) {
    ctx.fillStyle = b.color;
    if (b.x0 !== undefined) {
      ctx.fillRect(sx(b.x0), pad.t, sx(b.x1) - sx(b.x0), ih);
    } else {
      ctx.fillRect(pad.l, sy(b.y1), iw, sy(b.y0) - sy(b.y1));
    }
  }

  const xt = opts.xTicks || niceTicks(x0, x1, 6);
  const yt = opts.yTicks || niceTicks(y0, y1, 4);
  ctx.lineWidth = 1;
  ctx.font = `500 10.5px ${MONO}`;
  ctx.fillStyle = text;

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of yt) {
    if (v < y0 - 1e-9 || v > y1 + 1e-9) continue;
    const y = Math.round(sy(v)) + 0.5;
    ctx.strokeStyle = Math.abs(v) < 1e-9 ? gridStrong : grid;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + iw, y);
    ctx.stroke();
    ctx.fillText((opts.fmtY || ((n) => n.toFixed(2)))(v), pad.l - 7, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // Gridlines are always drawn; labels are dropped when they would collide with
  // the previous one, so a dense tick set still reads on a narrow canvas.
  let lastRight = -Infinity;
  for (const v of xt) {
    if (v < x0 - 1e-9 || v > x1 + 1e-9) continue;
    const x = Math.round(sx(v)) + 0.5;
    ctx.strokeStyle = Math.abs(v) < 1e-9 ? gridStrong : grid;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + ih);
    ctx.stroke();
    const label = (opts.fmtX || ((n) => String(+n.toFixed(2))))(v);
    const half = ctx.measureText(label).width / 2;
    if (x - half < lastRight + 7) continue;
    ctx.fillText(label, x, pad.t + ih + 6);
    lastRight = x + half;
  }

  // vertical event markers
  for (const vl of opts.vlines || []) {
    if (vl.x < x0 || vl.x > x1) continue;
    ctx.strokeStyle = vl.color;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(sx(vl.x), pad.t);
    ctx.lineTo(sx(vl.x), pad.t + ih);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // series
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, iw, ih);
  ctx.clip();
  for (const s of opts.series || []) {
    if (!s.x || s.x.length < 2) continue;
    ctx.lineWidth = s.width || 1.75;
    ctx.strokeStyle = s.color;
    ctx.setLineDash(s.dash || []);
    ctx.globalAlpha = s.alpha ?? 1;
    if (s.fillTo !== undefined) {
      ctx.beginPath();
      ctx.moveTo(sx(s.x[0]), sy(s.fillTo));
      for (let i = 0; i < s.x.length; i++) ctx.lineTo(sx(s.x[i]), sy(s.y[i]));
      ctx.lineTo(sx(s.x[s.x.length - 1]), sy(s.fillTo));
      ctx.closePath();
      ctx.fillStyle = s.fill || s.color;
      ctx.globalAlpha = (s.alpha ?? 1) * 0.14;
      ctx.fill();
      ctx.globalAlpha = s.alpha ?? 1;
    }
    ctx.beginPath();
    ctx.moveTo(sx(s.x[0]), sy(s.y[0]));
    for (let i = 1; i < s.x.length; i++) ctx.lineTo(sx(s.x[i]), sy(s.y[i]));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // operating-point markers
  for (const m of opts.markers || []) {
    const x = sx(m.x);
    const y = sy(m.y);
    ctx.strokeStyle = m.color;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(x, y);
    ctx.moveTo(x, pad.t + ih);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = cssVar('--c-plot-bg');
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();

  // axis labels
  ctx.fillStyle = text;
  ctx.font = `500 10px ${MONO}`;
  if (opts.xLabel) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.xLabel, pad.l + iw, h - 1);
  }
  if (opts.yLabel) {
    ctx.save();
    ctx.translate(11, pad.t);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(opts.yLabel, -ih, 0);
    ctx.restore();
  }

  // legend
  if (opts.legend?.length) {
    ctx.font = `500 10.5px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    let lx = pad.l + 8;
    const ly = pad.t + 10;
    for (const item of opts.legend) {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(item.dash || []);
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + 14, ly);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--c-text-muted');
      ctx.fillText(item.label, lx + 19, ly + 0.5);
      lx += 19 + ctx.measureText(item.label).width + 14;
    }
  }
  ctx.restore();
}

// Ring buffer for streaming traces.
export class Ring {
  constructor(n) {
    this.n = n;
    this.x = [];
    this.y = [];
  }
  push(x, y) {
    this.x.push(x);
    this.y.push(y);
    if (this.x.length > this.n) {
      this.x.shift();
      this.y.shift();
    }
  }
  clear() {
    this.x.length = 0;
    this.y.length = 0;
  }
  last() {
    return this.y.length ? this.y[this.y.length - 1] : 0;
  }
}
