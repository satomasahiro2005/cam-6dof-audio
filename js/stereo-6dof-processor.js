const C = 343;
const Y0 = 1.2;
const BASE = 256;
const RING = 8192;
const MASK = RING - 1;

function speaker(azDeg, r = 2.2) {
  const az = (azDeg * Math.PI) / 180;
  return { x: Math.sin(az) * r, y: Y0, z: -Math.cos(az) * r };
}

class Stereo6DoFProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = new Float32Array(RING);
    this.bufR = new Float32Array(RING);
    this.w = 0;
    this.fl = speaker(-30);
    this.fr = speaker(30);
    this.pose = {
      x: 0,
      y: Y0,
      z: 0,
      fx: 0,
      fy: 0,
      fz: -1,
      ux: 0,
      uy: 1,
      uz: 0,
      headRadius: 0.0875,
    };
    this.p0 = null;
    this.h0Radius = -1;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.flx != null) {
        this.fl = { x: d.flx, y: d.fly, z: d.flz };
        this.fr = { x: d.frx, y: d.fry, z: d.frz };
        this.p0 = null;
      }
      Object.assign(this.pose, d);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const L = input?.[0];
    const R = input?.[1] || L;
    const destL = outputs[0][0];
    const destR = outputs[0][1] || destL;
    const n = destL?.length || 128;
    if (!L) {
      destL.fill(0);
      if (destR && destR !== destL) destR.fill(0);
      return true;
    }
    if (!this.p0 || this.h0Radius !== this.pose.headRadius) {
      this.h0Radius = this.pose.headRadius;
      this.p0 = this._paths(0, Y0, 0, 0, 0, -1, 0, 1, 0, this.pose.headRadius);
    }
    const p0 = this.p0;
    const p = this._paths(
      this.pose.x,
      this.pose.y,
      this.pose.z,
      this.pose.fx,
      this.pose.fy,
      this.pose.fz,
      this.pose.ux,
      this.pose.uy,
      this.pose.uz,
      this.pose.headRadius
    );
    const sr = sampleRate;
    const dL = Math.max(1, Math.min(RING - 2, Math.round(BASE + (p.tLL - p0.tLL) * sr)));
    const dR = Math.max(1, Math.min(RING - 2, Math.round(BASE + (p.tRR - p0.tRR) * sr)));
    const gL = p.gLL / p0.gLL;
    const gR = p.gRR / p0.gRR;
    const dry = dL === BASE && dR === BASE && Math.abs(gL - 1) < 1e-4 && Math.abs(gR - 1) < 1e-4;

    for (let i = 0; i < n; i++) {
      const w = this.w;
      const l = L[i];
      const r = R[i] ?? l;
      this.bufL[w] = l;
      this.bufR[w] = r;
      if (dry) {
        destL[i] = l;
        if (destR) destR[i] = r;
      } else {
        destL[i] = gL * this.bufL[(w - dL) & MASK];
        if (destR) destR[i] = gR * this.bufR[(w - dR) & MASK];
      }
      this.w = (w + 1) & MASK;
    }
    return true;
  }

  _paths(x, y, z, fx, fy, fz, ux, uy, uz, a) {
    const rx = fy * uz - fz * uy;
    const ry = fz * ux - fx * uz;
    const rz = fx * uy - fy * ux;
    const rn = Math.hypot(rx, ry, rz) || 1;
    const le = { x: x - (rx / rn) * a, y: y - (ry / rn) * a, z: z - (rz / rn) * a };
    const re = { x: x + (rx / rn) * a, y: y + (ry / rn) * a, z: z + (rz / rn) * a };
    const pack = (sp, ear) => {
      const d = Math.max(0.05, Math.hypot(sp.x - ear.x, sp.y - ear.y, sp.z - ear.z));
      return { g: 1.8 / d, t: d / C };
    };
    const LL = pack(this.fl, le);
    const RR = pack(this.fr, re);
    return { gLL: LL.g, tLL: LL.t, gRR: RR.g, tRR: RR.t };
  }
}

registerProcessor("stereo-6dof", Stereo6DoFProcessor);
