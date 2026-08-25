import { HeadTracker, listCameras } from "./tracker.js";
import { SpatialEngine, listAudioInputs, unlockAudioDevices } from "./audio-engine.js";
import { LAYOUTS } from "./layouts.js";
import { RoomView } from "./scene.js";

const $ = (id) => document.getElementById(id);

const state = {
  dof: 6,
  scale: 2,
  running: false,
  backend: "—",
  keys: new Set(),
  offset: {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
  },
};

const tracker = new HeadTracker();
const engine = new SpatialEngine();
const view = new RoomView($("view"));
const overlay = $("overlay");
const octx = overlay.getContext("2d");

const IDENTITY = {
  x: 0,
  y: 0,
  z: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  forward: { x: 0, y: 0, z: -1 },
  up: { x: 0, y: 1, z: 0 },
};

function yprToBasis(yaw, pitch, roll) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  const forward = {
    x: -sy * cp,
    y: sp,
    z: -cy * cp,
  };
  const up = {
    x: cy * sr - sy * sp * cr,
    y: cp * cr,
    z: -sy * sr - cy * sp * cr,
  };
  return { forward, up };
}

function applyDoF(raw) {
  const pose = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    forward: { ...IDENTITY.forward },
    up: { ...IDENTITY.up },
  };
  if (state.dof >= 3) {
    pose.yaw = (raw.yaw || 0) + state.offset.yaw;
    pose.pitch = (raw.pitch || 0) + state.offset.pitch;
    pose.roll = (raw.roll || 0) + state.offset.roll;
    const b = yprToBasis(pose.yaw, pose.pitch, pose.roll);
    pose.forward = b.forward;
    pose.up = b.up;
  }
  if (state.dof >= 6) {
    pose.x = (raw.x || 0) * state.scale + state.offset.x;
    pose.y = (raw.y || 0) * state.scale + state.offset.y;
    pose.z = (raw.z || 0) * state.scale + state.offset.z;
    const limit = 1.2;
    pose.x = clamp(pose.x, -limit, limit);
    pose.y = clamp(pose.y, -0.5, 0.5);
    pose.z = clamp(pose.z, -limit, limit);
  }
  return snapCenter(pose);
}

function snapCenter(pose) {
  const pos = Math.hypot(pose.x, pose.y, pose.z);
  const ang = Math.hypot(pose.yaw, pose.pitch, pose.roll);
  if (pos < 0.04 && ang < (4 * Math.PI) / 180) return { ...IDENTITY };
  return pose;
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function drawLandmarks(landmarks) {
  const w = overlay.width;
  const h = overlay.height;
  octx.clearRect(0, 0, w, h);
  if (!landmarks) return;
  octx.fillStyle = "rgba(212,160,23,0.9)";
  for (const p of landmarks) {
    octx.beginPath();
    octx.arc((1 - p.x) * w, p.y * h, 1.2, 0, Math.PI * 2);
    octx.fill();
  }
}

function setBar(id, value, range) {
  const el = $(id);
  el.style.width = `${clamp(50 + (value / range) * 50, 0, 100)}%`;
}

function format(v, digits) {
  const n = Number.isFinite(v) ? v : 0;
  return (n >= 0 ? "+" : "") + n.toFixed(digits);
}

function renderPose(pose, tracking) {
  $("status").textContent = tracking ? "TRACK" : "NO FACE";
  $("status").className = "badge " + (tracking ? "live" : "lost");
  $("backend").textContent = state.backend;
  $("dofLabel").textContent = `${state.dof}DoF`;
  $("px").textContent = format(pose.x, 2);
  $("py").textContent = format(pose.y, 2);
  $("pz").textContent = format(pose.z, 2);
  $("yaw").textContent = `${((pose.yaw * 180) / Math.PI).toFixed(0)}°`;
  $("pitch").textContent = `${((pose.pitch * 180) / Math.PI).toFixed(0)}°`;
  $("roll").textContent = `${((pose.roll * 180) / Math.PI).toFixed(0)}°`;
  setBar("bx", pose.x, 1.8);
  setBar("by", pose.y, 1.2);
  setBar("bz", pose.z, 1.8);
  setBar("byaw", pose.yaw, Math.PI);
  setBar("bpitch", pose.pitch, Math.PI / 2);
  setBar("broll", pose.roll, Math.PI / 2);
}

function stepKeyboard(dt) {
  const k = state.keys;
  const move = 0.9 * dt;
  const rot = 1.2 * dt;
  if (k.has("KeyW")) state.offset.z -= move;
  if (k.has("KeyS")) state.offset.z += move;
  if (k.has("KeyA")) state.offset.x -= move;
  if (k.has("KeyD")) state.offset.x += move;
  if (k.has("KeyR")) state.offset.y += move;
  if (k.has("KeyF")) state.offset.y -= move;
  if (k.has("ArrowLeft")) state.offset.yaw += rot;
  if (k.has("ArrowRight")) state.offset.yaw -= rot;
  if (k.has("ArrowUp")) state.offset.pitch += rot;
  if (k.has("ArrowDown")) state.offset.pitch -= rot;
  if (k.has("KeyQ")) state.offset.roll += rot;
  if (k.has("KeyE")) state.offset.roll -= rot;
}

function fitOverlay() {
  overlay.width = overlay.clientWidth;
  overlay.height = overlay.clientHeight;
}

async function start() {
  $("start").disabled = true;
  $("hint").textContent = "カメラと AudioContext を初期化しています…";
  try {
    if (!engine.ctx) {
      state.backend = await engine.init();
      $("backend").textContent = state.backend;
    }
    await engine.resume();
    refreshFormat();
    await tracker.start($("cam"), $("camera").value || undefined);
    try {
      await unlockAudioDevices();
    } catch {
      /* mic denied: list stays locked */
    }
    await fillCameras();
    await fillAudioInputs();
    fitOverlay();
    state.running = true;
    $("calibrate").disabled = false;
    $("stop").disabled = false;
    $("hint").textContent = "正面を見てキャリブレーションを押す。ヘッドホン必須。";
    if ($("audioIn").value) {
      try {
        if ($("mode").value === "demo") $("mode").value = "pair";
        engine.setMode($("mode").value);
        const info = await engine.startLiveInput($("audioIn").value);
        buildSourceList();
        refreshFormat();
        $("hint").textContent = `${info.label} を入力中。正面を見てキャリブレーション。`;
      } catch (err) {
        $("hint").textContent = `カメラは開始。音声入力: ${err.message}`;
      }
    }
  } catch (err) {
    $("hint").textContent = `起動失敗: ${err.message}`;
    $("start").disabled = false;
  }
}

function stop() {
  tracker.stop();
  state.running = false;
  $("start").disabled = false;
  $("calibrate").disabled = true;
  $("stop").disabled = true;
  $("status").textContent = "STOP";
  $("status").className = "badge lost";
}

function buildSourceList() {
  const mode = $("mode").value;
  const upmix = mode === "upmix";
  const pair = mode === "pair";
  const layout = engine.currentLayout();
  const root = $("sourceList");
  root.innerHTML = "";
  $("upmixPanel").hidden = !upmix;
  $("dropTargetRow").hidden = upmix || pair;
  $("sourceHint").textContent = upmix
    ? "ステレオを FL / FR / C / SL / SR / T に分けて、各スピーカを6DoFで聴く。"
    : pair
      ? "L を左前、R を右前のスピーカに置く。分解しない。"
      : "部屋に置いてある音源。ファイルをドロップするとその位置でループする。";
  for (const spec of layout) {
    const el = document.createElement("div");
    el.className = "source";
    el.dataset.id = spec.id;
    el.innerHTML = `
      <h3>${spec.name} <span class="meta">${spec.id.replace("upmix-", "")}</span></h3>
      <div class="meta">${spec.x.toFixed(1)}, ${spec.y.toFixed(1)}, ${spec.z.toFixed(1)}</div>
      <div class="meta" data-delay="${spec.id}">L —  R —  Δ — smp</div>
      <label class="row">gain <input type="range" min="0" max="1.5" step="0.01" value="1" data-gain="${spec.id}"></label>
    `;
    root.appendChild(el);
  }
  view.setLayout(layout);
}

async function ensureEngine() {
  if (!engine.ctx) {
    state.backend = await engine.init();
    $("backend").textContent = state.backend;
    refreshFormat();
  }
  await engine.resume();
}

function refreshFormat() {
  if (!engine.ctx) return;
  const f = engine.formatInfo();
  const inTxt = f.inputRate ? ` / in ${f.inputRate}Hz ${f.inputBits || "?"}bit` : "";
  $("format").textContent = `${f.contextRate}Hz f32${inTxt}`;
  const cm = f.headRadius * 100;
  $("headVal").textContent = `${cm.toFixed(2)}cm / 耳間 ${(cm * 2).toFixed(1)}cm`;
  renderEngineLatency();
}

function renderEngineLatency() {
  if (!engine.ctx) return;
  const d = engine.engineLatency();
  $("engDelay").textContent = `遅延 ${d.total} smp`;
  $("engTotal").textContent = `${d.total} smp  (${d.totalMs.toFixed(1)} ms)  @ ${d.sampleRate} Hz`;
  $("engStft").textContent = d.stft
    ? `window ${d.stft} / hop ${d.hop} / SL+ ${d.surround} smp`
    : "通っていない";
  $("engDev").textContent = `in ${d.input} + base ${d.base} + out ${d.output}  (quantum ${d.quantum})`;
  $("footerFmt").textContent =
    `エンジン遅延 ${d.total} smp (${d.totalMs.toFixed(1)} ms) = 入力 ${d.input} + STFT ${d.stft} + base ${d.base} + out ${d.output}`;
}

function applySpeakerLayout() {
  const id = $("layout").value;
  const r = Number($("layoutR").value);
  $("layoutRVal").textContent = r.toFixed(1);
  if (!engine.ctx) {
    engine.layoutId = id;
    engine.layoutRadius = r;
    return;
  }
  engine.setSpeakerLayout(id);
  engine.setLayoutRadius(r);
  buildSourceList();
}

async function applyMode(mode) {
  await ensureEngine();
  engine.setMode(mode);
  applySpeakerLayout();
  buildSourceList();
  if (mode === "upmix" && !engine.upmixSrc && !engine.liveActive) {
    $("hint").textContent = "音声入力を選ぶか、ファイル／テストステレオを再生。";
  }
  if (mode === "demo") $("audioIn").value = "";
}

function bindUi() {
  $("start").addEventListener("click", start);
  $("stop").addEventListener("click", stop);
  $("calibrate").addEventListener("click", () => {
    state.offset = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    const ok = tracker.calibrate();
    $("hint").textContent = ok ? "原点を現在の頭部に合わせた。" : "顔が見えてからもう一度。";
  });
  $("dof").addEventListener("change", (e) => {
    state.dof = Number(e.target.value);
  });
  $("viewMode").addEventListener("change", (e) => {
    view.setViewMode(e.target.value);
  });
  $("scale").addEventListener("input", (e) => {
    state.scale = Number(e.target.value);
    $("scaleVal").textContent = state.scale.toFixed(2);
  });
  $("master").addEventListener("input", (e) => {
    engine.setMasterGain(Number(e.target.value));
  });
  $("room").addEventListener("change", (e) => {
    engine.setRoom(e.target.checked);
  });
  $("spatializer").addEventListener("change", (e) => {
    engine.setSpatializer(e.target.value);
  });
  $("headRadius").addEventListener("input", (e) => {
    const cm = Number(e.target.value);
    engine.setHeadRadius(cm / 100);
    $("headVal").textContent = `${cm.toFixed(2)}cm / 耳間 ${(cm * 2).toFixed(1)}cm`;
    refreshFormat();
  });
  $("mode").addEventListener("change", (e) => applyMode(e.target.value));
  $("layout").addEventListener("change", applySpeakerLayout);
  $("layoutR").addEventListener("input", (e) => {
    $("layoutRVal").textContent = Number(e.target.value).toFixed(1);
    applySpeakerLayout();
  });
  $("audioIn").addEventListener("change", onAudioInputChange);
  $("audioList").addEventListener("click", revealAudioInputs);
  $("sourceList").addEventListener("input", (e) => {
    const id = e.target.dataset.gain;
    if (id) engine.setSourceGain(id, Number(e.target.value));
  });
  for (const [id, key] of [
    ["upmixCenter", "center"],
    ["upmixSurround", "surround"],
    ["upmixHeight", "height"],
    ["upmixWidth", "width"],
  ]) {
    $(id).addEventListener("input", (e) => {
      const v = Number(e.target.value);
      $(key + "Val").textContent = v.toFixed(2);
      engine.setUpmixParam(key, v);
    });
  }
  $("testStereo").addEventListener("click", async () => {
    await ensureEngine();
    if ($("mode").value === "demo") $("mode").value = "pair";
    engine.setMode($("mode").value);
    const kind = await engine.playTestStereo();
    buildSourceList();
    $("hint").textContent = `テストステレオ再生中（${kind}）。`;
  });

  const drop = $("drop");
  const onFile = async (file, id) => {
    await ensureEngine();
    if ($("mode").value === "upmix" || $("mode").value === "pair") {
      engine.setMode($("mode").value);
      const kind = await engine.playUpmixFile(file);
      buildSourceList();
      $("hint").textContent = `${file.name} を再生中（${kind}）。`;
      return;
    }
    await engine.loadFile(id, file);
    $("hint").textContent = `${file.name} を ${id} に置いた。`;
  };
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const file = e.dataTransfer.files[0];
    if (file) await onFile(file, $("dropTarget").value);
  });
  $("file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (file) await onFile(file, $("dropTarget").value);
  });

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code === "Digit0") $("dof").value = state.dof = 0;
    if (e.code === "Digit3") $("dof").value = state.dof = 3;
    if (e.code === "Digit6") $("dof").value = state.dof = 6;
    if (e.code === "KeyC") $("calibrate").click();
    state.keys.add(e.code);
  });
  window.addEventListener("keyup", (e) => state.keys.delete(e.code));
  window.addEventListener("blur", () => state.keys.clear());
}

async function fillCameras() {
  try {
    const cams = await listCameras();
    const sel = $("camera");
    const prev = sel.value;
    sel.innerHTML = "";
    cams.forEach((c, i) => {
      const opt = document.createElement("option");
      opt.value = c.deviceId;
      opt.textContent = c.label || `Camera ${i + 1}`;
      sel.appendChild(opt);
    });
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  } catch {
    /* permission comes after start */
  }
}

function addOption(sel, value, text) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = text;
  sel.appendChild(opt);
  return opt;
}

async function fillAudioInputs() {
  const sel = $("audioIn");
  const prev = sel.value;
  sel.innerHTML = "";
  addOption(sel, "", "使わない");
  let labeled = [];
  try {
    labeled = (await listAudioInputs()).filter((d) => d.label);
  } catch {
    labeled = [];
  }
  if (!labeled.length) {
    addOption(sel, "__unlock__", "マイクを許可して一覧を出す…");
    return;
  }
  for (const d of labeled) addOption(sel, d.deviceId, d.label);
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function revealAudioInputs() {
  $("hint").textContent = "マイクの許可を出すとデバイス名が出る。";
  try {
    await unlockAudioDevices();
    await fillAudioInputs();
    const n = $("audioIn").options.length - 1;
    $("hint").textContent = n > 0 ? `入力 ${n} 件。選んでください。` : "入力デバイスが見つからない。";
  } catch (err) {
    $("hint").textContent = `マイク許可が必要: ${err.message}`;
    $("audioIn").value = "";
  }
}

async function onAudioInputChange() {
  const id = $("audioIn").value;
  if (id === "__unlock__") {
    await revealAudioInputs();
    return;
  }
  if (!id) {
    engine.stopLiveInput();
    $("hint").textContent = "音声入力を切った。";
    $("inPeak").style.width = "0%";
    return;
  }
  if ($("mode").value === "demo") $("mode").value = "pair";
  await ensureEngine();
  engine.setMode($("mode").value);
  try {
    const info = await engine.startLiveInput(id);
    buildSourceList();
    await fillAudioInputs();
    $("audioIn").value = id;
    refreshFormat();
    $("hint").textContent = `${info.label} を ${$("mode").value === "upmix" ? "仮想マルチ" : "ステレオ対"} で再生中。`;
  } catch (err) {
    $("hint").textContent = `音声入力: ${err.message}`;
    $("audioIn").value = "";
  }
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  stepKeyboard(dt);
  const raw = tracker.update(now);
  const pose = applyDoF(raw.tracking ? raw : IDENTITY);
  if (engine.ctx) engine.setListener(pose);
  view.setListenerPose(pose);
  view.render();
  renderPose(pose, !!raw.tracking);
  if (raw.landmarks) drawLandmarks(raw.landmarks);
  const peak = engine.inputPeak();
  $("inPeak").style.width = `${Math.min(100, peak * 140)}%`;
  $("inPeak").style.background = peak > 0.9 ? "var(--warn)" : "var(--ok)";
  renderEngineLatency();
  requestAnimationFrame(loop);
}

function fillLayouts() {
  const sel = $("layout");
  sel.innerHTML = "";
  for (const L of LAYOUTS) {
    const opt = document.createElement("option");
    opt.value = L.id;
    opt.textContent = L.name;
    sel.appendChild(opt);
  }
  sel.value = "stereo30";
}

fillLayouts();
buildSourceList();
bindUi();
fillCameras();
fillAudioInputs();
if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    fillCameras();
    fillAudioInputs();
  });
}
fitOverlay();
window.addEventListener("resize", fitOverlay);
requestAnimationFrame(loop);
