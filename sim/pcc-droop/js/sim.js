// ---------------------------------------------------------------------------
// PCC droop-response engine
//
// Per-unit on the inverter apparent-power base (S_rated = 1.0 pu).
// Grid is represented by a Thevenin source behind line impedance R + jX,
// plus a reduced-order frequency model (swing equation + aggregate governor).
//
//   V_pcc  =  Vs + R*P_inv + X*Q_inj            (linearised voltage rise)
//   2H dw  =  Pg + r*(P_inv - P_inv0) - dPload - D*w
//   Tg dPg = -Pg - Kg*w                          (rest-of-fleet primary reserve)
//   Tp dP  =  P_ref(f_meas) - P                  (IEEE 1547 open-loop response)
//   Tq dQ  =  Q_ref(V_meas) - Q
// ---------------------------------------------------------------------------

export const F_NOM = 60.0;

export const DEFAULTS = {
  // droop / deadband
  kp: 33.3, // % P_rated per Hz  (33.3 %/Hz == 5 % droop)
  kq: 15.0, // % Q_rated per 0.01 pu V
  dbF: 0.036, // Hz deadband (IEEE 1547 default 0.036 Hz)
  dbV: 0.02, // pu deadband
  Tp: 0.5, // s  open-loop response time, frequency-watt
  Tq: 1.0, // s  open-loop response time, volt-var
  vRef: 1.0, // pu voltage reference
  P0: 0.55, // pu pre-disturbance dispatch
  qMax: 0.44, // pu reactive capability (44 % of rating, per IEEE 1547 cat B)
  bidirP: true, // storage-capable: P may go negative
  priority: 'Q', // apparent-power priority when S limit binds: 'P' | 'Q'
  // network
  R: 0.05, // pu line resistance (inverter base)
  X: 0.15, // pu line reactance  -> SCR ~ 6.3
  Vs: 1.0, // pu Thevenin source magnitude
  // grid frequency model
  H: 4.0, // s  system inertia constant
  D: 1.5, // pu/pu load damping
  Kg: 20.0, // pu/pu aggregate governor gain (5 % droop)
  Tg: 5.0, // s  governor time constant
  r: 0.08, // inverter rating / system base
  // measurement
  Tm: 0.02, // s  f and V measurement filter
  // grid representation
  stiffF: false, // true: frequency is an imposed input (slider-driven)
  fOffset: 0, // Hz sustained frequency bias, stiff mode only
};

export const EVENTS = {
  freqDrop: {
    label: 'Frequency drop',
    detail: 'Generation trip — 0.08 pu load/gen imbalance at t = 2 s',
    apply: (t) => ({ dPload: t >= 2 ? 0.08 : 0, dVs: 0, df: t >= 2 ? -0.8 : 0 }),
  },
  freqRise: {
    label: 'Frequency rise',
    detail: 'Load rejection — −0.06 pu imbalance at t = 2 s',
    apply: (t) => ({ dPload: t >= 2 ? -0.06 : 0, dVs: 0, df: t >= 2 ? 0.5 : 0 }),
  },
  voltSag: {
    label: 'Voltage sag',
    detail: 'Source steps to 0.92 pu at t = 2 s, recovers at t = 8 s',
    apply: (t) => ({ dPload: 0, dVs: t >= 2 && t < 8 ? -0.08 : 0 }),
  },
  voltSwell: {
    label: 'Voltage swell',
    detail: 'Source steps to 1.07 pu at t = 2 s, holds',
    apply: (t) => ({ dPload: 0, dVs: t >= 2 ? 0.07 : 0 }),
  },
  combined: {
    label: 'Combined event',
    detail: 'Voltage sag at t = 2 s, frequency drop at t = 6 s',
    apply: (t) => ({
      dPload: t >= 6 ? 0.07 : 0,
      dVs: t >= 2 && t < 9 ? -0.07 : 0,
      df: t >= 6 ? -0.7 : 0,
    }),
  },
  ramp: {
    label: 'Slow source drift',
    detail: 'Source magnitude drifts 1.00 → 1.06 pu over 12 s',
    apply: (t) => ({ dPload: 0, dVs: Math.min(Math.max((t - 2) / 12, 0), 1) * 0.06 }),
  },
  none: {
    label: 'Manual / quiescent',
    detail: 'No scripted event — drive the plant with the sliders',
    apply: () => ({ dPload: 0, dVs: 0 }),
  },
};

// deadband with slope continuation (no step at the edge)
export function deadband(x, db) {
  if (x > db) return x - db;
  if (x < -db) return x + db;
  return 0;
}

// ---- static characteristics (used by the curve plots) ----------------------

export function pRef(f, c) {
  const e = deadband(f - F_NOM, c.dbF);
  const p = c.P0 - (c.kp / 100) * e;
  const min = c.bidirP ? -1 : 0;
  return Math.min(Math.max(p, min), 1);
}

export function qRef(v, c) {
  const e = deadband(v - c.vRef, c.dbV);
  const q = -(c.kq / 100) * (e / 0.01);
  return Math.min(Math.max(q, -c.qMax), c.qMax);
}

// apparent-power limiter with selectable priority
export function limitS(p, q, c) {
  const s = Math.hypot(p, q);
  if (s <= 1.0 + 1e-9) return [p, q, false];
  if (c.priority === 'P') {
    const pl = Math.min(Math.abs(p), 1.0) * Math.sign(p);
    const room = Math.sqrt(Math.max(1 - pl * pl, 0));
    return [pl, Math.min(Math.abs(q), room) * Math.sign(q), true];
  }
  const ql = Math.min(Math.abs(q), Math.min(1.0, c.qMax)) * Math.sign(q);
  const room = Math.sqrt(Math.max(1 - ql * ql, 0));
  return [Math.min(Math.abs(p), room) * Math.sign(p), ql, true];
}

// ---- dynamic model --------------------------------------------------------

export function initState(c) {
  const w0 = c.stiffF ? c.fOffset / F_NOM : 0;
  const f0 = F_NOM * (1 + w0);

  // Pre-disturbance operating point. V and Q are coupled through the network, so
  // this is a fixed point: V = Vs + R·P + X·Q(V). Successive substitution diverges
  // once the loop gain X·dQ/dV exceeds 1, so bisect on the residual instead —
  // it is monotone decreasing in V, hence a single root.
  const residual = (v) => {
    const [p, q] = limitS(pRef(f0, c), qRef(v, c), c);
    return c.Vs + c.R * p + c.X * q - v;
  };
  let lo = 0.2;
  let hi = 2.0;
  for (let i = 0; i < 90; i++) {
    const mid = 0.5 * (lo + hi);
    if (residual(mid) > 0) lo = mid;
    else hi = mid;
  }
  const v = 0.5 * (lo + hi);
  const [p, q] = limitS(pRef(f0, c), qRef(v, c), c);

  return {
    t: 0,
    w: w0, // pu frequency deviation
    Pg: 0, // governor output
    P: p,
    Q: q,
    vM: v, // filtered voltage measurement
    fM: f0,
    vPcc: v,
    P0eq: p,
    clipped: false,
  };
}

export function step(s, c, dt, dist) {
  const dPload = dist.dPload || 0;
  const dVs = dist.dVs || 0;

  // --- network: algebraic PCC voltage from the injections -------------------
  const vs = c.Vs + dVs;
  const vPcc = vs + c.R * s.P + c.X * s.Q;

  // --- measurement filters -------------------------------------------------
  const f = F_NOM * (1 + s.w);
  s.vM += (dt / c.Tm) * (vPcc - s.vM);
  s.fM += (dt / c.Tm) * (f - s.fM);

  // --- droop references + apparent-power limit -----------------------------
  const [pCmd, qCmd, clipped] = limitS(pRef(s.fM, c), qRef(s.vM, c), c);

  // --- inverter response lag ----------------------------------------------
  s.P += (dt / Math.max(c.Tp, 0.02)) * (pCmd - s.P);
  s.Q += (dt / Math.max(c.Tq, 0.02)) * (qCmd - s.Q);

  // --- grid frequency ------------------------------------------------------
  let dw;
  if (c.stiffF) {
    // imposed frequency: slider bias + scripted event, 0.15 s ramp
    const target = (c.fOffset + (dist.df || 0)) / F_NOM;
    dw = (target - s.w) / 0.15;
    s.w += dt * dw;
  } else {
    // swing equation + aggregate governor of the rest of the fleet
    const dPinv = c.r * (s.P - s.P0eq);
    dw = (s.Pg + dPinv - dPload - c.D * s.w) / (2 * c.H);
    s.w += dt * dw;
    s.Pg += (dt / c.Tg) * (-s.Pg - c.Kg * s.w);
  }

  s.t += dt;
  s.vPcc = vPcc;
  s.clipped = clipped;
  s.f = F_NOM * (1 + s.w);
  s.rocof = dw * F_NOM;
  s.pCmd = pCmd;
  s.qCmd = qCmd;
  s.vNoSupport = vs; // voltage that would exist with no injection at all
  return s;
}

// ---- headless run (comparison mode) ------------------------------------

export function runScenario(c, eventKey, tEnd = 20, dt = 0.002, sampleEvery = 10) {
  const ev = EVENTS[eventKey] || EVENTS.none;
  const s = initState(c);
  const trace = { t: [], f: [], v: [], p: [], q: [] };
  const m = {
    fNadir: F_NOM,
    fPeak: F_NOM,
    rocof: 0,
    vMin: s.vPcc,
    vMax: s.vPcc,
    vSS: s.vPcc,
    pPeak: 0,
    qPeak: 0,
    vErrIntegral: 0,
    clipTime: 0,
    vRing: 0,
  };
  const n = Math.round(tEnd / dt);
  // ringing index: path length V travels after the disturbance, minus the net move.
  // Zero for a monotone recovery, and grows with every reversal — this is what
  // catches volt-var hunting on a weak line, which decays too fast to show up in
  // steady-state ripple.
  // Measured on the support component V − V_no-support, so the disturbance's own
  // path does not count — only what the inverter's own response adds.
  let vPrev = 0;
  let vAtEvent = 0;
  let vTravel = 0;
  let dPrevSet = false;
  for (let i = 0; i < n; i++) {
    step(s, c, dt, ev.apply(s.t));
    const dSup = s.vPcc - s.vNoSupport;
    if (s.t > 1.9) {
      if (!dPrevSet) {
        vPrev = dSup;
        vAtEvent = dSup;
        dPrevSet = true;
      }
      vTravel += Math.abs(dSup - vPrev);
      vPrev = dSup;
    }
    if (s.t > 1.0) {
      m.fNadir = Math.min(m.fNadir, s.f);
      m.fPeak = Math.max(m.fPeak, s.f);
      m.rocof = Math.max(m.rocof, Math.abs(s.rocof));
      m.vMin = Math.min(m.vMin, s.vPcc);
      m.vMax = Math.max(m.vMax, s.vPcc);
      m.pPeak = Math.max(m.pPeak, Math.abs(s.P - s.P0eq));
      m.qPeak = Math.max(m.qPeak, Math.abs(s.Q));
      m.vErrIntegral += Math.abs(s.vPcc - c.vRef) * dt;
      if (s.clipped) m.clipTime += dt;
    }
    if (i % sampleEvery === 0) {
      trace.t.push(s.t);
      trace.f.push(s.f);
      trace.v.push(s.vPcc);
      trace.p.push(s.P);
      trace.q.push(s.Q);
    }
  }
  m.fSS = s.f;
  m.vSS = s.vPcc;
  m.pSS = s.P;
  m.qSS = s.Q;
  m.fSSdev = s.f - F_NOM;

  // Settling time: last instant the signal is still outside a 5 % band around its
  // own final value (droop leaves a legitimate steady-state offset, so absolute
  // bands would never be met).
  const settle = (arr, final, floor) => {
    const tol = Math.max(floor, 0.05 * Math.abs(final - arr[0]));
    let t = 0;
    for (let i = 0; i < arr.length; i++) {
      if (Math.abs(arr[i] - final) > tol) t = trace.t[i];
    }
    return t;
  };
  m.tSettleF = settle(trace.f, m.fSS, 0.01);
  m.tSettleV = settle(trace.v, m.vSS, 0.001);
  m.vRing = Math.max(0, vTravel - Math.abs(s.vPcc - s.vNoSupport - vAtEvent));
  // ripple / oscillation index: RMS of P about its local mean, last 60 %
  const start = Math.floor(trace.p.length * 0.4);
  const seg = trace.p.slice(start);
  const mean = seg.reduce((a, b) => a + b, 0) / Math.max(seg.length, 1);
  m.ripple = Math.sqrt(seg.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(seg.length, 1));
  return { trace, metrics: m };
}

// Small-signal stability of the Q–V loop:  loop gain = X * dQ/dV
export function stabilityIndex(c) {
  const slope = (c.kq / 100) / 0.01; // pu Q per pu V
  return c.X * slope; // >1 means the voltage feedback loop is regenerative
}

export function scr(c) {
  return 1 / Math.max(Math.hypot(c.R, c.X), 1e-6);
}
