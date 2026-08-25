"""Diagnose remaining quality loss: speaker-phase / comb / STFT delay / jitter."""
from __future__ import annotations

import math
import numpy as np
from numpy.fft import rfft, irfft

from measure_identity import (
    C,
    FL,
    FR,
    HOP,
    N,
    SR,
    Y0,
    H_of,
    ears,
    hij,
    inv_2x2,
    istft_js,
    log_sweep,
    rms,
    run,
    snr_gain,
    stft_js,
)

HEAD_R = 0.0875
pos0 = np.array([0.0, Y0, 0.0])
fwd0 = np.array([0.0, 0.0, -1.0])
up0 = np.array([0.0, 1.0, 0.0])
n_bins = N // 2 + 1
freqs = np.arange(n_bins) * SR / N


def paths(pos, forward, up):
    le, re = ears(pos, forward, up)
    return [hij(FL, le), hij(FR, le), hij(FL, re), hij(FR, re)]


def H_rel(pos, forward, up, tau0, n_fft=N):
    ps = paths(pos, forward, up)
    k = np.arange(n_fft // 2 + 1)
    H = np.zeros((2, 2, n_fft // 2 + 1), dtype=np.complex128)
    for (i, j), (g, tau) in zip(((0, 0), (0, 1), (1, 0), (1, 1)), ps):
        H[i, j] = g * np.exp(-2j * np.pi * k * ((tau - tau0) * SR) / n_fft)
    return H


def frac_delay(x, samples, nfft=None):
    nfft = nfft or (1 << int(np.ceil(np.log2(len(x) * 2))))
    X = rfft(x, n=nfft)
    k = np.arange(X.shape[0])
    y = irfft(X * np.exp(-2j * np.pi * k * samples / nfft), n=nfft)
    return y[: len(x)]


def mix_td(L, R, pos, forward, up):
    ps = paths(pos, forward, up)
    (gLL, tLL), (gLR, tLR), (gRL, tRL), (gRR, tRR) = ps
    yL = gLL * frac_delay(L, tLL * SR) + gLR * frac_delay(R, tLR * SR)
    yR = gRL * frac_delay(L, tRL * SR) + gRR * frac_delay(R, tRR * SR)
    return yL, yR


def pose(dx=0, dy=0, dz=0, yaw=0, pitch=0, roll=0):
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    cr, sr = math.cos(roll), math.sin(roll)
    fwd = np.array([sy * cp, -sp, -cy * cp])
    up = np.array(
        [
            sy * sp * cr + cy * sr,
            cp * cr,
            -cy * sp * cr + sy * sr,
        ]
    )
    return pos0 + np.array([dx, dy, dz]), fwd, up


def cond_vs_freq(H):
    cond = []
    invg = []
    for k in range(H.shape[2]):
        M = H[:, :, k]
        s = np.linalg.svd(M, compute_uv=False)
        cond.append(s[0] / max(s[-1], 1e-20))
        inv = np.linalg.pinv(M)
        invg.append(np.linalg.norm(inv, 2))
    return np.array(cond), np.array(invg)


def comb_nulls(delta_s):
    # first intensity-dip freqs for two arrivals
    if abs(delta_s) < 1e-9:
        return []
    f0 = 0.5 / abs(delta_s)
    return [f0 * (2 * n + 1) for n in range(8) if f0 * (2 * n + 1) < 20000]


def welch_db(ref, est, nperseg=2048):
    n = min(len(ref), len(est))
    ref, est = ref[:n], est[:n]
    nperseg = min(nperseg, n // 4 * 2)
    win = np.hanning(nperseg)
    hop = nperseg // 2
    acc_h = 0
    acc_x = 0
    nfr = 0
    for i in range(0, n - nperseg, hop):
        X = rfft(ref[i : i + nperseg] * win)
        Y = rfft(est[i : i + nperseg] * win)
        acc_h += Y * np.conj(X)
        acc_x += X * np.conj(X)
        nfr += 1
    H = acc_h / (acc_x + 1e-20)
    f = np.arange(len(H)) * SR / nperseg
    return f, 20 * np.log10(np.abs(H) + 1e-20), np.angle(H)


def notch_depth(f, mag, target):
    i = int(np.argmin(np.abs(f - target)))
    lo = max(0, i - 4)
    hi = min(len(mag), i + 5)
    return float(np.min(mag[lo:hi]))


def main():
    H0 = H_of(pos0, fwd0, up0, n_bins, N)
    ps0 = paths(pos0, fwd0, up0)
    names = ["FL→L", "FR→L", "FL→R", "FR→R"]
    print("Identity path delays (speaker phase / comb source)\n")
    for n, (g, tau) in zip(names, ps0):
        print(f"  {n:8s}  {tau * 1000:6.3f} ms  {tau * SR:7.2f} smp  gain {g:.3f}")
    tLL, tLR = ps0[0][1], ps0[1][1]
    tRL, tRR = ps0[2][1], ps0[3][1]
    print(f"\n  left-ear  FR-FL  Δ {abs(tLR - tLL) * 1e6:6.1f} µs  comb ~ {0.5 / abs(tLR - tLL):.0f} Hz")
    print(f"  right-ear FL-FR  Δ {abs(tRL - tRR) * 1e6:6.1f} µs  comb ~ {0.5 / abs(tRL - tRR):.0f} Hz")
    print(f"  ITD (R-L, FL)    { (tRL - tLL) * 1e6:6.1f} µs")
    print(f"  bulk delay       {min(t * SR for _, t in ps0):.1f} smp  (FFT N={N})")
    print(f"  wrap fraction    {min(t * SR for _, t in ps0) / N:.2f} of FFT")

    cond, invg = cond_vs_freq(H0)
    print(f"\n  cond(H0)  min {cond.min():.2f}  med {np.median(cond):.2f}  max {cond.max():.2f}")
    print(f"  |inv(H0)| min {invg.min():.2f}  med {np.median(invg):.2f}  max {invg.max():.2f}")
    for hz in (500, 1000, 2000, 4000, 8000, 12000):
        i = int(round(hz * N / SR))
        if i < len(cond):
            print(f"    {hz:5d} Hz  cond {cond[i]:6.2f}  |inv| {invg[i]:6.2f}")

    sweep = log_sweep(0.8)
    z = np.zeros_like(sweep)

    print("\nUncompensated two-speaker mix (no inv H0) vs dry stereo")
    # apply H0 only
    zL, zR = stft_js(sweep), stft_js(sweep)
    nfr = min(zL.shape[1], zR.shape[1])
    yL = H0[0, 0, :, None] * zL[:, :nfr] + H0[0, 1, :, None] * zR[:, :nfr]
    yR = H0[1, 0, :, None] * zL[:, :nfr] + H0[1, 1, :, None] * zR[:, :nfr]
    oL, oR = istft_js(yL), istft_js(yR)
    s, g = snr_gain(sweep, oL)
    print(f"  dual sweep through H0 only: SNR {s:.1f} dB  gain {g:.3f}  (combing if low)")
    f, mag, ang = welch_db(sweep, oL)
    for hz in comb_nulls(tLR - tLL)[:4]:
        print(f"    comb {hz:6.0f} Hz  mag {notch_depth(f, mag, hz):+6.2f} dB")

    print("\nSTFT circular delay vs true linear-delay mix (same H)")
    tdL, tdR = mix_td(sweep, sweep, pos0, fwd0, up0)
    s_stft, _ = snr_gain(tdL, oL)
    print(f"  identity H0: STFT vs time-domain mix  SNR {s_stft:.1f} dB")

    pos1, f1, u1 = pose(dx=0.12)
    H1 = H_of(pos1, f1, u1, n_bins, N)
    stL, stR = run(sweep, sweep, H1, H0)
    td1L, td1R = mix_td(sweep, sweep, pos1, f1, u1)
    td0L, td0R = mix_td(sweep, sweep, pos0, fwd0, up0)
    # transaural TD: mix(now) * inv_mix(0) is not easy in TD; compare STFT moved vs TD moved * TD0^{-1} approx
    # here: does STFT H(now) match TD mix(now)?
    zL, zR = stft_js(sweep), stft_js(sweep)
    nfr = min(zL.shape[1], zR.shape[1])
    yL = H1[0, 0, :, None] * zL[:, :nfr] + H1[0, 1, :, None] * zR[:, :nfr]
    yR = H1[1, 0, :, None] * zL[:, :nfr] + H1[1, 1, :, None] * zR[:, :nfr]
    s1, _ = snr_gain(td1L, istft_js(yL))
    print(f"  +0.12 m X  H(now) STFT vs TD mix     SNR {s1:.1f} dB")

    tau0 = min(t for _, t in ps0)
    H0r = H_rel(pos0, fwd0, up0, tau0)
    H1r = H_rel(pos1, f1, u1, tau0)
    st_rel_L, _ = run(sweep, sweep, H1r, H0r)
    yL = H1r[0, 0, :, None] * zL[:, :nfr] + H1r[0, 1, :, None] * zR[:, :nfr]
    s1r, _ = snr_gain(td1L, istft_js(yL))
    # relative mix vs TD still differs by bulk e^{-jω τ0}; delay-align snr_gain handles it
    print(f"  +0.12 m X  relative-delay STFT vs TD  SNR {s1r:.1f} dB")

    ident_rel, _ = run(sweep, sweep, H0r, H0r)
    si, gi = snr_gain(sweep, ident_rel)
    print(f"  identity with bulk delay stripped:    SNR {si:.1f} dB  gain {gi:.3f}")

    print("\nTracker-like pose error around identity (H(now)·inv(H0), dual sweep)")
    print("  (scale slider default 2x multiplies camera millimetres)")
    errs = [
        ("0.5 mm X", pose(dx=0.0005)),
        ("2 mm X", pose(dx=0.002)),
        ("5 mm X", pose(dx=0.005)),
        ("10 mm X", pose(dx=0.010)),
        ("20 mm X (scale=2 on 1cm)", pose(dx=0.020)),
        ("0.2° yaw", pose(yaw=math.radians(0.2))),
        ("1° yaw", pose(yaw=math.radians(1))),
        ("3° yaw", pose(yaw=math.radians(3))),
        ("1° pitch", pose(pitch=math.radians(1))),
        ("1° roll", pose(roll=math.radians(1))),
        ("5mm+1° yaw", pose(dx=0.005, yaw=math.radians(1))),
    ]
    for name, (p, fw, up) in errs:
        H = H_of(p, fw, up, n_bins, N)
        oL, oR = run(sweep, sweep, H, H0)
        sL, gL = snr_gain(sweep, oL)
        sR, gR = snr_gain(sweep, oR)
        f, mag, _ = welch_db(sweep, oL)
        worst = min(notch_depth(f, mag, hz) for hz in (1000, 2000, 4000, 8000))
        print(
            f"  {name:26s}  SNR L {sL:6.1f}  R {sR:6.1f}  gain {gL:.3f}  worst 1-8k {worst:+5.2f} dB"
        )

    print("\nSame errors with bulk delay stripped")
    for name, (p, fw, up) in errs[:6]:
        H = H_rel(p, fw, up, tau0)
        oL, oR = run(sweep, sweep, H, H0r)
        sL, _ = snr_gain(sweep, oL)
        sR, _ = snr_gain(sweep, oR)
        print(f"  {name:26s}  SNR L {sL:6.1f}  R {sR:6.1f}")

    print("\nHop-to-hop jitter (σ=3 mm, 0.4°, 30 Hz)  — still-head tracking noise")
    rng = np.random.default_rng(0)
    zL, zR = stft_js(sweep), stft_js(sweep)
    nfr = min(zL.shape[1], zR.shape[1])
    inv0 = inv_2x2(H0)
    uL = inv0[0, 0, :, None] * zL[:, :nfr] + inv0[0, 1, :, None] * zR[:, :nfr]
    uR = inv0[1, 0, :, None] * zL[:, :nfr] + inv0[1, 1, :, None] * zR[:, :nfr]
    yL = np.empty_like(uL)
    yR = np.empty_like(uR)
    hops_per_s = SR / HOP
    for i in range(nfr):
        # new pose ~ every 2 hops at 48k hop 512 → 93 Hz; downsample to 30 Hz
        if i % max(1, int(hops_per_s / 30)) == 0:
            p, fw, up = pose(
                dx=rng.normal(0, 0.003),
                dy=rng.normal(0, 0.002),
                dz=rng.normal(0, 0.004),
                yaw=rng.normal(0, math.radians(0.4)),
                pitch=rng.normal(0, math.radians(0.3)),
                roll=rng.normal(0, math.radians(0.3)),
            )
            Hj = H_of(p, fw, up, n_bins, N)
        yL[:, i] = Hj[0, 0] * uL[:, i] + Hj[0, 1] * uR[:, i]
        yR[:, i] = Hj[1, 0] * uL[:, i] + Hj[1, 1] * uR[:, i]
    oL, oR = istft_js(yL), istft_js(yR)
    sL, gL = snr_gain(sweep, oL)
    sR, gR = snr_gain(sweep, oR)
    print(f"  jittered identity  SNR L {sL:.1f}  R {sR:.1f}  gain {gL:.3f}/{gR:.3f}")

    print("\nILD of geometric model (should be ~0 dB if only 1/r, no head shadow)")
    for hz in (200, 1000, 4000, 8000, 12000):
        i = int(round(hz * N / SR))
        ild_fl = 20 * np.log10((np.abs(H0[1, 0, i]) + 1e-20) / (np.abs(H0[0, 0, i]) + 1e-20))
        print(f"  {hz:5d} Hz  FL ILD {ild_fl:+5.2f} dB  (real HRTF at 8 kHz is ~10 dB)")

    print("\nUpmix STFT reconstruction (hann N=2048 hop=512 ×0.5, no spatial)")
    # mimic upmix window/overlap
    n_u, hop_u = 2048, 512
    win = 0.5 * (1 - np.cos(2 * np.pi * np.arange(n_u) / n_u))
    x = sweep
    n_frames = 1 + (len(x) - n_u) // hop_u
    idx = np.arange(n_u)[None, :] + np.arange(n_frames)[:, None] * hop_u
    frames = np.zeros((n_frames, n_u))
    valid = idx < len(x)
    frames[valid] = x[idx[valid]]
    spec = rfft(frames * win, axis=1)
    rec = irfft(spec, n=n_u) * win * 0.5
    out = np.zeros((n_frames - 1) * hop_u + n_u)
    for i in range(n_frames):
        out[i * hop_u : i * hop_u + n_u] += rec[i]
    su, gu = snr_gain(x, out)
    print(f"  dry roundtrip SNR {su:.1f} dB  gain {gu:.3f}")

    print("\nDead-path check: ear LPF created but not connected (pair bypasses ears).")
    print("Pair path: source → stereo-6dof worklet → master. No DelayNode, no biquad.")


if __name__ == "__main__":
    main()
