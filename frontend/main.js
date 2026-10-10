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
    createTrack("video", "映像 1"),
    createTrack("video", "映像 2"),
    createTrack("video", "映像 3"),
    createTrack("audio", "音声 1"),
  ];
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
  selectedClipId: null,
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

/** kept_ranges の有音と無音を、対象クリップの位置から横に並べる。 */
function applySilenceCuts(data, clipId) {
  const cut = data?.silence_cut;
  if (!cut || cut.enabled === false) return false;
  const duration = cut.original_duration || data.source?.duration || 0;
  const located = findClip(clipId);
  if (!located) return false;
  const { track, clip } = located;
  const blocks = silenceBlocks(cut.kept_ranges, duration, data.source?.fps);
  if (!blocks.length) return false;

  const family = clip.sourceUrl
    ? track.clips.filter((item) => item.sourceUrl === clip.sourceUrl)
    : [clip];
  const origin = Math.min(...family.map((item) => item.startTime));
  const sourceName = data.source?.file_name || clip.name || "動画";
  const pieces = blocks.map((block) => createClip({
    type: "動画",
    name: block.kept ? sourceName : "無音",
    startTime: origin + block.sourceStart,
    duration: block.sourceEnd - block.sourceStart,
    sourceUrl: clip.sourceUrl,
    kept: block.kept,
  }));
  const rest = track.clips.filter((item) => !family.includes(item));
  track.clips = [...rest, ...pieces].sort((a, b) => a.startTime - b.startTime);
  if (!track.clips.some((item) => item.id === state.selectedClipId)) state.selectedClipId = null;
  return true;
}

function isVisible(seg) {
  return seg.importance >= state.threshold;
}

function currentText(seg) {
  return seg.variants[seg.selected_variant] ?? seg.variants.original;
}

function setBusy(busy) {
  state.busy = busy;
  $("file-input").disabled = busy || !state.connected;
  $("import-label").classList.toggle("is-disabled", busy || !state.connected);
  $("cancel-btn").hidden = !busy;
  $("cancel-btn").disabled = false;
  $("export-btn").disabled = busy || !result;
  $("analysis-overlay").hidden = !busy;
  const cutButton = $("cut-silence-btn");
  if (cutButton) cutButton.disabled = busy;
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

  const playing = Boolean(monitor && monitor.src && !monitor.paused && !monitor.ended);
  state.playing = playing;
  placePlayhead();
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
      state.currentTime = monitor.currentTime;
      placePlayhead();
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
  const monitor = previewMonitor();
  if (!monitor || !monitor.src) return;

  if (playing) {
    const end = playbackLimit();
    if (monitor.ended || (end > 0 && state.currentTime >= end - 0.05)) setCurrentTime(0);
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

function applyResult(data, clipId) {
  result = data;
  state.segments = (data.segments || []).map((seg) => ({ ...seg, selected_variant: "original" }));
  state.threshold = 1;
  state.currentTime = 0;
  state.playing = false;
  rememberSilenceResult(data, clipId);

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

function showAnalysisProgress(status) {
  const label = status.current_step?.label ?? EXPORT_STATUS_LABELS[status.status] ?? status.status;
  const progress = Math.round(status.progress ?? 0);
  $("analysis-label").textContent = `${label}… ${progress}%`;
  $("analysis-progress").value = progress;
  $("cut-info").textContent = `${label}… ${progress}%`;
}

async function startAnalysis(file, clipId) {
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
    form.append("options", JSON.stringify({ transcription: { model: "small" } }));
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

    const split = applyResult(await api(`/projects/${created.project_id}/result`), analysis.clipId);
    showToast(split
      ? "解析が完了しました。無音の位置に切り込みを入れました。"
      : "解析が完了しました。");
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

function buildExportPayload() {
  const telops = timelineTelops();
  const variants = new Set(["original", "summary", "impact", "custom"]);
  const segments = [];
  for (const clip of telops) {
    const text = String(clip.text || clip.name || "").trim();
    const start = Math.max(0, Number(clip.startTime) || 0);
    const end = start + Math.max(0, Number(clip.duration) || 0);
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
  return {
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

const SAMPLE_TELOPS = [
  "こんにちは、今日の動画です",
  "ここが大事なポイントです",
];

function selectToolTab(group, tab) {
  for (const other of group.querySelectorAll("[role='tab']")) {
    const selected = other === tab;
    other.classList.toggle("is-active", selected);
    other.setAttribute("aria-selected", selected ? "true" : "false");
    $(other.getAttribute("aria-controls")).hidden = !selected;
  }
}

function renderSampleTelops() {
  const list = $("telop-blocks");
  list.replaceChildren();
  SAMPLE_TELOPS.forEach((text, index) => {
    const item = document.createElement("li");
    item.className = "telop-block";

    const field = document.createElement("input");
    field.className = "telop-text";
    field.type = "text";
    field.value = text;

    const choices = document.createElement("div");
    choices.className = "telop-choices";
    for (const [choice, label] of [["original", "そのままの言葉"], ["polished", "綺麗な文章に直す"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tool-choice";
      if (choice === "original") button.classList.add("is-active");
      button.textContent = label;
      button.addEventListener("click", () => {
        for (const other of choices.querySelectorAll(".tool-choice")) {
          other.classList.toggle("is-active", other === button);
        }
        const action = choice === "original" ? "そのままの言葉にする" : "綺麗な文章に直す";
        console.log(`テロップ編集: ${index + 1}件目を${action}`);
      });
      choices.append(button);
    }

    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "btn btn-secondary tool-action";
    fix.textContent = "この文言を修正する";
    fix.addEventListener("click", () => {
      console.log(`テロップ編集: ${index + 1}件目を「${field.value}」に修正する`);
    });

    item.append(field, choices, fix);
    list.append(item);
  });
}

async function cutSelectedClip() {
  const selected = findClip(state.selectedClipId);
  let clip = selected?.clip?.type === "動画" ? selected.clip : null;
  if (!clip) {
    for (const track of state.project.tracks) {
      if (track.type !== "video") continue;
      clip = track.clips.find((item) => item.type === "動画") || null;
      if (clip) break;
    }
  }
  if (!clip) {
    showToast("切り込みを入れる動画がありません。");
    return;
  }
  try {
    const media = state.media.find((item) => item.file && (item.url === clip.sourceUrl || item.name === clip.name));
    let file = media?.file || null;
    if (!file && clip.sourceUrl) {
      const response = await fetch(clip.sourceUrl);
      if (!response.ok) throw new Error("動画を読み込めませんでした。");
      const blob = await response.blob();
      const name = clip.name && /\.[a-z0-9]+$/i.test(clip.name) ? clip.name : "video.mp4";
      file = new File([blob], name, { type: blob.type || "video/mp4" });
    }
    if (!file) {
      showToast("このクリップの動画を読み込めませんでした。");
      return;
    }
    await startAnalysis(file, clip.id);
  } catch (error) {
    showToast(error.message || "動画を読み込めませんでした。");
  }
}

const silenceResults = new Map();
const CLIP_LOOK_KEYS = [
  "x", "y", "scale", "rotation", "flipH", "flipV",
  "baseWidth", "baseHeight", "width", "height",
  "speed", "chromaEnabled", "chromaColor", "volume", "fadeIn", "fadeOut", "pitch",
];

function rememberSilenceResult(data, clipId) {
  const located = findClip(clipId);
  const url = located?.clip.sourceUrl;
  if (!url || !data) return;
  if (!data.silence_cut && !(data.segments || []).length) return;
  silenceResults.set(url, data);
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
    kept,
  });
  copyClipLook(clip, piece);
  piece.sourceStart = sourceStart;
  return piece;
}

function cutCompareVersions(clip, data) {
  const cut = data?.silence_cut;
  if (!cut || cut.enabled === false) return null;
  const duration = cut.original_duration || data.source?.duration || clip.duration;
  const blocks = silenceBlocks(cut.kept_ranges, duration, data.source?.fps);
  if (!blocks.length) return null;
  const sourceName = data.source?.file_name || clip.name || "動画";
  const origin = clip.startTime;
  const split = blocks.map((block) => cutPiece(
    clip,
    block.kept ? sourceName : "無音",
    origin + block.sourceStart,
    block.sourceEnd - block.sourceStart,
    block.kept,
    block.sourceStart,
  ));
  const packed = [];
  let cursor = origin;
  for (const block of blocks) {
    if (!block.kept) continue;
    const length = block.sourceEnd - block.sourceStart;
    packed.push(cutPiece(clip, sourceName, cursor, length, true, block.sourceStart));
    cursor += length;
  }
  return { split, packed, origin };
}

let cutComparePlan = null;
let cutCompareSyncing = false;

function cutSpan(clips, origin) {
  return Math.max(clips.reduce((max, clip) => Math.max(max, clip.startTime - origin + clip.duration), 0), 0.001);
}

function cutLane(kind) {
  return $(kind === "packed" ? "cut-lane-packed" : "cut-lane-split");
}

function localTimeFromEvent(event, kind) {
  const lane = cutLane(kind);
  const px = cutComparePlan?.px?.[kind] || 1;
  return Math.max(0, (event.clientX - lane.getBoundingClientRect().left) / px);
}

function sourceTimeForPacked(localTime) {
  const clips = [...cutComparePlan.packed].sort((a, b) => a.startTime - b.startTime);
  let remain = localTime;
  for (const clip of clips) {
    if (remain <= clip.duration + CLIP_EPS) {
      return clip.sourceStart + Math.max(0, Math.min(remain, clip.duration));
    }
    remain -= clip.duration;
  }
  const last = clips[clips.length - 1];
  return last ? last.sourceStart + last.duration : 0;
}

function packedLocalForSource(sourceTime) {
  const clips = [...cutComparePlan.packed].sort((a, b) => a.startTime - b.startTime);
  let local = 0;
  for (const clip of clips) {
    const end = clip.sourceStart + clip.duration;
    if (sourceTime <= clip.sourceStart) return local;
    if (sourceTime <= end) return local + (sourceTime - clip.sourceStart);
    local += clip.duration;
  }
  return local;
}

function placeCutPlayhead(kind) {
  const head = $(kind === "packed" ? "cut-playhead-packed" : "cut-playhead-split");
  if (!head || !cutComparePlan) return;
  head.style.left = `${cutComparePlan.time[kind] * (cutComparePlan.px[kind] || 1)}px`;
}

function markCutActive(kind) {
  $("cut-lane-packed")?.classList.toggle("is-active", kind === "packed");
  $("cut-lane-split")?.classList.toggle("is-active", kind === "split");
}

function syncCutSplitButton() {
  const button = $("cut-split-btn");
  const plan = cutComparePlan;
  if (!button || !plan) return;
  const clip = plan.split.find((item) => item.id === plan.selectedSplitId);
  const time = plan.origin + plan.time.split;
  const inside = Boolean(
    clip && time > clip.startTime + CLIP_EPS && time < clip.startTime + clip.duration - CLIP_EPS,
  );
  button.disabled = !inside;
}

function markSplitSelection() {
  const track = $("cut-track-split");
  if (!track || !cutComparePlan) return;
  for (const el of track.querySelectorAll(".cut-dummy")) {
    el.classList.toggle("is-selected", el.dataset.id === cutComparePlan.selectedSplitId);
  }
  syncCutSplitButton();
}

function seekCompare(kind, localTime) {
  const plan = cutComparePlan;
  if (!plan) return;
  const span = cutSpan(plan[kind], plan.origin);
  const time = Math.min(Math.max(0, localTime), span);
  plan.time[kind] = time;
  plan.active = kind;
  placeCutPlayhead(kind);
  markCutActive(kind);
  if (kind === "split") syncCutSplitButton();
  const video = $("cut-compare-video");
  if (!video) return;
  const source = kind === "split" ? time : sourceTimeForPacked(time);
  const apply = () => {
    if (!cutComparePlan || cutComparePlan.active !== kind || !$("cut-compare-dialog")?.open) return;
    const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : source;
    const next = Math.min(Math.max(0, source), limit);
    if (Math.abs(video.currentTime - next) < 0.04) return;
    cutCompareSyncing = true;
    video.currentTime = next;
  };
  if (video.readyState >= 1) apply();
  else video.addEventListener("loadedmetadata", apply, { once: true });
}

function onCompareVideoTime() {
  if (cutCompareSyncing || !cutComparePlan || !$("cut-compare-dialog")?.open) return;
  const video = $("cut-compare-video");
  const kind = cutComparePlan.active;
  const local = kind === "split" ? video.currentTime : packedLocalForSource(video.currentTime);
  const span = cutSpan(cutComparePlan[kind], cutComparePlan.origin);
  cutComparePlan.time[kind] = Math.min(Math.max(0, local), span);
  placeCutPlayhead(kind);
  if (kind === "split") syncCutSplitButton();
}

function renderCutLane(kind) {
  const plan = cutComparePlan;
  const clips = plan[kind];
  const track = $(kind === "packed" ? "cut-track-packed" : "cut-track-split");
  const lane = cutLane(kind);
  if (!track || !lane) return;
  track.replaceChildren();
  const span = cutSpan(clips, plan.origin);
  const view = lane.parentElement?.clientWidth || 480;
  const px = Math.max(10, Math.min(48, view / span));
  plan.px[kind] = px;
  lane.style.width = `${Math.max(span * px, view)}px`;
  for (const clip of clips) {
    const el = document.createElement("div");
    el.className = "cut-dummy";
    if (clip.kept === false) el.classList.add("is-silence");
    if (kind === "split" && clip.id === plan.selectedSplitId) el.classList.add("is-selected");
    el.dataset.id = clip.id;
    el.style.left = `${(clip.startTime - plan.origin) * px}px`;
    el.style.width = `${Math.max(clip.duration * px, 8)}px`;
    const label = document.createElement("span");
    label.className = "tl-label";
    label.textContent = clip.kept === false ? "無音" : clip.name;
    el.append(label);
    if (kind === "split") {
      const left = document.createElement("span");
      left.className = "tl-edge tl-edge-left";
      const right = document.createElement("span");
      right.className = "tl-edge tl-edge-right";
      el.prepend(left);
      el.append(right);
      el.addEventListener("pointerdown", (event) => onSplitClipPointerDown(clip, el, event));
    }
    track.append(el);
  }
  placeCutPlayhead(kind);
  if (kind === "split") syncCutSplitButton();
}

function placeCutClip(el, clip) {
  const px = cutComparePlan.px.split || 1;
  el.style.left = `${(clip.startTime - cutComparePlan.origin) * px}px`;
  el.style.width = `${Math.max(clip.duration * px, 8)}px`;
}

function snapSplitEdge(time, clipId, minTime, maxTime) {
  const limit = 12 / (cutComparePlan.px.split || 1);
  const targets = [cutComparePlan.origin + cutComparePlan.time.split];
  for (const item of cutComparePlan.split) {
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

function onSplitClipPointerDown(clip, el, event) {
  if (event.button !== 0) return;
  const edge = event.target.closest(".tl-edge");
  if (!edge) {
    cutComparePlan.selectedSplitId = clip.id;
    markSplitSelection();
    return;
  }
  event.stopPropagation();
  cutComparePlan.selectedSplitId = clip.id;
  markSplitSelection();
  const side = edge.classList.contains("tl-edge-left") ? "left" : "right";
  const fixedEnd = clip.startTime + clip.duration;
  const fixedStart = clip.startTime;
  const sourceStart = clip.sourceStart;
  el.classList.add("is-trimming");
  trackPointer(el, event, (moveEvent) => {
    const pointer = cutComparePlan.origin + localTimeFromEvent(moveEvent, "split");
    if (side === "left") {
      const raw = Math.min(Math.max(cutComparePlan.origin, pointer), fixedEnd - MIN_CLIP_SEC);
      const snapped = snapSplitEdge(raw, clip.id, cutComparePlan.origin, fixedEnd - MIN_CLIP_SEC);
      clip.startTime = snapped;
      clip.duration = fixedEnd - clip.startTime;
      if (Number.isFinite(sourceStart)) clip.sourceStart = sourceStart + (clip.startTime - fixedStart);
    } else {
      const raw = Math.max(pointer, fixedStart + MIN_CLIP_SEC);
      const snapped = snapSplitEdge(raw, clip.id, fixedStart + MIN_CLIP_SEC, Number.POSITIVE_INFINITY);
      clip.duration = snapped - fixedStart;
    }
    placeCutClip(el, clip);
  }, () => {
    el.classList.remove("is-trimming");
    const holder = { clips: cutComparePlan.split };
    overwriteTrack(holder, clip.id);
    cutComparePlan.split = holder.clips;
    cutComparePlan.selectedSplitId = clip.id;
    renderCutLane("split");
    const local = side === "left"
      ? clip.startTime - cutComparePlan.origin
      : clip.startTime + clip.duration - cutComparePlan.origin;
    seekCompare("split", local);
  });
}

function onCutLanePointerDown(kind, event) {
  if (event.button !== 0) return;
  if (event.target.closest(".tl-edge")) return;
  seekCompare(kind, localTimeFromEvent(event, kind));
  trackPointer(event.currentTarget, event, (moveEvent) => {
    seekCompare(kind, localTimeFromEvent(moveEvent, kind));
  });
}

function splitCompareAtPlayhead() {
  const plan = cutComparePlan;
  if (!plan || !$("cut-compare-dialog")?.open) return;
  const clip = plan.split.find((item) => item.id === plan.selectedSplitId);
  if (!clip) {
    showToast("分割するブロックを選んでください。");
    return;
  }
  const time = plan.origin + plan.time.split;
  const start = clip.startTime;
  const end = start + clip.duration;
  if (time <= start + CLIP_EPS || time >= end - CLIP_EPS) {
    showToast("再生ヘッドがブロックの途中にありません。");
    return;
  }
  const right = sliceClip(clip, time, end - time);
  clip.duration = time - start;
  plan.split.push(right);
  plan.split.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  plan.selectedSplitId = right.id;
  renderCutLane("split");
}

function openCutCompare() {
  const located = findClip(state.selectedClipId);
  if (!located || located.clip.type !== "動画") {
    showToast("比較する動画クリップを選んでください。");
    return;
  }
  const clip = located.clip;
  if (!clip.sourceUrl) {
    showToast("このクリップの動画を表示できません。");
    return;
  }
  const data = silenceResults.get(clip.sourceUrl);
  const versions = cutCompareVersions(clip, data);
  if (!versions || !versions.packed.length) {
    showToast("このクリップの無音解析結果がまだありません。");
    return;
  }
  cutComparePlan = {
    clipId: clip.id,
    trackId: located.track.id,
    ...versions,
    active: "split",
    time: { packed: 0, split: 0 },
    selectedSplitId: null,
    px: { packed: 1, split: 1 },
  };
  const dialog = $("cut-compare-dialog");
  dialog.dataset.clipId = clip.id;
  $("cut-compare-name").textContent = clip.name || "動画";
  const monitor = previewMonitor();
  if (monitor && !monitor.paused) monitor.pause();
  const video = $("cut-compare-video");
  if (video.src !== clip.sourceUrl) video.src = clip.sourceUrl;
  video.currentTime = 0;
  if (!dialog.open) dialog.showModal();
  renderCutLane("packed");
  renderCutLane("split");
  seekCompare("split", 0);
}

function applyCutCompare(kind) {
  const plan = cutComparePlan;
  if (!plan) return;
  const located = findClip(plan.clipId);
  if (!located) {
    showToast("元のクリップが見つかりません。");
    return;
  }
  if (located.track.locked) {
    showToast("ロック中のトラックは置き換えできません。");
    return;
  }
  const pieces = kind === "packed" ? plan.packed : plan.split;
  if (!pieces.length) {
    showToast("適用する区間がありません。");
    return;
  }
  const { track } = located;
  track.clips = track.clips.filter((item) => item.id !== plan.clipId);
  track.clips.push(...pieces);
  track.clips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  state.selectedClipId = pieces[0].id;
  cutComparePlan = null;
  $("cut-compare-dialog").close();
  renderSequence();
  setCurrentTime(pieces[0].startTime);
  rememberProject(false);
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

function buildTelopItems(segments, data) {
  return (segments || []).map((seg, index) => {
    const variants = {
      original: seg.variants?.original || "",
      summary: seg.variants?.summary || seg.variants?.original || "",
      impact: seg.variants?.impact || seg.variants?.summary || seg.variants?.original || "",
    };
    const ai = variants.summary !== variants.original ? "summary" : "impact";
    const pretty = variants[ai] || variants.original;
    const useAi = Boolean(pretty && pretty !== variants.original);
    const sourceStart = outputTimeToSource(seg.start, data);
    const sourceEnd = Math.max(outputTimeToSource(seg.end, data), sourceStart + 0.05);
    return {
      id: seg.id || `seg-${index}`,
      sourceStart,
      sourceEnd,
      variants,
      mode: useAi ? "ai" : "original",
      ai,
      text: useAi ? pretty : variants.original,
      custom: false,
    };
  }).filter((item) => item.sourceEnd > item.sourceStart);
}

function telopSpan(plan) {
  const fromItems = plan.items.reduce((max, item) => Math.max(max, item.sourceEnd), 0);
  return Math.max(fromItems, Number(plan.sourceDuration) || 0, 0.001);
}

function familyPieces(clip, track) {
  const family = track.clips.filter((item) => item.type === "動画" && item.sourceUrl && item.sourceUrl === clip.sourceUrl);
  return family.length ? family : [clip];
}

function sourceRangeOf(piece, pieces) {
  if (Number.isFinite(piece.sourceStart)) {
    return { start: piece.sourceStart, end: piece.sourceStart + piece.duration };
  }
  const origin = Math.min(...pieces.map((item) => item.startTime));
  return { start: piece.startTime - origin, end: piece.startTime - origin + piece.duration };
}

function timelineTimeForSource(sourceTime, clip, track) {
  const pieces = familyPieces(clip, track);
  for (const piece of pieces) {
    const range = sourceRangeOf(piece, pieces);
    if (sourceTime >= range.start - 0.02 && sourceTime <= range.end + 0.02) {
      return piece.startTime + (sourceTime - range.start);
    }
  }
  const range = sourceRangeOf(clip, pieces);
  return clip.startTime + (sourceTime - range.start);
}

function trackAbove(track) {
  const videos = state.project.tracks.filter((item) => item.type === "video");
  const index = videos.findIndex((item) => item.id === track.id);
  if (index < 0) return null;
  return videos[index + 1] || videos[index - 1] || null;
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
  for (const block of document.querySelectorAll("#telop-gen-track .cut-dummy")) {
    block.classList.toggle("is-selected", block.dataset.id === plan.selectedId);
  }
}

function refreshTelopLabel(id) {
  const item = telopPlan?.items.find((entry) => entry.id === id);
  const block = document.querySelector(`#telop-gen-track .cut-dummy[data-id="${id}"] .tl-label`);
  if (item && block) block.textContent = item.text.trim() || "（空）";
}

function seekTelop(sourceTime) {
  const plan = telopPlan;
  if (!plan) return;
  const time = Math.min(Math.max(0, sourceTime), telopSpan(plan));
  plan.time = time;
  placeTelopPlayhead();
  const video = $("telop-gen-video");
  if (!video) return;
  const apply = () => {
    if (!telopPlan || !$("telop-gen-dialog")?.open) return;
    const limit = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : time;
    const next = Math.min(Math.max(0, time), limit);
    if (Math.abs(video.currentTime - next) < 0.04) return;
    telopSyncing = true;
    video.currentTime = next;
  };
  if (video.readyState >= 1) apply();
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
  if (seek) seekTelop(item.sourceStart);
}

function syncTelopChoice(row, item) {
  for (const button of row.querySelectorAll(".telop-choice")) {
    const selected = button.dataset.mode === item.mode;
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
    prettyTitle.textContent = "綺麗な文";
    const prettyBody = document.createElement("span");
    prettyBody.textContent = item.variants[item.ai] || item.variants.original || "（空）";
    pretty.append(prettyTitle, prettyBody);
    const aiSelect = document.createElement("select");
    aiSelect.setAttribute("aria-label", "AI補正の種類");
    for (const [value, label] of [["summary", "要約"], ["impact", "インパクト"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      aiSelect.append(option);
    }
    aiSelect.value = item.ai === "impact" ? "impact" : "summary";
    aiCol.append(pretty, aiSelect);
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
    aiSelect.addEventListener("change", () => {
      item.ai = aiSelect.value === "impact" ? "impact" : "summary";
      prettyBody.textContent = item.variants[item.ai] || item.variants.original || "（空）";
      if (item.mode === "ai") applyChoice("ai");
    });
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

function renderTelopLane() {
  const plan = telopPlan;
  const track = $("telop-gen-track");
  const lane = $("telop-gen-lane");
  if (!plan || !track || !lane) return;
  track.replaceChildren();
  const span = telopSpan(plan);
  const view = lane.parentElement?.clientWidth || 480;
  const px = Math.max(8, Math.min(48, view / span));
  plan.px = px;
  lane.style.width = `${Math.max(span * px, view)}px`;
  for (const item of plan.items) {
    const el = document.createElement("div");
    el.className = "cut-dummy is-telop";
    if (item.id === plan.selectedId) el.classList.add("is-selected");
    el.dataset.id = item.id;
    el.style.left = `${item.sourceStart * px}px`;
    el.style.width = `${Math.max((item.sourceEnd - item.sourceStart) * px, 8)}px`;
    const label = document.createElement("span");
    label.className = "tl-label";
    label.textContent = item.text.trim() || "（空）";
    el.append(label);
    el.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      selectTelopItem(item.id, true);
    });
    track.append(el);
  }
  placeTelopPlayhead();
}

function onTelopLanePointerDown(event) {
  if (event.button !== 0 || !telopPlan) return;
  if (event.target.closest(".cut-dummy")) return;
  const lane = $("telop-gen-lane");
  const time = Math.max(0, (event.clientX - lane.getBoundingClientRect().left) / (telopPlan.px || 1));
  const hit = telopPlan.items.find((item) => time >= item.sourceStart && time < item.sourceEnd);
  if (hit) selectTelopItem(hit.id, false);
  seekTelop(time);
}

function onTelopVideoTime() {
  if (telopSyncing || !telopPlan || !$("telop-gen-dialog")?.open) return;
  const video = $("telop-gen-video");
  const time = Math.min(Math.max(0, video.currentTime), telopSpan(telopPlan));
  telopPlan.time = time;
  placeTelopPlayhead();
  if (document.activeElement?.closest?.("#telop-gen-list textarea")) return;
  const hit = telopPlan.items.find((item) => time >= item.sourceStart && time < item.sourceEnd);
  if (hit && hit.id !== telopPlan.selectedId) selectTelopItem(hit.id, false);
}

function openTelopGenerate() {
  const located = findClip(state.selectedClipId);
  if (!located || located.clip.type !== "動画") {
    showToast("テロップを作る動画クリップを選んでください。");
    return;
  }
  const clip = located.clip;
  if (!clip.sourceUrl) {
    showToast("このクリップの動画を表示できません。");
    return;
  }
  const data = silenceResults.get(clip.sourceUrl);
  const items = buildTelopItems(data?.segments, data);
  if (!items.length) {
    showToast("このクリップの文字起こしがまだありません。");
    return;
  }
  telopPlan = {
    clipId: clip.id,
    trackId: located.track.id,
    sourceUrl: clip.sourceUrl,
    data,
    items,
    selectedId: items[0].id,
    time: 0,
    px: 1,
    sourceDuration: data?.source?.duration || data?.silence_cut?.original_duration || clip.duration,
  };
  const dialog = $("telop-gen-dialog");
  $("telop-gen-name").textContent = clip.name || "動画";
  const monitor = previewMonitor();
  if (monitor && !monitor.paused) monitor.pause();
  const video = $("telop-gen-video");
  if (video.src !== clip.sourceUrl) video.src = clip.sourceUrl;
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
  const dest = trackAbove(located.track);
  if (!dest || dest.id === located.track.id) {
    showToast("テロップを置く映像トラックがありません。");
    return;
  }
  if (dest.locked) {
    showToast("ロック中のトラックにはテロップを置けません。");
    return;
  }
  const usable = plan.items.filter((item) => item.text.trim());
  if (!usable.length) {
    showToast("表示するテロップがありません。");
    return;
  }
  const { height } = projectSize();
  const boxH = Math.max(48, Math.round(height * 0.18));
  const pieces = usable.map((item) => {
    const start = timelineTimeForSource(item.sourceStart, located.clip, located.track);
    let end = timelineTimeForSource(item.sourceEnd, located.clip, located.track);
    if (end < start) end = start + (item.sourceEnd - item.sourceStart);
    const text = item.text.trim();
    const piece = createClip({
      type: "テロップ",
      name: telopClipName(text),
      startTime: start,
      duration: Math.max(end - start, 0.05),
      sourceUrl: "",
    });
    piece.text = text;
    piece.baseHeight = boxH;
    piece.height = boxH;
    piece.y = Math.round(height / 2 - boxH / 2 - height * 0.04);
    piece.segmentId = item.id;
    return piece;
  });
  for (const item of plan.items) {
    const seg = (plan.data?.segments || []).find((entry) => entry.id === item.id);
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
  dest.clips.push(...pieces);
  dest.clips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  state.selectedClipId = pieces[0].id;
  telopPlan = null;
  $("telop-gen-dialog").close();
  renderSequence();
  syncPropertyPanel();
  setCurrentTime(pieces[0].startTime);
  showToast(`テロップを「${dest.name}」に追加しました。`);
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
  el.textContent = text || "";
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
  frame.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
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
    if (handle) startTelopEditScale(item, event);
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
  const located = findClip(state.selectedClipId);
  if (!located || (located.clip.type !== "テロップ" && located.clip.type !== "動画")) {
    showToast("編集するテロップを選ぶか、テロップのある動画を選んでください。");
    return;
  }
  let video = null;
  let telops = [];
  let selectedId = null;
  if (located.clip.type === "テロップ") {
    video = videoOverlappingTelop(located.clip);
    telops = video
      ? telopsOverlapping(video.clip.startTime, video.clip.startTime + video.clip.duration)
      : located.track.clips.filter((clip) => clip.type === "テロップ");
    if (!telops.some((clip) => clip.id === located.clip.id)) telops.push(located.clip);
    telops.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
    selectedId = located.clip.id;
  } else {
    video = { track: located.track, clip: located.clip };
    telops = telopsOverlapping(located.clip.startTime, located.clip.startTime + located.clip.duration);
    selectedId = telops[0]?.id || null;
  }
  if (!telops.length || !selectedId) {
    showToast("この動画にテロップがありません。");
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
  $("telop-edit-name").textContent = video?.clip.name || located.clip.name || "テロップ";
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
  if (findClip(selected)) state.selectedClipId = selected;
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

  renderSampleTelops();

  $("cut-silence-btn").addEventListener("click", () => {
    cutSelectedClip();
  });
  $("cut-gap-delete-btn").addEventListener("click", openCutCompare);
  $("cut-apply-packed").addEventListener("click", () => applyCutCompare("packed"));
  $("cut-apply-split").addEventListener("click", () => applyCutCompare("split"));
  $("cut-split-btn").addEventListener("click", splitCompareAtPlayhead);
  $("cut-lane-packed").addEventListener("pointerdown", (event) => onCutLanePointerDown("packed", event));
  $("cut-lane-split").addEventListener("pointerdown", (event) => onCutLanePointerDown("split", event));
  const compareVideo = $("cut-compare-video");
  compareVideo.addEventListener("timeupdate", onCompareVideoTime);
  compareVideo.addEventListener("seeked", () => {
    cutCompareSyncing = false;
    onCompareVideoTime();
  });
  $("cut-compare-dialog").addEventListener("close", () => {
    compareVideo.pause();
    cutCompareSyncing = false;
  });
  $("telop-generate-btn").addEventListener("click", openTelopGenerate);
  $("telop-gen-apply").addEventListener("click", applyTelopGenerate);
  $("telop-gen-lane").addEventListener("pointerdown", onTelopLanePointerDown);
  const telopVideo = $("telop-gen-video");
  telopVideo.addEventListener("timeupdate", onTelopVideoTime);
  telopVideo.addEventListener("seeked", () => {
    telopSyncing = false;
    onTelopVideoTime();
  });
  $("telop-gen-dialog").addEventListener("close", () => {
    telopVideo.pause();
    telopSyncing = false;
  });
  $("telop-settings-btn").addEventListener("click", () => {
    const count = Math.max(1, Number($("telop-max-chars").value) || 1);
    console.log(`テロップ設定: ${count}文字以内で区切ってテロップを生成する`);
  });
  $("telop-style-btn").addEventListener("click", openTelopEdit);
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
    selectedClipId: state.selectedClipId,
    currentTime: state.currentTime,
  };
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
  state.selectedClipId = snap.selectedClipId;
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
  const total = projectDuration();
  if (seek && !scrubbingPreview) {
    seek.max = String(Math.max(total, 0.01));
    seek.value = String(Math.min(Math.max(0, state.currentTime), Number(seek.max)));
  }
  if (label) label.textContent = `${formatTimecode(state.currentTime)} / ${formatTimecode(total)}`;
  if (play) {
    const playing = state.playing;
    play.textContent = playing ? "一時停止" : "再生";
    play.setAttribute("aria-label", playing ? "一時停止" : "再生");
  }
  const aspect = $("preview-aspect");
  const custom = $("preview-custom");
  if (aspect && document.activeElement !== aspect) {
    const key = aspectKeyForProject();
    aspect.value = key;
    if (custom) custom.hidden = key !== "custom";
  }
  const widthInput = $("preview-width");
  const heightInput = $("preview-height");
  if (widthInput && document.activeElement !== widthInput) widthInput.value = String(state.project.width || 1920);
  if (heightInput && document.activeElement !== heightInput) heightInput.value = String(state.project.height || 1080);
}

function stepPreviewFrame(direction) {
  setPlaying(false);
  const frame = 1 / (state.project.fps || 30);
  setCurrentTime(state.currentTime + direction * frame);
  updatePlayback();
}

function applyPreviewAspect(key) {
  const custom = $("preview-custom");
  if (custom) custom.hidden = key !== "custom";
  if (key === "custom") return;
  const table = {
    "16:9": [16, 9],
    "9:16": [9, 16],
    "4:3": [4, 3],
    "3:4": [3, 4],
    "1:1": [1, 1],
  };
  const pair = table[key];
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

function applyCustomCanvasSize() {
  const width = Math.min(7680, Math.max(16, Math.round(Number($("preview-width").value) || 0)));
  const height = Math.min(7680, Math.max(16, Math.round(Number($("preview-height").value) || 0)));
  if (!width || !height) return;
  state.project.width = width;
  state.project.height = height;
  rememberProject(true);
  fitPreviewCanvas();
  syncPropertyPanel();
}

let previewMuted = false;

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
  syncPreviewMuteButton();
}

function drawContained(ctx, source, sw, sh, dx, dy, dw, dh) {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  const scale = Math.min(dw / sw, dh / sh);
  const width = sw * scale;
  const height = sh * scale;
  ctx.drawImage(source, dx + (dw - width) / 2, dy + (dh - height) / 2, width, height);
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
  const video = previewMonitor();
  const frame = $("preview-transform");
  if (video && frame && video.videoWidth > 0 && video.readyState >= 2) {
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
    const link = document.createElement("a");
    const stamp = formatTimecode(state.currentTime).replaceAll(":", "");
    link.href = url;
    link.download = `editai-${stamp}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    setCurrentTime(Number(seek.value));
  });
  const endPreviewScrub = () => {
    scrubbingPreview = false;
    syncPreviewControls();
  };
  seek.addEventListener("change", endPreviewScrub);
  seek.addEventListener("pointerup", endPreviewScrub);
  seek.addEventListener("pointercancel", endPreviewScrub);
  aspect.addEventListener("change", () => applyPreviewAspect(aspect.value));
  $("preview-width").addEventListener("change", applyCustomCanvasSize);
  $("preview-height").addEventListener("change", applyCustomCanvasSize);
  $("preview-mute").addEventListener("click", togglePreviewMute);
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
  });
  $("prop-chroma-color").addEventListener("input", () => {
    const clip = selectedEditableClip();
    if (!clip) return;
    clip.chromaColor = $("prop-chroma-color").value;
    rememberProject(true);
  });
  bindPreviewGestures();
  const previewStage = document.querySelector(".preview-stage");
  if (previewStage) new ResizeObserver(() => syncPropertyPanel()).observe(previewStage);
  document.addEventListener("keydown", (event) => {
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
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    if ($("editor").hidden) return;
    const key = event.key.toLowerCase();
    if ($("cut-compare-dialog")?.open) {
      if (key === "s") {
        event.preventDefault();
        splitCompareAtPlayhead();
      }
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    if (key === "s") {
      event.preventDefault();
      splitSelectedAtPlayhead();
    } else if (key === "delete" || key === "backspace") {
      event.preventDefault();
      deleteSelectedClip();
    }
  });

  $("file-input").addEventListener("change", (event) => {
    addMediaFiles(event.target.files);
    event.target.value = "";
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
    addMediaFiles(event.dataTransfer.files);
  });

  $("cancel-btn").addEventListener("click", cancelAnalysis);
  $("export-btn").addEventListener("click", startExport);

  $("start-create").addEventListener("click", () => {
    showEditor();
    if (!result && !$("preview-monitor").getAttribute("src")) {
      $("file-name").textContent = "新しいプロジェクト";
    }
  });
  bindPaneResize();
  $("settings-btn").addEventListener("click", () => {
    showToast("設定はこれから追加します。");
  });
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
  $("file-input").disabled = false;
  $("import-label").classList.remove("is-disabled");
}

function mediaKind(file) {
  const type = file.type || "";
  const ext = file.name.split(".").pop().toLowerCase();
  if (type.startsWith("video/") || ["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) return "動画";
  if (type.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "写真";
  if (type.startsWith("audio/") || ["mp3", "wav", "m4a", "aac"].includes(ext)) return "音声";
  return "";
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

async function addMediaFiles(fileList) {
  const added = [];
  const videos = [];
  for (const file of fileList) {
    const kind = mediaKind(file);
    if (!kind) {
      showToast(`「${file.name}」は追加できない種類です。`);
      continue;
    }
    const url = URL.createObjectURL(file);
    state.media.push({ name: file.name, kind, file, url });
    const duration = await probeDuration(url, kind);
    const track = trackForKind(kind);
    const clip = createClip({
      type: kind,
      name: file.name,
      startTime: trackEnd(track),
      duration,
      sourceUrl: url,
    });
    track.clips.push(clip);
    added.push(file.name);
    if (kind === "動画") videos.push({ file, clipId: clip.id });
  }
  if (!added.length) return;
  renderMediaList();
  renderSequence();
  rememberProject(false);
  if (!videos.length) {
    showToast(added.length === 1 ? `「${added[0]}」を追加しました。` : `${added.length}件を追加しました。`);
    return;
  }
  for (const video of videos) {
    const ok = await startAnalysis(video.file, video.clipId);
    if (!ok) break;
  }
}

function renderMediaList() {
  const list = $("media-list");
  list.replaceChildren();
  for (const item of state.media) {
    const li = document.createElement("li");
    li.className = "media-item";
    if (item.url) {
      const thumb = document.createElement(item.kind === "写真" ? "img" : "video");
      thumb.className = "media-thumb";
      thumb.src = item.url;
      if (thumb.tagName === "VIDEO") {
        thumb.muted = true;
        thumb.preload = "metadata";
        thumb.playsInline = true;
      }
      li.append(thumb);
    }
    const name = document.createElement("span");
    name.className = "media-item-name";
    name.textContent = item.name;
    const kind = document.createElement("span");
    kind.className = "media-item-kind";
    kind.textContent = item.kind;
    li.append(name, kind);
    list.append(li);
  }
}

const ZOOM_MIN = 6;
const ZOOM_MAX = 320;
let PX_PER_SEC = 56;
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

function createClip({ type, name, startTime, duration, sourceUrl, kept = true }) {
  return {
    id: nextClipId(),
    type,
    name,
    startTime,
    duration,
    sourceUrl: sourceUrl || "",
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

function trackEnd(track) {
  return track.clips.reduce((max, clip) => Math.max(max, clip.startTime + clip.duration), 0);
}

function projectDuration() {
  let max = 0;
  for (const track of state.project.tracks) {
    for (const clip of track.clips) max = Math.max(max, clip.startTime + clip.duration);
  }
  return max;
}

function timelineSpan() {
  const view = $("seq-lanes-view");
  const content = projectDuration() + 4;
  const visible = view ? view.clientWidth / PX_PER_SEC : 30;
  return Math.max(content, visible, 30);
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

function xToTime(clientX, el) {
  const rect = el.getBoundingClientRect();
  return Math.max(0, (clientX - rect.left) / PX_PER_SEC);
}

function setCurrentTime(time) {
  const limit = playbackLimit();
  const next = limit > 0 ? Math.min(Math.max(0, time), limit) : Math.max(0, time);
  state.currentTime = next;
  placePlayhead();
  const monitor = previewMonitor();
  if (!monitor || !Number.isFinite(monitor.duration) || monitor.duration <= 0) return;
  if (Math.abs(monitor.currentTime - next) < 0.001) return;
  syncingMonitor = true;
  monitor.currentTime = next;
}

function pullMonitorTime() {
  const monitor = previewMonitor();
  if (!monitor || scrubbingTimeline || syncingMonitor) return;
  if (!Number.isFinite(monitor.currentTime)) return;
  state.currentTime = monitor.currentTime;
  placePlayhead();
  applyClipPlayback();
}

function bindPreviewMonitor() {
  const monitor = previewMonitor();
  if (!monitor || monitor.dataset.bound) return;
  monitor.dataset.bound = "1";
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
  const monitor = previewMonitor();
  const resume = Boolean(monitor && monitor.src && !monitor.paused && !monitor.ended);
  scrubbingTimeline = true;
  if (resume) monitor.pause();
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

function selectClip(id) {
  state.selectedClipId = id;
  for (const el of document.querySelectorAll(".seq-clip")) {
    el.classList.toggle("is-selected", el.dataset.id === id);
  }
  syncEditCommands();
}

function syncEditCommands() {
  const has = Boolean(state.selectedClipId && findClip(state.selectedClipId));
  const split = $("split-btn");
  const remove = $("delete-btn");
  if (split) split.disabled = !has;
  if (remove) remove.disabled = !has;
  syncPropertyPanel();
}

function selectedEditableClip() {
  const located = findClip(state.selectedClipId);
  if (!located) return null;
  if (located.clip.type !== "動画" && located.clip.type !== "画像") return null;
  return located.clip;
}

function selectedDirectClip() {
  const located = findClip(state.selectedClipId);
  if (!located) return null;
  if (located.clip.type !== "画像" && located.clip.type !== "テロップ") return null;
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

function applyClipPlayback() {
  const monitor = previewMonitor();
  if (!monitor) return;
  monitor.muted = previewMuted;
  const located = findClip(state.selectedClipId);
  const clip = located?.clip;
  if (!clip || clip.type !== "動画") {
    monitor.playbackRate = 1;
    monitor.volume = 1;
    return;
  }
  ensureClipLayout(clip);
  monitor.playbackRate = Math.min(4, Math.max(0.1, clip.speed));
  let gain = Math.min(100, Math.max(0, Number(clip.volume) || 0)) / 100;
  const local = state.currentTime - clip.startTime;
  if (local >= 0 && local <= clip.duration) {
    if (clip.fadeIn > 0 && local < clip.fadeIn) gain *= local / clip.fadeIn;
    const remain = clip.duration - local;
    if (clip.fadeOut > 0 && remain < clip.fadeOut) gain *= Math.max(0, remain) / clip.fadeOut;
  }
  monitor.volume = Math.min(1, Math.max(0, gain));
}

function applyPreviewSelection() {
  const frame = $("preview-transform");
  const object = $("preview-object");
  const image = $("preview-image");
  const telop = $("preview-telop");
  const monitor = previewMonitor();
  if (!frame || !object) return;
  const located = findClip(state.selectedClipId);
  const clip = located?.clip || null;
  object.hidden = true;
  if (image) image.hidden = true;
  if (telop) telop.hidden = true;
  hidePreviewGuides();
  if (monitor) monitor.style.pointerEvents = "";
  if (!clip || (clip.type !== "動画" && clip.type !== "画像" && clip.type !== "テロップ")) {
    resetVideoFrame();
    applyClipPlayback();
    return;
  }
  ensureClipLayout(clip);
  if (clip.type === "動画") {
    placeLayer(frame, clip);
    applyClipPlayback();
    return;
  }
  resetVideoFrame();
  object.hidden = false;
  if (monitor) monitor.style.pointerEvents = "none";
  if (clip.type === "画像") {
    image.hidden = false;
    if (image.dataset.source !== (clip.sourceUrl || "")) {
      image.dataset.source = clip.sourceUrl || "";
      image.src = clip.sourceUrl || "";
    }
  } else {
    telop.hidden = false;
    paintTelopCaption(telop, clip.text || clip.name || "テロップ", clip.style || DEFAULT_STYLE);
  }
  placeLayer(object, clip);
  applyClipPlayback();
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
    ["prop-scale", clip.scale, 1],
    ["prop-width", clip.width, 1],
    ["prop-height", clip.height, 1],
    ["prop-x", clip.x, 1],
    ["prop-y", clip.y, 1],
    ["prop-rotation", clip.rotation, 1],
    ["prop-speed", clip.speed, 0.1],
    ["prop-volume", clip.volume, 1],
    ["prop-fade-in", clip.fadeIn, 0.1],
    ["prop-fade-out", clip.fadeOut, 0.1],
    ["prop-pitch", clip.pitch, 1],
  ];
  for (const [id, value, step] of fields) {
    const input = $(id);
    if (!input || input === document.activeElement) continue;
    input.value = fieldText(value, step);
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
    if (document.activeElement?.dataset?.prop) document.activeElement.blur();
    applyPreviewSelection();
    return;
  }
  if (clipChanged && document.activeElement?.dataset?.prop) document.activeElement.blur();
  writePropertyFields(clip);
  applyPreviewSelection();
}

function refreshClipAppearance(clip) {
  writePropertyFields(clip);
  applyPreviewSelection();
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
  if (key === "scale" || key === "width" || key === "height") {
    if (!(clip.baseWidth > 0) || !(clip.baseHeight > 0)) return;
    if (key === "width") setClipScale(clip, value / clip.baseWidth * 100);
    else if (key === "height") setClipScale(clip, value / clip.baseHeight * 100);
    else setClipScale(clip, value);
  } else if (key === "speed") {
    clip.speed = Math.min(4, Math.max(0.1, value));
  } else if (key === "volume") {
    clip.volume = Math.min(100, Math.max(0, value));
  } else if (key === "fadeIn" || key === "fadeOut") {
    clip[key] = Math.max(0, value);
  } else if (key === "pitch") {
    clip.pitch = Math.min(12, Math.max(-12, value));
  } else {
    clip[key] = value;
  }
  refreshClipAppearance(clip);
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

function bindPreviewGestures() {
  const canvas = $("preview-canvas");
  const object = $("preview-object");
  if (!canvas || !object || canvas.dataset.gestures) return;
  canvas.dataset.gestures = "1";
  canvas.addEventListener("pointerdown", (event) => {
    if (event.target.closest("#preview-object")) return;
    if (event.target.closest("video")) return;
    selectClip(null);
  });
  object.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const clip = selectedDirectClip();
    if (!clip) return;
    event.stopPropagation();
    const handle = event.target.closest("[data-handle]")?.dataset.handle;
    if (handle === "rotate") startPreviewRotate(clip, event);
    else if (handle) startPreviewScale(clip, event);
    else startPreviewMove(clip, event);
  });
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

function startPreviewScale(clip, event) {
  ensureClipLayout(clip);
  const center = clipCenterScreen(clip);
  const startDist = Math.max(8, Math.hypot(event.clientX - center.x, event.clientY - center.y));
  const startScale = clip.scale;
  trackPointer(event.currentTarget, event, (moveEvent) => {
    const dist = Math.hypot(moveEvent.clientX - center.x, moveEvent.clientY - center.y);
    setClipScale(clip, startScale * dist / startDist);
    refreshClipAppearance(clip);
  }, () => {
    rememberProject(false);
  });
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
}

function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function splitSelectedAtPlayhead() {
  const located = findClip(state.selectedClipId);
  if (!located) {
    showToast("分割するクリップを選んでください。");
    return;
  }
  if (located.track.locked) {
    showToast("ロック中のトラックは分割できません。");
    return;
  }
  const clip = located.clip;
  const time = state.currentTime;
  const start = clip.startTime;
  const end = start + clip.duration;
  if (time <= start + CLIP_EPS || time >= end - CLIP_EPS) {
    showToast("再生ヘッドがクリップの途中にありません。");
    return;
  }
  const right = sliceClip(clip, time, end - time);
  clip.duration = time - start;
  located.track.clips.push(right);
  located.track.clips.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  state.selectedClipId = right.id;
  renderSequence();
  rememberProject(false);
}

function deleteSelectedClip() {
  const located = findClip(state.selectedClipId);
  if (!located) return;
  if (located.track.locked) {
    showToast("ロック中のトラックは削除できません。");
    return;
  }
  located.track.clips = located.track.clips.filter((item) => item.id !== located.clip.id);
  state.selectedClipId = null;
  renderSequence();
  rememberProject(false);
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

function collectSnapTimes(ignoreId) {
  const times = [state.currentTime];
  for (const track of state.project.tracks) {
    for (const item of track.clips) {
      if (item.id === ignoreId) continue;
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

function snapMovedClip(startTime, duration, clipId) {
  const targets = collectSnapTimes(clipId);
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

function laneUnder(clientY) {
  for (const lane of document.querySelectorAll(".seq-lane")) {
    const rect = lane.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) return lane;
  }
  return null;
}

function sliceClip(clip, startTime, duration) {
  const next = createClip({
    type: clip.type,
    name: clip.name,
    startTime,
    duration,
    sourceUrl: clip.sourceUrl,
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
  if (clip.text) next.text = clip.text;
  if (Number.isFinite(clip.sourceStart)) {
    next.sourceStart = clip.sourceStart + (startTime - clip.startTime);
  }
  return next;
}

/** 操作したクリップを優先し、同じトラックの重なりを削る・割る・消す。 */
function overwriteTrack(track, activeId) {
  const active = track.clips.find((item) => item.id === activeId);
  if (!active) return;
  const a0 = active.startTime;
  const a1 = a0 + active.duration;
  const next = [active];
  for (const clip of track.clips) {
    if (clip.id === activeId) continue;
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
      if (Number.isFinite(clip.sourceStart)) clip.sourceStart += a1 - clip.startTime;
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
  state.selectedClipId = clip.id;
  overwriteTrack(destTrack, clip.id);
  renderSequence();
  setCurrentTime(previewTime);
  rememberProject(false);
}

function bindSeqClip(el, track, clip) {
  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (track.locked) {
      selectClip(clip.id);
      return;
    }
    const lane = el.parentElement;
    const edge = event.target.closest(".tl-edge");
    if (edge) {
      const side = edge.classList.contains("tl-edge-left") ? "left" : "right";
      const fixedEnd = clip.startTime + clip.duration;
      const fixedStart = clip.startTime;
      el.classList.add("is-trimming");
      holdPreview();
      trackPointer(el, event, (moveEvent) => {
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
        const time = side === "left" ? clip.startTime : clip.startTime + clip.duration;
        finishClipEdit(track, track, clip, time);
      });
      return;
    }

    const grab = xToTime(event.clientX, lane) - clip.startTime;
    const originX = event.clientX;
    const originY = event.clientY;
    let mode = "press";
    let destTrack = track;
    let growArmed = true;
    trackPointer(el, event, (moveEvent) => {
      const moved = Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY);
      if (mode === "press" && moved > 5) {
        mode = "move";
        el.classList.add("is-moving");
        holdPreview();
      }
      if (mode !== "move") return;
      const grown = growTrackForDrag(moveEvent.clientY, clip, growArmed);
      if (grown) growArmed = false;
      else if (laneUnder(moveEvent.clientY) && !trackGrowTarget(moveEvent.clientY, clip)) growArmed = true;
      const hoveredLane = laneUnder(moveEvent.clientY);
      const hovered = hoveredLane && trackById(hoveredLane.dataset.trackId);
      if (hovered && clipFitsTrack(clip, hovered) && el.parentElement !== hoveredLane) {
        hoveredLane.append(el);
        destTrack = hovered;
      }
      const measureLane = el.parentElement || lane;
      const rawStart = Math.max(0, xToTime(moveEvent.clientX, measureLane) - grab);
      const snapped = snapMovedClip(rawStart, clip.duration, clip.id);
      clip.startTime = snapped.startTime;
      showSnapGuide(snapped.guide);
      placeClip(el, clip);
    }, () => {
      el.classList.remove("is-moving");
      showSnapGuide(null);
      if (mode !== "move") {
        selectClip(clip.id);
        return;
      }
      finishClipEdit(track, destTrack, clip, clip.startTime);
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
  } else {
    const speaker = headerIcon(track.muted ? "ミュート中" : "音を出す", !track.muted, ICON_SPEAKER);
    toggle(speaker, () => track.muted, (value) => { track.muted = value; });
    header.append(speaker);
  }
  const lock = headerIcon(track.locked ? "ロック中" : "編集できる", track.locked, ICON_LOCK);
  toggle(lock, () => track.locked, (value) => { track.locked = value; });
  header.append(name, lock);
  return header;
}

function createTrackLane(track) {
  const lane = document.createElement("div");
  lane.className = "seq-lane";
  lane.classList.toggle("is-hidden", !track.visible);
  lane.dataset.trackId = track.id;
  for (const clip of track.clips) {
    const el = document.createElement("div");
    el.className = "seq-clip";
    if (clip.type === "画像") el.classList.add("is-image");
    if (clip.type === "音声") el.classList.add("is-audio");
    if (clip.type === "テロップ") el.classList.add("is-telop");
    if (clip.kept === false) el.classList.add("is-silence");
    if (clip.id === state.selectedClipId) el.classList.add("is-selected");
    el.dataset.id = clip.id;
    el.title = clip.kept === false ? `カット ${formatClock(clip.startTime)}` : clip.name;
    const left = document.createElement("span");
    left.className = "tl-edge tl-edge-left";
    const label = document.createElement("span");
    label.className = "tl-label";
    label.textContent = clip.name;
    const right = document.createElement("span");
    right.className = "tl-edge tl-edge-right";
    el.append(left, label, right);
    placeClip(el, clip);
    lane.append(el);
    bindSeqClip(el, track, clip);
  }
  return lane;
}

function nextTrackLabel(type) {
  const prefix = type === "audio" ? "音声" : "映像";
  let max = 0;
  for (const track of state.project.tracks) {
    if (track.type !== type) continue;
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
  headers.insertBefore(createTrackHeader(track), headers.children[index] || null);
  const laneNodes = [...lanes.querySelectorAll(":scope > .seq-lane")];
  lanes.insertBefore(createTrackLane(track), laneNodes[index] || $("seq-playhead-line"));
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
  knob.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    event.preventDefault();
    startRulerScrub(event);
  });
  if (!ruler.dataset.bound) {
    ruler.dataset.bound = "1";
    ruler.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest(".seq-playhead-knob")) return;
      startRulerScrub(event);
    });
  }

  for (const track of state.project.tracks) {
    headers.append(createTrackHeader(track));
    lanes.append(createTrackLane(track));
  }

  const line = document.createElement("div");
  line.className = "seq-playhead-line";
  line.id = "seq-playhead-line";
  lanes.append(line);
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
  });
}

const paneSizes = { cols: [1, 1, 1], top: 1, bottom: 0.43 };
const PANE_MIN_WIDTH = 180;
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
  layout.style.gridTemplateColumns = `minmax(0, ${a}fr) 12px minmax(0, ${b}fr) 12px minmax(0, ${c}fr)`;
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
      const minimum = axis === "x" ? PANE_MIN_WIDTH : PANE_MIN_HEIGHT;

      const move = (moveEvent) => {
        const delta = (axis === "x" ? moveEvent.clientX : moveEvent.clientY) - start;
        let nextA = startPixels[0] + delta;
        let nextB = startPixels[1] - delta;
        if (nextA < minimum) {
          nextB -= minimum - nextA;
          nextA = minimum;
        }
        if (nextB < minimum) {
          nextA -= minimum - nextB;
          nextB = minimum;
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

const DUMMY_VIDEO_NAME = "test.mp4";
const DUMMY_VIDEO_URL = "../temp/test/test.mp4";
let dummyVideoLoaded = false;

async function loadDummyVideo() {
  if (dummyVideoLoaded) return;
  dummyVideoLoaded = true;

  const url = new URL(DUMMY_VIDEO_URL, window.location.href).href;
  let sourceUrl = url;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    const raw = await response.blob();
    const head = new Uint8Array(await raw.slice(0, 4).arrayBuffer());
    const webm = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    const blob = webm ? new Blob([raw], { type: "video/webm" }) : raw;
    sourceUrl = URL.createObjectURL(blob);
  } catch {
    showToast("開発用の動画を読み込めませんでした。");
  }

  state.media.push({ name: DUMMY_VIDEO_NAME, kind: "動画", url: sourceUrl });
  const clip = createClip({
    type: "動画",
    name: DUMMY_VIDEO_NAME,
    startTime: 0,
    duration: 8,
    sourceUrl,
  });
  baseVideoTrack().clips.push(clip);
  renderMediaList();
  renderSequence();
  seedProjectHistory();

  const monitor = previewMonitor();
  const applyDuration = () => {
    if (!Number.isFinite(monitor.duration) || monitor.duration <= 0 || clip.duration === monitor.duration) return;
    clip.duration = monitor.duration;
    renderSequence();
    if (projectHistory.stack.length === 1 && projectHistory.index === 0) seedProjectHistory();
    else rememberProject(false);
  };
  monitor.addEventListener("loadedmetadata", applyDuration);
  monitor.src = sourceUrl;
  applyDuration();
  monitor.addEventListener("error", () => {
    showToast("開発用の動画をプレビューに表示できませんでした。");
  }, { once: true });
  $("file-name").textContent = DUMMY_VIDEO_NAME;
}

function showEditor() {
  $("start-screen").hidden = true;
  $("editor").hidden = false;
  applyPaneSizes();
  loadDummyVideo();
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
  $("file-input").disabled = true;
  $("import-label").classList.add("is-disabled");
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
    $("file-input").disabled = true;
    $("import-label").classList.add("is-disabled");
    showToast(error.message);
  }
}

init();
