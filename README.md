# Cam 6DoF Audio

Proof of concept. Webcam head tracking (6DoF) driving a binaural spatial audio engine in the browser.

The intended use is **system audio in via a virtual cable** (VB-CABLE, VoiceMeeter, etc.). Pick that device as the audio input and listen on headphones. Browsers have no loopback of their own. Dropping a file or running the demo objects is for trying the renderer, not the main path.

## Requirements

- Chrome / Edge
- Headphones
- Webcam
- A virtual audio cable, if you want to feed PC playback
- HTTPS or localhost (the camera/mic APIs do not work on `file://`)

Live: https://satomasahiro2005.github.io/cam-6dof-audio/

Or locally:

```powershell
cd C:\Users\masahiro\workspace\cam-6dof-audio
python -m http.server 8765
```

Open `http://localhost:8765`.

## Usage

1. Route the PC’s output into a virtual cable (set that as the Windows default playback device, or send only the apps you want)
2. Put headphones on (echo cancellation is off)
3. Click **List** or **Start** and allow the microphone (device names stay hidden until then), then pick the virtual cable as the input
4. **Start** → allow the camera → look forward and hit **Calibrate**
5. Turn your head (3DoF) or lean (6DoF)

You can also drop a file onto the page to play it, without a virtual cable. That is secondary.

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
