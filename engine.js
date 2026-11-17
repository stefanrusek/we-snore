// We Snore™ engine: pure DSP + clustering, no DOM. Runs in the browser and in Node.
//
// Pipeline: mono audio (~16 kHz) -> 64 ms Hann frames -> FFT -> 32 mel bands
//   -> adaptive noise floor -> sound events (0.25–5 s bursts above the floor)
//   -> rhythm check (snores come in trains) -> per-event "snoreprint"
//   (12 mel-cepstral coefficients of the noise-subtracted spectrum, i.e. the
//   shape of the airway's resonances, + loudness + pitch) -> k-means, with k
//   chosen by silhouette score up to the number of sleepers in the room. A
//   split is only accepted if there is a real density gap between the groups,
//   so one snorer with a variable snore is not turned into two people.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFFT(N) {
  const bits = Math.log2(N);
  const rev = new Uint32Array(N), cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / N); sin[i] = Math.sin((2 * Math.PI * i) / N); }
  return (re, im) => {
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let s = 0; s < N; s += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = s + j, b = a + half;
          const tr = re[b] * cos[k] + im[b] * sin[k], ti = im[b] * cos[k] - re[b] * sin[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

const mel = (f) => 2595 * Math.log10(1 + f / 700);
const imel = (m) => 700 * (10 ** (m / 2595) - 1);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

export const NB = 32;      // mel bands
export const NC = 12;      // cepstral coefficients in a snoreprint
const WL = 0.5, WP = 1.0;  // feature weights: loudness (per dB), pitch (per semitone)
const DCT = Array.from({ length: NC }, (_, j) => Float64Array.from({ length: NB }, (_, b) => (2 / NB) * Math.cos((Math.PI * (j + 1) * (b + 0.5)) / NB)));

export class SnoreEngine {
  constructor(fs, opts = {}) {
    this.fs = fs;
    const N = (this.N = 1024);
    this.hop = 512;
    this.dt = this.hop / fs;
    this.cfg = Object.assign({ onDb: 7, offDb: 4, hang: 5, minDur: 0.25, maxDur: 5 }, opts);
    this.fft = makeFFT(N);
    this.win = new Float32Array(N);
    let w2 = 0;
    for (let i = 0; i < N; i++) { this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); w2 += this.win[i] ** 2; }
    this.norm = 2 / (N * w2);
    this.buf = new Float32Array(N); this.fill = 0;
    this.re = new Float64Array(N); this.im = new Float64Array(N);
    this.P = new Float64Array(N / 2);
    this.y = new Float32Array(N / 2); this.acf = new Float32Array(N / 2 + 2);

    const binHz = fs / N, fmin = 60, fmax = Math.min(4000, fs * 0.47);
    this.kLo = Math.ceil(fmin / binHz); this.kHi = Math.floor(fmax / binHz);
    const pts = [];
    for (let i = 0; i < NB + 2; i++) pts.push(imel(mel(fmin) + ((mel(fmax) - mel(fmin)) * i) / (NB + 1)));
    this.bandHz = pts.slice(1, NB + 1);
    this.fb = [];
    for (let b = 0; b < NB; b++) {
      const [lo, mid, hi] = [pts[b], pts[b + 1], pts[b + 2]], ks = [], ws = [];
      for (let k = Math.floor(lo / binHz); k <= Math.ceil(hi / binHz); k++) {
        const f = k * binHz, w = f <= mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid);
        if (w > 0) { ks.push(k); ws.push(w); }
      }
      if (!ks.length) { ks.push(Math.round(mid / binHz)); ws.push(1); }
      this.fb.push({ ks, ws });
    }
    this.bandPow = new Float64Array(NB); this.bandDb = new Float32Array(NB);
    this.noiseDb = new Float32Array(NB); this.rel = new Float32Array(NB);
    this.floor = null;
    this.ring = new Float32Array(Math.round(fs * 8)); this.total = 0;
    this.frame = 0; this.cur = null;
    this.events = [];
    this.onFrame = null; this.onEvent = null;
  }

  get time() { return this.total / this.fs; }

  push(x) {
    const { buf, N, hop, ring } = this, R = ring.length;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      ring[this.total % R] = v; this.total++;
      buf[this.fill++] = v;
      if (this.fill === N) { this._frame(); buf.copyWithin(0, hop); this.fill = N - hop; }
    }
  }

  _frame() {
    const { N, re, im, win, buf, P, cfg } = this;
    for (let i = 0; i < N; i++) { re[i] = buf[i] * win[i]; im[i] = 0; }
    this.fft(re, im);
    let tot = 0;
    for (let k = 1; k < N / 2; k++) { P[k] = re[k] * re[k] + im[k] * im[k]; if (k >= this.kLo && k <= this.kHi) tot += P[k]; }
    const pow = tot * this.norm, db = 10 * Math.log10(pow + 1e-12);
    for (let b = 0; b < NB; b++) {
      const { ks, ws } = this.fb[b]; let s = 0;
      for (let j = 0; j < ks.length; j++) s += ws[j] * P[ks[j]];
      this.bandPow[b] = s * this.norm; this.bandDb[b] = 10 * Math.log10(s * this.norm + 1e-13);
    }
    const cur = this.cur, f = this.frame++;
    // Noise floor: drops fast, creeps up slowly (fast if a "sound" never ends, i.e. it's the new ambient).
    if (this.floor === null) { this.floor = db; this.noiseDb.set(this.bandDb); }
    else {
      const down = f < 1 / this.dt ? 1 : 0.15, up = cur && cur.bad ? 0.1 : 0.008;
      this.floor += db < this.floor ? down * (db - this.floor) : up;
      for (let b = 0; b < NB; b++) {
        const d = this.bandDb[b] - this.noiseDb[b];
        this.noiseDb[b] += d < 0 ? down * d : up;
      }
    }
    if (!cur) {
      if (db > this.floor + cfg.onDb && f > 1 / this.dt) {
        this.cur = { start: f, last: f, n: 0, sum: 0, peak: -Infinity, acc: new Float64Array(NB), f0s: [], floor: this.floor, noise: Float32Array.from(this.noiseDb), bad: false };
        this._accum(this.cur, pow, db);
      }
    } else {
      if (db > this.floor + cfg.offDb) { cur.last = f; if (!cur.bad) this._accum(cur, pow, db); }
      else if (f - cur.last > cfg.hang) { this.cur = null; this._finish(cur); }
      if ((f - cur.start) * this.dt > cfg.maxDur) cur.bad = true;
    }
    if (this.onFrame) {
      for (let b = 0; b < NB; b++) this.rel[b] = this.bandDb[b] - this.noiseDb[b];
      this.onFrame(this.rel, db, this.floor, !!this.cur);
    }
  }

  _accum(cur, pow, db) {
    for (let b = 0; b < NB; b++) cur.acc[b] += this.bandPow[b];
    cur.sum += pow; if (db > cur.peak) cur.peak = db;
    if (cur.n++ % 2 === 0) { const p = this._pitch(); if (p) cur.f0s.push(p); }
  }

  // Autocorrelation pitch (45–400 Hz) on the frame, decimated x2.
  _pitch() {
    const x = this.buf, y = this.y, M = this.N / 2, fs2 = this.fs / 2, r = this.acf;
    let mean = 0;
    for (let i = 0; i < M; i++) { y[i] = (x[2 * i] + x[2 * i + 1]) / 2; mean += y[i]; }
    mean /= M;
    let r0 = 0;
    for (let i = 0; i < M; i++) { y[i] -= mean; r0 += y[i] * y[i]; }
    if (r0 < 1e-12) return 0;
    const lo = Math.max(2, Math.floor(fs2 / 400)), hi = Math.min(M / 2, Math.ceil(fs2 / 45));
    let best = 0;
    for (let lag = lo - 1; lag <= hi + 1; lag++) {
      let s = 0; const L = M - lag;
      for (let i = 0; i < L; i++) s += y[i] * y[i + lag];
      r[lag] = (s / r0) * (M / L);
      if (lag >= lo && lag <= hi && r[lag] > best) best = r[lag];
    }
    if (best < 0.4) return 0;
    for (let lag = lo; lag <= hi; lag++) {
      if (r[lag] >= 0.85 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
        const den = r[lag - 1] - 2 * r[lag] + r[lag + 1]; // parabolic peak interpolation
        return fs2 / (lag + (den < 0 ? (0.5 * (r[lag - 1] - r[lag + 1])) / den : 0));
      }
    }
    return 0;
  }

  _finish(cur) {
    const dur = (cur.last - cur.start + 1) * this.dt;
    if (cur.bad || dur < this.cfg.minDur || !cur.n) return;
    const shape = new Float32Array(NB);
    let m = 0, cw = 0, cs = 0;
    for (let b = 0; b < NB; b++) {
      const p = cur.acc[b] / cur.n, clean = Math.max(p - 10 ** (cur.noise[b] / 10), 0.05 * p);
      shape[b] = 10 * Math.log10(clean + 1e-13); m += shape[b];
      cw += clean; cs += clean * this.bandHz[b];
    }
    m /= NB;
    for (let b = 0; b < NB; b++) shape[b] = Math.max(shape[b] - m, -30);
    // Low-order cepstrum: keeps the resonance envelope, drops the pitch harmonics.
    const cep = new Float32Array(NC);
    for (let j = 0; j < NC; j++) { let s = 0; for (let b = 0; b < NB; b++) s += DCT[j][b] * shape[b]; cep[j] = s; }
    const level = 10 * Math.log10(cur.sum / cur.n + 1e-12);
    const R = this.ring.length, pad = Math.round(0.2 * this.fs);
    const s0 = Math.max(0, cur.start * this.hop - pad, this.total - R), s1 = Math.min(this.total, (cur.last + 1) * this.hop + this.N + pad);
    const clip = new Float32Array(Math.max(0, s1 - s0));
    for (let i = 0; i < clip.length; i++) clip[i] = this.ring[(s0 + i) % R];
    const e = {
      t: cur.start * this.dt, dur, level, snr: level - cur.floor, peak: cur.peak - cur.floor,
      f0: cur.f0s.length >= 2 ? median(cur.f0s) : 0, cen: cs / (cw || 1), cep, clip, ok: false, c: -1,
    };
    this.events.push(e);
    if (this.onEvent) this.onEvent(e);
  }

  // Confirm rhythmic events, cluster them into snorers. Sets e.ok / e.c on every event.
  analyze(maxK = 2) {
    const ev = this.events;
    let lo = 0, hi = 0;
    for (let i = 0; i < ev.length; i++) {
      while (ev[i].t - ev[lo].t > 30) lo++;
      if (hi < i) hi = i;
      while (hi + 1 < ev.length && ev[hi + 1].t - ev[i].t <= 30) hi++;
      ev[i].ok = hi - lo >= 2; ev[i].c = -1;
    }
    const idx = [];
    for (let i = 0; i < ev.length; i++) if (ev[i].ok) idx.push(i);
    const n = idx.length;
    if (!n) return { k: 0, clusters: [] };
    const medF0 = median(idx.map((i) => ev[i].f0).filter((f) => f > 0)) || 100;
    const st = (f) => 12 * Math.log2((f || medF0) / 100);
    const X = idx.map((i) => {
      const e = ev[i], v = new Float32Array(NC + 2);
      v.set(e.cep); v[NC] = e.level * WL; v[NC + 1] = st(e.f0) * WP;
      return v;
    });
    const rnd = mulberry32(1234);
    let best = { k: 1, a: new Int32Array(n), score: 0.2 }; // a split must beat this silhouette
    if (n >= 8) {
      for (let k = 2; k <= maxK; k++) {
        const km = kmeans(X, k, rnd), cnt = new Array(k).fill(0);
        for (let i = 0; i < n; i++) cnt[km.a[i]]++;
        if (Math.min(...cnt) < Math.max(3, 0.04 * n) || gapless(X, km.a, k) > 0.06) continue;
        const score = silhouette(X, km.a, k);
        if (score > best.score + (best.k > 1 ? 0.05 : 0)) best = { k, a: km.a, score };
      }
    }
    const k = best.k, groups = Array.from({ length: k }, () => []);
    for (let i = 0; i < n; i++) groups[best.a[i]].push(i);
    const clusters = groups.map((g) => {
      const vec = new Array(NC + 2).fill(0);
      for (const i of g) for (let d = 0; d < NC + 2; d++) vec[d] += X[i][d] / g.length;
      return { g, n: g.length, vec: vec.map((v) => +v.toFixed(3)), cen: g.reduce((s, i) => s + ev[idx[i]].cen, 0) / g.length };
    }).sort((p, q) => p.cen - q.cen); // deepest snorer first: stable ordering between re-runs
    clusters.forEach((c, ci) => {
      const members = c.g.map((i) => ev[idx[i]]);
      for (const e of members) e.c = ci;
      members.sort((p, q) => q.snr - p.snr).slice(8).forEach((e) => { e.clip = null; }); // keep the 8 clearest samples
      delete c.g;
    });
    const tNow = this.time;
    for (const e of ev) if (!e.ok && tNow - e.t > 60) e.clip = null;
    return { k, clusters, score: best.score };
  }
}

function dist2(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return s; }

function kmeans(X, k, rnd) {
  const n = X.length, d = X[0].length;
  let best = null;
  for (let rep = 0; rep < 4; rep++) {
    const C = [Float64Array.from(X[Math.floor(rnd() * n)])], d2 = new Float64Array(n).fill(Infinity);
    while (C.length < k) {
      let sum = 0; const c = C[C.length - 1];
      for (let i = 0; i < n; i++) { const v = dist2(X[i], c); if (v < d2[i]) d2[i] = v; sum += d2[i]; }
      let r = rnd() * sum, pick = n - 1;
      for (let i = 0; i < n; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
      C.push(Float64Array.from(X[pick]));
    }
    const a = new Int32Array(n); let inertia = 0;
    for (let it = 0; it < 30; it++) {
      let changed = false; inertia = 0;
      for (let i = 0; i < n; i++) {
        let bj = 0, bv = Infinity;
        for (let j = 0; j < k; j++) { const v = dist2(X[i], C[j]); if (v < bv) { bv = v; bj = j; } }
        if (a[i] !== bj) { a[i] = bj; changed = true; }
        inertia += bv;
      }
      if (!changed && it) break;
      const cnt = new Array(k).fill(0), S = Array.from({ length: k }, () => new Float64Array(d));
      for (let i = 0; i < n; i++) { cnt[a[i]]++; for (let j = 0; j < d; j++) S[a[i]][j] += X[i][j]; }
      for (let j = 0; j < k; j++) if (cnt[j]) for (let q = 0; q < d; q++) C[j][q] = S[j][q] / cnt[j];
    }
    if (!best || inertia < best.inertia) best = { a, inertia };
  }
  return best;
}

// Worst-case share of points sitting in the no-man's-land between two cluster centres
// (middle fifth of the line joining them). Genuinely different snorers leave it empty;
// an arbitrary cut through one snorer's cloud does not.
function gapless(X, a, k) {
  const n = X.length, d = X[0].length, C = Array.from({ length: k }, () => new Float64Array(d)), cnt = new Array(k).fill(0);
  for (let i = 0; i < n; i++) { cnt[a[i]]++; for (let j = 0; j < d; j++) C[a[i]][j] += X[i][j]; }
  for (let c = 0; c < k; c++) for (let j = 0; j < d; j++) C[c][j] /= cnt[c];
  let worst = 0;
  for (let p = 0; p < k; p++) for (let q = p + 1; q < k; q++) {
    const D2 = dist2(C[p], C[q]);
    let mid = 0;
    for (let i = 0; i < n; i++) {
      if (a[i] !== p && a[i] !== q) continue;
      let dot = 0;
      for (let j = 0; j < d; j++) dot += (X[i][j] - C[p][j]) * (C[q][j] - C[p][j]);
      const u = dot / D2;
      if (u > 0.4 && u < 0.6) mid++;
    }
    // Centres closer than ~3 dB / 3 semitones are the same person, whatever the statistics say.
    worst = Math.max(worst, D2 < 9 ? 1 : mid / (cnt[p] + cnt[q]));
  }
  return worst;
}

function silhouette(X, a, k) {
  const n = X.length, step = Math.max(1, Math.floor(n / 300)), S = [];
  for (let i = 0; i < n; i += step) S.push(i);
  let tot = 0;
  for (const i of S) {
    const sum = new Float64Array(k), cnt = new Float64Array(k);
    for (const j of S) if (j !== i) { sum[a[j]] += Math.sqrt(dist2(X[i], X[j])); cnt[a[j]]++; }
    if (!cnt[a[i]]) continue;
    const own = sum[a[i]] / cnt[a[i]];
    let other = Infinity;
    for (let c = 0; c < k; c++) if (c !== a[i] && cnt[c]) other = Math.min(other, sum[c] / cnt[c]);
    if (other < Infinity) tot += (other - own) / Math.max(own, other);
  }
  return tot / S.length;
}

// Distance between two snoreprints, ignoring loudness (phone placement changes night to night).
export function profileDist(a, b) {
  if (!a || !b || a.length !== NC + 2 || b.length !== NC + 2) return Infinity;
  let s = 0;
  for (let i = 0; i < NC; i++) s += (a[i] - b[i]) ** 2;
  s += (a[NC + 1] - b[NC + 1]) ** 2;
  return Math.sqrt(s);
}

// labels: one {name, emoji, color, matched} per cluster. Clusters sharing a name are merged into one person.
export function buildReport(events, labels, { startMs, durSec, mode = 'live', vecs = [] }) {
  const nb = Math.max(12, Math.min(96, Math.ceil(durSec / 60))), binSec = durSec / nb;
  const byName = new Map();
  labels.forEach((l, c) => {
    if (!byName.has(l.name)) byName.set(l.name, { name: l.name, emoji: l.emoji, color: l.color, matched: !!l.matched, clusters: [], vec: vecs[c] });
    byName.get(l.name).clusters.push(c);
  });
  let people = [];
  for (const p of byName.values()) {
    const evs = events.filter((e) => e.ok && p.clusters.includes(e.c));
    if (!evs.length) continue;
    p.count = evs.length; p.snoreSec = 0; p.peak = -Infinity; p.boutSec = 0; p.streak = 0;
    p.bins = new Array(nb).fill(0);
    let snr = 0, bStart = evs[0].t, bEnd = evs[0].t + evs[0].dur;
    const close = () => { p.boutSec += bEnd - bStart; p.streak = Math.max(p.streak, bEnd - bStart); };
    evs.forEach((e, i) => {
      p.snoreSec += e.dur; snr += e.snr; p.peak = Math.max(p.peak, e.peak);
      p.bins[Math.min(nb - 1, Math.floor(e.t / binSec))] += e.dur;
      if (i) { if (e.t - bEnd > 20) { close(); bStart = e.t; } bEnd = Math.max(bEnd, e.t + e.dur); }
    });
    close();
    p.avgSnr = snr / evs.length;
    p.f0 = Math.round(median(evs.map((e) => e.f0).filter((f) => f > 0)));
    p.pct = p.boutSec / Math.max(durSec, 1);
    p.score = Math.round(100 * (1 - Math.exp(-4 * p.pct)) * (0.65 + 0.35 * Math.min(1, p.avgSnr / 25)));
    p.bins = p.bins.map((v) => +v.toFixed(2));
    people.push(p);
  }
  people.sort((a, b) => b.boutSec - a.boutSec);
  const total = people.reduce((s, p) => s + p.boutSec, 0) || 1;
  people.forEach((p) => { p.share = p.boutSec / total; });
  const top = (f) => people.reduce((bi, p, i) => (f(p) > f(people[bi]) ? i : bi), 0);
  const awards = [];
  if (people.length) {
    awards.push({ emoji: '🏆', title: 'Snorer of the Night', who: 0, kind: 'time' });
    awards.push({ emoji: '📢', title: 'Decibel Demon', who: top((p) => p.peak), kind: 'peak' });
    awards.push({ emoji: '🏃', title: 'Marathon Session', who: top((p) => p.streak), kind: 'streak' });
    const voiced = people.filter((p) => p.f0 > 0);
    if (voiced.length) awards.push({ emoji: '🔉', title: 'Human Subwoofer', who: people.indexOf(voiced.reduce((a, b) => (b.f0 < a.f0 ? b : a))), kind: 'pitch' });
  }
  return { id: startMs, startMs, durSec, mode, nb, binSec, people, awards };
}
