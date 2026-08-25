# Cam 6DoF Audio

Webcam head tracking (6DoF) driving a binaural spatial audio engine in the browser.

## Requirements

- Chrome / Edge
- Headphones
- Webcam
- Local HTTP (the camera API does not work on `file://`)

```powershell
cd C:\Users\masahiro\workspace\cam-6dof-audio
python -m http.server 8765
```

Open `http://localhost:8765`.

## Usage

1. Put headphones on
2. Click **List** or **Start** and allow the microphone (device names stay hidden until then), then pick an input
3. **Start** → allow the camera → look forward and hit **Calibrate**
4. Turn your head (3DoF) or lean (6DoF)
5. Drop a file to play it

To route PC playback, pick VB-CABLE or VoiceMeeter as the input. Browsers have no loopback of their own. Echo cancellation is off, so headphones are the point.

The same pose can be driven from the keyboard (no camera needed).

| Key | Action |
| --- | --- |
| WASD | Move |
| R / F | Up / down |
| ← → | Yaw |
| ↑ ↓ | Pitch |
| Q / E | Roll |
| C | Calibrate |
| 0 / 3 / 6 | DoF mode |

Playback modes:

- **Demo** — five objects in the room
- **Stereo pair** — L/R stay L/R. At the calibrated origin the renderer is a dry pass-through; off-center it applies ITD/ILD from the virtual FL/FR speakers
- **Virtual multichannel** — STFT split of a stereo file or live input onto six objects

Speaker **layout** (Stereo ±30°, ITU 5.0, Quad, desktop, far, height, …) and **layout distance** can be switched from the UI. They move the objects the current mode is using.

The 3D view: drag to orbit, right-drag to pan, wheel to zoom, double-click to reset. Behind / mirror still snap the camera back to those presets.

## Stereo → virtual multichannel

In **virtual multichannel** mode, 2ch is split onto six sources in the room.

| Output | Content |
| --- | --- |
| C | In-phase content common to L and R |
| FL / FR | Left/right residual after center is removed |
| SL / SR | Side / out-of-phase |
| T | High-frequency side, above the head |

STFT center extraction first. If the worklet cannot load, it falls back to a mid/side filter graph. The test stereo is 440 Hz left, E5 right, 110 Hz common, out-of-phase noise.

## Pipeline

```
camera → MediaPipe Face Landmarker
      → pose relative to calibration
      → listener (ears ITD, or Resonance Audio 3rd-order Ambisonics + HRTF)

audio input / stereo file
      → stereo pair worklet  (identity = copy, else ITD/ILD)
      → or STFT upmix (C/FL/FR/SL/SR/T) → one object each
```

If Resonance Audio is missing, Web Audio `PannerNode` (HRTF) is the fallback. Room reverb is off unless you enable it.
