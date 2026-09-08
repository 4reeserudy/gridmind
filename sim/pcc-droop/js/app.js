import {
  F_NOM,
  DEFAULTS,
  EVENTS,
  pRef,
  qRef,
  initState,
  step,
  runScenario,
  stabilityIndex,
  scr,
} from './sim.js';
import { plot, Ring, cssVar } from './plot.js';

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

const DT = 0.002; // integration step, s
const WIN = 20; // scope window, s

const cfg = { ...DEFAULTS };
let sim = initState(cfg);
let running = true;
let eventKey = 'freqDrop';
let saved = [];
let cmp = null;
let seq = 0;

const rings = {
  f: new Ring(2600),
  v: new Ring(2600),
  vn: new Ring(2600),
  p: new Ring(2600),
  q: new Ring(2600),
};

const CMP_COLORS = ['--c-cmp-1', '--c-cmp-2', '--c-cmp-3', '--c-cmp-4', '--c-cmp-5', '--c-cmp-6'];

// ---------------------------------------------------------------------------
// control definitions
// ---------------------------------------------------------------------------

const f2 = (n) => n.toFixed(2);
const f3 = (n) => n.toFixed(3);

const GROUPS = [
  {
    title: 'Grid conditions',
    note: 'source',
    controls: [
      {
        type: 'pills',
        key: 'stiffF',
        label: 'Grid representation',
        options: [
          { v: false, label: 'Dynamic (inertia)' },
          { v: true, label: 'Stiff (imposed)' },
        ],
        hint: 'Dynamic solves the swing equation, so droop actually changes the nadir. Stiff lets you drive frequency straight from the slider.',
      },
      { type: 'event' },
      {
        key: 'Vs',
        label: 'Source magnitude',
        sym: 'Vs',
        min: 0.88,
        max: 1.12,
        step: 0.005,
        unit: 'pu',
        fmt: f3,
      },
      {
        key: 'fOffset',
        label: 'Frequency deviation',
        sym: 'Δf',
        min: -2,
        max: 2,
        step: 0.01,
        unit: 'Hz',
        fmt: f2,
        onlyStiff: true,
        hint: 'Imposed system frequency offset. Active in stiff mode only.',
      },
    ],
  },
  {
    title: 'Line impedance',
    note: 'PCC coupling',
    controls: [
      { key: 'R', label: 'Resistance', sym: 'R', min: 0, max: 0.3, step: 0.005, unit: 'pu', fmt: f3 },
      { key: 'X', label: 'Reactance', sym: 'X', min: 0.01, max: 0.6, step: 0.005, unit: 'pu', fmt: f3 },
    ],
    footer: 'netInfo',
  },
  {
    title: 'Droop settings',
    note: 'IEEE 1547',
    controls: [
      {
        key: 'kp',
        label: 'Frequency-watt gain',
        sym: 'kp',
        min: 0,
        max: 120,
        step: 0.5,
        unit: '%P/Hz',
        fmt: (n) => n.toFixed(1),
        hint: 'Active-power response per hertz. 33.3 %/Hz = 5 % droop.',
      },
      {
        key: 'dbF',
        label: 'Frequency deadband',
        sym: 'db_f',
        min: 0,
        max: 0.5,
        step: 0.002,
        unit: 'Hz',
        fmt: f3,
      },
      {
        key: 'kq',
        label: 'Volt-var gain',
        sym: 'kq',
        min: 0,
        max: 60,
        step: 0.5,
        unit: '%Q/0.01pu',
        fmt: (n) => n.toFixed(1),
        hint: 'Reactive response per 0.01 pu of voltage error. Loop gain is X·dQ/dV — push it too far on a weak line and the response rings.',
      },
      {
        key: 'dbV',
        label: 'Voltage deadband',
        sym: 'db_v',
        min: 0,
        max: 0.06,
        step: 0.002,
        unit: 'pu',
        fmt: f3,
      },
      {
        key: 'vRef',
        label: 'Voltage reference',
        sym: 'Vref',
        min: 0.95,
        max: 1.05,
        step: 0.005,
        unit: 'pu',
        fmt: f3,
      },
    ],
    footer: 'droopInfo',
  },
  {
    title: 'Inverter',
    note: 'limits & response',
    controls: [
      { key: 'P0', label: 'Pre-event dispatch', sym: 'P0', min: -1, max: 1, step: 0.01, unit: 'pu', fmt: f2 },
      { key: 'qMax', label: 'Reactive capability', sym: 'Qmax', min: 0.1, max: 1, step: 0.01, unit: 'pu', fmt: f2 },
      {
        key: 'Tp',
        label: 'P response time',
        sym: 'Tp',
        min: 0.05,
        max: 10,
        step: 0.05,
        unit: 's',
        fmt: f2,
      },
      {
        key: 'Tq',
        label: 'Q response time',
        sym: 'Tq',
        min: 0.05,
        max: 10,
        step: 0.05,
        unit: 's',
        fmt: f2,
      },
      {
        type: 'pills',
        key: 'priority',
        label: 'Apparent-power priority',
        options: [
          { v: 'Q', label: 'Q priority' },
          { v: 'P', label: 'P priority' },
        ],
      },
      {
        type: 'pills',
        key: 'bidirP',
        label: 'Active-power range',
        options: [
          { v: true, label: 'Bidirectional' },
          { v: false, label: 'Export only' },
        ],
        hint: 'Bidirectional lets the plant absorb during overfrequency (storage-capable).',
      },
    ],
  },
  {
    title: 'Frequency model',
    note: 'dynamic only',
    onlyDynamic: true,
    controls: [
      { key: 'H', label: 'System inertia', sym: 'H', min: 0.5, max: 10, step: 0.1, unit: 's', fmt: (n) => n.toFixed(1) },
      { key: 'D', label: 'Load damping', sym: 'D', min: 0, max: 4, step: 0.1, unit: 'pu', fmt: (n) => n.toFixed(1) },
      { key: 'Kg', label: 'Fleet governor gain', sym: 'Kg', min: 0, max: 40, step: 0.5, unit: 'pu', fmt: (n) => n.toFixed(1) },
      { key: 'Tg', label: 'Governor time constant', sym: 'Tg', min: 1, max: 15, step: 0.5, unit: 's', fmt: (n) => n.toFixed(1) },
      {
        key: 'r',
        label: 'Plant / system ratio',
        sym: 'r',
        min: 0.01,
        max: 0.4,
        step: 0.01,
        unit: '—',
        fmt: f2,
        hint: 'How much of the system this plant represents — sets how much its droop moves system frequency.',
      },
    ],
  },
];

const PRESETS = {
  ieee1547: {
    label: 'IEEE 1547-2018 defaults',
    patch: { kp: 33.3, dbF: 0.036, kq: 15, dbV: 0.02, Tp: 0.5, Tq: 1.0, qMax: 0.44, R: 0.05, X: 0.15 },
  },
  aggressive: {
    label: 'Aggressive fast support',
    patch: { kp: 90, dbF: 0.01, kq: 40, dbV: 0.005, Tp: 0.1, Tq: 0.15, qMax: 0.6, R: 0.05, X: 0.15 },
  },
  weak: {
    label: 'Weak grid — hunting risk',
    patch: { kp: 60, dbF: 0.02, kq: 45, dbV: 0.004, Tp: 0.2, Tq: 0.2, qMax: 0.6, R: 0.12, X: 0.5 },
  },
  conservative: {
    label: 'Conservative / wide deadband',
    patch: { kp: 16, dbF: 0.2, kq: 6, dbV: 0.04, Tp: 2, Tq: 4, qMax: 0.44, R: 0.05, X: 0.15 },
  },
  nosupport: {
    label: 'No grid support (baseline)',
    patch: { kp: 0, kq: 0, dbF: 0.036, dbV: 0.02, Tp: 0.5, Tq: 1.0 },
  },
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------------------
// sidebar
// ---------------------------------------------------------------------------

const valNodes = {};
const ctrlNodes = [];

function buildControls() {
  const host = $('#controls');
  host.textContent = '';

  for (const g of GROUPS) {
    const group = el('div', 'group');
    if (g.onlyDynamic) group.dataset.onlyDynamic = '1';
    const head = el('div', 'group-head');
    head.append(el('h3', null, g.title), el('span', null, g.note || ''));
    group.append(head);

    for (const c of g.controls) {
      if (c.type === 'event') {
        group.append(buildEventPicker());
        continue;
      }
      if (c.type === 'pills') {
        group.append(buildPills(c));
        continue;
      }
      group.append(buildSlider(c));
    }
    if (g.footer) {
      const f = el('p', 'ctrl-hint');
      f.id = g.footer;
      group.append(f);
    }
    host.append(group);
  }

  host.append(buildConfigGroup());
  syncDisabled();
}

function buildSlider(c) {
  const wrap = el('div', 'ctrl');
  const top = el('div', 'ctrl-top');
  top.append(
    el('span', 'ctrl-name', `${c.label} ${c.sym ? `<em>${c.sym}</em>` : ''}`),
    el('span', 'ctrl-val', `${c.fmt(cfg[c.key])} ${c.unit}`)
  );
  const input = el('input');
  input.type = 'range';
  input.min = c.min;
  input.max = c.max;
  input.step = c.step;
  input.value = cfg[c.key];
  input.setAttribute('aria-label', `${c.label} in ${c.unit}`);
  const valNode = top.lastChild;
  valNodes[c.key] = () => (valNode.textContent = `${c.fmt(cfg[c.key])} ${c.unit}`);
  input.addEventListener('input', () => {
    cfg[c.key] = parseFloat(input.value);
    valNodes[c.key]();
    onCfgChange(c.key);
  });
  wrap.append(top, input);
  if (c.hint) wrap.append(el('p', 'ctrl-hint', c.hint));
  ctrlNodes.push({ node: wrap, input, spec: c });
  return wrap;
}

function buildPills(c) {
  const wrap = el('div', 'ctrl');
  const top = el('div', 'ctrl-top');
  top.append(el('span', 'ctrl-name', c.label));
  const pills = el('div', 'pills');
  const btns = [];
  for (const o of c.options) {
    const b = el('button', 'pill', o.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(cfg[c.key] === o.v));
    b.addEventListener('click', () => {
      cfg[c.key] = o.v;
      btns.forEach((x, i) => x.setAttribute('aria-pressed', String(c.options[i].v === o.v)));
      onCfgChange(c.key);
      if (c.key === 'stiffF') {
        syncDisabled();
        reset();
      }
    });
    btns.push(b);
    pills.append(b);
  }
  valNodes[c.key] = () =>
    btns.forEach((x, i) => x.setAttribute('aria-pressed', String(c.options[i].v === cfg[c.key])));
  wrap.append(top, pills);
  if (c.hint) wrap.append(el('p', 'ctrl-hint', c.hint));
  ctrlNodes.push({ node: wrap, spec: c });
  return wrap;
}

function buildEventPicker() {
  const wrap = el('div', 'ctrl');
  const top = el('div', 'ctrl-top');
  top.append(el('span', 'ctrl-name', 'Transient scenario'));
  const sel = el('select');
  sel.setAttribute('aria-label', 'Transient scenario');
  for (const [k, v] of Object.entries(EVENTS)) {
    const o = el('option', null, v.label);
    o.value = k;
    sel.append(o);
  }
  sel.value = eventKey;
  const hint = el('p', 'ctrl-hint', EVENTS[eventKey].detail);
  sel.addEventListener('change', () => {
    eventKey = sel.value;
    hint.textContent = EVENTS[eventKey].detail;
    $('#cmpEvent').value = eventKey;
    reset();
  });
  wrap.append(top, sel, hint);
  return wrap;
}

function buildConfigGroup() {
  const group = el('div', 'group');
  const head = el('div', 'group-head');
  head.append(el('h3', null, 'Configurations'), el('span', null, 'save & compare'));
  group.append(head);

  const presetCtrl = el('div', 'ctrl');
  const ptop = el('div', 'ctrl-top');
  ptop.append(el('span', 'ctrl-name', 'Load preset'));
  const psel = el('select');
  psel.setAttribute('aria-label', 'Load preset');
  psel.append(el('option', null, 'Choose a preset…'));
  for (const [k, v] of Object.entries(PRESETS)) {
    const o = el('option', null, v.label);
    o.value = k;
    psel.append(o);
  }
  psel.addEventListener('change', () => {
    const p = PRESETS[psel.value];
    if (!p) return;
    Object.assign(cfg, p.patch);
    Object.values(valNodes).forEach((fn) => fn());
    ctrlNodes.forEach(({ input, spec }) => {
      if (input) input.value = cfg[spec.key];
    });
    reset();
    toast(`Loaded “${p.label}”`);
    psel.value = '';
  });
  presetCtrl.append(ptop, psel);

  const nameCtrl = el('div', 'ctrl');
  const ntop = el('div', 'ctrl-top');
  ntop.append(el('span', 'ctrl-name', 'Label'));
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'e.g. kq 40 fast';
  nameInput.setAttribute('aria-label', 'Configuration label');
  Object.assign(nameInput.style, {
    width: '100%',
    background: 'var(--c-surface-2)',
    border: '1px solid var(--c-border-strong)',
    borderRadius: 'var(--radius-sm)',
    padding: '7px 8px',
    fontSize: '12px',
  });
  nameCtrl.append(ntop, nameInput);

  const row = el('div', 'preset-row');
  const save = el('button', 'btn primary', 'Save current configuration');
  save.type = 'button';
  save.addEventListener('click', () => {
    saveConfig(nameInput.value.trim());
    nameInput.value = '';
  });
  const restore = el('button', 'btn ghost', 'Restore defaults');
  restore.type = 'button';
  restore.addEventListener('click', () => {
    Object.assign(cfg, DEFAULTS);
    Object.values(valNodes).forEach((fn) => fn());
    ctrlNodes.forEach(({ input, spec }) => {
      if (input) input.value = cfg[spec.key];
    });
    syncDisabled();
    reset();
    toast('Defaults restored');
  });
  row.append(save, restore);

  group.append(presetCtrl, nameCtrl, row);
  return group;
}

function syncDisabled() {
  document.querySelectorAll('[data-only-dynamic]').forEach((n) => {
    n.style.display = cfg.stiffF ? 'none' : '';
  });
  for (const { node, input, spec } of ctrlNodes) {
    if (!spec.onlyStiff) continue;
    const off = !cfg.stiffF;
    node.classList.toggle('is-off', off);
    if (input) input.disabled = off;
  }
  $('#sldMode').textContent = cfg.stiffF ? 'stiff grid' : 'dynamic grid';
}

function onCfgChange(key) {
  if (['R', 'X', 'H', 'D', 'Kg', 'Tg', 'r', 'Vs'].includes(key)) {
    // network / grid parameters are absorbed live; nothing else to do
  }
  updateSidebarReadouts();
}

function updateSidebarReadouts() {
  const gain = stabilityIndex(cfg);
  const netInfo = $('#netInfo');
  if (netInfo) {
    netInfo.innerHTML = `Short-circuit ratio ≈ <strong>${scr(cfg).toFixed(
      1
    )}</strong> · X/R = <strong>${(cfg.X / Math.max(cfg.R, 1e-6)).toFixed(
      1
    )}</strong>. Sensitivity dV/dQ = ${cfg.X.toFixed(3)} pu, dV/dP = ${cfg.R.toFixed(3)} pu.`;
  }
  const dInfo = $('#droopInfo');
  if (dInfo) {
    const droopPct = cfg.kp > 0 ? (100 / cfg.kp / F_NOM) * 100 : Infinity;
    const verdict =
      gain < 3 ? 'well damped' : gain < 8 ? 'moderately damped' : gain < 14 ? 'lightly damped — expect overshoot' : 'oscillatory — hunting likely';
    dInfo.innerHTML = `Equivalent P-f droop <strong>${
      isFinite(droopPct) ? droopPct.toFixed(1) + ' %' : 'disabled'
    }</strong> · Q-V loop gain X·dQ/dV = <strong>${gain.toFixed(2)}</strong> (${verdict}).`;
  }
}

// ---------------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------------

const KPI_DEFS = [
  { id: 'f', label: 'Frequency', color: '--c-f' },
  { id: 'v', label: 'PCC voltage', color: '--c-v' },
  { id: 'dv', label: 'Voltage support', color: '--c-v' },
  { id: 'p', label: 'Active power', color: '--c-p' },
  { id: 'q', label: 'Reactive power', color: '--c-q' },
  { id: 's', label: 'Rating used', color: '--c-accent' },
];

function buildKpis() {
  const host = $('#kpis');
  host.textContent = '';
  for (const k of KPI_DEFS) {
    const card = el('div', 'kpi');
    const lab = el('div', 'kpi-label');
    const dot = el('span', 'kpi-dot');
    dot.style.background = `var(${k.color})`;
    lab.append(dot, document.createTextNode(k.label));
    const val = el('div', 'kpi-value', '—');
    val.id = `kpi-${k.id}`;
    const sub = el('div', 'kpi-sub', '—');
    sub.id = `kpisub-${k.id}`;
    card.append(lab, val, sub);
    host.append(card);
  }
}

// ---------------------------------------------------------------------------
// simulation loop
// ---------------------------------------------------------------------------

let peak = { fmin: F_NOM, fmax: F_NOM, vmin: 1, vmax: 1, rocof: 0 };

function reset() {
  sim = initState(cfg);
  Object.values(rings).forEach((r) => r.clear());
  peak = { fmin: sim.f || F_NOM, fmax: sim.f || F_NOM, vmin: sim.vPcc, vmax: sim.vPcc, rocof: 0 };
  updateSidebarReadouts();
}

let lastFrame = performance.now();
function frame(now) {
  const wall = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  if (running) {
    const n = Math.max(1, Math.round(wall / DT));
    const ev = EVENTS[eventKey] || EVENTS.none;
    for (let i = 0; i < n; i++) {
      step(sim, cfg, DT, ev.apply(sim.t));
      if (i % 4 === 0) {
        rings.f.push(sim.t, sim.f);
        rings.v.push(sim.t, sim.vPcc);
        rings.vn.push(sim.t, sim.vNoSupport);
        rings.p.push(sim.t, sim.P);
        rings.q.push(sim.t, sim.Q);
      }
      peak.fmin = Math.min(peak.fmin, sim.f);
      peak.fmax = Math.max(peak.fmax, sim.f);
      peak.vmin = Math.min(peak.vmin, sim.vPcc);
      peak.vmax = Math.max(peak.vmax, sim.vPcc);
      peak.rocof = Math.max(peak.rocof, Math.abs(sim.rocof));
    }
  }
  render();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function setText(id, v) {
  const n = document.getElementById(id);
  if (n && n.textContent !== v) n.textContent = v;
}

function render() {
  const S = Math.hypot(sim.P, sim.Q);
  const pf = S > 1e-4 ? Math.abs(sim.P) / S : 1;

  setText('simTime', `${sim.t.toFixed(2)} s`);
  setText('kpi-f', `${sim.f.toFixed(3)}`);
  setText(
    'kpisub-f',
    `Hz · Δ ${((sim.f - F_NOM) * 1000).toFixed(0)} mHz · ROCOF ${sim.rocof.toFixed(2)}`
  );
  setText('kpi-v', `${sim.vPcc.toFixed(4)}`);
  setText(
    'kpisub-v',
    `pu · band ${peak.vmin.toFixed(3)}–${peak.vmax.toFixed(3)}`
  );
  const dv = sim.vPcc - sim.vNoSupport;
  setText('kpi-dv', `${dv >= 0 ? '+' : '−'}${Math.abs(dv * 100).toFixed(2)}`);
  setText('kpisub-dv', `% of nominal from Q/P injection`);
  setText('kpi-p', `${sim.P >= 0 ? '+' : '−'}${Math.abs(sim.P).toFixed(3)}`);
  setText('kpisub-p', `pu · ${sim.P >= 0 ? 'injecting' : 'absorbing'} · cmd ${sim.pCmd.toFixed(3)}`);
  setText('kpi-q', `${sim.Q >= 0 ? '+' : '−'}${Math.abs(sim.Q).toFixed(3)}`);
  setText(
    'kpisub-q',
    `pu · ${sim.Q >= 0 ? 'injecting' : 'absorbing'} · pf ${pf.toFixed(3)}`
  );
  setText('kpi-s', `${(S * 100).toFixed(1)}`);
  setText('kpisub-s', sim.clipped ? '% of rating · LIMIT ACTIVE' : `% of rating · ${(100 - S * 100).toFixed(1)}% headroom`);

  // single-line diagram
  setText('sldVs', `${(cfg.Vs + (EVENTS[eventKey].apply(sim.t).dVs || 0)).toFixed(3)} pu`);
  setText('sldZ', `${cfg.R.toFixed(2)}+j${cfg.X.toFixed(2)}`);
  setText('sldVpcc', `${sim.vPcc.toFixed(3)} pu`);
  setText('sldF', `${sim.f.toFixed(3)} Hz`);
  setText('sldP', `P ${sim.P >= 0 ? '+' : '−'}${Math.abs(sim.P).toFixed(2)} pu`);
  setText('sldQ', `Q ${sim.Q >= 0 ? '+' : '−'}${Math.abs(sim.Q).toFixed(2)} pu`);
  animateFlow();

  // chips
  const droopPct = cfg.kp > 0 ? (100 / cfg.kp / F_NOM) * 100 : Infinity;
  setText('chipDroopP', isFinite(droopPct) ? `${droopPct.toFixed(1)} % droop` : 'frequency-watt off');
  const gain = stabilityIndex(cfg);
  const chipQ = $('#chipDroopQ');
  chipQ.textContent = `loop gain ${gain.toFixed(2)}`;
  chipQ.className = 'chip ' + (gain > 12 ? 'warn' : gain > 0 ? 'ok' : '');
  setText('chipF', `nadir ${peak.fmin.toFixed(3)} Hz · peak ${peak.fmax.toFixed(3)} Hz`);
  setText('chipV', `min ${peak.vmin.toFixed(3)} · max ${peak.vmax.toFixed(3)} pu`);
  const chipS = $('#chipS');
  chipS.textContent = sim.clipped ? `S limit active — ${cfg.priority} priority` : `S = ${(S * 100).toFixed(1)} % of rating`;
  chipS.className = 'chip ' + (sim.clipped ? 'warn' : '');

  drawCurves();
  drawScopes();
}

let flowPhase = 0;
function animateFlow() {
  const speed = Math.max(Math.abs(sim.P), 0.02) * 90;
  flowPhase = (flowPhase + speed * 0.016) % 200;
  const dir = sim.P >= 0 ? -1 : 1; // injection flows toward the grid (leftwards)
  for (let i = 0; i < 2; i++) {
    const d = document.getElementById(`flowDot${i + 1}`);
    if (!d) continue;
    const base = (flowPhase + i * 100) % 200;
    const x = dir < 0 ? 320 - base * 1.14 : 92 + base * 1.14;
    d.setAttribute('cx', String(Math.max(94, Math.min(328, x))));
    d.setAttribute('fill', sim.P >= 0 ? cssVar('--c-p') : cssVar('--c-warn'));
    d.setAttribute('opacity', String(0.35 + 0.55 * Math.min(Math.abs(sim.P), 1)));
  }
}

function drawCurves() {
  // --- P–f ---
  const xs = [];
  const ys = [];
  for (let f = 57; f <= 63.0001; f += 0.02) {
    xs.push(f);
    ys.push(pRef(f, cfg));
  }
  plot($('#cPf'), {
    xDomain: [57, 63],
    yDomain: [-1.05, 1.05],
    yTicks: [-1, -0.5, 0, 0.5, 1],
    xTicks: [57, 58, 59, 60, 61, 62, 63],
    bands: [{ x0: F_NOM - cfg.dbF, x1: F_NOM + cfg.dbF, color: cssVar('--c-band') }],
    series: [{ x: xs, y: ys, color: cssVar('--c-p'), width: 2 }],
    markers: [{ x: sim.fM, y: sim.P, color: cssVar('--c-p') }],
    xLabel: 'f [Hz]',
    yLabel: 'P [pu]',
    fmtX: (n) => n.toFixed(0),
    fmtY: (n) => n.toFixed(1),
  });
  $('#footPf').innerHTML = `Operating point: f = <strong>${sim.fM.toFixed(
    3
  )} Hz</strong>, P = <strong>${sim.P.toFixed(3)} pu</strong> (command ${sim.pCmd.toFixed(
    3
  )}). Shaded band is the ±${cfg.dbF.toFixed(3)} Hz deadband.`;

  // --- Q–V ---
  const vx = [];
  const vy = [];
  for (let v = 0.86; v <= 1.1401; v += 0.001) {
    vx.push(v);
    vy.push(qRef(v, cfg));
  }
  const qLim = Math.max(cfg.qMax, 0.2) * 1.15;
  plot($('#cQv'), {
    xDomain: [0.86, 1.14],
    yDomain: [-qLim, qLim],
    bands: [{ x0: cfg.vRef - cfg.dbV, x1: cfg.vRef + cfg.dbV, color: cssVar('--c-band') }],
    series: [{ x: vx, y: vy, color: cssVar('--c-q'), width: 2 }],
    markers: [{ x: sim.vM, y: sim.Q, color: cssVar('--c-q') }],
    xLabel: 'V [pu]',
    yLabel: 'Q [pu]',
    fmtX: (n) => n.toFixed(2),
    fmtY: (n) => n.toFixed(2),
  });
  $('#footQv').innerHTML = `Operating point: V = <strong>${sim.vM.toFixed(
    4
  )} pu</strong>, Q = <strong>${sim.Q.toFixed(3)} pu</strong> (command ${sim.qCmd.toFixed(
    3
  )}). Slope ${(cfg.kq).toFixed(1)} % of rating per 0.01 pu, clipped at ±${cfg.qMax.toFixed(2)} pu.`;
}

function scopeDomain() {
  return sim.t <= WIN ? [0, WIN] : [sim.t - WIN, sim.t];
}

function pad(min, max, floorSpan) {
  const mid = (min + max) / 2;
  const span = Math.max(max - min, floorSpan) * 1.25;
  return [mid - span / 2, mid + span / 2];
}

function drawScopes() {
  const xd = scopeDomain();
  const evT = eventKey === 'none' ? [] : [{ x: 2, color: cssVar('--c-grid-strong') }];

  const fmin = Math.min(peak.fmin, F_NOM - 0.15);
  const fmax = Math.max(peak.fmax, F_NOM + 0.15);
  plot($('#cScopeF'), {
    xDomain: xd,
    yDomain: pad(fmin, fmax, 0.6),
    bands: [{ y0: 59.5, y1: 60.5, color: cssVar('--c-band') }],
    vlines: evT,
    series: [{ x: rings.f.x, y: rings.f.y, color: cssVar('--c-f'), width: 2 }],
    xLabel: 't [s]',
    yLabel: 'f [Hz]',
    fmtY: (n) => n.toFixed(2),
    fmtX: (n) => n.toFixed(0),
    legend: [{ label: 'f at PCC', color: cssVar('--c-f') }],
  });

  const vmin = Math.min(peak.vmin, 0.97);
  const vmax = Math.max(peak.vmax, 1.03);
  plot($('#cScopeV'), {
    xDomain: xd,
    yDomain: pad(vmin, vmax, 0.08),
    bands: [{ y0: 0.95, y1: 1.05, color: cssVar('--c-band') }],
    vlines: evT,
    series: [
      {
        x: rings.vn.x,
        y: rings.vn.y,
        color: cssVar('--c-text-faint'),
        width: 1.4,
        dash: [4, 3],
      },
      { x: rings.v.x, y: rings.v.y, color: cssVar('--c-v'), width: 2 },
    ],
    xLabel: 't [s]',
    yLabel: 'V [pu]',
    fmtY: (n) => n.toFixed(3),
    fmtX: (n) => n.toFixed(0),
    legend: [
      { label: 'V at PCC', color: cssVar('--c-v') },
      { label: 'no support', color: cssVar('--c-text-faint'), dash: [4, 3] },
    ],
  });

  plot($('#cScopePQ'), {
    xDomain: xd,
    yDomain: [-1.05, 1.05],
    yTicks: [-1, -0.5, 0, 0.5, 1],
    vlines: evT,
    series: [
      { x: rings.p.x, y: rings.p.y, color: cssVar('--c-p'), width: 2, fillTo: 0 },
      { x: rings.q.x, y: rings.q.y, color: cssVar('--c-q'), width: 2 },
    ],
    xLabel: 't [s]',
    yLabel: 'P, Q [pu]',
    fmtY: (n) => n.toFixed(1),
    fmtX: (n) => n.toFixed(0),
    legend: [
      { label: 'P', color: cssVar('--c-p') },
      { label: 'Q', color: cssVar('--c-q') },
    ],
  });
}

// ---------------------------------------------------------------------------
// saved configurations + comparison
// ---------------------------------------------------------------------------

// Configurations live in session memory — the preview iframe has no storage access.
function persist() {}

function restore() {}

function saveConfig(name) {
  if (saved.length >= 6) {
    toast('Six configurations max — delete one first');
    return;
  }
  seq += 1;
  saved.push({
    id: `c${Date.now()}`,
    name: name || `Config ${seq}`,
    cfg: { ...cfg },
    on: true,
  });
  persist();
  renderSaved();
  toast(`Saved “${saved[saved.length - 1].name}”`);
}

function renderSaved() {
  const host = $('#savedList');
  host.textContent = '';
  $('#tabCount').textContent = String(saved.length);
  if (!saved.length) {
    host.append(
      el(
        'div',
        'empty',
        'No configurations saved yet.<br />Set up the droop parameters you want to test, add a label in the sidebar, and press <strong>Save current configuration</strong>.'
      )
    );
    return;
  }
  saved.forEach((s, i) => {
    const row = el('div', 'saved');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = s.on;
    cb.setAttribute('aria-label', `Include ${s.name} in comparison`);
    cb.addEventListener('change', () => {
      s.on = cb.checked;
      persist();
    });

    const mid = el('div');
    const nameRow = el('div', 'saved-name');
    const sw = el('span', 'swatch');
    sw.style.background = cssVar(CMP_COLORS[i % CMP_COLORS.length]);
    nameRow.append(sw, document.createTextNode(s.name));
    const c = s.cfg;
    mid.append(
      nameRow,
      el(
        'div',
        'saved-meta',
        `kp ${c.kp.toFixed(1)} %/Hz · db_f ${c.dbF.toFixed(3)} Hz · Tp ${c.Tp.toFixed(2)} s<br />` +
          `kq ${c.kq.toFixed(1)} %/0.01pu · db_v ${c.dbV.toFixed(3)} pu · Tq ${c.Tq.toFixed(2)} s<br />` +
          `Z = ${c.R.toFixed(3)} + j${c.X.toFixed(3)} pu · SCR ${scr(c).toFixed(1)} · ${
            c.priority
          } priority · ${c.stiffF ? 'stiff' : 'dynamic'}`
      )
    );

    const actions = el('div', 'saved-actions');
    const load = el('button', 'link-btn', 'Load');
    load.addEventListener('click', () => {
      Object.assign(cfg, s.cfg);
      Object.values(valNodes).forEach((fn) => fn());
      ctrlNodes.forEach(({ input, spec }) => {
        if (input) input.value = cfg[spec.key];
      });
      syncDisabled();
      reset();
      toast(`Loaded “${s.name}”`);
    });
    const del = el('button', 'link-btn', 'Delete');
    del.addEventListener('click', () => {
      saved = saved.filter((x) => x.id !== s.id);
      persist();
      renderSaved();
    });
    actions.append(load, del);

    row.append(cb, mid, actions);
    host.append(row);
  });
}

const CMP_COLS = [
  { key: 'maxDf', label: 'max |Δf| mHz', dir: 'min', fmt: (m) => (m.maxDf * 1000).toFixed(0) },
  { key: 'rocof', label: 'max ROCOF Hz/s', dir: 'min', fmt: (m) => m.rocof.toFixed(3) },
  { key: 'maxDv', label: 'max |ΔV| pu', dir: 'min', fmt: (m) => m.maxDv.toFixed(4) },
  { key: 'vErrIntegral', label: 'Δ|V| integral pu·s', dir: 'min', fmt: (m) => m.vErrIntegral.toFixed(3) },
  { key: 'vSS', label: 'V steady pu', dir: null, fmt: (m) => m.vSS.toFixed(4) },
  {
    key: 'fSSdev',
    label: 'f steady Δ mHz',
    dir: null,
    fmt: (m) => (m.fSSdev * 1000).toFixed(0),
  },
  { key: 'pPeak', label: 'ΔP peak pu', dir: null, fmt: (m) => m.pPeak.toFixed(3) },
  { key: 'qPeak', label: '|Q| peak pu', dir: null, fmt: (m) => m.qPeak.toFixed(3) },
  { key: 'ripple', label: 'P ripple RMS pu', dir: 'min', fmt: (m) => m.ripple.toFixed(4) },
  { key: 'vRing', label: 'V ringing pu', dir: 'min', fmt: (m) => m.vRing.toFixed(4) },
  { key: 'clipTime', label: 'S-limit time s', dir: 'min', fmt: (m) => m.clipTime.toFixed(2) },
  { key: 'tSettleF', label: 'f settle s', dir: 'min', fmt: (m) => m.tSettleF.toFixed(1) },
  { key: 'tSettleV', label: 'V settle s', dir: 'min', fmt: (m) => m.tSettleV.toFixed(1) },
];

function runComparison() {
  const sel = saved.filter((s) => s.on);
  if (!sel.length) {
    toast('Select at least one saved configuration');
    return;
  }
  const evKey = $('#cmpEvent').value;
  cmp = sel.map((s, i) => {
    const { trace, metrics } = runScenario(s.cfg, evKey, WIN, DT, 12);
    metrics.maxDf = Math.max(Math.abs(metrics.fNadir - F_NOM), Math.abs(metrics.fPeak - F_NOM));
    metrics.maxDv = Math.max(
      Math.abs(metrics.vMin - s.cfg.vRef),
      Math.abs(metrics.vMax - s.cfg.vRef)
    );
    return { name: s.name, cfg: s.cfg, trace, metrics, color: CMP_COLORS[saved.indexOf(s) % CMP_COLORS.length] };
  });
  $('#cmpResults').classList.remove('is-hidden');
  $('#cmpEventChip').textContent = EVENTS[evKey].label.toLowerCase();
  renderCmpTable();
  drawCmp();
  toast(`Ran ${cmp.length} configuration${cmp.length > 1 ? 's' : ''}`);
}

function renderCmpTable() {
  const t = $('#cmpTable');
  t.textContent = '';
  const thead = el('thead');
  const hr = el('tr');
  hr.append(el('th', null, 'Configuration'));
  for (const c of CMP_COLS) hr.append(el('th', null, c.label));
  thead.append(hr);

  const best = {};
  for (const c of CMP_COLS) {
    if (!c.dir) continue;
    const vals = cmp.map((r) => r.metrics[c.key]).filter((v) => v !== null && v !== undefined);
    if (vals.length) best[c.key] = Math.min(...vals);
  }

  const tbody = el('tbody');
  for (const r of cmp) {
    const tr = el('tr');
    const nameTd = el('td');
    const wrap = el('div', 'row-name');
    const sw = el('span', 'swatch');
    sw.style.background = cssVar(r.color);
    wrap.append(sw, document.createTextNode(r.name));
    nameTd.append(wrap);
    tr.append(nameTd);
    for (const c of CMP_COLS) {
      const td = el('td', null, c.fmt(r.metrics));
      if (c.dir && Math.abs((r.metrics[c.key] ?? Infinity) - best[c.key]) < 1e-9) td.classList.add('best');
      tr.append(td);
    }
    tbody.append(tr);
  }
  t.append(thead, tbody);
}

function drawCmp() {
  if (!cmp) return;
  const mk = (field) =>
    cmp.map((r) => ({ x: r.trace.t, y: r.trace[field], color: cssVar(r.color), width: 1.8 }));
  const legend = cmp.map((r) => ({ label: r.name, color: cssVar(r.color) }));

  const allF = cmp.flatMap((r) => r.trace.f);
  const allV = cmp.flatMap((r) => r.trace.v);
  plot($('#cCmpF'), {
    xDomain: [0, WIN],
    yDomain: pad(Math.min(...allF, 59.85), Math.max(...allF, 60.15), 0.6),
    bands: [{ y0: 59.5, y1: 60.5, color: cssVar('--c-band') }],
    series: mk('f'),
    legend,
    xLabel: 't [s]',
    yLabel: 'f [Hz]',
    fmtY: (n) => n.toFixed(2),
    fmtX: (n) => n.toFixed(0),
  });
  plot($('#cCmpV'), {
    xDomain: [0, WIN],
    yDomain: pad(Math.min(...allV, 0.97), Math.max(...allV, 1.03), 0.08),
    bands: [{ y0: 0.95, y1: 1.05, color: cssVar('--c-band') }],
    series: mk('v'),
    legend,
    xLabel: 't [s]',
    yLabel: 'V [pu]',
    fmtY: (n) => n.toFixed(3),
    fmtX: (n) => n.toFixed(0),
  });
  plot($('#cCmpP'), {
    xDomain: [0, WIN],
    yDomain: [-1.05, 1.05],
    yTicks: [-1, -0.5, 0, 0.5, 1],
    series: mk('p'),
    legend,
    xLabel: 't [s]',
    yLabel: 'P [pu]',
    fmtY: (n) => n.toFixed(1),
    fmtX: (n) => n.toFixed(0),
  });
  plot($('#cCmpQ'), {
    xDomain: [0, WIN],
    yDomain: [-1.05, 1.05],
    yTicks: [-1, -0.5, 0, 0.5, 1],
    series: mk('q'),
    legend,
    xLabel: 't [s]',
    yLabel: 'Q [pu]',
    fmtY: (n) => n.toFixed(1),
    fmtX: (n) => n.toFixed(0),
  });
}

// ---------------------------------------------------------------------------
// chrome: tabs, theme, buttons
// ---------------------------------------------------------------------------

function initChrome() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => {
        t.classList.toggle('is-active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      document.querySelectorAll('.panel').forEach((p) => {
        p.classList.toggle('is-hidden', p.dataset.panel !== tab.dataset.tab);
      });
      if (tab.dataset.tab === 'compare') drawCmp();
    });
  });

  const sel = $('#cmpEvent');
  for (const [k, v] of Object.entries(EVENTS)) {
    const o = el('option', null, v.label);
    o.value = k;
    sel.append(o);
  }
  sel.value = eventKey;
  $('#btnCompare').addEventListener('click', runComparison);

  $('#btnRun').addEventListener('click', (e) => {
    running = !running;
    e.target.textContent = running ? 'Pause' : 'Run';
    e.target.setAttribute('aria-pressed', String(running));
  });
  $('#btnEvent').addEventListener('click', () => {
    reset();
    running = true;
    $('#btnRun').textContent = 'Pause';
    $('#btnRun').setAttribute('aria-pressed', 'true');
    toast(`${EVENTS[eventKey].label} armed at t = 2 s`);
  });
  $('#btnReset').addEventListener('click', () => {
    reset();
    toast('Bench reset');
  });

  const media = window.matchMedia('(prefers-color-scheme: light)');
  let theme = media.matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  $('#themeToggle').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    $('#themeIcon').setAttribute(
      'd',
      theme === 'dark'
        ? 'M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z'
        : 'M12 4.5v-2M12 21.5v-2M4.5 12h-2M21.5 12h-2M6.7 6.7 5.3 5.3M18.7 18.7l-1.4-1.4M6.7 17.3l-1.4 1.4M18.7 5.3l-1.4 1.4M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z'
    );
    drawCmp();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') {
      e.preventDefault();
      $('#btnRun').click();
    }
    if (e.key === 'r') $('#btnReset').click();
    if (e.key === 'e') $('#btnEvent').click();
  });

  window.addEventListener('resize', () => {
    if (cmp) drawCmp();
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

restore();
buildControls();
buildKpis();
initChrome();
renderSaved();
updateSidebarReadouts();
reset();
requestAnimationFrame((t) => {
  lastFrame = t;
  frame(t);
});
