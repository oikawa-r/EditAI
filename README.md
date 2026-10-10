# EditAI

AI で動画編集を自動化するデスクトップアプリ。無音カット、テロップの自動生成、重要度による絞り込み、3パターンの文言提案、テロップのスタイル保存ができる。

詳しい設計は [`docs/00_architecture.md`](docs/00_architecture.md)、API は [`docs/01_api_schema.md`](docs/01_api_schema.md) を参照。

## 進捗チェックリスト

### 準備

- [x] フォルダ構成の作成
- [x] API 仕様書（`docs/01_api_schema.md`）
- [x] 全体設計（`docs/00_architecture.md`）
- [x] UI モック（`frontend/`、ダミーデータで動作）
- [ ] Python のインストール
- [ ] FFmpeg のインストール
- [ ] Ollama のインストールと `qwen2.5:7b` の取得
- [x] `backend/requirements.txt` の作成
- [ ] 依存ライブラリのインストール（`python -m pip install -r backend/requirements.txt`）
- [x] API サーバーの実装（`backend/api/`、起動は `cd backend` → `python main.py`）
- [ ] FastAPI サーバーの起動確認（`GET /health`）

### ステップ1：無音カット

- [x] 仕様を `docs/02_silence_cut.md` に書く
- [x] `backend/core/silence_cutter.py` の実装（音声抽出・VAD・FFmpeg で結合・`kept_ranges` の出力）
- [x] 実際の動画で動作確認（`cd backend` → `python -m core.silence_cutter <動画> ../temp/test`）

### ステップ2：文字起こし

- [x] 仕様を `docs/03_transcription.md` に書く
- [x] `backend/core/transcriber.py` の実装（`cut.mp4` の音声を faster-whisper で文字起こしし、`transcript.json` に保存）
- [x] 実際の動画で動作確認（`cd backend` → `python -m core.transcriber ../temp/test --model small`）

### ステップ3：LLM による重要度判定と3択生成

- [x] 仕様を `docs/04_llm_processing.md` に書く
- [x] Ollama に渡すプロンプトの作成
- [x] 重要度（1〜3）と要約・インパクト重視の文言を JSON で受け取る
- [x] 返ってきた JSON の検証と、失敗したときの既定値
- [x] `result.json` に保存
- [x] 実際の動画で動作確認（`cd backend` → `python -m core.llm_processor ../temp/test`）

### ステップ4：UI の構築

- [ ] 仕様を `docs/05_ui_design.md` に書く
- [x] 3択の切り替えボタン（モック）
- [x] 重要度スライダーによる絞り込み（モック）
- [x] スタイル設定パネルとプリセット保存（モック、保存はメモリのみ）
- [ ] バックエンド API との接続（解析の開始・進捗・結果の取得）
- [ ] プリセットをバックエンドに保存する
- [ ] Tauri または Electron でデスクトップアプリにする

### ステップ5：テロップの焼き込み

- [x] 仕様を `docs/06_export_video.md` に書く
- [x] 確定データとスタイルから `.ass` ファイルを生成
- [x] FFmpeg で動画に焼き込む
- [x] 書き出しの進捗を返す
- [x] 実際の動画で動作確認（`cd backend` → `python -m core.sub_exporter ../temp/test --threshold 2 --variant impact`）

## UI モックの確認方法

`frontend/index.html` をブラウザで直接開く（サーバーは不要）。
