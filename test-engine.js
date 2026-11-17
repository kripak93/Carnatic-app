/*
 * test-engine.js — acceptance checks for the src/ engine (SPEC section 6).
 * Run: node test-engine.js
 */
global.window = global;
require("./src/music.js");
require("./src/yin.js");
require("./src/analysis.js");
const M = global.Music, Yin = global.Yin, A = global.Analysis;

let pass = 0, fail = 0;
function ok(name, cond, info) { if (cond) pass++; else { fail++; console.log("FAIL:", name, info || ""); } }
const cents = (a, b) => 1200 * Math.log2(a / b);

// --- YIN: synthetic tones, 70–880 Hz, 44.1/48k, within 1¢, no octave errors ---
function synth(f, sr, n) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    b[i] = 0.5 * Math.sin(2*Math.PI*f*t) + 0.9 * Math.sin(2*Math.PI*2*f*t)
         + 0.4 * Math.sin(2*Math.PI*3*f*t) + 0.05 * (Math.random()*2-1);
  }
  return b;
}
for (const sr of [44100, 48000]) {
  for (const f of [70, 110, 146.83, 220, 330, 440, 587.33, 880]) {
    const r = Yin.detect(synth(f, sr, 2048), sr);
    const e = r ? cents(r.freq, f) : 999;
    ok(`YIN ${f}Hz@${sr}`, r && Math.abs(e) <= 1, r ? e.toFixed(2) + "c" : "no detect");
  }
}

// --- Analysis acceptance check 2 ---
function runSteady(ragaId, freq, saHz) {
  const raga = M.RAGA_BY_ID[ragaId];
  const ragaSet = M.ragaPositions(raga);
  const tune = M.tuneTable("just");
  const an = A.createAnalyzer({});
  let last;
  for (let i = 0; i < 50; i++) {
    last = an.process({
      t: i/60, dB: -20,
      det: { freq, ap: 0.05, clarity: 0.95, voiced: true },
      centroid: 800, saFreq: saHz, tune, ragaSet,
    }, 1/60);
  }
  return { last, tune };
}
const saHz = 200;
const f350 = saHz * Math.pow(2, 350/1200);
const s = runSteady("shankarabharanam", f350, saHz);
ok("Shankara -> Ga3 (pos4)", ((s.last.target % 12) + 12) % 12 === 4, "pos " + (((s.last.target%12)+12)%12));
ok("Shankara ~36c flat", Math.abs((350 - M.targetCents(s.last.target, s.tune)) - (-36.31)) < 3);
ok("Shankara 2nd guess Ga2 (pos3)", (((s.last.secondK % 12)+12)%12) === 3, "pos " + (s.last.secondK!=null?((s.last.secondK%12)+12)%12:null));
const n = runSteady("none", f350, saHz);
ok("No-raga guesses similar", (n.last.secondProb / n.last.topProb) > 0.5, (n.last.secondProb/n.last.topProb).toFixed(2));

// --- Voicing hysteresis: a single borderline frame mid-note shouldn't reset ---
(function () {
  const raga = M.RAGA_BY_ID.none;
  const ragaSet = M.ragaPositions(raga);
  const tune = M.tuneTable("just");
  const saHz2 = 200;
  const f = saHz2 * Math.pow(2, 700 / 1200); // Pa
  const an = A.createAnalyzer({});
  // establish a solid voiced note
  for (let i = 0; i < 30; i++) {
    an.process({ t: i/60, dB: -20, det: { freq: f, ap: 0.05, clarity: 0.95, voiced: true }, centroid: 800, saFreq: saHz2, tune, ragaSet }, 1/60);
  }
  const statsBefore = an.segmentStats(tune);
  // one borderline frame: slightly high aperiodicity, a few dB down, det.voiced=false
  an.process({ t: 30/60, dB: -26, det: { freq: f, ap: 0.4, clarity: 0.6, voiced: false }, centroid: 800, saFreq: saHz2, tune, ragaSet }, 1/60);
  // continue the note
  for (let i = 31; i < 40; i++) {
    an.process({ t: i/60, dB: -20, det: { freq: f, ap: 0.05, clarity: 0.95, voiced: true }, centroid: 800, saFreq: saHz2, tune, ragaSet }, 1/60);
  }
  const statsAfter = an.segmentStats(tune);
  ok("Segment survives a single borderline frame", statsBefore != null && statsAfter != null,
     "before=" + !!statsBefore + " after=" + !!statsAfter);
})();

// --- Composite score: accurate singing should score high ---------------
(function () {
  const raga = M.RAGA_BY_ID.shankarabharanam;
  const ragaSet = M.ragaPositions(raga);
  const tune = M.tuneTable("just");
  const saHz2 = 200;
  function sing(an, k, cents_off, frames) {
    const f = saHz2 * Math.pow(2, (M.targetCents(k, tune) + cents_off) / 1200);
    const base = an._t || 0;
    for (let i = 0; i < frames; i++) {
      an._t = base + i / 60;
      an.process({ t: an._t, dB: -20, det: { freq: f, ap: 0.04, clarity: 0.96, voiced: true }, centroid: 800, saFreq: saHz2, tune, ragaSet }, 1/60);
    }
    an._t += 0.2; // gap between notes
  }
  // Accurate, steady singer over a realistic ~35s of singing.
  const good = A.createAnalyzer({}); good._t = 0;
  for (let rep = 0; rep < 5; rep++) [0,2,4,5,7,9,11].forEach((k) => sing(good, k, 2, 60));
  const gScore = good.sessionScore();
  ok("Good singer scores >=80", gScore && gScore.composite >= 80, gScore && gScore.composite);
  ok("Score has 4 parts", gScore && ["intonation","consistency","stability","coverage"].every((p)=>p in gScore.parts), "");

  // Off-pitch singer (consistently 40c sharp), same duration.
  const bad = A.createAnalyzer({}); bad._t = 0;
  for (let rep = 0; rep < 5; rep++) [0,2,4,5,7,9,11].forEach((k) => sing(bad, k, 40, 60));
  const bScore = bad.sessionScore();
  ok("Off-pitch singer scores lower", bScore && bScore.composite < gScore.composite,
     (bScore && bScore.composite) + " vs " + (gScore && gScore.composite));
})();

// --- Gamaka raga check -------------------------------------------------
(function () {
  const tune = M.tuneTable("just");
  // Hamsadhwani: S R2 G3 P N3 (pos 0,2,4,7,11). No Ma (5,6), no Da (8,9,10), no Ri1.
  const hamsa = M.RAGA_BY_ID.hamsadhwani;

  // Kampita on Ga3 (pos4, ~386c) swinging toward Ri2 (pos2, ~204c) and Pa-ish.
  // Center ~386 (Ga3, in raga), turns toward Ri2 (in raga) — should be in-raga.
  function osc(centerC, depth, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(centerC + Math.sin(i / 1.5) * depth);
    return out;
  }
  // Realistic kampita: ±40c oscillation centered on Ga3 (stays near Ga3).
  const gGa = M.gamakaRagaCheck(osc(386, 40, 40), hamsa, tune);
  ok("Gamaka centered on Ga3 is in-raga (Hamsadhwani)", gGa && gGa.inRaga, JSON.stringify(gGa && gGa.strayPositions));

  // An oscillation centered on Ma1 (pos5, ~498c) — Ma is NOT in Hamsadhwani.
  const gMa = M.gamakaRagaCheck(osc(498, 30, 40), hamsa, tune);
  ok("Gamaka settling on Ma1 flagged outside Hamsadhwani", gMa && !gMa.inRaga && gMa.strayPositions.includes(5),
     JSON.stringify(gMa && gMa.strayPositions));

  // In "none" raga nothing is a stray.
  const gNone = M.gamakaRagaCheck(osc(498, 30, 40), M.RAGA_BY_ID.none, tune);
  ok("Gamaka in 'none' raga never strays", gNone && gNone.inRaga, "");
})();

// --- Gamaka doesn't tank consistency -----------------------------------
(function () {
  const tune = M.tuneTable("just");
  const raga = M.RAGA_BY_ID.shankarabharanam;
  const rs = M.ragaPositions(raga);
  const sa2 = 200;
  // Sing an oscillating Ga3 (gamaka) centered on target with ±70c swing.
  const an = A.createAnalyzer({}); let t = 0;
  const tcGa = M.targetCents(4, tune);
  for (let i = 0; i < 120; i++) {
    const cents = tcGa + Math.sin(i / 1.4) * 70; // kampita
    const f = sa2 * Math.pow(2, cents / 1200);
    an.process({ t, dB: -20, det: { freq: f, ap: 0.05, clarity: 0.95, voiced: true }, centroid: 800, saFreq: sa2, tune, ragaSet: rs }, 1/60);
    t += 1/60;
  }
  const rows = an.sessionStats();
  const ga = rows.find((r) => r.pos === 4);
  // Spread is measured around the local (oscillation) center, so it should be
  // far smaller than the ±70c raw swing.
  ok("Gamaka spread not counted as raw swing", ga && ga.spread < 45, ga && ga.spread.toFixed(1));
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
