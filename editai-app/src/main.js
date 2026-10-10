"use strict";

const API_ORIGIN = "http://127.0.0.1:8765";
const API_BASE = `${API_ORIGIN}/api/v1`;

const IMPORTANCE_LABELS = { 1: "低", 2: "中", 3: "高" };

const THRESHOLD_DESCRIPTIONS = {
  1: "すべてのテロップを表示します。",
  2: "重要度「低」のテロップを非表示にします。",
  3: "重要度「高」のテロップだけを表示します。",
};

const EXPORT_STATUS_LABELS = {
  queued: "開始待ち",
  generating_ass: "字幕を作成中",
  encoding: "動画に焼き込み中",
  completed: "完了",
  failed: "失敗",
};

const RECENT_PROJECTS = [
  { name: "カメラ紹介", updated: "9月29日", duration: "08:12", tone: "a" },
  { name: "週末のvlog", updated: "9月27日", duration: "12:40", tone: "b" },
  { name: "ゲーム実況 #12", updated: "9月24日", duration: "24:05", tone: "c" },
];

const LOW_CONFIDENCE = 0.8;
const POLL_MS = 1000;

// SubtitleStyle（docs/01_api_schema.md 3.2）の既定値
const DEFAULT_STYLE = {
  font_family: "Noto Sans JP",
  font_size: 64,
  bold: true,
  italic: false,
  primary_color: "#FFFFFF",
  primary_opacity: 1.0,
  outline_color: "#000000",
  outline_opacity: 1.0,
  outline_width: 4.0,
  shadow_color: "#000000",
  shadow_opacity: 0.5,
  shadow_depth: 2.0,
  background_enabled: false,
  background_color: "#000000",
  background_opacity: 0.6,
  alignment: 2,
  margin_v: 60,
  margin_h: 40,
  letter_spacing: 0.0,
};

const LLM_STATUS_MESSAGES = {
  partial: "一部のテロップは AI の判定を使えなかったため、原文のまま表示しています。",
  failed: "AI の判定を使えませんでした。テロップは原文のまま、重要度はすべて「中」です。",
  disabled: "AI の判定はオフのため、テロップは原文のまま、重要度はすべて「中」です。",
};

/** GET /projects/{id}/result のレスポンス。解析前は null */
let result = null;
/** いま開いている .editai のパス。未保存のときは空 */
let projectFilePath = "";
/** 進行中の解析。中断ボタンから参照する */
let analysis = null;

let trackSerial = 1;

function createTrack(type, name) {
  const id = `track-${trackSerial}`;
  trackSerial += 1;
  return { id, type, name, visible: true, locked: false, muted: false, clips: [] };
}

function createInitialTracks() {
  return [
    createTrack("video", "映像 3"),
    createTrack("video", "映像 2"),
    createTrack("video", "映像 1"),
    createTrack("audio", "音声 1"),
  ];
}

/** 画面の上から下。映像を先に、その下へ音声を積む。配列の先頭が一番上。 */
function tracksTopToBottom() {
  const videos = [];
  const audios = [];
  for (const track of state.project.tracks) {
    if (track.type === "audio") audios.push(track);
    else videos.push(track);
  }
  return [...videos, ...audios];
}

const state = {
  connected: false,
  busy: false,
  exporting: false,
  media: [],
  project: {
    width: 1920,
    height: 1080,
    fps: 30,
    tracks: createInitialTracks(),
  },
  selectedClipIds: [],
  selectedMediaId: null,
  previewTarget: "timeline",
  mediaTime: 0,
  threshold: 1,
  currentTime: 0,
  playing: false,
  segments: [],
  style: { ...DEFAULT_STYLE },
  presets: [],
  activePresetId: null,
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- API ----------

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, options);
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("バックエンドに接続できません。backend で python main.py を実行してください。");
  }

  if (res.status === 204) return null;

  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    if (!res.ok) throw new Error(`サーバーがエラーを返しました（HTTP ${res.status}）。`);
    return null;
  }

  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error?.message ?? `サーバーがエラーを返しました（HTTP ${res.status}）。`);
  }
  return body;
}

function apiJson(path, method, body) {
  return api(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------- ユーティリティ ----------

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(seconds, 0) : 0;
  const m = Math.floor(safe / 60);
  const s = safe - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

function hexToRgba(hex, opacity) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity})`;
}

// CSS には ASS のような縁取りがないため、全方向に text-shadow を重ねて近似する
function outlineShadows(width, color) {
  if (width <= 0) return [];
  const steps = 16;
  const shadows = [];
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const x = (Math.cos(angle) * width).toFixed(2);
    const y = (Math.sin(angle) * width).toFixed(2);
    shadows.push(`${x}px ${y}px 0 ${color}`);
  }
  return shadows;
}

let toastTimer;
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3500);
}

function findClip(id) {
  if (!id) return null;
  for (const track of state.project.tracks) {
    const clip = track.clips.find((item) => item.id === id);
    if (clip) return { track, clip };
  }
  return null;
}

function silenceBlocks(keptRanges, duration, fps) {
  if (!duration) return [];
  const ranges = [...(keptRanges || [])].sort((a, b) => a.source_start - b.source_start);
  const epsilon = Math.max(1 / (fps || 30), 0.001);
  const blocks = [];
  const push = (kept, start, end) => {
    const sourceStart = Math.max(0, start);
    const sourceEnd = Math.min(duration, end);
    if (sourceEnd - sourceStart < epsilon) return;
    blocks.push({ kept, sourceStart, sourceEnd });
  };
  if (!ranges.length) {
    push(true, 0, duration);
    return blocks;
  }
  let cursor = 0;
  for (const range of ranges) {
    push(false, cursor, range.source_start);
    push(true, range.source_start, range.source_end);
    cursor = Math.max(cursor, range.source_end);
  }
  push(false, cursor, duration);
  return blocks;
}

/** kept_ranges のうち、対象クリップの素材範囲に重なる部分だけを、そのクリップの長さの中へ並べる。 */
function applySilenceCuts(data, clipId) {
  const cut = data?.silence_cut;
  if (!cut || cut.enabled === false) return false;
  const located = findClip(clipId);
  if (!located || located.clip.type !== "動画") return false;
  const { track, clip } = located;
  const duration = cut.original_duration || data.source?.duration || 0;
  const blocks = silenceBlocksForClip(located, silenceBlocks(cut.kept_ranges, duration, data.source?.fps));
  if (!blocks.length) return false;
  const sourceName = data.source?.file_name || clip.name || "動画";
  const pieces = blocks.map((block) => cutPiece(
    clip,
    block.kept ? sourceName : "無音",
    block.timelineStart,
    block.duration,
    block.kept,
    block.sourceStart,
  ));
  const index = track.clips.findIndex((item) => item.id === clip.id);
  if (index < 0) return false;
  track.clips.splice(index, 1, ...pieces);
  track.clips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  const selected = new Set(state.selectedClipIds);
  if (selected.has(clip.id)) {
    selected.delete(clip.id);
    for (const piece of pieces) selected.add(piece.id);
  }
  state.selectedClipIds = [...selected].filter((id) => findClip(id));
  return true;
}

function isVisible(seg) {
  return seg.importance >= state.threshold;
}

function currentText(seg) {
  return seg.variants[seg.selected_variant] ?? seg.variants.original;
}

function setImportEnabled(enabled) {
  const button = $("import-label");
  button.disabled = !enabled;
  button.classList.toggle("is-disabled", !enabled);
}

function setBusy(busy) {
  state.busy = busy;
  setImportEnabled(state.connected && !busy);
  $("cancel-btn").hidden = !busy;
  $("cancel-btn").disabled = false;
  $("export-btn").disabled = busy || !result;
  $("analysis-overlay").hidden = !busy;
  syncEditCommands();
}

// タイムラインから映像へ時刻を書き込んでいる間は、映像側のイベントで再生ヘッドを引き戻さない
let syncingMonitor = false;
let scrubbingTimeline = false;

function previewMonitor() {
  return $("preview-monitor");
}

function playbackLimit() {
  const monitor = previewMonitor();
  const media = monitor && Number.isFinite(monitor.duration) ? monitor.duration : 0;
  return Math.max(projectDuration(), media);
}

function updatePlayback() {
  const monitor = previewMonitor();
  if (state.previewTarget !== "timeline") {
    state.playing = Boolean(monitor && monitor.src && !monitor.paused && !monitor.ended);
  }
  placePlayhead();
  syncNarration();
}

let ticking = false;

function tick() {
  if (ticking) return;
  ticking = true;
  const step = () => {
    const monitor = previewMonitor();
    if (!monitor || monitor.paused || monitor.ended) {
      ticking = false;
      updatePlayback();
      return;
    }
    if (!scrubbingTimeline && !syncingMonitor && Number.isFinite(monitor.currentTime)) {
      if (state.previewTarget === "media") {
        state.mediaTime = monitor.currentTime;
        syncPreviewControls();
      }
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function seek(time) {
  setCurrentTime(time);
  updatePlayback();
}

function setPlaying(playing) {
  if (state.previewTarget === "timeline") {
    if (playing) {
      const end = projectDuration();
      if (end <= 0) {
        state.playing = false;
        updatePlayback();
        return;
      }
      if (state.currentTime >= end - 0.05) setCurrentTime(0);
      state.playing = true;
      playClock = { startPerf: performance.now(), startTime: state.currentTime };
      syncTimelineFrame();
      requestAnimationFrame(tickTimeline);
    } else {
      state.playing = false;
      playClock = null;
      syncLayerPlayback();
      updatePlayback();
    }
    return;
  }
  const monitor = previewMonitor();
  if (!monitor || !monitor.src) return;

  if (playing) {
    if (state.previewTarget === "media") {
      const end = Number.isFinite(monitor.duration) ? monitor.duration : 0;
      if (monitor.ended || (end > 0 && state.mediaTime >= end - 0.05)) setMediaTime(0);
    } else {
      const end = playbackLimit();
      if (monitor.ended || (end > 0 && state.currentTime >= end - 0.05)) setCurrentTime(0);
    }
    if (previewPitch?.ctx?.state === "suspended") previewPitch.ctx.resume();
    monitor.play().then(() => {
      requestAnimationFrame(tick);
    }).catch((error) => {
      showToast(error.message || "動画を再生できませんでした。");
      updatePlayback();
    });
  } else {
    monitor.pause();
    updatePlayback();
  }
}

// ---------- スタイル ----------

function applyStyle() {
}

function readInput(input) {
  if (input.type === "checkbox") return input.checked;
  if (input.dataset.type === "number") return Number(input.value);
  return input.value;
}

function syncStyleForm() {
  for (const input of document.querySelectorAll("#style-form [data-key]")) {
    const value = state.style[input.dataset.key];
    if (input.type === "checkbox") {
      input.checked = value;
    } else {
      // <input type="color"> は小文字の #rrggbb しか受け付けない
      input.value = input.type === "color" ? String(value).toLowerCase() : String(value);
    }

    const { requires, disabledBy } = input.dataset;
    input.disabled = (requires && !state.style[requires]) || (disabledBy && state.style[disabledBy]) || false;
  }

  for (const output of document.querySelectorAll("#style-form [data-output]")) {
    const value = state.style[output.dataset.output];
    output.textContent =
      output.dataset.format === "percent" ? `${Math.round(value * 100)}%` : `${value}${output.dataset.unit ?? ""}`;
  }
}

function renderPresets() {
  const select = $("preset-select");
  if (!select) return;
  select.replaceChildren();

  const custom = new Option("カスタム（未保存）", "");
  custom.disabled = true;
  select.append(custom);

  for (const preset of state.presets) {
    select.append(new Option(preset.name, preset.id));
  }
  select.value = state.activePresetId ?? "";
}

async function loadPresets() {
  const data = await api("/style-presets");
  state.presets = data.presets;
  if (!state.activePresetId && state.presets.length) {
    const first = state.presets[0];
    state.activePresetId = first.id;
    state.style = { ...DEFAULT_STYLE, ...first.style };
  }
  renderPresets();
}

async function savePreset() {
  const input = $("preset-name");
  const name = input.value.trim();
  if (!name) {
    showToast("プリセット名を入力してください。");
    return;
  }

  try {
    const preset = await apiJson("/style-presets", "POST", { name, style: { ...state.style } });
    state.presets.push(preset);
    state.activePresetId = preset.id;
    input.value = "";
    renderPresets();
    showToast(`プリセット「${name}」を保存しました。`);
  } catch (error) {
    showToast(error.message);
  }
}

// ---------- 解析結果の反映 ----------

function applyResult(data, clipId, options = {}) {
  const touchTimeline = options.timeline !== false;
  rememberSilenceResult(data, clipId);
  if (!touchTimeline) return false;
  result = data;
  state.segments = (data.segments || []).map((seg) => ({ ...seg, selected_variant: "original" }));
  state.threshold = 1;
  state.currentTime = 0;
  state.playing = false;

  const source = data.source ?? {};
  const cut = data.silence_cut ?? {};
  $("file-name").textContent = source.file_name || "解析済みの動画";
  if (cut.original_duration != null && cut.cut_duration != null) {
    const removed = cut.removed_duration ?? cut.original_duration - cut.cut_duration;
    $("cut-info").textContent =
      `無音カット：${cut.original_duration.toFixed(1)}秒 → ${cut.cut_duration.toFixed(1)}秒（-${removed.toFixed(1)}秒）`;
  } else {
    $("cut-info").textContent = "解析が完了しました。";
  }
  if (source.width && source.height) {
    state.project.width = source.width;
    state.project.height = source.height;
  }
  if (source.fps) state.project.fps = source.fps;

  const split = applySilenceCuts(data, clipId);
  renderSequence();
  setCurrentTime(0);
  updatePlayback();
  $("export-btn").disabled = false;

  const llm = data.llm;
  if (llm && llm.status !== "ok") {
    showToast(llm.message || LLM_STATUS_MESSAGES[llm.status] || "AI の判定を一部使えませんでした。");
  }
  rememberProject(false);
  return split;
}

/** ボタンごとに、走らせる工程だけを options に入れる。 */
function analysisRequestOptions(profile) {
  const text = { enabled: true, model: "small" };
  const silence = { enabled: true };
  const llm = { enabled: true };
  if (profile === "silence") {
    return { silence, transcription: { ...text, enabled: false }, llm: { enabled: false } };
  }
  if (profile === "telop") {
    return { silence: { enabled: false }, transcription: text, llm };
  }
  return { silence, transcription: text, llm };
}

function showAnalysisProgress(status) {
  const label = status.current_step?.label ?? EXPORT_STATUS_LABELS[status.status] ?? status.status;
  const progress = Math.round(status.progress ?? 0);
  $("analysis-label").textContent = `${label}… ${progress}%`;
  $("analysis-progress").value = progress;
  $("cut-info").textContent = `${label}… ${progress}%`;
}

async function startAnalysis(file, clipId, options = {}) {
  if (state.busy) return false;
  if (!state.connected) {
    showToast("バックエンドに接続できていません。");
    return false;
  }

  showEditor();
  const controller = new AbortController();
  analysis = { controller, projectId: null, clipId: clipId || null };
  const located = findClip(clipId);
  const monitor = previewMonitor();
  if (located?.clip.sourceUrl) {
    monitor.pause();
    if (monitor.src !== located.clip.sourceUrl) monitor.src = located.clip.sourceUrl;
  }
  $("file-name").textContent = file.name;
  setBusy(true);
  showAnalysisProgress({ progress: 0, current_step: { label: "アップロード中" } });

  try {
    const form = new FormData();
    form.append("file", file);
    // ブラウザでの確認は small を使う。large-v3 は CPU だと極端に遅い
    form.append("options", JSON.stringify(analysisRequestOptions(options.profile)));
    const created = await api("/projects", { method: "POST", body: form, signal: controller.signal });
    analysis.projectId = created.project_id;

    while (true) {
      const status = await api(`/projects/${created.project_id}/status`, { signal: controller.signal });
      showAnalysisProgress(status);
      if (status.status === "completed") break;
      if (status.status === "failed") {
        throw new Error(status.error?.message ?? "解析に失敗しました。");
      }
      if (status.status === "cancelled") {
        const cancelled = new Error("解析を中断しました。");
        cancelled.name = "Cancelled";
        throw cancelled;
      }
      await sleep(POLL_MS);
    }

    const split = applyResult(await api(`/projects/${created.project_id}/result`), analysis.clipId, options);
    showToast(options.timeline === false
      ? "解析が完了しました。"
      : (split
        ? "解析が完了しました。無音の位置に切り込みを入れました。"
        : "解析が完了しました。"));
    return true;
  } catch (error) {
    const stopped = error.name === "AbortError" || error.name === "Cancelled";
    $("cut-info").textContent = stopped ? "解析を中断しました。" : error.message;
    showToast(stopped ? "解析を中断しました。" : error.message);
    return false;
  } finally {
    analysis = null;
    setBusy(false);
  }
}

async function cancelAnalysis() {
  if (!analysis) return;
  $("cancel-btn").disabled = true;
  $("cut-info").textContent = "解析の中断を要求しました…";
  try {
    if (analysis.projectId) {
      await api(`/projects/${analysis.projectId}/cancel`, { method: "POST" });
    } else {
      // アップロード中は、まだ project_id がないので通信自体を止める
      analysis.controller.abort();
    }
  } catch (error) {
    showToast(error.message);
    $("cancel-btn").disabled = false;
  }
}

// ---------- 書き出し ----------

function timelineTelops() {
  const clips = [];
  for (const track of state.project.tracks) {
    for (const clip of track.clips) {
      if (clip.type === "テロップ") clips.push(clip);
    }
  }
  return clips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
}

function exportStyleFromTimeline(telops) {
  const source = telops[0]?.style || state.style || {};
  const style = {};
  for (const key of Object.keys(DEFAULT_STYLE)) {
    style[key] = source[key] != null ? source[key] : (state.style?.[key] ?? DEFAULT_STYLE[key]);
  }
  style.font_size = Math.min(300, Math.max(8, Math.round(Number(style.font_size) || 64)));
  return style;
}

function exportNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function exportTime(value) {
  return Math.round(Math.max(0, exportNumber(value, 0)) * 1000) / 1000;
}

function exportClipPayload(clip) {
  const duration = exportTime(clip.duration);
  if (!(duration > 0)) return null;
  const item = {
    id: String(clip.id),
    type: clip.type,
    startTime: exportTime(clip.startTime),
    duration,
    sourcePath: clip.sourcePath || "",
    sourceUrl: clip.sourceUrl || "",
    sourceStart: exportTime(clip.sourceStart),
    kept: clip.kept !== false,
    x: exportNumber(clip.x, 0),
    y: exportNumber(clip.y, 0),
    scale: exportNumber(clip.scale, 100),
    rotation: exportNumber(clip.rotation, 0),
    flipH: Boolean(clip.flipH),
    flipV: Boolean(clip.flipV),
    speed: exportNumber(clip.speed, 1) > 0 ? exportNumber(clip.speed, 1) : 1,
    volume: exportNumber(clip.volume, 100),
    fadeIn: Math.max(0, exportNumber(clip.fadeIn, 0)),
    fadeOut: Math.max(0, exportNumber(clip.fadeOut, 0)),
    pitch: exportNumber(clip.pitch, 0),
    chromaEnabled: Boolean(clip.chromaEnabled),
    chromaColor: clip.chromaColor || "#00ff00",
  };
  if (exportNumber(clip.width, 0) > 0) item.width = exportNumber(clip.width, 0);
  if (exportNumber(clip.height, 0) > 0) item.height = exportNumber(clip.height, 0);
  if (clip.type === "テロップ") {
    item.text = String(clip.text || clip.name || "");
    item.style = exportStyleFromTimeline([clip]);
  }
  return item;
}

function exportTracks() {
  const tracks = [];
  for (const track of tracksTopToBottom()) {
    if (track.visible === false) continue;
    const clips = [];
    for (const clip of track.clips) {
      const item = exportClipPayload(clip);
      if (item) clips.push(item);
    }
    clips.sort((a, b) => a.startTime - b.startTime || String(a.id).localeCompare(String(b.id)));
    tracks.push({
      id: track.id,
      type: track.type,
      name: track.name || "",
      muted: Boolean(track.muted),
      locked: Boolean(track.locked),
      clips,
    });
  }
  return tracks;
}

function buildExportPayload() {
  const telops = timelineTelops();
  const variants = new Set(["original", "summary", "impact", "custom"]);
  const segments = [];
  for (const clip of telops) {
    const text = String(clip.text || clip.name || "").trim();
    const start = exportTime(clip.startTime);
    const end = exportTime(start + Math.max(0, Number(clip.duration) || 0));
    if (!text || end <= start) continue;
    segments.push({
      id: clip.id,
      start,
      end,
      visible: true,
      selected_variant: variants.has(clip.selected_variant) ? clip.selected_variant : "custom",
      text,
    });
  }
  const project = state.project || {};
  return {
    width: Math.max(1, Math.round(exportNumber(project.width, 1920))),
    height: Math.max(1, Math.round(exportNumber(project.height, 1080))),
    fps: exportNumber(project.fps, 30) > 0 ? exportNumber(project.fps, 30) : 30,
    tracks: exportTracks(),
    segments,
    style: exportStyleFromTimeline(telops),
    importance_threshold: state.threshold,
    output: {
      overwrite: false,
      video_codec: "libx264",
      crf: 20,
      preset: "medium",
      audio_codec: "aac",
      audio_bitrate: "192k",
    },
  };
}

function resetExportDialog() {
  $("export-status").textContent = "書き出しを開始しています…";
  $("export-progress-bar").value = 0;
  $("export-progress-text").textContent = "0%";
  $("export-error").hidden = true;
  $("export-error").textContent = "";
  const link = $("export-download");
  link.hidden = true;
  link.removeAttribute("href");
}

async function startExport() {
  if (!result || state.exporting) return;
  resetExportDialog();
  $("export-dialog").showModal();
  state.exporting = true;

  try {
    const created = await apiJson(`/projects/${result.project_id}/exports`, "POST", buildExportPayload());
    const exportId = created.export_id;

    while ($("export-dialog").open) {
      const status = await api(`/projects/${result.project_id}/exports/${exportId}`);
      const label = EXPORT_STATUS_LABELS[status.status] ?? status.status;
      const progress = Math.round(status.progress ?? 0);
      $("export-status").textContent = `${label}…`;
      $("export-progress-bar").value = progress;
      $("export-progress-text").textContent = `${progress}%`;

      if (status.status === "completed") {
        const link = $("export-download");
        const fileName = (result.source?.file_name || "video").replace(/\.[^.]+$/, "") + "_edited.mp4";
        link.href = `${API_BASE}/projects/${result.project_id}/exports/${exportId}/download`;
        link.setAttribute("download", fileName);
        link.hidden = false;
        $("export-status").textContent = status.output_path
          ? `完了しました。保存先：${status.output_path}`
          : "完了しました。下のボタンから動画を保存できます。";
        $("export-progress-bar").value = 100;
        $("export-progress-text").textContent = "100%";
        showToast("書き出しが完了しました。");
        break;
      }
      if (status.status === "failed") {
        throw new Error(status.error?.message ?? "書き出しに失敗しました。");
      }
      await sleep(POLL_MS);
    }
  } catch (error) {
    $("export-error").textContent = error.message;
    $("export-error").hidden = false;
    $("export-status").textContent = "書き出しに失敗しました。";
    showToast(error.message);
  } finally {
    state.exporting = false;
  }
}

// ---------- イベント ----------

function selectToolTab(group, tab) {
  for (const other of group.querySelectorAll("[role='tab']")) {
    const selected = other === tab;
    other.classList.toggle("is-active", selected);
    other.setAttribute("aria-selected", selected ? "true" : "false");
    $(other.getAttribute("aria-controls")).hidden = !selected;
  }
}

async function cutSelectedClip() {
  const targets = selectedVideoClips();
  if (!targets.length) {
    showToast("切り込みを入れる動画クリップを選んでください。");
    return;
  }
  const groups = new Map();
  for (const located of targets) {
    const url = located.clip.sourceUrl;
    if (!url) continue;
    if (!groups.has(url)) groups.set(url, []);
    groups.get(url).push(located.clip.id);
  }
  if (!groups.size) {
    showToast("このクリップの動画を読み込めませんでした。");
    return;
  }
  let changed = false;
  for (const [url, ids] of groups) {
    let data = silenceResults.get(url);
    if (!silenceAnalysisReady(data)) {
      const located = findClip(ids[0]);
      if (!located) continue;
      try {
        const media = state.media.find((item) => item.url === located.clip.sourceUrl || item.path === located.clip.sourcePath || item.name === located.clip.name);
        const file = await fileFromMedia(media || { name: located.clip.name, url: located.clip.sourceUrl });
        if (!file) {
          showToast("このクリップの動画を読み込めませんでした。");
          continue;
        }
        const ok = await startAnalysis(file, ids[0], { profile: "silence" });
        if (!ok) return;
        changed = true;
        data = silenceResults.get(url);
        for (const id of ids.slice(1)) {
          if (data && applySilenceCuts(data, id)) changed = true;
        }
      } catch (error) {
        showToast(error.message || "動画を読み込めませんでした。");
        return;
      }
      continue;
    }
    for (const id of ids) {
      if (applySilenceCuts(data, id)) changed = true;
    }
  }
  if (changed) {
    renderSequence();
    rememberProject(false);
  }
}

const silenceResults = new Map();
const CLIP_LOOK_KEYS = [
  "x", "y", "scale", "rotation", "flipH", "flipV",
  "baseWidth", "baseHeight", "width", "height",
  "speed", "chromaEnabled", "chromaColor", "volume", "fadeIn", "fadeOut", "pitch",
  "cropX", "cropY", "cropWidth", "cropHeight", "cropAspect",
];

function silenceAnalysisReady(data) {
  return Boolean(data?.silence_cut?.enabled);
}

function telopAnalysisReady(data) {
  return (data?.segments || []).length > 0;
}

function rememberSilenceResult(data, clipId) {
  const located = findClip(clipId);
  const url = located?.clip.sourceUrl;
  if (!url || !data) return;
  if (!data.silence_cut && !(data.segments || []).length) return;
  const prev = silenceResults.get(url);
  if (!prev) {
    silenceResults.set(url, data);
    return;
  }
  const next = { ...prev, ...data };
  if (!telopAnalysisReady(data) && telopAnalysisReady(prev)) {
    next.segments = prev.segments;
    if (prev.llm) next.llm = prev.llm;
  }
  if (!silenceAnalysisReady(data) && silenceAnalysisReady(prev)) next.silence_cut = prev.silence_cut;
  silenceResults.set(url, next);
}

function copyClipLook(from, to) {
  for (const key of CLIP_LOOK_KEYS) {
    if (from[key] != null) to[key] = from[key];
  }
}

function cutPiece(clip, name, startTime, duration, kept, sourceStart) {
  const piece = createClip({
    type: clip.type,
    name,
    startTime,
    duration,
    sourceUrl: clip.sourceUrl,
    sourcePath: clip.sourcePath,
    kept,
  });
  copyClipLook(clip, piece);
  piece.sourceStart = sourceStart;
  return piece;
}

function silenceBlocksForClip(located, blocks) {
  const window = clipSourceWindow(located);
  const speed = clipSpeed(located.clip);
  const epsilon = 0.001;
  const next = [];
  for (const block of blocks || []) {
    const sourceStart = Math.max(block.sourceStart, window.start);
    const sourceEnd = Math.min(block.sourceEnd, window.end);
    if (sourceEnd - sourceStart < epsilon) continue;
    next.push({
      kept: block.kept,
      sourceStart,
      sourceEnd,
      timelineStart: located.clip.startTime + (sourceStart - window.start) / speed,
      duration: (sourceEnd - sourceStart) / speed,
    });
  }
  return next;
}

function cutCompareVersions(clip, data) {
  const cut = data?.silence_cut;
  if (!cut || cut.enabled === false) return null;
  const located = findClip(clip.id);
  if (!located) return null;
  const duration = cut.original_duration || data.source?.duration || clip.duration;
  const blocks = silenceBlocksForClip(located, silenceBlocks(cut.kept_ranges, duration, data.source?.fps));
  if (!blocks.length) return null;
  const sourceName = data.source?.file_name || clip.name || "動画";
  const split = blocks.map((block) => cutPiece(
    clip,
    block.kept ? sourceName : "無音",
    block.timelineStart,
    block.duration,
    block.kept,
    block.sourceStart,
  ));
  const packed = [];
  let cursor = clip.startTime;
  for (const block of blocks) {
    if (!block.kept) continue;
    packed.push(cutPiece(clip, sourceName, cursor, block.duration, true, block.sourceStart));
    cursor += block.duration;
  }
  return { split, packed, origin: clip.startTime };
}

let cutComparePlan = null;
let cutCompareSyncing = false;
let cutCompareBaseline = null;
let cutCompareCommitted = false;
let telopGenBaseline = null;
let telopGenCommitted = false;

function cutSpan(clips, origin) {
  return Math.max(clips.reduce((max, clip) => Math.max(max, clip.startTime - origin + clip.duration), 0), 0.001);
}

function cutStage(kind) {
  return $(kind === "packed" ? "cut-stage-packed" : "cut-stage-split");
}

function cutLanesHost(kind) {
  return $(kind === "packed" ? "cut-lanes-packed" : "cut-lanes-split");
}

function planClips(kind) {
  const lanes = cutComparePlan?.lanes || [];
  const clips = [];
  for (const lane of lanes) clips.push(...(lane[kind] || []));
  return clips;
}

function laneForClip(kind, id) {
  return (cutComparePlan?.lanes || []).find((lane) => (lane[kind] || []).some((clip) => clip.id === id)) || null;
}

function localTimeFromEvent(event, kind) {
  const stage = cutStage(kind);
  const px = cutComparePlan?.px?.[kind] || 1;
  if (!stage) return 0;
  return Math.max(0, (event.clientX - stage.getBoundingClientRect().left) / px);
}

function mergeTimeRanges(ranges) {
  const sorted = ranges
    .filter((range) => range.end - range.start > CLIP_EPS)
    .map((range) => ({ start: range.start, end: range.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + CLIP_EPS) last.end = Math.max(last.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
}

function rangesMinus(base, cuts) {
  let current = base.map((range) => ({ start: range.start, end: range.end }));
  for (const cut of cuts) {
    const next = [];
    for (const range of current) {
      if (cut.end <= range.start + CLIP_EPS || cut.start >= range.end - CLIP_EPS) {
        next.push(range);
        continue;
      }
      if (cut.start > range.start + CLIP_EPS) next.push({ start: range.start, end: Math.min(cut.start, range.end) });
      if (cut.end < range.end - CLIP_EPS) next.push({ start: Math.max(cut.end, range.start), end: range.end });
    }
    current = next;
  }
  return mergeTimeRanges(current);
}

function shiftPastRanges(time, gaps) {
  let removed = 0;
  for (const gap of gaps) {
    if (gap.end <= time + CLIP_EPS) removed += gap.end - gap.start;
    else break;
  }
  return time - removed;
}

/** 有音と重ならない無音区間だけを、全トラック共通で左へ詰める。 */
function packCompareLanes(lanes) {
  const silence = [];
  const speech = [];
  for (const lane of lanes) {
    for (const clip of lane.split) {
      const range = { start: clip.startTime, end: clip.startTime + clip.duration };
      if (clip.kept === false) silence.push(range);
      else speech.push(range);
    }
  }
  const gaps = rangesMinus(mergeTimeRanges(silence), speech);
  for (const lane of lanes) {
    const packed = [];
    for (const clip of lane.split) {
      if (clip.kept === false) continue;
      const end = clip.startTime + clip.duration;
      const start = shiftPastRanges(clip.startTime, gaps);
      const duration = shiftPastRanges(end, gaps) - start;
      if (duration <= CLIP_EPS) continue;
      const piece = cutPiece(clip, clip.name, start, duration, true, clip.sourceStart);
      piece.kept = true;
      packed.push(piece);
    }
    packed.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
    lane.packed = packed;
  }
}

function splitClips() {
  return planClips("split").sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
}

function sourceOnClip(clip, absolute) {
  const speed = clip.speed > 0 ? clip.speed : 1;
  const source = Number.isFinite(clip.sourceStart) ? clip.sourceStart : 0;
  const offset = Math.max(0, Math.min(clip.duration, absolute - clip.startTime));
  return source + offset * speed;
}

function clipAtAbsolute(kind, absolute) {
  for (const lane of cutComparePlan?.lanes || []) {
    for (const clip of lane[kind] || []) {
      const start = clip.startTime;
      const end = start + clip.duration;
      if (absolute >= start - CLIP_EPS && absolute <= end + CLIP_EPS) return clip;
    }
  }
  return null;
}

function sourceTimeForSplit(localTime) {
  const origin = cutComparePlan.origin;
  const absolute = origin + localTime;
  const hit = clipAtAbsolute("split", absolute);
  if (hit) return sourceOnClip(hit, absolute);
  const clips = splitClips();
  if (!clips.length) return 0;
  const next = clips.find((clip) => clip.startTime > absolute + CLIP_EPS);
  if (next) return Number.isFinite(next.sourceStart) ? next.sourceStart : 0;
  const last = clips[clips.length - 1];
  return sourceOnClip(last, last.startTime + last.duration);
}

function localForSplitSource(sourceTime) {
  const origin = cutComparePlan.origin;
  const url = cutComparePlan.previewUrl;
  const clips = splitClips().filter((clip) => !url || clip.sourceUrl === url);
  if (!clips.length) return 0;
  for (const clip of clips) {
    const speed = clip.speed > 0 ? clip.speed : 1;
    const source = Number.isFinite(clip.sourceStart) ? clip.sourceStart : 0;
    const sourceEnd = source + clip.duration * speed;
    const localStart = clip.startTime - origin;
    if (sourceTime < source - CLIP_EPS) return Math.max(0, localStart);
    if (sourceTime <= sourceEnd + CLIP_EPS) {
      return Math.max(0, localStart + (sourceTime - source) / speed);
    }
  }
  const last = clips[clips.length - 1];
  return Math.max(0, (last.startTime - origin) + last.duration);
}

function packedClips() {
  return planClips("packed").sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
}

function sourceTimeForPacked(localTime) {
  const absolute = cutComparePlan.origin + localTime;
  const hit = clipAtAbsolute("packed", absolute);
  if (hit) return sourceOnClip(hit, absolute);
  const clips = packedClips();
  if (!clips.length) return 0;
  const next = clips.find((clip) => clip.startTime > absolute + CLIP_EPS);
  if (next) return Number.isFinite(next.sourceStart) ? next.sourceStart : 0;
  const last = clips[clips.length - 1];
  return sourceOnClip(last, last.startTime + last.duration);
}

function packedLocalForSource(sourceTime) {
  const origin = cutComparePlan.origin;
  const url = cutComparePlan.previewUrl;
  const clips = packedClips().filter((clip) => !url || clip.sourceUrl === url);
  if (!clips.length) return 0;
  for (const clip of clips) {
    const speed = clip.speed > 0 ? clip.speed : 1;
    const source = Number.isFinite(clip.sourceStart) ? clip.sourceStart : 0;
    const sourceEnd = source + clip.duration * speed;
    const localStart = clip.startTime - origin;
    if (sourceTime < source - CLIP_EPS) return Math.max(0, localStart);
    if (sourceTime <= sourceEnd + CLIP_EPS) {
      return Math.max(0, localStart + (sourceTime - source) / speed);
    }
  }
  const last = clips[clips.length - 1];
  return (last.startTime - origin) + last.duration;
}

/** 削除した無音の上では止めず、今の素材の次の有音の先頭へ飛ばす。 */
function packedSourceSkip(sourceTime) {
  const url = cutComparePlan?.previewUrl;
  const clips = packedClips().filter((clip) => !url || clip.sourceUrl === url);
  if (!clips.length) return sourceTime;
  for (const clip of clips) {
    const speed = clip.speed > 0 ? clip.speed : 1;
    const source = Number.isFinite(clip.sourceStart) ? clip.sourceStart : 0;
    const sourceEnd = source + clip.duration * speed;
    if (sourceTime >= source - CLIP_EPS && sourceTime <= sourceEnd + CLIP_EPS) return sourceTime;
  }
  const next = clips.find((clip) => (Number.isFinite(clip.sourceStart) ? clip.sourceStart : 0) > sourceTime + CLIP_EPS);
  if (next) return Number.isFinite(next.sourceStart) ? next.sourceStart : 0;
  const last = clips[clips.length - 1];
  const speed = last.speed > 0 ? last.speed : 1;
  return (Number.isFinite(last.sourceStart) ? last.sourceStart : 0) + last.duration * speed;
}

function placeCutPlayhead(kind) {
  const head = $(kind === "packed" ? "cut-playhead-packed" : "cut-playhead-split");
  if (!head || !cutComparePlan) return;
  head.style.left = `${cutComparePlan.time[kind] * (cutComparePlan.px[kind] || 1)}px`;
}

function markCutActive(kind) {
  $("cut-stage-packed")?.classList.toggle("is-active", kind === "packed");
  $("cut-stage-split")?.classList.toggle("is-active", kind === "split");
}

function clipsUnderCutPlayhead(kind) {
  const plan = cutComparePlan;
  if (!plan) return [];
  const time = plan.origin + (plan.time[kind] || 0);
  return planClips(kind).filter((clip) => playheadCrosses(clip, time));
}

function syncCutSplitButton() {
  const button = $("cut-split-btn");
  const plan = cutComparePlan;
  if (!button || !plan) return;
  button.disabled = !clipsUnderCutPlayhead(plan.active).length;
}

function markCompareSelection() {
  if (!cutComparePlan) return;
  for (const el of document.querySelectorAll("#cut-compare-dialog .cut-dummy")) {
    el.classList.toggle("is-selected", el.dataset.id === cutComparePlan.selectedId);
  }
  syncCutSplitButton();
}

function syncPackedSeek() {
  const bar = $("cut-packed-seek");
  const plan = cutComparePlan;
  if (!bar || !plan) return;
  const span = cutSpan(planClips("packed"), plan.origin);
  const start = plan.origin;
  bar.min = String(start);
  bar.max = String(Math.max(start + span, start + 0.01));
  bar.step = "0.01";
  if (document.activeElement !== bar) bar.value = String(start + Math.min(plan.time.packed, span));
}

function seekCompare(kind, localTime) {
  const plan = cutComparePlan;
  if (!plan) return;
  const span = cutSpan(planClips(kind), plan.origin);
  const time = Math.min(Math.max(0, localTime), span);
  plan.time[kind] = time;
  plan.active = kind;
  placeCutPlayhead(kind);
  markCutActive(kind);
  if (kind === "split" || kind === "packed") syncCutSplitButton();
  syncPackedSeek();
  const video = $("cut-compare-video");
  if (!video) return;
  const absolute = plan.origin + time;
  const hit = clipAtAbsolute(kind, absolute) || planClips(kind).find((clip) => clip.startTime > absolute + CLIP_EPS) || null;
  if (hit?.sourceUrl) plan.previewUrl = hit.sourceUrl;
  const sourceChanged = Boolean(hit?.sourceUrl && video.src !== hit.sourceUrl);
  if (sourceChanged) video.src = hit.sourceUrl;
  const source = kind === "split" ? sourceTimeForSplit(time) : sourceTimeForPacked(time);
  const apply = () => {
    if (!cutComparePlan || cutComparePlan.active !== kind || !$("cut-compare-dialog")?.open) return;
    const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : source;
    const next = Math.min(Math.max(0, source), limit);
    if (Math.abs(video.currentTime - next) < 0.04) return;
    cutCompareSyncing = true;
    video.currentTime = next;
  };
  if (!sourceChanged && video.readyState >= 1) apply();
  else video.addEventListener("loadedmetadata", apply, { once: true });
}

function onCompareVideoTime() {
  if (cutCompareSyncing || !cutComparePlan || !$("cut-compare-dialog")?.open) return;
  const video = $("cut-compare-video");
  const kind = cutComparePlan.active;
  if (kind === "packed" && Number.isFinite(video.currentTime)) {
    const jumped = packedSourceSkip(video.currentTime);
    if (jumped > video.currentTime + 0.05) {
      cutCompareSyncing = true;
      video.currentTime = jumped;
      return;
    }
  }
  const local = kind === "split" ? localForSplitSource(video.currentTime) : packedLocalForSource(video.currentTime);
  const span = cutSpan(planClips(kind), cutComparePlan.origin);
  cutComparePlan.time[kind] = Math.min(Math.max(0, local), span);
  placeCutPlayhead(kind);
  syncCutSplitButton();
  syncPackedSeek();
}

function createCompareHeader(lane) {
  const header = document.createElement("div");
  header.className = "seq-header cut-compare-header";
  header.dataset.trackId = lane.trackId || "";
  const name = document.createElement("span");
  name.className = "seq-header-name";
  name.textContent = lane.name || "トラック";
  header.append(name);
  return header;
}

function fillTimelineClip(el, clip) {
  el.classList.add("seq-clip");
  if (clip.type === "動画") el.classList.add("is-video");
  if (isStillClip(clip)) el.classList.add("is-image");
  if (clip.type === "音声") el.classList.add("is-audio");
  if (clip.type === "テロップ") el.classList.add("is-telop");
  if (clip.kept === false) el.classList.add("is-silence");
  el.title = clip.kept === false ? "無音" : (clip.name || "");
  appendClipEdges(el);
  if (clip.type === "動画" || isStillClip(clip)) {
    const title = document.createElement("div");
    title.className = "seq-clip-title";
    title.textContent = clip.kept === false ? "無音" : clip.name;
    el.append(title);
    appendClipThumb(el, clip);
    if (clip.type === "動画") appendClipWave(el, clip);
  } else if (clip.type === "音声") {
    appendClipWave(el, clip);
  } else {
    const label = document.createElement("span");
    label.className = "tl-label";
    label.textContent = clip.kept === false ? "無音" : (clip.name || "");
    el.append(label);
  }
}

function renderSubRuler(ruler, origin, span, px) {
  if (!ruler) return;
  const major = rulerMajorStep();
  const minor = major / 5;
  const end = origin + span;
  ruler.replaceChildren();
  const epsilon = 0.001;
  const seen = new Set();
  const addTick = (time, forceMajor) => {
    const rounded = Math.round(time * 1000) / 1000;
    if (rounded < origin - epsilon || rounded > end + epsilon) return;
    const key = String(rounded);
    if (seen.has(key)) return;
    seen.add(key);
    const onMajor = Math.abs(rounded / major - Math.round(rounded / major)) < 0.001;
    const isMajor = forceMajor || onMajor;
    const tick = document.createElement("div");
    tick.className = isMajor ? "seq-tick" : "seq-tick is-minor";
    tick.style.left = `${(rounded - origin) * px}px`;
    if (isMajor) {
      const label = document.createElement("span");
      label.textContent = formatRulerLabel(rounded, major);
      tick.append(label);
    }
    ruler.append(tick);
  };
  const startIndex = Math.max(0, Math.floor((origin - epsilon) / minor));
  const endIndex = Math.ceil(end / minor);
  for (let index = startIndex; index <= endIndex; index += 1) {
    addTick(index * minor, false);
  }
  addTick(origin, true);
}

function syncSubZoomSlider(id, px) {
  const slider = $(id);
  if (!slider || document.activeElement === slider || !Number.isFinite(px)) return;
  slider.value = sliderValueForZoom(px);
}

function setCutZoom(kind, nextPx, anchorTime, anchorClientX) {
  const plan = cutComparePlan;
  if (!plan) return;
  const scroll = $(kind === "packed" ? "cut-scroll-packed" : "cut-scroll-split");
  const old = plan.px[kind] > 1 ? plan.px[kind] : PX_PER_SEC;
  const px = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextPx));
  let time = plan.time[kind] || 0;
  let offset = time * old - (scroll?.scrollLeft || 0);
  if (scroll && anchorClientX != null) {
    const rect = scroll.getBoundingClientRect();
    offset = anchorClientX - rect.left;
    time = anchorTime == null ? (scroll.scrollLeft + offset) / old : anchorTime;
  }
  plan.px[kind] = px;
  renderCutLane(kind);
  if (scroll) scroll.scrollLeft = Math.max(0, time * px - offset);
}

function setTelopZoom(nextPx, anchorTime, anchorClientX) {
  const plan = telopPlan;
  if (!plan) return;
  const scroll = $("telop-gen-scroll");
  const old = plan.px > 1 ? plan.px : PX_PER_SEC;
  const px = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextPx));
  let time = plan.time || 0;
  let offset = time * old - (scroll?.scrollLeft || 0);
  if (scroll && anchorClientX != null) {
    const rect = scroll.getBoundingClientRect();
    offset = anchorClientX - rect.left;
    time = anchorTime == null ? (scroll.scrollLeft + offset) / old : anchorTime;
  }
  plan.px = px;
  renderTelopLane();
  if (scroll) scroll.scrollLeft = Math.max(0, time * px - offset);
}

function bindSubZoom(sliderId, scrollId, readPx, writeZoom) {
  const slider = $(sliderId);
  const scroll = $(scrollId);
  if (slider && !slider.dataset.bound) {
    slider.dataset.bound = "1";
    slider.addEventListener("input", () => writeZoom(zoomFromSlider(slider.value)));
  }
  if (scroll && !scroll.dataset.zoom) {
    scroll.dataset.zoom = "1";
    scroll.addEventListener("wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      const px = readPx();
      if (!px) return;
      event.preventDefault();
      const rect = scroll.getBoundingClientRect();
      const time = (scroll.scrollLeft + event.clientX - rect.left) / px;
      const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
      writeZoom(px * factor, time, event.clientX);
    }, { passive: false });
  }
}

function bindSubScissors(headId, onSeek, onSplit) {
  const scissors = $(headId)?.querySelector(".seq-playhead-scissors");
  if (!scissors || scissors.dataset.bound) return;
  scissors.dataset.bound = "1";
  scissors.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const originX = event.clientX;
    const originY = event.clientY;
    let dragged = false;
    trackPointer(scissors, event, (moveEvent) => {
      if (Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) <= 5) return;
      dragged = true;
      scissors.classList.add("is-seeking");
      scissors.textContent = "↔";
      onSeek(moveEvent);
    }, () => {
      scissors.classList.remove("is-seeking");
      scissors.textContent = "✂";
      scissors.title = "この位置で分割";
      if (!dragged) onSplit();
    });
  });
}

function bindSubScroll(scrollId, rulerViewId, headersId) {
  const scroll = $(scrollId);
  const rulerView = $(rulerViewId);
  const headers = $(headersId);
  if (!scroll || scroll.dataset.scrollBound) return;
  scroll.dataset.scrollBound = "1";
  scroll.addEventListener("scroll", () => {
    if (rulerView) rulerView.scrollLeft = scroll.scrollLeft;
    if (headers) headers.scrollTop = scroll.scrollTop;
  });
}

function renderCutLane(kind) {
  const plan = cutComparePlan;
  const host = cutLanesHost(kind);
  const stage = cutStage(kind);
  if (!plan || !host || !stage) return;
  host.replaceChildren();
  const headers = $(kind === "packed" ? "cut-headers-packed" : "cut-headers-split");
  if (headers) {
    headers.replaceChildren();
    for (const lane of plan.lanes) headers.append(createCompareHeader(lane));
  }
  const clips = planClips(kind);
  const span = cutSpan(clips, plan.origin);
  const scroll = stage.parentElement?.parentElement;
  const view = scroll?.clientWidth || 480;
  const px = plan.px[kind] > 1 ? plan.px[kind] : PX_PER_SEC;
  plan.px[kind] = px;
  const width = Math.max(span * px, view);
  stage.style.width = `${width}px`;
  const sheet = stage.parentElement;
  if (sheet) sheet.style.width = `${width}px`;
  for (const lane of plan.lanes) {
    const row = document.createElement("div");
    row.className = "cut-compare-lane";
    row.dataset.kind = kind;
    row.dataset.trackId = lane.trackId;
    if (lane.name) row.title = lane.name;
    const track = document.createElement("div");
    track.className = "cut-compare-track";
    for (const clip of lane[kind]) {
      const el = document.createElement("div");
      el.className = "cut-dummy";
      if (clip.id === plan.selectedId) el.classList.add("is-selected");
      el.dataset.id = clip.id;
      el.style.left = `${(clip.startTime - plan.origin) * px}px`;
      el.style.width = `${Math.max(clip.duration * px, 8)}px`;
      fillTimelineClip(el, clip);
      el.addEventListener("pointerdown", (event) => onCompareClipPointerDown(kind, clip, el, event));
      track.append(el);
    }
    row.style.width = `${width}px`;
    row.append(track);
    host.append(row);
  }
  renderCutRuler(kind);
  placeCutPlayhead(kind);
  syncCutSplitButton();
  if (kind === "packed") syncPackedSeek();
  syncSubZoomSlider(kind === "packed" ? "cut-zoom-packed" : "cut-zoom-split", px);
}

function renderCutRuler(kind) {
  const plan = cutComparePlan;
  const ruler = $(kind === "packed" ? "cut-ruler-packed" : "cut-ruler-split");
  const stage = cutStage(kind);
  if (!plan || !ruler || !stage) return;
  const span = cutSpan(planClips(kind), plan.origin);
  const px = plan.px[kind] || PX_PER_SEC;
  ruler.style.width = stage.style.width;
  renderSubRuler(ruler, plan.origin, span, px);
}

function placeCutClip(el, clip, kind) {
  const px = cutComparePlan.px[kind] || 1;
  el.style.left = `${(clip.startTime - cutComparePlan.origin) * px}px`;
  el.style.width = `${Math.max(clip.duration * px, 8)}px`;
}

function snapSplitEdge(kind, time, clipId, minTime, maxTime) {
  const limit = 12 / (cutComparePlan.px[kind] || 1);
  const targets = [cutComparePlan.origin + cutComparePlan.time[kind]];
  for (const item of planClips(kind)) {
    if (item.id === clipId) continue;
    targets.push(item.startTime, item.startTime + item.duration);
  }
  let best = null;
  for (const target of targets) {
    const delta = target - time;
    if (Math.abs(delta) > limit) continue;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, time: target };
  }
  if (!best) return time;
  const next = time + best.delta;
  if (next < minTime - CLIP_EPS || next > maxTime + CLIP_EPS) return time;
  return next;
}

function onCompareClipPointerDown(kind, clip, el, event) {
  if (event.button !== 0) return;
  const plan = cutComparePlan;
  if (!plan) return;
  event.stopPropagation();
  if (consumeDoubleClick(`compare:${kind}:${clip.id}`, event.detail, () => {
    plan.selectedId = clip.id;
    seekCompare(kind, clip.startTime - plan.origin);
  })) {
    event.preventDefault();
    return;
  }
  plan.selectedId = clip.id;
  if (plan.active !== kind) seekCompare(kind, plan.time[kind] || 0);
  else markCompareSelection();
  const edge = event.target.closest(".tl-edge");
  const originX = event.clientX;
  const originY = event.clientY;
  const pressedAt = performance.now();
  const grab = localTimeFromEvent(event, kind) - (clip.startTime - plan.origin);
  let mode = "press";
  const side = edge?.classList.contains("tl-edge-left") ? "left" : "right";
  const fixedEnd = clip.startTime + clip.duration;
  const fixedStart = clip.startTime;
  const sourceStart = clip.sourceStart;
  trackPointer(el, event, (moveEvent) => {
    const moved = Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY);
    if (mode === "press" && timelineDragStarted(pressedAt, moved)) {
      lastTimelineClick = null;
      mode = edge ? "trim" : "move";
      if (mode === "trim") el.classList.add("is-trimming");
    }
    if (mode === "trim") {
      const pointer = plan.origin + localTimeFromEvent(moveEvent, kind);
      if (side === "left") {
        const raw = Math.min(Math.max(plan.origin, pointer), fixedEnd - MIN_CLIP_SEC);
        const snapped = snapSplitEdge(kind, raw, clip.id, plan.origin, fixedEnd - MIN_CLIP_SEC);
        clip.startTime = snapped;
        clip.duration = fixedEnd - clip.startTime;
        if (Number.isFinite(sourceStart)) clip.sourceStart = sourceStart + (clip.startTime - fixedStart);
      } else {
        const raw = Math.max(pointer, fixedStart + MIN_CLIP_SEC);
        const snapped = snapSplitEdge(kind, raw, clip.id, fixedStart + MIN_CLIP_SEC, Number.POSITIVE_INFINITY);
        clip.duration = snapped - fixedStart;
      }
      placeCutClip(el, clip, kind);
    } else if (mode === "move") {
      const raw = Math.max(plan.origin, plan.origin + localTimeFromEvent(moveEvent, kind) - grab);
      clip.startTime = snapSplitEdge(kind, raw, clip.id, plan.origin, Number.POSITIVE_INFINITY);
      placeCutClip(el, clip, kind);
    }
  }, () => {
    el.classList.remove("is-trimming");
    if (mode === "press") return;
    const lane = laneForClip(kind, clip.id);
    if (lane) {
      const holder = { clips: lane[kind] };
      overwriteTrack(holder, clip.id);
      lane[kind] = holder.clips;
    }
    plan.selectedId = clip.id;
    renderCutLane(kind);
    const local = mode === "trim" && side === "right"
      ? clip.startTime + clip.duration - plan.origin
      : clip.startTime - plan.origin;
    seekCompare(kind, local);
  });
}

function onCutLanePointerDown(kind, event) {
  if (event.button !== 0) return;
  const plan = cutComparePlan;
  if (!plan) return;
  if (plan.active !== kind) {
    seekCompare(kind, plan.time[kind] || 0);
    return;
  }
  if (event.target.closest(".cut-dummy, .seq-playhead-scissors")) return;
  seekCompare(kind, localTimeFromEvent(event, kind));
  trackPointer(event.currentTarget, event, (moveEvent) => {
    seekCompare(kind, localTimeFromEvent(moveEvent, kind));
  });
}

function splitCompareAtPlayhead(kind) {
  const plan = cutComparePlan;
  if (!plan || !$("cut-compare-dialog")?.open) return;
  const side = kind || plan.active;
  const time = plan.origin + (plan.time[side] || 0);
  const crossed = [];
  for (const lane of plan.lanes) {
    for (const clip of lane[side] || []) {
      if (!playheadCrosses(clip, time)) continue;
      crossed.push({ lane, clip });
    }
  }
  const selected = crossed.filter((item) => item.clip.id === plan.selectedId);
  const targets = selected.length ? selected : crossed;
  if (!targets.length) {
    showToast("再生ヘッドがブロックの途中にありません。");
    return;
  }
  const rights = [];
  for (const { lane, clip } of targets) {
    const right = sliceClip(clip, time, clip.startTime + clip.duration - time);
    clip.duration = time - clip.startTime;
    lane[side].push(right);
    lane[side].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
    rights.push(right.id);
  }
  plan.active = side;
  plan.selectedId = rights[0];
  renderCutLane(side);
  seekCompare(side, time - plan.origin);
}

function toggleComparePlayback() {
  const plan = cutComparePlan;
  const video = $("cut-compare-video");
  if (!plan || !video || !$("cut-compare-dialog")?.open) return;
  const kind = plan.active || "split";
  if (!video.paused) {
    video.pause();
    return;
  }
  const span = cutSpan(planClips(kind), plan.origin);
  if (plan.time[kind] >= span - 0.05) seekCompare(kind, 0);
  video.play().catch(() => {});
}

function deleteCompareClip() {
  const plan = cutComparePlan;
  if (!plan?.selectedId || !$("cut-compare-dialog")?.open) return;
  const id = plan.selectedId;
  let removed = false;
  for (const kind of ["packed", "split"]) {
    let changed = false;
    for (const lane of plan.lanes) {
      if (!lane[kind].some((clip) => clip.id === id)) continue;
      lane[kind] = lane[kind].filter((clip) => clip.id !== id);
      changed = true;
      removed = true;
    }
    if (changed) renderCutLane(kind);
  }
  if (!removed) return;
  plan.selectedId = null;
  markCompareSelection();
}

async function analysisForClip(located, profile) {
  const url = located.clip.sourceUrl;
  const cached = url ? silenceResults.get(url) : null;
  if (profile === "silence" && silenceAnalysisReady(cached)) return cached;
  if (profile === "telop" && telopAnalysisReady(cached)) return cached;
  if (!profile && cached) return cached;
  const media = state.media.find((item) => item.url === located.clip.sourceUrl || item.path === located.clip.sourcePath || item.name === located.clip.name);
  const file = await fileFromMedia(media || { name: located.clip.name, url: located.clip.sourceUrl });
  if (!file) {
    showToast("このクリップの動画を読み込めませんでした。");
    return null;
  }
  const ok = await startAnalysis(file, located.clip.id, { timeline: false, profile });
  if (!ok) return null;
  return silenceResults.get(url) || null;
}

function videoClipForSource(url, preferredId) {
  const preferred = findClip(preferredId);
  if (preferred?.clip.type === "動画" && preferred.clip.sourceUrl === url) return preferred;
  for (const track of state.project.tracks) {
    const clip = track.clips.find((item) => item.type === "動画" && item.sourceUrl === url);
    if (clip) return { track, clip };
  }
  return null;
}

async function openCutCompare() {
  const selected = selectedVideoClips();
  if (!selected.length) {
    showToast("比較する動画クリップを選んでください。");
    return;
  }
  const baseline = captureEditorBaseline();
  const abort = (message) => {
    if (message) showToast(message);
    restoreEditorBaseline(baseline);
  };
  const byTrack = new Map();
  for (const item of selected) {
    const sourceUrl = item.clip.sourceUrl;
    if (!sourceUrl) continue;
    let data = silenceResults.get(sourceUrl);
    if (!data) {
      try {
        data = await analysisForClip(item, "silence");
      } catch (error) {
        abort(error.message || "動画を読み込めませんでした。");
        return;
      }
      if (!data) {
        abort();
        return;
      }
    }
    const located = findClip(item.clip.id);
    if (!located) continue;
    const versions = cutCompareVersions(located.clip, data);
    if (!versions?.split.length) continue;
    let lane = byTrack.get(located.track.id);
    if (!lane) {
      lane = {
        trackId: located.track.id,
        name: located.track.name,
        clipIds: [],
        split: [],
        packed: [],
      };
      byTrack.set(located.track.id, lane);
    }
    lane.clipIds.push(located.clip.id);
    lane.split.push(...versions.split);
  }
  const lanes = [];
  for (const track of tracksTopToBottom()) {
    const lane = byTrack.get(track.id);
    if (!lane) continue;
    lane.split.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
    lanes.push(lane);
  }
  if (!lanes.length) {
    abort("このクリップの無音解析結果がまだありません。");
    return;
  }
  packCompareLanes(lanes);
  const sourceStarts = lanes.flatMap((lane) => lane.clipIds
    .map((id) => findClip(id)?.clip.startTime)
    .filter((time) => Number.isFinite(time)));
  const origin = sourceStarts.length
    ? Math.min(...sourceStarts)
    : Math.min(...lanes.flatMap((lane) => lane.split.map((clip) => clip.startTime)));
  const preview = lanes.flatMap((lane) => lane.split).find((clip) => clip.sourceUrl) || null;
  cutCompareBaseline = baseline;
  cutCompareCommitted = false;
  cutComparePlan = {
    lanes,
    active: "split",
    time: { packed: 0, split: 0 },
    selectedId: null,
    px: { packed: 1, split: 1 },
    origin,
    previewUrl: preview?.sourceUrl || "",
  };
  const dialog = $("cut-compare-dialog");
  const clipCount = lanes.reduce((sum, lane) => sum + lane.clipIds.length, 0);
  $("cut-compare-name").textContent = clipCount > 1
    ? `選択した動画 ${clipCount}件・${lanes.length}トラック`
    : (preview?.name || "動画");
  const monitor = previewMonitor();
  if (monitor && !monitor.paused) monitor.pause();
  const video = $("cut-compare-video");
  const sourceUrl = preview?.sourceUrl || "";
  if (sourceUrl && video.src !== sourceUrl) video.src = sourceUrl;
  video.pause();
  if (!dialog.open) dialog.showModal();
  renderCutLane("packed");
  renderCutLane("split");
  seekCompare("split", 0);
}

function applyCutCompare(kind) {
  const plan = cutComparePlan;
  if (!plan?.lanes?.length) return;
  const placed = [];
  let locked = false;
  let changed = false;
  for (const lane of plan.lanes) {
    const track = trackById(lane.trackId);
    if (!track) continue;
    if (track.locked) {
      locked = true;
      continue;
    }
    const ids = new Set(lane.clipIds);
    if (!track.clips.some((clip) => ids.has(clip.id))) continue;
    const pieces = lane[kind] || [];
    track.clips = track.clips.filter((item) => !ids.has(item.id));
    track.clips.push(...pieces);
    track.clips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
    placed.push(...pieces);
    changed = true;
  }
  if (!changed) {
    showToast(locked ? "ロック中のトラックは置き換えできません。" : "適用する区間がありません。");
    return;
  }
  const origin = plan.origin;
  state.selectedClipIds = placed.map((clip) => clip.id);
  cutCompareCommitted = true;
  cutComparePlan = null;
  $("cut-compare-dialog").close();
  renderSequence();
  setCurrentTime(placed[0]?.startTime ?? origin);
  rememberProject(false);
  if (locked) showToast("ロック中のトラックは飛ばして、残りのクリップへ反映しました。");
}

let telopPlan = null;
let telopSyncing = false;

function outputTimeToSource(outputTime, data) {
  const time = Number(outputTime) || 0;
  const ranges = [...(data?.silence_cut?.kept_ranges || [])]
    .filter((range) => Number.isFinite(range.output_start) && Number.isFinite(range.source_start))
    .sort((a, b) => a.output_start - b.output_start);
  if (!ranges.length) return time;
  for (const range of ranges) {
    const outLen = range.output_end - range.output_start;
    if (outLen <= CLIP_EPS) continue;
    const startsHere = Math.abs(time - range.output_start) <= CLIP_EPS;
    const inside = time > range.output_start && time < range.output_end;
    if (startsHere || inside) {
      const ratio = Math.min(1, Math.max(0, (time - range.output_start) / outLen));
      return range.source_start + ratio * (range.source_end - range.source_start);
    }
    if (Math.abs(time - range.output_end) <= CLIP_EPS) {
      const nextStarts = ranges.some((other) => other !== range && Math.abs(other.output_start - time) <= CLIP_EPS);
      if (!nextStarts) return range.source_end;
    }
  }
  if (time < ranges[0].output_start) return ranges[0].source_start;
  return ranges[ranges.length - 1].source_end;
}

function telopGuideLength() {
  const value = Number($("telop-max-chars")?.value);
  return Number.isFinite(value) && value >= 1 ? Math.round(value) : 20;
}

const TELOP_BREAK = /[。、！？!? 　，．]/;

/** 目安の文字数に近い句読点や空白で切る。無ければその文字数で切る。 */
function chunkTelopText(text, target) {
  const chars = [...String(text || "").trim()];
  const limit = Math.max(1, Math.round(target) || 20);
  if (!chars.length) return [];
  if (chars.length <= Math.ceil(limit * 1.2)) return [chars.join("")];
  const chunks = [];
  let start = 0;
  while (start < chars.length) {
    const remain = chars.length - start;
    if (remain <= Math.ceil(limit * 1.2)) {
      const tail = chars.slice(start).join("").trim();
      if (tail) chunks.push(tail);
      break;
    }
    const minCut = start + Math.max(1, Math.floor(limit * 0.5));
    const maxCut = Math.min(chars.length, start + Math.ceil(limit * 1.2));
    let cut = -1;
    let best = Infinity;
    for (let index = minCut; index < maxCut; index += 1) {
      if (!TELOP_BREAK.test(chars[index])) continue;
      const dist = Math.abs(index + 1 - start - limit);
      if (dist < best) {
        best = dist;
        cut = index + 1;
      }
    }
    if (cut < 0) cut = Math.min(chars.length, start + limit);
    const piece = chars.slice(start, cut).join("").trim();
    if (piece) chunks.push(piece);
    start = cut;
    while (start < chars.length && /\s/.test(chars[start])) start += 1;
  }
  return chunks.length ? chunks : [chars.join("")];
}

function telopItemFromSegment(seg, index, data) {
  const variants = {
    original: seg.variants?.original || seg.text || "",
    summary: seg.variants?.summary || seg.variants?.original || seg.text || "",
    impact: seg.variants?.impact || seg.variants?.summary || seg.variants?.original || seg.text || "",
  };
  const ai = variants.summary !== variants.original ? "summary" : "impact";
  const pretty = variants[ai] || variants.original;
  const useAi = Boolean(pretty && pretty !== variants.original);
  const sourceStart = outputTimeToSource(seg.start, data);
  const sourceEnd = Math.max(outputTimeToSource(seg.end, data), sourceStart + 0.05);
  if (!(sourceEnd > sourceStart)) return null;
  return {
    id: seg.id || `seg-${index}`,
    segmentId: seg.id || `seg-${index}`,
    sourceStart,
    sourceEnd,
    variants,
    mode: useAi ? "ai" : "original",
    ai,
    text: useAi ? pretty : variants.original,
    custom: false,
  };
}

function buildTelopItems(segments, data) {
  const target = telopGuideLength();
  const items = [];
  (segments || []).forEach((seg, index) => {
    const base = telopItemFromSegment(seg, index, data);
    if (!base) return;
    const chunks = chunkTelopText(base.text, target);
    if (chunks.length <= 1) {
      items.push(base);
      return;
    }
    const weights = chunks.map((chunk) => Math.max(1, [...chunk].length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const span = base.sourceEnd - base.sourceStart;
    let cursor = base.sourceStart;
    chunks.forEach((chunk, part) => {
      const sourceEnd = part === chunks.length - 1
        ? base.sourceEnd
        : cursor + span * (weights[part] / total);
      items.push({
        ...base,
        id: `${base.id}~${part + 1}`,
        sourceStart: cursor,
        sourceEnd,
        text: chunk,
        mode: "original",
        custom: false,
        variants: { original: chunk, summary: chunk, impact: chunk },
      });
      cursor = sourceEnd;
    });
  });
  return items.filter((item) => item.sourceEnd > item.sourceStart);
}

/** 選択クリップのソース範囲に完全に入るか、重なる部分だけを残す。重なりは範囲内へ切り詰める。 */
function clipTelopItems(items, windows) {
  const next = [];
  for (const item of items || []) {
    let part = 0;
    for (const window of windows || []) {
      const start = Math.max(item.sourceStart, window.start);
      const end = Math.min(item.sourceEnd, window.end);
      if (end - start < 0.05) continue;
      part += 1;
      next.push({
        ...item,
        id: part === 1 ? item.id : `${item.id}~${part}`,
        segmentId: item.segmentId || item.id,
        sourceStart: start,
        sourceEnd: end,
      });
    }
  }
  return next;
}

function mergeWindows(windows) {
  const sorted = (windows || [])
    .filter((window) => window && window.end - window.start > CLIP_EPS)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end + 0.02) last.end = Math.max(last.end, window.end);
    else merged.push({ start: window.start, end: window.end });
  }
  return merged;
}

/** タイムライン上の startTime から duration までに対応する、素材上の範囲。他のクリップには広げない。 */
function clipSourceWindow(located) {
  const clip = located.clip;
  const speed = clipSpeed(clip);
  return { start: sourceOrigin(clip), end: sourceOrigin(clip) + clip.duration * speed };
}

function telopSpan(plan) {
  const fromItems = plan.items.reduce((max, item) => Math.max(max, item.sourceEnd), 0);
  return Math.max(fromItems, Number(plan.sourceDuration) || 0, 0.001);
}

function telopItemSpan(item) {
  const plan = telopPlan;
  if (!plan || !item) return null;
  if (Number.isFinite(item.timelineStart) && Number.isFinite(item.timelineEnd) && item.timelineEnd > item.timelineStart) {
    return { start: item.timelineStart, end: item.timelineEnd };
  }
  const start = timelineTimeForPlanSource(item.sourceStart, plan, item.sourceUrl);
  if (start == null) return null;
  let end = timelineTimeForPlanSource(item.sourceEnd, plan, item.sourceUrl);
  if (end == null || end < start) end = start + Math.max(0.05, item.sourceEnd - item.sourceStart);
  return { start, end };
}

function telopViewSpan(plan) {
  let end = plan.origin || 0;
  for (const item of plan.items || []) {
    const span = telopItemSpan(item);
    if (span) end = Math.max(end, span.end);
  }
  return Math.max(end - (plan.origin || 0), 0.001);
}

function sourceTimeForTelopLocal(local) {
  const plan = telopPlan;
  if (!plan) return 0;
  const absolute = (plan.origin || 0) + local;
  for (const id of plan.clipIds || []) {
    const located = findClip(id);
    if (!located) continue;
    const clip = located.clip;
    if (absolute < clip.startTime - CLIP_EPS || absolute > clip.startTime + clip.duration + CLIP_EPS) continue;
    plan.previewUrl = clip.sourceUrl || plan.previewUrl;
    return sourceOrigin(clip) + Math.max(0, absolute - clip.startTime) * clipSpeed(clip);
  }
  return plan.items[0]?.sourceStart || 0;
}

function familyPieces(clip, track) {
  const family = track.clips.filter((item) => item.type === "動画" && item.sourceUrl && item.sourceUrl === clip.sourceUrl);
  return family.length ? family : [clip];
}

function sourceRangeOf(piece, pieces) {
  if (Number.isFinite(piece.sourceStart)) {
    const speed = piece.speed > 0 ? piece.speed : 1;
    return { start: piece.sourceStart, end: piece.sourceStart + piece.duration * speed };
  }
  const origin = Math.min(...pieces.map((item) => item.startTime));
  return { start: piece.startTime - origin, end: piece.startTime - origin + piece.duration };
}

function timelineTimeForSource(sourceTime, clip, track) {
  const pieces = familyPieces(clip, track);
  for (const piece of pieces) {
    const range = sourceRangeOf(piece, pieces);
    if (sourceTime >= range.start - 0.02 && sourceTime <= range.end + 0.02) {
      const speed = piece.speed > 0 ? piece.speed : 1;
      const into = sourceTime - range.start;
      return piece.startTime + (Number.isFinite(piece.sourceStart) ? into / speed : into);
    }
  }
  const range = sourceRangeOf(clip, pieces);
  return clip.startTime + (sourceTime - range.start);
}

function timelineTimeForPlanSource(sourceTime, plan, sourceUrl) {
  const url = sourceUrl || plan.sourceUrl;
  for (const id of plan.clipIds || []) {
    const located = findClip(id);
    if (!located || located.clip.type !== "動画" || located.clip.sourceUrl !== url) continue;
    const range = clipSourceWindow(located);
    if (sourceTime < range.start - 0.02 || sourceTime > range.end + 0.02) continue;
    const into = sourceTime - range.start;
    return located.clip.startTime + into / clipSpeed(located.clip);
  }
  return null;
}

function sourceTrackForTelopItem(item, plan, fallbackTrack) {
  const url = item.sourceUrl || plan.sourceUrl;
  const sourceTime = Number(item.sourceStart);
  for (const id of plan.clipIds || []) {
    const located = findClip(id);
    if (!located || located.clip.type !== "動画") continue;
    if (url && located.clip.sourceUrl !== url) continue;
    const range = clipSourceWindow(located);
    if (sourceTime < range.start - 0.02 || sourceTime > range.end + 0.02) continue;
    return located.track;
  }
  return fallbackTrack;
}

/** 配列の先頭が画面の一番上。対象映像のすぐ上は、ひとつ前の映像トラック。 */
function videoTrackAbove(track) {
  const videos = state.project.tracks.filter((item) => item.type === "video");
  const index = videos.findIndex((item) => item.id === track?.id);
  if (index <= 0) return null;
  return videos[index - 1];
}

function trackOverlapsRanges(track, ranges) {
  if (!track) return true;
  return (ranges || []).some((range) => track.clips.some((clip) =>
    clip.startTime < range.end - CLIP_EPS && clip.startTime + clip.duration > range.start + CLIP_EPS
  ));
}

function insertVideoTrackAbove(track) {
  const created = createTrack("video", nextTrackLabel("video"));
  const index = track ? state.project.tracks.indexOf(track) : 0;
  state.project.tracks.splice(index < 0 ? 0 : index, 0, created);
  renumberTracks();
  return created;
}

/** 対象映像のすぐ上を使う。無いか、重なるクリップがあるときは、その直前に新しい映像トラックを作る。 */
function ensureTelopTrack(videoTrack, ranges) {
  const above = videoTrackAbove(videoTrack);
  if (above && !above.locked && !trackOverlapsRanges(above, ranges)) return above;
  return insertVideoTrackAbove(videoTrack);
}

function telopClipName(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "テロップ";
  return flat.length <= 18 ? flat : `${flat.slice(0, 18)}…`;
}

function placeTelopPlayhead() {
  const head = $("telop-gen-playhead");
  if (!head || !telopPlan) return;
  head.style.left = `${telopPlan.time * (telopPlan.px || 1)}px`;
}

function setTelopCaption(text) {
  const caption = $("telop-gen-caption");
  if (caption) caption.textContent = text || "";
}

function markTelopSelection() {
  const plan = telopPlan;
  if (!plan) return;
  for (const row of document.querySelectorAll("#telop-gen-list .telop-row")) {
    row.classList.toggle("is-selected", row.dataset.id === plan.selectedId);
  }
  for (const block of document.querySelectorAll("#telop-gen-lanes .cut-dummy")) {
    block.classList.toggle("is-selected", block.dataset.id === plan.selectedId);
  }
}

function refreshTelopLabel(id) {
  const item = telopPlan?.items.find((entry) => entry.id === id);
  const block = document.querySelector(`#telop-gen-lanes .cut-dummy[data-id="${id}"] .tl-label`);
  if (item && block) block.textContent = item.text.trim() || "（空）";
}

function seekTelop(localTime) {
  const plan = telopPlan;
  if (!plan) return;
  const span = telopViewSpan(plan);
  const time = Math.min(Math.max(0, localTime), span);
  plan.time = time;
  placeTelopPlayhead();
  const video = $("telop-gen-video");
  if (!video) return;
  const source = sourceTimeForTelopLocal(time);
  const url = plan.previewUrl || plan.sourceUrl || "";
  const sourceChanged = Boolean(url && video.src !== url);
  if (sourceChanged) video.src = url;
  const apply = () => {
    if (!telopPlan || !$("telop-gen-dialog")?.open) return;
    const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : source;
    const next = Math.min(Math.max(0, source), limit);
    if (Math.abs(video.currentTime - next) < 0.04) return;
    telopSyncing = true;
    video.currentTime = next;
  };
  if (!sourceChanged && video.readyState >= 1) apply();
  else video.addEventListener("loadedmetadata", apply, { once: true });
}

function selectTelopItem(id, seek) {
  const plan = telopPlan;
  if (!plan) return;
  const item = plan.items.find((entry) => entry.id === id);
  if (!item) return;
  plan.selectedId = id;
  markTelopSelection();
  setTelopCaption(item.text);
  const row = document.querySelector(`#telop-gen-list .telop-row[data-id="${id}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
  if (seek) {
    const span = telopItemSpan(item);
    if (span) seekTelop(span.start - (plan.origin || 0));
  }
}

function syncTelopChoice(row, item) {
  for (const button of row.querySelectorAll(".telop-choice")) {
    const selected = button.dataset.mode === item.mode;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
  for (const button of row.querySelectorAll(".telop-ai-mode")) {
    const selected = item.mode === "ai" && button.dataset.ai === item.ai;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
}

function renderTelopList() {
  const plan = telopPlan;
  const list = $("telop-gen-list");
  if (!plan || !list) return;
  list.replaceChildren();
  for (const item of plan.items) {
    const row = document.createElement("article");
    row.className = "telop-row";
    row.dataset.id = item.id;

    const choices = document.createElement("div");
    choices.className = "telop-choices";

    const original = document.createElement("button");
    original.type = "button";
    original.className = "telop-choice";
    original.dataset.mode = "original";
    const originalTitle = document.createElement("strong");
    originalTitle.textContent = "そのままの言葉";
    const originalBody = document.createElement("span");
    originalBody.textContent = item.variants.original || "（空）";
    original.append(originalTitle, originalBody);

    const aiCol = document.createElement("div");
    aiCol.className = "telop-ai-col";
    const pretty = document.createElement("button");
    pretty.type = "button";
    pretty.className = "telop-choice";
    pretty.dataset.mode = "ai";
    const prettyTitle = document.createElement("strong");
    prettyTitle.textContent = "綺麗な正しいテロップを生成";
    const prettyBody = document.createElement("span");
    prettyBody.textContent = item.variants[item.ai] || item.variants.original || "（空）";
    pretty.append(prettyTitle, prettyBody);
    const aiModes = document.createElement("div");
    aiModes.className = "telop-ai-modes";
    aiModes.setAttribute("role", "group");
    aiModes.setAttribute("aria-label", "綺麗な正しいテロップを生成");
    for (const [value, label] of [["summary", "要約"], ["impact", "インパクト"]]) {
      const mode = document.createElement("button");
      mode.type = "button";
      mode.className = "telop-ai-mode";
      mode.dataset.ai = value;
      mode.textContent = label;
      mode.addEventListener("click", (event) => {
        event.stopPropagation();
        item.ai = value;
        prettyBody.textContent = item.variants[item.ai] || item.variants.original || "（空）";
        applyChoice("ai");
      });
      aiModes.append(mode);
    }
    aiCol.append(pretty, aiModes);
    choices.append(original, aiCol);

    const field = document.createElement("label");
    field.className = "telop-text";
    field.append("表示する文言");
    const area = document.createElement("textarea");
    area.value = item.text;
    area.rows = 2;
    field.append(area);

    const applyChoice = (mode) => {
      item.mode = mode;
      item.custom = false;
      item.text = mode === "original" ? item.variants.original : (item.variants[item.ai] || item.variants.original);
      area.value = item.text;
      prettyBody.textContent = item.variants[item.ai] || item.variants.original || "（空）";
      syncTelopChoice(row, item);
      refreshTelopLabel(item.id);
      selectTelopItem(item.id, true);
    };
    original.addEventListener("click", () => applyChoice("original"));
    pretty.addEventListener("click", () => applyChoice("ai"));
    area.addEventListener("focus", () => selectTelopItem(item.id, plan.selectedId !== item.id));
    area.addEventListener("input", () => {
      item.text = area.value;
      item.custom = true;
      refreshTelopLabel(item.id);
      if (plan.selectedId === item.id) setTelopCaption(item.text);
    });
    row.addEventListener("click", (event) => {
      if (event.target.closest("button, select, textarea, label")) return;
      selectTelopItem(item.id, true);
    });

    row.append(choices, field);
    list.append(row);
    syncTelopChoice(row, item);
  }
}

function buildTelopLanes(clipIds, items) {
  const byTrack = new Map();
  const lookup = { clipIds, sourceUrl: "" };
  for (const id of clipIds) {
    const located = findClip(id);
    if (!located) continue;
    if (!byTrack.has(located.track.id)) {
      byTrack.set(located.track.id, {
        trackId: located.track.id,
        name: located.track.name,
        clipIds: [],
        items: [],
      });
    }
    byTrack.get(located.track.id).clipIds.push(id);
  }
  const lanes = [];
  for (const track of tracksTopToBottom()) {
    const lane = byTrack.get(track.id);
    if (lane) lanes.push(lane);
  }
  for (const item of items) {
    const track = sourceTrackForTelopItem(item, lookup, null);
    const lane = (track && byTrack.get(track.id)) || lanes[0];
    if (!lane) continue;
    item.laneTrackId = lane.trackId;
    lane.items.push(item);
  }
  return lanes;
}

function syncTelopItemsFromLanes() {
  const plan = telopPlan;
  if (!plan?.lanes) return;
  plan.items = plan.lanes.flatMap((lane) => lane.items);
}

function setTelopTimeline(item, start, end) {
  const prev = telopItemSpan(item);
  if (!prev) return;
  const prevDur = Math.max(0.05, prev.end - prev.start);
  const sourceDur = Math.max(0.05, item.sourceEnd - item.sourceStart);
  const nextStart = start;
  const nextEnd = Math.max(end, start + 0.05);
  const map = (time) => item.sourceStart + ((time - prev.start) / prevDur) * sourceDur;
  const sourceStart = map(nextStart);
  item.sourceStart = sourceStart;
  item.sourceEnd = Math.max(sourceStart + 0.05, map(nextEnd));
  item.timelineStart = nextStart;
  item.timelineEnd = nextEnd;
}

function cloneTelopItem(item, id) {
  return {
    ...item,
    id,
    variants: { ...(item.variants || {}) },
  };
}

function overwriteTelopLane(lane, activeId) {
  const active = lane.items.find((item) => item.id === activeId);
  if (!active) return;
  const a = telopItemSpan(active);
  if (!a) return;
  const next = [active];
  for (const item of [...lane.items]) {
    if (item.id === activeId) continue;
    const b = telopItemSpan(item);
    if (!b || b.end <= a.start + CLIP_EPS || b.start >= a.end - CLIP_EPS) {
      next.push(item);
      continue;
    }
    if (b.start >= a.start - CLIP_EPS && b.end <= a.end + CLIP_EPS) continue;
    if (b.start < a.start - CLIP_EPS && b.end > a.end + CLIP_EPS) {
      const right = cloneTelopItem(item, nextClipId());
      setTelopTimeline(item, b.start, a.start);
      setTelopTimeline(right, a.end, b.end);
      if (item.timelineEnd - item.timelineStart > CLIP_EPS) next.push(item);
      if (right.timelineEnd - right.timelineStart > CLIP_EPS) next.push(right);
      continue;
    }
    if (b.start < a.start) {
      setTelopTimeline(item, b.start, a.start);
      if (item.timelineEnd - item.timelineStart > CLIP_EPS) next.push(item);
      continue;
    }
    setTelopTimeline(item, a.end, b.end);
    if (item.timelineEnd - item.timelineStart > CLIP_EPS) next.push(item);
  }
  lane.items = next.sort((left, right) => {
    const aSpan = telopItemSpan(left);
    const bSpan = telopItemSpan(right);
    return (aSpan?.start || 0) - (bSpan?.start || 0) || left.id.localeCompare(right.id);
  });
}

function placeTelopBlock(el, item) {
  const plan = telopPlan;
  const span = telopItemSpan(item);
  const px = plan?.px || 1;
  if (!plan || !span) return;
  el.style.left = `${(span.start - plan.origin) * px}px`;
  el.style.width = `${Math.max((span.end - span.start) * px, 8)}px`;
}

function snapTelopEdge(time, itemId, minTime, maxTime) {
  const plan = telopPlan;
  const limit = 12 / (plan?.px || 1);
  const targets = [plan.origin + plan.time];
  for (const item of plan.items || []) {
    if (item.id === itemId) continue;
    const span = telopItemSpan(item);
    if (!span) continue;
    targets.push(span.start, span.end);
  }
  let best = null;
  for (const target of targets) {
    const delta = target - time;
    if (Math.abs(delta) > limit) continue;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, time: target };
  }
  if (!best) return time;
  const next = time + best.delta;
  if (next < minTime - CLIP_EPS || next > maxTime + CLIP_EPS) return time;
  return next;
}

function telopLocalFromEvent(event) {
  const stage = $("telop-gen-time-stage");
  const px = telopPlan?.px || 1;
  if (!stage) return 0;
  return Math.max(0, (event.clientX - stage.getBoundingClientRect().left) / px);
}

function onTelopClipPointerDown(lane, item, el, event) {
  if (event.button !== 0 || !telopPlan) return;
  event.stopPropagation();
  const plan = telopPlan;
  const span = telopItemSpan(item);
  if (!span) return;
  if (consumeDoubleClick(`telop:${item.id}`, event.detail, () => {
    selectTelopItem(item.id, false);
    seekTelop(span.start - plan.origin);
  })) {
    event.preventDefault();
    return;
  }
  selectTelopItem(item.id, false);
  const edge = event.target.closest(".tl-edge");
  const originX = event.clientX;
  const originY = event.clientY;
  const pressedAt = performance.now();
  const grab = telopLocalFromEvent(event) - (span.start - plan.origin);
  const fixedEnd = span.end;
  const fixedStart = span.start;
  let mode = "press";
  const side = edge?.classList.contains("tl-edge-left") ? "left" : "right";
  trackPointer(el, event, (moveEvent) => {
    const moved = Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY);
    if (mode === "press" && timelineDragStarted(pressedAt, moved)) {
      lastTimelineClick = null;
      mode = edge ? "trim" : "move";
      if (mode === "trim") el.classList.add("is-trimming");
    }
    if (mode === "trim") {
      const pointer = plan.origin + telopLocalFromEvent(moveEvent);
      if (side === "left") {
        const raw = Math.min(Math.max(plan.origin, pointer), fixedEnd - MIN_CLIP_SEC);
        const snapped = snapTelopEdge(raw, item.id, plan.origin, fixedEnd - MIN_CLIP_SEC);
        setTelopTimeline(item, snapped, fixedEnd);
      } else {
        const raw = Math.max(pointer, fixedStart + MIN_CLIP_SEC);
        const snapped = snapTelopEdge(raw, item.id, fixedStart + MIN_CLIP_SEC, Number.POSITIVE_INFINITY);
        setTelopTimeline(item, fixedStart, snapped);
      }
      placeTelopBlock(el, item);
    } else if (mode === "move") {
      const duration = fixedEnd - fixedStart;
      const raw = Math.max(plan.origin, plan.origin + telopLocalFromEvent(moveEvent) - grab);
      const snapped = snapTelopEdge(raw, item.id, plan.origin, Number.POSITIVE_INFINITY);
      setTelopTimeline(item, snapped, snapped + duration);
      placeTelopBlock(el, item);
    }
  }, () => {
    el.classList.remove("is-trimming");
    if (mode === "press") {
      selectTelopItem(item.id, true);
      return;
    }
    overwriteTelopLane(lane, item.id);
    syncTelopItemsFromLanes();
    plan.selectedId = item.id;
    renderTelopList();
    renderTelopLane();
    const next = telopItemSpan(item);
    if (next) seekTelop(next.start - plan.origin);
  });
}

function renderTelopLane() {
  const plan = telopPlan;
  const host = $("telop-gen-lanes");
  const sheet = $("telop-gen-sheet");
  const stage = $("telop-gen-time-stage");
  const ruler = $("telop-gen-ruler");
  const headers = $("telop-gen-headers");
  if (!plan || !host || !stage) return;
  host.replaceChildren();
  const origin = plan.origin || 0;
  const span = telopViewSpan(plan);
  const scroll = $("telop-gen-scroll");
  const view = scroll?.clientWidth || 480;
  const px = plan.px > 1 ? plan.px : PX_PER_SEC;
  plan.px = px;
  const width = Math.max(span * px, view);
  if (stage) stage.style.width = `${width}px`;
  if (sheet) sheet.style.width = `${width}px`;
  if (ruler) ruler.style.width = `${width}px`;
  renderSubRuler(ruler, origin, span, px);
  const lanes = plan.lanes?.length ? plan.lanes : [{
    trackId: plan.trackId || "",
    name: "テロップ",
    items: plan.items || [],
  }];
  if (headers) {
    headers.replaceChildren();
    for (const lane of lanes) headers.append(createCompareHeader(lane));
  }
  for (const lane of lanes) {
    const row = document.createElement("div");
    row.className = "cut-compare-lane";
    row.dataset.trackId = lane.trackId || "";
    if (lane.name) row.title = lane.name;
    const track = document.createElement("div");
    track.className = "cut-compare-track";
    for (const item of lane.items || []) {
      const range = telopItemSpan(item);
      if (!range) continue;
      const el = document.createElement("div");
      el.className = "cut-dummy";
      if (item.id === plan.selectedId) el.classList.add("is-selected");
      el.dataset.id = item.id;
      el.style.left = `${(range.start - origin) * px}px`;
      el.style.width = `${Math.max((range.end - range.start) * px, 8)}px`;
      fillTimelineClip(el, { type: "テロップ", name: item.text.trim() || "（空）", kept: true });
      el.addEventListener("pointerdown", (event) => onTelopClipPointerDown(lane, item, el, event));
      track.append(el);
    }
    row.style.width = `${width}px`;
    row.append(track);
    host.append(row);
  }
  placeTelopPlayhead();
  syncSubZoomSlider("telop-gen-zoom", px);
}

function splitTelopAtPlayhead() {
  const plan = telopPlan;
  if (!plan || !$("telop-gen-dialog")?.open) return;
  const time = (plan.origin || 0) + (plan.time || 0);
  const crossed = [];
  for (const lane of plan.lanes || []) {
    for (const item of lane.items || []) {
      const span = telopItemSpan(item);
      if (!span || time <= span.start + CLIP_EPS || time >= span.end - CLIP_EPS) continue;
      crossed.push({ lane, item, span });
    }
  }
  const selected = crossed.filter((entry) => entry.item.id === plan.selectedId);
  const targets = selected.length ? selected : crossed;
  if (!targets.length) {
    showToast("再生ヘッドがブロックの途中にありません。");
    return;
  }
  const rights = [];
  for (const { lane, item, span } of targets) {
    const right = cloneTelopItem(item, nextClipId());
    setTelopTimeline(item, span.start, time);
    setTelopTimeline(right, time, span.end);
    right.laneTrackId = item.laneTrackId || lane.trackId;
    lane.items.push(right);
    rights.push(right.id);
    lane.items.sort((left, other) => (telopItemSpan(left)?.start || 0) - (telopItemSpan(other)?.start || 0));
  }
  syncTelopItemsFromLanes();
  plan.selectedId = rights[0];
  renderTelopList();
  renderTelopLane();
  seekTelop(time - (plan.origin || 0));
}

function onTelopLanePointerDown(event) {
  if (event.button !== 0 || !telopPlan) return;
  if (event.target.closest(".cut-dummy, .seq-playhead-scissors")) return;
  const stage = $("telop-gen-time-stage");
  const local = Math.max(0, (event.clientX - stage.getBoundingClientRect().left) / (telopPlan.px || 1));
  const absolute = (telopPlan.origin || 0) + local;
  const hit = telopPlan.items.find((item) => {
    const range = telopItemSpan(item);
    return range && absolute >= range.start && absolute < range.end;
  });
  if (hit) selectTelopItem(hit.id, false);
  seekTelop(local);
}

function onTelopVideoTime() {
  if (telopSyncing || !telopPlan || !$("telop-gen-dialog")?.open) return;
  const video = $("telop-gen-video");
  const mapped = timelineTimeForPlanSource(video.currentTime, telopPlan, telopPlan.previewUrl || telopPlan.sourceUrl);
  const local = mapped == null
    ? Math.min(Math.max(0, video.currentTime), telopViewSpan(telopPlan))
    : Math.max(0, mapped - (telopPlan.origin || 0));
  const time = Math.min(local, telopViewSpan(telopPlan));
  telopPlan.time = time;
  placeTelopPlayhead();
  if (document.activeElement?.closest?.("#telop-gen-list textarea")) return;
  const absolute = (telopPlan.origin || 0) + time;
  const hit = telopPlan.items.find((item) => {
    const range = telopItemSpan(item);
    return range && absolute >= range.start && absolute < range.end;
  });
  if (hit && hit.id !== telopPlan.selectedId) selectTelopItem(hit.id, false);
}

function selectedVideoClips() {
  const found = [];
  for (const id of state.selectedClipIds) {
    const located = findClip(id);
    if (located?.clip.type === "動画" && located.clip.sourceUrl) found.push(located);
  }
  return found;
}

function toggleTelopPlayback() {
  const plan = telopPlan;
  const video = $("telop-gen-video");
  if (!plan || !video || !$("telop-gen-dialog")?.open) return;
  if (!video.paused) {
    video.pause();
    return;
  }
  if (plan.time >= telopViewSpan(plan) - 0.05) seekTelop(0);
  video.play().catch(() => {});
}

async function openTelopGenerate() {
  const selected = selectedVideoClips();
  if (!selected.length) {
    showToast("テロップを作る動画クリップを選んでください。");
    return;
  }
  const baseline = captureEditorBaseline();
  const abort = (message) => {
    if (message) showToast(message);
    restoreEditorBaseline(baseline);
  };
  const groups = new Map();
  for (const item of selected) {
    const url = item.clip.sourceUrl;
    if (!url) continue;
    if (!groups.has(url)) groups.set(url, []);
    groups.get(url).push(item);
  }
  if (!groups.size) {
    showToast("このクリップの動画を表示できません。");
    return;
  }
  const items = [];
  const clipIds = [];
  let first = null;
  let firstData = null;
  for (const [url, targets] of groups) {
    let data = silenceResults.get(url);
    if (!buildTelopItems(data?.segments, data).length) {
      try {
        data = await analysisForClip(targets[0], "telop");
      } catch (error) {
        abort(error.message || "動画を読み込めませんでした。");
        return;
      }
      if (!data) {
        abort();
        return;
      }
    }
    const fresh = targets.map((item) => findClip(item.clip.id)).filter(Boolean);
    if (!fresh.length) continue;
    const windows = mergeWindows(fresh.map((item) => clipSourceWindow(item)));
    const scoped = clipTelopItems(buildTelopItems(data?.segments, data), windows)
      .map((item) => ({ ...item, sourceUrl: url }));
    items.push(...scoped);
    clipIds.push(...fresh.map((item) => item.clip.id));
    if (!first) {
      first = fresh[0];
      firstData = data;
    }
  }
  if (!items.length || !first) {
    abort("この範囲に重なる文字起こしがありません。");
    return;
  }
  const starts = clipIds
    .map((id) => findClip(id)?.clip.startTime)
    .filter((time) => Number.isFinite(time));
  const origin = starts.length ? Math.min(...starts) : first.clip.startTime;
  const lanes = buildTelopLanes(clipIds, items);
  telopGenBaseline = baseline;
  telopGenCommitted = false;
  telopPlan = {
    clipId: first.clip.id,
    clipIds,
    trackId: first.track.id,
    sourceUrl: first.clip.sourceUrl,
    previewUrl: first.clip.sourceUrl,
    data: firstData,
    items,
    lanes,
    selectedId: items[0].id,
    time: 0,
    px: PX_PER_SEC,
    origin,
    sourceDuration: Math.max(...items.map((item) => item.sourceEnd), 0.001),
  };
  const dialog = $("telop-gen-dialog");
  $("telop-gen-name").textContent = clipIds.length > 1
    ? `選択した動画 ${clipIds.length}件・${lanes.length}トラック`
    : (first.clip.name || "動画");
  const monitor = previewMonitor();
  if (monitor && !monitor.paused) monitor.pause();
  const video = $("telop-gen-video");
  if (video.src !== first.clip.sourceUrl) video.src = first.clip.sourceUrl;
  if (!dialog.open) dialog.showModal();
  renderTelopList();
  renderTelopLane();
  selectTelopItem(items[0].id, true);
}

function applyTelopGenerate() {
  const plan = telopPlan;
  if (!plan) return;
  const located = findClip(plan.clipId);
  if (!located) {
    showToast("元のクリップが見つかりません。");
    return;
  }
  const usable = plan.items.filter((item) => item.text.trim());
  if (!usable.length) {
    showToast("表示するテロップがありません。");
    return;
  }
  const pieces = [];
  for (const item of usable) {
    const text = item.text.trim();
    const span = telopItemSpan(item);
    if (!span) continue;
    const sourceTrack = trackById(item.laneTrackId) || sourceTrackForTelopItem(item, plan, located.track);
    const piece = createClip({
      type: "テロップ",
      name: telopClipName(text),
      startTime: span.start,
      duration: Math.max(span.end - span.start, 0.05),
      sourceUrl: "",
    });
    piece.text = text;
    piece.style = cloneTelopStyle(state.style);
    applyTelopBox(piece, text, piece.style.font_size);
    piece.segmentId = item.id;
    pieces.push({ piece, sourceTrack });
  }
  if (!pieces.length) {
    showToast("この範囲に置けるテロップがありません。");
    return;
  }
  for (const item of plan.items) {
    const seg = (plan.data?.segments || []).find((entry) => entry.id === (item.segmentId || item.id));
    if (!seg) continue;
    seg.variants = { ...seg.variants, ...item.variants };
    if (item.custom) {
      seg.variants.custom = item.text.trim();
      seg.selected_variant = "custom";
    } else {
      seg.selected_variant = item.mode === "original" ? "original" : item.ai;
    }
  }
  if (result === plan.data) {
    state.segments = (plan.data.segments || []).map((seg) => ({
      ...seg,
      selected_variant: seg.selected_variant || "original",
    }));
  }
  const groups = new Map();
  for (const entry of pieces) {
    const track = entry.sourceTrack || located.track;
    if (!groups.has(track.id)) groups.set(track.id, { track, pieces: [] });
    groups.get(track.id).pieces.push(entry.piece);
  }
  const dests = [];
  const placed = [];
  for (const group of groups.values()) {
    const ranges = group.pieces.map((clip) => ({ start: clip.startTime, end: clip.startTime + clip.duration }));
    const dest = ensureTelopTrack(group.track, ranges);
    dest.clips.push(...group.pieces);
    dest.clips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
    dests.push(dest);
    placed.push(...group.pieces);
  }
  const destNames = [...new Set(dests.map((track) => track.name))];
  state.selectedClipIds = [placed[0].id];
  telopGenCommitted = true;
  telopPlan = null;
  $("telop-gen-dialog").close();
  renderSequence();
  syncPropertyPanel();
  setCurrentTime(placed[0].startTime);
  showToast(destNames.length === 1
    ? `テロップを「${destNames[0]}」に追加しました。`
    : "テロップを追加しました。");
  rememberProject(false);
}

const TELOP_FONTS = ["Noto Sans JP", "Yu Gothic", "Meiryo", "sans-serif"];
const TELOP_ANIMATIONS = [
  ["none", "なし"],
  ["fade", "フェード"],
  ["pop", "ポップ"],
];
const BUILTIN_TELOP_PRESETS = [
  { id: "builtin-standard", name: "標準（白文字・黒縁）", style: {} },
  { id: "builtin-game", name: "ゲーム実況（黄色・太縁）", style: { font_size: 80, primary_color: "#FFE600", outline_width: 8 } },
  {
    id: "builtin-news",
    name: "ニュース風（背景ボックス）",
    style: { font_size: 52, bold: false, background_enabled: true, background_color: "#0B1F4D", background_opacity: 0.85 },
  },
];

let telopEditPlan = null;
let telopEditSyncing = false;
let localPresetSerial = 1;

function cloneTelopStyle(style) {
  return {
    ...DEFAULT_STYLE,
    ...(style || {}),
    animation: style?.animation || "none",
  };
}

function telopPresetChoices() {
  const saved = state.presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    style: cloneTelopStyle(preset.style),
  }));
  const fromApi = saved.filter((preset) => !String(preset.id).startsWith("local-preset-"));
  if (fromApi.length) return fromApi;
  const locals = saved.filter((preset) => String(preset.id).startsWith("local-preset-"));
  const builtins = BUILTIN_TELOP_PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    style: cloneTelopStyle(preset.style),
  }));
  return [...builtins, ...locals];
}

function fontStack(name) {
  if (!name || name === "sans-serif") return "sans-serif";
  return `"${name}", "Yu Gothic", "Meiryo", sans-serif`;
}

function paintTelopCaption(el, text, style, animate) {
  if (!el) return;
  const look = cloneTelopStyle(style);
  if (!el.classList.contains("is-editing")) el.textContent = text || "";
  const frame = el.closest(".telop-gen-stage, .preview-canvas");
  const frameH = frame?.clientHeight || 320;
  const scale = frameH / (state.project.height || 1080);
  el.style.fontFamily = fontStack(look.font_family);
  el.style.fontSize = `${Math.max(14, look.font_size * scale)}px`;
  el.style.fontWeight = look.bold ? "700" : "400";
  el.style.color = look.primary_color || "#FFFFFF";
  const shadows = outlineShadows(Math.max(0, look.outline_width) * scale, look.outline_color || "#000000");
  el.style.textShadow = shadows.length ? shadows.join(", ") : "none";
  if (look.background_enabled) {
    el.style.background = hexToRgba(look.background_color || "#000000", look.background_opacity ?? 0.6);
    el.style.padding = "2px 8px";
    el.style.borderRadius = "6px";
  } else {
    el.style.background = "transparent";
    el.style.padding = "0";
    el.style.borderRadius = "0";
  }
  el.classList.remove("telop-anim-fade", "telop-anim-pop");
  if (!animate || look.animation === "none") return;
  void el.offsetWidth;
  el.classList.add(look.animation === "pop" ? "telop-anim-pop" : "telop-anim-fade");
}

function rangesOverlap(a0, a1, b0, b1) {
  return a0 < b1 - CLIP_EPS && b0 < a1 - CLIP_EPS;
}

function telopsOverlapping(start, end) {
  const found = [];
  for (const track of state.project.tracks) {
    for (const clip of track.clips) {
      if (clip.type !== "テロップ") continue;
      if (rangesOverlap(clip.startTime, clip.startTime + clip.duration, start, end)) found.push(clip);
    }
  }
  return found.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
}

function videoOverlappingTelop(telop) {
  let best = null;
  let bestOverlap = 0;
  for (const track of state.project.tracks) {
    for (const clip of track.clips) {
      if (clip.type !== "動画" || clip.kept === false) continue;
      const start = Math.max(telop.startTime, clip.startTime);
      const end = Math.min(telop.startTime + telop.duration, clip.startTime + clip.duration);
      if (end - start > bestOverlap) {
        bestOverlap = end - start;
        best = { track, clip };
      }
    }
  }
  return best;
}

function timelineToSourceTime(timelineTime, clip, track) {
  const pieces = familyPieces(clip, track);
  for (const piece of pieces) {
    if (timelineTime >= piece.startTime - 0.02 && timelineTime <= piece.startTime + piece.duration + 0.02) {
      const range = sourceRangeOf(piece, pieces);
      return range.start + (timelineTime - piece.startTime);
    }
  }
  const range = sourceRangeOf(clip, pieces);
  return range.start + (timelineTime - clip.startTime);
}

function telopEditSpan() {
  const plan = telopEditPlan;
  if (!plan) return 0.001;
  const end = plan.items.reduce((max, item) => Math.max(max, item.startTime + item.duration), plan.origin);
  return Math.max(end - plan.origin, 0.001);
}

function placeTelopEditPlayhead() {
  const head = $("telop-edit-playhead");
  if (!head || !telopEditPlan) return;
  head.style.left = `${(telopEditPlan.time - telopEditPlan.origin) * (telopEditPlan.px || 1)}px`;
}

function selectedTelopEditItem() {
  const plan = telopEditPlan;
  if (!plan) return null;
  return plan.items.find((entry) => entry.clipId === plan.selectedId) || null;
}

function copyTelopLayout(clip) {
  const layout = {
    x: clip.x,
    y: clip.y,
    scale: clip.scale,
    rotation: clip.rotation,
    width: clip.width,
    height: clip.height,
    baseWidth: clip.baseWidth,
    baseHeight: clip.baseHeight,
  };
  ensureClipLayout(layout);
  return layout;
}

function placeTelopEditFrame(item) {
  const frame = $("telop-edit-frame");
  const stage = $("telop-edit-stage");
  if (!frame) return;
  if (!item || !stage) {
    frame.hidden = true;
    return;
  }
  ensureClipLayout(item);
  frame.hidden = false;
  const { sx, sy } = canvasUnits(stage);
  const x = (Number(item.x) || 0) * sx;
  const y = (Number(item.y) || 0) * sy;
  frame.style.width = `${Math.max(item.width * sx, 24)}px`;
  frame.style.height = `${Math.max(item.height * sy, 24)}px`;
  frame.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotate(${Number(item.rotation) || 0}deg)`;
}

function syncTelopLayoutFields(item, row) {
  if (!item) return;
  const target = row || document.querySelector(`#telop-edit-list .telop-edit-row[data-id="${item.clipId}"]`);
  if (!target) return;
  styleFieldLock = true;
  for (const [key, value] of [["scale", item.scale], ["x", item.x], ["y", item.y]]) {
    const input = target.querySelector(`[data-layout="${key}"]`);
    if (!input || document.activeElement === input) continue;
    input.value = fieldText(value, 1);
  }
  styleFieldLock = false;
}

function readTelopLayoutFields(row, item) {
  ensureClipLayout(item);
  const input = (key) => row.querySelector(`[data-layout="${key}"]`);
  const scale = input("scale");
  const x = input("x");
  const y = input("y");
  if (scale && scale.value.trim() !== "") setClipScale(item, Number(scale.value));
  if (x && x.value.trim() !== "" && x.value !== "-") item.x = Number(x.value);
  if (y && y.value.trim() !== "" && y.value !== "-") item.y = Number(y.value);
}

function showTelopEditGuides(snap) {
  const guideX = $("telop-edit-guide-x");
  const guideY = $("telop-edit-guide-y");
  if (!guideX || !guideY) return;
  const xAt = { center: "50%", left: "0", right: "100%" };
  const yAt = { center: "50%", top: "0", bottom: "100%" };
  guideX.hidden = !snap?.xGuide;
  guideY.hidden = !snap?.yGuide;
  if (snap?.xGuide) guideX.style.left = xAt[snap.xGuide];
  if (snap?.yGuide) guideY.style.top = yAt[snap.yGuide];
}

function startTelopEditMove(item, event) {
  const stage = $("telop-edit-stage");
  ensureClipLayout(item);
  const { sx, sy } = canvasUnits(stage);
  const startX = item.x;
  const startY = item.y;
  const originX = event.clientX;
  const originY = event.clientY;
  trackPointer(event.currentTarget, event, (moveEvent) => {
    const rawX = startX + (moveEvent.clientX - originX) / sx;
    const rawY = startY + (moveEvent.clientY - originY) / sy;
    const snapped = snapClipPosition(item, rawX, rawY, stage);
    item.x = snapped.x;
    item.y = snapped.y;
    placeTelopEditFrame(item);
    syncTelopLayoutFields(item);
    showTelopEditGuides(snapped);
  }, () => {
    showTelopEditGuides(null);
  });
}

function startTelopEditScale(item, event) {
  const stage = $("telop-edit-stage");
  ensureClipLayout(item);
  const center = clipCenterScreen(item, stage);
  const startDist = Math.max(8, Math.hypot(event.clientX - center.x, event.clientY - center.y));
  const startScale = item.scale;
  trackPointer(event.currentTarget, event, (moveEvent) => {
    const dist = Math.hypot(moveEvent.clientX - center.x, moveEvent.clientY - center.y);
    setClipScale(item, startScale * dist / startDist);
    placeTelopEditFrame(item);
    syncTelopLayoutFields(item);
  }, () => {});
}

function startTelopEditRotate(item, event) {
  const stage = $("telop-edit-stage");
  ensureClipLayout(item);
  const center = clipCenterScreen(item, stage);
  const startAngle = Math.atan2(event.clientY - center.y, event.clientX - center.x);
  const startRotation = Number(item.rotation) || 0;
  trackPointer(event.currentTarget, event, (moveEvent) => {
    const angle = Math.atan2(moveEvent.clientY - center.y, moveEvent.clientX - center.x);
    item.rotation = startRotation + (angle - startAngle) * 180 / Math.PI;
    placeTelopEditFrame(item);
  }, () => {});
}

function bindTelopEditGestures() {
  const frame = $("telop-edit-frame");
  const stage = $("telop-edit-stage");
  if (!frame || !stage || frame.dataset.bound) return;
  frame.dataset.bound = "1";
  frame.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const item = selectedTelopEditItem();
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.target.closest("[data-handle]")?.dataset.handle;
    if (handle === "rotate") startTelopEditRotate(item, event);
    else if (handle) startTelopEditScale(item, event);
    else startTelopEditMove(item, event);
  });
  new ResizeObserver(() => {
    if (!$("telop-edit-dialog")?.open) return;
    placeTelopEditFrame(selectedTelopEditItem());
  }).observe(stage);
}

function paintTelopEditCaption(animate) {
  const plan = telopEditPlan;
  const item = plan?.items.find((entry) => entry.clipId === plan.selectedId);
  paintTelopCaption($("telop-edit-caption"), item?.text || "", item?.style, animate);
  placeTelopEditFrame(item);
  if (item) syncTelopLayoutFields(item);
}

function markTelopEditSelection() {
  const plan = telopEditPlan;
  if (!plan) return;
  for (const row of document.querySelectorAll("#telop-edit-list .telop-edit-row")) {
    row.classList.toggle("is-selected", row.dataset.id === plan.selectedId);
  }
  for (const block of document.querySelectorAll("#telop-edit-track .cut-dummy")) {
    block.classList.toggle("is-selected", block.dataset.id === plan.selectedId);
  }
}

function seekTelopEdit(timelineTime) {
  const plan = telopEditPlan;
  if (!plan) return;
  const end = plan.origin + telopEditSpan();
  plan.time = Math.min(Math.max(plan.origin, timelineTime), end);
  placeTelopEditPlayhead();
  const video = $("telop-edit-video");
  const located = findClip(plan.videoClipId);
  if (!video || !located) return;
  const source = timelineToSourceTime(plan.time, located.clip, located.track);
  const apply = () => {
    if (!telopEditPlan || !$("telop-edit-dialog")?.open) return;
    const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : source;
    const next = Math.min(Math.max(0, source), limit);
    if (Math.abs(video.currentTime - next) < 0.04) return;
    telopEditSyncing = true;
    video.currentTime = next;
  };
  if (video.readyState >= 1) apply();
  else video.addEventListener("loadedmetadata", apply, { once: true });
}

function selectTelopEdit(id, seek) {
  const plan = telopEditPlan;
  if (!plan || !plan.items.some((item) => item.clipId === id)) return;
  plan.selectedId = id;
  markTelopEditSelection();
  const item = plan.items.find((entry) => entry.clipId === id);
  paintTelopEditCaption(true);
  const row = document.querySelector(`#telop-edit-list .telop-edit-row[data-id="${id}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
  if (seek && item) seekTelopEdit(item.startTime);
}

function markPresetButtons(row, item) {
  for (const button of row.querySelectorAll("[data-preset]")) {
    const on = button.dataset.preset === item.presetId;
    button.classList.toggle("is-selected", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

let styleFieldLock = false;

function writeTelopStyleFields(row, item) {
  styleFieldLock = true;
  const style = item.style;
  const font = row.querySelector('[data-style="font_family"]');
  const size = row.querySelector('[data-style="font_size"]');
  const color = row.querySelector('[data-style="primary_color"]');
  const outline = row.querySelector('[data-style="outline_color"]');
  const outlineWidth = row.querySelector('[data-style="outline_width"]');
  const bold = row.querySelector('[data-style="bold"]');
  const background = row.querySelector('[data-style="background_enabled"]');
  const animation = row.querySelector('[data-style="animation"]');
  if (font) font.value = TELOP_FONTS.includes(style.font_family) ? style.font_family : TELOP_FONTS[0];
  if (size) size.value = String(style.font_size);
  if (color) color.value = String(style.primary_color || "#ffffff").slice(0, 7).toLowerCase();
  if (outline) outline.value = String(style.outline_color || "#000000").slice(0, 7).toLowerCase();
  if (outlineWidth) outlineWidth.value = String(style.outline_width);
  if (bold) bold.checked = Boolean(style.bold);
  if (background) background.checked = Boolean(style.background_enabled);
  if (animation) animation.value = style.animation || "none";
  styleFieldLock = false;
}

function readTelopStyleFields(row, item) {
  const style = item.style;
  const value = (key) => row.querySelector(`[data-style="${key}"]`);
  style.font_family = value("font_family")?.value || style.font_family;
  style.font_size = Math.min(160, Math.max(12, Number(value("font_size")?.value) || style.font_size));
  style.primary_color = value("primary_color")?.value || style.primary_color;
  style.outline_color = value("outline_color")?.value || style.outline_color;
  style.outline_width = Math.min(16, Math.max(0, Number(value("outline_width")?.value) || 0));
  style.bold = Boolean(value("bold")?.checked);
  style.background_enabled = Boolean(value("background_enabled")?.checked);
  style.animation = value("animation")?.value || "none";
}

function renderTelopEditList() {
  const plan = telopEditPlan;
  const list = $("telop-edit-list");
  if (!plan || !list) return;
  list.replaceChildren();
  const presets = telopPresetChoices();
  for (const item of plan.items) {
    const row = document.createElement("article");
    row.className = "telop-edit-row";
    row.dataset.id = item.clipId;
    const text = document.createElement("p");
    text.className = "telop-edit-text";
    text.textContent = telopClipName(item.text);
    text.title = item.text;

    const controls = document.createElement("div");
    controls.className = "telop-edit-controls";
    const addField = (key, label, control) => {
      const wrap = document.createElement("label");
      wrap.append(label);
      control.dataset.style = key;
      wrap.append(control);
      controls.append(wrap);
      return control;
    };
    const font = document.createElement("select");
    for (const name of TELOP_FONTS) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name === "sans-serif" ? "サンセリフ" : name;
      font.append(option);
    }
    addField("font_family", "フォント", font);
    const size = document.createElement("input");
    size.type = "number";
    size.min = "12";
    size.max = "160";
    size.step = "1";
    addField("font_size", "サイズ", size);
    const color = document.createElement("input");
    color.type = "color";
    addField("primary_color", "文字色", color);
    const outline = document.createElement("input");
    outline.type = "color";
    addField("outline_color", "縁の色", outline);
    const outlineWidth = document.createElement("input");
    outlineWidth.type = "number";
    outlineWidth.min = "0";
    outlineWidth.max = "16";
    outlineWidth.step = "0.5";
    addField("outline_width", "縁の太さ", outlineWidth);
    const animation = document.createElement("select");
    for (const [value, label] of TELOP_ANIMATIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      animation.append(option);
    }
    addField("animation", "動き", animation);
    const addLayout = (key, label, min, max, step) => {
      const input = document.createElement("input");
      input.type = "number";
      input.min = min;
      input.max = max;
      input.step = step;
      input.dataset.layout = key;
      const wrap = document.createElement("label");
      wrap.append(label, input);
      controls.append(wrap);
      return input;
    };
    addLayout("scale", "スケール（%）", "1", "400", "1");
    addLayout("x", "X座標", "-4000", "4000", "1");
    addLayout("y", "Y座標", "-4000", "4000", "1");
    const boldWrap = document.createElement("label");
    boldWrap.className = "telop-edit-check";
    const bold = document.createElement("input");
    bold.type = "checkbox";
    bold.dataset.style = "bold";
    boldWrap.append(bold, "太字");
    const backgroundWrap = document.createElement("label");
    backgroundWrap.className = "telop-edit-check";
    const background = document.createElement("input");
    background.type = "checkbox";
    background.dataset.style = "background_enabled";
    backgroundWrap.append(background, "背景");
    controls.append(boldWrap, backgroundWrap);

    const presetBox = document.createElement("div");
    presetBox.className = "telop-edit-presets";
    for (const preset of presets) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.preset = preset.id;
      button.textContent = preset.name;
      button.addEventListener("click", () => {
        item.style = cloneTelopStyle(preset.style);
        item.presetId = preset.id;
        writeTelopStyleFields(row, item);
        markPresetButtons(row, item);
        selectTelopEdit(item.clipId, true);
      });
      presetBox.append(button);
    }
    controls.append(presetBox);
    row.append(text, controls);
    writeTelopStyleFields(row, item);
    syncTelopLayoutFields(item, row);
    markPresetButtons(row, item);

    const onEdit = (event) => {
      if (styleFieldLock) return;
      if (event.target.dataset.layout) {
        readTelopLayoutFields(row, item);
        if (plan.selectedId === item.clipId) placeTelopEditFrame(item);
        return;
      }
      readTelopStyleFields(row, item);
      item.presetId = "";
      markPresetButtons(row, item);
      if (plan.selectedId === item.clipId) paintTelopEditCaption(true);
      else selectTelopEdit(item.clipId, true);
    };
    for (const input of controls.querySelectorAll("input, select")) {
      input.addEventListener("input", onEdit);
      input.addEventListener("focus", () => {
        if (plan.selectedId !== item.clipId) selectTelopEdit(item.clipId, true);
      });
    }
    row.addEventListener("click", (event) => {
      if (event.target.closest("input, select, button, label")) return;
      selectTelopEdit(item.clipId, true);
    });
    list.append(row);
  }
  markTelopEditSelection();
}

function renderTelopEditLane() {
  const plan = telopEditPlan;
  const track = $("telop-edit-track");
  const lane = $("telop-edit-lane");
  if (!plan || !track || !lane) return;
  track.replaceChildren();
  const span = telopEditSpan();
  const view = lane.parentElement?.clientWidth || 480;
  const px = Math.max(8, Math.min(48, view / span));
  plan.px = px;
  lane.style.width = `${Math.max(span * px, view)}px`;
  for (const item of plan.items) {
    const el = document.createElement("div");
    el.className = "cut-dummy is-telop";
    if (item.clipId === plan.selectedId) el.classList.add("is-selected");
    el.dataset.id = item.clipId;
    el.style.left = `${(item.startTime - plan.origin) * px}px`;
    el.style.width = `${Math.max(item.duration * px, 8)}px`;
    const label = document.createElement("span");
    label.className = "tl-label";
    label.textContent = telopClipName(item.text);
    el.append(label);
    el.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      selectTelopEdit(item.clipId, true);
    });
    track.append(el);
  }
  placeTelopEditPlayhead();
}

function onTelopEditLanePointerDown(event) {
  if (event.button !== 0 || !telopEditPlan) return;
  if (event.target.closest(".cut-dummy")) return;
  const lane = $("telop-edit-lane");
  const local = Math.max(0, (event.clientX - lane.getBoundingClientRect().left) / (telopEditPlan.px || 1));
  const time = telopEditPlan.origin + local;
  const hit = telopEditPlan.items.find((item) => time >= item.startTime && time < item.startTime + item.duration);
  if (hit) selectTelopEdit(hit.clipId, false);
  seekTelopEdit(time);
}

function onTelopEditVideoTime() {
  if (telopEditSyncing || !telopEditPlan || !$("telop-edit-dialog")?.open) return;
  const located = findClip(telopEditPlan.videoClipId);
  const video = $("telop-edit-video");
  if (!located || !video) return;
  const timeline = timelineTimeForSource(video.currentTime, located.clip, located.track);
  const end = telopEditPlan.origin + telopEditSpan();
  telopEditPlan.time = Math.min(Math.max(telopEditPlan.origin, timeline), end);
  placeTelopEditPlayhead();
  if (document.activeElement?.closest?.("#telop-edit-list input, #telop-edit-list select, #telop-edit-list textarea")) return;
  const hit = telopEditPlan.items.find((item) => telopEditPlan.time >= item.startTime && telopEditPlan.time < item.startTime + item.duration);
  if (hit && hit.clipId !== telopEditPlan.selectedId) selectTelopEdit(hit.clipId, false);
}

function openTelopEdit() {
  const scoped = [];
  for (const id of state.selectedClipIds) {
    const located = findClip(id);
    if (!located) continue;
    if (located.clip.type !== "テロップ" && located.clip.type !== "動画") continue;
    scoped.push(located);
  }
  if (!scoped.length) {
    showToast("編集するテロップを選ぶか、テロップのある動画を選んでください。");
    return;
  }
  const seen = new Set();
  const telops = [];
  const addTelop = (clip) => {
    if (!clip || clip.type !== "テロップ" || seen.has(clip.id)) return;
    seen.add(clip.id);
    telops.push(clip);
  };
  for (const item of scoped) {
    if (item.clip.type === "テロップ") addTelop(item.clip);
  }
  for (const item of scoped) {
    if (item.clip.type !== "動画") continue;
    const start = item.clip.startTime;
    const end = start + item.clip.duration;
    for (const clip of telopsOverlapping(start, end)) addTelop(clip);
  }
  telops.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  const videoItem = scoped.find((item) => item.clip.type === "動画") || videoOverlappingTelop(scoped[0].clip);
  const video = videoItem?.clip?.type === "動画" ? videoItem : null;
  const selectedTelop = scoped.find((item) => item.clip.type === "テロップ");
  const selectedId = (selectedTelop && telops.some((clip) => clip.id === selectedTelop.clip.id) ? selectedTelop.clip.id : null) || telops[0]?.id || null;
  if (!telops.length || !selectedId) {
    showToast("この範囲にテロップがありません。");
    return;
  }
  const items = telops.map((clip) => ({
    clipId: clip.id,
    text: clip.text || clip.name || "テロップ",
    startTime: clip.startTime,
    duration: clip.duration,
    style: cloneTelopStyle(clip.style),
    presetId: clip.presetId || "",
    ...copyTelopLayout(clip),
  }));
  telopEditPlan = {
    videoClipId: video?.clip.id || "",
    items,
    selectedId,
    origin: Math.min(...items.map((item) => item.startTime)),
    time: items.find((item) => item.clipId === selectedId)?.startTime || items[0].startTime,
    px: 1,
  };
  $("telop-edit-name").textContent = video?.clip.name || scoped[0].clip.name || "テロップ";
  const monitor = previewMonitor();
  if (monitor && !monitor.paused) monitor.pause();
  const preview = $("telop-edit-video");
  const sourceUrl = video?.clip.sourceUrl || "";
  if (sourceUrl && preview.src !== sourceUrl) preview.src = sourceUrl;
  const dialog = $("telop-edit-dialog");
  if (!dialog.open) dialog.showModal();
  renderTelopEditList();
  renderTelopEditLane();
  selectTelopEdit(selectedId, true);
}

async function saveTelopEditPreset() {
  const plan = telopEditPlan;
  const item = plan?.items.find((entry) => entry.clipId === plan.selectedId);
  if (!item) {
    showToast("保存するテロップを選んでください。");
    return;
  }
  const name = $("telop-edit-preset-name").value.trim();
  if (!name) {
    showToast("プリセット名を入力してください。");
    return;
  }
  const style = cloneTelopStyle(item.style);
  try {
    if (state.connected) {
      const preset = await apiJson("/style-presets", "POST", { name, style });
      state.presets.push(preset);
      item.presetId = preset.id;
      showToast(`プリセット「${name}」を保存しました。`);
    } else {
      throw new Error("offline");
    }
  } catch (error) {
    if (error.message !== "offline") {
      showToast(error.message);
      return;
    }
    const preset = { id: `local-preset-${localPresetSerial}`, name, style };
    localPresetSerial += 1;
    state.presets.push(preset);
    item.presetId = preset.id;
    showToast(`プリセット「${name}」を一覧に追加しました。`);
  }
  $("telop-edit-preset-name").value = "";
  renderTelopEditList();
  renderTelopEditLane();
  selectTelopEdit(item.clipId, false);
}

function applyTelopEdit() {
  const plan = telopEditPlan;
  if (!plan) return;
  let wrote = 0;
  let skipped = 0;
  for (const item of plan.items) {
    const located = findClip(item.clipId);
    if (!located || located.clip.type !== "テロップ") continue;
    if (located.track.locked) {
      skipped += 1;
      continue;
    }
    located.clip.style = cloneTelopStyle(item.style);
    located.clip.presetId = item.presetId || "";
    located.clip.x = item.x;
    located.clip.y = item.y;
    located.clip.rotation = item.rotation || 0;
    located.clip.scale = item.scale;
    located.clip.width = item.width;
    located.clip.height = item.height;
    located.clip.baseWidth = item.baseWidth;
    located.clip.baseHeight = item.baseHeight;
    wrote += 1;
  }
  if (!wrote) {
    showToast(skipped ? "ロック中のトラックには見た目を書き込めません。" : "テロップのスタイルを書き込めませんでした。");
    return;
  }
  const selected = plan.selectedId;
  const chosen = plan.items.find((item) => item.clipId === selected);
  telopEditPlan = null;
  $("telop-edit-dialog").close();
  renderSequence();
  if (findClip(selected)) state.selectedClipIds = [selected];
  syncPropertyPanel();
  if (chosen) setCurrentTime(chosen.startTime);
  showToast(skipped ? "ロック中のトラックは飛ばして、残りのテロップへ反映しました。" : "テロップの見た目と位置を反映しました。");
  rememberProject(false);
}

function bindToolTabs() {
  for (const group of document.querySelectorAll(".tool-group")) {
    for (const tab of group.querySelectorAll("[role='tab']")) {
      tab.addEventListener("click", () => selectToolTab(group, tab));
    }
  }

  $("cut-silence-btn").addEventListener("click", () => {
    cutSelectedClip();
  });
  $("cut-compare-btn").addEventListener("click", () => {
    openCutCompare().catch((error) => showToast(error.message || "比較画面を開けませんでした。"));
  });
  $("cut-apply-packed").addEventListener("click", () => applyCutCompare("packed"));
  $("cut-apply-split").addEventListener("click", () => applyCutCompare("split"));
  $("cut-split-btn").addEventListener("click", splitCompareAtPlayhead);
  $("cut-stage-packed").addEventListener("pointerdown", (event) => onCutLanePointerDown("packed", event));
  $("cut-stage-split").addEventListener("pointerdown", (event) => onCutLanePointerDown("split", event));
  const packedRow = $("cut-stage-packed")?.closest(".cut-compare-row-main");
  if (packedRow && !$("cut-packed-seek")) {
    const bar = document.createElement("input");
    bar.type = "range";
    bar.id = "cut-packed-seek";
    bar.className = "cut-packed-seek";
    bar.min = "0";
    bar.max = "1";
    bar.step = "0.01";
    bar.value = "0";
    bar.setAttribute("aria-label", "自動削除版の再生位置");
    packedRow.append(bar);
    bar.addEventListener("input", () => {
      if (!cutComparePlan) return;
      seekCompare("packed", Number(bar.value) - (cutComparePlan.origin || 0));
    });
  }
  const compareVideo = $("cut-compare-video");
  compareVideo.addEventListener("timeupdate", onCompareVideoTime);
  compareVideo.addEventListener("seeked", () => {
    cutCompareSyncing = false;
    onCompareVideoTime();
  });
  $("cut-compare-dialog").addEventListener("close", () => {
    compareVideo.pause();
    cutCompareSyncing = false;
    if (!cutCompareCommitted && cutCompareBaseline) restoreEditorBaseline(cutCompareBaseline);
    cutCompareBaseline = null;
    cutCompareCommitted = false;
    cutComparePlan = null;
  });
  bindSubScroll("cut-scroll-packed", "cut-ruler-view-packed", "cut-headers-packed");
  bindSubScroll("cut-scroll-split", "cut-ruler-view-split", "cut-headers-split");
  bindSubScroll("telop-gen-scroll", "telop-gen-ruler-view", "telop-gen-headers");
  bindSubZoom("cut-zoom-packed", "cut-scroll-packed", () => cutComparePlan?.px?.packed || PX_PER_SEC, (px, time, clientX) => setCutZoom("packed", px, time, clientX));
  bindSubZoom("cut-zoom-split", "cut-scroll-split", () => cutComparePlan?.px?.split || PX_PER_SEC, (px, time, clientX) => setCutZoom("split", px, time, clientX));
  bindSubZoom("telop-gen-zoom", "telop-gen-scroll", () => telopPlan?.px || PX_PER_SEC, (px, time, clientX) => setTelopZoom(px, time, clientX));
  bindSubScissors("cut-playhead-packed", (event) => seekCompare("packed", localTimeFromEvent(event, "packed")), () => splitCompareAtPlayhead("packed"));
  bindSubScissors("cut-playhead-split", (event) => seekCompare("split", localTimeFromEvent(event, "split")), () => splitCompareAtPlayhead("split"));
  bindSubScissors("telop-gen-playhead", (event) => seekTelop(telopLocalFromEvent(event)), splitTelopAtPlayhead);
  $("telop-generate-btn").addEventListener("click", () => {
    openTelopGenerate().catch((error) => showToast(error.message || "テロップ生成を開けませんでした。"));
  });
  $("telop-gen-apply").addEventListener("click", applyTelopGenerate);
  $("telop-gen-time-stage").addEventListener("pointerdown", onTelopLanePointerDown);
  const telopVideo = $("telop-gen-video");
  telopVideo.addEventListener("timeupdate", onTelopVideoTime);
  telopVideo.addEventListener("seeked", () => {
    telopSyncing = false;
    onTelopVideoTime();
  });
  $("telop-gen-dialog").addEventListener("close", () => {
    telopVideo.pause();
    telopSyncing = false;
    if (!telopGenCommitted && telopGenBaseline) restoreEditorBaseline(telopGenBaseline);
    telopGenBaseline = null;
    telopGenCommitted = false;
    telopPlan = null;
  });
  $("telop-settings-toggle").addEventListener("click", () => {
    const panel = $("telop-settings-panel");
    const open = panel.hidden;
    panel.hidden = !open;
    $("telop-settings-toggle").classList.toggle("is-active", open);
    $("telop-settings-toggle").setAttribute("aria-expanded", open ? "true" : "false");
  });
  $("telop-settings-btn").addEventListener("click", () => {
    const count = telopGuideLength();
    $("telop-max-chars").value = String(count);
    showToast(`テロップは${count}文字を目安に分けます。`);
  });
  $("telop-edit-btn").addEventListener("click", openTelopEdit);
  $("telop-edit-apply").addEventListener("click", applyTelopEdit);
  $("telop-edit-save").addEventListener("click", saveTelopEditPreset);
  $("telop-edit-lane").addEventListener("pointerdown", onTelopEditLanePointerDown);
  const editVideo = $("telop-edit-video");
  editVideo.addEventListener("timeupdate", onTelopEditVideoTime);
  editVideo.addEventListener("seeked", () => {
    telopEditSyncing = false;
    onTelopEditVideoTime();
  });
  $("telop-edit-dialog").addEventListener("close", () => {
    editVideo.pause();
    telopEditSyncing = false;
    showTelopEditGuides(null);
  });
  bindTelopEditGestures();
}

const projectHistory = {
  stack: [],
  index: -1,
  coalesce: false,
  applying: false,
};

function captureProject() {
  return {
    project: structuredClone(state.project),
    selectedClipIds: [...state.selectedClipIds],
    currentTime: state.currentTime,
  };
}

function captureEditorBaseline() {
  return {
    snap: captureProject(),
    historyIndex: projectHistory.index,
    result,
    segments: structuredClone(state.segments || []),
    threshold: state.threshold,
    exportDisabled: $("export-btn")?.disabled ?? true,
    fileName: $("file-name")?.textContent || "",
    cutInfo: $("cut-info")?.textContent || "",
  };
}

function restoreEditorBaseline(baseline) {
  if (!baseline) return;
  projectHistory.stack.splice(Math.max(0, baseline.historyIndex + 1));
  if (projectHistory.stack[baseline.historyIndex]) {
    projectHistory.stack[baseline.historyIndex] = structuredClone(baseline.snap);
  }
  projectHistory.index = Math.max(0, Math.min(baseline.historyIndex, projectHistory.stack.length - 1));
  projectHistory.coalesce = false;
  result = baseline.result;
  state.segments = baseline.segments;
  state.threshold = baseline.threshold;
  if ($("export-btn")) $("export-btn").disabled = baseline.exportDisabled;
  if ($("file-name")) $("file-name").textContent = baseline.fileName;
  if ($("cut-info")) $("cut-info").textContent = baseline.cutInfo;
  restoreProjectSnapshot(baseline.snap);
}

function syncHistoryButtons() {
  const undo = $("undo-btn");
  const redo = $("redo-btn");
  if (undo) undo.disabled = projectHistory.index <= 0;
  if (redo) redo.disabled = projectHistory.index < 0 || projectHistory.index >= projectHistory.stack.length - 1;
}

function seedProjectHistory() {
  projectHistory.stack = [captureProject()];
  projectHistory.index = 0;
  projectHistory.coalesce = false;
  syncHistoryButtons();
}

function rememberProject(coalesce) {
  if (projectHistory.applying) return;
  const snap = captureProject();
  const prev = projectHistory.stack[projectHistory.index];
  if (!coalesce && prev && JSON.stringify(prev.project) === JSON.stringify(snap.project)) return;
  if (coalesce && projectHistory.coalesce && projectHistory.index >= 0) {
    projectHistory.stack[projectHistory.index] = snap;
    syncHistoryButtons();
    return;
  }
  if (projectHistory.index < projectHistory.stack.length - 1) {
    projectHistory.stack.splice(projectHistory.index + 1);
  }
  projectHistory.stack.push(snap);
  if (projectHistory.stack.length > 60) {
    projectHistory.stack.shift();
    projectHistory.index = projectHistory.stack.length - 1;
  } else {
    projectHistory.index += 1;
  }
  projectHistory.coalesce = Boolean(coalesce);
  syncHistoryButtons();
}

function restoreProjectSnapshot(snap) {
  projectHistory.applying = true;
  projectHistory.coalesce = false;
  state.project = structuredClone(snap.project);
  state.selectedClipIds = Array.isArray(snap.selectedClipIds)
    ? snap.selectedClipIds.filter(Boolean)
    : (snap.selectedClipId ? [snap.selectedClipId] : []);
  state.currentTime = snap.currentTime;
  projectHistory.applying = false;
  renderSequence();
  syncPropertyPanel();
  fitPreviewCanvas();
  setCurrentTime(state.currentTime);
  syncHistoryButtons();
}

function undoProject() {
  if (projectHistory.index <= 0) return;
  const monitor = previewMonitor();
  if (monitor && !monitor.paused) monitor.pause();
  projectHistory.index -= 1;
  restoreProjectSnapshot(projectHistory.stack[projectHistory.index]);
}

function redoProject() {
  if (projectHistory.index >= projectHistory.stack.length - 1) return;
  const monitor = previewMonitor();
  if (monitor && !monitor.paused) monitor.pause();
  projectHistory.index += 1;
  restoreProjectSnapshot(projectHistory.stack[projectHistory.index]);
}

function formatTimecode(seconds) {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remain = safe % 60;
  return [hours, minutes, remain].map((part) => String(part).padStart(2, "0")).join(":");
}

function aspectKeyForProject() {
  const width = state.project.width || 1920;
  const height = state.project.height || 1080;
  const ratio = width / height;
  const options = [
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["4:3", 4 / 3],
    ["3:4", 3 / 4],
    ["1:1", 1],
  ];
  for (const [key, value] of options) {
    if (Math.abs(ratio - value) < 0.02) return key;
  }
  return "custom";
}

let scrubbingPreview = false;

function syncPreviewControls() {
  const seek = $("preview-seek");
  const label = $("preview-time");
  const play = $("preview-play");
  if (!seek && !label && !play) return;
  const mediaMode = state.previewTarget === "media";
  const monitor = previewMonitor();
  const mediaItem = mediaMode ? selectedMedia() : null;
  const total = mediaMode
    ? (mediaItem?.kind === "写真" ? (mediaItem.duration || 5) : (monitor && Number.isFinite(monitor.duration) ? monitor.duration : 0))
    : projectDuration();
  const now = mediaMode ? (mediaItem?.kind === "写真" ? 0 : state.mediaTime) : state.currentTime;
  if (seek && !scrubbingPreview) {
    seek.max = String(Math.max(total, 0.01));
    seek.value = String(Math.min(Math.max(0, now), Number(seek.max)));
  }
  if (label) label.textContent = `${formatTimecode(now)} / ${formatTimecode(total)}`;
  if (play) {
    const playing = state.playing;
    play.classList.toggle("is-playing", playing);
    const label = playing ? "一時停止" : "再生";
    play.setAttribute("aria-label", label);
    play.title = label;
  }
  const aspect = $("preview-aspect");
  if (aspect && document.activeElement !== aspect && !$("project-settings-dialog")?.open) {
    aspect.value = aspectKeyForProject();
  }
}

function stepPreviewFrame(direction) {
  setPlaying(false);
  const frame = 1 / (state.project.fps || 30);
  if (state.previewTarget === "media") setMediaTime(state.mediaTime + direction * frame);
  else setCurrentTime(state.currentTime + direction * frame);
  updatePlayback();
}

const ASPECT_RATIOS = {
  "16:9": [16, 9],
  "9:16": [9, 16],
  "4:3": [4, 3],
  "3:4": [3, 4],
  "1:1": [1, 1],
};

function sizeForAspect(key, width, height) {
  const pair = ASPECT_RATIOS[key];
  if (!pair) return { width, height };
  const [w, h] = pair;
  if (w >= h) {
    const nextH = height >= 16 ? height : 1080;
    return { width: Math.round(nextH * w / h), height: nextH };
  }
  const nextW = width >= 16 ? width : 1080;
  return { width: nextW, height: Math.round(nextW * h / w) };
}

function applyPreviewAspect(key) {
  if (key === "custom") {
    openProjectSettings();
    return;
  }
  const pair = ASPECT_RATIOS[key];
  if (!pair) return;
  const [w, h] = pair;
  if (w >= h) {
    state.project.height = 1080;
    state.project.width = Math.round(1080 * w / h);
  } else {
    state.project.width = 1080;
    state.project.height = Math.round(1080 * h / w);
  }
  rememberProject(false);
  fitPreviewCanvas();
  syncPropertyPanel();
}

function fillProjectSettings() {
  const width = state.project.width || 1920;
  const height = state.project.height || 1080;
  $("project-width").value = String(width);
  $("project-height").value = String(height);
  $("project-fps").value = String(state.project.fps || 30);
  $("project-aspect").value = aspectKeyForProject();
}

function openProjectSettings() {
  const dialog = $("project-settings-dialog");
  if (!dialog) return;
  fillProjectSettings();
  dialog.returnValue = "";
  if (!dialog.open) dialog.showModal();
}

function readProjectSettings() {
  const width = Math.min(7680, Math.max(16, Math.round(Number($("project-width").value) || 0)));
  const height = Math.min(7680, Math.max(16, Math.round(Number($("project-height").value) || 0)));
  const fps = Math.min(120, Math.max(1, Math.round(Number($("project-fps").value) || 0)));
  if (!width || !height || !fps) return null;
  return { width, height, fps };
}

function bindProjectSettings() {
  const dialog = $("project-settings-dialog");
  if (!dialog || dialog.dataset.bound) return;
  dialog.dataset.bound = "1";
  $("project-aspect").addEventListener("change", () => {
    const key = $("project-aspect").value;
    if (key === "custom") return;
    const next = sizeForAspect(key, Number($("project-width").value) || 1920, Number($("project-height").value) || 1080);
    $("project-width").value = String(next.width);
    $("project-height").value = String(next.height);
  });
  const refreshAspect = () => {
    const width = Number($("project-width").value) || 0;
    const height = Number($("project-height").value) || 0;
    if (width < 16 || height < 16) return;
    const prev = state.project.width;
    const prevH = state.project.height;
    state.project.width = width;
    state.project.height = height;
    $("project-aspect").value = aspectKeyForProject();
    state.project.width = prev;
    state.project.height = prevH;
  };
  $("project-width").addEventListener("input", refreshAspect);
  $("project-height").addEventListener("input", refreshAspect);
  const restoreAspectMenu = () => {
    const aspect = $("preview-aspect");
    if (aspect) aspect.value = aspectKeyForProject();
  };
  const commitProjectSettings = () => {
    const next = readProjectSettings();
    if (!next) {
      showToast("幅、高さ、フレームレートを確認してください。");
      return false;
    }
    state.project.width = next.width;
    state.project.height = next.height;
    state.project.fps = next.fps;
    rememberProject(false);
    fitPreviewCanvas();
    syncPropertyPanel();
    syncPreviewControls();
    return true;
  };
  $("project-settings-cancel").addEventListener("click", () => {
    restoreAspectMenu();
    dialog.close();
  });
  $("project-settings-ok").addEventListener("click", () => {
    if (!commitProjectSettings()) return;
    dialog.close();
  });
  dialog.addEventListener("cancel", () => {
    restoreAspectMenu();
  });
}

let previewMuted = false;
let previewVolume = 100;

function masterPreviewGain() {
  return Math.min(1, Math.max(0, previewVolume / 100));
}

function syncPreviewMuteButton() {
  const button = $("preview-mute");
  if (!button) return;
  button.classList.toggle("is-on", previewMuted);
  button.setAttribute("aria-pressed", previewMuted ? "true" : "false");
  const label = previewMuted ? "ミュート解除" : "ミュート";
  button.setAttribute("aria-label", label);
  button.title = label;
}

function syncPreviewFullscreenButton() {
  const button = $("preview-full");
  const stage = document.querySelector(".preview-stage");
  if (!button) return;
  const on = Boolean(stage) && document.fullscreenElement === stage;
  button.classList.toggle("is-on", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  const label = on ? "全画面を終了" : "全画面";
  button.setAttribute("aria-label", label);
  button.title = label;
}

function togglePreviewMute() {
  previewMuted = !previewMuted;
  applyClipPlayback();
  syncNarration();
  syncPreviewMuteButton();
}

function setPreviewVolume(value) {
  previewVolume = Math.min(100, Math.max(0, Number(value) || 0));
  const range = $("preview-volume-range");
  if (range && document.activeElement !== range) range.value = String(previewVolume);
  applyClipPlayback();
  syncNarration();
}

function drawContained(ctx, source, sw, sh, dx, dy, dw, dh, crop) {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  const sx = crop ? crop.x : 0;
  const sy = crop ? crop.y : 0;
  const sWidth = crop ? crop.width : sw;
  const sHeight = crop ? crop.height : sh;
  if (sWidth <= 0 || sHeight <= 0) return;
  const scale = Math.min(dw / sWidth, dh / sHeight);
  const width = sWidth * scale;
  const height = sHeight * scale;
  ctx.drawImage(source, sx, sy, sWidth, sHeight, dx + (dw - width) / 2, dy + (dh - height) / 2, width, height);
}

function capturePreviewFrame() {
  const stage = $("preview-canvas");
  if (!stage || stage.clientWidth < 2 || stage.clientHeight < 2) {
    showToast("プレビューの画面がまだありません。");
    return;
  }
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  const canvas = document.createElement("canvas");
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  const stageRect = stage.getBoundingClientRect();
  const layers = state.previewTarget === "timeline" ? [...stage.querySelectorAll(".preview-layer")] : [];
  if (layers.length) {
    for (const layer of layers) {
      const box = layer.getBoundingClientRect();
      const clip = findClip(layer.dataset.clipId)?.clip;
      const baked = layer.querySelector(":scope > canvas.preview-crop");
      const chromaLayer = layer.querySelector("#preview-chroma");
      const video = layer.querySelector("video");
      if (baked && !baked.hidden && baked.width > 0) {
        ctx.drawImage(baked, box.left - stageRect.left, box.top - stageRect.top, box.width, box.height);
      } else if (chromaLayer && !chromaLayer.hidden && chromaLayer.width > 0) {
        ctx.drawImage(chromaLayer, box.left - stageRect.left, box.top - stageRect.top, box.width, box.height);
      } else if (video && video.videoWidth > 0 && video.readyState >= 2) {
        const crop = sourceCropRect(clip, video.videoWidth, video.videoHeight);
        drawContained(ctx, video, video.videoWidth, video.videoHeight, box.left - stageRect.left, box.top - stageRect.top, box.width, box.height, crop);
      }
      const image = layer.querySelector("img");
      if (image && image.naturalWidth > 0) {
        const crop = sourceCropRect(clip, image.naturalWidth, image.naturalHeight);
        drawContained(ctx, image, image.naturalWidth, image.naturalHeight, box.left - stageRect.left, box.top - stageRect.top, box.width, box.height, crop);
      }
      const telop = layer.querySelector(".preview-telop");
      if (telop && telop.textContent.trim()) {
        const look = getComputedStyle(telop);
        ctx.fillStyle = look.color || "#fff";
        ctx.font = `${look.fontWeight} ${look.fontSize} ${look.fontFamily}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(telop.textContent.trim(), box.left - stageRect.left + box.width / 2, box.top - stageRect.top + box.height / 2);
      }
    }
  }
  const video = previewMonitor();
  const frame = $("preview-transform");
  const chroma = $("preview-chroma");
  if (layers.length) {
    // タイムラインの重なりは上で描いた
  } else if (chroma && !chroma.hidden && frame && chroma.width > 0) {
    const box = frame.getBoundingClientRect();
    ctx.drawImage(
      chroma,
      box.left - stageRect.left,
      box.top - stageRect.top,
      box.width,
      box.height,
    );
  } else if (video && frame && video.videoWidth > 0 && video.readyState >= 2) {
    const box = frame.getBoundingClientRect();
    drawContained(
      ctx,
      video,
      video.videoWidth,
      video.videoHeight,
      box.left - stageRect.left,
      box.top - stageRect.top,
      box.width,
      box.height,
    );
  }
  const image = $("preview-image");
  if (image && !image.hidden && image.naturalWidth > 0) {
    const box = image.getBoundingClientRect();
    drawContained(
      ctx,
      image,
      image.naturalWidth,
      image.naturalHeight,
      box.left - stageRect.left,
      box.top - stageRect.top,
      box.width,
      box.height,
    );
  }
  const telop = $("preview-telop");
  if (telop && !telop.hidden && telop.textContent.trim()) {
    const box = telop.getBoundingClientRect();
    const look = getComputedStyle(telop);
    ctx.fillStyle = look.color || "#fff";
    ctx.font = `${look.fontWeight} ${look.fontSize} ${look.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      telop.textContent.trim(),
      box.left - stageRect.left + box.width / 2,
      box.top - stageRect.top + box.height / 2,
    );
  }
  canvas.toBlob((blob) => {
    if (!blob) {
      showToast("画像を作れませんでした。");
      return;
    }
    const url = URL.createObjectURL(blob);
    const stamp = formatTimecode(state.currentTime).replaceAll(":", "");
    const name = `editai-${stamp}.png`;
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    state.media.push({
      id: nextMediaId(),
      name,
      kind: "写真",
      path: "",
      url,
      duration: 5,
    });
    renderMediaList();
    showToast(`「${name}」を素材に追加しました。`);
  }, "image/png");
}

async function togglePreviewFullscreen() {
  const stage = document.querySelector(".preview-stage");
  const controls = document.querySelector(".preview-controls");
  const pane = document.querySelector(".pane-preview");
  if (!stage) return;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  if (controls && controls.parentElement !== stage) stage.append(controls);
  try {
    await stage.requestFullscreen();
  } catch {
    if (controls && pane && controls.parentElement !== pane) pane.append(controls);
    showToast("全画面にできませんでした。");
    return;
  }
  if (document.fullscreenElement !== stage && controls && pane && controls.parentElement !== pane) {
    pane.append(controls);
  }
}

function restorePreviewControls() {
  const stage = document.querySelector(".preview-stage");
  const controls = document.querySelector(".preview-controls");
  const pane = document.querySelector(".pane-preview");
  if (!controls || !pane || !stage) return;
  if (document.fullscreenElement === stage) return;
  if (controls.parentElement !== pane) pane.append(controls);
}

function bindPreviewControls() {
  const play = $("preview-play");
  const seek = $("preview-seek");
  const aspect = $("preview-aspect");
  if (!play || !seek || play.dataset.bound) return;
  play.dataset.bound = "1";
  $("preview-frame-back").addEventListener("click", () => stepPreviewFrame(-1));
  play.addEventListener("click", () => setPlaying(!state.playing));
  $("preview-frame-forward").addEventListener("click", () => stepPreviewFrame(1));
  seek.addEventListener("pointerdown", () => {
    scrubbingPreview = true;
    setPlaying(false);
  });
  seek.addEventListener("input", () => {
    scrubbingPreview = true;
    if (state.previewTarget === "media") setMediaTime(Number(seek.value));
    else setCurrentTime(Number(seek.value));
  });
  const endPreviewScrub = () => {
    scrubbingPreview = false;
    syncPreviewControls();
  };
  seek.addEventListener("change", endPreviewScrub);
  seek.addEventListener("pointerup", endPreviewScrub);
  seek.addEventListener("pointercancel", endPreviewScrub);
  aspect.addEventListener("change", () => applyPreviewAspect(aspect.value));
  bindProjectSettings();
  $("preview-mute").addEventListener("click", () => {
    togglePreviewMute();
    $("preview-volume")?.classList.add("is-open");
  });
  const volumeRange = $("preview-volume-range");
  if (volumeRange) {
    volumeRange.addEventListener("input", () => setPreviewVolume(volumeRange.value));
    volumeRange.addEventListener("pointerdown", (event) => event.stopPropagation());
  }
  document.addEventListener("pointerdown", (event) => {
    const box = $("preview-volume");
    if (!box || box.contains(event.target)) return;
    box.classList.remove("is-open");
  });
  $("preview-shot").addEventListener("click", capturePreviewFrame);
  $("preview-full").addEventListener("click", () => {
    togglePreviewFullscreen();
  });
  document.addEventListener("fullscreenchange", () => {
    restorePreviewControls();
    syncPreviewFullscreenButton();
    fitPreviewCanvas();
  });
  syncPreviewMuteButton();
  syncPreviewControls();
}

function bindEvents() {
  bindToolTabs();
  bindPreviewMonitor();
  bindPreviewControls();
  bindTimelineZoom();
  $("split-btn").addEventListener("click", splitSelectedAtPlayhead);
  $("delete-btn").addEventListener("click", deleteSelectedClip);
  $("crop-btn").addEventListener("click", openCropDialog);
  $("undo-btn").addEventListener("click", undoProject);
  $("redo-btn").addEventListener("click", redoProject);
  for (const input of document.querySelectorAll("#property-editor [data-prop]")) {
    input.addEventListener("input", onPropertyInput);
  }
  $("prop-flip-h").addEventListener("click", () => toggleClipFlip("flipH"));
  $("prop-flip-v").addEventListener("click", () => toggleClipFlip("flipV"));
  $("prop-chroma").addEventListener("change", () => {
    const clip = selectedEditableClip();
    if (!clip) return;
    clip.chromaEnabled = $("prop-chroma").checked;
    rememberProject(false);
    startChromaLoop();
  });
  $("prop-chroma-color").addEventListener("input", () => {
    const clip = selectedEditableClip();
    if (!clip) return;
    clip.chromaColor = $("prop-chroma-color").value;
    rememberProject(true);
    startChromaLoop();
  });
  $("prop-text")?.addEventListener("input", onTelopPropertyText);
  $("tl-text-btn").addEventListener("click", addTextClip);
  $("mic-btn").addEventListener("click", toggleNarration);
  bindPreviewGestures();
  const previewStage = document.querySelector(".preview-stage");
  if (previewStage) new ResizeObserver(() => syncPropertyPanel()).observe(previewStage);
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (!$("editor").hidden) {
        saveProject().catch((error) => showToast(errorText(error, "プロジェクトを保存できませんでした。")));
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !$("editor").hidden && !document.querySelector("dialog[open]")) {
      const command = event.key.toLowerCase();
      if (command === "z") {
        event.preventDefault();
        if (event.shiftKey) redoProject();
        else undoProject();
        return;
      }
      if (command === "y" && !event.shiftKey) {
        event.preventDefault();
        redoProject();
        return;
      }
    }
    const compareOpen = $("cut-compare-dialog")?.open;
    const editingText = isTypingTarget(event.target)
      && !(event.target.tagName === "INPUT" && event.target.type === "range");
    if (compareOpen && !editingText && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if ((event.code === "Space" || event.key === " ")
        && !(event.target instanceof Element && event.target.closest("button, a, [role='button']"))) {
        event.preventDefault();
        toggleComparePlayback();
        return;
      }
      if (key === "delete" || key === "backspace") {
        event.preventDefault();
        deleteCompareClip();
        return;
      }
      if (key === "s") {
        event.preventDefault();
        splitCompareAtPlayhead();
        return;
      }
    }
    const telopOpen = $("telop-gen-dialog")?.open;
    if (telopOpen && !editingText && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if ((event.code === "Space" || event.key === " ")
        && !(event.target instanceof Element && event.target.closest("button, a, [role='button']"))) {
        event.preventDefault();
        toggleTelopPlayback();
        return;
      }
    }
    if (isTypingTarget(event.target)) return;
    if (!$("editor").hidden && !event.altKey && !event.repeat) {
      const command = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (command === "c" || command === "v")) {
        event.preventDefault();
        if (command === "c") copyTimelineClips();
        else pasteTimelineClips();
        return;
      }
      if (event.shiftKey && !event.ctrlKey && !event.metaKey && command === "d") {
        event.preventDefault();
        duplicateTimelineClips();
        return;
      }
    }
    if ($("editor").hidden) return;
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !$("cut-compare-dialog")?.open && !document.querySelector("dialog[open]")) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        stepPreviewFrame(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
    }
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key.toLowerCase();
    if ($("cut-compare-dialog")?.open) return;
    if (document.querySelector("dialog[open]")) return;
    if (event.code === "Space" || event.key === " ") {
      if (event.target instanceof Element && event.target.closest("button, a, [role='button']")) return;
      event.preventDefault();
      setPlaying(!state.playing);
      return;
    }
    if (key === "s") {
      event.preventDefault();
      splitSelectedAtPlayhead();
    } else if (key === "delete" || key === "backspace") {
      event.preventDefault();
      deleteSelectedClip();
    }
  });

  $("import-label").addEventListener("click", async () => {
    if ($("import-label").disabled) return;
    try {
      const paths = await openMediaDialog();
      if (paths.length) await addMediaPaths(paths);
    } catch (error) {
      showToast(error.message || "ファイルを選べませんでした。");
    }
  });

  const mediaPane = document.querySelector(".pane-media");
  mediaPane.addEventListener("dragover", (event) => {
    event.preventDefault();
    $("import-label").classList.add("is-dragover");
  });
  mediaPane.addEventListener("dragleave", (event) => {
    if (!mediaPane.contains(event.relatedTarget)) $("import-label").classList.remove("is-dragover");
  });
  mediaPane.addEventListener("drop", (event) => {
    event.preventDefault();
    $("import-label").classList.remove("is-dragover");
  });
  bindNativeFileDrop();

  $("cancel-btn").addEventListener("click", cancelAnalysis);
  $("export-btn").addEventListener("click", startExport);
  $("save-project-btn").addEventListener("click", () => {
    saveProject().catch((error) => showToast(errorText(error, "プロジェクトを保存できませんでした。")));
  });
  $("start-open").addEventListener("click", () => {
    openProject().catch((error) => showToast(errorText(error, "プロジェクトを開けませんでした。")));
  });

  $("start-create").addEventListener("click", () => {
    showEditor();
    if (!result && !$("preview-monitor").getAttribute("src")) {
      $("file-name").textContent = "新しいプロジェクト";
    }
  });
  bindPaneResize();
  bindTimelineNavigation();
  $("settings-btn").addEventListener("click", openProjectSettings);
  $("editor-settings-btn").addEventListener("click", openProjectSettings);
  $("project-cards").addEventListener("click", (event) => {
    const card = event.target.closest(".project-card");
    if (!card) return;
    showToast(`「${card.dataset.name}」はサンプルです。続きからは、まだ開けません。`);
  });
}

// ---------- 初期化 ----------

async function checkHealth() {
  const health = await api("/health");
  state.connected = true;
  const missing = [];
  if (!health.dependencies?.ffmpeg?.available) missing.push("FFmpeg");
  if (!health.dependencies?.whisper?.available) missing.push("faster-whisper");
  if (missing.length) {
    $("cut-info").textContent = `接続済み（${missing.join("・")} が見つかりません）`;
    showToast(`${missing.join("・")} が見つかりません。インストール状況を確認してください。`);
  } else {
    const ollama = health.dependencies?.ollama?.available ? "Ollama 利用可" : "Ollama 未接続（判定は原文で代替）";
    $("cut-info").textContent = `接続済み・${ollama}`;
  }
  setImportEnabled(true);
}

const MEDIA_DIALOG_FILTERS = [
  { name: "動画・音声・画像", extensions: ["mp4", "mov", "mkv", "avi", "webm", "mp3", "wav", "m4a", "aac", "png", "jpg", "jpeg", "gif", "webp"] },
  { name: "動画", extensions: ["mp4", "mov", "mkv", "avi", "webm"] },
  { name: "音声", extensions: ["mp3", "wav", "m4a", "aac"] },
  { name: "画像", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
];

function tauriCore() {
  return window.__TAURI__?.core ?? null;
}

function fileNameFromPath(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

function mediaKindFromName(name) {
  const ext = String(name).split(".").pop().toLowerCase();
  if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) return "動画";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "写真";
  if (["mp3", "wav", "m4a", "aac"].includes(ext)) return "音声";
  return "";
}

function normalizePickedPaths(picked) {
  if (!picked) return [];
  const list = Array.isArray(picked) ? picked : [picked];
  return list.map((item) => (typeof item === "string" ? item : "")).filter(Boolean);
}

// Tauri 2 のダイアログ。v1 の @tauri-apps/api/dialog の open に当たる。
async function openMediaDialog() {
  const core = tauriCore();
  if (!core?.invoke) throw new Error("ファイル選択はデスクトップアプリの中で使います。");
  const picked = await core.invoke("plugin:dialog|open", {
    options: {
      title: "素材を追加",
      multiple: true,
      directory: false,
      filters: MEDIA_DIALOG_FILTERS,
    },
  });
  return normalizePickedPaths(picked);
}

async function mediaUrlFromPath(path) {
  const core = tauriCore();
  if (!core?.convertFileSrc) throw new Error("ローカルファイルを開く準備ができていません。");
  await core.invoke("allow_media_path", { path });
  return core.convertFileSrc(path);
}

const PROJECT_FILE_VERSION = 1;
const PROJECT_DIALOG_FILTERS = [{ name: "EditAI プロジェクト", extensions: ["editai"] }];

function errorText(error, fallback) {
  if (typeof error === "string" && error) return error;
  if (error && typeof error.message === "string" && error.message) return error.message;
  return fallback;
}

function projectFileBaseName() {
  const raw = ($("file-name")?.textContent || "").trim() || "新しいプロジェクト";
  const safe = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\.editai$/i, "").trim();
  return safe || "新しいプロジェクト";
}

function raiseSerial(current, ids) {
  let next = current;
  for (const id of ids) {
    const match = /-(\d+)$/.exec(String(id || ""));
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

function isBlobUrl(url) {
  return typeof url === "string" && url.startsWith("blob:");
}

function buildProjectDocument() {
  const project = structuredClone(state.project);
  for (const track of project.tracks || []) {
    for (const clip of track.clips || []) {
      if (isBlobUrl(clip.sourceUrl)) clip.sourceUrl = "";
    }
  }
  return {
    version: PROJECT_FILE_VERSION,
    savedAt: new Date().toISOString(),
    name: ($("file-name")?.textContent || "").trim(),
    project,
    media: state.media.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      path: item.path || "",
      duration: item.duration,
    })),
    style: structuredClone(state.style),
    segments: structuredClone(state.segments),
    threshold: state.threshold,
    currentTime: state.currentTime,
    selectedClipIds: [...state.selectedClipIds],
    selectedClipId: state.selectedClipIds.length === 1 ? state.selectedClipIds[0] : null,
    selectedMediaId: state.selectedMediaId,
  };
}

async function writeProjectFile(path, document) {
  const core = tauriCore();
  if (!core?.invoke) throw new Error("プロジェクトの保存は、デスクトップアプリの中で使います。");
  const bytes = new TextEncoder().encode(JSON.stringify(document, null, 2));
  await core.invoke("plugin:fs|write_text_file", bytes, {
    headers: { path: encodeURIComponent(path) },
  });
}

async function readProjectFile(path) {
  const core = tauriCore();
  if (!core?.invoke) throw new Error("プロジェクトを開くのは、デスクトップアプリの中で使います。");
  const data = await core.invoke("plugin:fs|read_text_file", { path });
  if (typeof data === "string") return data;
  const bytes = data instanceof ArrayBuffer || data instanceof Uint8Array ? data : Uint8Array.from(data);
  return new TextDecoder("utf-8").decode(bytes);
}

async function applyProjectDocument(document) {
  if (!document || document.version !== PROJECT_FILE_VERSION || !document.project || !Array.isArray(document.project.tracks)) {
    throw new Error("このファイルは EditAI のプロジェクトではありません。");
  }
  const project = structuredClone(document.project);
  const width = Number(project.width);
  const height = Number(project.height);
  const fps = Number(project.fps);
  project.width = Number.isFinite(width) && width > 0 ? width : 1920;
  project.height = Number.isFinite(height) && height > 0 ? height : 1080;
  project.fps = Number.isFinite(fps) && fps > 0 ? fps : 30;

  const media = [];
  const missing = [];
  const urlByPath = new Map();
  const rememberUrl = async (path) => {
    if (!path) return "";
    if (urlByPath.has(path)) return urlByPath.get(path);
    let url = "";
    try {
      url = await mediaUrlFromPath(path);
    } catch {
      url = "";
    }
    urlByPath.set(path, url);
    return url;
  };

  for (const item of Array.isArray(document.media) ? document.media : []) {
    const path = typeof item.path === "string" ? item.path : "";
    const name = item.name || fileNameFromPath(path) || "素材";
    const url = await rememberUrl(path);
    if (path && !url) missing.push(name);
    media.push({
      id: item.id || "",
      name,
      kind: item.kind || mediaKindFromName(name) || "動画",
      path,
      url,
      duration: Number(item.duration) > 0 ? Number(item.duration) : 0,
    });
  }

  const knownPaths = new Set(media.map((item) => item.path).filter(Boolean));
  for (const track of project.tracks) {
    if (!Array.isArray(track.clips)) track.clips = [];
    for (const clip of track.clips) {
      const path = typeof clip.sourcePath === "string" ? clip.sourcePath : "";
      if (isBlobUrl(clip.sourceUrl)) clip.sourceUrl = "";
      if (!path) continue;
      const url = await rememberUrl(path);
      clip.sourceUrl = url;
      const label = fileNameFromPath(path) || "素材";
      if (!url && !knownPaths.has(path) && !missing.includes(label)) missing.push(label);
    }
  }

  state.project = project;
  state.media = media;
  state.style = {
    ...DEFAULT_STYLE,
    ...(document.style && typeof document.style === "object" ? document.style : {}),
  };
  state.segments = Array.isArray(document.segments) ? structuredClone(document.segments) : [];
  const threshold = Number(document.threshold);
  state.threshold = threshold === 2 || threshold === 3 ? threshold : 1;
  state.currentTime = Number(document.currentTime) >= 0 ? Number(document.currentTime) : 0;
  state.selectedClipIds = Array.isArray(document.selectedClipIds)
    ? document.selectedClipIds.filter((id) => typeof id === "string" && id)
    : (document.selectedClipId ? [document.selectedClipId] : []);
  state.selectedMediaId = document.selectedMediaId || null;
  state.previewTarget = "timeline";
  state.mediaTime = 0;
  state.playing = false;
  result = null;

  trackSerial = raiseSerial(1, project.tracks.map((track) => track.id));
  clipSerial = raiseSerial(1, project.tracks.flatMap((track) => (track.clips || []).map((clip) => clip.id)));
  mediaSerial = raiseSerial(1, media.map((item) => item.id));
  for (const item of state.media) {
    if (!item.id) item.id = nextMediaId();
  }

  projectHistory.stack = [];
  projectHistory.index = -1;
  const monitor = previewMonitor();
  if (monitor) {
    monitor.pause();
    monitor.removeAttribute("src");
    monitor.load();
  }
  if ($("export-btn")) $("export-btn").disabled = true;

  showEditor();
  renderMediaList();
  syncStyleForm();
  syncPropertyPanel();
  fitPreviewCanvas();
  setCurrentTime(state.currentTime);
  updatePlayback();

  if (missing.length) {
    const shown = missing.slice(0, 3).map((name) => `「${name}」`).join("");
    const rest = missing.length > 3 ? `ほか${missing.length - 3}件` : "";
    showToast(`見つからない素材があります。${shown}${rest}`);
  }
}

async function saveProject() {
  const core = tauriCore();
  if (!core?.invoke) {
    showToast("プロジェクトの保存は、デスクトップアプリの中で使います。");
    return;
  }
  const picked = await core.invoke("plugin:dialog|save", {
    options: {
      title: "プロジェクトを保存",
      defaultPath: projectFilePath || `${projectFileBaseName()}.editai`,
      filters: PROJECT_DIALOG_FILTERS,
    },
  });
  if (typeof picked !== "string" || !picked) return;
  const path = /\.editai$/i.test(picked) ? picked : `${picked}.editai`;
  const document = buildProjectDocument();
  document.name = fileNameFromPath(path).replace(/\.editai$/i, "");
  await writeProjectFile(path, document);
  projectFilePath = path;
  $("file-name").textContent = document.name;
  showToast("プロジェクトを保存しました。");
}

async function openProject() {
  const core = tauriCore();
  if (!core?.invoke) {
    showToast("プロジェクトを開くのは、デスクトップアプリの中で使います。");
    return;
  }
  const picked = await core.invoke("plugin:dialog|open", {
    options: {
      title: "プロジェクトを開く",
      multiple: false,
      directory: false,
      filters: PROJECT_DIALOG_FILTERS,
    },
  });
  const path = typeof picked === "string" ? picked : "";
  if (!path) return;
  const text = await readProjectFile(path);
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error("このファイルは EditAI のプロジェクトではありません。");
  }
  await applyProjectDocument(document);
  projectFilePath = path;
  const stored = typeof document.name === "string" ? document.name.trim() : "";
  $("file-name").textContent = stored || fileNameFromPath(path).replace(/\.editai$/i, "");
}

async function fileFromMedia(item) {
  const url = item?.url;
  if (!url) return null;
  const response = await fetch(url);
  if (!response.ok) throw new Error("動画を読み込めませんでした。");
  const blob = await response.blob();
  const name = item.name && /\.[a-z0-9]+$/i.test(item.name) ? item.name : "video.mp4";
  return new File([blob], name, { type: blob.type || "video/mp4" });
}

function bindNativeFileDrop() {
  const getCurrent = window.__TAURI__?.webview?.getCurrentWebview;
  if (typeof getCurrent !== "function") return;
  const webview = getCurrent();
  if (!webview?.onDragDropEvent) return;
  webview.onDragDropEvent((event) => {
    const payload = event.payload;
    if (!payload) return;
    if (payload.type === "enter") $("import-label").classList.add("is-dragover");
    if (payload.type === "leave" || payload.type === "drop") $("import-label").classList.remove("is-dragover");
    if (payload.type === "drop") addMediaPaths(payload.paths || []);
  });
}

function probeDuration(url, kind) {
  if (kind === "写真") return Promise.resolve(5);
  return new Promise((resolve) => {
    const el = document.createElement(kind === "音声" ? "audio" : "video");
    el.preload = "metadata";
    el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 8);
    el.onerror = () => resolve(8);
    el.src = url;
  });
}

async function addMediaPaths(paths) {
  const added = [];
  for (const path of paths) {
    const name = fileNameFromPath(path);
    const kind = mediaKindFromName(name);
    if (!kind) {
      showToast(`「${name}」は追加できない種類です。`);
      continue;
    }
    let url;
    try {
      url = await mediaUrlFromPath(path);
    } catch (error) {
      showToast(error.message || `「${name}」を開けませんでした。`);
      continue;
    }
    const duration = await probeDuration(url, kind);
    state.media.push({ id: nextMediaId(), name, kind, path, url, duration });
    added.push(name);
  }
  if (!added.length) return;
  renderMediaList();
  showToast(added.length === 1 ? `「${added[0]}」を追加しました。` : `${added.length}件を追加しました。`);
}

let mediaSerial = 1;
const MEDIA_DRAG_PX = 5;

function nextMediaId() {
  const id = `media-${mediaSerial}`;
  mediaSerial += 1;
  return id;
}

function selectedMedia() {
  return state.media.find((item) => item.id === state.selectedMediaId) || null;
}

function renderMediaList() {
  const list = $("media-list");
  list.replaceChildren();
  for (const item of state.media) {
    if (!item.id) item.id = nextMediaId();
    const li = document.createElement("li");
    li.className = "media-item";
    li.classList.toggle("is-selected", item.id === state.selectedMediaId);
    li.dataset.id = item.id;
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-pressed", item.id === state.selectedMediaId ? "true" : "false");
    if (item.url) {
      const thumb = document.createElement(item.kind === "写真" ? "img" : "video");
      thumb.className = "media-thumb";
      thumb.src = item.url;
      thumb.draggable = false;
      if (thumb.tagName === "IMG") thumb.alt = "";
      if (thumb.tagName === "VIDEO") {
        thumb.muted = true;
        thumb.preload = "metadata";
        thumb.playsInline = true;
      }
      li.append(thumb);
    }
    const caption = document.createElement("span");
    caption.className = "media-item-caption";
    const name = document.createElement("span");
    name.className = "media-item-name";
    name.textContent = item.name;
    const kind = document.createElement("span");
    kind.className = "media-item-kind";
    kind.textContent = item.kind;
    caption.append(name, kind);
    if (item.kind === "動画") {
      const duration = document.createElement("span");
      duration.className = "media-duration";
      duration.textContent = formatMediaClock(item.duration);
      li.append(duration);
    }
    if (mediaUrlUsed(item.url)) {
      const used = document.createElement("span");
      used.className = "media-used";
      used.textContent = "✔";
      used.title = "タイムラインで使用中";
      li.append(used);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "media-add-btn";
    add.textContent = "＋";
    add.title = "再生位置に追加";
    add.setAttribute("aria-label", "再生位置に追加");
    add.addEventListener("pointerdown", (event) => event.stopPropagation());
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      placeMediaAtPlayhead(item.id).catch((error) => showToast(error.message || "タイムラインに置けませんでした。"));
    });
    li.append(caption, add);
    li.draggable = false;
    li.addEventListener("dragstart", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    li.addEventListener("pointerdown", (event) => beginMediaPointerDrag(event, item, li));
    li.addEventListener("click", () => selectMedia(item.id));
    li.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectMedia(item.id);
    });
    list.append(li);
  }
}

function setMediaDragCursor(on) {
  document.body.classList.toggle("is-media-dragging", on);
  document.body.style.cursor = on ? "grabbing" : "";
}

function placeMediaGhost(ghost, clientX, clientY, grabX, grabY) {
  ghost.style.left = `${clientX - grabX}px`;
  ghost.style.top = `${clientY - grabY}px`;
}

function createMediaGhost(source, clientX, clientY) {
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true);
  ghost.classList.add("media-ghost");
  ghost.removeAttribute("id");
  ghost.style.position = "fixed";
  ghost.style.pointerEvents = "none";
  ghost.style.zIndex = "9999";
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.margin = "0";
  document.body.append(ghost);
  const grabX = clientX - rect.left;
  const grabY = clientY - rect.top;
  placeMediaGhost(ghost, clientX, clientY, grabX, grabY);
  return { ghost, grabX, grabY };
}

function clearMediaDropGhost() {
  document.querySelector("#seq-lanes .seq-drop-ghost")?.remove();
}

function mediaDropPreview(clientY, clip) {
  const lane = laneContaining(clientY);
  const hovered = lane && trackById(lane.dataset.trackId);
  if (hovered) {
    if (hovered.locked || !clipTypeFitsTrack(clip, hovered)) return null;
    return { track: hovered };
  }
  if (trackGrowTarget(clientY, clip)) return { grow: clip.type === "音声" ? "audio" : "video" };
  const isAudio = clip.type === "音声";
  const existing = state.project.tracks.filter((item) => item.type === (isAudio ? "audio" : "video") && !item.locked);
  if (!existing.length) return null;
  return { track: isAudio ? existing[existing.length - 1] : existing[0] };
}

function syncMediaDropGhost(item, clientX, clientY) {
  const lanes = $("seq-lanes");
  const view = $("seq-lanes-view");
  if (!lanes || !view) return;
  const viewRect = view.getBoundingClientRect();
  const inside = clientX >= viewRect.left && clientX <= viewRect.right
    && clientY >= viewRect.top && clientY <= viewRect.bottom;
  if (!inside) {
    clearMediaDropGhost();
    return;
  }
  const duration = item.duration > 0 ? item.duration : (item.kind === "写真" ? 5 : 4);
  const preview = mediaDropPreview(clientY, { type: item.kind, duration });
  if (!preview) {
    clearMediaDropGhost();
    return;
  }
  let ghost = lanes.querySelector(".seq-drop-ghost");
  if (!ghost) {
    ghost = document.createElement("div");
    ghost.className = "seq-drop-ghost";
    lanes.append(ghost);
  }
  const lanesRect = lanes.getBoundingClientRect();
  let top = 3;
  let height = 24;
  if (preview.track) {
    const lane = document.querySelector(`#seq-lanes > .seq-lane[data-track-id="${preview.track.id}"]`);
    const laneRect = lane?.getBoundingClientRect();
    if (!laneRect) {
      ghost.remove();
      return;
    }
    top = laneRect.top - lanesRect.top + 3;
    height = Math.max(8, laneRect.height - 6);
  } else {
    const pad = lanes.querySelector(preview.grow === "audio" ? ".seq-track-pad.is-audio" : ".seq-track-pad:not(.is-audio)");
    const padRect = pad?.getBoundingClientRect();
    if (!padRect) {
      ghost.remove();
      return;
    }
    top = padRect.top - lanesRect.top;
    height = Math.max(8, padRect.height);
  }
  const start = Math.max(0, xToTime(clientX, lanes));
  ghost.style.left = `${start * PX_PER_SEC}px`;
  ghost.style.width = `${Math.max(duration * PX_PER_SEC, 4)}px`;
  ghost.style.top = `${top}px`;
  ghost.style.height = `${height}px`;
}

function beginMediaPointerDrag(event, item, li) {
  if (event.button !== 0) return;
  if (event.target instanceof Element && event.target.closest(".media-add-btn")) return;
  event.preventDefault();
  const originX = event.clientX;
  const originY = event.clientY;
  let dragging = false;
  let ghost = null;
  let grabX = 0;
  let grabY = 0;
  trackPointer(li, event, (moveEvent) => {
    moveEvent.preventDefault();
    if (!dragging) {
      if (Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) <= MEDIA_DRAG_PX) return;
      dragging = true;
      const created = createMediaGhost(li, moveEvent.clientX, moveEvent.clientY);
      ghost = created.ghost;
      grabX = created.grabX;
      grabY = created.grabY;
      setMediaDragCursor(true);
    }
    if (ghost) placeMediaGhost(ghost, moveEvent.clientX, moveEvent.clientY, grabX, grabY);
    syncMediaDropGhost(item, moveEvent.clientX, moveEvent.clientY);
  }, (endEvent) => {
    if (ghost) ghost.remove();
    clearMediaDropGhost();
    setMediaDragCursor(false);
    if (!dragging) {
      selectMedia(item.id);
      return;
    }
    const suppressClick = (clickEvent) => {
      const target = clickEvent.target;
      if (!(target instanceof Element) || !li.contains(target)) return;
      if (target.closest(".media-add-btn")) return;
      clickEvent.stopPropagation();
      clickEvent.preventDefault();
    };
    document.addEventListener("click", suppressClick, true);
    setTimeout(() => document.removeEventListener("click", suppressClick, true), 0);
    const view = $("seq-lanes-view");
    if (!view) return;
    const rect = view.getBoundingClientRect();
    const inside = endEvent.clientX >= rect.left && endEvent.clientX <= rect.right
      && endEvent.clientY >= rect.top && endEvent.clientY <= rect.bottom;
    if (!inside) return;
    placeMediaOnTimeline(item.id, endEvent.clientX, endEvent.clientY)
      .catch((error) => showToast(error.message || "タイムラインに置けませんでした。"));
  });
}

function selectMedia(id) {
  const item = state.media.find((entry) => entry.id === id);
  if (!item) return;
  state.selectedMediaId = id;
  state.previewTarget = "media";
  state.mediaTime = 0;
  renderMediaList();
  showMediaPreview(item, false);
}

function showMediaPreview(item, keepTime) {
  hideTimelineStack();
  const monitor = previewMonitor();
  const image = $("preview-image");
  const object = $("preview-object");
  const telop = $("preview-telop");
  if (!item) return;
  if (telop) telop.hidden = true;
  hidePreviewGuides();
  resetVideoFrame();
  if (item.kind === "写真") {
    if (monitor) {
      monitor.pause();
      monitor.classList.add("is-media-hidden");
    }
    if (object && image) {
      object.hidden = false;
      image.hidden = false;
      object.style.width = "100%";
      object.style.height = "100%";
      object.style.transform = "translate(-50%, -50%)";
      if (image.dataset.source !== (item.url || "")) {
        image.dataset.source = item.url || "";
        image.src = item.url || "";
      }
    }
    state.playing = false;
    updatePlayback();
    syncPreviewControls();
    return;
  }
  if (object) object.hidden = true;
  if (image) image.hidden = true;
  if (!monitor || !item.url) return;
  monitor.classList.remove("is-media-hidden");
  monitor.playbackRate = 1;
  monitor.preservesPitch = true;
  monitor.muted = previewMuted;
  applyElementGain(monitor, masterPreviewGain());
  const applyStart = () => {
    if (state.previewTarget !== "media" || state.selectedMediaId !== item.id) return;
    if (!keepTime) {
      state.mediaTime = 0;
      try {
        monitor.currentTime = 0;
      } catch {
        // 長さが分かるまで待つ
      }
    }
    syncPreviewControls();
  };
  if (monitor.dataset.source !== item.url) {
    monitor.dataset.source = item.url;
    monitor.pause();
    monitor.src = item.url;
    monitor.addEventListener("loadedmetadata", applyStart, { once: true });
  } else {
    applyStart();
  }
  syncPreviewControls();
}

function laneContaining(clientY) {
  const root = $("seq-lanes");
  if (!root) return null;
  for (const lane of root.querySelectorAll(":scope > .seq-lane")) {
    const rect = lane.getBoundingClientRect();
    if (rect.height <= 0) continue;
    if (clientY >= rect.top && clientY <= rect.bottom) return lane;
  }
  return null;
}

function clipTypeFitsTrack(clip, target) {
  if (!target) return false;
  if (clip.type === "音声") return target.type === "audio";
  return target.type === "video";
}

function destinationTrackForMedia(clientY, clip) {
  const lane = laneContaining(clientY);
  const hovered = lane && trackById(lane.dataset.trackId);
  if (hovered) {
    if (hovered.locked) return { error: "ロック中のトラックには置けません。" };
    if (!clipTypeFitsTrack(clip, hovered)) return { error: "このトラックには置けない種類です。" };
    return { track: hovered };
  }
  const isAudio = clip.type === "音声";
  const kind = isAudio ? "audio" : "video";
  const existing = state.project.tracks.filter((item) => item.type === kind);
  if (!existing.length) {
    const track = createTrack(kind, nextTrackLabel(kind));
    const index = isAudio ? state.project.tracks.length : 0;
    state.project.tracks.splice(index, 0, track);
    return { track };
  }
  if (trackGrowTarget(clientY, clip)) {
    const edge = isAudio ? existing[existing.length - 1] : existing[0];
    const track = createTrack(kind, nextTrackLabel(kind));
    const index = isAudio ? state.project.tracks.indexOf(edge) + 1 : state.project.tracks.indexOf(edge);
    state.project.tracks.splice(index, 0, track);
    return { track };
  }
  const open = existing.filter((item) => !item.locked);
  if (!open.length) return { error: "この位置には置けません。" };
  return { track: isAudio ? open[open.length - 1] : open[0] };
}

async function placeMediaOnTimeline(id, clientX, clientY) {
  const item = state.media.find((entry) => entry.id === id);
  if (!item) return;
  const lanes = $("seq-lanes");
  if (!lanes) return;
  const startTime = Math.max(0, xToTime(clientX, lanes));
  const duration = item.duration > 0 ? item.duration : await probeDuration(item.url, item.kind);
  item.duration = duration;
  const clip = createClip({
    type: item.kind,
    name: item.name,
    startTime,
    duration,
    sourceUrl: item.url,
    sourcePath: item.path || "",
  });
  const placed = destinationTrackForMedia(clientY, clip);
  const track = placed?.track;
  if (!track) {
    showToast(placed?.error || "この位置には置けません。");
    return;
  }
  track.clips.push(clip);
  overwriteTrack(track, clip.id);
  state.selectedClipIds = [clip.id];
  state.previewTarget = "timeline";
  renderSequence();
  rememberProject(false);
}

/** 再生ヘッドの時刻に、空いているいちばん上の同種トラックへ置く。空がなければトラックを足す。 */
function trackForPlayheadClip(kind, start, duration) {
  const isAudio = kind === "音声";
  const type = isAudio ? "audio" : "video";
  const tracks = tracksTopToBottom().filter((item) => item.type === type);
  const free = tracks.find((item) => !item.locked && rangeFree(item, start, duration));
  if (free) return free;
  const track = createTrack(type, nextTrackLabel(type));
  if (isAudio) {
    const last = state.project.tracks.reduce((index, item, at) => (item.type === "audio" ? at : index), -1);
    state.project.tracks.splice(last + 1, 0, track);
  } else {
    const index = state.project.tracks.findIndex((item) => item.type === "video");
    state.project.tracks.splice(index < 0 ? 0 : index, 0, track);
  }
  return track;
}

async function placeMediaAtPlayhead(id) {
  const item = state.media.find((entry) => entry.id === id);
  if (!item) return;
  const startTime = Math.max(0, Number(state.currentTime) || 0);
  const duration = item.duration > 0 ? item.duration : await probeDuration(item.url, item.kind);
  item.duration = duration;
  const clip = createClip({
    type: item.kind,
    name: item.name,
    startTime,
    duration,
    sourceUrl: item.url,
    sourcePath: item.path || "",
  });
  const track = trackForPlayheadClip(item.kind, startTime, duration);
  track.clips.push(clip);
  track.clips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  state.selectedClipIds = [clip.id];
  state.previewTarget = "timeline";
  renderSequence();
  rememberProject(false);
}

const ZOOM_MIN = 6;
const ZOOM_MAX = 320;
let PX_PER_SEC = 56;
let selectedGap = null;
let pendingLanesScroll = null;
const MIN_CLIP_SEC = 0.5;
const CLIP_EPS = 0.001;
const SNAP_PX = 12;
let clipSerial = 1;

function nextClipId() {
  const id = `clip-${clipSerial}`;
  clipSerial += 1;
  return id;
}

const TEXT_CLIP_SEC = 3;

function rangeFree(track, start, duration) {
  const end = start + duration;
  return !track.clips.some((clip) => clip.startTime < end - CLIP_EPS && clip.startTime + clip.duration > start + CLIP_EPS);
}

function telopBoxSize(text, fontSize) {
  const { width, height } = projectSize();
  const size = Math.max(8, Number(fontSize) || 64);
  const lines = String(text || " ").split("\n");
  const longest = Math.max(1, ...lines.map((line) => [...line].length));
  const textWidth = Math.ceil(longest * size * 1.05) + Math.round(size * 0.8);
  const textHeight = Math.ceil(lines.length * size * 1.35) + Math.round(size * 0.45);
  return {
    width: Math.min(Math.round(width * 0.92), Math.max(Math.round(size * 2), textWidth)),
    height: Math.min(Math.round(height * 0.8), Math.max(Math.round(size * 1.4), textHeight)),
  };
}

function applyTelopBox(clip, text, fontSize) {
  const { height } = projectSize();
  const box = telopBoxSize(text, fontSize);
  clip.baseWidth = box.width;
  clip.baseHeight = box.height;
  clip.width = box.width;
  clip.height = box.height;
  clip.scale = 100;
  clip.y = Math.round(height / 2 - box.height / 2 - height * 0.04);
}

function videoTargetForNewTelop(start, duration) {
  const selected = findClip(activeClipId());
  if (selected?.clip.type === "動画") return selected.track;
  const end = start + duration;
  return tracksTopToBottom().find((track) => track.type === "video" && track.clips.some((clip) =>
    clip.type === "動画"
    && clip.startTime < end - CLIP_EPS
    && clip.startTime + clip.duration > start + CLIP_EPS
  )) || null;
}

function addTextClip() {
  const start = Math.max(0, Number(state.currentTime) || 0);
  const duration = TEXT_CLIP_SEC;
  const text = "新しいテキスト";
  const style = cloneTelopStyle(state.style);
  const clip = createClip({
    type: "テロップ",
    name: text,
    startTime: start,
    duration,
    sourceUrl: "",
  });
  clip.text = text;
  clip.style = style;
  applyTelopBox(clip, text, style.font_size);
  const ranges = [{ start, end: start + duration }];
  const target = videoTargetForNewTelop(start, duration);
  const track = ensureTelopTrack(target, ranges);
  track.clips.push(clip);
  track.clips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  state.selectedClipIds = [clip.id];
  state.previewTarget = "timeline";
  renderSequence();
  setCurrentTime(start);
  rememberProject(false);
}

function createClip({ type, name, startTime, duration, sourceUrl, sourcePath = "", kept = true }) {
  return {
    id: nextClipId(),
    type,
    name,
    startTime,
    duration,
    sourceUrl: sourceUrl || "",
    sourcePath: sourcePath || "",
    kept,
    x: 0,
    y: 0,
    scale: 100,
    rotation: 0,
    flipH: false,
    flipV: false,
    baseWidth: 0,
    baseHeight: 0,
    width: 0,
    height: 0,
    speed: 1,
    chromaEnabled: false,
    chromaColor: "#00ff00",
    volume: 100,
    fadeIn: 0,
    fadeOut: 0,
    pitch: 0,
  };
}

function baseVideoTrack() {
  return state.project.tracks.find((track) => track.type === "video");
}

function trackForKind(kind) {
  if (kind === "音声") return state.project.tracks.find((track) => track.type === "audio");
  return baseVideoTrack();
}

function projectDuration() {
  let max = 0;
  for (const track of state.project.tracks) {
    for (const clip of track.clips) max = Math.max(max, clip.startTime + clip.duration);
  }
  return max;
}

let timelineTail = 0;
let extendingTimeline = false;

function timelineSpan() {
  const view = $("seq-lanes-view");
  const visible = view && view.clientWidth > 0 ? view.clientWidth / PX_PER_SEC : 40;
  const base = Math.max(visible, 180);
  return Math.max(projectDuration() + base + timelineTail, 60);
}

function extendTimelineTail() {
  const view = $("seq-lanes-view");
  if (!view || extendingTimeline || view.clientWidth <= 0) return;
  const remain = view.scrollWidth - view.scrollLeft - view.clientWidth;
  if (remain > view.clientWidth * 0.45) return;
  extendingTimeline = true;
  timelineTail += Math.max(view.clientWidth / PX_PER_SEC, 60);
  pendingLanesScroll = view.scrollLeft;
  renderSequence();
  extendingTimeline = false;
}

function rulerMajorStep() {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const step of steps) {
    if (step * PX_PER_SEC >= 72) return step;
  }
  return steps[steps.length - 1];
}

function formatRulerLabel(seconds, step) {
  const safe = Math.max(0, seconds);
  const whole = Math.floor(safe);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = safe - hours * 3600 - minutes * 60;
  const secText = step < 1
    ? secs.toFixed(1).padStart(4, "0")
    : String(Math.floor(secs + 1e-6)).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${secText}`;
  return `${String(minutes).padStart(2, "0")}:${secText}`;
}

function zoomFromSlider(value) {
  const t = Math.min(1, Math.max(0, Number(value) / 100));
  return ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** t;
}

function sliderValueForZoom(px) {
  const t = Math.log(px / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN);
  return String(Math.round(Math.min(1, Math.max(0, t)) * 100));
}

function syncZoomSlider() {
  const slider = $("tl-zoom");
  if (!slider || document.activeElement === slider) return;
  slider.value = sliderValueForZoom(PX_PER_SEC);
}

function setTimelineZoom(nextPx, anchorTime, anchorClientX) {
  const view = $("seq-lanes-view");
  const px = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextPx));
  let time = anchorTime;
  let offset = 0;
  if (view) {
    const rect = view.getBoundingClientRect();
    if (anchorClientX == null) {
      offset = state.currentTime * PX_PER_SEC - view.scrollLeft;
      time = state.currentTime;
    } else {
      offset = anchorClientX - rect.left;
      if (time == null) time = (view.scrollLeft + offset) / PX_PER_SEC;
    }
  }
  PX_PER_SEC = px;
  pendingLanesScroll = view ? Math.max(0, time * px - offset) : null;
  renderSequence();
  syncZoomSlider();
}

function bindTimelineZoom() {
  const slider = $("tl-zoom");
  const view = $("seq-lanes-view");
  if (!slider || !view || slider.dataset.bound) return;
  slider.dataset.bound = "1";
  slider.value = sliderValueForZoom(PX_PER_SEC);
  slider.addEventListener("input", () => {
    const rect = view.getBoundingClientRect();
    const playheadX = rect.left + state.currentTime * PX_PER_SEC - view.scrollLeft;
    setTimelineZoom(zoomFromSlider(slider.value), state.currentTime, playheadX);
  });
  view.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    const rect = view.getBoundingClientRect();
    const time = (view.scrollLeft + event.clientX - rect.left) / PX_PER_SEC;
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    setTimelineZoom(PX_PER_SEC * factor, time, event.clientX);
  }, { passive: false });
}

function formatClock(seconds) {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(safe / 60);
  const remain = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`;
}

function formatMediaClock(seconds) {
  const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remain = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`;
}

function mediaUrlUsed(url) {
  if (!url) return false;
  for (const track of state.project.tracks) {
    for (const clip of track.clips) {
      if (clip.sourceUrl === url) return true;
    }
  }
  return false;
}

function syncMediaUsedMarks() {
  const list = $("media-list");
  if (!list) return;
  for (const li of list.querySelectorAll(".media-item")) {
    const item = state.media.find((entry) => entry.id === li.dataset.id);
    const used = !!(item && mediaUrlUsed(item.url));
    let mark = li.querySelector(".media-used");
    if (used && !mark) {
      mark = document.createElement("span");
      mark.className = "media-used";
      mark.textContent = "✔";
      mark.title = "タイムラインで使用中";
      li.append(mark);
    } else if (!used && mark) {
      mark.remove();
    }
  }
}

function xToTime(clientX, el) {
  const rect = el.getBoundingClientRect();
  return Math.max(0, (clientX - rect.left) / PX_PER_SEC);
}

function setCurrentTime(time) {
  const span = timelineSpan();
  const next = Math.min(Math.max(0, time), span);
  state.currentTime = next;
  if (state.playing && state.previewTarget === "timeline" && playClock && !timelineTick) {
    playClock.startPerf = performance.now();
    playClock.startTime = next;
  }
  placePlayhead();
  if (state.previewTarget !== "timeline") return;
  syncTimelineFrame();
}

function setMediaTime(time) {
  const monitor = previewMonitor();
  const duration = monitor && Number.isFinite(monitor.duration) ? monitor.duration : 0;
  const next = duration > 0 ? Math.min(Math.max(0, time), duration) : Math.max(0, time);
  state.mediaTime = next;
  if (!monitor || !Number.isFinite(monitor.duration) || monitor.duration <= 0) {
    syncPreviewControls();
    return;
  }
  if (Math.abs(monitor.currentTime - next) < 0.001) {
    syncPreviewControls();
    return;
  }
  syncingMonitor = true;
  monitor.currentTime = next;
  syncPreviewControls();
}

function pullMonitorTime() {
  const monitor = previewMonitor();
  if (!monitor || scrubbingTimeline || syncingMonitor) return;
  if (state.previewTarget !== "media") return;
  if (!Number.isFinite(monitor.currentTime)) return;
  if (state.previewTarget === "media") {
    state.mediaTime = monitor.currentTime;
    syncPreviewControls();
    return;
  }
  if (state.currentTime > monitor.duration + 0.05) return;
  state.currentTime = monitor.currentTime;
  placePlayhead();
  applyClipPlayback();
}

function bindPreviewMonitor() {
  const monitor = previewMonitor();
  if (!monitor || monitor.dataset.bound) return;
  monitor.dataset.bound = "1";
  monitor.crossOrigin = "anonymous";
  ensurePreviewPitch();
  monitor.addEventListener("timeupdate", () => {
    if (syncingMonitor && !monitor.seeking && Math.abs(monitor.currentTime - state.currentTime) < 0.08) {
      syncingMonitor = false;
    }
    pullMonitorTime();
  });
  monitor.addEventListener("seeked", () => {
    if (scrubbingTimeline) return;
    syncingMonitor = false;
    pullMonitorTime();
  });
  monitor.addEventListener("play", () => {
    updatePlayback();
    requestAnimationFrame(tick);
  });
  monitor.addEventListener("pause", updatePlayback);
  monitor.addEventListener("ended", () => {
    state.playing = false;
    updatePlayback();
  });
}

function startRulerScrub(event) {
  if (event.button !== 0) return;
  const ruler = $("seq-ruler");
  const resume = playbackActive();
  scrubbingTimeline = true;
  if (resume) setPlaying(false);
  setCurrentTime(xToTime(event.clientX, ruler));
  trackPointer(event.currentTarget, event, (moveEvent) => {
    setCurrentTime(xToTime(moveEvent.clientX, ruler));
  }, () => {
    scrubbingTimeline = false;
    const current = previewMonitor();
    if (current && !current.seeking) syncingMonitor = false;
    if (resume) setPlaying(true);
  });
}

function activeClipId() {
  return state.selectedClipIds.length === 1 ? state.selectedClipIds[0] : null;
}

function setClipSelection(ids) {
  const next = [];
  for (const id of ids) {
    if (!id || next.includes(id) || !findClip(id)) continue;
    next.push(id);
  }
  state.selectedClipIds = next;
  if (next.length) {
    state.previewTarget = "timeline";
    clearSelectedGap();
  }
}

function selectClip(id, options = {}) {
  if (options.additive && id) {
    const next = state.selectedClipIds.includes(id)
      ? state.selectedClipIds.filter((item) => item !== id)
      : [...state.selectedClipIds, id];
    setClipSelection(next);
  } else {
    setClipSelection(id ? [id] : []);
  }
  for (const el of document.querySelectorAll("#seq-lanes .seq-clip")) {
    el.classList.toggle("is-selected", state.selectedClipIds.includes(el.dataset.id));
  }
  syncEditCommands();
}

function syncEditCommands() {
  const located = findClip(activeClipId());
  const selected = state.selectedClipIds.map((id) => findClip(id)?.clip).filter(Boolean);
  const videoCount = selected.filter((clip) => clip.type === "動画").length;
  const telopCount = selected.filter((clip) => clip.type === "テロップ").length;
  const busy = state.busy;
  const any = selected.length > 0;
  const split = $("split-btn");
  const remove = $("delete-btn");
  if (split) split.disabled = !located;
  if (remove) remove.disabled = !any;
  const crop = $("crop-btn");
  const soleCrop = selected.length === 1 && isCropClip(selected[0]);
  if (crop) crop.disabled = busy || !soleCrop;
  const cut = $("cut-silence-btn");
  const compare = $("cut-compare-btn");
  const generate = $("telop-generate-btn");
  const edit = $("telop-edit-btn");
  if (cut) cut.disabled = busy || videoCount < 1;
  if (compare) compare.disabled = busy || videoCount < 1;
  if (generate) generate.disabled = busy || videoCount < 1;
  if (edit) edit.disabled = busy || (videoCount < 1 && telopCount < 1);
  syncPropertyPanel();
}

function isCropClip(clip) {
  return !!clip && (clip.type === "動画" || isStillClip(clip)) && !!clip.sourceUrl;
}

let cropSession = null;

function cropRatioValue(aspect) {
  if (aspect === "16:9") return 16 / 9;
  if (aspect === "4:3") return 4 / 3;
  if (aspect === "1:1") return 1;
  if (aspect === "9:16") return 9 / 16;
  return 0;
}

function detectCropAspect(rect) {
  if (!(rect.width > 0) || !(rect.height > 0)) return "free";
  const ratio = rect.width / rect.height;
  const options = [["16:9", 16 / 9], ["4:3", 4 / 3], ["1:1", 1], ["9:16", 9 / 16]];
  for (const [key, value] of options) {
    if (Math.abs(ratio - value) < 0.03) return key;
  }
  return "free";
}

function minCropSize(sourceW, sourceH) {
  return Math.max(16, Math.min(sourceW, sourceH) * 0.08);
}

function fitCropRect(rect, sourceW, sourceH) {
  const min = minCropSize(sourceW, sourceH);
  let width = Math.min(sourceW, Math.max(min, rect.width));
  let height = Math.min(sourceH, Math.max(min, rect.height));
  if (width > sourceW) width = sourceW;
  if (height > sourceH) height = sourceH;
  const x = Math.min(Math.max(0, rect.x), Math.max(0, sourceW - width));
  const y = Math.min(Math.max(0, rect.y), Math.max(0, sourceH - height));
  return { x, y, width, height };
}

function sourceCropRect(clip, sourceW, sourceH) {
  if (!clip || !(sourceW > 1) || !(sourceH > 1)) return null;
  const width = Number(clip.cropWidth);
  const height = Number(clip.cropHeight);
  if (!(width > 1) || !(height > 1)) return null;
  const rect = savedCropRect(clip, sourceW, sourceH);
  const full = rect.x <= 1 && rect.y <= 1 && rect.width >= sourceW - 1 && rect.height >= sourceH - 1;
  return full ? null : rect;
}

function clearMediaCrop(media) {
  if (!media) return;
  media.style.position = "";
  media.style.left = "";
  media.style.top = "";
  media.style.width = "";
  media.style.height = "";
  media.style.objectFit = "";
  media.style.maxWidth = "";
}

/** 切り抜き範囲がレイヤーいっぱいに見えるよう、素材を拡大してずらす。共有の映像要素には残さない。 */
function layoutCroppedMedia(media, clip, host) {
  if (!media || !host) return;
  clearMediaCrop(media);
  media.style.visibility = "";
  paintClipCrop(host, clip, media);
}

const cropPaintNodes = new Set();
let cropPaintFrame = 0;

function ensureCropCanvas(node) {
  let canvas = node.querySelector(":scope > canvas.preview-crop");
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "preview-crop";
    canvas.hidden = true;
    node.append(canvas);
  }
  return canvas;
}

function paintClipCrop(node, clip, media) {
  if (!node || !clip || !media) return;
  node.dataset.clipId = clip.id;
  media.dataset.cropFor = clip.id;
  const canvas = ensureCropCanvas(node);
  const sourceW = media.tagName === "VIDEO" ? media.videoWidth : media.naturalWidth;
  const sourceH = media.tagName === "VIDEO" ? media.videoHeight : media.naturalHeight;
  const crop = sourceCropRect(clip, sourceW, sourceH);
  const chromaOwns = clip.chromaEnabled && clip.id === monitorHostId;
  if (!crop || chromaOwns || !(node.clientWidth > 1) || !(node.clientHeight > 1)) {
    canvas.hidden = true;
    media.style.visibility = "";
    cropPaintNodes.delete(node);
    if (!cropPaintNodes.size && cropPaintFrame) {
      cancelAnimationFrame(cropPaintFrame);
      cropPaintFrame = 0;
    }
    return;
  }
  canvas.hidden = false;
  media.style.visibility = "hidden";
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(node.clientWidth * dpr));
  const height = Math.max(1, Math.round(node.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  drawContained(ctx, media, sourceW, sourceH, 0, 0, width, height, crop);
  cropPaintNodes.add(node);
  if (!cropPaintFrame) cropPaintFrame = requestAnimationFrame(repaintCropNodes);
}

function repaintCropNodes() {
  cropPaintFrame = 0;
  for (const node of [...cropPaintNodes]) {
    if (!node.isConnected) {
      cropPaintNodes.delete(node);
      continue;
    }
    const clip = findClip(node.dataset.clipId)?.clip;
    const media = node.querySelector("video, img");
    if (!clip || !media || media.dataset.cropFor !== clip.id) {
      cropPaintNodes.delete(node);
      continue;
    }
    paintClipCrop(node, clip, media);
  }
}

function watchCropLayout(media, clip, host) {
  if (!media || !host || !clip) return;
  clearMediaCrop(media);
  media.dataset.cropFor = clip.id;
  host.dataset.clipId = clip.id;
  paintClipCrop(host, clip, media);
  const ready = media.tagName === "VIDEO" ? media.videoWidth > 1 : media.naturalWidth > 1;
  if (ready) return;
  const event = media.tagName === "VIDEO" ? "loadedmetadata" : "load";
  const clipId = clip.id;
  media.addEventListener(event, () => {
    if (media.dataset.cropFor !== clipId) return;
    const live = findClip(clipId)?.clip;
    if (live) paintClipCrop(host, live, media);
  }, { once: true });
}

function savedCropRect(clip, sourceW, sourceH) {
  const width = Number(clip.cropWidth);
  const height = Number(clip.cropHeight);
  if (!(width > 1) || !(height > 1)) return { x: 0, y: 0, width: sourceW, height: sourceH };
  return fitCropRect({
    x: Number(clip.cropX) || 0,
    y: Number(clip.cropY) || 0,
    width,
    height,
  }, sourceW, sourceH);
}

function cropMediaView() {
  const stage = $("crop-stage");
  if (!stage || !cropSession) return null;
  const bounds = stage.getBoundingClientRect();
  const scale = Math.min(bounds.width / cropSession.sourceW, bounds.height / cropSession.sourceH);
  const width = cropSession.sourceW * scale;
  const height = cropSession.sourceH * scale;
  return {
    left: (bounds.width - width) / 2,
    top: (bounds.height - height) / 2,
    width,
    height,
    scale,
    bounds,
  };
}

function clientToCropSource(clientX, clientY) {
  const view = cropMediaView();
  if (!view || !(view.scale > 0)) return { x: 0, y: 0 };
  return {
    x: (clientX - view.bounds.left - view.left) / view.scale,
    y: (clientY - view.bounds.top - view.top) / view.scale,
  };
}

function layoutCrop() {
  if (!cropSession) return;
  const view = cropMediaView();
  const media = cropSession.still ? $("crop-image") : $("crop-video");
  const box = $("crop-box");
  if (!view || !media || !box) return;
  media.hidden = false;
  media.style.left = `${view.left}px`;
  media.style.top = `${view.top}px`;
  media.style.width = `${view.width}px`;
  media.style.height = `${view.height}px`;
  const rect = cropSession.rect;
  box.hidden = false;
  box.style.left = `${view.left + rect.x * view.scale}px`;
  box.style.top = `${view.top + rect.y * view.scale}px`;
  box.style.width = `${Math.max(8, rect.width * view.scale)}px`;
  box.style.height = `${Math.max(8, rect.height * view.scale)}px`;
  const readout = $("crop-readout");
  if (readout) {
    readout.textContent = `X ${Math.round(rect.x)}　Y ${Math.round(rect.y)}　幅 ${Math.round(rect.width)}　高さ ${Math.round(rect.height)}`;
  }
}

function applyCropAspect() {
  if (!cropSession) return;
  const ratio = cropRatioValue(cropSession.aspect);
  if (!ratio) return;
  const { sourceW, sourceH, rect } = cropSession;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let width = rect.width;
  let height = width / ratio;
  if (height > sourceH) {
    height = sourceH;
    width = height * ratio;
  }
  if (width > sourceW) {
    width = sourceW;
    height = width / ratio;
  }
  cropSession.rect = fitCropRect({
    x: cx - width / 2,
    y: cy - height / 2,
    width,
    height,
  }, sourceW, sourceH);
}

function moveCrop(start, dx, dy) {
  cropSession.rect = fitCropRect({
    x: start.x + dx,
    y: start.y + dy,
    width: start.width,
    height: start.height,
  }, cropSession.sourceW, cropSession.sourceH);
}

function resizeCrop(start, handle, pointer) {
  const ratio = cropRatioValue(cropSession.aspect);
  const left = handle.includes("w");
  const top = handle.includes("n");
  const anchorX = left ? start.x + start.width : start.x;
  const anchorY = top ? start.y + start.height : start.y;
  let width = Math.max(minCropSize(cropSession.sourceW, cropSession.sourceH), Math.abs(pointer.x - anchorX));
  let height = Math.max(minCropSize(cropSession.sourceW, cropSession.sourceH), Math.abs(pointer.y - anchorY));
  if (ratio) {
    if (width / height > ratio) width = height * ratio;
    else height = width / ratio;
  }
  let x = left ? anchorX - width : anchorX;
  let y = top ? anchorY - height : anchorY;
  if (x < 0) {
    width += x;
    x = 0;
    if (ratio) height = width / ratio;
    if (top) y = anchorY - height;
  }
  if (y < 0) {
    height += y;
    y = 0;
    if (ratio) width = height * ratio;
    if (left) x = anchorX - width;
  }
  if (x + width > cropSession.sourceW) {
    width = cropSession.sourceW - x;
    if (ratio) height = width / ratio;
    if (top) y = anchorY - height;
  }
  if (y + height > cropSession.sourceH) {
    height = cropSession.sourceH - y;
    if (ratio) width = height * ratio;
    if (left) x = anchorX - width;
  }
  cropSession.rect = fitCropRect({ x, y, width, height }, cropSession.sourceW, cropSession.sourceH);
}

function bindCropDialog() {
  const dialog = $("crop-dialog");
  const box = $("crop-box");
  const aspect = $("crop-aspect");
  if (!dialog || !box || dialog.dataset.bound) return;
  dialog.dataset.bound = "1";
  box.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !cropSession) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.target instanceof Element ? event.target.closest(".crop-handle") : null;
    const mode = handle?.dataset.handle || "move";
    const origin = clientToCropSource(event.clientX, event.clientY);
    const start = { ...cropSession.rect };
    trackPointer(box, event, (moveEvent) => {
      const now = clientToCropSource(moveEvent.clientX, moveEvent.clientY);
      if (mode === "move") moveCrop(start, now.x - origin.x, now.y - origin.y);
      else resizeCrop(start, mode, now);
      layoutCrop();
    }, () => {});
  });
  aspect.addEventListener("change", () => {
    if (!cropSession) return;
    cropSession.aspect = aspect.value;
    applyCropAspect();
    layoutCrop();
  });
  $("crop-apply").addEventListener("click", applyCrop);
  dialog.addEventListener("close", () => {
    const video = $("crop-video");
    const image = $("crop-image");
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.hidden = true;
    }
    if (image) {
      image.removeAttribute("src");
      image.hidden = true;
    }
    cropSession = null;
  });
  window.addEventListener("resize", () => {
    if (dialog.open) layoutCrop();
  });
}

function beginCropSession(clip, sourceW, sourceH) {
  cropSession = {
    clipId: clip.id,
    still: isStillClip(clip),
    sourceW,
    sourceH,
    aspect: clip.cropAspect || "free",
    rect: savedCropRect(clip, sourceW, sourceH),
  };
  if (!clip.cropAspect) cropSession.aspect = detectCropAspect(cropSession.rect);
  const aspect = $("crop-aspect");
  if (aspect) aspect.value = cropSession.aspect;
  const video = $("crop-video");
  const image = $("crop-image");
  if (cropSession.still) {
    video.hidden = true;
    image.hidden = false;
  } else {
    image.hidden = true;
    video.hidden = false;
  }
  layoutCrop();
}

function openCropDialog() {
  const located = findClip(activeClipId());
  const clip = located?.clip;
  if (!isCropClip(clip)) {
    showToast("切り抜く動画か画像を1つ選んでください。");
    return;
  }
  bindCropDialog();
  const dialog = $("crop-dialog");
  const name = $("crop-name");
  if (name) name.textContent = clip.name || "";
  const video = $("crop-video");
  const image = $("crop-image");
  const box = $("crop-box");
  if (box) box.hidden = true;
  if (!dialog.open) dialog.showModal();
  const fail = () => {
    showToast("この素材をプレビューできませんでした。");
    if (dialog.open) dialog.close();
  };
  if (isStillClip(clip)) {
    video.hidden = true;
    image.hidden = false;
    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!(width > 0) || !(height > 0)) {
        fail();
        return;
      }
      beginCropSession(clip, width, height);
    };
    image.onerror = fail;
    image.src = clip.sourceUrl;
    return;
  }
  image.hidden = true;
  video.hidden = false;
  video.onloadedmetadata = () => {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!(width > 0) || !(height > 0)) {
      fail();
      return;
    }
    const at = Number.isFinite(clip.sourceStart) ? Math.max(0, clip.sourceStart) : 0;
    const seek = () => beginCropSession(clip, width, height);
    if (at > 0 && Number.isFinite(video.duration)) {
      video.addEventListener("seeked", seek, { once: true });
      try {
        video.currentTime = Math.min(at, Math.max(0, video.duration - 0.05));
      } catch {
        seek();
      }
      return;
    }
    seek();
  };
  video.onerror = fail;
  video.src = clip.sourceUrl;
}

function applyCrop() {
  if (!cropSession?.clipId) return;
  const located = findClip(cropSession.clipId);
  if (!located) return;
  const clip = located.clip;
  const rect = cropSession.rect;
  clip.cropX = Math.round(rect.x);
  clip.cropY = Math.round(rect.y);
  clip.cropWidth = Math.round(rect.width);
  clip.cropHeight = Math.round(rect.height);
  clip.cropAspect = cropSession.aspect || "free";
  rememberProject(false);
  if (state.previewTarget === "timeline") syncTimelineFrame();
  showToast("切り抜きを適用しました。");
  const dialog = $("crop-dialog");
  if (dialog?.open) dialog.close();
}

function selectedEditableClip() {
  const located = findClip(activeClipId());
  if (!located) return null;
  if (located.clip.type !== "動画" && located.clip.type !== "画像" && located.clip.type !== "テロップ") return null;
  return located.clip;
}

function selectedDirectClip() {
  const located = findClip(activeClipId());
  if (!located) return null;
  if (located.clip.type !== "動画" && located.clip.type !== "画像" && located.clip.type !== "テロップ") return null;
  return located.clip;
}

function projectSize() {
  return {
    width: state.project.width || 1920,
    height: state.project.height || 1080,
  };
}

function canvasUnits(canvas = $("preview-canvas")) {
  const { width, height } = projectSize();
  const sx = canvas && canvas.clientWidth > 0 ? canvas.clientWidth / width : 1;
  const sy = canvas && canvas.clientHeight > 0 ? canvas.clientHeight / height : 1;
  return { sx, sy };
}

function ensureClipLayout(clip) {
  const { width, height } = projectSize();
  if (!(clip.baseWidth > 0)) clip.baseWidth = width;
  if (!(clip.baseHeight > 0)) clip.baseHeight = height;
  if (!(clip.scale > 0)) clip.scale = 100;
  if (!(clip.width > 0)) clip.width = clip.baseWidth * clip.scale / 100;
  if (!(clip.height > 0)) clip.height = clip.baseHeight * clip.scale / 100;
  clip.flipH = Boolean(clip.flipH);
  clip.flipV = Boolean(clip.flipV);
  if (!(clip.speed > 0)) clip.speed = 1;
  if (clip.chromaEnabled == null) clip.chromaEnabled = false;
  if (!clip.chromaColor) clip.chromaColor = "#00ff00";
  if (clip.volume == null) clip.volume = 100;
  if (clip.fadeIn == null) clip.fadeIn = 0;
  if (clip.fadeOut == null) clip.fadeOut = 0;
  if (clip.pitch == null) clip.pitch = 0;
  if (clip.x == null) clip.x = 0;
  if (clip.y == null) clip.y = 0;
  if (clip.rotation == null) clip.rotation = 0;
}

function setClipScale(clip, scale) {
  ensureClipLayout(clip);
  const next = Math.min(400, Math.max(1, scale));
  clip.scale = next;
  clip.width = clip.baseWidth * next / 100;
  clip.height = clip.baseHeight * next / 100;
}

function placeLayer(el, clip) {
  const { sx, sy } = canvasUnits();
  const x = (Number(clip.x) || 0) * sx;
  const y = (Number(clip.y) || 0) * sy;
  const fx = clip.flipH ? -1 : 1;
  const fy = clip.flipV ? -1 : 1;
  el.style.width = `${clip.width * sx}px`;
  el.style.height = `${clip.height * sy}px`;
  el.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) rotate(${Number(clip.rotation) || 0}deg) scale(${fx}, ${fy})`;
}

function mountPreviewBox(layer) {
  const box = $("preview-box");
  const canvas = $("preview-canvas");
  if (!box || !layer || !canvas) return;
  if (box.parentElement !== canvas) canvas.append(box);
  box.hidden = false;
  box.style.left = "50%";
  box.style.top = "50%";
  box.style.width = layer.style.width;
  box.style.height = layer.style.height;
  box.style.transform = layer.style.transform;
}

function hidePreviewBox() {
  const box = $("preview-box");
  if (box) box.hidden = true;
}

function resetVideoFrame() {
  const frame = $("preview-transform");
  if (!frame) return;
  frame.style.width = "100%";
  frame.style.height = "100%";
  frame.style.transform = "translate(-50%, -50%)";
}

function hidePreviewGuides() {
  const guideX = $("preview-guide-x");
  const guideY = $("preview-guide-y");
  if (guideX) guideX.hidden = true;
  if (guideY) guideY.hidden = true;
}

function showPreviewGuides(snap) {
  const guideX = $("preview-guide-x");
  const guideY = $("preview-guide-y");
  if (!guideX || !guideY) return;
  const xAt = { center: "50%", left: "0", right: "100%" };
  const yAt = { center: "50%", top: "0", bottom: "100%" };
  guideX.hidden = !snap.xGuide;
  guideY.hidden = !snap.yGuide;
  if (snap.xGuide) guideX.style.left = xAt[snap.xGuide];
  if (snap.yGuide) guideY.style.top = yAt[snap.yGuide];
}

let previewPitch = null;
let previewPitchJob = null;
let previewPitchSemis = 0;
let chromaLoop = 0;
let narrationRecorder = null;
let narrationAudio = null;
const previewLayers = new Map();
let monitorHostId = null;
let playClock = null;
let timelineTick = false;

function playbackActive() {
  if (state.previewTarget === "timeline") return state.playing;
  const monitor = previewMonitor();
  return Boolean(monitor && monitor.src && !monitor.paused && !monitor.ended);
}

function tickTimeline() {
  if (!state.playing || state.previewTarget !== "timeline" || !playClock) return;
  const elapsed = (performance.now() - playClock.startPerf) / 1000;
  const next = playClock.startTime + elapsed;
  const end = projectDuration();
  if (end > 0 && next >= end) {
    setCurrentTime(end);
    setPlaying(false);
    return;
  }
  timelineTick = true;
  setCurrentTime(next);
  timelineTick = false;
  requestAnimationFrame(tickTimeline);
}

function applyPreviewPitch(semitones) {
  previewPitchSemis = semitones;
  const graph = previewPitch;
  if (!graph) {
    ensurePreviewPitch();
    return;
  }
  const ratio = 2 ** (semitones / 12);
  if (graph.mode === "worklet") {
    const param = graph.shift.parameters.get("ratio");
    if (param) param.value = ratio;
    if (graph.ctx.state === "suspended") graph.ctx.resume();
    return;
  }
  const monitor = previewMonitor();
  if (!monitor) return;
  const speed = monitor.playbackRate || 1;
  monitor.preservesPitch = Math.abs(semitones) < 0.01;
  monitor.playbackRate = Math.abs(semitones) < 0.01 ? speed : speed * ratio;
}

function ensurePreviewPitch() {
  if (previewPitch || previewPitchJob) return previewPitchJob;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const monitor = previewMonitor();
  if (!Ctx || !monitor) return null;
  previewPitchJob = (async () => {
    const ctx = new Ctx();
    try {
      await ctx.audioWorklet.addModule(new URL("pitch-processor.js", window.location.href).href);
      const source = ctx.createMediaElementSource(monitor);
      const gain = ctx.createGain();
      const shift = new AudioWorkletNode(ctx, "pitch-processor");
      source.connect(gain);
      gain.connect(shift);
      shift.connect(ctx.destination);
      previewPitch = { ctx, shift, gain, mode: "worklet" };
    } catch {
      try {
        const source = ctx.createMediaElementSource(monitor);
        const gain = ctx.createGain();
        source.connect(gain);
        gain.connect(ctx.destination);
        previewPitch = { ctx, gain, mode: "rate" };
      } catch {
        previewPitch = { ctx, mode: "rate" };
      }
    }
    applyPreviewPitch(previewPitchSemis);
    return previewPitch;
  })();
  return previewPitchJob;
}

function chromaTarget() {
  const time = state.currentTime;
  const selected = findClip(activeClipId())?.clip;
  if (
    selected?.type === "動画"
    && selected.chromaEnabled
    && time >= selected.startTime
    && time < selected.startTime + selected.duration
  ) {
    return selected;
  }
  for (const track of state.project.tracks) {
    if (track.type !== "video" || track.visible === false) continue;
    for (const clip of track.clips) {
      if (clip.type !== "動画" || !clip.chromaEnabled) continue;
      if (time >= clip.startTime && time < clip.startTime + clip.duration) return clip;
    }
  }
  return null;
}

function chromaKeyRgb(color) {
  const match = /^#?([0-9a-f]{6})$/i.exec(color || "");
  const hex = match ? match[1] : "00ff00";
  const value = Number.parseInt(hex, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function paintChroma() {
  const video = previewMonitor();
  const canvas = $("preview-chroma");
  if (!video || !canvas) return;
  const clip = chromaTarget();
  if (!clip || clip.id !== monitorHostId || video.readyState < 2 || video.videoWidth < 2 || video.clientWidth < 2) {
    canvas.hidden = true;
    video.classList.remove("is-chroma-hidden");
    return;
  }
  const ratio = 1;
  const width = Math.max(2, Math.round(video.clientWidth * ratio));
  const height = Math.max(2, Math.round(video.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  const crop = sourceCropRect(clip, video.videoWidth, video.videoHeight);
  drawContained(ctx, video, video.videoWidth, video.videoHeight, 0, 0, width, height, crop);
  let image;
  try {
    image = ctx.getImageData(0, 0, width, height);
  } catch {
    canvas.hidden = true;
    video.classList.remove("is-chroma-hidden");
    return;
  }
  const data = image.data;
  const [keyR, keyG, keyB] = chromaKeyRgb(clip.chromaColor);
  const limit = 110;
  const edge = 35;
  const limitSq = limit * limit;
  const inner = limit - edge;
  const innerSq = inner * inner;
  for (let i = 0; i < data.length; i += 4) {
    const dr = data[i] - keyR;
    const dg = data[i + 1] - keyG;
    const db = data[i + 2] - keyB;
    const distSq = dr * dr + dg * dg + db * db;
    if (distSq >= limitSq) continue;
    const alpha = distSq <= innerSq ? 0 : (Math.sqrt(distSq) - inner) / edge;
    data[i + 3] = Math.round(data[i + 3] * alpha);
  }
  ctx.putImageData(image, 0, 0);
  canvas.hidden = false;
  video.classList.add("is-chroma-hidden");
}

function startChromaLoop() {
  if (!chromaTarget()) {
    paintChroma();
    return;
  }
  if (chromaLoop) return;
  const step = () => {
    paintChroma();
    if (chromaTarget()) chromaLoop = requestAnimationFrame(step);
    else {
      chromaLoop = 0;
      const video = previewMonitor();
      const canvas = $("preview-chroma");
      if (canvas) canvas.hidden = true;
      if (video) video.classList.remove("is-chroma-hidden");
    }
  };
  chromaLoop = requestAnimationFrame(step);
}

function narrationPlayer() {
  if (!narrationAudio) {
    narrationAudio = document.createElement("audio");
    narrationAudio.preload = "auto";
  }
  return narrationAudio;
}

function audioClipAt(time) {
  for (let index = state.project.tracks.length - 1; index >= 0; index -= 1) {
    const track = state.project.tracks[index];
    if (track.type !== "audio" || track.muted || track.visible === false) continue;
    for (const clip of track.clips) {
      if (clip.type !== "音声" || !clip.sourceUrl) continue;
      if (time >= clip.startTime && time < clip.startTime + clip.duration) return clip;
    }
  }
  return null;
}

function syncNarration() {
  const audio = narrationPlayer();
  const clip = audioClipAt(state.currentTime);
  const monitor = previewMonitor();
  const playing = state.previewTarget === "timeline"
    ? state.playing
    : Boolean(monitor && monitor.src && !monitor.paused && !monitor.ended);
  if (!clip) {
    if (!audio.paused) audio.pause();
    return;
  }
  if (audio.dataset.clip !== clip.id) {
    audio.dataset.clip = clip.id;
    audio.src = clip.sourceUrl;
  }
  const local = localSourceTime(clip);
  if (!Number.isFinite(audio.currentTime) || Math.abs(audio.currentTime - local) > 0.25) {
    try {
      audio.currentTime = local;
    } catch {
      // メタデータ前のシークは次の更新でやり直す
    }
  }
  audio.muted = previewMuted;
  applyElementGain(audio, (clampVolume(clip.volume) / 100) * masterPreviewGain());
  if (playing) {
    if (audio.paused) audio.play().catch(() => {});
  } else if (!audio.paused) {
    audio.pause();
  }
}

function setMicRecording(on) {
  const button = $("mic-btn");
  if (!button) return;
  button.classList.toggle("is-recording", on);
  button.setAttribute("aria-pressed", on ? "true" : "false");
  const label = on ? "録音を停止" : "ナレーションを録音";
  button.setAttribute("aria-label", label);
  button.title = label;
}

function narrationMime() {
  if (typeof MediaRecorder === "undefined") return "";
  const types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function placeNarrationClip(blob) {
  const url = URL.createObjectURL(blob);
  const duration = await probeDuration(url, "音声");
  const name = `ナレーション ${formatClock(state.currentTime)}`;
  state.media.push({ id: nextMediaId(), name, kind: "音声", url, duration });
  const track = trackForKind("音声");
  if (!track) {
    showToast("音声トラックがありません。");
    return;
  }
  const clip = createClip({
    type: "音声",
    name,
    startTime: state.currentTime,
    duration,
    sourceUrl: url,
  });
  track.clips.push(clip);
  state.selectedClipIds = [clip.id];
  state.previewTarget = "timeline";
  renderMediaList();
  renderSequence();
  syncPropertyPanel();
  rememberProject(false);
  showToast(`「${name}」を追加しました。`);
}

async function toggleNarration() {
  if (narrationRecorder && narrationRecorder.state === "recording") {
    narrationRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showToast("この環境ではマイク録音が使えません。");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = narrationMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      narrationRecorder = null;
      setMicRecording(false);
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
      if (!blob.size) {
        showToast("録音データがありません。");
        return;
      }
      placeNarrationClip(blob);
    });
    narrationRecorder = recorder;
    recorder.start();
    setMicRecording(true);
    showToast("録音を開始しました。もう一度押すと止まります。");
  } catch (error) {
    narrationRecorder = null;
    setMicRecording(false);
    showToast(error.message || "マイクを使えませんでした。");
  }
}

function applyClipPlayback() {
  if (state.previewTarget === "timeline") {
    syncLayerPlayback();
    return;
  }
  const monitor = previewMonitor();
  if (!monitor) return;
  monitor.muted = previewMuted;
  const located = findClip(activeClipId());
  const clip = located?.clip;
  if (!clip || clip.type !== "動画") {
    monitor.playbackRate = 1;
    monitor.preservesPitch = true;
    applyElementGain(monitor, masterPreviewGain());
    applyPreviewPitch(0);
    startChromaLoop();
    return;
  }
  ensureClipLayout(clip);
  const speed = Math.min(4, Math.max(0.1, clip.speed));
  const semis = Math.min(12, Math.max(-12, Number(clip.pitch) || 0));
  monitor.preservesPitch = true;
  monitor.playbackRate = speed;
  applyPreviewPitch(semis);
  applyElementGain(monitor, clipGain(clip));
  startChromaLoop();
}

function isStillClip(clip) {
  return clip.type === "画像" || clip.type === "写真";
}

function visualClipsAt(time) {
  const tracks = tracksTopToBottom().filter((track) => track.type === "video" && track.visible !== false);
  const clips = [];
  for (let index = tracks.length - 1; index >= 0; index -= 1) {
    const hits = tracks[index].clips.filter((clip) => {
      if (clip.type === "音声") return false;
      return time >= clip.startTime && time < clip.startTime + clip.duration;
    });
    hits.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
    clips.push(...hits);
  }
  return clips;
}

function ensurePreviewStack() {
  const canvas = $("preview-canvas");
  if (!canvas) return null;
  let stack = $("preview-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "preview-stack";
    stack.className = "preview-stack";
    canvas.append(stack);
  }
  return stack;
}

function parkMonitor() {
  const frame = $("preview-transform");
  const monitor = previewMonitor();
  const chroma = $("preview-chroma");
  if (!frame || !monitor) return;
  if (monitor.parentElement !== frame) frame.insertBefore(monitor, frame.firstChild);
  if (chroma && chroma.parentElement !== frame) frame.append(chroma);
  monitorHostId = null;
  clearMediaCrop(monitor);
}

function hideTimelineStack() {
  const canvas = $("preview-canvas");
  if (canvas) canvas.classList.remove("is-timeline");
  parkMonitor();
  const stack = $("preview-stack");
  if (!stack) return;
  for (const video of stack.querySelectorAll("video")) {
    if (!video.paused) video.pause();
  }
  stack.hidden = true;
}

function layerNode(clip) {
  let node = previewLayers.get(clip.id);
  if (!node) {
    node = document.createElement("div");
    node.className = "preview-layer";
    node.dataset.clipId = clip.id;
    previewLayers.set(clip.id, node);
  }
  return node;
}

function clipSpeed(clip) {
  const speed = Number(clip.speed);
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
}

function sourceOrigin(clip) {
  const origin = Number(clip.sourceStart);
  return Number.isFinite(origin) ? origin : 0;
}

function localSourceTime(clip) {
  return Math.max(0, sourceOrigin(clip) + (state.currentTime - clip.startTime) * clipSpeed(clip));
}

function fillPreviewLayer(node, clip, hostMonitor) {
  if (clip.type === "動画") {
    node.querySelector("img")?.remove();
    node.querySelector(".preview-telop")?.remove();
    if (hostMonitor) {
      node.querySelector("video.preview-extra")?.remove();
      const monitor = previewMonitor();
      const chroma = $("preview-chroma");
      if (monitor && monitor.parentElement !== node) node.append(monitor);
      if (chroma && chroma.parentElement !== node) node.append(chroma);
      monitor?.classList.remove("is-media-hidden");
      if (monitor && clip.sourceUrl && monitor.dataset.source !== clip.sourceUrl) {
        monitor.dataset.source = clip.sourceUrl;
        monitor.src = clip.sourceUrl;
      }
      monitorHostId = clip.id;
      if (monitor) watchCropLayout(monitor, clip, node);
      return;
    }
    if (monitorHostId === clip.id) parkMonitor();
    let video = node.querySelector("video.preview-extra");
    if (!video) {
      video = document.createElement("video");
      video.className = "preview-extra";
      video.playsInline = true;
      video.preload = "auto";
      node.append(video);
    }
    if (clip.sourceUrl && video.dataset.source !== clip.sourceUrl) {
      video.dataset.source = clip.sourceUrl;
      video.src = clip.sourceUrl;
    }
    watchCropLayout(video, clip, node);
    return;
  }
  if (monitorHostId === clip.id) parkMonitor();
  node.querySelector("video.preview-extra")?.remove();
  if (isStillClip(clip)) {
    node.querySelector(".preview-telop")?.remove();
    let image = node.querySelector("img");
    if (!image) {
      image = document.createElement("img");
      image.alt = "";
      node.append(image);
    }
    if (image.dataset.source !== (clip.sourceUrl || "")) {
      image.dataset.source = clip.sourceUrl || "";
      image.src = clip.sourceUrl || "";
    }
    watchCropLayout(image, clip, node);
    return;
  }
  node.querySelector("img")?.remove();
  let telop = node.querySelector(".preview-telop");
  if (!telop) {
    telop = document.createElement("div");
    telop.className = "preview-telop";
    node.append(telop);
    bindTelopInlineEdit(telop);
  }
  paintTelopCaption(telop, clip.text || clip.name || "テロップ", clip.style || DEFAULT_STYLE);
}

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 100;
  return Math.min(200, Math.max(0, number));
}

function clipGain(clip) {
  let gain = clampVolume(clip?.volume) / 100;
  const local = state.currentTime - clip.startTime;
  if (local >= 0 && local <= clip.duration) {
    if (clip.fadeIn > 0 && local < clip.fadeIn) gain *= local / clip.fadeIn;
    const remain = clip.duration - local;
    if (clip.fadeOut > 0 && remain < clip.fadeOut) gain *= Math.max(0, remain) / clip.fadeOut;
  }
  return Math.max(0, gain * masterPreviewGain());
}

function ensureElementGain(element) {
  if (!element || element === previewMonitor()) return null;
  if (element._editaiGain) return element._editaiGain;
  if (element._editaiGainFailed) return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    element._editaiGainFailed = true;
    return null;
  }
  try {
    if (!waveContext) waveContext = new Ctx();
    const source = waveContext.createMediaElementSource(element);
    const gain = waveContext.createGain();
    source.connect(gain);
    gain.connect(waveContext.destination);
    element._editaiGain = gain;
    return gain;
  } catch {
    element._editaiGainFailed = true;
    return null;
  }
}

function applyElementGain(element, level) {
  if (!element) return;
  const gain = Math.max(0, Number(level) || 0);
  if (element === previewMonitor() && !previewPitch?.gain) ensurePreviewPitch();
  const node = element === previewMonitor() ? previewPitch?.gain : ensureElementGain(element);
  if (node) {
    element.volume = gain > 0 ? 1 : 0;
    node.gain.value = gain;
    if (node.context?.state === "suspended") node.context.resume().catch(() => {});
    return;
  }
  element.volume = Math.min(1, gain);
}

function syncLayerPlayback() {
  if (state.previewTarget !== "timeline") return;
  const playing = state.playing;
  const monitor = previewMonitor();
  let monitorClip = null;
  for (const [id, node] of previewLayers) {
    if (node.hidden || !node.isConnected) continue;
    const located = findClip(id);
    if (!located || located.clip.type !== "動画") continue;
    const video = id === monitorHostId ? monitor : node.querySelector("video.preview-extra");
    if (!video) continue;
    const clip = located.clip;
    if (id === monitorHostId) monitorClip = clip;
    const rate = Math.min(4, Math.max(0.1, clip.speed > 0 ? clip.speed : 1));
    video.playbackRate = rate;
    video.preservesPitch = true;
    const silenced = previewMuted || located.track.muted;
    video.muted = silenced;
    applyElementGain(video, silenced ? 0 : clipGain(clip));
    const local = localSourceTime(clip);
    if (playing) {
      if (video.paused) video.play().catch(() => {});
      if (Number.isFinite(video.currentTime) && Math.abs(video.currentTime - local) > 0.35) {
        try { video.currentTime = local; } catch { /* メタデータ前は次のフレームで合わせる */ }
      }
    } else {
      if (!video.paused) video.pause();
      if (Number.isFinite(video.duration) && Math.abs((video.currentTime || 0) - local) > 0.04) {
        try { video.currentTime = local; } catch { /* 長さが分かるまで待つ */ }
      }
    }
  }
  if (monitorClip) applyPreviewPitch(Number(monitorClip.pitch) || 0);
  else applyPreviewPitch(0);
  startChromaLoop();
}

/** 再生ヘッドの時刻に重なる映像を、トラックの前後関係のまま重ねる。選択は枠だけを足す。 */
function syncTimelineFrame() {
  if (state.previewTarget !== "timeline") return;
  const canvas = $("preview-canvas");
  const stack = ensurePreviewStack();
  if (!canvas || !stack) return;
  stack.hidden = false;
  const clips = visualClipsAt(state.currentTime);
  const frontVideo = [...clips].reverse().find((clip) => clip.type === "動画" && clip.sourceUrl) || null;
  const keep = new Set(clips.map((clip) => clip.id));
  for (const [id, node] of previewLayers) {
    if (keep.has(id)) continue;
    if (id === monitorHostId) parkMonitor();
    const extra = node.querySelector("video.preview-extra");
    if (extra && !extra.paused) extra.pause();
    cropPaintNodes.delete(node);
    node.remove();
    previewLayers.delete(id);
  }
  if (!frontVideo) {
    parkMonitor();
    const monitor = previewMonitor();
    if (monitor) {
      if (!monitor.paused) monitor.pause();
      monitor.classList.add("is-media-hidden");
    }
  }
  const selected = selectedDirectClip();
  clips.forEach((clip, index) => {
    const node = layerNode(clip);
    node.hidden = false;
    node.style.zIndex = String(index + 1);
    ensureClipLayout(clip);
    placeLayer(node, clip);
    fillPreviewLayer(node, clip, Boolean(frontVideo && frontVideo.id === clip.id));
    if (node.parentElement !== stack) stack.append(node);
  });
  canvas.classList.add("is-timeline");
  if (selected && keep.has(selected.id)) {
    const node = previewLayers.get(selected.id);
    if (node) mountPreviewBox(node);
  } else {
    hidePreviewBox();
  }
  syncLayerPlayback();
}

function applyPreviewSelection() {
  if (state.previewTarget === "media") {
    hidePreviewBox();
    hideTimelineStack();
    const item = selectedMedia();
    if (item) showMediaPreview(item, true);
    return;
  }
  hidePreviewGuides();
  const object = $("preview-object");
  const image = $("preview-image");
  const telop = $("preview-telop");
  if (object) object.hidden = true;
  if (image) image.hidden = true;
  if (telop) telop.hidden = true;
  syncTimelineFrame();
}

function fieldText(value, step) {
  const n = Number(value) || 0;
  if (step && step < 1) return String(Math.round(n * 10) / 10);
  return String(Math.round(n * 10) / 10);
}

function writePropertyFields(clip) {
  if (!clip) return;
  ensureClipLayout(clip);
  const fields = [
    ["scale", clip.scale, 1],
    ["width", clip.width, 1],
    ["height", clip.height, 1],
    ["x", clip.x, 1],
    ["y", clip.y, 1],
    ["rotation", clip.rotation, 1],
    ["speed", clip.speed, 0.1],
    ["volume", clip.volume, 1],
    ["fadeIn", clip.fadeIn, 0.1],
    ["fadeOut", clip.fadeOut, 0.1],
    ["pitch", clip.pitch, 1],
  ];
  for (const [key, value, step] of fields) {
    const text = fieldText(value, step);
    for (const input of document.querySelectorAll(`#property-editor [data-prop="${key}"]`)) {
      if (input === document.activeElement) continue;
      input.value = text;
    }
  }
  const flipH = $("prop-flip-h");
  const flipV = $("prop-flip-v");
  if (flipH) {
    flipH.setAttribute("aria-pressed", clip.flipH ? "true" : "false");
    flipH.classList.toggle("is-on", clip.flipH);
  }
  if (flipV) {
    flipV.setAttribute("aria-pressed", clip.flipV ? "true" : "false");
    flipV.classList.toggle("is-on", clip.flipV);
  }
  const chroma = $("prop-chroma");
  const color = $("prop-chroma-color");
  if (chroma && chroma !== document.activeElement) chroma.checked = Boolean(clip.chromaEnabled);
  if (color && color !== document.activeElement) color.value = clip.chromaColor || "#00ff00";
  const videoFields = $("property-video");
  if (videoFields) videoFields.hidden = clip.type !== "動画";
  const textField = $("property-text");
  const textArea = $("prop-text");
  if (textField) textField.hidden = clip.type !== "テロップ";
  if (textArea && clip.type === "テロップ" && document.activeElement !== textArea) {
    textArea.value = clip.text || "";
  }
}

let propertyClipId = null;

function syncPropertyPanel() {
  const panel = $("property-editor");
  if (!panel) return;
  const clip = selectedEditableClip();
  const nextId = clip?.id || null;
  const clipChanged = nextId !== propertyClipId;
  propertyClipId = nextId;
  panel.hidden = !clip;
  fitPreviewCanvas();
  if (!clip) {
    if (document.activeElement?.dataset?.prop || document.activeElement?.id === "prop-text") document.activeElement.blur();
    applyPreviewSelection();
    return;
  }
  if (clipChanged && (document.activeElement?.dataset?.prop || document.activeElement?.id === "prop-text")) document.activeElement.blur();
  writePropertyFields(clip);
  applyPreviewSelection();
}

function refreshClipAppearance(clip) {
  writePropertyFields(clip);
  applyPreviewSelection();
}

function applyClipSpeed(clip, value) {
  const next = Math.min(4, Math.max(0.1, value));
  const prev = Number(clip.speed);
  const oldSpeed = Number.isFinite(prev) && prev > 0 ? prev : 1;
  if (Math.abs(next - oldSpeed) < 0.0001) {
    clip.speed = next;
    return false;
  }
  const oldDuration = Number(clip.duration) || 0;
  const nextDuration = oldDuration * (oldSpeed / next);
  clip.speed = next;
  if (Number.isFinite(nextDuration) && nextDuration > 0) clip.duration = nextDuration;
  return true;
}

function onPropertyInput(event) {
  const clip = selectedEditableClip();
  const key = event.target.dataset.prop;
  if (!clip || !key) return;
  const raw = event.target.value.trim();
  if (raw === "" || raw === "-" || raw === "." || raw === "-.") return;
  const value = Number(raw);
  if (!Number.isFinite(value)) return;
  ensureClipLayout(clip);
  let durationChanged = false;
  if (key === "scale" || key === "width" || key === "height") {
    if (!(clip.baseWidth > 0) || !(clip.baseHeight > 0)) return;
    if (key === "width") setClipScale(clip, value / clip.baseWidth * 100);
    else if (key === "height") setClipScale(clip, value / clip.baseHeight * 100);
    else setClipScale(clip, value);
  } else if (key === "speed") {
    durationChanged = applyClipSpeed(clip, value);
  } else if (key === "volume") {
    clip.volume = clampVolume(value);
  } else if (key === "fadeIn" || key === "fadeOut") {
    clip[key] = Math.max(0, value);
  } else if (key === "pitch") {
    clip.pitch = Math.min(12, Math.max(-12, value));
  } else {
    clip[key] = value;
  }
  refreshClipAppearance(clip);
  if (durationChanged) renderSequence();
  rememberProject(true);
}

function toggleClipFlip(key) {
  const clip = selectedEditableClip();
  if (!clip) return;
  ensureClipLayout(clip);
  clip[key] = !clip[key];
  refreshClipAppearance(clip);
  rememberProject(false);
}

function snapOffset(value, targets, limit) {
  let best = value;
  let guide = null;
  let dist = limit;
  for (const target of targets) {
    const gap = Math.abs(value - target.at);
    if (gap <= dist) {
      dist = gap;
      best = target.at;
      guide = target.guide;
    }
  }
  return { value: best, guide };
}

function snapClipPosition(clip, x, y, canvas = $("preview-canvas")) {
  const { sx } = canvasUnits(canvas);
  const limit = 10 / (sx || 1);
  const { width, height } = projectSize();
  const halfW = clip.width / 2;
  const halfH = clip.height / 2;
  const xSnap = snapOffset(x, [
    { at: 0, guide: "center" },
    { at: -width / 2 + halfW, guide: "left" },
    { at: width / 2 - halfW, guide: "right" },
  ], limit);
  const ySnap = snapOffset(y, [
    { at: 0, guide: "center" },
    { at: -height / 2 + halfH, guide: "top" },
    { at: height / 2 - halfH, guide: "bottom" },
  ], limit);
  return { x: xSnap.value, y: ySnap.value, xGuide: xSnap.guide, yGuide: ySnap.guide };
}

function clipCenterScreen(clip, canvas = $("preview-canvas")) {
  const rect = canvas.getBoundingClientRect();
  const { sx, sy } = canvasUnits(canvas);
  return {
    x: rect.left + rect.width / 2 + clip.x * sx,
    y: rect.top + rect.height / 2 + clip.y * sy,
  };
}

function onPreviewLayerPointerDown(event) {
  if (event.button !== 0) return;
  if (state.previewTarget !== "timeline") return;
  const clip = selectedDirectClip();
  if (!clip) return;
  const onVideo = event.currentTarget.id === "preview-transform";
  if (onVideo && clip.type !== "動画") return;
  if (!onVideo && clip.type === "動画") return;
  event.preventDefault();
  event.stopPropagation();
  const handle = event.target.closest("[data-handle]")?.dataset.handle;
  if (handle === "rotate") startPreviewRotate(clip, event);
  else if (handle) startPreviewScale(clip, event);
  else startPreviewMove(clip, event);
}

function bindPreviewGestures() {
  const canvas = $("preview-canvas");
  const object = $("preview-object");
  const frame = $("preview-transform");
  if (!canvas || !object || !frame || canvas.dataset.gestures) return;
  canvas.dataset.gestures = "1";
  canvas.addEventListener("dblclick", (event) => {
    const located = telopClipFromPreviewEvent(event);
    if (!located || state.previewTarget !== "timeline") return;
    event.preventDefault();
    event.stopPropagation();
    openTelopInlineEdit(located.clip.id);
  });
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest(".preview-telop.is-editing")) return;
    const telopHit = telopClipFromPreviewEvent(event);
    if (telopHit && event.detail >= 2 && state.previewTarget === "timeline") {
      event.stopPropagation();
      openTelopInlineEdit(telopHit.clip.id);
      return;
    }
    const handle = event.target.closest("[data-handle]")?.dataset.handle;
    if (handle && state.previewTarget === "timeline") {
      const direct = selectedDirectClip();
      if (!direct) return;
      event.preventDefault();
      event.stopPropagation();
      if (handle === "rotate") startPreviewRotate(direct, event);
      else startPreviewScale(direct, event);
      return;
    }
    if (event.target.closest(".preview-handle")) return;
    const layer = event.target.closest(".preview-layer");
    if (layer && state.previewTarget === "timeline") {
      const located = findClip(layer.dataset.clipId);
      if (!located) return;
      event.stopPropagation();
      if (located.clip.type === "テロップ") {
        if (activeClipId() !== located.clip.id) selectClip(located.clip.id);
        armTelopPreviewPress(located.clip, event);
        return;
      }
      event.preventDefault();
      if (activeClipId() !== located.clip.id) selectClip(located.clip.id);
      startPreviewMove(located.clip, event);
      return;
    }
    const clip = selectedDirectClip();
    if (clip && clip.type !== "動画" && event.target.closest("#preview-object")) return;
    if (clip && clip.type === "動画" && event.target.closest("#preview-transform")) return;
    selectClip(null);
  });
  object.addEventListener("pointerdown", onPreviewLayerPointerDown);
  frame.addEventListener("pointerdown", onPreviewLayerPointerDown);
}

function telopClipFromPreviewEvent(event) {
  if (event.target?.closest?.(".preview-handle, [data-handle]")) return null;
  const direct = event.target?.closest?.(".preview-telop");
  const layer = direct?.closest(".preview-layer") || event.target?.closest?.(".preview-layer");
  const located = layer ? findClip(layer.dataset.clipId) : null;
  if (located?.clip.type === "テロップ" && layer.querySelector(".preview-telop")) return located;
  const box = $("preview-box");
  const previous = box ? box.style.pointerEvents : "";
  if (box) box.style.pointerEvents = "none";
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  if (box) box.style.pointerEvents = previous;
  const hitLayer = hit?.closest?.(".preview-layer");
  const hitClip = hitLayer ? findClip(hitLayer.dataset.clipId) : null;
  if (hitClip?.clip.type === "テロップ" && hitLayer.querySelector(".preview-telop")) return hitClip;
  return null;
}

function armTelopPreviewPress(clip, event) {
  const originX = event.clientX;
  const originY = event.clientY;
  const startX = clip.x;
  const startY = clip.y;
  const pointerId = event.pointerId;
  const el = event.currentTarget;
  const { sx, sy } = canvasUnits();
  let dragging = false;
  const onMove = (moveEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    if (document.querySelector(".preview-telop.is-editing")) return;
    const moved = Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY);
    if (!dragging && moved <= 5) return;
    if (!dragging) {
      dragging = true;
      try {
        el.setPointerCapture(pointerId);
      } catch {
        // ポインタを掴めなくても、移動の計算は続ける
      }
      holdPreview();
    }
    moveEvent.preventDefault();
    const rawX = startX + (moveEvent.clientX - originX) / sx;
    const rawY = startY + (moveEvent.clientY - originY) / sy;
    const snapped = snapClipPosition(clip, rawX, rawY);
    clip.x = snapped.x;
    clip.y = snapped.y;
    refreshClipAppearance(clip);
    showPreviewGuides(snapped);
  };
  const stop = () => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", stop);
    el.removeEventListener("pointercancel", stop);
    hidePreviewGuides();
    if (dragging) rememberProject(false);
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
}

function startPreviewMove(clip, event) {
  ensureClipLayout(clip);
  const { sx, sy } = canvasUnits();
  const startX = clip.x;
  const startY = clip.y;
  const originX = event.clientX;
  const originY = event.clientY;
  trackPointer(event.currentTarget, event, (moveEvent) => {
    const rawX = startX + (moveEvent.clientX - originX) / sx;
    const rawY = startY + (moveEvent.clientY - originY) / sy;
    const snapped = snapClipPosition(clip, rawX, rawY);
    clip.x = snapped.x;
    clip.y = snapped.y;
    refreshClipAppearance(clip);
    showPreviewGuides(snapped);
  }, () => {
    hidePreviewGuides();
    rememberProject(false);
  });
}

function telopStyleOf(clip) {
  if (!clip.style || clip.style === DEFAULT_STYLE) clip.style = cloneTelopStyle(clip.style || DEFAULT_STYLE);
  return clip.style;
}

function startPreviewScale(clip, event) {
  ensureClipLayout(clip);
  const center = clipCenterScreen(clip);
  const startDist = Math.max(8, Math.hypot(event.clientX - center.x, event.clientY - center.y));
  const startScale = clip.scale;
  const startFont = clip.type === "テロップ" ? (Number(telopStyleOf(clip).font_size) || 64) : 0;
  trackPointer(event.currentTarget, event, (moveEvent) => {
    const dist = Math.hypot(moveEvent.clientX - center.x, moveEvent.clientY - center.y);
    setClipScale(clip, startScale * dist / startDist);
    if (clip.type === "テロップ" && startScale > 0) {
      const ratio = clip.scale / startScale;
      telopStyleOf(clip).font_size = Math.min(300, Math.max(8, Math.round(startFont * ratio)));
    }
    refreshClipAppearance(clip);
  }, () => {
    rememberProject(false);
  });
}

function bindTelopInlineEdit(telop) {
  if (telop.dataset.editBound) return;
  telop.dataset.editBound = "1";
  telop.addEventListener("pointerdown", (event) => {
    if (!telop.classList.contains("is-editing")) return;
    event.stopPropagation();
  });
  telop.addEventListener("input", () => syncTelopFromPreview(telop));
  telop.addEventListener("keydown", (event) => {
    if (!telop.classList.contains("is-editing")) return;
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) {
      insertTelopNewline();
      syncTelopFromPreview(telop);
      return;
    }
    telop.blur();
  });
  telop.addEventListener("blur", () => finishTelopInlineEdit(telop));
}

function insertTelopNewline() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode("\n");
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function openTelopInlineEdit(clipId) {
  const located = findClip(clipId);
  if (!located || located.clip.type !== "テロップ") return;
  if (activeClipId() !== clipId) selectClip(clipId);
  const telop = previewLayers.get(clipId)?.querySelector(".preview-telop");
  if (!telop) return;
  bindTelopInlineEdit(telop);
  telop.classList.add("is-editing");
  telop.contentEditable = "true";
  telop.focus();
  const range = document.createRange();
  range.selectNodeContents(telop);
  range.collapse(false);
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function telopPreviewText(telop) {
  return (telop.innerText || "").replace(/\u00a0/g, " ").replace(/\n$/, "");
}

function syncTelopFromPreview(telop) {
  if (!telop.classList.contains("is-editing")) return;
  const located = findClip(telop.closest(".preview-layer")?.dataset.clipId);
  if (!located || located.clip.type !== "テロップ") return;
  const text = telopPreviewText(telop);
  located.clip.text = text;
  located.clip.name = telopClipName(text);
  const area = $("prop-text");
  if (area && document.activeElement !== area) area.value = text;
  const label = document.querySelector(`#seq-lanes .seq-clip[data-id="${located.clip.id}"] .tl-label`);
  if (label) label.textContent = located.clip.name;
  rememberProject(true);
}

function onTelopPropertyText() {
  const area = $("prop-text");
  const clip = selectedEditableClip();
  if (!area || !clip || clip.type !== "テロップ") return;
  clip.text = area.value;
  clip.name = telopClipName(area.value);
  const telop = previewLayers.get(clip.id)?.querySelector(".preview-telop");
  if (telop?.classList.contains("is-editing")) {
    if (document.activeElement !== telop) telop.textContent = clip.text;
  } else if (telop) {
    paintTelopCaption(telop, clip.text || clip.name || "テロップ", clip.style || DEFAULT_STYLE);
  }
  const label = document.querySelector(`#seq-lanes .seq-clip[data-id="${clip.id}"] .tl-label`);
  if (label) label.textContent = clip.name;
  rememberProject(true);
}

function finishTelopInlineEdit(telop) {
  if (!telop.classList.contains("is-editing")) return;
  const located = findClip(telop.closest(".preview-layer")?.dataset.clipId);
  telop.classList.remove("is-editing");
  telop.contentEditable = "false";
  if (!located || located.clip.type !== "テロップ") return;
  const text = telopPreviewText(telop).replace(/\n+$/g, "");
  located.clip.text = text;
  located.clip.name = telopClipName(text);
  paintTelopCaption(telop, located.clip.text || located.clip.name || "テロップ", located.clip.style || DEFAULT_STYLE);
  renderSequence();
  rememberProject(false);
}

function startPreviewRotate(clip, event) {
  ensureClipLayout(clip);
  const center = clipCenterScreen(clip);
  const startAngle = Math.atan2(event.clientY - center.y, event.clientX - center.x);
  const startRotation = Number(clip.rotation) || 0;
  trackPointer(event.currentTarget, event, (moveEvent) => {
    const angle = Math.atan2(moveEvent.clientY - center.y, moveEvent.clientX - center.x);
    clip.rotation = startRotation + (angle - startAngle) * 180 / Math.PI;
    refreshClipAppearance(clip);
  }, () => {
    rememberProject(false);
  });
}
function fitPreviewCanvas() {
  const canvas = $("preview-canvas");
  const stage = canvas?.parentElement;
  if (!canvas || !stage) return;
  const width = state.project.width || 1920;
  const height = state.project.height || 1080;
  canvas.style.aspectRatio = `${width} / ${height}`;
  const ratio = width / height;
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  if (stageW <= 0 || stageH <= 0) return;
  if (stageW / stageH > ratio) {
    canvas.style.height = "100%";
    canvas.style.width = "auto";
  } else {
    canvas.style.width = "100%";
    canvas.style.height = "auto";
  }
  if (state.previewTarget === "timeline") syncTimelineFrame();
}

let lastTimelineClick = null;

function consumeDoubleClick(id, detail, onDouble) {
  const now = performance.now();
  const recent = lastTimelineClick && lastTimelineClick.id === id && now - lastTimelineClick.at < 450;
  if ((detail || 0) >= 2 || recent) {
    lastTimelineClick = null;
    onDouble();
    return true;
  }
  lastTimelineClick = { id, at: now };
  return false;
}

function timelineDragStarted(pressedAt, moved) {
  const held = performance.now() - pressedAt;
  return moved > 5 && (held > 280 || moved > 16);
}

let clipClipboard = null;

function selectedCompareClip() {
  const plan = cutComparePlan;
  if (!plan?.selectedId) return null;
  const kind = plan.active || "split";
  const lane = laneForClip(kind, plan.selectedId);
  const clip = lane?.[kind]?.find((item) => item.id === plan.selectedId);
  if (!clip || !lane) return null;
  return { kind, lane, clip };
}

function selectedTelopEntry() {
  const plan = telopPlan;
  if (!plan?.selectedId) return null;
  for (const lane of plan.lanes || []) {
    const item = (lane.items || []).find((entry) => entry.id === plan.selectedId);
    if (!item) continue;
    const span = telopItemSpan(item);
    if (!span) return null;
    return { lane, item, duration: Math.max(0.05, span.end - span.start) };
  }
  return null;
}

function copyTimelineClips(quiet) {
  if ($("cut-compare-dialog")?.open) {
    const selected = selectedCompareClip();
    if (!selected) {
      if (!quiet) showToast("コピーするクリップを選んでください。");
      return false;
    }
    clipClipboard = {
      scope: "compare",
      trackId: selected.lane.trackId,
      clip: structuredClone(selected.clip),
    };
    if (!quiet) showToast("クリップをコピーしました。");
    return true;
  }
  if ($("telop-gen-dialog")?.open) {
    const selected = selectedTelopEntry();
    if (!selected) {
      if (!quiet) showToast("コピーするクリップを選んでください。");
      return false;
    }
    clipClipboard = {
      scope: "telop",
      laneId: selected.lane.trackId,
      item: structuredClone(selected.item),
      duration: selected.duration,
    };
    if (!quiet) showToast("クリップをコピーしました。");
    return true;
  }
  if (document.querySelector("dialog[open]") || $("editor").hidden) return false;
  const located = state.selectedClipIds.map((id) => findClip(id)).filter(Boolean);
  if (!located.length) {
    if (!quiet) showToast("コピーするクリップを選んでください。");
    return false;
  }
  const origin = Math.min(...located.map((item) => item.clip.startTime));
  clipClipboard = {
    scope: "main",
    clips: located.map((item) => ({
      trackId: item.track.id,
      offset: item.clip.startTime - origin,
      clip: structuredClone(item.clip),
    })),
  };
  if (!quiet) showToast("クリップをコピーしました。");
  return true;
}

function pasteTimelineClips(quiet) {
  const board = clipClipboard;
  if (!board) {
    if (!quiet) showToast("コピーしたクリップがありません。");
    return false;
  }
  if (board.scope === "compare") {
    const plan = cutComparePlan;
    if (!$("cut-compare-dialog")?.open || !plan) return false;
    const kind = plan.active || "split";
    const lane = (plan.lanes || []).find((item) => item.trackId === board.trackId)
      || laneForClip(kind, plan.selectedId)
      || plan.lanes?.[0];
    if (!lane) return false;
    const time = plan.origin + (plan.time[kind] || 0);
    const clip = structuredClone(board.clip);
    clip.id = nextClipId();
    clip.startTime = Math.max(plan.origin, time);
    lane[kind].push(clip);
    const holder = { clips: lane[kind] };
    overwriteTrack(holder, clip.id);
    lane[kind] = holder.clips;
    plan.selectedId = clip.id;
    plan.active = kind;
    renderCutLane(kind);
    seekCompare(kind, clip.startTime - plan.origin);
    if (!quiet) showToast("クリップを貼り付けました。");
    return true;
  }
  if (board.scope === "telop") {
    const plan = telopPlan;
    if (!$("telop-gen-dialog")?.open || !plan?.lanes?.length) return false;
    const lane = plan.lanes.find((item) => item.trackId === board.laneId)
      || plan.lanes.find((item) => (item.items || []).some((entry) => entry.id === plan.selectedId))
      || plan.lanes[0];
    const time = (plan.origin || 0) + (plan.time || 0);
    const item = cloneTelopItem(structuredClone(board.item), nextClipId());
    const duration = Math.max(0.05, board.duration || 1);
    setTelopTimeline(item, time, time + duration);
    item.laneTrackId = lane.trackId;
    lane.items.push(item);
    overwriteTelopLane(lane, item.id);
    syncTelopItemsFromLanes();
    plan.selectedId = item.id;
    renderTelopList();
    renderTelopLane();
    seekTelop(time - (plan.origin || 0));
    if (!quiet) showToast("クリップを貼り付けました。");
    return true;
  }
  if (document.querySelector("dialog[open]") || $("editor").hidden) return false;
  const pasted = [];
  let locked = false;
  for (const entry of board.clips || []) {
    const track = trackById(entry.trackId);
    if (!track || track.locked) {
      locked = true;
      continue;
    }
    const clip = structuredClone(entry.clip);
    clip.id = nextClipId();
    clip.startTime = Math.max(0, state.currentTime + entry.offset);
    clip.volume = clampVolume(clip.volume);
    track.clips.push(clip);
    pasted.push({ track, clip });
  }
  if (!pasted.length) {
    if (!quiet) showToast(locked ? "ロック中のトラックには貼り付けできません。" : "貼り付けできませんでした。");
    return false;
  }
  const keep = new Set(pasted.map((item) => item.clip.id));
  for (const item of pasted) overwriteTrack(item.track, item.clip.id, keep);
  state.selectedClipIds = pasted.map((item) => item.clip.id);
  renderSequence();
  setCurrentTime(state.currentTime);
  rememberProject(false);
  if (!quiet) showToast("クリップを貼り付けました。");
  return true;
}

function duplicateTimelineClips() {
  const previous = clipClipboard;
  if (!copyTimelineClips(true)) {
    showToast("複製するクリップを選んでください。");
    return;
  }
  const pasted = pasteTimelineClips(true);
  clipClipboard = previous;
  if (pasted) showToast("クリップを複製しました。");
}

function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function playheadCrosses(clip, time) {
  return time > clip.startTime + CLIP_EPS && time < clip.startTime + clip.duration - CLIP_EPS;
}

/** 再生ヘッド上に選択中クリップがあればそれだけを切る。無ければ、その時刻の全トラックを切る。クリップが無ければ何もしない。 */
function splitPlayheadContext() {
  const time = state.currentTime;
  const crossed = [];
  for (const track of state.project.tracks) {
    for (const clip of track.clips) {
      if (!playheadCrosses(clip, time)) continue;
      crossed.push({ track, clip });
    }
  }
  if (!crossed.length) return false;
  const selectedOnLine = crossed.filter((item) => state.selectedClipIds.includes(item.clip.id));
  const targets = selectedOnLine.length ? selectedOnLine : crossed;
  const open = targets.filter((item) => !item.track.locked);
  if (!open.length) {
    showToast("ロック中のトラックは分割できません。");
    return false;
  }
  const rights = [];
  for (const { track, clip } of open) {
    const right = sliceClip(clip, time, clip.startTime + clip.duration - time);
    clip.duration = time - clip.startTime;
    track.clips.push(right);
    rights.push(right.id);
    track.clips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  }
  state.selectedClipIds = rights;
  state.previewTarget = "timeline";
  renderSequence();
  rememberProject(false);
  return true;
}

function splitAtPlayheadClick() {
  splitPlayheadContext();
}

function splitSelectedAtPlayhead() {
  splitPlayheadContext();
}

const PLAYHEAD_DRAG_PX = 5;
let scissorsOffsetY = 0;

function beginPlayheadGesture(event, surface) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const originX = event.clientX;
  const originY = event.clientY;
  const measure = surface === "ruler" ? $("seq-ruler") : $("seq-lanes");
  const splitOnRelease = surface === "lane"
    && event.target instanceof Element
    && !!event.target.closest(".seq-playhead-scissors");
  let dragged = false;
  const resume = playbackActive();
  if (resume) setPlaying(false);
  trackPointer(event.currentTarget, event, (moveEvent) => {
    if (Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) <= PLAYHEAD_DRAG_PX) return;
    dragged = true;
    setScissorsSeeking(true);
    if (splitOnRelease) placeScissors(moveEvent.clientY);
    scrubbingTimeline = true;
    setCurrentTime(xToTime(moveEvent.clientX, measure));
  }, (endEvent) => {
    setScissorsSeeking(false);
    scrubbingTimeline = false;
    const current = previewMonitor();
    if (current && !current.seeking) syncingMonitor = false;
    if (!dragged) {
      if (splitOnRelease) splitAtPlayheadClick();
      if (resume) setPlaying(true);
      return;
    }
    setCurrentTime(xToTime(endEvent.clientX, measure));
    if (resume) setPlaying(true);
  });
}

function deleteSelectedClip() {
  const located = state.selectedClipIds.map((id) => findClip(id)).filter(Boolean);
  if (!located.length) return;
  const locked = located.filter((item) => item.track.locked);
  const open = located.filter((item) => !item.track.locked);
  if (!open.length) {
    showToast("ロック中のトラックは削除できません。");
    return;
  }
  const drop = new Set(open.map((item) => item.clip.id));
  for (const track of state.project.tracks) {
    track.clips = track.clips.filter((clip) => !drop.has(clip.id));
  }
  state.selectedClipIds = locked.map((item) => item.clip.id);
  renderSequence();
  rememberProject(false);
  if (locked.length) showToast("ロック中のトラックは削除できません。");
}

function trackPointer(el, event, onMove, onUp) {
  try {
    el.setPointerCapture(event.pointerId);
  } catch {
    // ポインタを掴めても、掴めなくても、移動中の計算は同じ
  }
  const stop = (endEvent) => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", stop);
    el.removeEventListener("pointercancel", stop);
    onUp(endEvent);
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
}

function placeClip(el, clip) {
  el.style.left = `${clip.startTime * PX_PER_SEC}px`;
  el.style.width = `${Math.max(clip.duration * PX_PER_SEC, 4)}px`;
}

function snapLimit() {
  return SNAP_PX / PX_PER_SEC;
}

function collectSnapTimes(ignoreId, alsoIgnore) {
  const times = [state.currentTime];
  for (const track of state.project.tracks) {
    for (const item of track.clips) {
      if (item.id === ignoreId || alsoIgnore?.has(item.id)) continue;
      times.push(item.startTime, item.startTime + item.duration);
    }
  }
  return times;
}

function nearestSnap(time, targets) {
  const limit = snapLimit();
  let best = null;
  for (const target of targets) {
    const delta = target - time;
    if (Math.abs(delta) > limit) continue;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, time: target };
  }
  return best;
}

function snapMovedClip(startTime, duration, clipId, alsoIgnore) {
  const targets = collectSnapTimes(clipId, alsoIgnore);
  const left = nearestSnap(startTime, targets);
  const right = nearestSnap(startTime + duration, targets);
  const chosen = left && (!right || Math.abs(left.delta) <= Math.abs(right.delta)) ? left : right;
  if (!chosen) return { startTime, guide: null };
  const next = startTime + chosen.delta;
  if (next < 0) return { startTime, guide: null };
  return { startTime: next, guide: chosen.time };
}

function snapEdgeTime(time, clipId, minTime, maxTime) {
  const hit = nearestSnap(time, collectSnapTimes(clipId));
  if (!hit) return { time, guide: null };
  const next = time + hit.delta;
  if (next < minTime - CLIP_EPS || next > maxTime + CLIP_EPS) return { time, guide: null };
  return { time: next, guide: hit.time };
}

function showSnapGuide(time) {
  for (const id of ["seq-snap-guide", "seq-snap-guide-ruler"]) {
    const guide = $(id);
    if (!guide) continue;
    if (time == null) {
      guide.hidden = true;
      continue;
    }
    guide.hidden = false;
    guide.style.left = `${time * PX_PER_SEC}px`;
  }
}

function mountSnapGuide(parent, id) {
  const guide = document.createElement("div");
  guide.className = "seq-snap-guide";
  guide.id = id;
  guide.hidden = true;
  parent.append(guide);
}

function trackById(id) {
  return state.project.tracks.find((item) => item.id === id) || null;
}

function clipFitsTrack(clip, target) {
  if (!target || target.locked) return false;
  if (clip.type === "音声") return target.type === "audio";
  return target.type === "video";
}

function laneUnder(clientY, clientX) {
  const root = $("seq-lanes");
  if (!root) return null;
  const lanes = [...root.querySelectorAll(":scope > .seq-lane")];
  const inside = lanes.find((lane) => {
    const rect = lane.getBoundingClientRect();
    return rect.height > 0 && clientY >= rect.top && clientY <= rect.bottom;
  });
  if (inside) return inside;
  if (Number.isFinite(clientX)) {
    for (const node of document.elementsFromPoint(clientX, clientY)) {
      if (!(node instanceof Element)) continue;
      if (node.closest(".seq-clip.is-moving, .seq-playhead-line")) continue;
      const lane = node.classList.contains("seq-lane") ? node : node.closest(".seq-lane");
      if (lane && lanes.includes(lane)) return lane;
    }
  }
  let nearest = null;
  let best = Infinity;
  for (const lane of lanes) {
    const rect = lane.getBoundingClientRect();
    if (rect.height <= 0) continue;
    const dist = clientY < rect.top ? rect.top - clientY : clientY - rect.bottom;
    if (dist < best) {
      best = dist;
      nearest = lane;
    }
  }
  return best <= 26 ? nearest : null;
}

function scrollTimelineForPointer(clientX, clientY) {
  const view = $("seq-lanes-view");
  if (!view) return;
  const rect = view.getBoundingClientRect();
  const edge = 28;
  let dx = 0;
  let dy = 0;
  if (clientY < rect.top + edge) dy = -14;
  else if (clientY > rect.bottom - edge) dy = 14;
  if (clientX < rect.left + edge) dx = -18;
  else if (clientX > rect.right - edge) dx = 18;
  if (!dx && !dy) return;
  view.scrollLeft += dx;
  view.scrollTop += dy;
  const ruler = $("seq-ruler-view");
  const headers = $("seq-headers");
  if (ruler) ruler.scrollLeft = view.scrollLeft;
  if (headers) headers.scrollTop = view.scrollTop;
}

function sliceClip(clip, startTime, duration) {
  const next = createClip({
    type: clip.type,
    name: clip.name,
    startTime,
    duration,
    sourceUrl: clip.sourceUrl,
    sourcePath: clip.sourcePath,
    kept: clip.kept !== false,
  });
  next.kept = clip.kept;
  next.x = clip.x;
  next.y = clip.y;
  next.scale = clip.scale;
  next.rotation = clip.rotation;
  next.flipH = clip.flipH;
  next.flipV = clip.flipV;
  next.baseWidth = clip.baseWidth;
  next.baseHeight = clip.baseHeight;
  next.width = clip.width;
  next.height = clip.height;
  next.speed = clip.speed;
  next.chromaEnabled = clip.chromaEnabled;
  next.chromaColor = clip.chromaColor;
  next.volume = clip.volume;
  next.fadeIn = clip.fadeIn;
  next.fadeOut = clip.fadeOut;
  next.pitch = clip.pitch;
  next.cropX = clip.cropX;
  next.cropY = clip.cropY;
  next.cropWidth = clip.cropWidth;
  next.cropHeight = clip.cropHeight;
  next.cropAspect = clip.cropAspect;
  if (clip.text) next.text = clip.text;
  if (clip.style) next.style = cloneTelopStyle(clip.style);
  const elapsed = startTime - clip.startTime;
  next.sourceStart = sourceOrigin(clip) + elapsed * clipSpeed(clip);
  return next;
}

/** 操作したクリップを優先し、同じトラックの重なりを削る・割る・消す。 */
function overwriteTrack(track, activeId, keepIds) {
  const active = track.clips.find((item) => item.id === activeId);
  if (!active) return;
  const a0 = active.startTime;
  const a1 = a0 + active.duration;
  const next = [active];
  for (const clip of track.clips) {
    if (clip.id === activeId) continue;
    if (keepIds?.has(clip.id)) {
      next.push(clip);
      continue;
    }
    const b0 = clip.startTime;
    const b1 = b0 + clip.duration;
    if (b1 <= a0 + CLIP_EPS || b0 >= a1 - CLIP_EPS) {
      next.push(clip);
      continue;
    }
    if (b0 >= a0 - CLIP_EPS && b1 <= a1 + CLIP_EPS) continue;
    if (b0 < a0 - CLIP_EPS && b1 > a1 + CLIP_EPS) {
      const right = sliceClip(clip, a1, b1 - a1);
      clip.duration = a0 - b0;
      if (clip.duration > CLIP_EPS) next.push(clip);
      if (right.duration > CLIP_EPS) next.push(right);
      continue;
    }
    if (b0 < a0) {
      clip.duration = a0 - b0;
      if (clip.duration > CLIP_EPS) next.push(clip);
      continue;
    }
    const remain = b1 - a1;
    if (remain > CLIP_EPS) {
      clip.sourceStart = sourceOrigin(clip) + (a1 - clip.startTime) * clipSpeed(clip);
      clip.startTime = a1;
      clip.duration = remain;
      next.push(clip);
    }
  }
  track.clips = next.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
}

function holdPreview() {
  const monitor = previewMonitor();
  if (monitor && !monitor.paused && !monitor.ended) monitor.pause();
}

function finishClipEdit(sourceTrack, destTrack, clip, previewTime) {
  if (destTrack !== sourceTrack) {
    sourceTrack.clips = sourceTrack.clips.filter((item) => item.id !== clip.id);
    destTrack.clips.push(clip);
  }
  state.selectedClipIds = [clip.id];
  overwriteTrack(destTrack, clip.id);
  renderSequence();
  setCurrentTime(previewTime);
  rememberProject(false);
}

function finishClipMoves(members, previewTime) {
  const keep = new Set(members.map((member) => member.clip.id));
  const affected = new Set();
  for (const member of members) {
    const dest = member.dest || member.track;
    if (dest !== member.track) {
      member.track.clips = member.track.clips.filter((item) => item.id !== member.clip.id);
      dest.clips.push(member.clip);
    }
    affected.add(dest);
  }
  for (const dest of affected) {
    for (const member of members) {
      if ((member.dest || member.track) === dest) overwriteTrack(dest, member.clip.id, keep);
    }
  }
  state.selectedClipIds = members.map((member) => member.clip.id);
  renderSequence();
  setCurrentTime(previewTime);
  rememberProject(false);
}

function bindSeqClip(el, track, clip) {
  el.draggable = false;
  el.addEventListener("dragstart", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  el.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setCurrentTime(clip.startTime);
  });
  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (consumeDoubleClick(clip.id, event.detail, () => {
      selectClip(clip.id);
      setCurrentTime(clip.startTime);
    })) {
      event.preventDefault();
      return;
    }
    if (track.locked) {
      selectClip(clip.id, { additive: event.shiftKey });
      return;
    }
    const lane = el.parentElement;
    const edge = event.target.closest(".tl-edge");
    if (edge) {
      const side = edge.classList.contains("tl-edge-left") ? "left" : "right";
      const fixedEnd = clip.startTime + clip.duration;
      const fixedStart = clip.startTime;
      const originSource = sourceOrigin(clip);
      const speed = clipSpeed(clip);
      el.classList.add("is-trimming");
      holdPreview();
      trackPointer(el, event, (moveEvent) => {
        moveEvent.preventDefault();
        const pointerTime = xToTime(moveEvent.clientX, lane);
        if (side === "left") {
          const raw = Math.min(Math.max(0, pointerTime), fixedEnd - MIN_CLIP_SEC);
          const snapped = snapEdgeTime(raw, clip.id, 0, fixedEnd - MIN_CLIP_SEC);
          clip.startTime = snapped.time;
          clip.duration = fixedEnd - clip.startTime;
          showSnapGuide(snapped.guide);
        } else {
          const raw = Math.max(pointerTime, fixedStart + MIN_CLIP_SEC);
          const snapped = snapEdgeTime(raw, clip.id, fixedStart + MIN_CLIP_SEC, Number.POSITIVE_INFINITY);
          clip.duration = snapped.time - fixedStart;
          showSnapGuide(snapped.guide);
        }
        placeClip(el, clip);
      }, () => {
        el.classList.remove("is-trimming");
        showSnapGuide(null);
        if (side === "left") clip.sourceStart = Math.max(0, originSource + (clip.startTime - fixedStart) * speed);
        const time = side === "left" ? clip.startTime : clip.startTime + clip.duration;
        finishClipEdit(track, track, clip, time);
      });
      return;
    }

    const grab = xToTime(event.clientX, lane) - clip.startTime;
    const originX = event.clientX;
    const originY = event.clientY;
    const pressedAt = performance.now();
    const additive = event.shiftKey;
    const grouped = state.selectedClipIds.includes(clip.id) && state.selectedClipIds.length > 1;
    const members = [];
    const seedIds = grouped ? state.selectedClipIds : [clip.id];
    for (const id of seedIds) {
      const located = findClip(id);
      if (!located || located.track.locked) continue;
      members.push({
        track: located.track,
        clip: located.clip,
        el: document.querySelector(`#seq-lanes .seq-clip[data-id="${id}"]`),
        startTime: located.clip.startTime,
        dest: located.track,
      });
    }
    if (!members.some((member) => member.clip.id === clip.id)) {
      members.push({ track, clip, el, startTime: clip.startTime, dest: track });
    }
    const ignore = new Set(members.map((member) => member.clip.id));
    let mode = "press";
    let destTrack = track;
    let growArmed = !grouped;
    const dragHost = $("seq-lanes-view") || el;
    trackPointer(dragHost, event, (moveEvent) => {
      moveEvent.preventDefault();
      const moved = Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY);
      if (mode === "press" && timelineDragStarted(pressedAt, moved)) {
        lastTimelineClick = null;
        mode = "move";
        for (const member of members) member.el?.classList.add("is-moving");
        document.body.classList.add("is-clip-moving");
        holdPreview();
      }
      if (mode !== "move") return;
      scrollTimelineForPointer(moveEvent.clientX, moveEvent.clientY);
      const grown = growTrackForDrag(moveEvent.clientY, clip, growArmed);
      if (grown) growArmed = false;
      else if (laneUnder(moveEvent.clientY, moveEvent.clientX) && !trackGrowTarget(moveEvent.clientY, clip)) growArmed = true;
      const hoveredLane = laneUnder(moveEvent.clientY, moveEvent.clientX);
      const hovered = hoveredLane && trackById(hoveredLane.dataset.trackId);
      if (hovered && clipFitsTrack(clip, hovered)) destTrack = hovered;
      const measureLane = document.querySelector(`#seq-lanes > .seq-lane[data-track-id="${destTrack.id}"]`) || lane;
      const rawStart = Math.max(0, xToTime(moveEvent.clientX, measureLane) - grab);
      const snapped = snapMovedClip(rawStart, clip.duration, clip.id, ignore);
      const originStart = members.find((member) => member.clip.id === clip.id)?.startTime ?? clip.startTime;
      let delta = snapped.startTime - originStart;
      const earliest = Math.min(...members.map((member) => member.startTime));
      if (earliest + delta < 0) delta = -earliest;
      const order = tracksTopToBottom();
      const fromIndex = order.findIndex((item) => item.id === track.id);
      const toIndex = order.findIndex((item) => item.id === destTrack.id);
      const trackDelta = toIndex - fromIndex;
      for (const member of members) {
        let dest = member.track;
        if (member.clip.id === clip.id) dest = destTrack;
        else if (grouped && trackDelta) {
          const index = order.findIndex((item) => item.id === member.track.id);
          const next = order[index + trackDelta];
          if (next && clipFitsTrack(member.clip, next)) dest = next;
        }
        member.dest = dest;
        member.clip.startTime = member.startTime + delta;
        const home = document.querySelector(`#seq-lanes > .seq-lane[data-track-id="${dest.id}"]`);
        if (home && member.el && member.el.parentElement !== home) home.append(member.el);
        if (member.el) placeClip(member.el, member.clip);
      }
      showSnapGuide(snapped.guide);
    }, () => {
      for (const member of members) member.el?.classList.remove("is-moving");
      document.body.classList.remove("is-clip-moving");
      showSnapGuide(null);
      if (mode !== "move") {
        selectClip(clip.id, { additive });
        return;
      }
      if (members.length < 2) {
        const primary = members[0];
        finishClipEdit(primary.track, primary.dest || primary.track, primary.clip, primary.clip.startTime);
        return;
      }
      finishClipMoves(members, clip.startTime);
    });
  });
}

function headerIcon(label, pressed, path) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `seq-icon${pressed ? " is-on" : ""}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", pressed ? "true" : "false");
  button.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
  return button;
}

const ICON_EYE = "M12 5c5 0 9.3 3.1 11 7-1.7 3.9-6 7-11 7S2.7 15.9 1 12c1.7-3.9 6-7 11-7zm0 2.2A4.8 4.8 0 1 0 12 16.8 4.8 4.8 0 0 0 12 7.2zm0 2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6z";
const ICON_LOCK = "M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-6 7.7V19h2v-2.3a2 2 0 1 0-2 0zM10 9V7a2 2 0 1 1 4 0v2h-4z";
const ICON_SPEAKER = "M4 9v6h4l5 4V5L8 9H4zm11.5 3a3.5 3.5 0 0 0-1.8-3.1v6.2A3.5 3.5 0 0 0 15.5 12z";

function createTrackHeader(track) {
  const header = document.createElement("div");
  header.className = "seq-header";
  header.classList.toggle("is-hidden", !track.visible);
  const name = document.createElement("span");
  name.className = "seq-header-name";
  name.textContent = track.name;
  const toggle = (button, flag, apply) => {
    button.addEventListener("click", () => {
      apply(!flag());
      rememberProject(false);
      renderSequence();
    });
  };
  if (track.type === "video") {
    const eye = headerIcon(track.visible ? "表示中" : "非表示", track.visible, ICON_EYE);
    toggle(eye, () => track.visible, (value) => { track.visible = value; });
    header.append(eye);
  }
  const speaker = headerIcon(track.muted ? "ミュート中" : "音を出す", !track.muted, ICON_SPEAKER);
  toggle(speaker, () => track.muted, (value) => {
    track.muted = value;
    syncLayerPlayback();
    syncNarration();
  });
  header.append(speaker);
  const lock = headerIcon(track.locked ? "ロック中" : "編集できる", track.locked, ICON_LOCK);
  toggle(lock, () => track.locked, (value) => { track.locked = value; });
  header.append(name, lock);
  header.dataset.trackId = track.id;
  header.style.height = `${trackHeight(track)}px`;
  bindTrackHeaderDrag(header, track);
  return header;
}

function sameTrackKind(a, b) {
  return (a?.type === "audio") === (b?.type === "audio");
}

function tracksOfKind(track) {
  return tracksTopToBottom().filter((item) => sameTrackKind(item, track));
}

/** 映像は下から映像 1、音声は上から音声 1。並び替えたあとに、位置へ名前を合わせる。 */
function renumberTracks() {
  const videos = [];
  const audios = [];
  for (const track of state.project.tracks) {
    if (track.type === "audio") audios.push(track);
    else videos.push(track);
  }
  videos.forEach((track, index) => {
    track.name = `映像 ${videos.length - index}`;
  });
  audios.forEach((track, index) => {
    track.name = `音声 ${index + 1}`;
  });
}

function ensureTrackDropMarker() {
  const headers = $("seq-headers");
  if (!headers) return null;
  let marker = $("seq-track-drop");
  if (!marker) {
    marker = document.createElement("div");
    marker.id = "seq-track-drop";
    marker.className = "seq-track-drop";
    marker.hidden = true;
    headers.append(marker);
  } else if (marker.parentElement !== headers) {
    headers.append(marker);
  }
  return marker;
}

function trackInsertIndex(clientY, track) {
  const order = tracksOfKind(track);
  let index = order.length;
  for (let i = 0; i < order.length; i += 1) {
    const header = document.querySelector(`#seq-headers .seq-header[data-track-id="${order[i].id}"]`);
    if (!header) continue;
    const rect = header.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      index = i;
      break;
    }
  }
  return { order, index };
}

function placeTrackDropMarker(marker, track, insertIndex, order) {
  if (!marker) return;
  const anchor = order[Math.min(insertIndex, order.length - 1)];
  const header = anchor && document.querySelector(`#seq-headers .seq-header[data-track-id="${anchor.id}"]`);
  if (!header) {
    marker.hidden = true;
    return;
  }
  const top = insertIndex >= order.length ? header.offsetTop + header.offsetHeight : header.offsetTop;
  marker.hidden = false;
  marker.style.top = `${Math.max(0, top - 1)}px`;
}

function scrollHeadersForPointer(clientY) {
  const view = $("seq-lanes-view");
  const headers = $("seq-headers");
  if (!view || !headers) return;
  const rect = headers.getBoundingClientRect();
  const edge = 24;
  let dy = 0;
  if (clientY < rect.top + edge) dy = -12;
  else if (clientY > rect.bottom - edge) dy = 12;
  if (!dy) return;
  view.scrollTop += dy;
  headers.scrollTop = view.scrollTop;
}

function reorderTrack(track, insertIndex) {
  const order = tracksOfKind(track);
  const from = order.indexOf(track);
  if (from < 0) return;
  let dest = insertIndex;
  if (dest > from) dest -= 1;
  if (dest === from) return;
  const isAudio = track.type === "audio";
  const group = state.project.tracks.filter((item) => (item.type === "audio") === isAudio);
  const at = group.indexOf(track);
  if (at < 0) return;
  group.splice(at, 1);
  group.splice(dest, 0, track);
  const others = state.project.tracks.filter((item) => (item.type === "audio") !== isAudio);
  state.project.tracks = isAudio ? [...others, ...group] : [...group, ...others];
  renumberTracks();
  renderSequence();
  rememberProject(false);
}

function bindTrackHeaderDrag(header, track) {
  header.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    const originY = event.clientY;
    let dragging = false;
    let insertIndex = tracksOfKind(track).indexOf(track);
    const marker = ensureTrackDropMarker();
    trackPointer(header, event, (moveEvent) => {
      moveEvent.preventDefault();
      if (!dragging && Math.abs(moveEvent.clientY - originY) <= 4) return;
      dragging = true;
      header.classList.add("is-reordering");
      document.body.classList.add("is-track-reordering");
      scrollHeadersForPointer(moveEvent.clientY);
      const next = trackInsertIndex(moveEvent.clientY, track);
      insertIndex = next.index;
      placeTrackDropMarker(marker, track, next.index, next.order);
    }, () => {
      header.classList.remove("is-reordering");
      document.body.classList.remove("is-track-reordering");
      if (marker) marker.hidden = true;
      if (!dragging) return;
      reorderTrack(track, insertIndex);
    });
  });
}

const TRACK_HEIGHT_MIN = 28;
const TRACK_HEIGHT_MAX = 180;
const TRACK_HEIGHT_DEFAULT = 72;

function trackHeight(track) {
  const height = Number(track.laneHeight);
  if (height >= TRACK_HEIGHT_MIN && height <= TRACK_HEIGHT_MAX) return height;
  return TRACK_HEIGHT_DEFAULT;
}

function createTrackResizer(track) {
  const bar = document.createElement("div");
  bar.className = "seq-track-resizer";
  bar.dataset.trackId = track.id;
  bar.title = "トラックの高さを変える";
  bar.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    const start = trackHeight(track);
    trackPointer(bar, event, (moveEvent) => {
      const next = Math.min(TRACK_HEIGHT_MAX, Math.max(TRACK_HEIGHT_MIN, Math.round(start + moveEvent.clientY - startY)));
      track.laneHeight = next;
      const height = `${next}px`;
      for (const el of document.querySelectorAll(`[data-track-id="${track.id}"]`)) {
        if (el.classList.contains("seq-header") || el.classList.contains("seq-lane")) el.style.height = height;
      }
    }, () => {
      rememberProject(false);
    });
  });
  return bar;
}

function createTrackAddButton(kind) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `seq-track-add${kind === "audio" ? " is-audio" : ""}`;
  button.textContent = kind === "audio" ? "＋ 音声トラックを追加" : "＋ 映像トラックを追加";
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", () => addEmptyTrack(kind));
  return button;
}

function createTrackAddPad(kind) {
  const pad = document.createElement("div");
  pad.className = `seq-track-pad${kind === "audio" ? " is-audio" : ""}`;
  pad.setAttribute("aria-hidden", "true");
  return pad;
}

function addEmptyTrack(kind) {
  const type = kind === "audio" ? "audio" : "video";
  const track = createTrack(type, nextTrackLabel(type));
  if (type === "audio") {
    const last = state.project.tracks.reduce((index, item, at) => (item.type === "audio" ? at : index), -1);
    state.project.tracks.splice(last + 1, 0, track);
  } else {
    const index = state.project.tracks.findIndex((item) => item.type === "video");
    state.project.tracks.splice(index < 0 ? 0 : index, 0, track);
  }
  renderSequence();
  rememberProject(false);
}

const GAP_MIN = 0.05;

function trackGaps(track) {
  const clips = [...track.clips].sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  const gaps = [];
  let cursor = null;
  for (const clip of clips) {
    const start = clip.startTime;
    const end = start + clip.duration;
    if (cursor == null) {
      cursor = end;
      continue;
    }
    if (start - cursor > GAP_MIN) gaps.push({ trackId: track.id, start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  return gaps;
}

function gapAtPoint(clientX, clientY) {
  const lane = laneUnder(clientY, clientX);
  const lanes = $("seq-lanes");
  if (!lane || !lanes) return null;
  const track = trackById(lane.dataset.trackId);
  if (!track) return null;
  const time = xToTime(clientX, lanes);
  return trackGaps(track).find((gap) => time >= gap.start && time <= gap.end) || null;
}

function clearSelectedGap() {
  if (!selectedGap) return;
  selectedGap = null;
  for (const el of document.querySelectorAll("#seq-lanes .seq-gap")) el.remove();
}

function selectGap(gap) {
  selectedGap = { trackId: gap.trackId, start: gap.start, end: gap.end };
  state.selectedClipIds = [];
  renderSequence();
  syncEditCommands();
}

function rippleDeleteGap(gap) {
  const target = gap || selectedGap;
  if (!target) return;
  const track = trackById(target.trackId);
  if (!track) {
    clearSelectedGap();
    return;
  }
  if (track.locked) {
    showToast("ロック中のトラックは詰められません。");
    return;
  }
  const width = target.end - target.start;
  if (!(width > CLIP_EPS)) {
    clearSelectedGap();
    renderSequence();
    return;
  }
  for (const clip of track.clips) {
    if (clip.startTime + CLIP_EPS >= target.end) clip.startTime = Math.max(0, clip.startTime - width);
  }
  track.clips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  selectedGap = null;
  renderSequence();
  rememberProject(false);
}

function appendSelectedGap(lane, track) {
  if (!selectedGap || selectedGap.trackId !== track.id) return;
  const live = trackGaps(track).find((gap) => Math.abs(gap.start - selectedGap.start) < 0.05 && Math.abs(gap.end - selectedGap.end) < 0.05);
  if (!live) {
    selectedGap = null;
    return;
  }
  const el = document.createElement("div");
  el.className = "seq-gap is-selected";
  el.style.left = `${live.start * PX_PER_SEC}px`;
  el.style.width = `${Math.max((live.end - live.start) * PX_PER_SEC, 4)}px`;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "seq-gap-close";
  close.textContent = "×";
  close.title = "空白を詰める";
  close.setAttribute("aria-label", "空白を詰める");
  close.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    rippleDeleteGap(live);
  });
  el.append(close);
  lane.append(el);
}

const waveReady = new Map();
const wavePending = new Set();
let waveContext = null;

function fallbackWavePeaks(key) {
  let seed = 2166136261;
  const text = String(key || "wave");
  for (let i = 0; i < text.length; i += 1) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }
  const peaks = [];
  for (let i = 0; i < 48; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    peaks.push(0.16 + ((seed % 1000) / 1000) * 0.78);
  }
  return peaks;
}

function wavePeaksFor(clip) {
  const ready = clip.sourceUrl ? waveReady.get(clip.sourceUrl) : null;
  return ready || fallbackWavePeaks(clip.sourceUrl || clip.id);
}

function paintWaveCanvas(canvas, peaks) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < 2 || height < 2) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  const gap = dpr;
  const bar = Math.max(dpr, (canvas.width - gap * (peaks.length - 1)) / peaks.length);
  peaks.forEach((peak, index) => {
    const h = Math.max(dpr, peak * canvas.height);
    ctx.fillRect(index * (bar + gap), canvas.height - h, Math.max(dpr, bar - gap), h);
  });
}

function repaintClipWaves(url) {
  const peaks = waveReady.get(url);
  if (!peaks) return;
  for (const canvas of document.querySelectorAll(".seq-wave-canvas")) {
    if (canvas.dataset.src !== url) continue;
    paintWaveCanvas(canvas, peaks);
  }
}

function ensureWavePeaks(url) {
  if (!url || waveReady.has(url) || wavePending.has(url)) return;
  wavePending.add(url);
  const finish = (peaks) => {
    wavePending.delete(url);
    if (!peaks) return;
    waveReady.set(url, peaks);
    repaintClipWaves(url);
  };
  fetch(url)
    .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject()))
    .then((buffer) => {
      if (!waveContext) waveContext = new AudioContext();
      return waveContext.decodeAudioData(buffer.slice(0));
    })
    .then((audio) => {
      const channel = audio.getChannelData(0);
      const count = 48;
      const step = Math.max(1, Math.floor(channel.length / count));
      const peaks = [];
      for (let i = 0; i < count; i += 1) {
        let max = 0;
        const end = Math.min(channel.length, (i + 1) * step);
        for (let at = i * step; at < end; at += 1) max = Math.max(max, Math.abs(channel[at]));
        peaks.push(Math.min(1, max));
      }
      finish(peaks);
    })
    .catch(() => finish(null));
}

function placeVolumeLine(line, volume) {
  const value = clampVolume(volume);
  line.style.top = `${100 - (value / 200) * 100}%`;
}

function bindClipVolume(wave, line, clip) {
  wave.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const apply = (clientY) => {
      const rect = wave.getBoundingClientRect();
      const ratio = rect.height > 0 ? 1 - (clientY - rect.top) / rect.height : 1;
      clip.volume = Math.round(clampVolume(ratio * 200));
      placeVolumeLine(line, clip.volume);
      if (activeClipId() === clip.id) refreshClipAppearance(clip);
      else if (state.previewTarget === "timeline") syncLayerPlayback();
      syncNarration();
      rememberProject(true);
    };
    apply(event.clientY);
    showVolumeTip(event.clientX, event.clientY, clip.volume);
    trackPointer(wave, event, (moveEvent) => {
      apply(moveEvent.clientY);
      showVolumeTip(moveEvent.clientX, moveEvent.clientY, clip.volume);
    }, () => {
      hideVolumeTip();
    });
  });
}

function ensureVolumeTip() {
  let tip = $("seq-volume-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "seq-volume-tip";
    tip.className = "seq-volume-tip";
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

function showVolumeTip(clientX, clientY, volume) {
  const tip = ensureVolumeTip();
  tip.hidden = false;
  tip.textContent = `${Math.round(volume)}%`;
  tip.style.left = `${clientX}px`;
  tip.style.top = `${clientY}px`;
}

function hideVolumeTip() {
  const tip = $("seq-volume-tip");
  if (tip) tip.hidden = true;
}

function appendClipEdges(el) {
  const left = document.createElement("span");
  left.className = "tl-edge tl-edge-left";
  const right = document.createElement("span");
  right.className = "tl-edge tl-edge-right";
  el.append(left, right);
}

function appendClipThumb(el, clip) {
  const frame = document.createElement("div");
  frame.className = "seq-clip-thumb";
  if (clip.sourceUrl) {
    const thumb = document.createElement(isStillClip(clip) ? "img" : "video");
    thumb.className = "seq-thumb";
    thumb.draggable = false;
    if (thumb.tagName === "IMG") thumb.alt = "";
    if (thumb.tagName === "VIDEO") {
      thumb.muted = true;
      thumb.playsInline = true;
      thumb.preload = "auto";
      const at = Number.isFinite(clip.sourceStart) ? Math.max(0, clip.sourceStart) : 0;
      thumb.addEventListener("loadeddata", () => {
        const limit = Number.isFinite(thumb.duration) ? Math.max(0, thumb.duration - 0.05) : at;
        try {
          thumb.currentTime = Math.min(at, limit);
        } catch {
          // 先頭フレームがまだ読めないときは、次の表示に任せる
        }
      }, { once: true });
    }
    thumb.src = clip.sourceUrl;
    frame.append(thumb);
  }
  el.append(frame);
}

function appendClipWave(el, clip) {
  const wave = document.createElement("div");
  wave.className = "seq-clip-wave";
  wave.title = "上下にドラッグして音量を変える";
  const canvas = document.createElement("canvas");
  canvas.className = "seq-wave-canvas";
  canvas.dataset.src = clip.sourceUrl || "";
  const line = document.createElement("div");
  line.className = "seq-volume-line";
  placeVolumeLine(line, clip.volume);
  wave.append(canvas, line);
  el.append(wave);
  const paint = () => paintWaveCanvas(canvas, wavePeaksFor(clip));
  requestAnimationFrame(paint);
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(paint);
    observer.observe(wave);
  }
  ensureWavePeaks(clip.sourceUrl);
  bindClipVolume(wave, line, clip);
}

function createTrackLane(track) {
  const lane = document.createElement("div");
  lane.className = "seq-lane";
  lane.classList.toggle("is-hidden", !track.visible);
  lane.dataset.trackId = track.id;
  lane.style.height = `${trackHeight(track)}px`;
  for (const clip of track.clips) {
    const el = document.createElement("div");
    el.className = "seq-clip";
    if (clip.type === "動画") el.classList.add("is-video");
    if (isStillClip(clip)) el.classList.add("is-image");
    if (clip.type === "音声") el.classList.add("is-audio");
    if (clip.type === "テロップ") el.classList.add("is-telop");
    if (clip.kept === false) el.classList.add("is-silence");
    if (state.selectedClipIds.includes(clip.id)) el.classList.add("is-selected");
    el.dataset.id = clip.id;
    el.title = clip.kept === false ? `カット ${formatClock(clip.startTime)}` : clip.name;
    appendClipEdges(el);
    if (clip.type === "動画" || isStillClip(clip)) {
      const title = document.createElement("div");
      title.className = "seq-clip-title";
      title.textContent = clip.name;
      el.append(title);
      appendClipThumb(el, clip);
      if (clip.type === "動画") appendClipWave(el, clip);
    } else if (clip.type === "音声") {
      appendClipWave(el, clip);
    } else {
      const label = document.createElement("span");
      label.className = "tl-label";
      label.textContent = clip.name;
      el.append(label);
    }
    placeClip(el, clip);
    lane.append(el);
    bindSeqClip(el, track, clip);
  }
  appendSelectedGap(lane, track);
  return lane;
}

/** 映像は画面の下から上へ 1, 2, 3…。新しい映像は一番上に足すので、いまの最大番号の次になる。音声は上から下へ 1, 2, 3…。新しい音声は一番下に足すので、いまの最大番号の次になる。 */
function nextTrackLabel(type) {
  const prefix = type === "audio" ? "音声" : "映像";
  let max = 0;
  for (const track of state.project.tracks) {
    if ((type === "audio") !== (track.type === "audio")) continue;
    const match = /(\d+)\s*$/.exec(track.name || "");
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix} ${max + 1}`;
}

function mountTrackAt(track, index) {
  const headers = $("seq-headers");
  const lanes = $("seq-lanes");
  const view = $("seq-lanes-view");
  if (!headers || !lanes) return;
  const next = tracksTopToBottom()[index + 1];
  const headerBefore = next
    ? headers.querySelector(`.seq-header[data-track-id="${next.id}"]`)
    : headers.querySelector(".seq-track-add.is-audio");
  const laneBefore = next
    ? lanes.querySelector(`.seq-lane[data-track-id="${next.id}"]`)
    : lanes.querySelector(".seq-track-pad.is-audio");
  const header = createTrackHeader(track);
  const lane = createTrackLane(track);
  headers.insertBefore(header, headerBefore);
  headers.insertBefore(createTrackResizer(track), headerBefore);
  lanes.insertBefore(lane, laneBefore);
  lanes.insertBefore(createTrackResizer(track), laneBefore || $("seq-playhead-line"));
  if (!view) return;
  view.scrollTop = track.type === "video" ? 0 : view.scrollHeight;
  headers.scrollTop = view.scrollTop;
}

/** 一番上の映像、または一番下の音声の外へドラッグしたとき、トラックを1本足す。 */
function trackGrowTarget(clientY, clip) {
  const view = $("seq-lanes-view");
  if (!view) return null;
  const viewRect = view.getBoundingClientRect();
  const isAudio = clip.type === "音声";
  const kind = isAudio ? "audio" : "video";
  const tracks = state.project.tracks.filter((item) => item.type === kind);
  if (!tracks.length) return null;
  const edgeTrack = isAudio ? tracks[tracks.length - 1] : tracks[0];
  const lane = document.querySelector(`.seq-lane[data-track-id="${edgeTrack.id}"]`);
  if (!lane) return null;
  const rect = lane.getBoundingClientRect();
  const outside = isAudio
    ? (rect.top < viewRect.bottom && rect.bottom >= viewRect.bottom - 24 && clientY >= viewRect.bottom - 18 && clientY <= viewRect.bottom + 40)
      || (clientY > rect.bottom + 2 && clientY <= viewRect.bottom + 40 && rect.bottom <= viewRect.bottom + 2)
    : (rect.bottom > viewRect.top && rect.top <= viewRect.top + 24 && clientY <= viewRect.top + 14 && clientY >= viewRect.top - 40)
      || (clientY < rect.top - 2 && clientY >= viewRect.top - 40);
  return outside ? { kind, edgeTrack } : null;
}

function growTrackForDrag(clientY, clip, armed) {
  if (!armed) return false;
  const target = trackGrowTarget(clientY, clip);
  if (!target) return false;
  const track = createTrack(target.kind, nextTrackLabel(target.kind));
  const index = target.kind === "audio"
    ? state.project.tracks.indexOf(target.edgeTrack) + 1
    : state.project.tracks.indexOf(target.edgeTrack);
  state.project.tracks.splice(index, 0, track);
  mountTrackAt(track, index);
  return true;
}

function renderSequence() {
  const ruler = $("seq-ruler");
  const headers = $("seq-headers");
  const lanes = $("seq-lanes");
  if (!ruler || !headers || !lanes) return;

  const lanesView = $("seq-lanes-view");
  const scrollLeft = pendingLanesScroll != null ? pendingLanesScroll : (lanesView ? lanesView.scrollLeft : 0);
  const scrollTop = lanesView ? lanesView.scrollTop : 0;
  pendingLanesScroll = null;
  const width = timelineSpan() * PX_PER_SEC;
  ruler.style.width = `${width}px`;
  lanes.style.width = `${width}px`;
  ruler.replaceChildren();
  headers.replaceChildren();
  lanes.replaceChildren();

  const span = timelineSpan();
  const major = rulerMajorStep();
  const minor = major / 5;
  const ticks = Math.round(span / minor);
  for (let i = 0; i <= ticks; i += 1) {
    const time = Math.round(i * minor * 1000) / 1000;
    if (time > span + 0.001) break;
    const tick = document.createElement("div");
    const isMajor = i % 5 === 0;
    tick.className = isMajor ? "seq-tick" : "seq-tick is-minor";
    tick.style.left = `${time * PX_PER_SEC}px`;
    if (isMajor) {
      const label = document.createElement("span");
      label.textContent = formatRulerLabel(time, major);
      tick.append(label);
    }
    ruler.append(tick);
  }

  const knob = document.createElement("button");
  knob.type = "button";
  knob.className = "seq-playhead-knob";
  knob.id = "seq-playhead-knob";
  knob.title = "再生位置";
  knob.setAttribute("aria-label", "再生位置");
  ruler.append(knob);
  knob.addEventListener("pointerdown", (event) => beginPlayheadGesture(event, "ruler"));
  if (!ruler.dataset.bound) {
    ruler.dataset.bound = "1";
    ruler.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest(".seq-playhead-knob")) return;
      startRulerScrub(event);
    });
  }

  headers.append(createTrackAddButton("video"));
  lanes.append(createTrackAddPad("video"));
  for (const track of tracksTopToBottom()) {
    headers.append(createTrackHeader(track), createTrackResizer(track));
    lanes.append(createTrackLane(track), createTrackResizer(track));
  }
  headers.append(createTrackAddButton("audio"));
  lanes.append(createTrackAddPad("audio"));

  const line = document.createElement("div");
  line.className = "seq-playhead-line";
  line.id = "seq-playhead-line";
  line.title = "ドラッグで再生位置を移動";
  const scissors = document.createElement("span");
  scissors.className = "seq-playhead-scissors";
  scissors.textContent = "✂";
  scissors.title = "この位置で分割";
  scissors.setAttribute("aria-label", "この位置で分割");
  line.append(scissors);
  line.addEventListener("pointerdown", (event) => beginPlayheadGesture(event, "lane"));
  lanes.append(line);
  applyScissorsOffset();
  if (!lanes.dataset.bound) lanes.dataset.bound = "1";
  mountSnapGuide(ruler, "seq-snap-guide-ruler");
  mountSnapGuide(lanes, "seq-snap-guide");
  placePlayhead();
  bindSeqScroll();
  syncEditCommands();
  if (lanesView) {
    lanesView.scrollLeft = scrollLeft;
    lanesView.scrollTop = scrollTop;
    $("seq-ruler-view").scrollLeft = scrollLeft;
    headers.scrollTop = scrollTop;
  }
  syncMediaUsedMarks();
}

function ensureMarquee() {
  let box = $("seq-marquee");
  const lanes = $("seq-lanes");
  if (!lanes) return null;
  if (!box) {
    box = document.createElement("div");
    box.id = "seq-marquee";
    box.className = "seq-marquee";
    box.hidden = true;
  }
  if (box.parentElement !== lanes) lanes.append(box);
  return box;
}

function rectsOverlap(a, b) {
  const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return overlapX >= 1 && overlapY >= 1;
}

/** 矩形は seq-lanes 内の座標。スクロールで画面外に出たクリップも、枠の中なら選ぶ。 */
function clipsInContentRect(rect) {
  if (!rect || !(rect.right - rect.left >= 1) || !(rect.bottom - rect.top >= 1)) return [];
  const hits = [];
  for (const el of document.querySelectorAll("#seq-lanes > .seq-lane > .seq-clip")) {
    const lane = el.parentElement;
    if (!lane) continue;
    const item = {
      left: el.offsetLeft,
      right: el.offsetLeft + el.offsetWidth,
      top: lane.offsetTop + el.offsetTop,
      bottom: lane.offsetTop + el.offsetTop + el.offsetHeight,
    };
    if (item.right - item.left < 1 || item.bottom - item.top < 1) continue;
    if (!rectsOverlap(item, rect)) continue;
    if (el.dataset.id) hits.push(el.dataset.id);
  }
  return hits;
}

function beginTimelinePan(event) {
  const view = $("seq-lanes-view");
  if (!view) return;
  event.preventDefault();
  const ruler = $("seq-ruler-view");
  const headers = $("seq-headers");
  const originX = event.clientX;
  const originY = event.clientY;
  const startLeft = view.scrollLeft;
  const startTop = view.scrollTop;
  view.classList.add("is-panning");
  document.body.classList.add("is-timeline-panning");
  trackPointer(view, event, (moveEvent) => {
    view.scrollLeft = startLeft - (moveEvent.clientX - originX);
    view.scrollTop = startTop - (moveEvent.clientY - originY);
    if (ruler) ruler.scrollLeft = view.scrollLeft;
    if (headers) headers.scrollTop = view.scrollTop;
  }, () => {
    view.classList.remove("is-panning");
    document.body.classList.remove("is-timeline-panning");
  });
}

function beginTimelineEmptyGesture(event) {
  const lanes = $("seq-lanes");
  const view = $("seq-lanes-view");
  if (!lanes || !view) return;
  if (event.target.closest(".seq-clip, .tl-edge, .seq-playhead-line, .seq-playhead-knob, .seq-gap-close, .seq-track-resizer, .seq-track-add")) return;
  const originX = event.clientX;
  const originY = event.clientY;
  const startScrollLeft = view.scrollLeft;
  const startScrollTop = view.scrollTop;
  const host = lanes.getBoundingClientRect();
  const originContentX = originX - host.left;
  const originContentY = originY - host.top;
  const additive = event.shiftKey;
  let dragged = false;
  let lastX = originX;
  let lastY = originY;
  const box = ensureMarquee();
  // 始点は押したときのタイムライン座標に固定する。スクロールした分は、今のポインタ側だけへ足す。
  const contentPoint = (clientX, clientY) => ({
    x: clientX - originX + originContentX + (view.scrollLeft - startScrollLeft),
    y: clientY - originY + originContentY + (view.scrollTop - startScrollTop),
  });
  const paint = (clientX, clientY) => {
    if (!box) return;
    const current = contentPoint(clientX, clientY);
    box.hidden = false;
    box.style.left = `${Math.min(originContentX, current.x)}px`;
    box.style.top = `${Math.min(originContentY, current.y)}px`;
    box.style.width = `${Math.abs(current.x - originContentX)}px`;
    box.style.height = `${Math.abs(current.y - originContentY)}px`;
  };
  const onScroll = () => {
    if (dragged) paint(lastX, lastY);
  };
  view.addEventListener("scroll", onScroll);
  trackPointer(view, event, (moveEvent) => {
    lastX = moveEvent.clientX;
    lastY = moveEvent.clientY;
    if (Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) <= 4) return;
    dragged = true;
    paint(moveEvent.clientX, moveEvent.clientY);
  }, (endEvent) => {
    view.removeEventListener("scroll", onScroll);
    if (box) box.hidden = true;
    if (!dragged) {
      if (!additive) {
        const gap = gapAtPoint(endEvent.clientX, endEvent.clientY);
        if (gap) {
          selectGap(gap);
          return;
        }
        clearSelectedGap();
        selectClip(null);
      }
      return;
    }
    clearSelectedGap();
    const end = contentPoint(endEvent.clientX, endEvent.clientY);
    const rect = {
      left: Math.min(originContentX, end.x),
      right: Math.max(originContentX, end.x),
      top: Math.min(originContentY, end.y),
      bottom: Math.max(originContentY, end.y),
    };
    const hits = clipsInContentRect(rect);
    const next = additive ? [...state.selectedClipIds, ...hits] : hits;
    setClipSelection(next);
    for (const el of document.querySelectorAll("#seq-lanes .seq-clip")) {
      el.classList.toggle("is-selected", state.selectedClipIds.includes(el.dataset.id));
    }
    syncEditCommands();
  });
}

function bindTimelineNavigation() {
  const view = $("seq-lanes-view");
  const ruler = $("seq-ruler-view");
  const headers = $("seq-headers");
  const lanes = $("seq-lanes");
  if (!view || view.dataset.nav) return;
  view.dataset.nav = "1";
  const blockMenu = (event) => event.preventDefault();
  view.addEventListener("contextmenu", blockMenu);
  ruler?.addEventListener("contextmenu", blockMenu);
  headers?.addEventListener("contextmenu", blockMenu);
  lanes?.addEventListener("contextmenu", blockMenu);
  view.addEventListener("pointerdown", (event) => {
    if (event.button === 2) {
      if (event.target.closest(".seq-clip, .tl-edge")) return;
      beginTimelinePan(event);
      return;
    }
    if (event.button !== 0) return;
    beginTimelineEmptyGesture(event);
  });
}

function applyScissorsOffset() {
  const line = $("seq-playhead-line");
  const scissors = line?.querySelector(".seq-playhead-scissors");
  if (!line || !scissors) return;
  const height = scissors.offsetHeight || 18;
  const max = Math.max(0, line.clientHeight - height);
  const y = Math.min(Math.max(0, scissorsOffsetY), max);
  scissorsOffsetY = y;
  scissors.style.top = `${y}px`;
}

function placeScissors(clientY) {
  const line = $("seq-playhead-line");
  const scissors = line?.querySelector(".seq-playhead-scissors");
  if (!line || !scissors || !Number.isFinite(clientY)) return;
  const rect = line.getBoundingClientRect();
  const height = scissors.offsetHeight || 18;
  const y = Math.min(Math.max(0, clientY - rect.top), Math.max(0, rect.height - height));
  scissorsOffsetY = y;
  scissors.style.top = `${y}px`;
}

function setScissorsSeeking(seeking) {
  const scissors = document.querySelector("#seq-playhead-line .seq-playhead-scissors");
  if (!scissors) return;
  scissors.classList.toggle("is-seeking", seeking);
  scissors.textContent = seeking ? "↔" : "✂";
  scissors.title = seeking ? "再生位置を移動" : "この位置で分割";
}

function placePlayhead() {
  const x = state.currentTime * PX_PER_SEC;
  const knob = $("seq-playhead-knob");
  const line = $("seq-playhead-line");
  if (knob) knob.style.left = `${x - 6}px`;
  if (line) line.style.left = `${x}px`;
  syncPreviewControls();
}

function bindSeqScroll() {
  const rulerView = $("seq-ruler-view");
  const lanesView = $("seq-lanes-view");
  const headers = $("seq-headers");
  if (!rulerView || rulerView.dataset.bound) return;
  rulerView.dataset.bound = "1";
  let syncing = false;
  const link = (from, to) => {
    from.addEventListener("scroll", () => {
      if (syncing) return;
      syncing = true;
      to.scrollLeft = from.scrollLeft;
      syncing = false;
    });
  };
  link(rulerView, lanesView);
  link(lanesView, rulerView);
  lanesView.addEventListener("scroll", () => {
    headers.scrollTop = lanesView.scrollTop;
    extendTimelineTail();
  });
}

const paneSizes = { cols: [3, 1, 6], top: 1, bottom: 0.43 };
const PANE_MIN_WIDTHS = [200, 168, 280];
const PANE_MIN_HEIGHT = 120;

function applyPaneSizes() {
  fitPreviewCanvas();
  const layout = $("editor-layout");
  if (!layout || window.innerWidth <= 1100) {
    if (layout) {
      layout.style.gridTemplateColumns = "";
      layout.style.gridTemplateRows = "";
    }
    return;
  }
  const [a, b, c] = paneSizes.cols;
  const [minA, minB, minC] = PANE_MIN_WIDTHS;
  layout.style.gridTemplateColumns = `minmax(${minA}px, ${a}fr) 12px minmax(${minB}px, ${b}fr) 12px minmax(${minC}px, ${c}fr)`;
  layout.style.gridTemplateRows = `minmax(0, ${paneSizes.top}fr) 12px minmax(${PANE_MIN_HEIGHT}px, ${paneSizes.bottom}fr)`;
}

function bindPaneResize() {
  const layout = $("editor-layout");
  applyPaneSizes();
  window.addEventListener("resize", applyPaneSizes);

  for (const handle of layout.querySelectorAll(".pane-resizer")) {
    handle.addEventListener("pointerdown", (event) => {
      if (window.innerWidth <= 1100) return;
      event.preventDefault();
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // ポインタを掴めても、掴めなくても、移動中の計算は同じ
      }
      handle.classList.add("is-dragging");
      const axis = handle.dataset.axis;
      document.body.classList.add("is-pane-dragging", axis === "x" ? "is-pane-dragging-x" : "is-pane-dragging-y");

      const start = axis === "x" ? event.clientX : event.clientY;
      const index = Number(handle.dataset.index);
      const panes = [...layout.querySelectorAll(".editor-pane")];
      const topPanes = panes.slice(0, 3);
      const pair = axis === "x"
        ? [topPanes[index].getBoundingClientRect(), topPanes[index + 1].getBoundingClientRect()]
        : [topPanes[0].getBoundingClientRect(), panes[3].getBoundingClientRect()];
      const startSizes = axis === "x" ? [paneSizes.cols[index], paneSizes.cols[index + 1]] : [paneSizes.top, paneSizes.bottom];
      const startPixels = axis === "x" ? [pair[0].width, pair[1].width] : [pair[0].height, pair[1].height];
      const minimums = axis === "x" ? [PANE_MIN_WIDTHS[index], PANE_MIN_WIDTHS[index + 1]] : [PANE_MIN_HEIGHT, PANE_MIN_HEIGHT];

      const move = (moveEvent) => {
        const delta = (axis === "x" ? moveEvent.clientX : moveEvent.clientY) - start;
        let nextA = startPixels[0] + delta;
        let nextB = startPixels[1] - delta;
        if (nextA < minimums[0]) {
          nextB -= minimums[0] - nextA;
          nextA = minimums[0];
        }
        if (nextB < minimums[1]) {
          nextA -= minimums[1] - nextB;
          nextB = minimums[1];
        }
        const unit = (startSizes[0] + startSizes[1]) / (startPixels[0] + startPixels[1]);
        if (axis === "x") {
          paneSizes.cols[index] = nextA * unit;
          paneSizes.cols[index + 1] = nextB * unit;
        } else {
          paneSizes.top = nextA * unit;
          paneSizes.bottom = nextB * unit;
        }
        applyPaneSizes();
      };
      const stop = () => {
        handle.classList.remove("is-dragging");
        document.body.classList.remove("is-pane-dragging", "is-pane-dragging-x", "is-pane-dragging-y");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });
  }
}

function showEditor() {
  $("start-screen").hidden = true;
  $("editor").hidden = false;
  applyPaneSizes();
  renderSequence();
  if (!projectHistory.stack.length) seedProjectHistory();
}

function renderProjectCards() {
  const list = $("project-cards");
  list.replaceChildren();
  for (const project of RECENT_PROJECTS) {
    const card = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-card";
    button.dataset.name = project.name;
    button.innerHTML = `
      <span class="project-thumb tone-${project.tone}" aria-hidden="true"></span>
      <span class="project-meta">
        <span class="project-name"></span>
        <span class="project-sub"></span>
      </span>`;
    button.querySelector(".project-name").textContent = project.name;
    button.querySelector(".project-sub").textContent = `${project.updated} ・ ${project.duration}`;
    card.append(button);
    list.append(card);
  }
}

async function init() {
  setImportEnabled(false);
  renderProjectCards();
  renderSequence();
  updatePlayback();
  bindEvents();

  try {
    await checkHealth();
    await loadPresets();
  } catch (error) {
    state.connected = false;
    $("cut-info").textContent = error.message;
    setImportEnabled(false);
    showToast(error.message);
  }
}

init();
