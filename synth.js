// Synthetic snorers for the demo night and the tests: a jittery pulse train
// (soft-palate flutter) through a few resonances (the airway), plus breath noise.
import { mulberry32 } from './engine.js';

export const DEMO_SNORERS = [
  // deep, loud, close to the mic
  { f0: 62, formants: [[220, 90, 1], [640, 140, 0.5], [1300, 250, 0.15]], period: 4.3, len: 1.6, rms: 0.09, breath: 0.15, sched: [[10, 200], [300, 520]] },
  // higher, nasal, further away
  { f0: 128, formants: [[480, 120, 1], [1500, 220, 0.6], [2700, 350, 0.3]], period: 3.5, len: 1.2, rms: 0.04, breath: 0.35, sched: [[150, 380], [470, 590]] },
];

function resonate(src, fs, f, bw, out, gain) {
  const r = Math.exp((-Math.PI * bw) / fs), a1 = 2 * r * Math.cos((2 * Math.PI * f) / fs), a2 = -r * r;
  let y1 = 0, y2 = 0;
  for (let i = 0; i < src.length; i++) { const y = src[i] + a1 * y1 + a2 * y2; y2 = y1; y1 = y; out[i] += gain * y * (1 - r); }
}

function snore(fs, s, rnd) {
  const n = Math.round(fs * s.len * (0.85 + 0.3 * rnd())), src = new Float32Array(n), out = new Float32Array(n);
  const f0 = s.f0 * (0.93 + 0.14 * rnd());
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (i >= next) { src[i] += 0.6 + 0.4 * rnd(); next += (fs / f0) * (0.96 + 0.08 * rnd()); }
    src[i] += s.breath * 0.05 * (rnd() * 2 - 1);
  }
  for (const [f, bw, g] of s.formants) resonate(src, fs, f * (0.96 + 0.08 * rnd()), bw, out, g);
  let e = 0;
  for (let i = 0; i < n; i++) {
    out[i] *= Math.sin((Math.PI * i) / n) ** 0.6 * (1 + 0.2 * Math.sin((2 * Math.PI * 11 * i) / fs));
    e += out[i] * out[i];
  }
  const g = (s.rms * 10 ** (((rnd() * 2 - 1) * 2.5) / 20)) / Math.sqrt(e / n + 1e-12);
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

export function makeNight({ fs = 16000, seconds = 600, snorers = DEMO_SNORERS, seed = 7, noise = 0.002, extras = true } = {}) {
  const rnd = mulberry32(seed), N = Math.round(fs * seconds), x = new Float32Array(N), truth = [];
  let lp = 0;
  for (let i = 0; i < N; i++) { const w = rnd() * 2 - 1; lp += 0.05 * (w - lp); x[i] = noise * (1.2 * w + 6 * lp); }
  const add = (buf, t) => { const o = Math.round(t * fs); for (let i = 0; i < buf.length && o + i < N; i++) x[o + i] += buf[i]; };
  snorers.forEach((s, who) => {
    for (const [a, b] of s.sched) {
      for (let t = a + rnd() * s.period; t < Math.min(b, seconds - 3); t += s.period * (0.9 + 0.2 * rnd())) {
        const buf = snore(fs, s, rnd); add(buf, t); truth.push({ t, dur: buf.length / fs, who });
      }
    }
  });
  if (extras) {
    const cough = new Float32Array(fs * 0.25).map((_, i, a) => 0.12 * (rnd() * 2 - 1) * Math.exp((-4 * i) / a.length));
    add(cough, 230); add(cough, 420.5);
    add(new Float32Array(fs * 0.4).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 80 * i) / fs) * Math.exp((-8 * i) / (fs * 0.4))), 265);
  }
  truth.sort((a, b) => a.t - b.t);
  return { samples: x, fs, truth };
}
