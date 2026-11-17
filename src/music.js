/*
 * music.js — Music model for Riyaz.
 *
 * Positions (0–11), Sa tuning, ragas, tuning systems, names/labels, registers.
 * Pure logic, no DOM, no audio. Exported on window.Music.
 */
(function (global) {
  "use strict";

  const A4 = 440;

  // --- Note names and tradition-specific labels -------------------------
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const NOTE_NAMES_PRETTY = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

  // Carnatic kattai numbers per chromatic note.
  const KATTAI = ["1", "1½", "2", "2½", "3", "4", "4½", "5", "5½", "6", "6½", "7"];

  // Hindustani harmonium key labels (white/black) per chromatic note.
  const HARMONIUM = [
    "White 1", "Black 1", "White 2", "Black 2", "White 3",
    "White 4", "Black 3", "White 5", "Black 4", "White 6",
    "Black 5", "White 7",
  ];

  // --- 12 positions above Sa --------------------------------------------
  // Just-intonation cents above Sa, from the spec.
  const JUST_CENTS = [
    0, 111.73, 203.91, 315.64, 386.31, 498.04,
    590.22, 701.96, 813.69, 884.36, 1017.60, 1088.27,
  ];

  // Carnatic names: default plus alias (dual-named positions).
  // Long names included for the detail readout.
  const POSITIONS = [
    { pos: 0,  car: ["Sa"],         carLong: "shadjam",                 hin: "Sa",        hinLong: "Sa" },
    { pos: 1,  car: ["Ri1"],        carLong: "shuddha rishabham",       hin: "re",        hinLong: "komal Re" },
    { pos: 2,  car: ["Ri2", "Ga1"], carLong: "chatushruti rishabham",   hin: "Re",        hinLong: "shuddh Re" },
    { pos: 3,  car: ["Ga2", "Ri3"], carLong: "sadharana gandharam",     hin: "ga",        hinLong: "komal Ga" },
    { pos: 4,  car: ["Ga3"],        carLong: "antara gandharam",        hin: "Ga",        hinLong: "shuddh Ga" },
    { pos: 5,  car: ["Ma1"],        carLong: "shuddha madhyamam",       hin: "ma",        hinLong: "shuddh Ma" },
    { pos: 6,  car: ["Ma2"],        carLong: "prati madhyamam",         hin: "Ma",        hinLong: "tivra Ma" },
    { pos: 7,  car: ["Pa"],         carLong: "panchamam",               hin: "Pa",        hinLong: "Pa" },
    { pos: 8,  car: ["Da1"],        carLong: "shuddha dhaivatam",       hin: "dha",       hinLong: "komal Dha" },
    { pos: 9,  car: ["Da2", "Ni1"], carLong: "chatushruti dhaivatam",   hin: "Dha",       hinLong: "shuddh Dha" },
    { pos: 10, car: ["Ni2", "Da3"], carLong: "kaishiki nishadam",       hin: "ni",        hinLong: "komal Ni" },
    { pos: 11, car: ["Ni3"],        carLong: "kakali nishadam",         hin: "Ni",        hinLong: "shuddh Ni" },
  ];

  // --- Registers --------------------------------------------------------
  // Index by octave offset from madhya (0). Clamp to available names.
  const REGISTERS = {
    carnatic: { names: ["anumandra", "mandra", "madhya", "tara", "ati-tara"], suffix: "sthayi", center: 2 },
    hindustani: { names: ["ati-mandra", "mandra", "madhya", "taar", "ati-taar"], suffix: "saptak", center: 2 },
  };

  // --- Ragas ------------------------------------------------------------
  // Scales given as position arrays. "^" upper Sa is represented as pos 0 at
  // octave +1 implicitly; for membership we only need the pitch classes.
  const RAGAS = [
    {
      id: "none", name: "Any swara", tradition: "–", family: "–",
      desc: "All twelve positions are allowed.",
      aroha: [0,1,2,3,4,5,6,7,8,9,10,11], avaroha: null,
    },
    {
      id: "hamsadhwani", name: "Hamsadhwani", tradition: "Carnatic", family: "Janya of 29",
      desc: "Pentatonic, bright and auspicious.",
      aroha: [0,2,4,7,11], avaroha: null,
    },
    {
      id: "dharmavati", name: "Dharmavati", tradition: "Carnatic", family: "Mela 59",
      desc: "Sampurna with prati madhyamam and sadharana gandharam.",
      aroha: [0,2,3,6,7,9,11], avaroha: null,
    },
    {
      id: "charukesi", name: "Charukesi", tradition: "Carnatic", family: "Mela 26",
      desc: "Major-scale lower half with komal Da and Ni.",
      aroha: [0,2,4,5,7,8,10], avaroha: null,
    },
    {
      id: "shankarabharanam", name: "Shankarabharanam", tradition: "Carnatic", family: "Mela 29",
      desc: "The Carnatic major scale.",
      aroha: [0,2,4,5,7,9,11], avaroha: null,
    },
    {
      id: "kalyani", name: "Kalyani", tradition: "Carnatic", family: "Mela 65",
      desc: "Major scale with prati madhyamam (Lydian).",
      aroha: [0,2,4,6,7,9,11], avaroha: null,
    },
    {
      id: "saraswati", name: "Saraswati", tradition: "Carnatic", family: "Janya of 64",
      desc: "Audava-shadava with prati madhyamam; Ga and Ni dropped in aroha.",
      aroha: [0,2,6,7,9], avaroha: [0,11,9,7,6,2,0],
    },
    {
      id: "ahirbhairav", name: "Ahir Bhairav", tradition: "Hindustani", family: "Bhairav + Kafi",
      desc: "Komal Re with shuddh Dha and komal Ni.",
      aroha: [0,1,4,5,7,9,10], avaroha: null,
    },
  ];

  const RAGA_BY_ID = Object.fromEntries(RAGAS.map((r) => [r.id, r]));

  /** The set of allowed pitch classes (0–11) for a raga. */
  function ragaPositions(raga) {
    if (!raga || raga.id === "none") return new Set([0,1,2,3,4,5,6,7,8,9,10,11]);
    const s = new Set(raga.aroha);
    if (raga.avaroha) raga.avaroha.forEach((p) => s.add(p));
    return s;
  }

  function inRaga(raga, pos) {
    const p = ((pos % 12) + 12) % 12;
    return ragaPositions(raga).has(p);
  }

  // --- Sa frequency -----------------------------------------------------
  // noteIndex: chromatic 0..11 (C..B). octave: scientific octave number.
  // fineCents: -50..+50. Returns Hz.
  function saFrequency(noteIndex, octave, fineCents) {
    // MIDI number for the note at the given octave. MIDI 69 = A4.
    const midi = (octave + 1) * 12 + noteIndex;
    const base = A4 * Math.pow(2, (midi - 69) / 12);
    return base * Math.pow(2, (fineCents || 0) / 1200);
  }

  /** Default Sa: C#3 = 138.59 Hz. noteIndex 1 (C#), octave 3, 0 cents. */
  function defaultSa() {
    return { noteIndex: 1, octave: 3, fineCents: 0 };
  }

  // --- Tuning -----------------------------------------------------------
  // tune[pos] in cents for the chosen system.
  function tuneTable(system) {
    if (system === "equal") return JUST_CENTS.map((_, i) => i * 100);
    return JUST_CENTS.slice();
  }

  /** Target cents of absolute note index k relative to Sa. k = octave*12+pos. */
  function targetCents(k, tune) {
    const pos = ((k % 12) + 12) % 12;
    const oct = Math.floor(k / 12);
    return oct * 1200 + tune[pos];
  }

  // --- Names ------------------------------------------------------------
  /**
   * Short swara name for a position, respecting tradition and raga aliasing.
   * For dual-named Carnatic positions, pick the alias the raga uses if the
   * primary isn't in the raga but the alias "fits" — we keep it simple and
   * always use the default (first) name; raga context mainly affects colour.
   */
  function swaraName(pos, tradition) {
    const p = ((pos % 12) + 12) % 12;
    const entry = POSITIONS[p];
    if (tradition === "hindustani") return entry.hin;
    return entry.car[0];
  }

  function swaraAlias(pos, tradition) {
    const p = ((pos % 12) + 12) % 12;
    const entry = POSITIONS[p];
    if (tradition === "hindustani") return null;
    return entry.car[1] || null;
  }

  function swaraLong(pos, tradition) {
    const p = ((pos % 12) + 12) % 12;
    const entry = POSITIONS[p];
    return tradition === "hindustani" ? entry.hinLong : entry.carLong;
  }

  /** Octave dots string: dots above for +octaves, below for −octaves. */
  function octaveDots(octaveOffset) {
    if (octaveOffset > 0) return "˙".repeat(octaveOffset);   // above (rendered via CSS too)
    if (octaveOffset < 0) return ".".repeat(-octaveOffset);  // below
    return "";
  }

  function registerName(octaveOffset, tradition) {
    const reg = REGISTERS[tradition === "hindustani" ? "hindustani" : "carnatic"];
    const idx = Math.max(0, Math.min(reg.names.length - 1, reg.center + octaveOffset));
    return reg.names[idx] + " " + reg.suffix;
  }

  function kattaiLabel(noteIndex) { return KATTAI[((noteIndex % 12) + 12) % 12]; }
  function harmoniumLabel(noteIndex) { return HARMONIUM[((noteIndex % 12) + 12) % 12]; }

  /** Western note name + octave for a frequency. */
  function freqToWestern(freq) {
    const midi = 69 + 12 * Math.log2(freq / A4);
    const rounded = Math.round(midi);
    const name = NOTE_NAMES_PRETTY[((rounded % 12) + 12) % 12];
    const oct = Math.floor(rounded / 12) - 1;
    const cents = Math.round((midi - rounded) * 100);
    return { name: name + oct, cents };
  }

  function centsToFreq(saFreq, cents) {
    return saFreq * Math.pow(2, cents / 1200);
  }

  /** Nearest absolute note index k for a cents value, using a tuning table. */
  function nearestK(cents, tune) {
    const octave = Math.floor(cents / 1200);
    const within = cents - octave * 1200;
    let bestPos = 0, bestD = Infinity;
    for (let p = 0; p < 12; p++) {
      let d = Math.abs(within - tune[p]);
      d = Math.min(d, Math.abs(within - (tune[p] + 1200)), Math.abs(within - (tune[p] - 1200)));
      if (d < bestD) { bestD = d; bestPos = p; }
    }
    return { k: octave * 12 + bestPos, pos: bestPos, offCents: bestD };
  }

  /**
   * Analyse a gamaka (an oscillation/slide) given its cents samples and the
   * current raga + tuning. Returns the center swara, the two turning points,
   * whether every anchor sits on a raga-allowed swara, and any stray note.
   *
   * "within the raga" (pitch-class) = the oscillation CENTER and its turning
   * points each snap to a raga-allowed swara within `tol` cents. A gamaka that
   * only brushes a neighbour briefly is NOT flagged — only one that centers or
   * turns onto a forbidden swara counts as a stray.
   */
  function gamakaRagaCheck(centsSamples, raga, tune, tol) {
    tol = tol == null ? 40 : tol;
    if (!centsSamples || centsSamples.length < 3) return null;
    const n = centsSamples.length;
    const sorted = centsSamples.slice().sort((a, b) => a - b);
    const lo = sorted[Math.floor(n * 0.1)];
    const hi = sorted[Math.ceil(n * 0.9) - 1];
    const mean = centsSamples.reduce((a, b) => a + b, 0) / n;
    const center = nearestK(mean, tune);

    // A gamaka "settles" on a swara only where it DWELLS — not where it merely
    // passes through. Snap every sample to its nearest swara and measure how
    // much time (fraction of samples) is spent within `tol` of each swara. A
    // neighbour that's only brushed in passing gets little dwell and is ignored.
    const dwell = {}; // pos -> fraction of samples anchored near it
    for (const c of centsSamples) {
      const nk = nearestK(c, tune);
      if (nk.offCents <= tol) dwell[nk.pos] = (dwell[nk.pos] || 0) + 1 / n;
    }

    // Flag a position as a stray only if the gamaka dwells there meaningfully
    // (≥20% of its time) AND it's outside the raga.
    const DWELL_MIN = 0.2;
    const strayPositions = Object.keys(dwell)
      .map(Number)
      .filter((pos) => dwell[pos] >= DWELL_MIN && !inRaga(raga, pos));

    const centerInRaga = center.offCents <= tol ? inRaga(raga, center.pos) : true;

    return {
      center,
      low: nearestK(lo, tune),
      high: nearestK(hi, tune),
      depthCents: hi - lo,
      dwell,
      inRaga: strayPositions.length === 0 && centerInRaga,
      strayPositions,
    };
  }

  global.Music = {
    A4,
    NOTE_NAMES, NOTE_NAMES_PRETTY, KATTAI, HARMONIUM,
    JUST_CENTS, POSITIONS, REGISTERS, RAGAS, RAGA_BY_ID,
    ragaPositions, inRaga,
    saFrequency, defaultSa,
    tuneTable, targetCents,
    swaraName, swaraAlias, swaraLong, octaveDots, registerName,
    kattaiLabel, harmoniumLabel, freqToWestern, centsToFreq,
    nearestK, gamakaRagaCheck,
  };
})(window);
