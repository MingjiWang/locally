/* =====================================================================
   transformer-dsp.js  —  content-preserving audio transforms.

   Pure DSP, no DOM. Operates on "channels" = Array<Float32Array>, all the
   same length, at a given sampleRate. Every transform returns a NEW set of
   channels (it never mutates the input).

   The design goal: keep the content cognitively recognizable (pitch
   contour, rhythm, intelligibility) while the underlying phase/spectrum are
   free to change completely.

   Transforms:
     reverse(channels)
     timeStretch(channels, sr, { rate, transient })       // rate = out/in duration
     pitchShift(channels, sr, { semitones, formant })      // duration preserved
     vocode(channels, sr, { bands, carrier, carrierFreq, mix })

   Shared primitives: radix-2 FFT / IFFT, Hann-windowed STFT overlap-add,
   a Laroche–Dolson phase-locked phase vocoder, and a cepstral spectral
   envelope for formant transfer.
   ===================================================================== */
(function (root) {
  "use strict";

  // ---- FFT -----------------------------------------------------------
  // In-place radix-2 FFT (same routine used by the Loudness analyzer).
  function fftRadix2(re, im) {
    const n = re.length;
    if ((n & (n - 1)) !== 0) throw new Error("FFT size must be a power of 2.");
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
      let m = n >> 1;
      while (m >= 1 && j >= m) { j -= m; m >>= 1; }
      j += m;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const theta = (-2 * Math.PI) / size;
      const wpr = Math.cos(theta);
      const wpi = Math.sin(theta);
      for (let i = 0; i < n; i += size) {
        let wr = 1, wi = 0;
        for (let k = 0; k < half; k++) {
          const i0 = i + k, i1 = i + k + half;
          const tr = wr * re[i1] - wi * im[i1];
          const ti = wr * im[i1] + wi * re[i1];
          re[i1] = re[i0] - tr; im[i1] = im[i0] - ti;
          re[i0] += tr; im[i0] += ti;
          const tmp = wr * wpr - wi * wpi;
          wi = wr * wpi + wi * wpr; wr = tmp;
        }
      }
    }
  }

  function ifftRadix2(re, im) {
    const n = re.length;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    fftRadix2(re, im);
    const inv = 1 / n;
    for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
  }

  function hann(N) {
    const w = new Float32Array(N);
    for (let n = 0; n < N; n++) w[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / N));
    return w;
  }

  function principalArg(x) {
    // wrap to (-pi, pi]
    return x - 2 * Math.PI * Math.round(x / (2 * Math.PI));
  }

  // ---- resampling ----------------------------------------------------
  function resampleTo(x, outLen) {
    const inLen = x.length;
    const out = new Float32Array(outLen);
    if (inLen === 0 || outLen === 0) return out;
    if (inLen === 1) { out.fill(x[0]); return out; }
    const step = (inLen - 1) / (outLen - 1);
    for (let i = 0; i < outLen; i++) {
      const pos = i * step;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = x[i0];
      const b = i0 + 1 < inLen ? x[i0 + 1] : x[i0];
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  // ---- reverse -------------------------------------------------------
  function reverse(channels) {
    return channels.map((ch) => {
      const o = new Float32Array(ch.length);
      const n = ch.length;
      for (let i = 0; i < n; i++) o[i] = ch[n - 1 - i];
      return o;
    });
  }

  // ---- phase-locked phase vocoder (time stretch, one channel) --------
  // R = output/input duration. Pitch is preserved. Phase-locking around
  // spectral peaks (Laroche & Dolson) suppresses the classic "phasey"
  // smear so the result still sounds like the source. Transient frames
  // reset phase to the analysis phase, keeping percussive hits sharp.
  function stretchChannel(x, R, opts) {
    opts = opts || {};
    const transient = opts.transient !== false;
    const N = 2048;
    const Hs = N >> 2;                 // synthesis hop (fixed, 75% overlap)
    const Ha = Math.max(1, Math.round(Hs / R)); // analysis hop
    const win = hann(N);
    const half = N >> 1;

    const inLen = x.length;
    if (inLen < N) return Float32Array.from(x); // too short to process

    const numFrames = 1 + Math.floor((inLen - N) / Ha);
    const outLen = Math.ceil(numFrames * Hs) + N;
    const out = new Float32Array(outLen);
    const norm = new Float32Array(outLen);

    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const lastPhase = new Float32Array(half + 1);
    const sumPhase = new Float32Array(half + 1);
    const mag = new Float32Array(half + 1);
    const phase = new Float32Array(half + 1);
    const omega = new Float32Array(half + 1);
    for (let k = 0; k <= half; k++) omega[k] = (2 * Math.PI * Ha * k) / N;

    let prevEnergy = 0;

    for (let m = 0; m < numFrames; m++) {
      const posA = m * Ha;
      for (let n = 0; n < N; n++) {
        const s = x[posA + n];
        re[n] = s * win[n];
        im[n] = 0;
      }
      fftRadix2(re, im);

      let energy = 0;
      for (let k = 0; k <= half; k++) {
        const rr = re[k], ii = im[k];
        const mg = Math.hypot(rr, ii);
        mag[k] = mg;
        phase[k] = Math.atan2(ii, rr);
        energy += mg;
      }

      // transient detection via positive spectral-flux jump
      const isTransient = transient && m > 0 && energy > 2.2 * (prevEnergy + 1e-9);
      prevEnergy = energy;

      // synthesis phase per bin
      if (m === 0) {
        for (let k = 0; k <= half; k++) sumPhase[k] = phase[k];
      } else if (isTransient) {
        for (let k = 0; k <= half; k++) sumPhase[k] = phase[k]; // phase reset
      } else {
        for (let k = 0; k <= half; k++) {
          const dphi = phase[k] - lastPhase[k] - omega[k];
          const dphiWrapped = principalArg(dphi);
          const trueFreq = omega[k] + dphiWrapped;      // per analysis hop
          sumPhase[k] += (Hs / Ha) * trueFreq;          // scale to synth hop
        }
      }
      for (let k = 0; k <= half; k++) lastPhase[k] = phase[k];

      // identity phase locking: lock non-peak bins to their nearest peak so
      // each sinusoid stays phase-coherent across bins.
      const synPhase = new Float32Array(half + 1);
      for (let k = 0; k <= half; k++) synPhase[k] = sumPhase[k];
      if (!isTransient) {
        let peak = 0;
        for (let k = 1; k <= half; k++) {
          const isPeak =
            mag[k] > mag[k - 1] &&
            mag[k] >= (k + 1 <= half ? mag[k + 1] : 0) &&
            mag[k] > 1e-6;
          if (isPeak) {
            const lock = sumPhase[k] - phase[k];
            const from = Math.floor((peak + k) / 2) + (peak === 0 ? 0 : 1);
            const to = k; // fill up to this peak; region beyond handled next
            for (let b = peak === 0 ? 0 : from; b <= to; b++) {
              synPhase[b] = phase[b] + lock;
            }
            peak = k;
          }
        }
        if (peak > 0) {
          const lock = sumPhase[peak] - phase[peak];
          for (let b = peak + 1; b <= half; b++) synPhase[b] = phase[b] + lock;
        }
      }

      // rebuild full spectrum (hermitian) and IFFT
      for (let k = 0; k <= half; k++) {
        const mg = mag[k];
        const ph = synPhase[k];
        re[k] = mg * Math.cos(ph);
        im[k] = mg * Math.sin(ph);
        if (k > 0 && k < half) {
          re[N - k] = re[k];
          im[N - k] = -im[k];
        }
      }
      ifftRadix2(re, im);

      const posS = m * Hs;
      for (let n = 0; n < N; n++) {
        const w = win[n];
        out[posS + n] += re[n] * w;
        norm[posS + n] += w * w;
      }
    }

    // Cap edge boost: early/late samples are covered by fewer windows, so a
    // raw divide by a tiny norm produces huge spikes. Floor the divisor at a
    // fraction of the steady-state coverage.
    let maxNorm = 0;
    for (let i = 0; i < outLen; i++) if (norm[i] > maxNorm) maxNorm = norm[i];
    const floor = Math.max(1e-8, maxNorm * 0.15);
    for (let i = 0; i < outLen; i++) out[i] = norm[i] > 1e-8 ? out[i] / Math.max(norm[i], floor) : 0;
    // trim to the theoretical stretched length
    const target = Math.max(1, Math.round(inLen * R));
    return out.subarray(0, Math.min(target, outLen)).slice();
  }

  function timeStretch(channels, sr, params) {
    const rate = Math.max(0.25, Math.min(4, Number(params.rate) || 1));
    if (Math.abs(rate - 1) < 1e-4) return channels.map((c) => Float32Array.from(c));
    return channels.map((ch) => stretchChannel(ch, rate, params));
  }

  // ---- cepstral spectral envelope (for formant transfer) -------------
  function cepstralEnvelope(mag, N, lifter) {
    // mag: full-length (N) magnitude spectrum. Returns smoothed magnitude.
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let k = 0; k < N; k++) { re[k] = Math.log(mag[k] + 1e-8); im[k] = 0; }
    ifftRadix2(re, im); // real cepstrum in re
    for (let q = 0; q < N; q++) {
      if (q > lifter && q < N - lifter) { re[q] = 0; im[q] = 0; }
    }
    fftRadix2(re, im);
    const env = new Float32Array(N);
    for (let k = 0; k < N; k++) env[k] = Math.exp(re[k]);
    return env;
  }

  // Transfer the spectral envelope of `reference` onto `target` (same
  // length, time-aligned). Restores formants after a pitch shift.
  function transferEnvelope(target, reference, sr) {
    const N = 2048;
    const Hs = N >> 2;
    const win = hann(N);
    const half = N >> 1;
    const lifter = 60;
    const len = Math.min(target.length, reference.length);
    if (len < N) return Float32Array.from(target);

    const out = new Float32Array(target.length);
    const norm = new Float32Array(target.length);
    const reT = new Float32Array(N), imT = new Float32Array(N);
    const reR = new Float32Array(N), imR = new Float32Array(N);
    const magT = new Float32Array(N), magR = new Float32Array(N);

    const numFrames = 1 + Math.floor((len - N) / Hs);
    for (let m = 0; m < numFrames; m++) {
      const pos = m * Hs;
      for (let n = 0; n < N; n++) {
        reT[n] = target[pos + n] * win[n]; imT[n] = 0;
        reR[n] = reference[pos + n] * win[n]; imR[n] = 0;
      }
      fftRadix2(reT, imT);
      fftRadix2(reR, imR);
      for (let k = 0; k < N; k++) {
        magT[k] = Math.hypot(reT[k], imT[k]);
        magR[k] = Math.hypot(reR[k], imR[k]);
      }
      const envT = cepstralEnvelope(magT, N, lifter);
      const envR = cepstralEnvelope(magR, N, lifter);
      let eBefore = 0, eAfter = 0;
      for (let k = 0; k < N; k++) {
        eBefore += reT[k] * reT[k] + imT[k] * imT[k];
        const g = envR[k] / (envT[k] + 1e-8);
        // clamp gain so the correction can't explode
        const gc = Math.max(0.05, Math.min(20, g));
        reT[k] *= gc; imT[k] *= gc;
        eAfter += reT[k] * reT[k] + imT[k] * imT[k];
      }
      // preserve per-frame energy: formant transfer reshapes the spectrum
      // but must not change overall loudness.
      const es = Math.sqrt(eBefore / (eAfter + 1e-12));
      for (let k = 0; k < N; k++) { reT[k] *= es; imT[k] *= es; }
      ifftRadix2(reT, imT);
      for (let n = 0; n < N; n++) {
        out[pos + n] += reT[n] * win[n];
        norm[pos + n] += win[n] * win[n];
      }
    }
    let maxNorm = 0;
    for (let i = 0; i < out.length; i++) if (norm[i] > maxNorm) maxNorm = norm[i];
    const floor = Math.max(1e-8, maxNorm * 0.15);
    for (let i = 0; i < out.length; i++) {
      out[i] = norm[i] > 1e-8 ? out[i] / Math.max(norm[i], floor) : target[i];
    }
    return out;
  }

  // ---- pitch shift ---------------------------------------------------
  // Stretch by `ratio` then resample back to the original length: net
  // pitch × ratio, duration unchanged. Optional formant preservation.
  function pitchShift(channels, sr, params) {
    const semis = Number(params.semitones) || 0;
    if (Math.abs(semis) < 1e-4) return channels.map((c) => Float32Array.from(c));
    const ratio = Math.pow(2, semis / 12);
    const formant = !!params.formant;
    return channels.map((ch) => {
      const stretched = stretchChannel(ch, ratio, { transient: true });
      let shifted = resampleTo(stretched, ch.length);
      if (formant) shifted = transferEnvelope(shifted, ch, sr);
      return shifted;
    });
  }

  // ---- carrier synthesis (for the vocoder) ---------------------------
  function makeCarrier(kind, len, sr, freq) {
    const out = new Float32Array(len);
    freq = Math.max(20, Math.min(2000, freq || 110));
    if (kind === "noise") {
      let s = 22222;
      for (let i = 0; i < len; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        out[i] = (s / 0x3fffffff) - 1;
      }
      return out;
    }
    const period = sr / freq;
    for (let i = 0; i < len; i++) {
      const ph = (i % period) / period; // 0..1
      if (kind === "pulse") out[i] = ph < 0.5 ? 1 : -1;
      else out[i] = 2 * ph - 1; // sawtooth (harmonically rich)
    }
    return out;
  }

  // ---- vocoder -------------------------------------------------------
  // Modulator = the content (channels). Carrier = an internal synth. The
  // modulator's per-band energy envelope is imposed on the carrier, so the
  // words/melody stay intelligible while the timbre is fully replaced.
  function vocodeChannel(mod, sr, params) {
    const N = 1024;
    const Hs = N >> 2;
    const win = hann(N);
    const half = N >> 1;
    const bands = Math.max(6, Math.min(48, Number(params.bands) || 20));
    const mix = params.mix == null ? 1 : Math.max(0, Math.min(1, params.mix));
    const carrier = makeCarrier(params.carrier || "saw", mod.length, sr, params.carrierFreq);

    // log-spaced band edges (bin indices) from ~80 Hz to Nyquist
    const fMin = 80, fMax = sr / 2;
    const edges = new Int32Array(bands + 1);
    for (let b = 0; b <= bands; b++) {
      const f = fMin * Math.pow(fMax / fMin, b / bands);
      edges[b] = Math.max(0, Math.min(half, Math.round((f * N) / sr)));
    }

    const len = mod.length;
    const out = new Float32Array(len);
    const norm = new Float32Array(len);
    const reM = new Float32Array(N), imM = new Float32Array(N);
    const reC = new Float32Array(N), imC = new Float32Array(N);

    if (len < N) return Float32Array.from(mod);
    const numFrames = 1 + Math.floor((len - N) / Hs);

    for (let m = 0; m < numFrames; m++) {
      const pos = m * Hs;
      for (let n = 0; n < N; n++) {
        reM[n] = mod[pos + n] * win[n]; imM[n] = 0;
        reC[n] = carrier[pos + n] * win[n]; imC[n] = 0;
      }
      fftRadix2(reM, imM);
      fftRadix2(reC, imC);

      for (let b = 0; b < bands; b++) {
        let em = 0, ec = 0;
        for (let k = edges[b]; k < edges[b + 1]; k++) {
          em += reM[k] * reM[k] + imM[k] * imM[k];
          ec += reC[k] * reC[k] + imC[k] * imC[k];
        }
        const gain = Math.sqrt(em / (ec + 1e-9));
        for (let k = edges[b]; k < edges[b + 1]; k++) {
          reC[k] *= gain; imC[k] *= gain;
          if (k > 0 && k < half) { reC[N - k] = reC[k]; imC[N - k] = -imC[k]; }
        }
      }
      // DC + Nyquist
      reC[0] *= 0; imC[0] = 0;

      ifftRadix2(reC, imC);
      for (let n = 0; n < N; n++) {
        out[pos + n] += reC[n] * win[n];
        norm[pos + n] += win[n] * win[n];
      }
    }
    let maxNorm = 0;
    for (let i = 0; i < len; i++) if (norm[i] > maxNorm) maxNorm = norm[i];
    const nfloor = Math.max(1e-8, maxNorm * 0.15);
    for (let i = 0; i < len; i++) out[i] = norm[i] > 1e-8 ? out[i] / Math.max(norm[i], nfloor) : 0;
    // normalize loudness roughly to the modulator, then apply dry/wet mix
    let pm = 0, po = 0;
    for (let i = 0; i < len; i++) { pm += mod[i] * mod[i]; po += out[i] * out[i]; }
    const g = Math.sqrt((pm + 1e-9) / (po + 1e-9));
    for (let i = 0; i < len; i++) out[i] = mix * (out[i] * g) + (1 - mix) * mod[i];
    return out;
  }

  function vocode(channels, sr, params) {
    return channels.map((ch) => vocodeChannel(ch, sr, params));
  }

  // ---- chain runner --------------------------------------------------
  // stages: [{ type, params }]. Runs sequentially. onProgress(frac, label).
  function runChain(channels, sr, stages, onProgress) {
    let cur = channels.map((c) => Float32Array.from(c));
    const total = stages.length || 1;
    stages.forEach((stage, i) => {
      if (onProgress) onProgress(i / total, stage.type);
      switch (stage.type) {
        case "reverse": cur = reverse(cur); break;
        case "stretch": cur = timeStretch(cur, sr, stage.params); break;
        case "pitch": cur = pitchShift(cur, sr, stage.params); break;
        case "vocode": cur = vocode(cur, sr, stage.params); break;
        default: break;
      }
    });
    if (onProgress) onProgress(1, "done");
    return cur;
  }

  // ---- WAV encoder (16-bit PCM) --------------------------------------
  function encodeWav(channels, sr) {
    const numCh = channels.length;
    const len = channels[0] ? channels[0].length : 0;
    const bytesPerSample = 2;
    const blockAlign = numCh * bytesPerSample;
    const dataSize = len * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };

    writeStr(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);        // PCM
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, dataSize, true);

    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = channels[c][i];
        s = Math.max(-1, Math.min(1, s));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  // Peak-normalize in place to avoid clipping from cumulative gain stages.
  function normalizePeak(channels, ceiling) {
    ceiling = ceiling || 0.99;
    let peak = 0;
    for (const ch of channels) {
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]);
        if (a > peak) peak = a;
      }
    }
    if (peak > ceiling && peak > 0) {
      const g = ceiling / peak;
      for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
    }
    return channels;
  }

  root.TransformerDSP = {
    reverse, timeStretch, pitchShift, vocode, runChain,
    encodeWav, normalizePeak, resampleTo,
    _fft: fftRadix2, _ifft: ifftRadix2, _hann: hann,
  };
})(typeof self !== "undefined" ? self : this);
