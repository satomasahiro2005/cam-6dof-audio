import { azEl, getLayout, resolvePos } from "./layouts.js";
export { LAYOUTS } from "./layouts.js";

const ROOM_SIZE = { width: 8, height: 3.2, depth: 8 };
const ROOM_MAT = {
  left: "brick-bare",
  right: "curtain-heavy",
  front: "plywood-panel",
  back: "glass-thin",
  down: "parquet-on-concrete",
  up: "acoustic-ceiling-tiles",
};
const ROOM_DRY = {
  left: "transparent",
  right: "transparent",
  front: "transparent",
  back: "transparent",
  down: "transparent",
  up: "transparent",
};

export const DEFAULT_SOURCES = [
  { id: "front", name: "前", x: 0, y: 1.2, z: -2.2, color: "#d4a017", kind: "melody" },
  { id: "left", name: "左", x: -2.0, y: 1.2, z: 0, color: "#6fbf73", kind: "pulse" },
  { id: "right", name: "右", x: 2.0, y: 1.2, z: 0, color: "#5aa6d4", kind: "pulse2" },
  { id: "rear", name: "後", x: 0, y: 1.1, z: 2.2, color: "#c45c4a", kind: "pad" },
  { id: "up", name: "上", x: 0.4, y: 2.4, z: -0.6, color: "#c9a0dc", kind: "chime" },
];

const UPMIX_POS = {
  FL: { ...azEl(-30, 0, 2.2), color: "#6fbf73" },
  FR: { ...azEl(30, 0, 2.2), color: "#5aa6d4" },
  C: { ...azEl(0, 0, 2.2), color: "#d4a017" },
  SL: { ...azEl(-110, 0, 2.2), color: "#c9a070" },
  SR: { ...azEl(110, 0, 2.2), color: "#c45c4a" },
  T: { ...azEl(0, 55, 2.0), color: "#c9a0dc" },
};

export const UPMIX_SOURCES = [
  { id: "upmix-FL", name: "FL 左固有", ch: 0, ...UPMIX_POS.FL },
  { id: "upmix-FR", name: "FR 右固有", ch: 1, ...UPMIX_POS.FR },
  { id: "upmix-C", name: "C センター", ch: 2, ...UPMIX_POS.C },
  { id: "upmix-SL", name: "SL アンビエンス", ch: 3, ...UPMIX_POS.SL },
  { id: "upmix-SR", name: "SR アンビエンス", ch: 4, ...UPMIX_POS.SR },
  { id: "upmix-T", name: "T ハイト", ch: 5, ...UPMIX_POS.T },
];

const SPEED_OF_SOUND = 343;
const DEFAULT_HEAD_RADIUS = 0.0875;
export const UPMIX_FFT_SIZE = 2048;
export const UPMIX_HOP_SIZE = 512;
const UPMIX_SURROUND_SEC = 0.019;

export class SpatialEngine {
  constructor() {
    this.ctx = null;
    this.backend = "none";
    this.scene = null;
    this.master = null;
    this.sources = new Map();
    this.listenerY = 1.2;
    this.mode = "demo";
    this.upmixNode = null;
    this.upmixSrc = null;
    this.upmixKind = "none";
    this.upmixParams = { center: 0.85, surround: 0.7, height: 0.45, width: 1 };
    this.liveStream = null;
    this.liveNode = null;
    this.inputAnalyser = null;
    this._peakBuf = null;
    this.headRadius = DEFAULT_HEAD_RADIUS;
    this.spatializer = "ears";
    this.layoutId = "stereo30";
    this.layoutRadius = 2.2;
    this.listenerPose = {
      x: 0,
      y: 1.2,
      z: 0,
      forward: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
    };
  }

  async init() {
    let ctx;
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    } catch {
      ctx = new AudioContext({ latencyHint: "interactive" });
    }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(ctx.destination);
    this.roomOn = false;

    this.hrtfBus = ctx.createGain();
    this.hrtfBus.gain.value = 0;
    this.hrtfBus.connect(this.master);
    this.earsBus = ctx.createGain();
    this.earsBus.gain.value = 1;
    this.earsMerger = ctx.createChannelMerger(2);
    this.earsMerger.connect(this.earsBus);
    this.earsBus.connect(this.master);

    if (typeof ResonanceAudio === "function") {
      const scene = new ResonanceAudio(ctx, { ambisonicOrder: 3 });
      scene.output.connect(this.hrtfBus);
      scene.setRoomProperties(ROOM_SIZE, ROOM_DRY);
      scene.setListenerPosition(0, this.listenerY, 0);
      scene.setListenerOrientation(0, 0, -1, 0, 1, 0);
      this.scene = scene;
      this.backend = "resonance";
    } else {
      this.backend = "panner";
    }
    this.setSpatializer("ears");

    for (const spec of DEFAULT_SOURCES) {
      this._spawn(spec, true);
    }
    for (const spec of UPMIX_SOURCES) {
      this._spawn(spec, false);
    }
    this._applyLayout();
    return this.backend;
  }

  resume() {
    return this.ctx?.resume();
  }

  setMasterGain(v) {
    if (this.master) this.master.gain.value = v;
  }

  setRoom(on) {
    this.roomOn = Boolean(on);
    if (!this.scene) return;
    this.scene.setRoomProperties(ROOM_SIZE, this.roomOn ? ROOM_MAT : ROOM_DRY);
  }

  setSpatializer(mode) {
    this.spatializer = mode === "hrtf" ? "hrtf" : "ears";
    if (this.hrtfBus) this.hrtfBus.gain.value = this.spatializer === "hrtf" ? 1 : 0;
    if (this.earsBus) this.earsBus.gain.value = this.spatializer === "ears" ? 1 : 0;
  }

  setHeadRadius(meters) {
    this.headRadius = Math.max(0.055, Math.min(0.12, meters));
    this._updateEarDelays();
    this._pushStereoPose();
  }

  formatInfo() {
    const inTrack = this.liveStream?.getAudioTracks?.()[0];
    const s = inTrack?.getSettings?.() || {};
    const sr = this.ctx?.sampleRate || 0;
    const maxItdSec = (this.headRadius / SPEED_OF_SOUND) * (Math.PI / 2 + 1);
    return {
      contextRate: sr,
      contextBits: "f32",
      inputRate: s.sampleRate || 0,
      inputBits: s.sampleSize || 0,
      headRadius: this.headRadius,
      earSpan: this.headRadius * 2,
      maxItdSec,
      maxItdSamples: maxItdSec * sr,
      maxItdUs: maxItdSec * 1e6,
    };
  }

  engineLatency() {
    const sr = this.ctx?.sampleRate || 0;
    const baseSec = this.ctx?.baseLatency ?? 0;
    const outSec = this.ctx?.outputLatency ?? 0;
    const inSec = this.liveStream?.getAudioTracks?.()[0]?.getSettings?.()?.latency ?? 0;
    const pairOn = this.mode === "pair" && this.stereo6dof;
    const upmixOn = this.upmixKind === "stft" && this.mode === "upmix";
    const ident = pairOn && this._poseIsIdentity();
    const stft = pairOn ? (ident ? 0 : 256) : upmixOn ? UPMIX_FFT_SIZE : 0;
    const hop = pairOn ? 0 : upmixOn ? UPMIX_HOP_SIZE : 0;
    const surround = upmixOn ? Math.round(UPMIX_SURROUND_SEC * sr) : 0;
    const base = Math.round(baseSec * sr);
    const output = Math.round(outSec * sr);
    const input = Math.round(inSec * sr);
    const quantum = this.ctx?.renderQuantumSize || 128;
    const total = input + stft + base + output;
    return {
      sampleRate: sr,
      quantum,
      stft,
      hop,
      surround,
      base,
      output,
      input,
      total,
      totalMs: sr ? (total / sr) * 1000 : 0,
    };
  }

  delayReadout() {
    const sr = this.ctx?.sampleRate || 0;
    const rows = [];
    for (const s of this.sources.values()) {
      if (!s.ears || s.gain.gain.value <= 0.0001) continue;
      const secL = s.ears.secL ?? 0;
      const secR = s.ears.secR ?? 0;
      const smpL = secL * sr;
      const smpR = secR * sr;
      rows.push({
        id: s.id,
        name: s.name,
        smpL,
        smpR,
        itdSamples: smpR - smpL,
        itdUs: (secR - secL) * 1e6,
      });
    }
    return { sampleRate: sr, rows };
  }

  setListener(pose) {
    const x = pose.x;
    const y = pose.y + this.listenerY;
    const z = pose.z;
    const f = pose.forward;
    const u = pose.up;
    this.listenerPose = { x, y, z, forward: f, up: u };
    if (this.scene) {
      this.scene.setListenerPosition(x, y, z);
      this.scene.setListenerOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = x;
      l.positionY.value = y;
      l.positionZ.value = z;
      l.forwardX.value = f.x;
      l.forwardY.value = f.y;
      l.forwardZ.value = f.z;
      l.upX.value = u.x;
      l.upY.value = u.y;
      l.upZ.value = u.z;
    } else if (l.setPosition) {
      l.setPosition(x, y, z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
    this._updateEarDelays();
    this._pushStereoPose();
  }

  _pushStereoPose() {
    const p = this.listenerPose;
    if (!this.stereo6dof) return;
    const fl = this.sources.get("upmix-FL");
    const fr = this.sources.get("upmix-FR");
    this.stereo6dof.port.postMessage({
      x: p.x,
      y: p.y,
      z: p.z,
      fx: p.forward.x,
      fy: p.forward.y,
      fz: p.forward.z,
      ux: p.up.x,
      uy: p.up.y,
      uz: p.up.z,
      headRadius: this.headRadius,
      flx: fl?.x ?? -1.1,
      fly: fl?.y ?? 1.2,
      flz: fl?.z ?? -1.905,
      frx: fr?.x ?? 1.1,
      fry: fr?.y ?? 1.2,
      frz: fr?.z ?? -1.905,
    });
  }

  _poseIsIdentity() {
    const p = this.listenerPose;
    if (!p) return true;
    return (
      Math.abs(p.x) < 1e-4 &&
      Math.abs(p.z) < 1e-4 &&
      Math.abs(p.y - this.listenerY) < 1e-4 &&
      Math.abs(p.forward.x) < 1e-4 &&
      Math.abs(p.forward.z + 1) < 1e-4 &&
      Math.abs(p.up.y - 1) < 1e-4
    );
  }

  setSpeakerLayout(id) {
    this.layoutId = getLayout(id).id;
    this._applyLayout();
  }

  setLayoutRadius(meters) {
    this.layoutRadius = Math.max(0.8, Math.min(4, meters));
    this._applyLayout();
  }

  _applyLayout() {
    const L = getLayout(this.layoutId);
    const R = this.layoutRadius;
    const pair = L.pair;
    this._moveSource("upmix-FL", resolvePos(pair.fl, R));
    this._moveSource("upmix-FR", resolvePos(pair.fr, R));
    for (const [key, def] of Object.entries(L.upmix)) {
      this._moveSource(`upmix-${key}`, resolvePos(def, R));
    }
    for (const [key, def] of Object.entries(L.demo)) {
      this._moveSource(key, resolvePos(def, R));
    }
    this._updateEarDelays();
    this._pushStereoPose();
  }

  _moveSource(id, pos) {
    const s = this.sources.get(id);
    if (!s || !pos) return;
    s.x = pos.x;
    s.y = pos.y;
    s.z = pos.z;
    s.src?.setPosition(pos.x, pos.y, pos.z);
    if (s.panner?.positionX) {
      s.panner.positionX.value = pos.x;
      s.panner.positionY.value = pos.y;
      s.panner.positionZ.value = pos.z;
    } else if (s.panner?.setPosition) {
      s.panner.setPosition(pos.x, pos.y, pos.z);
    }
  }

  setSourceGain(id, gain) {
    const s = this.sources.get(id);
    if (!s) return;
    s.userGain = gain;
    s.gain.gain.value = gain;
  }

  setSourceMute(id, mute) {
    const s = this.sources.get(id);
    if (s) s.gain.gain.value = mute ? 0 : s.userGain;
  }

  async loadFile(id, file) {
    const s = this.sources.get(id);
    if (!s) return;
    const audio = await this._decode(file);
    this._stopVoice(s);
    const node = this.ctx.createBufferSource();
    node.buffer = audio;
    node.loop = true;
    node.connect(s.gain);
    node.start();
    s.voice = node;
    s.fileName = file.name;
  }

  async playUpmixFile(file) {
    const audio = await this._decode(file);
    return this.playUpmixBuffer(audio, file.name || "stereo");
  }

  playTestStereo() {
    return this.playUpmixBuffer(makeTestStereo(this.ctx), "test-stereo");
  }

  async startLiveInput(deviceId) {
    this._stopUpmixSrc();
    const stream = await openAudioInput(deviceId);
    this.liveStream = stream;
    this.liveNode = this.ctx.createMediaStreamSource(stream);
    if (!this.inputAnalyser) {
      this.inputAnalyser = this.ctx.createAnalyser();
      this.inputAnalyser.fftSize = 256;
      this.inputAnalyser.smoothingTimeConstant = 0.3;
      this._peakBuf = new Float32Array(this.inputAnalyser.fftSize);
    }
    this.liveNode.connect(this.inputAnalyser);
    if (this.mode === "upmix") {
      await this._ensureUpmix();
      this.liveNode.connect(this.upmixInput);
      this.setMode("upmix");
    } else {
      await this._ensureStereo6DoF();
      this.liveNode.connect(this.stereo6dof);
      this.setMode("pair");
    }
    this.upmixLabel = stream.getAudioTracks()[0]?.label || "audio-input";
    return { kind: this.mode === "upmix" ? this.upmixKind : "pair", label: this.upmixLabel, channels: this.liveNode.channelCount };
  }

  inputPeak() {
    if (!this.inputAnalyser || !this.liveNode) return 0;
    this.inputAnalyser.getFloatTimeDomainData(this._peakBuf);
    let p = 0;
    for (let i = 0; i < this._peakBuf.length; i++) {
      const a = Math.abs(this._peakBuf[i]);
      if (a > p) p = a;
    }
    return p;
  }

  get liveActive() {
    return Boolean(this.liveStream);
  }

  async playUpmixBuffer(buffer, label = "") {
    this._stopUpmixSrc();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    if (this.mode === "upmix") {
      await this._ensureUpmix();
      src.connect(this.upmixInput);
      this.setMode("upmix");
    } else {
      await this._ensureStereo6DoF();
      src.connect(this.stereo6dof);
      this.setMode("pair");
    }
    src.start();
    this.upmixSrc = src;
    this.upmixLabel = label;
    return this.mode === "upmix" ? this.upmixKind : "pair";
  }

  async _ensureStereo6DoF() {
    if (this.stereo6dof) return;
    await this.ctx.audioWorklet.addModule(new URL("./stereo-6dof-processor.js", import.meta.url));
    const node = new AudioWorkletNode(this.ctx, "stereo-6dof", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    node.connect(this.master);
    this.stereo6dof = node;
    this._pushStereoPose();
  }

  setMode(mode) {
    if (mode === "stereo") mode = "pair";
    this.mode = mode;
    const demo = mode === "demo";
    const pair = mode === "pair";
    for (const spec of DEFAULT_SOURCES) {
      const s = this.sources.get(spec.id);
      if (!s) continue;
      s.gain.gain.value = demo ? s.userGain : 0;
      if (demo && !s.voice) this._attachSynth(spec, s.gain);
      if (!demo) this._stopVoice(s);
    }
    for (const spec of UPMIX_SOURCES) {
      const s = this.sources.get(spec.id);
      if (!s) continue;
      if (demo) s.gain.gain.value = 0;
      else if (pair) s.gain.gain.value = 0;
      else s.gain.gain.value = s.userGain;
    }
    if (demo) this._stopUpmixSrc();
  }

  setUpmixParam(name, value) {
    this.upmixParams[name] = value;
    const param = this.upmixNode?.parameters?.get(name);
    if (param) param.value = value;
    const g = this.upmixGains?.[name];
    if (g) g.gain.value = value;
    if (name === "surround" && this.upmixGains?.surroundR) this.upmixGains.surroundR.gain.value = -value;
    if (name === "width" && this.upmixGains?.widthR) this.upmixGains.widthR.gain.value = value;
  }

  currentLayout() {
    const ids =
      this.mode === "upmix"
        ? UPMIX_SOURCES.map((s) => s.id)
        : this.mode === "pair"
          ? ["upmix-FL", "upmix-FR"]
          : DEFAULT_SOURCES.map((s) => s.id);
    return ids.map((id) => {
      const s = this.sources.get(id);
      const fallback = UPMIX_SOURCES.find((u) => u.id === id) || DEFAULT_SOURCES.find((d) => d.id === id);
      return {
        id,
        name: s?.name || fallback?.name || id,
        x: s?.x ?? fallback?.x ?? 0,
        y: s?.y ?? fallback?.y ?? 1.2,
        z: s?.z ?? fallback?.z ?? 0,
        color: s?.color || fallback?.color || "#d4a017",
        ch: s?.ch ?? fallback?.ch,
      };
    });
  }

  async _decode(file) {
    const buf = await file.arrayBuffer();
    return this.ctx.decodeAudioData(buf.slice(0));
  }

  async _ensureUpmix() {
    if (this.upmixInput) return;
    try {
      await this.ctx.audioWorklet.addModule(new URL("./upmix-processor.js", import.meta.url));
      const node = new AudioWorkletNode(this.ctx, "stereo-upmix", {
        numberOfInputs: 1,
        numberOfOutputs: 6,
        outputChannelCount: [1, 1, 1, 1, 1, 1],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      for (const [k, v] of Object.entries(this.upmixParams)) {
        const p = node.parameters.get(k);
        if (p) p.value = v;
      }
      this.upmixNode = node;
      this.upmixInput = node;
      this.upmixKind = "stft";
      for (const spec of UPMIX_SOURCES) {
        node.connect(this.sources.get(spec.id).gain, spec.ch, 0);
      }
    } catch {
      this._buildGraphUpmix();
      this.upmixKind = "ms-graph";
    }
  }

  _buildGraphUpmix() {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    input.connect(split);

    const mid = ctx.createGain();
    const side = ctx.createGain();
    const lM = ctx.createGain();
    lM.gain.value = 0.5;
    const rM = ctx.createGain();
    rM.gain.value = 0.5;
    const lS = ctx.createGain();
    lS.gain.value = 0.5;
    const rS = ctx.createGain();
    rS.gain.value = -0.5;
    split.connect(lM, 0);
    split.connect(rM, 1);
    lM.connect(mid);
    rM.connect(mid);
    split.connect(lS, 0);
    split.connect(rS, 1);
    lS.connect(side);
    rS.connect(side);

    const cHp = ctx.createBiquadFilter();
    cHp.type = "highpass";
    cHp.frequency.value = 160;
    const cG = ctx.createGain();
    cG.gain.value = this.upmixParams.center;
    mid.connect(cHp).connect(cG);

    const cSub = ctx.createGain();
    cSub.gain.value = -0.55;
    cG.connect(cSub);
    const wL = ctx.createGain();
    wL.gain.value = this.upmixParams.width;
    const wR = ctx.createGain();
    wR.gain.value = this.upmixParams.width;
    split.connect(wL, 0);
    split.connect(wR, 1);
    cSub.connect(wL);
    cSub.connect(wR);

    const slDelay = ctx.createDelay(0.05);
    slDelay.delayTime.value = 0.013;
    const srDelay = ctx.createDelay(0.05);
    srDelay.delayTime.value = 0.019;
    const slLp = ctx.createBiquadFilter();
    slLp.type = "lowpass";
    slLp.frequency.value = 6000;
    const srLp = ctx.createBiquadFilter();
    srLp.type = "lowpass";
    srLp.frequency.value = 6000;
    const slG = ctx.createGain();
    slG.gain.value = this.upmixParams.surround;
    const srG = ctx.createGain();
    srG.gain.value = -this.upmixParams.surround;
    side.connect(slDelay).connect(slLp).connect(slG);
    side.connect(srDelay).connect(srLp).connect(srG);

    const tHp = ctx.createBiquadFilter();
    tHp.type = "highpass";
    tHp.frequency.value = 3500;
    const tDelay = ctx.createDelay(0.05);
    tDelay.delayTime.value = 0.008;
    const tG = ctx.createGain();
    tG.gain.value = this.upmixParams.height;
    side.connect(tHp).connect(tDelay).connect(tG);

    wL.connect(this.sources.get("upmix-FL").gain);
    wR.connect(this.sources.get("upmix-FR").gain);
    cG.connect(this.sources.get("upmix-C").gain);
    slG.connect(this.sources.get("upmix-SL").gain);
    srG.connect(this.sources.get("upmix-SR").gain);
    tG.connect(this.sources.get("upmix-T").gain);

    this.upmixInput = input;
    this.upmixNode = null;
    this.upmixGains = { center: cG, surround: slG, height: tG, width: wL, widthR: wR, surroundR: srG };
  }

  stopLiveInput() {
    try {
      this.liveNode?.disconnect();
    } catch {
      /* noop */
    }
    this.liveStream?.getTracks().forEach((t) => t.stop());
    this.liveNode = null;
    this.liveStream = null;
  }

  _stopUpmixSrc() {
    try {
      this.upmixSrc?.stop();
    } catch {
      /* already stopped */
    }
    try {
      this.upmixSrc?.disconnect();
    } catch {
      /* noop */
    }
    this.upmixSrc = null;
    this.stopLiveInput();
  }

  stopAll() {
    for (const s of this.sources.values()) this._stopVoice(s);
  }

  _makeEarTap(gain) {
    const ctx = this.ctx;
    const delayL = ctx.createDelay(0.08);
    const delayR = ctx.createDelay(0.08);
    const lpL = ctx.createBiquadFilter();
    const lpR = ctx.createBiquadFilter();
    lpL.type = "lowpass";
    lpR.type = "lowpass";
    lpL.frequency.value = 18000;
    lpR.frequency.value = 18000;
    const gL = ctx.createGain();
    const gR = ctx.createGain();
    gL.gain.value = 1;
    gR.gain.value = 1;
    gain.connect(delayL);
    gain.connect(delayR);
    delayL.connect(gL).connect(this.earsMerger, 0, 0);
    delayR.connect(gR).connect(this.earsMerger, 0, 1);
    return { delayL, delayR, lpL, lpR, gL, gR };
  }

  _updateEarDelays() {
    if (!this.ctx) return;
    const a = this.headRadius;
    const lp = this.listenerPose;
    const f = lp.forward;
    const u = lp.up;
    const right = norm(cross(f, u));
    const leftEar = { x: lp.x - right.x * a, y: lp.y - right.y * a, z: lp.z - right.z * a };
    const rightEar = { x: lp.x + right.x * a, y: lp.y + right.y * a, z: lp.z + right.z * a };
    const t = this.ctx.currentTime;
    for (const s of this.sources.values()) {
      if (!s.ears) continue;
      const dL = Math.max(0.05, dist(s, leftEar));
      const dR = Math.max(0.05, dist(s, rightEar));
      const secL = dL / SPEED_OF_SOUND;
      const secR = dR / SPEED_OF_SOUND;
      const earlier = Math.min(secL, secR);
      s.ears.secL = secL - earlier;
      s.ears.secR = secR - earlier;
      s.ears.delayL.delayTime.setTargetAtTime(s.ears.secL, t, 0.01);
      s.ears.delayR.delayTime.setTargetAtTime(s.ears.secR, t, 0.01);
      s.ears.gL.gain.setTargetAtTime(Math.min(2.5, 1.8 / dL), t, 0.01);
      s.ears.gR.gain.setTargetAtTime(Math.min(2.5, 1.8 / dR), t, 0.01);
      s.ears.lpL.frequency.setTargetAtTime(20000, t, 0.02);
      s.ears.lpR.frequency.setTargetAtTime(20000, t, 0.02);
    }
  }

  _spawn(spec, withSynth) {
    const gain = this.ctx.createGain();
    gain.gain.value = withSynth ? 1 : 0;
    const ears = this._makeEarTap(gain);
    if (this.backend === "resonance") {
      const src = this.scene.createSource({
        minDistance: 1.8,
        maxDistance: 20,
        rolloff: "logarithmic",
      });
      src.setPosition(spec.x, spec.y, spec.z);
      gain.connect(src.input);
      this.sources.set(spec.id, {
        ...spec,
        gain,
        src,
        panner: null,
        ears,
        voice: null,
        userGain: 1,
        fileName: "",
      });
    } else {
      const panner = this.ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 1.8;
      panner.maxDistance = 20;
      panner.rolloffFactor = 1;
      panner.positionX.value = spec.x;
      panner.positionY.value = spec.y;
      panner.positionZ.value = spec.z;
      gain.connect(panner);
      panner.connect(this.hrtfBus);
      this.sources.set(spec.id, {
        ...spec,
        gain,
        src: null,
        panner,
        ears,
        voice: null,
        userGain: 1,
        fileName: "",
      });
    }
    if (withSynth) this._attachSynth(spec, this.sources.get(spec.id).gain);
  }

  _attachSynth(spec, dest) {
    const s = this.sources.get(spec.id);
    const voice = makeSynth(this.ctx, spec.kind);
    voice.connect(dest);
    s.voice = voice;
  }

  _stopVoice(s) {
    try {
      s.voice?.stop?.();
    } catch {
      /* already stopped */
    }
    try {
      s.voice?.disconnect?.();
    } catch {
      /* noop */
    }
    s.voice = null;
  }
}

function makeSynth(ctx, kind) {
  const out = ctx.createGain();
  out.gain.value = 0.22;
  if (kind === "melody") {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 220;
    g.gain.value = 0.0;
    osc.connect(g).connect(out);
    osc.start();
    const notes = [220, 277, 330, 370, 440, 330];
    let i = 0;
    const tick = () => {
      if (out.context.state === "closed") return;
      const t = ctx.currentTime;
      osc.frequency.setValueAtTime(notes[i % notes.length], t);
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      i += 1;
      out._timer = setTimeout(tick, 320);
    };
    tick();
    out.stop = () => {
      clearTimeout(out._timer);
      osc.stop();
    };
    return out;
  }
  if (kind === "pulse" || kind === "pulse2") {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = kind === "pulse" ? 90 : 120;
    g.gain.value = 0.0001;
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.value = kind === "pulse" ? 400 : 900;
    filt.Q.value = 4;
    osc.connect(g).connect(filt).connect(out);
    osc.start();
    const period = kind === "pulse" ? 700 : 530;
    const beat = () => {
      const t = ctx.currentTime;
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.4, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      out._timer = setTimeout(beat, period);
    };
    beat();
    out.stop = () => {
      clearTimeout(out._timer);
      osc.stop();
    };
    return out;
  }
  if (kind === "chime") {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    g.gain.value = 0.0001;
    osc.connect(g).connect(out);
    osc.start();
    const chime = () => {
      const t = ctx.currentTime;
      osc.frequency.setValueAtTime(880 + 220 * (Math.random() > 0.5 ? 1 : 0), t);
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      out._timer = setTimeout(chime, 1800);
    };
    chime();
    out.stop = () => {
      clearTimeout(out._timer);
      osc.stop();
    };
    return out;
  }
  const osc = ctx.createOscillator();
  const lfo = ctx.createOscillator();
  const lfoG = ctx.createGain();
  const filt = ctx.createBiquadFilter();
  osc.type = "sawtooth";
  osc.frequency.value = 110;
  lfo.frequency.value = 0.15;
  lfoG.gain.value = 40;
  filt.type = "lowpass";
  filt.frequency.value = 420;
  lfo.connect(lfoG).connect(filt.frequency);
  osc.connect(filt).connect(out);
  osc.start();
  lfo.start();
  out.stop = () => {
    osc.stop();
    lfo.stop();
  };
  return out;
}

function makeTestStereo(ctx) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 16);
  const buf = ctx.createBuffer(2, n, sr);
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const bass = 0.18 * Math.sin(2 * Math.PI * 110 * t);
    const left = 0.22 * Math.sin(2 * Math.PI * 440 * t) * gate(t, 0, 16, 1.6);
    const right = 0.22 * Math.sin(2 * Math.PI * 659.25 * t) * gate(t, 0.8, 16, 1.6);
    const noise = (Math.random() * 2 - 1) * 0.05 * gate(t, 4, 12, 0.4);
    L[i] = bass + left + noise;
    R[i] = bass + right - noise * 0.85;
  }
  return buf;
}

function gate(t, start, end, period) {
  if (t < start || t > end) return 0;
  return 0.45 + 0.55 * Math.max(0, Math.sin((2 * Math.PI * (t - start)) / period));
}

export async function listAudioInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput" && d.deviceId);
}

export async function unlockAudioDevices() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
  stream.getTracks().forEach((t) => t.stop());
  await new Promise((r) => setTimeout(r, 80));
  return listAudioInputs();
}

async function openAudioInput(deviceId) {
  const base = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    voiceIsolation: false,
    sampleRate: 48000,
    sampleSize: 24,
    channelCount: 2,
  };
  if (deviceId) base.deviceId = { exact: deviceId };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: base, video: false });
  } catch {
    const fallback = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (deviceId) fallback.deviceId = { exact: deviceId };
    return navigator.mediaDevices.getUserMedia({ audio: fallback, video: false });
  }
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function norm(v) {
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
