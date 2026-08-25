import * as THREE from "three";
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/+esm";

const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm";

const IOD_M = 0.063;
const FOV_H = (68 * Math.PI) / 180;
const LM_NOSE = 1;
const LM_LEYE = 33;
const LM_REYE = 263;
const LM_LIRIS = 468;
const LM_RIRIS = 473;

const CAM_TO_WORLD = new THREE.Matrix4().set(
  -1, 0, 0, 0,
  0, -1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1
);

class OneEuro {
  constructor(minCutoff = 1.3, beta = 0.04) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.x = null;
    this.dx = 0;
  }
  filter(v, dt) {
    if (this.x == null || !Number.isFinite(v)) {
      this.x = v;
      return v;
    }
    dt = Math.max(dt, 1e-3);
    const edx = (v - this.x) / dt;
    this.dx += (edx - this.dx) * alpha(dt, 1);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (v - this.x) * alpha(dt, cutoff);
    return this.x;
  }
  reset() {
    this.x = null;
    this.dx = 0;
  }
}

function alpha(dt, cutoff) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function wrapDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class HeadTracker {
  constructor() {
    this.video = null;
    this.landmarker = null;
    this.stream = null;
    this.calibrated = false;
    this.cal = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    this._raw = new THREE.Matrix4();
    this._world = new THREE.Matrix4();
    this._dummy = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._fx = new OneEuro(1.4, 0.05);
    this._fy = new OneEuro(1.4, 0.05);
    this._fz = new OneEuro(1.0, 0.03);
    this._fyaw = new OneEuro(1.6, 0.08);
    this._fpitch = new OneEuro(1.6, 0.08);
    this._froll = new OneEuro(1.6, 0.08);
    this.lastResult = null;
    this._yawS = 0;
    this._pitchS = 0;
    this._rollS = 0;
  }

  async start(video, deviceId) {
    this.video = video;
    const constraints = {
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = this.stream;
    await video.play();

    const vision = await FilesetResolver.forVisionTasks(WASM);
    const options = {
      runningMode: "VIDEO",
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: false,
    };
    try {
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
      });
    } catch {
      this.landmarker = await FaceLandmarker.createFromOptions(vision, {
        ...options,
        baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
      });
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.calibrated = false;
    this._resetFilters();
  }

  calibrate() {
    const pose = this._lastMetric;
    if (!pose) return false;
    this.cal = { ...pose };
    this.calibrated = true;
    this._resetFilters();
    return true;
  }

  update(now) {
    if (!this.landmarker || !this.video || this.video.readyState < 2) {
      return { tracking: false };
    }
    const result = this.landmarker.detectForVideo(this.video, now);
    this.lastResult = result;
    const lm = result.faceLandmarks?.[0];
    const mats = result.facialTransformationMatrixes;
    if (!lm) return { tracking: false };

    const metric = this._metricFromLandmarks(lm);
    const rot = this._rotationFromLandmarks(lm) || (mats?.length ? this._rotationFromMatrix(mats[0].data) : null) || {
      yaw: 0,
      pitch: 0,
      roll: 0,
    };
    const abs = { ...metric, ...rot };
    this._lastMetric = abs;

    const dt = this._dt(now);
    const rel = this.calibrated
      ? {
          x: abs.x - this.cal.x,
          y: abs.y - this.cal.y,
          z: abs.z - this.cal.z,
          yaw: wrapDelta(this.cal.yaw, abs.yaw),
          pitch: wrapDelta(this.cal.pitch, abs.pitch),
          roll: wrapDelta(this.cal.roll, abs.roll),
        }
      : { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };

    const x = this._fx.filter(rel.x, dt);
    const y = this._fy.filter(rel.y, dt);
    const z = this._fz.filter(rel.z, dt);
    this._yawS += wrapDelta(this._yawS, this._fyaw.filter(this._yawS + wrapDelta(this._yawS, rel.yaw), dt));
    this._pitchS += wrapDelta(this._pitchS, this._fpitch.filter(this._pitchS + wrapDelta(this._pitchS, rel.pitch), dt));
    this._rollS += wrapDelta(this._rollS, this._froll.filter(this._rollS + wrapDelta(this._rollS, rel.roll), dt));

    const yaw = this._yawS;
    const pitch = this._pitchS;
    const roll = this._rollS;
    const { forward, up } = basis(yaw, pitch, roll);

    return {
      tracking: true,
      calibrated: this.calibrated,
      x,
      y,
      z,
      yaw,
      pitch,
      roll,
      forward,
      up,
      distance: abs.z,
      landmarks: lm,
    };
  }

  _metricFromLandmarks(lm) {
    const w = this.video.videoWidth || 640;
    const h = this.video.videoHeight || 480;
    const fx = w / 2 / Math.tan(FOV_H / 2);
    const le = lm[LM_LIRIS] || lm[LM_LEYE];
    const re = lm[LM_RIRIS] || lm[LM_REYE];
    const nose = lm[LM_NOSE] || lm[0];
    const iod = Math.hypot((le.x - re.x) * w, (le.y - re.y) * h);
    const zCam = (fx * IOD_M) / Math.max(iod, 1);
    const xCam = ((nose.x * w - w / 2) / fx) * zCam;
    const yCam = ((nose.y * h - h / 2) / fx) * zCam;
    return {
      x: xCam,
      y: -yCam,
      z: zCam,
    };
  }

  // Image: x right, y down, unmirrored. Person facing camera:
  // their right eye (263) is on the LEFT of the frame. World +X = their right.
  // Landmark z is more negative when closer to the camera → world +Z is away from camera.
  _rotationFromLandmarks(lm) {
    const L = this._lmWorld(lm[LM_LEYE]);
    const R = this._lmWorld(lm[LM_REYE]);
    const N = this._lmWorld(lm[LM_NOSE]);
    if (!L || !R || !N) return null;
    const right = new THREE.Vector3().subVectors(R, L);
    if (right.lengthSq() < 1e-10) return null;
    right.normalize();
    const mid = new THREE.Vector3().addVectors(L, R).multiplyScalar(0.5);
    const forward = new THREE.Vector3().subVectors(N, mid);
    if (forward.lengthSq() < 1e-10) return null;
    forward.normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    forward.crossVectors(up, right).normalize();
    const m = new THREE.Matrix4().makeBasis(right, up, forward.clone().negate());
    const e = new THREE.Euler().setFromRotationMatrix(m, "YXZ");
    return { yaw: e.y, pitch: e.x, roll: e.z };
  }

  _lmWorld(p) {
    if (!p) return null;
    return new THREE.Vector3(p.x - 0.5, -(p.y - 0.5), p.z);
  }

  _rotationFromMatrix(data) {
    this._raw.fromArray(data);
    this._world.multiplyMatrices(CAM_TO_WORLD, this._raw);
    this._world.decompose(this._dummy, this._quat, this._scale);
    const e = new THREE.Euler().setFromQuaternion(this._quat, "YXZ");
    return { yaw: e.y, pitch: e.x, roll: e.z };
  }

  _resetFilters() {
    this._fx.reset();
    this._fy.reset();
    this._fz.reset();
    this._fyaw.reset();
    this._fpitch.reset();
    this._froll.reset();
    this._yawS = 0;
    this._pitchS = 0;
    this._rollS = 0;
  }

  _dt(now) {
    const dt = this._last ? Math.min(0.05, (now - this._last) / 1000) : 0.016;
    this._last = now;
    return dt;
  }
}

function basis(yaw, pitch, roll) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  return {
    forward: { x: -sy * cp, y: sp, z: -cy * cp },
    up: {
      x: cy * sr - sy * sp * cr,
      y: cp * cr,
      z: -sy * sr - cy * sp * cr,
    },
  };
}

export async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}
