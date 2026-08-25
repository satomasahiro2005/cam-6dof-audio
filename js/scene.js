import * as THREE from "three";
import { DEFAULT_SOURCES } from "./audio-engine.js";

export class RoomView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0c0e10);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 40);
    this.viewMode = "behind";
    this.camera.up.set(0, 1, 0);
    this.orbit = {
      target: new THREE.Vector3(0, 1.22, 0),
      theta: 0,
      phi: 0.22,
      radius: 2.7,
    };
    this._drag = null;
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();

    this.scene.add(new THREE.AmbientLight(0x8899aa, 0.55));
    const key = new THREE.DirectionalLight(0xffe6b0, 0.7);
    key.position.set(3, 6, 4);
    this.scene.add(key);

    const grid = new THREE.GridHelper(8, 16, 0x3a3f46, 0x23272c);
    this.scene.add(grid);

    const room = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(8, 3.2, 8)),
      new THREE.LineBasicMaterial({ color: 0x3d444c })
    );
    room.position.y = 1.6;
    this.scene.add(room);

    this.listener = this._makeListener();
    this.scene.add(this.listener);

    this.markers = new Map();
    for (const spec of DEFAULT_SOURCES) {
      const m = this._makeSource(spec);
      this.markers.set(spec.id, m);
      this.scene.add(m);
    }

    this._bindOrbit();
    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  setViewMode(mode) {
    this.viewMode = mode === "mirror" ? "mirror" : "behind";
    this._resetOrbit();
    this._applyCamera();
  }

  setListenerPose(pose) {
    const x = pose.x;
    const y = pose.y + 1.2;
    const z = pose.z;
    this.listener.position.set(x, y, z);
    this.listener.up.set(pose.up.x, pose.up.y, pose.up.z);
    this.listener.lookAt(x + pose.forward.x, y + pose.forward.y, z + pose.forward.z);
  }

  setLayout(specs) {
    for (const m of this.markers.values()) this.scene.remove(m);
    this.markers.clear();
    for (const spec of specs) {
      const m = this._makeSource(spec);
      this.markers.set(spec.id, m);
      this.scene.add(m);
    }
  }

  render() {
    const gl = this.renderer.getContext();
    if (this.viewMode === "mirror") gl.frontFace(gl.CW);
    this.renderer.render(this.scene, this.camera);
    if (this.viewMode === "mirror") gl.frontFace(gl.CCW);
  }

  _resetOrbit() {
    if (this.viewMode === "mirror") {
      this.orbit.target.set(0, 1.22, 0.1);
      this.orbit.theta = Math.PI;
      this.orbit.phi = 0.18;
      this.orbit.radius = 1.85;
    } else {
      this.orbit.target.set(0, 1.22, -0.35);
      this.orbit.theta = 0;
      this.orbit.phi = 0.22;
      this.orbit.radius = 2.7;
    }
  }

  _applyCamera() {
    const { target, theta, phi, radius } = this.orbit;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    this.camera.position.set(
      target.x + radius * Math.sin(theta) * cp,
      target.y + radius * sp,
      target.z + radius * Math.cos(theta) * cp
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    this.camera.updateProjectionMatrix();
    if (this.viewMode === "mirror") this.camera.projectionMatrix.elements[0] *= -1;
  }

  _bindOrbit() {
    const el = this.canvas;
    el.style.touchAction = "none";
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      this._drag = {
        x: e.clientX,
        y: e.clientY,
        pan: e.button === 2 || e.button === 1 || e.shiftKey,
      };
      el.classList.add("drag");
    });
    el.addEventListener("pointermove", (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x;
      const dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX;
      this._drag.y = e.clientY;
      if (this._drag.pan) this._pan(dx, dy);
      else this._orbitBy(dx, dy);
      this._applyCamera();
    });
    const end = () => {
      this._drag = null;
      el.classList.remove("drag");
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const k = Math.exp(e.deltaY * 0.0012);
        this.orbit.radius = Math.max(0.6, Math.min(12, this.orbit.radius * k));
        this._applyCamera();
      },
      { passive: false }
    );
    el.addEventListener("dblclick", () => {
      this._resetOrbit();
      this._applyCamera();
    });
  }

  _orbitBy(dx, dy) {
    const sign = this.viewMode === "mirror" ? -1 : 1;
    this.orbit.theta -= sign * dx * 0.005;
    this.orbit.phi = Math.max(-1.15, Math.min(1.35, this.orbit.phi + dy * 0.005));
  }

  _pan(dx, dy) {
    this.camera.updateMatrixWorld();
    this._right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    this._up.setFromMatrixColumn(this.camera.matrixWorld, 1);
    const k = this.orbit.radius * 0.0018;
    this.orbit.target.addScaledVector(this._right, -dx * k);
    this.orbit.target.addScaledVector(this._up, dy * k);
  }

  _makeListener() {
    const g = new THREE.Group();
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.45 })
    );
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.05, 0.16, 8),
      new THREE.MeshStandardMaterial({ color: 0xffe08a })
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 0.14;
    const back = new THREE.Mesh(
      new THREE.SphereGeometry(0.122, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0x2c2926, roughness: 0.9 })
    );
    back.scale.set(1, 1, 0.42);
    back.position.z = -0.07;
    const axis = new THREE.AxesHelper(0.45);
    g.add(head, nose, back, axis);
    return g;
  }

  _makeSource(spec) {
    const g = new THREE.Group();
    g.position.set(spec.x, spec.y, spec.z);
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 14, 10),
      new THREE.MeshStandardMaterial({ color: spec.color, emissive: spec.color, emissiveIntensity: 0.35 })
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.16, 0.2, 20),
      new THREE.MeshBasicMaterial({ color: spec.color, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    g.add(ball, ring);
    return g;
  }

  _resize() {
    const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
    const h = this.canvas.clientHeight || this.canvas.parentElement.clientHeight || 480;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this._applyCamera();
  }
}
