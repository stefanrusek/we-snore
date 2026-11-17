// node test/engine.test.mjs
import assert from 'node:assert';
import { SnoreEngine, buildReport } from '../engine.js';
import { makeNight, DEMO_SNORERS } from '../synth.js';

function run(night, maxK) {
  const eng = new SnoreEngine(night.fs);
  for (let i = 0; i < night.samples.length; i += 2048) eng.push(night.samples.subarray(i, i + 2048));
  const an = eng.analyze(maxK);
  // score each confirmed event against the loudest true snore overlapping its midpoint
  const tally = Array.from({ length: Math.max(an.k, 1) }, () => [0, 0, 0]);
  let stray = 0;
  for (const e of eng.events.filter((e) => e.ok)) {
    const mid = e.t + e.dur / 2, hit = night.truth.filter((s) => mid >= s.t - 0.1 && mid <= s.t + s.dur + 0.1).sort((a, b) => a.who - b.who)[0];
    if (hit) tally[e.c][hit.who]++; else stray++;
  }
  const good = tally.reduce((s, r) => s + Math.max(...r), 0), all = tally.flat().reduce((a, b) => a + b, 0);
  return { eng, an, tally, stray, purity: all ? good / all : 1, all };
}

{
  const night = makeNight();
  const r = run(night, 2);
  console.log('two snorers   k=%d silhouette=%s purity=%s tally=%j stray=%d events=%d/%d true', r.an.k, r.an.score.toFixed(2), r.purity.toFixed(3), r.tally, r.stray, r.all, night.truth.length);
  assert.equal(r.an.k, 2);
  assert.ok(r.purity > 0.9, 'purity');
  assert.ok(r.stray <= 2, 'coughs/thuds rejected');
  assert.ok(r.all > night.truth.length * 0.7, 'recall');
  const rep = buildReport(r.eng.events, [{ name: 'A', emoji: '', color: '' }, { name: 'B', emoji: '', color: '' }], { startMs: 0, durSec: r.eng.time });
  console.log(rep.people.map((p) => `${p.name}: ${p.count} snores, ${p.boutSec.toFixed(0)}s, f0=${p.f0}Hz, peak=+${p.peak.toFixed(0)}dB, score=${p.score}`).join(' | '));
  assert.equal(rep.people.length, 2);
  assert.ok(Math.abs(rep.people[0].boutSec - 410) < 60 && Math.abs(rep.people[1].boutSec - 350) < 70, 'bout times');
}
{
  const r = run(makeNight({ snorers: DEMO_SNORERS, seed: 3 }), 4);
  console.log('maxK=4        k=%d purity=%s', r.an.k, r.purity.toFixed(3));
  assert.equal(r.an.k, 2, 'does not invent extra snorers');
}
{
  const r = run(makeNight({ snorers: [DEMO_SNORERS[1]], seed: 11 }), 3);
  console.log('one snorer    k=%d events=%d', r.an.k, r.all);
  assert.equal(r.an.k, 1, 'single snorer is not split');
}
{
  const r = run(makeNight({ snorers: [], seed: 5 }), 2);
  console.log('quiet room    k=%d confirmed=%d', r.an.k, r.all + r.stray);
  assert.equal(r.an.k, 0);
}
console.log('ok');
