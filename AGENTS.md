# EditAI — AI 向けプロジェクトガイド

AI 搭載の「自動動画編集デスクトップアプリ」。動画を読み込むと、無音カット・文字起こし・テロップ生成までを自動で行い、ユーザーはテロップを選ぶ・絞り込む・装飾するだけで動画を仕上げられる。

## アプリの要件

- 動画をインポートし、話の間（無音）を自動でカットする。
- テロップを自動生成し、各文の重要度（1〜3）を AI が判定する。ユーザーは重要度スライダーでテロップの表示・非表示を一括で切り替えられる（手動で消す手間を減らす）。
- AI がテロップの文言を3パターン（原文・要約・インパクト重視）提案し、ユーザーはクリックだけで選べる。
- テロップのフォント・色・縁取りなどを細かく設定し、自分用のスタイルとして保存・適用できる。

## 技術スタック

| 役割 | 技術 |
|---|---|
| 画面（UI） | HTML / CSS / JavaScript（Tauri または Electron で包む想定） |
| バックエンド | Python + FastAPI（ローカル API サーバー、`127.0.0.1` のみ） |
| 無音検出・カット | Silero VAD（faster-whisper 同梱の ONNX 版。PyTorch 不要）+ FFmpeg（`subprocess` で直接呼ぶ） |
| 文字起こし | faster-whisper |
| 重要度判定・3択生成 | Ollama（ローカル LLM、`qwen2.5:7b` など） |
| テロップ描画 | FFmpeg + ASS 字幕（ハードサブで焼き込み） |

## 実装の5ステップ

1. **無音カット**：動画から音声を抽出 → Silero VAD で発話区間を検出 → FFmpeg で結合
2. **文字起こし**：faster-whisper で各文の時間とテキストを JSON にする
3. **LLM 処理**：Ollama に渡し、重要度 1〜3 と3パターンの文言を JSON で返させる
4. **UI 構築**：3択カード、重要度スライダー、スタイル設定・プリセット保存パネル
5. **書き出し**：確定した文・時間・スタイルから `.ass` を生成し、FFmpeg で動画に焼き込む

進捗は `README.md` のチェックリストで管理する。

## フォルダ構成

```
EditAI/
├── AGENTS.md              # このファイル
├── README.md              # 進捗チェックリスト
├── docs/                  # 設計・仕様（実装前に書く）
│   ├── 00_architecture.md # 全体設計・データの流れ
│   ├── 01_api_schema.md   # フロント ⇔ API の通信仕様（作成済み）
│   ├── 02_silence_cut.md  # ステップ1
│   ├── 03_transcription.md# ステップ2
│   ├── 04_llm_processing.md # ステップ3
│   ├── 05_ui_design.md    # ステップ4
│   └── 06_export_video.md # ステップ5
├── backend/
│   ├── core/              # 処理エンジン（silence_cutter / transcriber / llm_processor / sub_exporter、共通の media / errors）
│   ├── api/server.py      # FastAPI のルーティング
│   ├── requirements.txt
│   └── main.py            # 起動用
├── frontend/              # index.html / style.css / main.js（UI モック作成済み）
└── temp/                  # 処理中の一時ファイル（Git 管理外）
```

## 守ること

- **API の形は `docs/01_api_schema.md` が正**。フロントとバックエンドはこの仕様に合わせる。仕様を変えるときは、先にこのファイルを更新する。
- 時間は秒（float）で、解析結果の時刻はすべて **無音カット後の動画** が基準。
- 色はフロントでは `#RRGGBB` と不透明度（0.0〜1.0）で扱い、ASS 形式（`&HAABBGGRR`）への変換はバックエンドで行う。
- 各ステップは、実装の前に `docs/` の該当ファイルに手順と仕様を書く。
- ユーザーへの説明・ドキュメント・コードのコメントは日本語で書く。

## 開発環境の注意

- OS は Windows。作業フォルダは `C:\Users\ryo30\nopasodaigaku\EditAI`（以前は OneDrive 内にあったが移動した）。
- Python・FFmpeg・Ollama のインストールはユーザーが手動で行う。AI はコードの実装に集中する。
- `.gitignore` はルートにある（再作成しない）。
- Windows で FFmpeg の `ass` フィルターにフルパスを渡すと、`\` と `:` のエスケープが必要になる。これを避けるため、FFmpeg を `.ass` のあるフォルダで起動し（`run_ffmpeg` の `cwd`）、ファイル名だけを渡している。

## 現在の状態

- 完了：フォルダ構成、API 仕様書（`docs/01_api_schema.md`）、UI モック（`frontend/`、ダミーデータで動作。バックエンドとはまだ通信しない）、`backend/requirements.txt`、ステップ1の仕様（`docs/02_silence_cut.md`）と実装（`backend/core/silence_cutter.py`、動作確認済み）、ステップ2の仕様（`docs/03_transcription.md`）と実装（`backend/core/transcriber.py`、動作確認済み）、ステップ3の仕様（`docs/04_llm_processing.md`）と実装（`backend/core/llm_processor.py`、動作確認済み）、ステップ5の仕様（`docs/06_export_video.md`）と実装（`backend/core/sub_exporter.py`、動作確認済み）、API サーバー（`backend/api/`：`server.py` ルーティング、`jobs.py` ジョブ管理、`presets.py` プリセット保存、`schemas.py` リクエストの形、`settings.py` 設定。起動は `backend/main.py`、動作は未確認）
- 次にやること：API サーバーの動作確認 → `frontend/main.js` をダミーデータから API 呼び出しに切り替える
- 方針：UI の作り込みは後回しにし、先にバックエンドの処理を最後（ステップ5）まで作りきる