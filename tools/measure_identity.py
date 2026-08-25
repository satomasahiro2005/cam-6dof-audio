"""Legacy STFT transaural (H(pose)·inv(H0)) identity suite.

The live pair engine is now relative integer ITD/ILD in
js/stereo-6dof-processor.js; use tools/measure_worklet.mjs for that.
This file keeps the 2x2 model so speaker-phase / comb can be re-checked.
"""
from __future__ import annotations

import math
import numpy as np
from numpy.fft import rfft, irfft
from scipy.signal import chirp, fftconvolve

SR = 48000
N = 1024
HOP = 512
C = 343.0
HEAD_R = 0.0875
Y0 = 1.2
WIN = np.sqrt(0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / N))


def speaker(az_deg, r=2.2):
    az = math.radians(az_deg)
    return np.array([math.sin(az) * r, Y0, -math.cos(az) * r])


FL, FR = speaker(-30), speaker(30)


def ears(pos, forward, up, a=HEAD_R):
    right = np.cross(forward, up)
    right = right / (np.linalg.norm(right) or 1)
    return pos - right * a, pos + right * a


def hij(sp, ear):
    d = max(0.05, float(np.linalg.norm(sp - ear)))
    return 1.8 / d, d / C


def H_of(pos, forward, up, n_bins, n_fft):
    le, re = ears(pos, forward, up)
    paths = [hij(FL, le), hij(FR, le), hij(FL, re), hij(FR, re)]
    k = np.arange(n_bins)
    H = np.zeros((2, 2, n_bins), dtype=np.complex128)
    for (i, j), (g, tau) in zip(((0, 0), (0, 1), (1, 0), (1, 1)), paths):
        H[i, j] = g * np.exp(-2j * np.pi * k * (tau * SR) / n_fft)
    return H


def inv_2x2(H, eps=1e-12):
    a, b, c, d = H[0, 0], H[0, 1], H[1, 0], H[1, 1]
    det = a * d - b * c
    det = np.where(np.abs(det) < 1e-12, det + eps, det)
    inv = np.empty_like(H)
    inv[0, 0], inv[0, 1] = d / det, -b / det
    inv[1, 0], inv[1, 1] = -c / det, a / det
    return inv


def stft_js(x):
    if len(x) < N:
        x = np.pad(x, (0, N - len(x)))
    n_frames = 1 + (len(x) - N) // HOP
    idx = np.arange(N)[None, :] + np.arange(n_frames)[:, None] * HOP
    frames = np.zeros((n_frames, N), dtype=np.float64)
    valid = idx < len(x)
    frames[valid] = x[idx[valid]]
    return rfft(frames * WIN, axis=1).T


def istft_js(z):
    frames = irfft(z.T, n=N) * WIN
    n_frames = frames.shape[0]
    out = np.zeros((n_frames - 1) * HOP + N)
    for i in range(n_frames):
        s = i * HOP
        out[s : s + N] += frames[i]
    return out


def run(L, R, H_now, H0):
    inv0 = inv_2x2(H0)
    zL, zR = stft_js(L), stft_js(R)
    n_frames = min(zL.shape[1], zR.shape[1])
    zL, zR = zL[:, :n_frames], zR[:, :n_frames]
    xL = inv0[0, 0, :, None] * zL + inv0[0, 1, :, None] * zR
    xR = inv0[1, 0, :, None] * zL + inv0[1, 1, :, None] * zR
    yL = H_now[0, 0, :, None] * xL + H_now[0, 1, :, None] * xR
    yR = H_now[1, 0, :, None] * xL + H_now[1, 1, :, None] * xR
    oL, oR = istft_js(yL), istft_js(yR)
    n = min(len(L), len(oL), len(R), len(oR))
    return oL[:n], oR[:n]


def rms(x):
    return float(np.sqrt(np.mean(np.square(x)) + 1e-30))


def align(ref, est):
    n = min(len(ref), len(est))
    ref, est = ref[:n].copy(), est[:n].copy()
    a, b = N, n - N
    if b <= a + SR // 40:
        a, b = 0, n
    ref, est = ref[a:b], est[a:b]
    if rms(ref) < 1e-6:
        return ref, est, 0
    corr = fftconvolve(est, ref[::-1], mode="full")
    lag = int(np.argmax(np.abs(corr)) - (len(ref) - 1))
    if lag > 0:
        est, ref = est[lag:], ref[: len(est)]
    elif lag < 0:
        ref, est = ref[-lag:], est[: len(ref)]
    n = min(len(ref), len(est))
    return ref[:n], est[:n], lag


def snr_gain(ref, est):
    ref, est, _ = align(ref, est)
    g = float(np.dot(est, ref) / (np.dot(ref, ref) + 1e-20))
    err = est - g * ref
    snr = 10 * np.log10((np.mean((g * ref) ** 2) + 1e-20) / (np.mean(err**2) + 1e-20))
    return snr, g


def isolation_db(active, leak):
    n = min(len(active), len(leak))
    a, b = N, n - N
    if b <= a + SR // 40:
        a, b = 0, n
    return 20 * np.log10((rms(leak[a:b]) + 1e-12) / (rms(active[a:b]) + 1e-12))


def log_sweep(sec=1.0, f0=20.0, f1=20000.0):
    n = int(SR * sec)
    t = np.arange(n) / SR
    return chirp(t, f0=f0, f1=f1, t1=sec, method="logarithmic").astype(np.float64)


def inv_filter(sweep, sec, f0, f1):
    t = np.arange(len(sweep)) / SR
    env = np.exp(-np.log(f1 / f0) * t / sec)
    inv = sweep[::-1] * env
    spec = rfft(np.concatenate([sweep, np.zeros(len(sweep))]))
    ispec = rfft(np.concatenate([inv, np.zeros(len(inv))]))
    peak = np.max(np.abs(irfft(spec * ispec)))
    return inv / (peak + 1e-20)


def deconv_ir(sig, inv, peak_hint=None):
    ir = fftconvolve(sig, inv, mode="full")
    lo = len(sig) - 64
    hi = lo + 4096
    lo = max(0, lo)
    hi = min(len(ir), hi)
    region = ir[lo:hi]
    rel = int(np.argmax(np.abs(region)))
    peak = lo + rel
    n_ir = 2048
    start = max(0, peak - 64)
    seg = np.zeros(n_ir)
    take = min(n_ir, len(ir) - start)
    seg[:take] = ir[start : start + take]
    return ir, peak, seg


def fr_db(seg, freqs):
    w = np.hanning(len(seg))
    spec = rfft(seg * w)
    mag = np.abs(spec) + 1e-20
    bins = freqs * len(seg) / SR
    out = []
    for b in bins:
        i = int(round(b))
        if 0 <= i < len(mag):
            out.append(20 * np.log10(mag[i]))
        else:
            out.append(float("nan"))
    return np.array(out)


def probes():
    t = np.arange(int(SR * 0.6)) / SR
    sweep = log_sweep(0.8)
    z = np.zeros_like(sweep)
    z_t = np.zeros_like(t)
    noise = np.random.randn(len(t))
    pink = np.cumsum(np.random.randn(len(t)))
    pink /= np.max(np.abs(pink)) + 1e-12
    speech = (
        0.4 * np.sin(2 * np.pi * 180 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 4 * t))
        + 0.2 * np.sin(2 * np.pi * 900 * t)
        + 0.08 * np.sin(2 * np.pi * 2400 * t)
    )
    impulse = np.zeros(SR // 4)
    impulse[SR // 16] = 1.0
    return {
        "log-sweep L": (sweep, z),
        "log-sweep R": (z, sweep),
        "log-sweep dual": (sweep, sweep),
        "log-sweep L/R out of phase": (sweep, -sweep),
        "1kHz L": (np.sin(2 * np.pi * 1000 * t), z_t),
        "1kHz stereo": (np.sin(2 * np.pi * 1000 * t), np.sin(2 * np.pi * 1000 * t)),
        "two-tone 440+5k": (
            0.5 * np.sin(2 * np.pi * 440 * t) + 0.5 * np.sin(2 * np.pi * 5000 * t),
            0.5 * np.sin(2 * np.pi * 440 * t) + 0.5 * np.sin(2 * np.pi * 5000 * t),
        ),
        "white uncorrelated": (noise, np.random.randn(len(t))),
        "pink stereo": (pink, pink),
        "speech-like": (speech, 0.7 * speech + 0.1 * np.random.randn(len(t))),
        "impulse L": (impulse, np.zeros_like(impulse)),
        "impulse stereo": (impulse, impulse),
    }


def score_pair(name, L, R, oL, oR):
    aL, aR = rms(L) > 1e-4, rms(R) > 1e-4
    snrs, gains, isol = [], [], []
    if aL:
        s, g = snr_gain(L, oL)
        snrs.append(s)
        gains.append(g)
    else:
        isol.append(isolation_db(R, oL))
    if aR:
        s, g = snr_gain(R, oR)
        snrs.append(s)
        gains.append(g)
    else:
        isol.append(isolation_db(L, oR))
    return {
        "name": name,
        "snr": float(np.mean(snrs)) if snrs else float("nan"),
        "snr_min": float(np.min(snrs)) if snrs else float("nan"),
        "gain": float(np.mean(gains)) if gains else 0.0,
        "isol": float(np.max(isol)) if isol else float("nan"),
        "snrs": snrs,
        "gains": gains,
        "active": (aL, aR),
    }


def main():
    np.random.seed(2)
    pos0 = np.array([0.0, Y0, 0.0])
    fwd0 = np.array([0.0, 0.0, -1.0])
    up0 = np.array([0.0, 1.0, 0.0])
    n_bins = N // 2 + 1
    H0 = H_of(pos0, fwd0, up0, n_bins, N)
    H1 = H_of(pos0 + np.array([0.12, 0.0, 0.0]), fwd0, up0, n_bins, N)

    print("Farina log-sweep  H(0)·H0⁻¹  (worklet-matched STFT)\n")

    sec, f0, f1 = 1.0, 20.0, 20000.0
    sweep = log_sweep(sec, f0, f1)
    z = np.zeros_like(sweep)
    inv = inv_filter(sweep, sec, f0, f1)
    freqs = np.array([100, 250, 500, 1000, 2000, 4000, 8000, 12000], dtype=float)

    for title, L, R, want_xtalk in (
        ("L-only", sweep, z, True),
        ("R-only", z, sweep, True),
        ("dual", sweep, sweep, False),
        ("out-of-phase", sweep, -sweep, False),
    ):
        oL, oR = run(L, R, H0, H0)
        sc = score_pair(title, L, R, oL, oR)
        active_out = oL if rms(L) > rms(R) else oR
        _, _, seg = deconv_ir(active_out, inv)
        _, _, seg_in = deconv_ir(sweep, inv)
        fr = fr_db(seg, freqs) - fr_db(seg_in, freqs)
        band = fr[:7]  # up to 8 kHz
        xt = ""
        if want_xtalk:
            leak = oR if rms(L) > rms(R) else oL
            xt = f"  isol {sc['isol']:6.1f} dB"
        print(
            f"  sweep {title:13s}  SNR {sc['snr']:6.1f} dB  gain {sc['gain']:.3f}"
            f"{xt}  FR 100-8k {np.nanmean(band):+.2f}±{np.nanstd(band):.2f} dB"
        )
        pts = " ".join(f"{f/1000:g}k={v:+.2f}" for f, v in zip(freqs, fr))
        print(f"           FR {pts}")

    print("\nProbe suite (identity)\n")
    rows = []
    isols = []
    for name, (L, R) in probes().items():
        oL, oR = run(L, R, H0, H0)
        sc = score_pair(name, L, R, oL, oR)
        rows.append(sc)
        isol_s = f"  isol {sc['isol']:6.1f} dB" if not math.isnan(sc["isol"]) else ""
        print(f"  {name:28s}  SNR {sc['snr']:6.1f} dB  gain {sc['gain']:.3f}{isol_s}")
        if not math.isnan(sc["isol"]):
            isols.append(sc["isol"])

    active_snrs = [r["snr"] for r in rows if not math.isnan(r["snr"])]
    print(
        f"\n  active SNR min {min(active_snrs):.1f}  median {np.median(active_snrs):.1f}"
        f"  mean {np.mean(active_snrs):.1f} dB"
    )
    if isols:
        print(f"  isolation (silent ch) max {max(isols):.1f} dB  (want <= -40)")

    L, R = probes()["log-sweep dual"]
    oL, oR = run(L, R, H1, H0)
    mL, _ = snr_gain(L, oL)
    mR, _ = snr_gain(R, oR)
    moved = 0.5 * (mL + mR)
    print(f"\nMoved +0.12 m X, log-sweep dual: L {mL:.1f}  R {mR:.1f} dB  (must be << identity)")

    ok = min(active_snrs) >= 40 and moved < 20 and (not isols or max(isols) <= -40)
    print("\nPASS" if ok else "\nFAIL", "(identity active SNR >= 40, isolation <= -40, moved lower)")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
