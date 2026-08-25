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

    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  setViewMode(mode) {
    this.viewMode = mode === "mirror" ? "mirror" : "behind";
    this._placeCamera();
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
    // Object3D.lookAt は +Z を目標に向ける。鼻は +Z。
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
    this._placeCamera();
  }

  _placeCamera() {
    this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();
    if (this.viewMode === "mirror") {
      this.camera.position.set(0, 1.36, -1.7);
      this.camera.lookAt(0, 1.22, 0.15);
      this.camera.projectionMatrix.elements[0] *= -1;
    } else {
      this.camera.position.set(0, 1.42, 2.4);
      this.camera.lookAt(0, 1.22, -0.5);
    }
  }
}
