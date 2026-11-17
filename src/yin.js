/*
 * yin.js — YIN pitch detection + spectral centroid.
 *
 * Implements the YIN algorithm (de Cheveigné & Kawahara) with the cumulative
 * mean normalised difference, a first-dip search, and parabolic interpolation.
 * Exported on window.Yin.
 */
(function (global) {
  "use strict";

  const FMIN = 62;
  const FMAX = 1100;
  const DIP_THRESHOLD = 0.15;   // first dip below this is accepted
  const FALLBACK_THRESHOLD = 0.35; // global-min fallback must be below this
  const VOICED_AP = 0.3;        // aperiodicity below this = voiced

  /**
   * Detect pitch from a time-domain buffer.
   * @param {Float32Array} buf   samples in [-1, 1]
   * @param {number} sampleRate  Hz
   * @returns {{freq:number, ap:number, clarity:number, voiced:boolean}|null}
   */
  function detect(buf, sampleRate) {
    const n = buf.length;
    const tauMin = Math.max(2, Math.floor(sampleRate / FMAX));
    const tauMax = Math.min(n - 1, Math.ceil(sampleRate / FMIN));
    if (tauMax <= tauMin) return null;

    // Difference function d(tau).
    const d = new Float32Array(tauMax + 1);
    for (let tau = tauMin; tau <= tauMax; tau++) {
      let sum = 0;
      const lim = n - tau;
      for (let i = 0; i < lim; i++) {
        const diff = buf[i] - buf[i + tau];
        sum += diff * diff;
      }
      d[tau] = sum;
    }

    // Cumulative mean normalised difference d'(tau).
    const cmnd = new Float32Array(tauMax + 1);
    cmnd[tauMin] = 1;
    let running = 0;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      running += d[tau];
      cmnd[tau] = running === 0 ? 1 : d[tau] * (tau - tauMin + 1) / running;
    }

    // First dip below threshold; then walk down to the local minimum.
    let tauEst = -1;
    for (let tau = tauMin + 1; tau <= tauMax; tau++) {
      if (cmnd[tau] < DIP_THRESHOLD) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        tauEst = tau;
        break;
      }
    }

    // Fallback: global minimum, only if convincingly periodic.
    if (tauEst === -1) {
      let min = Infinity, minTau = -1;
      for (let tau = tauMin + 1; tau <= tauMax; tau++) {
        if (cmnd[tau] < min) { min = cmnd[tau]; minTau = tau; }
      }
      if (minTau === -1 || min > FALLBACK_THRESHOLD) return null;
      tauEst = minTau;
    }

    // Parabolic interpolation for sub-sample accuracy. Interpolate on the raw
    // difference function d (sharper and less biased than the cumulative cmnd),
    // which matters at higher frequencies where the period spans few samples.
    let betterTau = tauEst;
    if (tauEst > tauMin && tauEst < tauMax) {
      const d0 = d[tauEst - 1];
      const d1 = d[tauEst];
      const d2 = d[tauEst + 1];
      const denom = d0 + d2 - 2 * d1;
      if (denom !== 0) {
        const shift = (d0 - d2) / (2 * denom);
        if (shift > -1 && shift < 1) betterTau = tauEst + shift;
      }
    }

    const freq = sampleRate / betterTau;
    if (freq < FMIN || freq > FMAX) return null;

    const ap = Math.max(0, Math.min(1, cmnd[tauEst]));
    return { freq, ap, clarity: 1 - ap, voiced: ap < VOICED_AP };
  }

  /**
   * Spectral centroid (Hz) from FFT magnitudes, between 80 and 5000 Hz.
   * @param {Float32Array} mags  magnitude spectrum (length = fftSize/2)
   * @param {number} sampleRate
   * @param {number} fftSize
   */
  function spectralCentroid(mags, sampleRate, fftSize) {
    const binHz = sampleRate / fftSize;
    const loBin = Math.max(1, Math.floor(80 / binHz));
    const hiBin = Math.min(mags.length - 1, Math.ceil(5000 / binHz));
    let num = 0, den = 0;
    for (let b = loBin; b <= hiBin; b++) {
      const m = mags[b];
      num += m * (b * binHz);
      den += m;
    }
    return den > 0 ? num / den : 0;
  }

  /** RMS of a time-domain buffer, in dBFS. */
  function rmsDb(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  }

  global.Yin = { detect, spectralCentroid, rmsDb, FMIN, FMAX, VOICED_AP };
})(window);
