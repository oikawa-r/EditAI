# 06. ステップ5：テロップの焼き込み（書き出し）

ユーザーが確定した文リストとスタイルから ASS 字幕ファイル（`.ass`）を作り、FFmpeg で無音カット後の動画（`cut.mp4`）に焼き込んで（ハードサブ）、完成動画を書き出す。

担当ファイル：`backend/core/sub_exporter.py`（クラス `SubExporter`）

---

## 1. 入力と出力

### 入力

`POST /projects/{id}/exports` のリクエスト（`01_api_schema.md` の 4.7）と同じ内容を受け取る。

| 項目 | 内容 |
|---|---|
| 動画 | `temp/{project_id}/cut.mp4` |
| `segments` | 確定した文リスト（`id`、`start`、`end`、`visible`、`selected_variant`、`text`） |
| `style` | `SubtitleStyle`（省略した項目は既定値） |
| `output` | 保存先・コーデックなど（すべて省略可） |

入力は Pydantic のモデル（`ExportSegment`、`SubtitleStyle`、`OutputOptions`）で検証する。API サーバーも同じモデルを使う。

### 検証（違反したら `VALIDATION_ERROR`）

- `start < end`
- `visible: true` の文は `text` が空でない
- `segments` 内で `id` が重複しない
- 色は `#RRGGBB`、数値は `01_api_schema.md` の 3.2 の範囲内

### 出力

| ファイル | 内容 |
|---|---|
| `temp/{project_id}/exports/{export_id}.ass` | 生成した字幕ファイル（確認用に残す） |
| 完成動画 | `output.path`。省略時は `temp/{project_id}/exports/{export_id}.mp4` |

---

## 2. 処理の手順

1. 入力を検証する
2. ffprobe で `cut.mp4` の幅・高さ・長さを取得する
3. 保存先に同じ名前のファイルがあり、`overwrite` が `false` なら `OUTPUT_EXISTS`
4. `.ass` を作る（進捗 0 → 5、状態 `generating_ass`）
5. FFmpeg で焼き込む（進捗 5 → 100、状態 `encoding`）。`保存先名.partial.mp4` に書き、成功したら本来の名前に変える

---

## 3. ASS ファイルの作り方

### 3.1 `[Script Info]`

```
[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None
```

| 項目 | 理由 |
|---|---|
| `PlayResX` / `PlayResY` | 動画の幅・高さにそろえる。これで `font_size` などの px が動画のピクセル数と一致する |
| `ScaledBorderAndShadow: yes` | 縁取りと影の太さも `PlayRes` 基準で拡大・縮小する |
| `YCbCr Matrix: None` | 色を変換させない。指定がないと、古い規格（BT.601）とみなされて色が少しずれることがある |

### 3.2 `[V4+ Styles]`（`SubtitleStyle` からの変換）

スタイルは `Default` の1つだけを作る。

| ASS の項目 | 通常（`background_enabled: false`） | 背景ボックスあり（`true`） |
|---|---|---|
| `Fontname` | `font_family` | 同左 |
| `Fontsize` | `font_size` | 同左 |
| `PrimaryColour` | `primary_color` + `primary_opacity` | 同左 |
| `SecondaryColour` | `PrimaryColour` と同じ（カラオケ用で、使わない） | 同左 |
| `OutlineColour` | `outline_color` + `outline_opacity` | **`background_color` + `background_opacity`**（箱の色） |
| `BackColour` | `shadow_color` + `shadow_opacity` | 同左（箱の影の色） |
| `Bold` / `Italic` | `-1`（オン）/ `0`（オフ） | 同左 |
| `Spacing` | `letter_spacing` | 同左 |
| `BorderStyle` | `1`（縁取り＋影） | `3`（箱で塗る） |
| `Outline` | `outline_width` | `font_size × 0.15`（箱の内側の余白。プレビューの上下の余白に合わせる） |
| `Shadow` | `shadow_depth` | 同左 |
| `Alignment` | `alignment`（テンキー配置） | 同左 |
| `MarginL` / `MarginR` / `MarginV` | `margin_h` / `margin_h` / `margin_v` | 同左 |

**色の変換**：`#RRGGBB` と不透明度を `&HAABBGGRR` にする。アルファ値は **`00` が不透明、`FF` が透明** なので、`AA = round((1 − 不透明度) × 255)`。

| 入力 | 出力 |
|---|---|
| `#FF8800`、不透明度 `1.0` | `&H000088FF` |
| `#000000`、不透明度 `0.5` | `&H80000000` |
| `#0B1F4D`、不透明度 `0.85` | `&H264D1F0B` |

### 3.3 `[Events]`

`visible: true` の文だけを、時間順に `Dialogue` 行にする。

```
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.48,Default,,0,0,0,,新カメラ、ついに解禁！
```

- **時間**：`H:MM:SS.cc`（100分の1秒）。丸めた結果 `start` と `end` が同じになったら、`end` を 0.01 秒延ばす。
- **特殊文字**：`{` `}` は ASS の装飾タグの記号、`\` は改行などの記号として解釈されてしまうので、全角の `｛` `｝` `＼` に置き換える。
- **改行**：`text` の `\n` は ASS の改行 `\N` にする。

### 3.4 自動改行

ASS（libass）は空白の位置でしか自動で改行しないため、空白のない日本語の長い文は画面からはみ出す。そこで、書き出し側で改行を入れる。

1. 1行に入る文字数 = `(動画の幅 − margin_h × 2) ÷ (font_size + letter_spacing)`（全角1文字を `font_size` 幅とみなす。半角は 0.5 文字として数える）
2. これを超える行は、必要な行数に **なるべく均等な長さ** で分ける（1行目だけ長く、2行目が1〜2文字、とならないように）
3. 「、」「。」「！」「？」や閉じかっこが行の先頭に来る場合は、前の行の末尾に付ける

---

## 4. FFmpeg の呼び出し

```
（.ass のあるフォルダで起動）
ffmpeg -i <cut.mp4> -vf ass=<export_id>.ass -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p
       -c:a aac -b:a 192k -movflags +faststart <保存先>.partial.mp4
```

- **Windows のパスの問題を避ける**：`ass` フィルターにフルパス（`C:\...`）を渡すと、`\` と `:` を何重にもエスケープしなければならない。FFmpeg を `.ass` のあるフォルダで起動し（`run_ffmpeg` の `cwd`）、記号を含まないファイル名だけを渡すことで、エスケープを不要にする。
- `video_codec` が `h264_nvenc` などの NVENC のときは、`-crf` の代わりに `-cq <crf> -b:v 0` を使う。
- `audio_codec` が `copy` のときは、音声を再エンコードせずにそのまま使う。
- 進捗は FFmpeg の `-progress` の出力（`out_time_us`）÷ 動画の長さで計算する。

---

## 5. 進捗・ログ・中断

| 状態（`status`） | 進捗 |
|---|---|
| `generating_ass` | 0 → 5 |
| `encoding` | 5 → 100 |

- 進捗は `on_progress(進捗, 状態)` で呼び出し元に返す（API の `GET /exports/{export_id}` の `status` と `progress` にそのまま入れる）。
- ログ（ロガー名 `core.sub_exporter`）：表示するテロップの数、`.ass` の保存先、10% ごとのエンコードの進捗、完了時の保存先と所要時間を記録する。
- 中断は `threading.Event` で受け取り、FFmpeg の実行中も約 0.5 秒ごとに確認する。途中のファイル（`.partial.mp4`）は削除する。

---

## 6. エラー

| code | 発生条件 |
|---|---|
| `VALIDATION_ERROR` | 入力が「1. 検証」に違反している（`details.errors` に内容） |
| `FILE_NOT_FOUND` | `cut.mp4` がない |
| `OUTPUT_EXISTS` | 保存先に同じ名前のファイルがあり、`overwrite` が `false` |
| `FFMPEG_ERROR` | FFmpeg の実行に失敗した（コーデック名の間違いもここ） |

---

## 7. 単体での動かし方

ステップ1〜3を実行済みのフォルダを指定する。`result.json` の文を読み、重要度と文言の種類を指定して書き出す。スタイルは既定値（`01_api_schema.md` の 3.2）を使う。

```
cd backend
python -m core.sub_exporter ../temp/test --threshold 2 --variant impact
```

| オプション | 既定値 | 説明 |
|---|---|---|
| `--threshold` | `1` | この重要度以上の文だけを表示する（UI の重要度スライダーと同じ） |
| `--variant` | `original` | `original` / `summary` / `impact` のどれを表示するか |
| `--output` | `<作業フォルダ>/output.mp4` | 保存先。すでにあれば上書きする |

---

## 8. 今後の検討事項・既知の差

- **文字の大きさ**：ASS（libass）の `Fontsize` はフォントの高さ全体に合わせるため、同じ数値でもブラウザの CSS の `font-size` より少し小さく見える。プレビューと書き出しの差が気になる場合は、どちらかで補正する。
- **フォント**：指定したフォントが PC にないと、FFmpeg は別のフォントで描画する。アプリにフォントを同梱する場合は、`ass` フィルターの `fontsdir` でそのフォルダを指定する。
- **背景ボックス**：ASS の箱は上下左右の余白が同じになるため、プレビュー（左右の余白が広い）とは少し見た目が違う。
