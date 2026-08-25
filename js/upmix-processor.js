const FFTN = 2048;
const HOP = 512;
const BINS = FFTN >> 1;
const DELAY = 2048;

class StereoUpmixProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "center", defaultValue: 0.85, minValue: 0, maxValue: 2 },
      { name: "surround", defaultValue: 0.7, minValue: 0, maxValue: 2 },
      { name: "height", defaultValue: 0.45, minValue: 0, maxValue: 2 },
      { name: "width", defaultValue: 1.0, minValue: 0, maxValue: 2 },
    ];
  }

  constructor() {
    super();
    this.window = new Float32Array(FFTN);
    for (let i = 0; i < FFTN; i++) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / FFTN));
    }
    this.inL = new Float32Array(FFTN);
    this.inR = new Float32Array(FFTN);
    this.iptr = 0;
    this.warm = 0;
    this.sinceHop = 0;

    this.reL = new Float32Array(FFTN);
    this.imL = new Float32Array(FFTN);
    this.reR = new Float32Array(FFTN);
    this.imR = new Float32Array(FFTN);
    this.outRe = Array.from({ length: 4 }, () => new Float32Array(FFTN));
    this.outIm = Array.from({ length: 4 }, () => new Float32Array(FFTN));
    this.tRe = new Float32Array(FFTN);
    this.tIm = new Float32Array(FFTN);
    this.ola = Array.from({ length: 4 }, () => new Float32Array(FFTN));
    this.tOla = new Float32Array(FFTN);
    this.cSmooth = new Float32Array(BINS);

    this.slBuf = new Float32Array(DELAY);
    this.srBuf = new Float32Array(DELAY);
    this.tBuf = new Float32Array(DELAY);
    this.dPos = 0;

    const fifoLen = HOP * 16;
    this.fifo = Array.from({ length: 6 }, () => new Float32Array(fifoLen));
    this.fifoLen = fifoLen;
    this.outRead = 0;
    this.outWrite = 0;
    this.outCount = 0;
  }

  process(inputs, outputs, parameters) {
    this._params = parameters;
    const input = inputs[0];
    const L = input?.[0];
    const R = input?.[1] || L;
    if (L) this._ingest(L, R);

    const n = outputs[0][0]?.length || 128;
    for (let i = 0; i < n; i++) {
      const idx = this.outCount > 0 ? this.outRead : -1;
      for (let ch = 0; ch < 6; ch++) {
        const dest = outputs[ch]?.[0];
        if (dest) dest[i] = idx < 0 ? 0 : this.fifo[ch][idx];
      }
      if (idx >= 0) {
        this.outRead = (this.outRead + 1) % this.fifoLen;
        this.outCount -= 1;
      }
    }
    return true;
  }

  _ingest(L, R) {
    for (let i = 0; i < L.length; i++) {
      this.inL[this.iptr] = L[i];
      this.inR[this.iptr] = R[i];
      this.iptr = (this.iptr + 1) & (FFTN - 1);
      this.warm = Math.min(FFTN, this.warm + 1);
      this.sinceHop += 1;
      if (this.warm >= FFTN && this.sinceHop >= HOP) {
        this.sinceHop = 0;
        this._hop();
      }
    }
  }

  _hop() {
    const p = this._params || {};
    const center = (p.center && p.center[0]) ?? 0.85;
    const surround = (p.surround && p.surround[0]) ?? 0.7;
    const height = (p.height && p.height[0]) ?? 0.45;
    const width = (p.width && p.width[0]) ?? 1;
    const hzPerBin = sampleRate / FFTN;
    const cLo = Math.max(1, Math.floor(140 / hzPerBin));
    const tLo = Math.max(1, Math.floor(3200 / hzPerBin));
    const slTap = 0;
    const srTap = 0;
    const tTap = 0;

    for (let i = 0; i < FFTN; i++) {
      const idx = (this.iptr + i) & (FFTN - 1);
      const w = this.window[i];
      this.reL[i] = this.inL[idx] * w;
      this.imL[i] = 0;
      this.reR[i] = this.inR[idx] * w;
      this.imR[i] = 0;
    }
    fft(this.reL, this.imL, false);
    fft(this.reR, this.imR, false);

    for (const arr of this.outRe) arr.fill(0);
    for (const arr of this.outIm) arr.fill(0);
    this.tRe.fill(0);
    this.tIm.fill(0);

    for (let k = 1; k < BINS; k++) {
      const lRe = this.reL[k];
      const lIm = this.imL[k];
      const rRe = this.reR[k];
      const rIm = this.imR[k];
      const magL = Math.hypot(lRe, lIm);
      const magR = Math.hypot(rRe, rIm);
      const dPhase = Math.atan2(lIm, lRe) - Math.atan2(rIm, rRe);
      const inPhase = Math.max(0, Math.cos(dPhase));
      let cMag = Math.min(magL, magR) * inPhase;
      if (k < cLo) cMag = 0;
      this.cSmooth[k] = this.cSmooth[k] * 0.72 + cMag * 0.28;
      const cUse = this.cSmooth[k] * center;
      const mRe = 0.5 * (lRe + rRe);
      const mIm = 0.5 * (lIm + rIm);
      const mMag = Math.hypot(mRe, mIm) + 1e-12;
      const cRe = (mRe / mMag) * cUse;
      const cIm = (mIm / mMag) * cUse;
      const flRe = (lRe - cRe) * width;
      const flIm = (lIm - cIm) * width;
      const frRe = (rRe - cRe) * width;
      const frIm = (rIm - cIm) * width;
      const sRe = 0.5 * (lRe - rRe) * surround;
      const sIm = 0.5 * (lIm - rIm) * surround;
      const tG = k >= tLo ? height : 0;

      writeHermitian(this.outRe[0], this.outIm[0], k, flRe, flIm);
      writeHermitian(this.outRe[1], this.outIm[1], k, frRe, frIm);
      writeHermitian(this.outRe[2], this.outIm[2], k, cRe, cIm);
      writeHermitian(this.outRe[3], this.outIm[3], k, sRe, sIm);
      writeHermitian(this.tRe, this.tIm, k, sRe * tG, sIm * tG);
    }

    for (let c = 0; c < 4; c++) fft(this.outRe[c], this.outIm[c], true);
    fft(this.tRe, this.tIm, true);

    const scale = 2 / 3;
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < FFTN; i++) {
        this.ola[c][i] += this.outRe[c][i] * this.window[i] * scale;
      }
    }
    for (let i = 0; i < FFTN; i++) {
      this.tOla[i] += this.tRe[i] * this.window[i] * scale;
    }

    for (let i = 0; i < HOP; i++) {
      const s = this.ola[3][i];
      const t = this.tOla[i];
      const p = this.dPos;
      this.slBuf[p] = s;
      this.srBuf[p] = s;
      this.tBuf[p] = t;
      const sl = this.slBuf[(p - slTap + DELAY) % DELAY];
      const sr = -this.srBuf[(p - srTap + DELAY) % DELAY];
      const th = this.tBuf[(p - tTap + DELAY) % DELAY];
      this.dPos = (p + 1) % DELAY;
      this._emit([this.ola[0][i], this.ola[1][i], this.ola[2][i], sl, sr, th]);
    }

    for (let c = 0; c < 4; c++) {
      this.ola[c].copyWithin(0, HOP);
      this.ola[c].fill(0, FFTN - HOP);
    }
    this.tOla.copyWithin(0, HOP);
    this.tOla.fill(0, FFTN - HOP);
  }

  _emit(samples) {
    if (this.outCount >= this.fifoLen - 1) {
      this.outRead = (this.outRead + 1) % this.fifoLen;
      this.outCount -= 1;
    }
    const w = this.outWrite;
    for (let ch = 0; ch < 6; ch++) this.fifo[ch][w] = samples[ch];
    this.outWrite = (w + 1) % this.fifoLen;
    this.outCount += 1;
  }
}

function writeHermitian(re, im, k, r, i) {
  re[k] = r;
  im[k] = i;
  re[FFTN - k] = r;
  im[FFTN - k] = -i;
}

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

registerProcessor("stereo-upmix", StereoUpmixProcessor);
