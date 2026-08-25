# Cam 6DoF Audio

Webカメラで頭部の位置と向き（6DoF）を取り、空間オーディオエンジンでバイノーラル再生する。

既存の近いものは [Cat3DA](https://git.iem.at/lukas_goelles/cat3da)（Ambisonics 専用プレーヤー）。こちらはオブジェクトベースの音源を Resonance Audio で置き、カメラ姿勢をリスナーに直結する。

## 必要なもの

- Chrome / Edge
- ヘッドホン
- Webカメラ
- ローカル HTTP（カメラ API は `file://` では動かない）

```powershell
cd C:\Users\masahiro\workspace\cam-6dof-audio
python -m http.server 8765
```

ブラウザで `http://localhost:8765` を開く。

## 使い方

1. ヘッドホンをつける
2. **一覧** か **開始** でマイクを許可する（許可前は名前が出ない）。そのあと入力デバイスを選ぶ
3. **開始** → カメラ許可 → 正面を見て **キャリブレーション**
4. 頭を回す（3DoF）／前後左右に傾ける（6DoF）
5. ファイルをドロップしても再生できる

PCの再生音を回したいときは VB-CABLE や VoiceMeeter を入力に選ぶ。ブラウザはループバックを直接は出さない。エコーキャンセルは切ってあるので、ヘッドホン推奨。

キーボードでも同じポーズを動かせる（カメラなしの確認用）。

| キー | 操作 |
| --- | --- |
| WASD | 前後左右 |
| R / F | 上下 |
| ← → | Yaw |
| ↑ ↓ | Pitch |
| Q / E | Roll |
| C | キャリブレーション |
| 0 / 3 / 6 | DoF モード |

## ステレオ → 仮想マルチチャンネル

再生モードを **ステレオ → 仮想マルチ** にすると、2ch を次の6本に分けて部屋に置く。

| 出力 | 中身 |
| --- | --- |
| C | 同相で左右に共通な成分（ボーカル／バスなど） |
| FL / FR | センターを引いた左右固有 |
| SL / SR | サイド／逆相。遅延を少しずらしてアンビエンス |
| T | サイドの高域。頭の上 |

STFT のセンター抽出が先。Worklet が使えないときは Mid/Side のフィルタグラフに落とす。テストステレオは左 440Hz、右 E5、共通 110Hz、逆相ノイズ。

## 構成

```
カメラ → MediaPipe Face Landmarker（4x4 姿勢）
      → キャリブレーション相対 6DoF
      → Resonance Audio（Ambisonic 3次 + 部屋反射）
      → ヘッドホン

音声入力 / ステレオファイル → STFT 分離（C/FL/FR/SL/SR/T）→ 各オブジェクト
```

Resonance Audio が読めない場合は Web Audio `PannerNode`（HRTF）に落とす。
