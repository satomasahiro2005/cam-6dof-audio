import { readFileSync } from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";

const src = readFileSync(new URL("../js/stereo-6dof-processor.js", import.meta.url), "utf8");

class AudioWorkletProcessor {
  constructor() {
    this.port = { onmessage: null, postMessage() {} };
  }
}

let Processor = null;
vm.runInNewContext(src, {
  AudioWorkletProcessor,
  sampleRate: 48000,
  registerProcessor(_name, cls) {
    Processor = cls;
  },
  Math,
  Float32Array,
  Object,
  console,
});

const SR = 48000;
const N = 1024;

function logSweep(sec = 0.8, f0 = 20, f1 = 20000) {
  const n = Math.round(SR * sec);
  const out = new Float32Array(n);
  const k = Math.log(f1 / f0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = Math.sin(((2 * Math.PI * f0 * sec) / k) * (Math.exp((t * k) / sec) - 1));
  }
  return out;
}

function rms(x, a = 0, b = x.length) {
  let s = 0;
  const n = Math.max(1, b - a);
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / n);
}

function at(x, t) {
  const i = Math.floor(t);
  const f = t - i;
  if (i < 0 || i + 1 >= x.length) return 0;
  return x[i] * (1 - f) + x[i + 1] * f;
}

function snrGain(ref, est) {
  const n = Math.min(ref.length, est.length);
  const a = N * 2;
  const b = n - N;
  const maxLag = N * 2;
  const m0 = b - a - maxLag;
  if (m0 < SR / 20) return { snr: -99, g: 0, lag: 0 };
  let best = -Infinity;
  let lag0 = 0;
  for (let lag = 0; lag <= maxLag; lag++) {
    let dot = 0;
    for (let i = 0; i < m0; i++) dot += est[a + lag + i] * ref[a + i];
    const score = Math.abs(dot);
    if (score > best) {
      best = score;
      lag0 = lag;
    }
  }
  let bestF = 0;
  best = -Infinity;
  for (let k = -10; k <= 10; k++) {
    const frac = k / 20;
    let dot = 0;
    for (let i = 0; i < m0; i++) dot += at(est, a + lag0 + frac + i) * ref[a + i];
    const score = Math.abs(dot);
    if (score > best) {
      best = score;
      bestF = frac;
    }
  }
  const lag = lag0 + bestF;
  let rr = 0;
  let er = 0;
  for (let i = 0; i < m0; i++) {
    const r = ref[a + i];
    const e = at(est, a + lag + i);
    rr += r * r;
    er += e * r;
  }
  const g = er / (rr + 1e-20);
  let err = 0;
  let sig = 0;
  for (let i = 0; i < m0; i++) {
    const r = g * ref[a + i];
    const d = at(est, a + lag + i) - r;
    err += d * d;
    sig += r * r;
  }
  return { snr: 10 * Math.log10((sig + 1e-20) / (err + 1e-20)), g, lag };
}

function isol(active, leak) {
  const n = Math.min(active.length, leak.length);
  const a = N;
  const b = n - N;
  return 20 * Math.log10((rms(leak, a, b) + 1e-12) / (rms(active, a, b) + 1e-12));
}

function render(L, R) {
  const p = new Processor();
  const q = 128;
  const outL = [];
  const outR = [];
  const oL = new Float32Array(q);
  const oR = new Float32Array(q);
  const n = L.length;
  for (let i = 0; i < n; i += q) {
    const take = Math.min(q, n - i);
    const iL = new Float32Array(q);
    const iR = new Float32Array(q);
    iL.set(L.subarray(i, i + take));
    iR.set(R.subarray(i, i + take));
    p.process([[iL, iR]], [[oL, oR]]);
    outL.push(Float32Array.from(oL.subarray(0, take)));
    outR.push(Float32Array.from(oR.subarray(0, take)));
  }
  const yL = new Float32Array(n);
  const yR = new Float32Array(n);
  let w = 0;
  for (let i = 0; i < outL.length; i++) {
    yL.set(outL[i], w);
    yR.set(outR[i], w);
    w += outL[i].length;
  }
  return [yL, yR];
}

function tone(hz, sec, phase = 0) {
  const n = Math.round(SR * sec);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * hz * (i / SR) + phase);
  return x;
}

const sweep = logSweep(0.8);
const z = new Float32Array(sweep.length);
const t1k = tone(1000, 0.6);
const z1k = new Float32Array(t1k.length);
const two = (() => {
  const a = tone(440, 0.6);
  const b = tone(5000, 0.6);
  const x = new Float32Array(a.length);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * a[i] + 0.5 * b[i];
  return x;
})();
const whiteL = Float32Array.from({ length: Math.round(SR * 0.6) }, () => Math.random() * 2 - 1);
const whiteR = Float32Array.from({ length: whiteL.length }, () => Math.random() * 2 - 1);
const pink = (() => {
  const n = Math.round(SR * 0.6);
  const x = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += Math.random() * 2 - 1;
    x[i] = acc;
  }
  let peak = 1e-12;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  for (let i = 0; i < n; i++) x[i] /= peak;
  return x;
})();
const speech = (() => {
  const n = Math.round(SR * 0.6);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] =
      0.4 * Math.sin(2 * Math.PI * 180 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t)) +
      0.2 * Math.sin(2 * Math.PI * 900 * t) +
      0.08 * Math.sin(2 * Math.PI * 2400 * t);
  }
  return x;
})();
const impulse = new Float32Array(SR / 4);
impulse[SR / 16] = 1;

const probes = [
  ["log-sweep L", sweep, z],
  ["log-sweep R", z, sweep],
  ["log-sweep dual", sweep, sweep],
  ["log-sweep out-of-phase", sweep, sweep.map((v) => -v)],
  ["1kHz L", t1k, z1k],
  ["1kHz stereo", t1k, t1k],
  ["two-tone 440+5k", two, two],
  ["white uncorrelated", whiteL, whiteR],
  ["pink stereo", pink, pink],
  ["speech-like", speech, Float32Array.from(speech, (v, i) => 0.7 * v + 0.1 * whiteL[i])],
  ["impulse L", impulse, new Float32Array(impulse.length)],
  ["impulse stereo", impulse, impulse],
];

console.log("Worklet identity  relative ITD/ILD  (actual stereo-6dof-processor.js)\n");
const snrs = [];
const isols = [];
for (const [name, L, R] of probes) {
  const [oL, oR] = render(L, R);
  const aL = rms(L) > 1e-4;
  const aR = rms(R) > 1e-4;
  const parts = [];
  let g = 0;
  let ng = 0;
  if (aL) {
    const s = snrGain(L, oL);
    parts.push(s.snr);
    g += s.g;
    ng += 1;
  } else isols.push(isol(R, oL));
  if (aR) {
    const s = snrGain(R, oR);
    parts.push(s.snr);
    g += s.g;
    ng += 1;
  } else isols.push(isol(L, oR));
  const snr = parts.reduce((x, y) => x + y, 0) / parts.length;
  snrs.push(snr);
  const iso = !aL || !aR ? `  isol ${isols[isols.length - 1].toFixed(1)} dB` : "";
  console.log(`  ${name.padEnd(28)}  SNR ${snr.toFixed(1).padStart(6)} dB  gain ${(g / Math.max(1, ng)).toFixed(3)}${iso}`);
}

console.log(
  `\n  active SNR min ${Math.min(...snrs).toFixed(1)}  median ${snrs.slice().sort((a, b) => a - b)[Math.floor(snrs.length / 2)].toFixed(1)}  mean ${(snrs.reduce((a, b) => a + b) / snrs.length).toFixed(1)} dB`
);
if (isols.length) console.log(`  isolation max ${Math.max(...isols).toFixed(1)} dB`);

const p = new Processor();
p.port.onmessage({ data: { x: 0.12, y: 1.2, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0, headRadius: 0.0875 } });
const moved = render(sweep, sweep);
// render() makes a new processor — need pose on that instance
function renderPose(L, R, pose) {
  const proc = new Processor();
  if (proc.port.onmessage) proc.port.onmessage({ data: pose });
  const q = 128;
  const yL = new Float32Array(L.length);
  const yR = new Float32Array(R.length);
  const oL = new Float32Array(q);
  const oR = new Float32Array(q);
  for (let i = 0; i < L.length; i += q) {
    const take = Math.min(q, L.length - i);
    const iL = new Float32Array(q);
    const iR = new Float32Array(q);
    iL.set(L.subarray(i, i + take));
    iR.set(R.subarray(i, i + take));
    proc.process([[iL, iR]], [[oL, oR]]);
    yL.set(oL.subarray(0, take), i);
    yR.set(oR.subarray(0, take), i);
  }
  return [yL, yR];
}

function poseAt(x, yaw = 0) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return {
    x,
    y: 1.2,
    z: 0,
    fx: sy,
    fy: 0,
    fz: -cy,
    ux: 0,
    uy: 1,
    uz: 0,
    headRadius: 0.0875,
  };
}

const [mL, mR] = renderPose(sweep, sweep, poseAt(0.12));
const sL = snrGain(sweep, mL);
const sR = snrGain(sweep, mR);
const [jL, jR] = renderPose(sweep, sweep, poseAt(0.002));
const j = snrGain(sweep, jL);
const identLag = snrGain(sweep, renderPose(sweep, sweep, poseAt(0))[0]);
const itd12 = (sR.lag - sL.lag) * (1e6 / SR);
const itd2 = (snrGain(sweep, jR).lag - j.lag) * (1e6 / SR);
const ild12 = 20 * Math.log10((rms(mR) + 1e-12) / (rms(mL) + 1e-12));
console.log(`\n2 mm X: SNR ${j.snr.toFixed(1)} dB  ITD ${itd2.toFixed(1)} µs  (want clean, no comb)`);
console.log(
  `+0.12 m X: SNR L ${sL.snr.toFixed(1)}  R ${sR.snr.toFixed(1)} dB  ITD ${itd12.toFixed(1)} µs  ILD ${ild12.toFixed(2)} dB`
);
console.log(`identity lag ${identLag.lag} smp (BASE delay)`);
const ok =
  Math.min(...snrs) >= 40 &&
  j.snr >= 40 &&
  Math.abs(itd12) >= 80 &&
  (isols.length === 0 || Math.max(...isols) <= -40);
console.log(ok ? "\nPASS" : "\nFAIL", "(identity/2mm SNR >= 40, 12cm ITD >= 80 µs, isolation <= -40)");
process.exit(ok ? 0 : 1);
