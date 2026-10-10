# 03. ステップ2：文字起こし

無音カット後の動画（`cut.mp4`）の音声を faster-whisper で文字起こしし、文ごとの「開始時間・終了時間・テキスト・信頼度」を `transcript.json` に保存する。ステップ3（LLM）はこのファイルを入力にする。

担当ファイル：`backend/core/transcriber.py`（クラス `Transcriber`）

---

## 1. 入力と出力

### 入力

| 項目 | 内容 |
|---|---|
| 作業フォルダ | `temp/{project_id}/`（ステップ1の出力先と同じ） |
| `cut.mp4` | ステップ1で作った無音カット後の動画 |
| オプション | `POST /projects` の `options.transcription`（`model`、`language`） |

### なぜ `audio.wav` ではなく `cut.mp4` の音声を使うか

- `audio.wav` は VAD 用に **元動画** から取り出した音声なので、時間が元動画基準になっている。
- テロップの時間は **無音カット後の動画** 基準にする決まりなので、カット後の音声を文字起こしすれば、変換なしでそのまま使える。
- 長い無音が取り除かれているため、Whisper が無音部分に存在しない文（「ご視聴ありがとうございました」など）を作ってしまう現象も起きにくい。

### 出力（作業フォルダ内）

| ファイル | 内容 |
|---|---|
| `cut_audio.wav` | `cut.mp4` から取り出した音声（16kHz・モノラル・16bit PCM） |
| `transcript.json` | 文字起こしの結果 |

```json
{
  "model": "large-v3",
  "language": "ja",
  "device": "cuda",
  "duration": 498.12,
  "segments": [
    {
      "id": "seg_0001",
      "index": 0,
      "start": 0.0,
      "end": 2.48,
      "text": "えーと今日はですね新しいカメラを紹介していきたいと思います",
      "confidence": 0.92
    }
  ]
}
```

- `id` と `index` はここで決め、ステップ3以降も同じ値を使う（API の `Segment.id` / `Segment.index`）。
- `duration` は `cut.mp4` の長さ（秒）。

---

## 2. 処理の手順

1. `cut.mp4` があるか確認し、ffprobe で長さを取得する
2. FFmpeg で音声を取り出して `cut_audio.wav` を作る（ステップ1と同じ `media.extract_audio` を使う）
3. faster-whisper のモデルを読み込む（1回読み込んだモデルは `Transcriber` が持ち続け、次の動画でも使い回す）
4. 文字起こしを実行し、Whisper の区切り（セグメント）ごとに結果を受け取る
5. 結果を整える（下の「4. 結果の整え方」）
6. `transcript.json` を保存し、結果のリストを返す

---

## 3. モデルと実行デバイス

### `Transcriber` の設定

| 引数 | 既定値 | 説明 |
|---|---|---|
| `model` | `"large-v3"` | faster-whisper のモデル名。精度と速度の目安は下の表 |
| `language` | `"ja"` | 言語コード。指定すると言語の自動判定を飛ばせる |
| `device` | `"auto"` | `"auto"` / `"cuda"` / `"cpu"`。`auto` は NVIDIA GPU があれば `cuda` を使う |
| `compute_type` | `"auto"` | `auto` のとき、`cuda` なら `float16`、`cpu` なら `int8` |
| `download_root` | `None` | モデルの保存先。`None` のときは Hugging Face の標準の場所（`%USERPROFILE%\.cache\huggingface\hub`） |

| モデル | ダウンロード量の目安 | 向いている場面 |
|---|---|---|
| `small` | 約 0.5GB | 動作確認、CPU だけの PC |
| `medium` | 約 1.5GB | 精度と速度の中間 |
| `large-v3` | 約 3GB | 本番（GPU 推奨。CPU だと動画の長さの数倍かかることがある） |

- モデルは初回だけ自動でダウンロードされる。
- Windows では、Hugging Face がシンボリックリンクについての警告を出すことがある。動作には問題ない。

### GPU で動かないときの対応

`device="auto"` で GPU を選んだのに、CUDA の DLL（cuBLAS・cuDNN）が見つからないなどの理由で失敗した場合は、警告をログに出して **CPU で最初からやり直す**。`device="cuda"` を明示したときはやり直さず、エラーにする。

### faster-whisper に渡す設定

| 設定 | 値 | 理由 |
|---|---|---|
| `language` | `language` | 自動判定を飛ばす |
| `beam_size` | `5` | 精度を優先する（faster-whisper の推奨値） |
| `condition_on_previous_text` | `False` | 前の文に引きずられて同じ文を繰り返す現象を防ぐ |
| `vad_filter` | `False` | ステップ1で無音はカット済みのため |

---

## 4. 結果の整え方

Whisper の区切りごとに、次の順で処理する。

1. テキストの前後の空白を取り除き、空になった文は捨てる
2. 前の文と時間が重なっている場合は、開始時間を前の文の終了時間にそろえる（テロップが2つ同時に出ないように）
3. 時間を `0`〜`duration` の範囲に収める。開始が `duration` 以上になった文は捨てる
4. 表示時間が `0.2` 秒より短い文は、終了時間を延ばして `0.2` 秒にする（書き出し時の `start < end` のチェックに引っかからないように）
5. **信頼度 `confidence`** を `exp(avg_logprob)` で計算し、`0.0`〜`1.0` に収める
   - `avg_logprob` は Whisper が出す「その文の単語の確からしさの平均（対数）」。`exp` で戻すと、1単語あたりの確率の目安になる
   - UI では `0.8` 未満を「要確認」として表示している
6. 時間と信頼度は小数点以下3桁に丸める

---

## 5. 進捗・ログ・中断

| 工程 | 進捗 |
|---|---|
| 音声の取り出し | 0 → 5 |
| 文字起こし | 5 → 100（受け取った文の終了時間 ÷ 動画の長さ） |

- ログは Python の `logging`（ロガー名 `core.transcriber`）で出す。モデルの読み込み開始・完了、10% ごとの進捗、完了時の文の数と所要時間を `INFO` で記録する。
- 中断は `threading.Event` で受け取り、文を1つ受け取るたびに確認する。中断すると `CancelledByUser` を送出する。

---

## 6. エラー

| code | 発生条件 |
|---|---|
| `FILE_NOT_FOUND` | `cut.mp4` がない（ステップ1が終わっていない） |
| `FFMPEG_ERROR` | 音声の取り出しに失敗した |
| `TRANSCRIPTION_ERROR` | モデルのダウンロード・読み込み、または文字起こしの実行に失敗した（`details.reason` に元のエラー文） |
| `INTERNAL_ERROR` | faster-whisper がインストールされていない |

---

## 7. 単体での動かし方

ステップ1を実行済みのフォルダを指定する。

```
cd backend
python -m core.transcriber ../temp/test --model small
```

| オプション | 既定値 | 説明 |
|---|---|---|
| `--model` | `large-v3` | モデル名 |
| `--language` | `ja` | 言語コード |
| `--device` | `auto` | `auto` / `cuda` / `cpu` |

---

## 8. 今後の検討事項

- Whisper の区切りは「文」と一致しないことがある（1つが長すぎる、文の途中で切れるなど）。テロップとして長すぎる場合は、`word_timestamps=True` で単語ごとの時間を取り、句読点や文字数で区切り直すことを検討する。
- 日本語では句読点が付かないことが多い。必要ならステップ3の LLM に句読点を付けさせるか、`initial_prompt` に句読点付きの例文を渡すことを検討する。
