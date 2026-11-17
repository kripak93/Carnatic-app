# Riyaz: build spec

A browser app for Indian classical vocal practice, mainly Carnatic with
Hindustani support. The user sings into the mic and gets live feedback on which
swara they are aiming for, how far off it they are, and how steadily they hold
it. The app also provides a drone and a raga reference.

## 2. Music model

**Sa (tonic).** Chosen as a note name, an octave (1–5) and a fine-tune offset
(−50 to +50 cents), with A4 = 440 Hz. Default is C♯3 (138.59 Hz).

- Label the note options with Carnatic kattai numbers: C=1, C♯=1½, D=2, D♯=2½,
  E=3, F=4, F♯=4½, G=5, G♯=5½, A=6, A♯=6½, B=7.
- In Hindustani mode, label them as harmonium keys: White 1, Black 1, White 2, …
- A **"Sing my Sa"** button sets Sa from the voice. It takes the median of about
  60 voiced frames, then rounds to a note name plus a cents offset.

**Twelve positions per octave (`pos` 0–11).** Each position has a Carnatic name,
a Hindustani name and a just-intonation offset in cents above Sa:

| pos | Carnatic (default / alias) | Hindustani | Just cents |
|---|---|---|---|
| 0 | Sa | Sa | 0 |
| 1 | Ri1 | re (komal) | 111.73 |
| 2 | Ri2 / Ga1 | Re | 203.91 |
| 3 | Ga2 / Ri3 | ga (komal) | 315.64 |
| 4 | Ga3 | Ga | 386.31 |
| 5 | Ma1 | ma (shuddh) | 498.04 |
| 6 | Ma2 | Ma (tivra) | 590.22 |
| 7 | Pa | Pa | 701.96 |
| 8 | Da1 | dha (komal) | 813.69 |
| 9 | Da2 / Ni1 | Dha | 884.36 |
| 10 | Ni2 / Da3 | ni (komal) | 1017.60 |
| 11 | Ni3 | Ni | 1088.27 |

- **Tuning toggle.** Just intonation is the default. Equal temperament uses
  `pos × 100`.
- **Absolute note index.** `k = octave × 12 + pos`, where octave 0 is the madhya
  (middle) octave. The target pitch is `tc(k) = floor(k/12) × 1200 + tune[pos]`
  cents relative to Sa.
- **Dual names.** When a raga is selected, a position shared by two names (for
  example pos 3 = Ga2 or Ri3) uses whichever name the raga uses.
- **Long names.** Carnatic: shadjam, chatushruti rishabham, antara gandharam,
  prati madhyamam, kakali nishadam, and so on. Hindustani: komal Re, tivra Ma,
  and so on.
- **Octave marks.** One dot above the name for each octave up, one dot below for
  each octave down.
- **Register names.** Carnatic: anumandra, mandra, madhya, tara, ati-tara
  (+ "sthayi"). Hindustani: ati-mandra, mandra, madhya, taar, ati-taar
  (+ "saptak").

**Ragas.** `^` means upper Sa. When no avarohanam is listed, it is the arohanam
reversed.

| id | Name | Tradition | Family | Arohanam | Avarohanam |
|---|---|---|---|---|---|
| none | Any swara | – | – | all 12 positions | |
| hamsadhwani | Hamsadhwani | Carnatic | Janya of 29 | Sa Ri2 Ga3 Pa Ni3 Sa^ | |
| dharmavati | Dharmavati | Carnatic | Mela 59 | Sa Ri2 Ga2 Ma2 Pa Da2 Ni3 Sa^ | |
| charukesi | Charukesi | Carnatic | Mela 26 | Sa Ri2 Ga3 Ma1 Pa Da1 Ni2 Sa^ | |
| shankarabharanam | Shankarabharanam | Carnatic | Mela 29 | Sa Ri2 Ga3 Ma1 Pa Da2 Ni3 Sa^ | |
| kalyani | Kalyani | Carnatic | Mela 65 | Sa Ri2 Ga3 Ma2 Pa Da2 Ni3 Sa^ | |
| saraswati | Saraswati | Carnatic | Janya of 64 | Sa Ri2 Ma2 Pa Da2 Sa^ | Sa^ Ni2 Da2 Pa Ma2 Ri2 Sa |
| ahirbhairav | Ahir Bhairav | Hindustani | Bhairav + Kafi | Sa Ri1 Ga3 Ma1 Pa Da2 Ni2 Sa^ | |

- A raga's set of allowed notes is the union of its arohanam and avarohanam.
- `inRaga(pos)` is true for every position when the raga is "none".

## 3. Pitch analysis

**Mic input.** `getUserMedia({audio:{echoCancellation: !headphones,
noiseSuppression:false, autoGainControl:false}})`. Noise suppression is off
because it damages sustained tones. Echo cancellation stays on unless the user
ticks "using headphones".

- Connect the source to an `AnalyserNode` with `fftSize` 2048 and
  `smoothingTimeConstant` 0.
- Also connect the analyser to a gain node at 0 that feeds the destination, so
  the browser keeps processing it.
- Analyse once per `requestAnimationFrame`, timestamped with `ctx.currentTime`.

Each frame goes through these steps:

1. **Level.** Compute the RMS of the time-domain buffer in dBFS.
2. **Calibration.** For 1.0 s after the mic starts, and again after the drone
   starts (only when not using headphones), set `floor = 90th percentile of the
   measured dB`, clamped to [−90, −42]. While this runs, the status line tells
   the user to stay quiet.
3. **Noise gate.** `gate = max(floor + margin, −72)`, where `margin` is a user
   slider from 4 to 24 dB (default 10). The floor then adapts:
   - it falls quickly toward a quieter level (5% per frame);
   - it rises at most 0.4 dB/s, only on frames with no detected pitch, and never
     above −40.
4. **Pitch detection with YIN.** Run only when the level is above the gate.
   - Use the cumulative mean normalised difference.
   - Search 62–1100 Hz and take the first dip below 0.15, then walk down to its
     local minimum.
   - If there is no such dip, fall back to the global minimum, but only if it is
     below 0.35.
   - Refine the period with parabolic interpolation.
   - The frame counts as voiced when aperiodicity `ap` < 0.3. Clarity = `1 − ap`.
5. **Spectral centroid.** On voiced frames only, compute it from the FFT
   magnitudes between 80 and 5000 Hz.
6. **Cents.** `c = 1200·log2(f/Sa)`.
   - **Octave-error fix:** if `c` is within ±120 cents of exactly ±1200 from the
     previous raw frame, fold it back by 1200.
7. **Gap rule.** A gap of more than 120 ms without voicing ends the current note
   and resets every buffer in steps 8–10.
8. **Smoothing.** Output the median of the last N raw cents values. N is a user
   slider: 3, 5 (default), 7, 9 or 11. Output nothing until 3 consecutive voiced
   frames have arrived, which rejects clicks and short noises.
9. **Attempt pitch `m`.** The median of the smoothed values over the last 350 ms.
10. **Target inference.** This handles the "sharp D or flat D♯" ambiguity:
    - For `k` in `round(m/100) ± 2`, score
      `prior × exp(−(m − tc(k))² / (2·32²))`.
    - `prior` is 1 for a note in the raga and 0.18 for a note outside it.
    - Normalise the scores to probabilities.
    - **Hysteresis:** keep the current target unless `|m − tc(target)| > 65`, or
      the best candidate has probability > 0.8 and lies within 30 cents of `m`.
11. **Notes as segments.** A new segment starts whenever the target changes or
    after a gap. Each segment stores, per frame:
    `{t, cents, dB, centroid, clarity}`.

**Statistics for the current segment.** Skip the first 150 ms (the attack) and
use at most the last 3 s.

- **Offset:** the mean of `cents − tc(k)`.
- **Drift:** the slope of a linear regression of cents on time, in ¢/s.
- **Wobble:** the RMS of the residuals after removing that line. Its **rate** is
  the number of residual zero crossings ÷ 2 ÷ duration. Count a crossing only
  when the residual passes ±max(2, 0.5 × wobble). Report the rate only when
  wobble ≥ 6¢ and rate ≥ 2.5 Hz (this is gamaka or vibrato).
- **Held in tune:** the time since the most recent frame more than 25¢ from the
  target.
- **Volume steadiness:** the standard deviation of dB.
- **Tone colour steadiness:** the standard deviation of the centroid divided by
  its mean, as a percentage.
- **Clarity:** mean clarity as a percentage.

**Session statistics, per position across all octaves.** On every frame that is
past the attack and within 60¢ of the target, accumulate the time held, the sum
of deviations and the sum of squared deviations. Show each swara's mean offset
and spread (standard deviation).

## 4. Interface

Order the page top to bottom. At 640px and narrower, everything stacks into one
column.

1. **Sticky top bar.**
   - App name.
   - A status line, for example "Checking the room. Stay quiet for a second.",
     or an error message if the mic is blocked.
   - **Drone** toggle.
   - **Start singing / Stop** as the primary button. While the mic is live,
     request a screen wake lock and keep the screen on.
2. **Controls row.**
   - Sa: note, octave, "Sing my Sa" button, fine-tune slider, and the resulting
     Sa in Hz.
   - Raga select, grouped by tradition.
   - Swara names: Carnatic | Hindustani.
   - Tuning: Just | Equal.
3. **Live row of 3 panels.** These sit side by side on desktop, 2 columns on
   tablet, 1 on phone.
   - **Attempted note.**
     - The swara name, large, coloured by whether it is in the raga, with octave
       dots.
     - Its long name and register, and a tag saying "in <raga>" or
       "outside <raga>".
     - The signed offset in cents, coloured green within 10¢, amber within 25¢,
       red beyond that, with the word "sharp", "flat" or "on the note".
     - The second guess, when its probability is at least 0.12:
       "or Ga2 sung 60¢ sharp".
     - A two-part bar showing the probability of the top guess and the second
       guess.
     - Absolute pitch: Hz, and the western note with its cents offset.
     - When the user goes silent, keep showing the last note, faded and labelled
       "Last note".
   - **Zoom (canvas).**
     - Y axis: from 30¢ below the next lower position (`k−1`) to 30¢ above the
       next higher one (`k+1`), relative to the target.
     - Shaded bands at ±10¢ and ±25¢, with y-axis ticks at ±25 and ±50.
     - The target line is solid. The neighbouring lines are dashed and labelled
       on the right with their name and their cents offset from the target.
       Colour each line by whether it is in the raga.
     - X axis: the last 4 s of smoothed pitch.
     - The current-pitch dot is coloured by accuracy.
   - **Steadiness.** Six tiles, each with a value, a meter bar and a one-line
     description.
     - Pitch: Wobble ±¢ (with Hz when oscillating), Drift ¢/s, Held in tune (s).
     - Texture: Volume ±dB, Tone colour ±%, Clarity %.
4. **Pitch trace (canvas, full width).**
   - X axis: the last 5, 10 or 20 s (user toggle), with second ticks and "now" at
     the right edge.
   - Y axis: about 20 px per semitone, spanning 1100–2600¢. It re-centres
     smoothly on the median of the last 2.5 s.
   - **Horizontal lines for every position:**
     - Sa: gold.
     - In the raga: solid green.
     - Outside the raga: dashed red.
     - Labels go in a left gutter. When lines are tight, only in-raga notes are
       labelled.
   - Raw pitch frames are faint dots. Smoothed pitch is a thick line coloured by
     whether its inferred target is in the raga, broken wherever there are gaps.
   - **Freeze** stops the view from scrolling while analysis continues. **Clear**
     empties the trace.
5. **Raga panel and drone panel, side by side.**
   - **Raga panel.**
     - Name, tradition, family, number of swaras, and a one-line description.
     - Arohanam and avarohanam as swara chips ("Aaroh" and "Avroh" in Hindustani
       mode).
     - **Keyboard:** 13 piano keys from Sa to upper Sa, starting on the real key
       of Sa, so it may begin on a black key.
     - Each key shows the swara name and the western note. In-raga keys are
       tinted green; out-of-raga labels are struck through.
     - Tapping a key plays the note at the current tuning. The key for the note
       being sung is outlined in gold.
     - **Play scale** plays the arohanam then the avarohanam, 0.42 s per note,
       lighting each key as it plays.
   - **Drone panel.**
     - Type: Tanpura | Shruti box | Pure tone | Breath.
     - Volume and Air sliders. Air is hidden for Breath.
     - For Tanpura: first string (Auto, Pa, Ma or Ni; Auto uses Pa if the raga
       has it, otherwise Ma, otherwise Ni) and cycle length (3–7 s, default 4.4).
     - A note recommending headphones.
6. **Session table and mic panel, side by side.**
   - **Session table.** Columns: swara, time held, average offset (a dot on a
     ±50¢ track plus the signed number), spread. A summary line names the swara
     that is most off, e.g. "Most off: Ga3, 14¢ flat on average." Include a
     **Reset** button.
   - **Mic panel.**
     - Live level meter with a red tick at the gate.
     - "Ignore background" (gate margin) slider and Smoothing slider.
     - Headphones checkbox; changing it restarts the mic.
     - **Re-check room** button.

**First view.** Before the mic starts, run the pipeline on a built-in example
phrase so every panel shows realistic data, clearly tagged "Example". The phrase
is Sa Ri2 Ga3 Ma1 Pa Da2 Ni3 Sa^ Pa Ga3, with small vibrato, a few deliberately
flat or sharp notes, and short gaps. Discard it when the mic starts. Changing Sa
clears the trace and the session.

**Colours.** Use one set of tokens: `--in` green, `--out` red, `--gold` for Sa
and the current note, `--trace`, plus neutrals. Define each for both light and
dark themes. To swap the in/out colours, the user changes the two token values.

## 5. Sound

All sound runs through a master gain into a compressor (threshold −8 dB,
ratio 10) and then to the output. The drone has its own volume gain, set to
`vol² × 1.4`. Every drone fades in and out over about 150 ms.

- **Tanpura.**
  - **Strings:** first string (Pa = Sa × 0.75, Ma = Sa × 2/3, Ni = Sa × 15/16),
    then Sa, Sa, and low Sa (Sa/2).
  - **Rendering:** pre-render each string once into a 6 s mono buffer by additive
    synthesis, and cache it.
  - Up to 48 harmonics, all below 6500 Hz. Amplitude ∝ h^−0.8, with the
    fundamental scaled by 0.7.
  - Decay time per harmonic: max(0.9, 3.8 − 0.065h) s, with a 3 ms attack.
  - **Jawari bloom:** for h ≥ 3, multiply by
    `0.28 + 0.95·exp(−((t − (0.06 + 0.055h)) / (0.22 + 0.025h))²)`.
  - Add a slow random amplitude LFO of ±20% per harmonic.
  - Add a 30 ms filtered-noise pluck at the start and a 0.4 s fade at the end,
    then normalise.
  - **Scheduling:** schedule plucks with a lookahead timer at offsets 0, 0.24,
    0.48 and 0.72 of the cycle, with ±15 ms jitter.
  - Pan the strings across the stereo field.
  - Damp a string's previous pluck when it is plucked again.
- **Shruti box.** Sa, Pa and upper Sa, each as 2 sawtooth oscillators detuned by
  ±3 cents, through a lowpass filter at min(2600 Hz, 7 × frequency). A 0.18 Hz
  LFO gives a bellows swell.
- **Pure tone.** Sine waves at Sa, Pa and upper Sa, with amplitudes 0.3, 0.15
  and 0.1.
- **Breath / Air.**
  - Looping white noise into bandpass filters at Sa × {0.5, 1, 1.5, 2, 3, 4},
    with makeup gain to normalise each band.
  - Q is 38 for the Breath type and 14 for the Air layer, which can be added to
    any other type.
  - A 0.09 Hz swell.
- **Keyboard and scale tones.** 2 detuned sawtooth oscillators through a lowpass
  filter, with a 15 ms attack and about 0.9 s decay.

## 6. Acceptance checks

- YIN on synthetic tones (fundamental + 2nd harmonic louder than the fundamental
  + 3rd harmonic + noise), from 70 to 880 Hz at both 44.1 and 48 kHz, lands
  within 1¢ with no octave errors.
- A steady sine at Sa × 2^(350/1200) with Shankarabharanam selected is identified
  as Ga3, about 36¢ flat, with Ga2 as the second guess. With no raga selected,
  both guesses get similar probabilities.
- A tap, a cough or fan noise shorter than 50 ms draws nothing on the trace.
- On a 390px-wide phone screen, nothing scrolls sideways and every panel is
  readable.
- The drone, mic and keyboard all work together without clicks or runaway timers.
  Tanpura scheduling catches up cleanly after the tab has been in the background.
- If the mic is denied, the status line explains how to allow it. If
  `getUserMedia` isn't available (an http page on a phone), it says to use https.
