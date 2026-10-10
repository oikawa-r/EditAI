use std::path::PathBuf;

use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Windows の `\\?\` 付きパスを、画面と asset プロトコルが読める形に戻す。
fn plain_path(path: PathBuf) -> String {
    let text = path.display().to_string();
    text.trim_start_matches(r"\\?\").to_string()
}

/// 選んだファイルを asset プロトコルの読み取り対象に加える。
#[tauri::command]
fn allow_media_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if !path.is_file() {
        return Err("ファイルが見つかりません。".to_string());
    }
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|err| err.to_string())?;
    Ok(())
}

/// 先頭 4 バイトが EBML なら WebM。拡張子が mp4 のままだと再生側が種類を誤る。
fn is_webm(path: &std::path::Path) -> bool {
    use std::io::Read;
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut head = [0u8; 4];
    file.read_exact(&mut head).is_ok() && head == [0x1a, 0x45, 0xdf, 0xa3]
}

/// 開発用の test.mp4 を絶対パスで返す。中身が WebM のときは隣に .webm を置く。
#[tauri::command]
fn dummy_video_path(app: tauri::AppHandle) -> Result<String, String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../temp/test/test.mp4");
    let canonical =
        std::fs::canonicalize(&path).map_err(|_| "開発用の動画が見つかりません。".to_string())?;
    let playback = if is_webm(&canonical) {
        let dest = canonical.with_extension("webm");
        let stale = match (canonical.metadata(), dest.metadata()) {
            (Ok(src), Ok(dst)) => dst
                .modified()
                .ok()
                .zip(src.modified().ok())
                .map(|(written, source)| written < source)
                .unwrap_or(true),
            _ => true,
        };
        if stale || !dest.is_file() {
            std::fs::copy(&canonical, &dest)
                .map_err(|_| "開発用の動画を読み込めませんでした。".to_string())?;
        }
        dest
    } else {
        canonical
    };
    let plain = plain_path(playback);
    app.asset_protocol_scope()
        .allow_file(&plain)
        .map_err(|err| err.to_string())?;
    Ok(plain)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            allow_media_path,
            dummy_video_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
