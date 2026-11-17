import { SnoreEngine, buildReport, profileDist } from './engine.js';
import { makeNight } from './synth.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('wesnore.' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wesnore.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('wesnore.' + k); } catch {} },
};

// Default suspects, deepest snore first.
const PERSONAS = [
  { name: 'The Chainsaw', emoji: '🪚', color: '#ff7a6b' },
  { name: 'The Walrus', emoji: '🦭', color: '#ffd166' },
  { name: 'The Kazoo', emoji: '🎺', color: '#5cd6ff' },
  { name: 'The Teakettle', emoji: '🫖', color: '#c09bff' },
];
const PICK = { 1: [0], 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };
const PROFILE_MATCH = 4; // max snoreprint distance to recognise someone from an earlier night

const settings = store.get('settings', { sleepers: 2 });
let S = null; // running session
let R = null; // report on screen: { report, s (session, if samples are still in memory) }
let actx = null;

function show(id) { for (const m of document.querySelectorAll('main')) m.hidden = m.id !== id; window.scrollTo(0, 0); }
let toastT;
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); }

const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtDur(sec) {
  sec = Math.round(sec);
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${sec}s`;
}
const fmtHMS = (sec) => { sec = Math.floor(sec); return `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };

// ---------- home ----------
function renderHome() {
  $('#sleepers').textContent = settings.sleepers;
  $('#sleepnote').textContent = ['', 'suspect (solo trial)', 'suspects', 'suspects. Pets count', 'suspects. Quite the party'][settings.sleepers];
  const nights = store.get('nights', []);
  $('#historyCard').hidden = !nights.length;
  $('#history').innerHTML = nights.map((n, i) => `<button class="night" data-i="${i}"><span class="d">${new Date(n.startMs).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span><span class="h">${esc(headline(n))}</span><span>›</span></button>`).join('');
}
function step(d) { settings.sleepers = Math.max(1, Math.min(4, settings.sleepers + d)); store.set('settings', settings); renderHome(); }

// ---------- sessions ----------
function newSession(mode, fs, colEvery) {
  const engine = new SnoreEngine(fs);
  const s = { mode, engine, fs, colEvery, startMs: Date.now(), maxK: mode === 'demo' ? Math.max(2, settings.sleepers) : settings.sleepers,
    analysis: { k: 0, clusters: [] }, labels: [], renames: {}, cols: [], level: 0, dirty: false, lastAn: 0, done: false };
  let n = 0;
  engine.onFrame = (rel, db, floor) => {
    s.level = db - floor;
    if (++n % colEvery === 0) { s.cols.push(Float32Array.from(rel)); if (s.cols.length > 400) s.cols.shift(); }
  };
  engine.onEvent = () => { s.dirty = true; };
  return s;
}

function labelsFor(s) {
  const cl = s.analysis.clusters, pick = PICK[cl.length] || [0, 1, 2, 3];
  // Recognise snoreprints saved on earlier nights: closest pairs first, each profile used once.
  const profs = s.mode === 'demo' ? [] : store.get('profiles', []), pairs = [], hit = {};
  cl.forEach((c, i) => profs.forEach((p, j) => { const d = profileDist(c.vec, p.vec); if (d < PROFILE_MATCH) pairs.push([d, i, j]); }));
  const usedP = new Set();
  for (const [, i, j] of pairs.sort((a, b) => a[0] - b[0])) if (!(i in hit) && !usedP.has(j)) { hit[i] = profs[j].name; usedP.add(j); }
  return cl.map((c, i) => {
    const p = PERSONAS[pick[i] ?? i % 4];
    return { name: s.renames[i] ?? hit[i] ?? p.name, emoji: p.emoji, color: p.color, matched: !(i in s.renames) && i in hit };
  });
}
function refresh(s) { s.analysis = s.engine.analyze(s.maxK); s.labels = labelsFor(s); }
function makeReport(s) {
  return buildReport(s.engine.events, s.labels, { startMs: s.startMs, durSec: s.engine.time, mode: s.mode, vecs: s.analysis.clusters.map((c) => c.vec) });
}
function saveNight(rep) {
  if (rep.mode === 'demo') return;
  store.set('nights', [rep, ...store.get('nights', []).filter((n) => n.id !== rep.id)].slice(0, 30));
}

let wake = null;
async function holdWake() { try { wake = await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (S?.mode === 'live' && document.visibilityState === 'visible') holdWake(); });

async function startLive() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('This browser has no microphone access here. Open the page over https or on localhost.', 6000);
  let stream;
  try {
    // Phone "voice call" processing erases snores: turn all of it off.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  } catch { return toast('We Snore needs the microphone to listen for snoring.', 5000); }
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try { await ctx.audioWorklet.addModule('worklet.js'); await ctx.resume(); }
  catch (e) { stream.getTracks().forEach((t) => t.stop()); return toast('Could not start audio capture: ' + e.message, 6000); }
  const D = Math.max(1, Math.round(ctx.sampleRate / 16000));
  const s = (S = newSession('live', ctx.sampleRate / D, 2));
  const node = new AudioWorkletNode(ctx, 'cap', { processorOptions: { D } });
  node.port.onmessage = (e) => { if (!s.done) s.engine.push(e.data); };
  const mute = ctx.createGain(); mute.gain.value = 0;
  ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
  const draft = () => { if (s.engine.time > 60) { refresh(s); store.set('draft', makeReport(s)); } };
  const timer = setInterval(draft, 60000);
  addEventListener('pagehide', draft);
  s.cleanup = () => { clearInterval(timer); removeEventListener('pagehide', draft); stream.getTracks().forEach((t) => t.stop()); ctx.close(); wake?.release?.().catch(() => {}); wake = null; store.del('draft'); };
  await holdWake();
  enterLive('Listening…', wake ? 'Screen stays awake and dims in a few seconds. Sleep well.' : 'Keep this screen on overnight (turn off auto-lock).');
  poke();
}

// Demo nights and uploaded recordings run through the exact same engine, just faster than real time.
function runBuffer(mode, samples, fs, speed, status, sub) {
  const s = (S = newSession(mode, fs, speed === Infinity ? 64 : Math.max(2, Math.round(speed / 4))));
  let pos = 0;
  s.feed = () => {
    const n = speed === Infinity ? fs * 45 : Math.round((fs * speed) / 60);
    s.engine.push(samples.subarray(pos, pos + n)); pos += n;
    s.progress = pos / samples.length;
    if (pos >= samples.length) finish();
  };
  enterLive(status, sub);
}
function startDemo() {
  const night = makeNight({ seconds: 600, seed: (Date.now() % 1000) + 1 });
  runBuffer('demo', night.samples, night.fs, 40, 'Demo night', 'Two synthetic snorers, 10 minutes, played at 40×');
}
async function startFile(file) {
  toast('Decoding ' + file.name + '…', 60000);
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    ctx.close();
    const D = Math.max(1, Math.round(buf.sampleRate / 16000)), n = Math.floor(buf.length / D), x = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < n; i++) { let a = 0; for (let j = 0; j < D; j++) a += ch[i * D + j]; x[i] += a / D / buf.numberOfChannels; }
    }
    $('#toast').hidden = true;
    runBuffer('file', x, buf.sampleRate / D, Infinity, 'Analyzing recording…', file.name);
    if (file.lastModified) S.startMs = file.lastModified - buf.duration * 1000;
  } catch (e) { toast('Could not read that file (' + e.message + '). Very long recordings may not fit in memory; try an hour or less.', 7000); }
}

function enterLive(status, sub) {
  $('#status').textContent = status; $('#sub').textContent = sub || '';
  $('#stop').textContent = S.mode === 'live' ? 'Wake up & see the verdict' : 'Skip to the verdict';
  $('#chips').innerHTML = '';
  const cv = $('#spec'), g = cv.getContext('2d'); g.fillStyle = '#0b1030'; g.fillRect(0, 0, cv.width, cv.height);
  show('live');
  requestAnimationFrame(tick);
}

function finish() {
  const s = S; if (!s) return;
  s.done = true; S = null; s.cleanup?.(); clearTimeout(idleT); $('#dim').hidden = true;
  refresh(s);
  R = { report: makeReport(s), s };
  saveNight(R.report);
  renderReport(); show('report');
}

// ---------- live view ----------
const LUT = (() => {
  const stops = [[0, [11, 16, 48]], [0.3, [62, 38, 130]], [0.55, [190, 62, 126]], [0.8, [255, 142, 92]], [1, [255, 236, 150]]], out = [];
  for (let i = 0; i < 256; i++) {
    const v = i / 255, k = stops.findIndex((st) => st[0] >= v), a = stops[Math.max(0, k - 1)], b = stops[k], f = b[0] === a[0] ? 0 : (v - a[0]) / (b[0] - a[0]);
    out.push(`rgb(${a[1].map((c, j) => Math.round(c + (b[1][j] - c) * f)).join(',')})`);
  }
  return out;
})();

let idleT, lastSec = -1;
function poke() { $('#dim').hidden = true; clearTimeout(idleT); if (S?.mode === 'live') idleT = setTimeout(() => { if (S?.mode === 'live') $('#dim').hidden = false; }, 20000); }

function tick(now) {
  const s = S; if (!s) return;
  requestAnimationFrame(tick);
  if (s.feed) { s.feed(); if (s.done) return; }
  if (s.dirty && now - s.lastAn > (s.mode === 'live' ? 1500 : 350)) { s.dirty = false; s.lastAn = now; refresh(s); renderChips(s); }
  const dimmed = !$('#dim').hidden;
  if (!dimmed) drawScope(s); else s.cols.length = 0;
  const sec = Math.floor(now / 1000);
  if (sec !== lastSec) {
    lastSec = sec;
    const t = fmtClock(Date.now());
    $('#clock').textContent = t; $('#dimclock').textContent = t;
    $('#elapsed').textContent = s.mode === 'file' ? Math.round((s.progress || 0) * 100) + '%' : fmtHMS(s.engine.time);
  }
}

function drawScope(s) {
  const cv = $('#spec'), g = cv.getContext('2d'), W = cv.width, H = cv.height, n = Math.min(s.cols.length, W);
  if (n) {
    g.drawImage(cv, -n, 0);
    for (let j = 0; j < n; j++) {
      const col = s.cols[s.cols.length - n + j], bh = H / col.length, x = W - n + j;
      for (let b = 0; b < col.length; b++) { g.fillStyle = LUT[Math.max(0, Math.min(255, (col[b] / 38) * 255)) | 0]; g.fillRect(x, H - (b + 1) * bh, 1, bh + 0.5); }
    }
    s.cols.length = 0;
  }
  const lc = $('#lane'), lg = lc.getContext('2d'), colSec = s.colEvery * s.engine.dt, tNow = s.engine.time, ev = s.engine.events;
  lg.clearRect(0, 0, W, lc.height);
  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i], x = W - (tNow - e.t) / colSec;
    if (x + e.dur / colSec < 0) break;
    lg.fillStyle = e.c >= 0 && s.labels[e.c] ? s.labels[e.c].color : '#4a5488';
    lg.fillRect(x, 2, Math.max(2, e.dur / colSec), lc.height - 4);
  }
  $('#orb').style.setProperty('--lv', Math.max(0, Math.min(1, s.level / 32)).toFixed(2));
}

function renderChips(s) {
  const cnt = s.labels.map(() => 0);
  for (const e of s.engine.events) if (e.ok && e.c >= 0) cnt[e.c]++;
  $('#chips').innerHTML = s.labels.map((l, i) => `<div class="chip" style="--c:${l.color}"><span class="e">${l.emoji}</span><span class="n">${esc(l.name)}</span><span class="v">${cnt[i]} snores</span></div>`).join('');
}

// ---------- report ----------
function headline(r) {
  const p = r.people;
  if (!p.length) return 'A silent night. Nobody snored. Suspicious. 🤫';
  if (p.length === 1) return `${p[0].name} did all the snoring. Case closed.`;
  const a = Math.round(p[0].share * 100), b = Math.round(p[1].share * 100);
  if (p.length === 2 && a - b < 10) return `It's a duet. ${p[0].name} and ${p[1].name} are equally guilty.`;
  return `${p[0].name} out-snored ${p.length === 2 ? p[1].name : 'everyone'}, ${a}% to ${b}%.`;
}
const pitchWord = (f) => (!f ? 'raspy, no clear pitch' : f < 80 ? 'sub-bass rumble' : f < 140 ? 'baritone purr' : 'tenor whistle');
function awardLine(a, p) {
  if (a.kind === 'time') return `${fmtDur(p.boutSec)} of snoring, ${Math.round(p.pct * 100)}% of the night`;
  if (a.kind === 'peak') return `peaked ${Math.round(p.peak)} dB above the room's quiet`;
  if (a.kind === 'streak') return `${fmtDur(p.streak)} without a break`;
  return `rumbling along at ${p.f0} Hz`;
}

function renderReport() {
  const r = R.report, P = r.people;
  const label = r.mode === 'demo' ? 'Demo night' : r.mode === 'file' ? 'Recording' : 'Night of ' + new Date(r.startMs).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  $('#when').textContent = `${label} · ${fmtDur(r.durSec)} listened`;
  $('#headline').textContent = headline(r);
  $('#h2h').hidden = P.length < 2;
  $('#h2h').innerHTML = P.map((p) => `<div style="--c:${p.color};flex:${Math.max(0.08, p.share)}">${p.emoji} ${Math.round(p.share * 100)}%</div>`).join('');
  $('#people').innerHTML = P.map((p, i) => `
    <div class="card pcard" style="--c:${p.color}">
      <div class="phead"><span class="e">${p.emoji}</span>
        <input class="pname" data-i="${i}" value="${esc(p.name)}" maxlength="24" aria-label="Name this snorer" enterkeyhint="done">
        <span class="score">${p.score}<small>snore score</small></span></div>
      <div class="hint">${p.matched ? '🔍 Recognised from an earlier night. ' : ''}✎ Tap the name to say who this really is.${P.length > 1 ? ' Same name on two cards merges them.' : ''}</div>
      <div class="stats">
        <div class="stat"><b>${fmtDur(p.boutSec)}</b><span>snoring · ${Math.round(p.pct * 100)}% of the night</span></div>
        <div class="stat"><b>${p.count}</b><span>individual snores</span></div>
        <div class="stat"><b>+${Math.round(p.peak)} dB</b><span>loudest, over room quiet</span></div>
        <div class="stat"><b>${p.f0 ? p.f0 + ' Hz' : '—'}</b><span>${pitchWord(p.f0)}</span></div>
      </div>
      ${R.s ? `<button class="play" data-i="${i}">▶ Hear the evidence</button>` : ''}
    </div>`).join('');
  $('#tlCard').hidden = $('#awardsCard').hidden = !P.length;
  $('#tl').innerHTML = Array.from({ length: r.nb }, (_, b) => {
    const hs = P.map((p) => p.bins[b] / (r.binSec * 0.45)), sum = hs.reduce((x, y) => x + y, 0), k = sum > 1 ? 1 / sum : 1;
    return `<div class="b">${P.map((p, i) => (hs[i] ? `<i style="height:${(hs[i] * k * 100).toFixed(1)}%;background:${p.color}"></i>` : '')).join('')}</div>`;
  }).join('');
  const dur = r.durSec * 1000;
  $('#axis').innerHTML = r.mode === 'live' || r.mode === 'file'
    ? [0, 0.5, 1].map((f) => `<span>${fmtClock(r.startMs + dur * f)}</span>`).join('')
    : [0, 0.5, 1].map((f) => `<span>${fmtDur(r.durSec * f)}</span>`).join('');
  $('#legend').innerHTML = P.map((p) => `<span><i style="background:${p.color}"></i>${esc(p.name)}</span>`).join('');
  $('#awards').innerHTML = r.awards.map((a) => { const p = P[a.who]; return `<div class="award"><span class="e">${a.emoji}</span><div><b>${a.title}: ${esc(p.name)}</b><span>${awardLine(a, p)}</span></div></div>`; }).join('');
}

function rename(i, name) {
  name = name.trim();
  const p = R.report.people[i];
  if (!name || name === p.name) return renderReport();
  if (R.s) { for (const c of p.clusters) R.s.renames[c] = name; R.s.labels = labelsFor(R.s); R.report = makeReport(R.s); }
  else p.name = name;
  if (R.report.mode !== 'demo' && p.vec) store.set('profiles', [{ name, vec: p.vec }, ...store.get('profiles', []).filter((q) => q.name !== name)].slice(0, 12));
  saveNight(R.report);
  renderReport();
  toast(R.report.mode === 'demo' ? `Renamed to ${name}.` : `Got it. We Snore will recognise ${name}'s snore next time.`);
}

const sampleIdx = {};
let playing = null;
function playSample(i) {
  const p = R.report.people[i], s = R.s;
  const evs = s.engine.events.filter((e) => e.clip && e.ok && p.clusters.includes(e.c)).sort((a, b) => b.snr - a.snr);
  if (!evs.length) return toast('No samples were kept for this snorer.');
  const k = (sampleIdx[p.name] = ((sampleIdx[p.name] ?? -1) + 1) % evs.length), e = evs[k];
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  actx.resume();
  let peak = 1e-6;
  for (const v of e.clip) peak = Math.max(peak, Math.abs(v));
  const buf = actx.createBuffer(1, e.clip.length, s.fs), ch = buf.getChannelData(0);
  for (let j = 0; j < ch.length; j++) ch[j] = (e.clip[j] / peak) * 0.9;
  try { playing?.stop(); } catch {}
  playing = actx.createBufferSource(); playing.buffer = buf; playing.connect(actx.destination); playing.start();
  const at = s.mode === 'demo' ? fmtDur(e.t) + ' in' : fmtClock(s.startMs + e.t * 1000);
  toast(`${p.emoji} ${p.name}, sample ${k + 1} of ${evs.length} · ${at}`);
}

async function share() {
  const r = R.report;
  const text = ['🌙 We Snore™ verdict', headline(r), ...r.people.map((p) => `${p.emoji} ${p.name}: ${fmtDur(p.boutSec)} snoring (${Math.round(p.share * 100)}% of the blame), ${p.count} snores, snore score ${p.score}`)].join('\n');
  try {
    if (navigator.share) await navigator.share({ title: 'We Snore™ verdict', text });
    else { await navigator.clipboard.writeText(text); toast('Verdict copied. Paste it in the group chat.'); }
  } catch {}
}

// ---------- wiring ----------
$('#less').onclick = () => step(-1);
$('#more').onclick = () => step(1);
$('#start').onclick = startLive;
$('#demo').onclick = startDemo;
$('#pick').onclick = () => $('#file').click();
$('#file').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) startFile(f); };
$('#stop').onclick = finish;
$('#live').addEventListener('pointerdown', poke);
$('#dim').addEventListener('click', (e) => { e.stopPropagation(); poke(); });
$('#history').onclick = (e) => { const b = e.target.closest('.night'); if (b) { R = { report: store.get('nights', [])[+b.dataset.i], s: null }; renderReport(); show('report'); } };
$('#people').addEventListener('change', (e) => { if (e.target.matches('.pname')) rename(+e.target.dataset.i, e.target.value); });
$('#people').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.pname')) e.target.blur(); });
$('#people').addEventListener('click', (e) => { const b = e.target.closest('.play'); if (b) playSample(+b.dataset.i); });
$('#share').onclick = share;
$('#done').onclick = () => { try { playing?.stop(); } catch {} R = null; renderHome(); show('home'); };

// A night that was cut short (crash, closed tab) is recovered from its last autosave.
const draft = store.get('draft', null);
if (draft) { saveNight(draft); store.del('draft'); }
renderHome();
if (location.hash === '#demo') startDemo(); // shareable "see it work" link
