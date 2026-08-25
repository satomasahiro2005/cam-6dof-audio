export function azEl(azDeg, elDeg, r, y0 = 1.2) {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return {
    x: Math.sin(az) * Math.cos(el) * r,
    y: y0 + Math.sin(el) * r,
    z: -Math.cos(az) * Math.cos(el) * r,
  };
}

function s(az, el = 0, r = 1) {
  return { az, el, r };
}

export const LAYOUTS = [
  {
    id: "stereo30",
    name: "Stereo ±30°",
    pair: { fl: s(-30), fr: s(30) },
    upmix: { FL: s(-30), FR: s(30), C: s(0), SL: s(-110), SR: s(110), T: s(0, 50, 0.9) },
    demo: { front: s(0), left: s(-90), right: s(90), rear: s(180), up: s(15, 55, 0.9) },
  },
  {
    id: "stereo15",
    name: "狭め ±15°",
    pair: { fl: s(-15), fr: s(15) },
    upmix: { FL: s(-15), FR: s(15), C: s(0), SL: s(-100), SR: s(100), T: s(0, 45, 0.85) },
    demo: { front: s(0), left: s(-70), right: s(70), rear: s(180), up: s(0, 50, 0.85) },
  },
  {
    id: "stereo45",
    name: "広め ±45°",
    pair: { fl: s(-45), fr: s(45) },
    upmix: { FL: s(-45), FR: s(45), C: s(0), SL: s(-125), SR: s(125), T: s(0, 50, 0.9) },
    demo: { front: s(0), left: s(-90), right: s(90), rear: s(180), up: s(20, 55, 0.9) },
  },
  {
    id: "stereo90",
    name: "真横 ±90°",
    pair: { fl: s(-90), fr: s(90) },
    upmix: { FL: s(-90), FR: s(90), C: s(0), SL: s(-140), SR: s(140), T: s(0, 55, 0.85) },
    demo: { front: s(0), left: s(-90), right: s(90), rear: s(180), up: s(0, 60, 0.85) },
  },
  {
    id: "itu50",
    name: "ITU 5.0",
    pair: { fl: s(-30), fr: s(30) },
    upmix: { FL: s(-30), FR: s(30), C: s(0), SL: s(-110), SR: s(110), T: s(0, 40, 0.95) },
    demo: { front: s(0), left: s(-30), right: s(30), rear: s(180), up: s(0, 50, 0.9) },
  },
  {
    id: "quad",
    name: "Quad",
    pair: { fl: s(-45), fr: s(45) },
    upmix: { FL: s(-45), FR: s(45), C: s(0, 0, 0.85), SL: s(-135), SR: s(135), T: s(180, 40, 0.8) },
    demo: { front: s(-45), left: s(-135), right: s(45), rear: s(135), up: s(0, 55, 0.85) },
  },
  {
    id: "desktop",
    name: "デスクトップ",
    pair: { fl: s(-22, -8, 0.55), fr: s(22, -8, 0.55) },
    upmix: {
      FL: s(-22, -8, 0.55),
      FR: s(22, -8, 0.55),
      C: s(0, -6, 0.5),
      SL: s(-110, 10, 0.7),
      SR: s(110, 10, 0.7),
      T: s(0, 50, 0.45),
    },
    demo: { front: s(0, -6, 0.5), left: s(-70, 0, 0.7), right: s(70, 0, 0.7), rear: s(180, 5, 0.8), up: s(0, 50, 0.45) },
  },
  {
    id: "far",
    name: "遠め",
    pair: { fl: s(-30, 0, 1.5), fr: s(30, 0, 1.5) },
    upmix: { FL: s(-30, 0, 1.5), FR: s(30, 0, 1.5), C: s(0, 0, 1.5), SL: s(-110, 0, 1.5), SR: s(110, 0, 1.5), T: s(0, 40, 1.2) },
    demo: { front: s(0, 0, 1.5), left: s(-90, 0, 1.5), right: s(90, 0, 1.5), rear: s(180, 0, 1.5), up: s(0, 45, 1.2) },
  },
  {
    id: "height",
    name: "ハイト重視",
    pair: { fl: s(-25, 18), fr: s(25, 18) },
    upmix: { FL: s(-30, 8), FR: s(30, 8), C: s(0, 5), SL: s(-110, 12), SR: s(110, 12), T: s(0, 65, 0.85) },
    demo: { front: s(0, 10), left: s(-80, 15), right: s(80, 15), rear: s(180, 10), up: s(0, 70, 0.8) },
  },
  {
    id: "rear",
    name: "後方寄り",
    pair: { fl: s(-40, 0, 1), fr: s(40, 0, 1) },
    upmix: { FL: s(-25), FR: s(25), C: s(0), SL: s(-150), SR: s(150), T: s(180, 45, 0.9) },
    demo: { front: s(0, 0, 0.85), left: s(-120), right: s(120), rear: s(180), up: s(180, 50, 0.85) },
  },
];

export function getLayout(id) {
  return LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];
}

export function resolvePos(def, radius) {
  return azEl(def.az, def.el, def.r * radius);
}
