/*
 * app.js — Riyaz UI controller (spec section 4).
 *
 * Wires the music model, YIN detector, analysis pipeline and drone to the DOM:
 * Sa controls, raga/tuning/tradition, the live note panel, zoom canvas, trace
 * canvas, steadiness tiles, raga keyboard, drone panel, session table and mic
 * panel. Also renders the "Example" first view before the mic starts.
 */
(function () {
  "use strict";

  const M = window.Music;
  const Yin = window.Yin;
  const Analysis = window.Analysis;
  const DroneFactory = window.Drone;

  const $ = (id) => document.getElementById(id);

  // --- App state --------------------------------------------------------
  const state = {
    sa: M.defaultSa(),           // {noteIndex, octave, fineCents}
    saFreq: 0,
    tradition: "carnatic",
    tuning: "just",
    ragaId: "none",
    raga: M.RAGA_BY_ID.none,
    ragaSet: M.ragaPositions(M.RAGA_BY_ID.none),
    tune: M.tuneTable("just"),
    smoothingN: 5,
    gateMargin: 10,
    headphones: false,
    running: false,
    example: true,               // showing the example first-view
    spanSec: 10,
    frozen: false,
  };

  // Audio + analysis handles.
  let ctx = null, analyser = null, micStream = null, zeroGain = null;
  let timeBuf = null, freqBuf = null;
  let analyzer = null, drone = null;
  let rafId = null, lastT = -1, wakeLock = null;

  // Trace history: {t, raw, smooth, target, voiced}
  let trace = [];
  let lastResult = null;

  function recomputeSa() {
    state.saFreq = M.saFrequency(state.sa.noteIndex, state.sa.octave, state.sa.fineCents);
    $("saHz").textContent = state.saFreq.toFixed(2) + " Hz";
    $("saFineVal").textContent = (state.sa.fineCents > 0 ? "+" : "") + state.sa.fineCents + "¢";
    if (drone) drone.setSa(state.saFreq);
  }

  function setRaga(id) {
    state.ragaId = id;
    state.raga = M.RAGA_BY_ID[id] || M.RAGA_BY_ID.none;
    state.ragaSet = M.ragaPositions(state.raga);
    if (drone) drone.setRagaSet(state.ragaSet);
    renderRagaPanel();
    renderKeyboard();
    clearSessionAndTrace();
  }

  // --- Full session recording / export ---------------------------------
  let recFrames = [];
  let recStart = 0;

  function downloadFile(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportSession(kind) {
    if (!recFrames.length) { setStatus("Nothing recorded yet. Start singing first."); return; }
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const cols = ["t_sec", "smooth_cents", "raw_cents", "target_k", "level_db", "clarity", "centroid_hz"];
    if (kind === "csv") {
      const rows = recFrames.map((r) => r.map((v) => (v == null ? "" : v)).join(","));
      downloadFile("riyaz-session-" + stamp + ".csv", cols.join(",") + "\n" + rows.join("\n"), "text/csv");
      return;
    }
    const swaras = analyzer ? analyzer.sessionStats().map((r) => ({
      swara: M.swaraName(r.pos, state.tradition),
      pos: r.pos, timeHeldSec: +r.time.toFixed(2),
      meanOffsetCents: +r.meanOffset.toFixed(1), spreadCents: +r.spread.toFixed(1),
    })) : [];
    const sc = analyzer ? analyzer.sessionScore() : null;
    const data = {
      meta: {
        app: "Riyaz",
        savedAt: new Date().toISOString(),
        saHz: state.saFreq,
        raga: state.raga && state.raga.id ? state.raga.id : String(state.raga),
        tradition: state.tradition,
        smoothingN: state.smoothingN,
        gateMarginDb: state.gateMargin,
        durationSec: recFrames[recFrames.length - 1][0],
      },
      notes: "target_k = absolute note index (octave*12 + position, 0 = Sa); cents are relative to Sa; null = unvoiced.",
      score: sc && !sc.notReady ? sc : null,
      swaras, columns: cols, frames: recFrames,
    };
    downloadFile("riyaz-session-" + stamp + ".json", JSON.stringify(data), "application/json");
  }

  // Full-session chart on an offscreen canvas (light theme, print friendly).
  function renderSessionChart() {
    const F = recFrames.filter((r) => r[1] != null);
    if (!F.length) return null;
    const dur = recFrames[recFrames.length - 1][0] || 1;
    const padL = 70, padR = 20, padT = 30, padB = 40;
    const W = Math.round(Math.min(6000, Math.max(1200, dur * 14))) + padL + padR;
    let lo = Infinity, hi = -Infinity;
    F.forEach((r) => { lo = Math.min(lo, r[1]); hi = Math.max(hi, r[1]); });
    lo = Math.floor((lo - 60) / 100) * 100; hi = Math.ceil((hi + 60) / 100) * 100;
    const H = Math.max(360, Math.round(((hi - lo) / 100) * 22)) + padT + padB;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
    const x = (t) => padL + (t / dur) * (W - padL - padR);
    const y = (c) => padT + (1 - (c - lo) / (hi - lo)) * (H - padT - padB);
    g.font = "12px sans-serif";
    for (let k = Math.floor(lo / 100) - 1; k <= Math.ceil(hi / 100) + 1; k++) {
      const c = M.targetCents(k, state.tune);
      if (c < lo || c > hi) continue;
      const pos = ((k % 12) + 12) % 12, inR = M.inRaga(state.raga, pos);
      g.strokeStyle = pos === 0 ? "#ca8a04" : inR ? "#16a34a" : "#dc2626";
      g.globalAlpha = inR || pos === 0 ? 0.55 : 0.3;
      g.setLineDash(inR || pos === 0 ? [] : [5, 4]);
      g.beginPath(); g.moveTo(padL, y(c)); g.lineTo(W - padR, y(c)); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = g.strokeStyle;
      g.fillText(M.swaraName(pos, state.tradition) + (k >= 12 ? "˙" : k < 0 ? "." : ""), 8, y(c) + 4);
    }
    const step = dur > 600 ? 60 : dur > 120 ? 30 : dur > 40 ? 10 : 5;
    g.fillStyle = "#444"; g.strokeStyle = "#ccc";
    for (let t = 0; t <= dur; t += step) {
      g.beginPath(); g.moveTo(x(t), padT); g.lineTo(x(t), H - padB); g.stroke();
      g.fillText(t >= 60 ? Math.floor(t / 60) + "m" + String(Math.round(t % 60)).padStart(2, "0") + "s" : t + "s", x(t) - 8, H - padB + 18);
    }
    g.lineWidth = 2.5; g.lineCap = "round";
    let prev = null;
    recFrames.forEach((r) => {
      if (r[1] == null) { prev = null; return; }
      const pos = r[3] != null ? (((r[3] % 12) + 12) % 12) : 0;
      g.strokeStyle = M.inRaga(state.raga, pos) ? "#15803d" : "#b91c1c";
      if (prev && r[0] - prev[0] < 0.12) {
        g.beginPath(); g.moveTo(x(prev[0]), y(prev[1])); g.lineTo(x(r[0]), y(r[1])); g.stroke();
      }
      prev = r;
    });
    g.fillStyle = "#111"; g.font = "bold 14px sans-serif";
    g.fillText("Pitch over session (cents above Sa)", padL, 18);
    return cv;
  }

  function sessionAnalysis() {
    const byPos = {};
    let voiced = 0, within10 = 0, within25 = 0, outRaga = 0;
    const halves = [[], []];
    const half = recFrames[recFrames.length - 1][0] / 2;
    recFrames.forEach((r) => {
      if (r[1] == null || r[3] == null) return;
      const dev = r[1] - M.targetCents(r[3], state.tune);
      if (Math.abs(dev) > 60) return;
      const pos = ((r[3] % 12) + 12) % 12;
      const b = byPos[pos] || (byPos[pos] = { n: 0, w10: 0, w25: 0 });
      b.n++; voiced++;
      if (Math.abs(dev) <= 10) { b.w10++; within10++; }
      if (Math.abs(dev) <= 25) { b.w25++; within25++; }
      if (!M.inRaga(state.raga, pos)) outRaga++;
      halves[r[0] < half ? 0 : 1].push(Math.abs(dev));
    });
    const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    return { byPos, voiced, within10, within25, outRaga, h1: avg(halves[0]), h2: avg(halves[1]) };
  }

  function exportReport() {
    if (!recFrames.length || !analyzer) { setStatus("Nothing recorded yet. Start singing first."); return; }
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const cv = renderSessionChart();
    const png = cv ? cv.toDataURL("image/png") : "";
    const dur = recFrames[recFrames.length - 1][0];
    const A = sessionAnalysis();
    const rows = analyzer.sessionStats().sort((a, b) => b.time - a.time);
    const sc = analyzer.sessionScore();
    const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
    const fmtT = (s) => (s >= 60 ? Math.floor(s / 60) + "m " + Math.round(s % 60) + "s" : s.toFixed(1) + "s");
    const sgn = (v) => (v > 0 ? "+" : "") + Math.round(v);
    const obs = [];
    if (A.voiced) {
      obs.push(pct(A.within25, A.voiced) + "% of sung time was within 25¢ of the target note, and " +
        pct(A.within10, A.voiced) + "% within 10¢.");
      if (state.raga.id !== "none" && A.outRaga) {
        obs.push(pct(A.outRaga, A.voiced) + "% of sung time was on notes outside " + state.raga.name + ".");
      }
      if (A.h1 != null && A.h2 != null && Math.abs(A.h2 - A.h1) >= 3) {
        obs.push("Accuracy " + (A.h2 < A.h1 ? "improved" : "worsened") + " during the session: average error " +
          Math.round(A.h1) + "¢ in the first half, " + Math.round(A.h2) + "¢ in the second.");
      }
    }
    rows.filter((r) => r.time >= 1).forEach((r) => {
      const nm = M.swaraName(r.pos, state.tradition);
      if (Math.abs(r.meanOffset) >= 10) {
        obs.push(nm + " tends " + (r.meanOffset > 0 ? "sharp" : "flat") + " by about " + Math.abs(Math.round(r.meanOffset)) + "¢. Aim " + (r.meanOffset > 0 ? "lower." : "higher."));
      }
      if (r.spread >= 15) obs.push(nm + " is unsteady (spread ±" + Math.round(r.spread) + "¢). Try holding it longer against the drone.");
    });
    if (!obs.length) obs.push("Not enough sung material to draw conclusions yet.");

    const scoreHtml = sc && !sc.notReady ? "<p class='big'>" + sc.composite +
      " / 100 <small>" + sc.label + "</small></p><table><tr>" + Object.entries(sc.parts).map(([k, v]) => "<th>" + k + "</th>").join("") + "</tr><tr>" +
      Object.values(sc.parts).map((v) => "<td>" + v + "</td>").join("") + "</tr></table>"
      : "<p>Not enough in-tune singing to score yet.</p>";
    const rowHtml = rows.map((r) => {
      const b = A.byPos[r.pos] || { n: 0, w10: 0, w25: 0 };
      return "<tr><td>" + M.swaraName(r.pos, state.tradition) + "</td><td>" + fmtT(r.time) + "</td><td>" +
        sgn(r.meanOffset) + "¢</td><td>±" + Math.round(r.spread) + "¢</td><td>" + pct(b.w10, b.n) + "%</td><td>" + pct(b.w25, b.n) + "%</td></tr>";
    }).join("");

    const html = "<!doctype html><meta charset='utf-8'><title>Riyaz practice report</title>" +
      "<style>body{font:15px/1.5 system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#222}" +
      "table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ccc;padding:4px 10px;text-align:left}" +
      ".big{font-size:40px;font-weight:700;margin:4px 0}img{max-width:100%;border:1px solid #ccc}</style>" +
      "<h1>Riyaz practice report</h1><p>" + new Date().toLocaleString() + " · Sa " + state.saFreq.toFixed(2) +
      " Hz · " + state.raga.name + " · " + state.tradition + " · " + state.tuning + " tuning · duration " + fmtT(dur) + "</p>" +
      "<h2>Score</h2>" + scoreHtml +
      "<h2>Observations</h2><ul>" + obs.map((o) => "<li>" + o + "</li>").join("") + "</ul>" +
      "<h2>Pitch over session</h2>" + (png ? "<img src='" + png + "' alt='Pitch chart'>" : "<p>No pitched singing recorded.</p>") +
      "<h2>By swara</h2><table><tr><th>Swara</th><th>Time held</th><th>Avg offset</th><th>Spread</th><th>Within 10¢</th><th>Within 25¢</th></tr>" +
      rowHtml + "</table><p><small>Offset: positive is sharp, negative is flat. Spread: smaller is steadier.</small></p>";
    downloadFile("riyaz-report-" + stamp + ".html", html, "text/html");
    if (cv) cv.toBlob((b) => {
      const url = URL.createObjectURL(b);
      const a = document.createElement("a");
      a.href = url; a.download = "riyaz-chart-" + stamp + ".png";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  function clearSessionAndTrace() {
    recFrames = []; recStart = 0;
    trace = [];
    if (analyzer) analyzer.resetSession();
    renderSessionTable();
  }

  // --- Controls population ---------------------------------------------
  function populateControls() {
    const saNote = $("saNote");
    M.NOTE_NAMES_PRETTY.forEach((nm, i) => {
      const extra = state.tradition === "hindustani"
        ? M.harmoniumLabel(i) : "kattai " + M.kattaiLabel(i);
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = nm + " · " + extra;
      if (i === state.sa.noteIndex) opt.selected = true;
      saNote.appendChild(opt);
    });

    const saOct = $("saOctave");
    for (let o = 1; o <= 5; o++) {
      const opt = document.createElement("option");
      opt.value = String(o);
      opt.textContent = String(o);
      if (o === state.sa.octave) opt.selected = true;
      saOct.appendChild(opt);
    }

    const ragaSel = $("ragaSelect");
    // Group by tradition.
    const groups = {};
    M.RAGAS.forEach((r) => {
      const g = r.tradition === "–" ? "General" : r.tradition;
      (groups[g] = groups[g] || []).push(r);
    });
    Object.keys(groups).forEach((g) => {
      const og = document.createElement("optgroup");
      og.label = g;
      groups[g].forEach((r) => {
        const opt = document.createElement("option");
        opt.value = r.id;
        opt.textContent = r.name;
        og.appendChild(opt);
      });
      ragaSel.appendChild(og);
    });
  }

  function relabelSaNotes() {
    const saNote = $("saNote");
    [...saNote.options].forEach((opt, i) => {
      const extra = state.tradition === "hindustani"
        ? M.harmoniumLabel(i) : "kattai " + M.kattaiLabel(i);
      opt.textContent = M.NOTE_NAMES_PRETTY[i] + " · " + extra;
    });
  }

  // (rendering + mic pipeline continue in subsequent sections)
  window.__riyaz = { state, recomputeSa, setRaga }; // debug handle

  // Run init once the DOM is ready. Scripts are at the end of <body>, so
  // DOMContentLoaded may have already fired — handle both cases.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // Defer to next tick so the rest of this IIFE finishes defining functions.
    setTimeout(init, 0);
  }

  function init() {
    populateControls();
    recomputeSa();
    setRaga(state.ragaId);
    wireControls();
    renderSteadyTiles(null);
    renderNotePanel(exampleResult());
    startExampleLoop();
  }

  // --- Rendering: attempted-note panel ---------------------------------
  function offsetColor(absCents) {
    if (absCents <= 10) return "var(--in)";
    if (absCents <= 25) return "var(--amber, #fbbf24)";
    return "var(--out)";
  }

  function noteLabelFor(k) {
    const pos = ((k % 12) + 12) % 12;
    const octaveOffset = Math.floor(k / 12);
    const name = M.swaraName(pos, state.tradition);
    return { pos, octaveOffset, name };
  }

  function renderNotePanel(res) {
    $("exampleBadge").style.display = state.example ? "" : "none";
    if (!res || res.target == null) {
      // keep last note faded handled by caller
      return;
    }
    const { pos, octaveOffset, name } = noteLabelFor(res.target);
    const dots = M.octaveDots(octaveOffset);
    const inR = M.inRaga(state.raga, pos);

    const swaraEl = $("noteSwara");
    swaraEl.textContent = name;
    swaraEl.dataset.dots = dots;
    swaraEl.style.color = inR ? "var(--in)" : "var(--out)";
    // octave dots as superscript/subscript marks
    swaraEl.title = dots ? "octave " + (octaveOffset > 0 ? "+" : "") + octaveOffset : "";

    $("noteLong").textContent =
      M.swaraLong(pos, state.tradition) + " · " + M.registerName(octaveOffset, state.tradition);
    $("noteTag").textContent = state.raga.id === "none"
      ? "" : (inR ? "in " + state.raga.name : "outside " + state.raga.name);
    $("noteTag").style.color = inR ? "var(--in)" : "var(--out)";

    // Offset in cents from the target.
    const tc = M.targetCents(res.target, state.tune);
    const off = (res.attempt != null) ? (res.attempt - tc) : 0;
    const word = Math.abs(off) <= 10 ? "on the note" : (off > 0 ? "sharp" : "flat");
    const offEl = $("noteOffset");
    offEl.textContent = (off > 0 ? "+" : "") + Math.round(off) + "¢ " + word;
    offEl.style.color = offsetColor(Math.abs(off));

    // Second guess.
    const secEl = $("noteSecond");
    if (res.secondK != null && res.secondProb >= 0.12) {
      const s = noteLabelFor(res.secondK);
      const so = Math.round(res.secondOffset);
      secEl.textContent = "or " + s.name + " sung " + (so > 0 ? "+" : "") + so + "¢";
    } else {
      secEl.textContent = "";
    }

    // Probability bar.
    $("probTop").style.width = Math.round((res.topProb || 0) * 100) + "%";
    $("probSecond").style.width = Math.round((res.secondProb || 0) * 100) + "%";

    // Absolute pitch.
    if (res.attempt != null) {
      const f = M.centsToFreq(state.saFreq, res.attempt);
      const w = M.freqToWestern(f);
      $("noteAbs").textContent =
        f.toFixed(1) + " Hz · " + w.name + " " + (w.cents > 0 ? "+" : "") + w.cents + "¢";
    }
  }

  // Gamaka tag: when an oscillation is detected, show whether it stays within
  // the raga (soft hint, not a penalty) in the note panel's tag slot.
  let _lastGamaka = null;
  function renderGamakaTag(res, stats) {
    const tagEl = $("noteTag");
    if (!stats || !stats.oscillating || !stats.gamaka) return; // leave normal tag
    const g = stats.gamaka;
    if (g.inRaga) {
      tagEl.textContent = "gamaka · in " + (state.raga.id === "none" ? "range" : state.raga.name);
      tagEl.style.color = "var(--in)";
    } else {
      const strayNames = g.strayPositions.map((p) => M.swaraName(p, state.tradition)).join(", ");
      tagEl.textContent = "gamaka · settles on " + strayNames + " (outside " + state.raga.name + "?)";
      tagEl.style.color = "var(--out)";
    }
  }

  // --- Rendering: raga panel + chips -----------------------------------
  function renderRagaPanel() {
    const r = state.raga;
    $("ragaName").textContent = r.name;
    const n = M.ragaPositions(r).size;
    $("ragaMeta").textContent =
      (r.tradition === "–" ? "" : r.tradition + " · " + r.family + " · ") +
      n + " swaras";
    $("ragaDesc").textContent = r.desc || "";

    const hin = state.tradition === "hindustani";
    $("arohLbl").textContent = hin ? "Aaroh" : "Arohanam";
    $("avrohLbl").textContent = hin ? "Avroh" : "Avarohanam";

    const aroha = r.aroha || [];
    const avaroha = r.avaroha || (r.aroha ? r.aroha.slice().reverse() : []);
    renderChips($("arohChips"), aroha);
    renderChips($("avrohChips"), avaroha);
  }

  function renderChips(container, positions) {
    container.innerHTML = "";
    positions.forEach((pos) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = M.swaraName(pos, state.tradition);
      if (!M.inRaga(state.raga, pos)) chip.classList.add("chip--out");
      container.appendChild(chip);
    });
  }

  // --- Rendering: keyboard ---------------------------------------------
  function renderKeyboard() {
    const kb = $("keyboard");
    kb.innerHTML = "";
    // 13 keys Sa..upper Sa. Black keys are positions 1,3,6,8,10.
    const blackSet = new Set([1, 3, 6, 8, 10]);
    for (let i = 0; i <= 12; i++) {
      const pos = i % 12;
      const key = document.createElement("button");
      key.type = "button";
      key.className = "key" + (blackSet.has(pos) ? " key--black" : "");
      const inR = M.inRaga(state.raga, pos);
      if (inR) key.classList.add("key--in");
      key.dataset.k = String(i);

      const nm = document.createElement("span");
      nm.className = "key__swara" + (inR ? "" : " key__swara--out");
      nm.textContent = i === 12 ? M.swaraName(0, state.tradition) : M.swaraName(pos, state.tradition);

      const west = document.createElement("span");
      west.className = "key__west";
      const f = M.centsToFreq(state.saFreq, M.targetCents(i, state.tune));
      west.textContent = M.freqToWestern(f).name;

      key.appendChild(nm);
      key.appendChild(west);
      key.addEventListener("click", () => {
        ensureAudio();
        drone && drone.playTone(f, 0.9);
      });
      kb.appendChild(key);
    }
  }

  function highlightKey(k) {
    const kb = $("keyboard");
    [...kb.children].forEach((c) => c.classList.remove("key--playing"));
    if (k == null) return;
    const idx = ((k % 12) + 12) % 12;
    const el = kb.querySelector('.key[data-k="' + idx + '"]');
    if (el) el.classList.add("key--playing");
  }

  // --- Rendering: session table ----------------------------------------
  function renderSessionTable() {
    const body = $("sessionBody");
    body.innerHTML = "";
    if (!analyzer) { $("sessionSummary").textContent = "—"; return; }
    const rows = analyzer.sessionStats().sort((a, b) => b.time - a.time);
    let worst = null;
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      const name = M.swaraName(r.pos, state.tradition);
      const dotPct = ((Math.max(-50, Math.min(50, r.meanOffset)) + 50) / 100) * 100;
      tr.innerHTML =
        "<td>" + name + "</td>" +
        "<td>" + r.time.toFixed(1) + "s</td>" +
        '<td><span class="offtrack"><span class="offtrack__dot" style="left:' + dotPct + '%"></span></span> ' +
          (r.meanOffset > 0 ? "+" : "") + Math.round(r.meanOffset) + "¢</td>" +
        "<td>±" + Math.round(r.spread) + "¢</td>";
      body.appendChild(tr);
      if (!worst || Math.abs(r.meanOffset) > Math.abs(worst.meanOffset)) worst = r;
    });
    if (worst) {
      const dir = worst.meanOffset > 0 ? "sharp" : "flat";
      $("sessionSummary").textContent =
        "Most off: " + M.swaraName(worst.pos, state.tradition) + ", " +
        Math.abs(Math.round(worst.meanOffset)) + "¢ " + dir + " on average.";
    } else {
      $("sessionSummary").textContent = "—";
    }
  }

  // --- Rendering: steadiness tiles -------------------------------------
  const STEADY_TILES = [
    { key: "wobble", label: "Wobble", unit: "±¢", max: 30, desc: "pitch jitter" },
    { key: "drift", label: "Drift", unit: "¢/s", max: 40, desc: "sliding off" },
    { key: "heldInTune", label: "Held in tune", unit: "s", max: 5, desc: "stable time" },
    { key: "volSd", label: "Volume", unit: "±dB", max: 6, desc: "loudness steadiness" },
    { key: "tonePct", label: "Tone colour", unit: "±%", max: 30, desc: "timbre steadiness" },
    { key: "clarityPct", label: "Clarity", unit: "%", max: 100, desc: "tone purity" },
  ];

  // Keep the last computed stats so the tiles hold their value through brief
  // gaps instead of flickering to "—". Ease values toward new readings so the
  // numbers settle instead of jittering at 60fps.
  let _lastStats = null;
  let _easedStats = null;
  function smoothStats(fresh) {
    if (!_easedStats) { _easedStats = Object.assign({}, fresh); return _easedStats; }
    const keys = ["wobble", "drift", "heldInTune", "volSd", "tonePct", "clarityPct", "rate"];
    keys.forEach((k) => {
      const nv = fresh[k];
      if (nv == null || !isFinite(nv)) return;
      const ov = (_easedStats[k] == null || !isFinite(_easedStats[k])) ? nv : _easedStats[k];
      _easedStats[k] = ov + 0.25 * (nv - ov); // exponential ease
    });
    _easedStats.oscillating = fresh.oscillating;
    _easedStats.k = fresh.k;
    return _easedStats;
  }

  function renderSteadyTiles(stats) {
    const grid = $("steadyGrid");
    grid.innerHTML = "";
    STEADY_TILES.forEach((t) => {
      let val = stats ? stats[t.key] : null;
      const tile = document.createElement("div");
      tile.className = "tile";
      let valText = "—";
      let pct = 0;
      if (val != null && isFinite(val)) {
        valText = (t.key === "wobble" || t.key === "drift")
          ? (Math.round(val) + " " + t.unit)
          : (val.toFixed(t.key === "heldInTune" ? 1 : 0) + " " + t.unit);
        pct = Math.max(0, Math.min(100, (Math.abs(val) / t.max) * 100));
        if (t.key === "wobble" && stats && stats.oscillating) {
          valText += " · " + stats.rate.toFixed(1) + " Hz";
        }
      }
      tile.innerHTML =
        '<div class="tile__val">' + valText + "</div>" +
        '<div class="tile__bar"><div class="tile__fill" style="width:' + pct + '%"></div></div>' +
        '<div class="tile__label">' + t.label + " — " + t.desc + "</div>";
      grid.appendChild(tile);
    });
  }

  // --- Canvas: zoom -----------------------------------------------------
  function drawZoom(res) {
    const cv = $("zoomCanvas");
    const g = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = getCss("--card2", "#111827");
    g.fillRect(0, 0, W, H);

    if (!res || res.target == null) return;
    const k = res.target;
    const tc = M.targetCents(k, state.tune);
    // Y range: 30¢ below k-1 to 30¢ above k+1, relative to target.
    const lo = M.targetCents(k - 1, state.tune) - tc - 30;
    const hi = M.targetCents(k + 1, state.tune) - tc + 30;
    const y = (c) => H - ((c - lo) / (hi - lo)) * H;

    // Bands ±10 and ±25.
    g.fillStyle = "rgba(74,222,128,0.14)";
    g.fillRect(0, y(10), W, y(-10) - y(10));
    g.fillStyle = "rgba(251,191,36,0.10)";
    g.fillRect(0, y(25), W, y(10) - y(25));
    g.fillRect(0, y(-10), W, y(-25) - y(-10));

    // Ticks at ±25, ±50.
    g.strokeStyle = "rgba(148,163,184,0.25)";
    g.fillStyle = getCss("--muted", "#94a3b8");
    g.font = "10px sans-serif";
    [-50, -25, 25, 50].forEach((c) => {
      if (c < lo || c > hi) return;
      g.beginPath(); g.moveTo(0, y(c)); g.lineTo(W, y(c)); g.stroke();
      g.fillText((c > 0 ? "+" : "") + c, 2, y(c) - 2);
    });

    // Neighbour + target lines.
    [k - 1, k, k + 1].forEach((kk) => {
      const rel = M.targetCents(kk, state.tune) - tc;
      if (rel < lo || rel > hi) return;
      const pos = ((kk % 12) + 12) % 12;
      const inR = M.inRaga(state.raga, pos);
      g.strokeStyle = inR ? getCss("--in", "#4ade80") : getCss("--out", "#f87171");
      g.setLineDash(kk === k ? [] : [5, 4]);
      g.beginPath(); g.moveTo(0, y(rel)); g.lineTo(W, y(rel)); g.stroke();
      g.setLineDash([]);
      g.fillStyle = g.strokeStyle;
      g.fillText(M.swaraName(pos, state.tradition) + " " + (rel > 0 ? "+" : "") + Math.round(rel), W - 56, y(rel) - 3);
    });

    // Last 4s of smoothed pitch (relative to target).
    const now = res.t || (ctx ? ctx.currentTime : 0);
    const pts = trace.filter((p) => p.smooth != null && now - p.t <= 4);
    g.lineWidth = 2;
    g.strokeStyle = getCss("--trace", "#38bdf8");
    g.beginPath();
    pts.forEach((p, i) => {
      const x = ((p.t - (now - 4)) / 4) * W;
      const yy = y(p.smooth - tc);
      if (i === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
    });
    g.stroke();

    // Current dot.
    if (res.attempt != null) {
      const off = Math.abs(res.attempt - tc);
      g.fillStyle = offsetColor(off);
      g.beginPath(); g.arc(W - 6, y(res.attempt - tc), 5, 0, Math.PI * 2); g.fill();
    }
  }

  // --- Canvas: full-width trace ----------------------------------------
  let traceCenter = 1850; // cents, smoothed re-center
  function drawTrace() {
    const cv = $("traceCanvas");
    const g = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = getCss("--card2", "#111827");
    g.fillRect(0, 0, W, H);

    const now = (_traceNowOverride != null) ? _traceNowOverride
      : (ctx ? ctx.currentTime : (trace.length ? trace[trace.length - 1].t : 0));
    const span = state.spanSec;

    // Re-center Y smoothly on median of last 2.5s.
    const recent = trace.filter((p) => p.smooth != null && now - p.t <= 2.5).map((p) => p.smooth);
    if (recent.length) {
      const med = recent.slice().sort((a, b) => a - b)[Math.floor(recent.length / 2)];
      traceCenter += 0.04 * (med - traceCenter); // gentler recenter = less shimmer
    }
    const halfSpanCents = (H / 2) / (20 / 100); // ~20px per semitone -> cents
    const loC = traceCenter - halfSpanCents;
    const hiC = traceCenter + halfSpanCents;
    const y = (c) => H - ((c - loC) / (hiC - loC)) * H;
    const x = (t) => ((t - (now - span)) / span) * W;

    // Position lines across the visible range.
    const kLo = Math.floor(loC / 100) - 1, kHi = Math.ceil(hiC / 100) + 1;
    const tight = (hiC - loC) / 100 > 24;
    for (let k = kLo; k <= kHi; k++) {
      const c = M.targetCents(k, state.tune);
      if (c < loC || c > hiC) continue;
      const pos = ((k % 12) + 12) % 12;
      const isSa = pos === 0;
      const inR = M.inRaga(state.raga, pos);
      g.strokeStyle = isSa ? getCss("--gold", "#eab308")
        : inR ? getCss("--in", "#4ade80") : getCss("--out", "#f87171");
      g.setLineDash(inR || isSa ? [] : [4, 4]);
      g.globalAlpha = isSa ? 0.9 : 0.5;
      g.beginPath(); g.moveTo(40, y(c)); g.lineTo(W, y(c)); g.stroke();
      g.globalAlpha = 1;
      g.setLineDash([]);
      if (!tight || inR || isSa) {
        g.fillStyle = g.strokeStyle;
        g.font = "11px sans-serif";
        g.fillText(M.swaraName(pos, state.tradition), 4, y(c) + 4);
      }
    }

    // Second ticks + "now".
    g.strokeStyle = "rgba(148,163,184,0.15)";
    g.fillStyle = getCss("--muted", "#94a3b8");
    g.font = "10px sans-serif";
    for (let s = Math.ceil(now - span); s <= now; s++) {
      const xx = x(s);
      g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, H); g.stroke();
    }

    // Raw dots + smoothed line.
    const vis = trace.filter((p) => now - p.t <= span);
    g.fillStyle = "rgba(148,163,184,0.25)"; // fainter raw dots
    vis.forEach((p) => {
      if (p.raw == null) return;
      g.fillRect(x(p.t) - 0.5, y(p.raw) - 0.5, 1.5, 1.5);
    });
    g.lineWidth = 2.5;
    let drawing = false;
    vis.forEach((p) => {
      if (p.smooth == null) { drawing = false; return; }
      const pos = p.target != null ? (((p.target % 12) + 12) % 12) : 0;
      g.strokeStyle = M.inRaga(state.raga, pos) ? getCss("--in", "#4ade80") : getCss("--out", "#f87171");
      const xx = x(p.t), yy = y(p.smooth);
      if (!drawing) { g.beginPath(); g.moveTo(xx, yy); drawing = true; }
      else { g.lineTo(xx, yy); g.stroke(); g.beginPath(); g.moveTo(xx, yy); }
    });
  }

  function getCss(varName, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(varName).trim();
    return v || fallback;
  }

  // --- Mic pipeline -----------------------------------------------------
  function ensureAudio() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ctx.destination;
      drone = DroneFactory.createDrone(ctx, dest);
      drone.setSa(state.saFreq);
      drone.setRagaSet(state.ragaSet);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  async function startMic() {
    ensureAudio();
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: !state.headphones,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (e) {
      setStatus("Microphone blocked. Allow mic access in your browser settings and reload.");
      return false;
    }
    const src = ctx.createMediaStreamSource(micStream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    timeBuf = new Float32Array(analyser.fftSize);
    freqBuf = new Float32Array(analyser.frequencyBinCount);
    // Keep the graph processing by routing through a zero gain to destination.
    zeroGain = ctx.createGain();
    zeroGain.gain.value = 0;
    src.connect(analyser);
    analyser.connect(zeroGain).connect(ctx.destination);
    return true;
  }

  function stopMic() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  function analysisFrame() {
    const now = ctx.currentTime;
    const dt = lastT < 0 ? 0.016 : now - lastT;
    lastT = now;

    analyser.getFloatTimeDomainData(timeBuf);
    analyser.getFloatFrequencyData(freqBuf);
    // Convert dB FFT to linear magnitudes for centroid.
    const mags = new Float32Array(freqBuf.length);
    for (let i = 0; i < mags.length; i++) mags[i] = Math.pow(10, freqBuf[i] / 20);

    const dB = Yin.rmsDb(timeBuf);
    const det = Yin.detect(timeBuf, ctx.sampleRate);
    const centroid = det && det.voiced ? Yin.spectralCentroid(mags, ctx.sampleRate, analyser.fftSize) : 0;

    const res = analyzer.process({
      t: now, dB, det, centroid,
      saFreq: state.saFreq, tune: state.tune, ragaSet: state.ragaSet,
    }, dt);
    res.t = now;
    lastResult = res;

    // Level meter + gate tick.
    updateLevelMeter(dB, analyzer.gateValue);

    // Status during calibration.
    if (analyzer.isCalibrating) setStatus("Checking the room. Stay quiet for a second.");
    else if (state.statusDefault) setStatus(state.statusDefault);

    // Full-session recording (kept until Reset/Clear or Sa change).
    if (!analyzer.isCalibrating) {
      if (!recStart) recStart = now;
      recFrames.push([
        +(now - recStart).toFixed(3),
        res.smoothCents != null ? +res.smoothCents.toFixed(1) : null,
        res.rawCents != null ? +res.rawCents.toFixed(1) : null,
        res.smoothCents != null ? res.target : null,
        +dB.toFixed(1),
        det && det.voiced ? +det.clarity.toFixed(2) : null,
        centroid ? Math.round(centroid) : null,
      ]);
    }

    // Record trace.
    if (!state.frozen) {
      trace.push({ t: now, raw: res.rawCents, smooth: res.smoothCents, target: res.target, voiced: res.voiced });
      const cutoff = now - 25;
      while (trace.length && trace[0].t < cutoff) trace.shift();
    }

    // Render.
    if (res.voiced && res.target != null) {
      renderNotePanel(res);
      $("noteCard").classList.remove("note--last");
      highlightKey(res.target);
    } else if (lastResult) {
      $("noteCard").classList.add("note--last"); // fade, keep last note
    }
    const freshStats = analyzer.segmentStats(state.tune, state.raga);
    if (freshStats) { _lastStats = smoothStats(freshStats); _lastGamaka = freshStats.gamaka; }
    renderSteadyTiles(_lastStats);
    renderGamakaTag(res, freshStats);
    drawZoom(res.voiced ? res : lastVoicedRes(res));
    drawTrace();
    renderSessionTable();

    rafId = requestAnimationFrame(analysisFrame);
  }

  let _lastVoiced = null;
  function lastVoicedRes(res) {
    if (res && res.voiced) _lastVoiced = res;
    return _lastVoiced;
  }

  function updateLevelMeter(dB, gate) {
    const toPct = (d) => Math.max(0, Math.min(100, ((d + 90) / 90) * 100));
    $("levelFill").style.width = (isFinite(dB) ? toPct(dB) : 0) + "%";
    $("gateTick").style.left = toPct(gate) + "%";
  }

  function setStatus(msg) { $("status").textContent = msg; }

  // --- Example first-view ----------------------------------------------
  // Synthesize a believable result object for the static example so panels
  // show realistic data before the mic starts.
  function exampleResult() {
    // Target Ga3 (k=4) sung ~8¢ flat.
    const k = 4;
    const tc = M.targetCents(k, state.tune);
    return {
      voiced: true, target: k, attempt: tc - 8,
      topProb: 0.86, secondK: 3, secondProb: 0.14, secondOffset: 60,
      rawCents: tc - 8, smoothCents: tc - 8, t: 0,
    };
  }

  let exampleRaf = null;
  function startExampleLoop() {
    // Build a short synthetic trace: Sa Ri2 Ga3 Ma1 Pa Da2 Ni3 Sa^ Pa Ga3.
    const seq = [0, 2, 4, 5, 7, 9, 11, 12, 7, 4];
    const perNote = 0.6;
    trace = [];
    let t = 0;
    seq.forEach((k, idx) => {
      const tc = M.targetCents(k, state.tune);
      const flaw = (idx % 3 === 0) ? -12 : (idx % 4 === 0 ? 10 : 0);
      for (let i = 0; i < 24; i++) {
        const vib = Math.sin(i / 2) * 4;
        const gap = i > 21; // small gaps between notes
        trace.push({
          t, raw: gap ? null : tc + flaw + vib + (Math.random() * 3 - 1.5),
          smooth: gap ? null : tc + flaw + vib * 0.6,
          target: k, voiced: !gap,
        });
        t += perNote / 24;
      }
    });
    traceCenter = M.targetCents(5, state.tune);

    renderNotePanel(exampleResult());
    renderSteadyTiles({ wobble: 7, drift: 3, heldInTune: 1.2, volSd: 1.4, tonePct: 6, clarityPct: 88, rate: 5.2, oscillating: true });

    // animate the example trace scrolling once
    const endT = t;
    const t0 = performance.now();
    function tickEx() {
      if (!state.example) return;
      const elapsed = ((performance.now() - t0) / 1000) % endT;
      // shift trace timestamps so "now" scrolls
      const now = elapsed;
      drawExampleTrace(now, endT);
      drawZoom(exampleResult());
      exampleRaf = requestAnimationFrame(tickEx);
    }
    tickEx();
  }

  function drawExampleTrace(now) {
    // Temporarily treat `trace` with a fake now by shifting the x mapping.
    const cv = $("traceCanvas");
    const g = cv.getContext("2d");
    const save = ctx;
    // Reuse drawTrace by faking ctx.currentTime via a shim.
    const fakeNow = now;
    // Minimal inline render: delegate to drawTrace with a temporary override.
    _traceNowOverride = fakeNow;
    drawTrace();
    _traceNowOverride = null;
  }

  // Allow drawTrace to use an override "now" for the example.
  let _traceNowOverride = null;
  const _origNowGetter = () => (_traceNowOverride != null ? _traceNowOverride
    : (ctx ? ctx.currentTime : (trace.length ? trace[trace.length - 1].t : 0)));

  function stopExampleLoop() {
    if (exampleRaf) cancelAnimationFrame(exampleRaf);
    exampleRaf = null;
  }

  // --- Control wiring ---------------------------------------------------
  function wireControls() {
    $("saNote").addEventListener("change", (e) => {
      state.sa.noteIndex = parseInt(e.target.value, 10);
      recomputeSa(); clearSessionAndTrace(); renderKeyboard();
    });
    $("saOctave").addEventListener("change", (e) => {
      state.sa.octave = parseInt(e.target.value, 10);
      recomputeSa(); clearSessionAndTrace(); renderKeyboard();
    });
    $("saFine").addEventListener("input", (e) => {
      state.sa.fineCents = parseInt(e.target.value, 10);
      recomputeSa(); renderKeyboard();
    });
    $("ragaSelect").addEventListener("change", (e) => setRaga(e.target.value));

    // Tradition + tuning segmented controls.
    $("tradSeg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-trad]"); if (!b) return;
      segOn($("tradSeg"), b);
      state.tradition = b.dataset.trad;
      relabelSaNotes(); renderRagaPanel(); renderKeyboard(); renderSessionTable();
      if (lastResult) renderNotePanel(lastResult);
    });
    $("tuneSeg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tune]"); if (!b) return;
      segOn($("tuneSeg"), b);
      state.tuning = b.dataset.tune;
      state.tune = M.tuneTable(state.tuning);
      renderKeyboard();
    });
    $("spanSeg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-span]"); if (!b) return;
      segOn($("spanSeg"), b);
      state.spanSec = parseInt(b.dataset.span, 10);
    });

    $("freezeBtn").addEventListener("click", () => {
      state.frozen = !state.frozen;
      $("freezeBtn").classList.toggle("btn--primary", state.frozen);
      $("freezeBtn").textContent = state.frozen ? "Frozen" : "Freeze";
    });
    $("clearBtn").addEventListener("click", () => { trace = []; });

    $("startBtn").addEventListener("click", toggleStart);
    $("droneBtn").addEventListener("click", toggleDrone);
    $("themeBtn").addEventListener("click", toggleTheme);
    $("singSaBtn").addEventListener("click", singMySa);
    $("reportBtn").addEventListener("click", exportReport);
    $("saveJsonBtn").addEventListener("click", () => exportSession("json"));
    $("saveCsvBtn").addEventListener("click", () => exportSession("csv"));
    $("resetSessionBtn").addEventListener("click", () => {
      recFrames = []; recStart = 0;
      analyzer && analyzer.resetSession();
      renderSessionTable();
      $("scorePanel").hidden = true;
    });
    $("scoreBtn").addEventListener("click", showScore);
    $("playScaleBtn").addEventListener("click", playScale);

    // Drone panel.
    $("droneTypeSeg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-drone]"); if (!b) return;
      segOn($("droneTypeSeg"), b);
      const t = b.dataset.drone;
      $("tanpuraOpts").style.display = t === "tanpura" ? "" : "none";
      $("airWrap").style.display = t === "breath" ? "none" : "";
      ensureAudio(); drone.setType(t);
    });
    $("droneVolSlider").addEventListener("input", (e) => { ensureAudio(); drone.setVolume(e.target.value / 100); });
    $("droneAirSlider").addEventListener("input", (e) => { ensureAudio(); drone.setAir(e.target.value / 100); });
    $("firstStringSel").addEventListener("change", (e) => { ensureAudio(); drone.setFirstString(e.target.value); });
    $("cycleSlider").addEventListener("input", (e) => {
      $("cycleVal").textContent = (+e.target.value).toFixed(1) + "s";
      ensureAudio(); drone.setCycle(+e.target.value);
    });

    // Mic panel.
    $("marginSlider").addEventListener("input", (e) => {
      state.gateMargin = +e.target.value;
      $("marginVal").textContent = state.gateMargin + " dB";
      if (analyzer) analyzer.setGateMargin(state.gateMargin);
    });
    const smoothMap = [3, 5, 7, 9, 11];
    $("smoothSlider").addEventListener("input", (e) => {
      state.smoothingN = smoothMap[+e.target.value];
      $("smoothVal").textContent = String(state.smoothingN);
      if (analyzer) analyzer.setSmoothingN(state.smoothingN);
    });
    $("headphonesChk").addEventListener("change", async (e) => {
      state.headphones = e.target.checked;
      if (state.running) { stopMic(); await startMic(); analyzer.startCalibration(ctx.currentTime); }
    });
    $("recheckBtn").addEventListener("click", () => {
      if (analyzer && ctx) analyzer.startCalibration(ctx.currentTime);
    });
  }

  function segOn(container, btn) {
    [...container.children].forEach((c) => c.classList.remove("seg__btn--on"));
    btn.classList.add("seg__btn--on");
  }

  // --- Start / stop -----------------------------------------------------
  async function toggleStart() {
    if (state.running) {
      state.running = false;
      stopMic();
      releaseWakeLock();
      $("startBtn").textContent = "Start singing";
      $("startBtn").classList.remove("btn--danger");
      setStatus("Stopped.");
      return;
    }
    setStatus("Requesting microphone…");
    ensureAudio();
    const ok = await startMic();
    if (!ok) return;

    // leave example mode
    state.example = false;
    stopExampleLoop();
    trace = [];
    _lastStats = null;
    _easedStats = null;
    _lastGamaka = null;
    analyzer = Analysis.createAnalyzer({ smoothingN: state.smoothingN, gateMargin: state.gateMargin });
    analyzer.startCalibration(ctx.currentTime);
    lastT = -1;
    state.statusDefault = "Listening…";
    state.running = true;
    $("startBtn").textContent = "Stop";
    $("startBtn").classList.add("btn--danger");
    requestWakeLock();
    analysisFrame();
  }

  function toggleDrone() {
    ensureAudio();
    if (!drone) return;
    if (drone.isOn) {
      drone.stop();
      $("droneBtn").textContent = "Drone: Off";
      $("droneBtn").classList.remove("btn--primary");
    } else {
      drone.start();
      $("droneBtn").textContent = "Drone: On";
      $("droneBtn").classList.add("btn--primary");
    }
  }

  // --- Sing my Sa -------------------------------------------------------
  async function singMySa() {
    ensureAudio();
    if (!state.running) {
      const ok = await startMic(); if (!ok) return;
    }
    setStatus("Sing your Sa and hold it…");
    const samples = [];
    const started = ctx.currentTime;
    const grab = () => {
      analyser.getFloatTimeDomainData(timeBuf);
      const det = Yin.detect(timeBuf, ctx.sampleRate);
      if (det && det.voiced) samples.push(det.freq);
      if (ctx.currentTime - started < 1.2 && samples.length < 60) {
        setTimeout(grab, 20); return;
      }
      if (samples.length < 5) { setStatus("Didn't catch a steady Sa. Try again."); return; }
      samples.sort((a, b) => a - b);
      const medFreq = samples[Math.floor(samples.length / 2)];
      const midi = 69 + 12 * Math.log2(medFreq / M.A4);
      const nearest = Math.round(midi);
      const noteIndex = ((nearest % 12) + 12) % 12;
      const octave = Math.floor(nearest / 12) - 1;
      const fine = Math.max(-50, Math.min(50, Math.round((midi - nearest) * 100)));
      state.sa = { noteIndex, octave: Math.max(1, Math.min(5, octave)), fineCents: fine };
      $("saNote").value = String(noteIndex);
      $("saOctave").value = String(state.sa.octave);
      $("saFine").value = String(fine);
      recomputeSa(); renderKeyboard(); clearSessionAndTrace();
      setStatus("Sa set from your voice: " + state.saFreq.toFixed(1) + " Hz.");
    };
    grab();
  }

  // --- Play scale -------------------------------------------------------
  async function playScale() {
    ensureAudio();
    const r = state.raga;
    const aroha = r.aroha || [0,2,4,5,7,9,11];
    const avaroha = r.avaroha || aroha.slice().reverse();
    const seq = [...aroha, ...avaroha];
    let i = 0;
    const step = () => {
      if (i >= seq.length) { highlightKey(null); return; }
      const k = seq[i];
      const f = M.centsToFreq(state.saFreq, M.targetCents(k, state.tune));
      drone.playTone(f, 0.42);
      highlightKey(k);
      i++;
      setTimeout(step, 420);
    };
    step();
  }

  // --- Composite score --------------------------------------------------
  function showScore() {
    if (!analyzer) { setStatus("Start singing first, then tap Score me."); return; }
    const sc = analyzer.sessionScore();
    const panel = $("scorePanel");
    if (!sc || sc.notReady) {
      panel.hidden = false;
      $("scoreNum").textContent = "—";
      const gotN = sc ? sc.voicedSec : 0;
      const got = gotN.toFixed(1);
      $("scoreLabel").textContent = gotN < 0.5
        ? "Barely any clear singing detected (" + got + "s). Check the mic: the blue level bar should cross the red gate tick when you sing — if not, lower \u201cIgnore background\u201d."
        : "Need ~2s of in-tune singing (have " + got + "s). Hold steady notes near a swara against the drone, then try again.";
      $("scoreBars").innerHTML = "";
      $("scoreTip").textContent = "";
      return;
    }
    panel.hidden = false;
    $("scoreNum").textContent = String(sc.composite);
    $("scoreLabel").textContent = sc.label + " · " + sc.voicedSec.toFixed(0) + "s sung";

    const bars = [
      ["Intonation", sc.parts.intonation, "how close to the target"],
      ["Consistency", sc.parts.consistency, "how tight your spread"],
      ["Stability", sc.parts.stability, "how steady you held"],
      ["Coverage", sc.parts.coverage, "range + time sung"],
    ];
    $("scoreBars").innerHTML = bars.map(([label, val, desc]) =>
      '<div class="score__row" title="' + desc + '">' +
        '<span class="score__rowlbl">' + label + "</span>" +
        '<span class="score__track"><span class="score__fill" style="width:' + val + '%"></span></span>' +
        '<span class="score__val">' + val + "</span></div>" +
      '<div class="score__desc">' + desc + "</div>"
    ).join("");

    if (sc.worst) {
      const name = M.swaraName(sc.worst.pos, state.tradition);
      const dir = sc.worst.meanOffset > 0 ? "sharp" : "flat";
      $("scoreTip").textContent =
        "Biggest win: tighten " + name + " — " +
        Math.abs(Math.round(sc.worst.meanOffset)) + "¢ " + dir +
        ", ±" + Math.round(sc.worst.spread) + "¢ spread.";
    } else {
      $("scoreTip").textContent = "";
    }
  }

  // --- Theme + wake lock ------------------------------------------------
  function toggleTheme() {
    const b = document.body;
    b.dataset.theme = b.dataset.theme === "dark" ? "light" : "dark";
  }
  async function requestWakeLock() {
    try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }

})();
