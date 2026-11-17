/*
 * drone.js — drone synthesis (spec section 5).
 *
 * Types: tanpura (additive, jawari, scheduled plucks), shruti box, pure tone,
 * breath. Plus a keyboard/scale tone player. Exported on window.Drone as a
 * factory createDrone(ctx, destination).
 */
(function (global) {
  "use strict";

  function createDrone(ctx, destination) {
    // Master chain: masterGain -> compressor -> destination.
    const master = ctx.createGain();
    master.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.ratio.value = 10;
    master.connect(comp).connect(destination);

    // Drone volume gain (vol^2 * 1.4).
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0;
    droneGain.connect(master);

    let active = null;    // teardown fn for the current drone
    let type = "tanpura";
    let volume = 0.5;
    let air = 0;
    let saFreq = 138.59;
    let firstString = "auto";
    let cycle = 4.4;
    let ragaSet = null;

    const bufferCache = new Map(); // key -> AudioBuffer

    function setVolume(v) {
      volume = v;
      const g = v * v * 1.4;
      droneGain.gain.setTargetAtTime(g, ctx.currentTime, 0.05);
    }

    function fadeIn() {
      droneGain.gain.cancelScheduledValues(ctx.currentTime);
      droneGain.gain.setValueAtTime(0.0001, ctx.currentTime);
      droneGain.gain.linearRampToValueAtTime(volume * volume * 1.4, ctx.currentTime + 0.15);
    }
    function fadeOut(then) {
      const now = ctx.currentTime;
      droneGain.gain.cancelScheduledValues(now);
      droneGain.gain.setValueAtTime(droneGain.gain.value, now);
      droneGain.gain.linearRampToValueAtTime(0.0001, now + 0.15);
      setTimeout(then, 180);
    }

    // --- Tanpura additive synthesis -------------------------------------
    function renderString(freq) {
      const key = type + ":" + freq.toFixed(2);
      if (bufferCache.has(key)) return bufferCache.get(key);

      const dur = 6;
      const sr = ctx.sampleRate;
      const buf = ctx.createBuffer(1, Math.floor(dur * sr), sr);
      const data = buf.getChannelData(0);

      const maxH = 48;
      for (let h = 1; h <= maxH; h++) {
        const hf = freq * h;
        if (hf >= 6500) break;
        let amp = Math.pow(h, -0.8);
        if (h === 1) amp *= 0.7;
        const decay = Math.max(0.9, 3.8 - 0.065 * h);
        const attack = 0.003;
        const lfoRate = 0.3 + Math.random() * 0.7;
        const lfoPhase = Math.random() * Math.PI * 2;
        const phase = Math.random() * Math.PI * 2;

        for (let i = 0; i < data.length; i++) {
          const t = i / sr;
          let env;
          if (t < attack) env = t / attack;
          else env = Math.exp(-(t - attack) / decay);

          // Jawari bloom for higher harmonics.
          let jaw = 1;
          if (h >= 3) {
            const mu = 0.06 + 0.055 * h;
            const sig = 0.22 + 0.025 * h;
            jaw = 0.28 + 0.95 * Math.exp(-(((t - mu) / sig) ** 2));
          }
          const lfo = 1 + 0.2 * Math.sin(2 * Math.PI * lfoRate * t + lfoPhase);
          data[i] += amp * env * jaw * lfo * Math.sin(2 * Math.PI * hf * t + phase);
        }
      }

      // 30ms filtered-noise pluck at the start.
      const pluckLen = Math.floor(0.03 * sr);
      for (let i = 0; i < pluckLen; i++) {
        const env = 1 - i / pluckLen;
        data[i] += (Math.random() * 2 - 1) * 0.15 * env;
      }
      // 0.4s fade at the end.
      const fadeLen = Math.floor(0.4 * sr);
      for (let i = 0; i < fadeLen; i++) {
        data[data.length - 1 - i] *= i / fadeLen;
      }
      // Normalise.
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      if (peak > 0) for (let i = 0; i < data.length; i++) data[i] /= peak;

      bufferCache.set(key, buf);
      return buf;
    }

    function pickFirstStringFreq() {
      let mode = firstString;
      if (mode === "auto") {
        const has = (p) => !ragaSet || ragaSet.has(p);
        mode = has(7) ? "pa" : has(5) ? "ma" : "ni";
      }
      if (mode === "pa") return saFreq * 0.75;       // Pa below Sa
      if (mode === "ma") return saFreq * (2 / 3);    // Ma below Sa
      return saFreq * (15 / 16);                     // Ni below Sa
    }

    function startTanpura() {
      const firstFreq = pickFirstStringFreq();
      const stringFreqs = [firstFreq, saFreq, saFreq, saFreq / 2];
      const pans = [-0.4, -0.1, 0.1, 0.4];
      const buffers = stringFreqs.map((fz) => renderString(fz));
      const lastNodes = new Array(stringFreqs.length).fill(null);

      let stopped = false;
      let nextCycleStart = ctx.currentTime + 0.1;
      let timer = null;

      const pluck = (idx, when) => {
        // Damp the previous pluck on this string.
        if (lastNodes[idx]) {
          try {
            lastNodes[idx].gain.gain.setTargetAtTime(0.0001, when, 0.05);
            lastNodes[idx].src.stop(when + 0.3);
          } catch (e) { /* already stopped */ }
        }
        const src = ctx.createBufferSource();
        src.buffer = buffers[idx];
        const g = ctx.createGain();
        g.gain.value = 1;
        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (panner) {
          panner.pan.value = pans[idx];
          src.connect(g).connect(panner).connect(droneGain);
        } else {
          src.connect(g).connect(droneGain);
        }
        src.start(when);
        lastNodes[idx] = { src, gain: g };
      };

      const schedule = () => {
        if (stopped) return;
        const lookahead = 0.3;
        while (nextCycleStart < ctx.currentTime + lookahead) {
          const offsets = [0, 0.24, 0.48, 0.72];
          for (let s = 0; s < 4; s++) {
            const jitter = (Math.random() * 2 - 1) * 0.015;
            pluck(s, nextCycleStart + offsets[s] * cycle + jitter);
          }
          nextCycleStart += cycle;
        }
        // Catch up cleanly if we fell behind (e.g. backgrounded tab).
        if (nextCycleStart < ctx.currentTime) nextCycleStart = ctx.currentTime + 0.05;
        timer = setTimeout(schedule, 100);
      };
      schedule();

      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        lastNodes.forEach((ln) => { if (ln) try { ln.src.stop(); } catch (e) {} });
      };
    }

    // --- Shruti box -----------------------------------------------------
    function startShruti() {
      const freqs = [saFreq, saFreq * 1.5, saFreq * 2];
      const nodes = [];
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.18;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.15;
      lfo.connect(lfoGain);
      lfo.start();

      freqs.forEach((fz) => {
        const filt = ctx.createBiquadFilter();
        filt.type = "lowpass";
        filt.frequency.value = Math.min(2600, 7 * fz);
        const g = ctx.createGain();
        g.gain.value = 0.25;
        lfoGain.connect(g.gain);
        for (const det of [-3, 3]) {
          const osc = ctx.createOscillator();
          osc.type = "sawtooth";
          osc.frequency.value = fz;
          osc.detune.value = det;
          osc.connect(filt);
          osc.start();
          nodes.push(osc);
        }
        filt.connect(g).connect(droneGain);
      });
      return () => { nodes.forEach((o) => { try { o.stop(); } catch (e) {} }); try { lfo.stop(); } catch (e) {} };
    }

    // --- Pure tone ------------------------------------------------------
    function startPure() {
      const specs = [[saFreq, 0.3], [saFreq * 1.5, 0.15], [saFreq * 2, 0.1]];
      const nodes = [];
      specs.forEach(([fz, amp]) => {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = fz;
        const g = ctx.createGain();
        g.gain.value = amp;
        osc.connect(g).connect(droneGain);
        osc.start();
        nodes.push(osc);
      });
      return () => nodes.forEach((o) => { try { o.stop(); } catch (e) {} });
    }

    // --- Breath / Air ---------------------------------------------------
    function startBreath(q) {
      const noise = makeNoise();
      const swell = ctx.createOscillator();
      swell.frequency.value = 0.09;
      const swellGain = ctx.createGain();
      swellGain.gain.value = 0.2;
      swell.connect(swellGain);
      swell.start();

      const mults = [0.5, 1, 1.5, 2, 3, 4];
      const nodes = [noise];
      mults.forEach((mult) => {
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = saFreq * mult;
        bp.Q.value = q;
        const g = ctx.createGain();
        g.gain.value = 0.5 * Math.sqrt(q);
        swellGain.connect(g.gain);
        noise.connect(bp).connect(g).connect(droneGain);
      });
      noise.start();
      return () => { try { noise.stop(); } catch (e) {} try { swell.stop(); } catch (e) {} };
    }

    function makeNoise() {
      const sr = ctx.sampleRate;
      const buf = ctx.createBuffer(1, sr * 2, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      return src;
    }

    // --- Public control -------------------------------------------------
    function start() {
      stopInternal();
      let teardown;
      if (type === "tanpura") teardown = startTanpura();
      else if (type === "shruti") teardown = startShruti();
      else if (type === "pure") teardown = startPure();
      else if (type === "breath") teardown = startBreath(38);

      // Optional air layer on non-breath types.
      let airTeardown = null;
      if (air > 0 && type !== "breath") airTeardown = startBreath(14);

      active = () => { if (teardown) teardown(); if (airTeardown) airTeardown(); };
      fadeIn();
    }

    function stopInternal() {
      if (active) { active(); active = null; }
    }

    function stop() {
      if (!active) return;
      const t = active;
      fadeOut(() => { t(); });
      active = null;
    }

    function setType(t) { type = t; if (active) start(); }
    function setSa(freq) { saFreq = freq; bufferCache.clear(); if (active) start(); }
    function setFirstString(s) { firstString = s; if (active && type === "tanpura") start(); }
    function setCycle(c) { cycle = c; }
    function setAir(a) { air = a; if (active) start(); }
    function setRagaSet(s) { ragaSet = s; }

    // --- Keyboard / scale tones ----------------------------------------
    function playTone(freq, dur) {
      const now = ctx.currentTime;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.4, now + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0005, now + (dur || 0.9));
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = Math.min(4000, 6 * freq);
      for (const det of [-4, 4]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = freq;
        osc.detune.value = det;
        osc.connect(filt);
        osc.start(now);
        osc.stop(now + (dur || 0.9) + 0.05);
      }
      filt.connect(g).connect(master);
    }

    return {
      start, stop, setType, setVolume, setSa, setFirstString, setCycle,
      setAir, setRagaSet, playTone,
      get isOn() { return !!active; },
      get type() { return type; },
    };
  }

  global.Drone = { createDrone };
})(window);
