/*
 * analysis.js — the per-frame analysis pipeline (spec section 3).
 *
 * Takes raw detector output per frame and produces smoothed pitch, an inferred
 * target note, note segments, per-segment statistics and session statistics.
 * Exported on window.Analysis as a factory createAnalyzer(opts).
 */
(function (global) {
  "use strict";

  const { targetCents } = window.Music;

  function median(arr) {
    if (arr.length === 0) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function percentile(arr, p) {
    if (arr.length === 0) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
    return s[idx];
  }

  function createAnalyzer(opts) {
    const cfg = Object.assign({
      smoothingN: 5,       // median window (frames)
      gateMargin: 10,      // dB
      sigma: 32,           // cents, target-inference width
    }, opts || {});

    // Calibration / gate state.
    let floor = -70;
    let calibrating = false;
    let calibSamples = [];
    let calibUntil = 0;

    // Smoothing / voicing state.
    let rawCents = [];       // recent raw cents for median smoothing
    let voicedRun = 0;       // consecutive voiced frames
    let smoothedHist = [];   // {t, cents} for attempt median over 350ms
    let prevRawCents = null; // for octave-error fix
    let lastVoicedTime = -1;
    let wasVoiced = false;   // voicing hysteresis

    // Target state.
    let target = null;       // absolute note index k
    let topProb = 0, secondK = null, secondProb = 0, secondOffset = 0;

    // Segments.
    let segments = [];
    let current = null;      // {k, frames:[{t,cents,dB,centroid,clarity}]}

    // Session stats per pitch-class position.
    const session = {}; // pos -> {time, sumDev, sumSq, lastT}

    // Global stability accumulators for the composite score.
    const stability = { wobbleSum: 0, wobbleN: 0, totalVoiced: 0, startT: null };

    function setSmoothingN(n) { cfg.smoothingN = n; }
    function setGateMargin(m) { cfg.gateMargin = m; }

    function startCalibration(nowSec) {
      calibrating = true;
      calibSamples = [];
      calibUntil = nowSec + 1.0;
    }

    function gate() {
      return Math.max(floor + cfg.gateMargin, -72);
    }

    function reset() {
      rawCents = []; voicedRun = 0; smoothedHist = [];
      prevRawCents = null; target = null; current = null;
    }

    /**
     * Process one frame.
     * @param {object} f  { t, dB, det, centroid, saFreq, tune, raga, ragaSet }
     *   t: seconds; dB: level; det: Yin.detect result or null;
     *   centroid: Hz; saFreq: Hz; tune: cents table; ragaSet: Set of positions
     * @param {number} dtSec  time since previous frame
     * @returns {object} frame result for UI
     */
    function process(f, dtSec) {
      const result = {
        voiced: false, rawCents: null, smoothCents: null,
        attempt: null, target, topProb, secondK, secondProb, secondOffset,
        gate: gate(), floor, calibrating,
      };

      // Step 2: calibration window.
      if (calibrating) {
        if (isFinite(f.dB)) calibSamples.push(f.dB);
        if (f.t >= calibUntil) {
          const p90 = percentile(calibSamples, 90);
          if (p90 != null) floor = Math.max(-90, Math.min(-42, p90));
          calibrating = false;
        }
        result.gate = gate();
        result.floor = floor;
        result.calibrating = calibrating;
        return result;
      }

      // Voicing with hysteresis: it's harder to drop out than to start, so a
      // single borderline frame doesn't kill a sustained note. Once voiced we
      // tolerate a slightly higher aperiodicity and a few dB below the gate.
      const aboveGate = isFinite(f.dB) && f.dB > gate();
      const aboveGateLoose = isFinite(f.dB) && f.dB > gate() - 6;
      const hasPitch = f.det && f.det.freq != null;
      const rawVoiced = aboveGate && f.det && f.det.voiced;
      let voiced;
      if (wasVoiced) {
        // stay voiced through small dips
        voiced = aboveGateLoose && hasPitch && f.det.ap < 0.45;
      } else {
        voiced = rawVoiced;
      }
      wasVoiced = voiced;

      // Step 3: floor adaptation.
      if (!voiced) {
        // Rise slowly on unvoiced frames, capped.
        floor = Math.min(-40, floor + 0.4 * (dtSec || 0.016));
      }
      // Fall quickly toward quieter levels.
      if (isFinite(f.dB) && f.dB < floor) {
        floor += 0.05 * (f.dB - floor);
      }

      // Step 7: gap rule.
      const gapMs = lastVoicedTime < 0 ? Infinity : (f.t - lastVoicedTime) * 1000;
      if (gapMs > 120) {
        endSegment(); // accumulate the finished note's wobble BEFORE clearing
        reset();
      }

      if (!voiced) {
        result.floor = floor;
        result.gate = gate();
        return result;
      }

      lastVoicedTime = f.t;
      voicedRun++;

      // Step 6: cents + octave-error fix.
      let c = 1200 * Math.log2(f.det.freq / f.saFreq);
      if (prevRawCents != null) {
        for (const jump of [1200, -1200]) {
          if (Math.abs((c - prevRawCents) - jump) <= 120) {
            c -= jump;
          }
        }
      }
      prevRawCents = c;
      result.rawCents = c;
      result.voiced = true;

      // Step 8: median smoothing; require 3 consecutive voiced frames.
      rawCents.push(c);
      if (rawCents.length > cfg.smoothingN) rawCents.shift();
      if (voicedRun < 3) {
        result.floor = floor;
        return result;
      }
      const sm = median(rawCents);
      result.smoothCents = sm;
      smoothedHist.push({ t: f.t, cents: sm });
      while (smoothedHist.length && f.t - smoothedHist[0].t > 0.35) smoothedHist.shift();

      // Step 9: attempt m = median of smoothed over last 350 ms.
      const m = median(smoothedHist.map((x) => x.cents));
      result.attempt = m;

      // Step 10: target inference with priors + hysteresis.
      inferTarget(m, f.tune, f.ragaSet);
      result.target = target;
      result.topProb = topProb;
      result.secondK = secondK;
      result.secondProb = secondProb;
      result.secondOffset = secondOffset;

      // Step 11: segments.
      if (!current || current.k !== target) {
        endSegment();
        current = { k: target, frames: [] };
      }
      current.frames.push({
        t: f.t, cents: sm, dB: f.dB, centroid: f.centroid, clarity: f.det.clarity,
      });

      // Session accumulation (within 60¢ of target, past 150ms attack).
      accumulateSession(f, sm);

      // Reliable voiced-time clock for the composite score: count every voiced
      // frame that is reasonably near a target (within 60¢), using the true
      // frame delta. Independent of per-position bookkeeping so it can't stall.
      if (target != null) {
        const dev = Math.abs(sm - targetCents(target, f.tune));
        if (dev <= 60) stability.totalVoiced += Math.max(0, Math.min(0.1, dtSec || 0.016));
      }

      return result;
    }

    function inferTarget(m, tune, ragaSet) {
      const kCenter = Math.round(m / 100);
      const cands = [];
      for (let k = kCenter - 2; k <= kCenter + 2; k++) {
        const tc = targetCents(k, tune);
        const pos = ((k % 12) + 12) % 12;
        const prior = (!ragaSet || ragaSet.has(pos)) ? 1 : 0.18;
        const score = prior * Math.exp(-((m - tc) * (m - tc)) / (2 * cfg.sigma * cfg.sigma));
        cands.push({ k, tc, score });
      }
      const sum = cands.reduce((a, c) => a + c.score, 0) || 1;
      cands.forEach((c) => (c.prob = c.score / sum));
      cands.sort((a, b) => b.prob - a.prob);

      const best = cands[0];
      const second = cands[1];

      // Hysteresis.
      if (target == null) {
        target = best.k;
      } else {
        const tcT = targetCents(target, tune);
        const far = Math.abs(m - tcT) > 65;
        const confident = best.prob > 0.8 && Math.abs(m - best.tc) < 30;
        if (far || confident) target = best.k;
      }

      // Report probabilities relative to the chosen target.
      const chosen = cands.find((c) => c.k === target) || best;
      topProb = chosen.prob;
      // Second guess = highest-prob candidate that isn't the target.
      const others = cands.filter((c) => c.k !== target).sort((a, b) => b.prob - a.prob);
      if (others.length) {
        secondK = others[0].k;
        secondProb = others[0].prob;
        secondOffset = m - others[0].tc;
      } else {
        secondK = null; secondProb = 0; secondOffset = 0;
      }
    }

    function accumulateSession(f, sm) {
      if (target == null || !current) return;
      const seg = current;
      const t0 = seg.frames.length ? seg.frames[0].t : f.t;
      if (f.t - t0 < 0.15) return; // skip attack
      const tc = targetCents(target, f.tune);
      const dev = sm - tc;            // deviation from the target (for offset)
      if (Math.abs(dev) > 60) return;
      const pos = ((target % 12) + 12) % 12;
      const s = session[pos] || (session[pos] =
        { time: 0, sumDev: 0, sumSq: 0, n: 0, lastT: f.t, recent: [] });
      const dt = Math.max(0, Math.min(0.1, f.t - s.lastT));

      // Local center = median of recent same-swara cents (last ~0.4s). For a
      // steady note this ≈ the note itself; for a gamaka it tracks the
      // oscillation center, so intentional swing doesn't inflate "spread".
      // Use deviation from target (not absolute cents) so the same swara in
      // different octaves or separate phrases doesn't look like huge scatter.
      if (f.t - s.lastT > 0.12) s.recent.length = 0; // new note: restart window
      s.recent.push(dev);
      if (s.recent.length > 24) s.recent.shift();
      const center = median(s.recent);
      const spreadDev = dev - center;  // scatter around your own center

      s.time += dt;
      s.sumDev += dev;                // offset still measured vs the true target
      s.sumSq += spreadDev * spreadDev; // consistency measured around local center
      s.n += 1;
      s.lastT = f.t;
    }

    function endSegment() {
      if (current && current.frames.length) {
        // Accumulate this segment's wobble (RMS of detrended cents) for the
        // stability score, ignoring very short fragments.
        const fr = current.frames.filter((x, i) => i > 2); // skip attack frames
        if (fr.length >= 4) {
          const times = fr.map((x) => x.t);
          const cents = fr.map((x) => x.cents);
          const { slope, intercept } = linreg(times, cents);
          const resid = fr.map((x) => x.cents - (slope * x.t + intercept));
          const wob = Math.sqrt(mean(resid.map((r) => r * r)));
          // Detect oscillation (gamaka): count thresholded residual crossings.
          const thr = Math.max(2, 0.5 * wob);
          let crossings = 0, lastSign = 0;
          for (const r of resid) {
            if (Math.abs(r) < thr) continue;
            const sign = r > 0 ? 1 : -1;
            if (lastSign !== 0 && sign !== lastSign) crossings++;
            lastSign = sign;
          }
          const dur = times[times.length - 1] - times[0];
          const rate = dur > 0 ? crossings / 2 / dur : 0;
          const isGamaka = wob >= 6 && rate >= 2.5;
          // Only steady notes feed the stability (wobble) score; gamakas are an
          // intentional ornament, not instability, so we exclude them.
          if (isFinite(wob) && !isGamaka) {
            stability.wobbleSum += wob;
            stability.wobbleN += 1;
          }
        }
        segments.push(current);
      }
      current = null;
    }

    // --- Current-segment statistics (spec section 3) --------------------
    function segmentStats(tune, raga) {
      if (!current || current.frames.length < 2) return null;
      const tc = targetCents(current.k, tune);
      const now = current.frames[current.frames.length - 1].t;
      // Skip first 150ms, use last 3s.
      const t0seg = current.frames[0].t;
      const frames = current.frames.filter(
        (fr) => fr.t - t0seg >= 0.15 && now - fr.t <= 3.0
      );
      if (frames.length < 2) return null;

      const times = frames.map((fr) => fr.t);
      const cents = frames.map((fr) => fr.cents);
      const dBs = frames.map((fr) => fr.dB);
      const cents0 = cents.map((c) => c - tc);

      const offset = mean(cents0);

      // Linear regression of cents on time -> drift (slope, ¢/s).
      const { slope, intercept } = linreg(times, cents);
      const drift = slope;

      // Residuals after removing the line.
      const resid = frames.map((fr) => fr.cents - (slope * fr.t + intercept));
      const wobble = Math.sqrt(mean(resid.map((r) => r * r)));

      // Wobble rate via residual zero crossings past a threshold.
      const thr = Math.max(2, 0.5 * wobble);
      let crossings = 0;
      let lastSign = 0;
      for (const r of resid) {
        if (Math.abs(r) < thr) continue;
        const sign = r > 0 ? 1 : -1;
        if (lastSign !== 0 && sign !== lastSign) crossings++;
        lastSign = sign;
      }
      const dur = times[times.length - 1] - times[0];
      let rate = dur > 0 ? crossings / 2 / dur : 0;
      const oscillating = wobble >= 6 && rate >= 2.5;

      // Held in tune: time since most recent frame > 25¢ from target.
      let heldSince = now;
      for (let i = current.frames.length - 1; i >= 0; i--) {
        if (Math.abs(current.frames[i].cents - tc) > 25) { heldSince = current.frames[i].t; break; }
        if (i === 0) heldSince = current.frames[0].t;
      }
      const heldInTune = now - heldSince;

      // Volume steadiness (SD of dB).
      const volSd = stddev(dBs);

      // Tone colour steadiness: SD(centroid)/mean(centroid) %.
      const cents_centroid = frames.map((fr) => fr.centroid).filter((x) => x > 0);
      let tonePct = 0;
      if (cents_centroid.length > 1) {
        const mc = mean(cents_centroid);
        tonePct = mc > 0 ? (stddev(cents_centroid) / mc) * 100 : 0;
      }

      const clarityPct = mean(frames.map((fr) => fr.clarity)) * 100;

      // Gamaka check: when oscillating, see whether the ornament is anchored
      // on raga-allowed swaras (pitch-class). Uses absolute cents (not
      // target-relative) so the center/turning points map to real swaras.
      let gamaka = null;
      if (oscillating && raga) {
        gamaka = window.Music.gamakaRagaCheck(cents, raga, tune);
      }

      return {
        offset, drift, wobble, rate, oscillating, heldInTune,
        volSd, tonePct, clarityPct, k: current.k, gamaka,
      };
    }

    function sessionStats() {
      const out = [];
      for (const pos of Object.keys(session)) {
        const s = session[pos];
        if (s.n === 0) continue;
        const meanOff = s.sumDev / s.n;                 // bias vs the target
        // sumSq already accumulates squared deviations around the local center,
        // so spread = RMS of those (no need to subtract the mean again).
        const spread = Math.sqrt(Math.max(0, s.sumSq / s.n));
        out.push({ pos: +pos, time: s.time, meanOffset: meanOff, spread });
      }
      return out;
    }

    function resetSession() {
      for (const k of Object.keys(session)) delete session[k];
      stability.wobbleSum = 0; stability.wobbleN = 0;
      stability.totalVoiced = 0; stability.startT = null;
    }

    /**
     * Composite practice score (0–100) with a breakdown. Combines:
     *   intonation 40% · consistency 30% · stability 20% · coverage 10%.
     * Returns null until there's enough data to be meaningful.
     */
    function sessionScore() {
      const rows = sessionStats();
      // Need a little in-tune, voiced material to be meaningful. Report how
      // much we have so the UI can give a useful hint instead of a mystery.
      if (!rows.length || stability.totalVoiced < 2) {
        return { notReady: true, voicedSec: stability.totalVoiced };
      }

      // Weight each swara's contribution by time held (so a swara you barely
      // touched doesn't dominate), via a weighted mean.
      let wSum = 0, offAcc = 0, spreadAcc = 0;
      rows.forEach((r) => {
        const w = r.time;
        wSum += w;
        offAcc += w * Math.abs(r.meanOffset);
        spreadAcc += w * r.spread;
      });
      const avgAbsOffset = wSum ? offAcc / wSum : 50;
      const avgSpread = wSum ? spreadAcc / wSum : 50;

      // Map to 0–100. 0¢ -> 100, 25¢ -> ~50, 50¢ -> 0 (linear, clamped).
      const toScore = (x, zero50) => Math.max(0, Math.min(100, 100 - (x / zero50) * 50));
      const intonation = toScore(avgAbsOffset, 25);
      const consistency = toScore(avgSpread, 20);

      // Stability: lower average wobble is better (6¢ -> ~85, 20¢ -> ~0).
      // No steady (non-gamaka) notes finished yet means nothing unsteady was
      // measured, so don't penalise.
      const avgWobble = stability.wobbleN ? stability.wobbleSum / stability.wobbleN : 0;
      const stabilityScore = Math.max(0, Math.min(100, 100 - (avgWobble / 20) * 100));

      // Coverage: reward singing longer and touching more swaras.
      const dur = stability.totalVoiced;
      const timeScore = Math.max(0, Math.min(100, (dur / 30) * 100)); // 30s voiced = full
      const breadthScore = Math.max(0, Math.min(100, (rows.length / 7) * 100));
      const coverage = 0.6 * timeScore + 0.4 * breadthScore;

      const composite = Math.round(
        0.40 * intonation + 0.30 * consistency + 0.20 * stabilityScore + 0.10 * coverage
      );

      // Biggest win: the swara with the worst weighted "badness".
      let worst = null;
      rows.forEach((r) => {
        const badness = Math.abs(r.meanOffset) + r.spread;
        if (!worst || badness > worst.badness) worst = { ...r, badness };
      });

      const label =
        composite >= 90 ? "Excellent" :
        composite >= 75 ? "Solid" :
        composite >= 60 ? "Coming along" :
        composite >= 40 ? "Needs work" : "Keep at it";

      return {
        composite, label,
        parts: {
          intonation: Math.round(intonation),
          consistency: Math.round(consistency),
          stability: Math.round(stabilityScore),
          coverage: Math.round(coverage),
        },
        avgAbsOffset, avgSpread, avgWobble, voicedSec: dur, swaraCount: rows.length,
        worst,
      };
    }

    // --- helpers --------------------------------------------------------
    function mean(a) { return a.reduce((x, y) => x + y, 0) / (a.length || 1); }
    function stddev(a) {
      if (a.length < 2) return 0;
      const m = mean(a);
      return Math.sqrt(mean(a.map((x) => (x - m) * (x - m))));
    }
    function linreg(xs, ys) {
      const n = xs.length;
      const mx = mean(xs), my = mean(ys);
      let num = 0, den = 0;
      for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
      const slope = den === 0 ? 0 : num / den;
      return { slope, intercept: my - slope * mx };
    }

    return {
      process, startCalibration, reset, endSegment,
      segmentStats, sessionStats, sessionScore, resetSession,
      setSmoothingN, setGateMargin,
      get floor() { return floor; },
      get gateValue() { return gate(); },
      get isCalibrating() { return calibrating; },
      get currentTarget() { return target; },
    };
  }

  global.Analysis = { createAnalyzer, median, percentile };
})(window);
