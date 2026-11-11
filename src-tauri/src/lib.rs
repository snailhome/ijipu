/**
 * iJipu 桌面端入口（Tauri v2 壳）
 * 前端为纯 Web 构建产物（vite build → ../dist），此处仅启动 WebView2 窗口。
 * 后端能力：
 *  - 采样音色库离线缓存读写（adj323）——soundfont 文本落在应用数据目录
 *    soundfonts/<lib_id>.js，前端通过 window.__TAURI__.core.invoke 调用。
 *  - 内置高质量音源（SF2）读取（adj346/adj416）——发布程序随包把 generaluser_gs.sf2
 *    放在安装目录，运行时直接读该文件（离线、无需联网下载）。
 *  - adj538：**外部打开**（双击 `.jps` / 文件关联）——路径经命令行参数进来，入队后通知前端；
 *    并提供"写回原文件"（保存时回读校验）。关联的注册/注销由 NSIS 钩子负责，见 `nsis/hooks.nsh`。
 *  - adj568：**桌面端工作区**——原生"选文件夹" + 按**磁盘路径**读写 `.jps`（绕开 Chromium
 *    对「下载/桌面/文档」整个目录的敏感目录黑名单，见下方 `ws_*` 命令段的说明）。
 */
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// adj875：命令行（`@ijipu/cli`）的**能力宿主**模块（Windows 命名管道；默认不开启）。
mod cli_host;
// adj1084：命令行导出视频的宿主侧（隐藏出片窗口 + 父进程等待）
mod cli_video;
// adj1085：桌面壳本机配置（%APPDATA%\iJipu\settings.json，三端存储分层）
mod prefs;
// adj1085：配置附件（卡片背景图）的 base64 编解码
mod b64;

/// adj944（用户需求「全局设置里加注册 iJipu CLI 的按钮」）：把**安装目录注册进当前用户 PATH** ——
/// 读写注册表 / 写前备份 / 回读校验 / 广播 `WM_SETTINGCHANGE` 都在这里；
/// **字符串口径与编排在 TS**（`packages/ijipu-cli/src/envPath.ts`），应用界面与命令行共用那一份 ✓。
mod cli_path;

/// adj942：**内嵌 CLI** —— `ijipu.exe cli …` 时用它跑编进 exe 的那段 JS（QuickJS），
/// **先于窗口**分流（见 `main.rs`）。只挂在 Windows 下：本轮交付物就是 `ijipu.exe` ✓。
#[cfg(windows)]
pub mod cli_embed;

/// adj957（用户裁定）：`mod cli_manual;` 已删除 —— 原先它提供 `cli_manual_open`，用**系统默认程序**
/// 打开随包放在安装目录里的 `docs/iJipu-CLI-手册.md`（adj945）。
/// 用户口径：那几份 MD 不必随包分发，命令行手册改在**应用内**看（`dialogs/DocDialog.tsx` 的 `kind:'cli'`，
/// 与操作手册/语法说明同路）⇒ 随包资源映射、`src-tauri/src/cli_manual.rs` 与本模块的注册一并撤掉。
/// 顺带解决一个真缺陷：Windows 默认没有 `.md` 关联程序，那个按钮在多数机器上会弹「你要如何打开此文件」。

/// adj538：待打开的 `.jps` 路径队列（去重前的原始路径，前端取走即清空）。
///
/// 为什么用队列 + 拉取，而不是直接把内容 emit 给前端：**冷启动存在竞态**——
/// `setup()` 阶段 emit 可能早于前端注册监听器，事件就丢了。所以路径先入队，
/// 前端在 mount 时（以及每次收到 `ijipu://open-files` 时）调 `take_pending_open_files` 拉取，
/// 拉取是幂等的"取走即清空"，重复调用不会重复打开。
#[derive(Default)]
struct PendingOpen(Mutex<Vec<String>>);

/// 是否是我们要接的文件参数：`.jps` 结尾且不是开关（`-`/`--`）。
/// 刻意**不按位置过滤**（不 `skip(1)`）：不同来源的 argv 是否含 argv[0]（exe 自身）并不一致
/// —— 单实例插件回传的参数含 exe 路径，而 exe 不会以 `.jps` 结尾，故"按后缀筛选"对两种口径都成立。
fn is_jps_arg(arg: &str) -> bool {
    !arg.starts_with('-') && arg.to_ascii_lowercase().ends_with(".jps")
}

/// 从 `OsString` 参数列表里挑出 `.jps` 路径（非 UTF-8 参数直接跳过，不 panic）。
fn jps_paths_from_os_args<I: IntoIterator<Item = OsString>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter_map(|a| a.into_string().ok())
        .filter(|a| is_jps_arg(a))
        .collect()
}

/// 从 `String` 参数列表里挑出 `.jps` 路径（单实例插件回传的是 `Vec<String>`）。
fn jps_paths_from_string_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter().filter(|a| is_jps_arg(a)).collect()
}

/// 交给前端的一个外部文件：读失败时 `error` 有值（前端据此提示，而不是静默打不开）。
#[derive(serde::Serialize)]
struct ExternalFile {
    path: String,
    /// 文件名（去扩展名）——与前端 `fileBaseName` 同口径
    name: String,
    code: String,
    error: Option<String>,
}

fn read_external_file(path: &str) -> ExternalFile {
    let p = Path::new(path);
    let name = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名".to_string());
    match std::fs::read_to_string(p) {
        Ok(code) => ExternalFile {
            path: path.to_string(),
            name,
            code,
            error: None,
        },
        Err(e) => ExternalFile {
            path: path.to_string(),
            name,
            code: String::new(),
            error: Some(e.to_string()),
        },
    }
}

/// adj538：取走待打开队列（前端 mount 时 / 收到 `ijipu://open-files` 后调用）。
#[tauri::command]
fn take_pending_open_files(state: tauri::State<'_, PendingOpen>) -> Vec<ExternalFile> {
    let paths = std::mem::take(&mut *state.0.lock().unwrap());
    paths.iter().map(|p| read_external_file(p)).collect()
}

/// adj538：写回外部文件（双击打开后 Ctrl+S 存回原文件）。
/// 与前端 FSA 路径**同口径**：写完**回读校验**，不一致就报错——宁可提示失败，也绝不谎报已保存
/// （对应 `src/store/saveSupport.ts` 的 `SaveVerifyError` 语义）。
#[tauri::command]
fn write_external_file(path: String, text: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("文件不存在或不是普通文件：{}", path));
    }
    std::fs::write(&p, &text).map_err(|e| format!("{}: {}", path, e))?;
    let back = std::fs::read_to_string(&p).map_err(|e| format!("回读失败 {}: {}", path, e))?;
    if back != text {
        return Err("写入后回读内容与预期不一致".to_string());
    }
    Ok(())
}

/// adj1128：读对拍边车文件（`赤伶.jps.sync.json`）。
///
/// 为什么不复用 `read_native_probe`：那个返回的是"外部改动检测"用的形状（含 mtime），
/// 而且**文件不存在时报错**；这里"文件不存在"是**正常状态**（还没对拍过）⇒ 返回 `None`，
/// 前端据此新建，而不是弹一个红字。
#[tauri::command]
fn sync_read_file(path: String) -> Result<Option<String>, String> {
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {}", path, e)),
    }
}

/// adj1154：伴奏音频的上限（256 MB；几百秒的无损也够）。
const AUDIO_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// 按 sidecar 里记的文件名读伴奏字节。
///
/// 安全边界（与 `read_asset_bytes` 同一套思路）：
///  · 只接受**音频扩展名**——不许拿一句路径把任意文件读进内存；
///  · 单文件 ≤ 256 MB（正常伴奏远小于它）。
fn read_audio_file_bytes(p: &Path) -> Result<Vec<u8>, String> {
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        ext.as_str(),
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "opus" | "webm"
    ) {
        return Err(format!(
            "只接受音频扩展名（mp3/m4a/aac/wav/flac/ogg/opus/webm）：{}",
            p.display()
        ));
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("{}: {}", p.display(), e))?;
    if meta.len() > AUDIO_MAX_BYTES {
        return Err(format!(
            "音频太大（超过 {}MB）：{}",
            AUDIO_MAX_BYTES / 1024 / 1024,
            p.display()
        ));
    }
    std::fs::read(p).map_err(|e| format!("{}: {}", p.display(), e))
}

/// adj1154：桌面壳按 sidecar 记的路径**自动读伴奏**（否则每次重开都要再选一次）。
/// 返回原始字节（`Response`，不经 JSON/base64 膨胀），前端交给 `decodeAccompaniment`。
#[tauri::command(async)]
fn sync_read_audio(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = read_audio_file_bytes(Path::new(&path))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// adj1128：写对拍边车文件——**允许新建**（`write_external_file` 要求文件已存在，
/// 而 sidecar 第一次保存时必然不存在）。
///
/// 与 `write_external_file` 同一口径：写完**回读校验**，不一致就报错，绝不谎报已保存。
/// 只写一个同目录的小 JSON，不建目录、不覆盖目录。
#[tauri::command]
fn sync_write_file(path: String, text: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        return Err(format!("目标是目录，不能当文件写：{}", path));
    }
    if let Some(dir) = p.parent() {
        if !dir.is_dir() {
            return Err(format!("目录不存在：{}", dir.display()));
        }
    }
    std::fs::write(&p, &text).map_err(|e| format!("{}: {}", path, e))?;
    let back = std::fs::read_to_string(&p).map_err(|e| format!("回读失败 {}: {}", path, e))?;
    if back != text {
        return Err("写入后回读内容与预期不一致".to_string());
    }
    Ok(())
}

/// adj966：读一个**系统文件**的当前内容 + mtime（毫秒）——"外部改动检测"的原生 IO。
///
/// 为什么要单独一条命令：既有的 `ws_read_text` 要求"工作区根 + 相对段"，
/// 而桌面端要**默认直接操作系统文件**（原生路径绑定，见双击关联打开那条路）——
/// 轮询检测外部改动需要**按绝对路径**读一次内容并取 mtime。信任模型与 `write_external_file` 一致：
/// 路径来自用户自己的选择（打开/另存为/双击关联），这里不额外放开任何目录范围。
#[derive(serde::Serialize)]
struct NativeFileProbe {
    text: String,
    /// 修改时间（毫秒，自 UNIX 纪元）；取不到就是 `None` ⇒ 前端退化为**只比内容**（安全判据不依赖时间戳）
    mtime_ms: Option<u64>,
}

#[tauri::command]
fn read_native_probe(path: String) -> Result<NativeFileProbe, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("文件不存在或不是普通文件：{}", path));
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("{}: {}", path, e))?;
    let mtime_ms = std::fs::metadata(&p)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(NativeFileProbe { text, mtime_ms })
}

#[cfg(test)]
mod native_probe_tests {
    use super::read_native_probe;

    /// adj966：外部改动检测的原生读取——内容要读回来、mtime 要能取到；
    /// 不存在 / 不是普通文件必须**报错**（不许返回空内容，否则前端会把"读不到"当成"文件被清空"）。
    #[test]
    fn reads_text_and_mtime_and_rejects_missing() {
        let dir = std::env::temp_dir().join("ijipu-native-probe-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("probe.jps");
        std::fs::write(&f, "1 2 3\n").unwrap();
        let got = read_native_probe(f.to_string_lossy().to_string()).unwrap();
        assert_eq!(got.text, "1 2 3\n");
        assert!(got.mtime_ms.is_some(), "应当能取到 mtime");
        let missing = read_native_probe(dir.join("nope.jps").to_string_lossy().to_string());
        assert!(missing.is_err(), "不存在的文件必须报错");
        let as_dir = read_native_probe(dir.to_string_lossy().to_string());
        assert!(as_dir.is_err(), "目录不是普通文件，必须报错");
        let _ = std::fs::remove_file(&f);
    }
}

/// adj1128：对拍边车文件（`xxx.jps.sync.json`）的读写。
///
/// 三条判据都是"错了会骗用户"的地方：
///  ① 写**允许新建**（第一版复用 `write_external_file` 就因为"要求文件已存在"而根本存不了）；
///  ② 读遇到"文件不存在"要返回 `Ok(None)`（还没对拍过是正常状态，不是错误）；
///  ③ 写完回读必须与写入一致，否则报错（绝不谎报已保存）。
#[cfg(test)]
mod sync_io_tests {
    use super::{read_audio_file_bytes, sync_read_file, sync_write_file};

    #[test]
    fn writes_new_file_and_reads_back() {
        let dir = std::env::temp_dir().join("ijipu-sync-io-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("曲.jps.sync.json");
        let _ = std::fs::remove_file(&f);
        // ① 文件不存在时读 ⇒ None（不是错误）
        assert_eq!(sync_read_file(f.to_string_lossy().to_string()).unwrap(), None);
        // ② 第一次写 = 新建
        let text = "{\n  \"version\": 1\n}\n";
        sync_write_file(f.to_string_lossy().to_string(), text.to_string()).unwrap();
        // ③ 回读一致
        assert_eq!(
            sync_read_file(f.to_string_lossy().to_string()).unwrap().as_deref(),
            Some(text)
        );
        // ④ 目录不存在 ⇒ 明确报错
        let bad = dir.join("no-such-dir").join("x.json");
        assert!(sync_write_file(bad.to_string_lossy().to_string(), "x".to_string()).is_err());
        let _ = std::fs::remove_file(&f);
    }

    /// adj1154：伴奏字节读取的扩展名白名单 + 真实字节往返
    #[test]
    fn reads_audio_bytes_and_rejects_other_extensions() {
        let dir = std::env::temp_dir().join("ijipu-sync-audio-test");
        std::fs::create_dir_all(&dir).unwrap();
        let audio = dir.join("伴奏.mp3");
        let bytes = vec![0x49, 0x44, 0x33, 0x04, 0x00];
        std::fs::write(&audio, &bytes).unwrap();
        assert_eq!(read_audio_file_bytes(&audio).unwrap(), bytes);

        let text = dir.join("谱.jps");
        std::fs::write(&text, b"V: 1.0\n").unwrap();
        assert!(read_audio_file_bytes(&text).is_err());
        let _ = std::fs::remove_file(&audio);
        let _ = std::fs::remove_file(&text);
    }
}

/// 把路径入队并通知前端（冷启动由 `setup()` 调用；热启动由单实例回调调用）。
fn queue_open_paths(app: &tauri::AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<PendingOpen>() {
        state.0.lock().unwrap().extend(paths.clone());
    }
    let _ = app.emit("ijipu://open-files", paths);
}

/// 读采样音色库缓存文件（app_data_dir/soundfonts/<lib_id>.js）；不存在返回 None。
#[tauri::command]
fn sf_cache_read(app: tauri::AppHandle, lib_id: String) -> Result<Option<String>, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("soundfonts");
    let path = dir.join(format!("{}.js", lib_id));
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

/// 写采样音色库缓存文件（自动创建目录）。
#[tauri::command]
fn sf_cache_write(app: tauri::AppHandle, lib_id: String, text: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("soundfonts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.js", lib_id)), text).map_err(|e| e.to_string())
}

/// 删除采样音色库缓存文件。
#[tauri::command]
fn sf_cache_remove(app: tauri::AppHandle, lib_id: String) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("soundfonts");
    let path = dir.join(format!("{}.js", lib_id));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// adj416：内置音源候选文件（按优先级）——安装目录根的 `<lib_id>.sf2` 优先，其次
/// `soundfonts/<lib_id>.sf2` 子目录。
/// Windows 下 resource_dir() == exe 所在目录，故“安装目录”与“exe 旁”是同一处。
///
/// adj894（用户要求「把内置的 generaluser_gs.sf2 也放在 soundfonts 里，和 LICENSE 放一起」）：
/// **随包布局改为 `soundfonts/`**（见 `tauri.conf.json` 的 `bundle.resources`），于是它与
/// `LICENSE-GeneralUserGS.txt` / `README.md` 同目录、一眼能看出是哪来的。
/// 两个候选都保留 ⇒ ① 旧的便携版布局照常可用；② 用户仍可把自备 sf2 放**安装目录根**来**覆盖**内置那份
/// （根目录**优先**于 soundfonts/，这正是把"可替换"这条路留在这里的原因）。
/// adj1025：**资源安装包目录**（用户自备的资源包落点）。
///
/// 用户 2026-10-21 明确：资源安装包装到 `%LOCALAPPDATA%\iJipu\soundfonts\`。
/// 它和"我的音色库目录"（`%APPDATA%\com.ijipu.app\soundfonts`）不是一处，所以单独扫。
fn resource_soundfont_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .local_data_dir()
        .ok()
        .map(|d| d.join("iJipu").join("soundfonts"))
}

/// 纯函数版：给单测用（AppHandle 在测试里造不出来）
#[cfg(test)]
fn resource_dir_under(local_data: &Path) -> PathBuf {
    local_data.join("iJipu").join("soundfonts")
}

fn builtin_soundfont_candidates(app: &tauri::AppHandle, lib_id: &str) -> Result<Vec<PathBuf>, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let file = format!("{}.sf2", lib_id);
    let mut out = vec![dir.join(&file), dir.join("soundfonts").join(&file)];
    // adj1013：**我的音色库目录**也算"有这个库"（用户自己下载/导入的那份）。
    // 放在最后 ⇒ 随包那份仍然优先（它一定存在），用户那份作为兜底/覆盖。
    if let Ok(app_data) = app.path().app_data_dir() {
        out.push(app_data.join("soundfonts").join(&file));
    }
    // adj1025：资源安装包那份（%LOCALAPPDATA%\iJipu\soundfonts）也要能读出来
    if let Some(res) = resource_soundfont_dir(app) {
        out.push(res.join(&file));
    }
    Ok(out)
}

/// adj416：探测内置音源是否存在——命中时返回其绝对路径，未随包提供返回 None。
/// 前端用它**在下载前**决定是否显示「正在下载音色库」提示：安装目录已有该文件就直接用。
#[tauri::command]
fn sf_soundfont_builtin_path(app: tauri::AppHandle, lib_id: String) -> Result<Option<String>, String> {
    for path in builtin_soundfont_candidates(&app, &lib_id)? {
        if path.exists() {
            return Ok(Some(path.display().to_string()));
        }
    }
    Ok(None)
}

/// 读内置高质量音源资源（打包进桌面的 SF2/SF3，来自 bundle.resources，adj346/adj416）。
/// 返回**原始字节**：`tauri::ipc::Response` 走 raw body（大响应走 fetch 通道），
/// 前端拿到 ArrayBuffer——30MB 若按 JSON 数组序列化会膨胀数倍且极慢（E-2026-146）。
/// 未随包提供时返回 Err（前端回退联网下载）。
#[tauri::command]
fn sf_soundfont_resource_read(
    app: tauri::AppHandle,
    lib_id: String,
) -> Result<tauri::ipc::Response, String> {
    for path in builtin_soundfont_candidates(&app, &lib_id)? {
        if path.exists() {
            let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", path.display(), e))?;
            return Ok(tauri::ipc::Response::new(bytes));
        }
    }
    Err(format!("内置音源资源缺失: {}.sf2（未随包提供）", lib_id))
}

// ============================================================================
// adj1013：音色库**发现**（扫描目录 + 读文件头 + 导入到"我的音色库目录"）
//
// 用户口径（2026-10-21）：「不预设用哪个音色库 —— 保证有一个基础库，其余靠发现本机文件 +
// 推荐下载 + 手动导入」。于是桌面端需要回答三个新问题：
//   ① 安装目录/我的音色库目录里**有什么** `.sf2`（原来只能按已知 id 查"在不在"）；
//   ② 这个文件**是什么库**（只读文件头拿 INAM，不读采样）；
//   ③ 用户选的库文件**存到哪**（`%APPDATA%\<app>\soundfonts\` —— 安装目录只读，
//      而且放这里卸载不会删用户自己的音源）。
//
// ⚠ SF2 的 `pdta`（音色表）在**文件尾部**，所以"音色列表"要读全量；扫描阶段刻意**不读**，
// 只读头 256 KB。音色表由前端在该库**首次被选中**时读一次再缓存（见 SOUNDBANK-PAGE-PLAN.md §4.2）。
// ============================================================================

/// 扫描结果的一项（只含"看一眼就有"的信息）
#[derive(serde::Serialize)]
pub struct ScannedSoundfont {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
    /// `install` = 安装目录（只读、随包）；`appdata` = 我的音色库目录（可写、卸载不删）
    pub origin: String,
}

/// 读头结果（供前端解析 INAM + 算**与全量导入同口径**的指纹；**不含采样数据**）
#[derive(serde::Serialize)]
pub struct SoundfontPeek {
    pub file_name: String,
    pub size_bytes: u64,
    /// 文件前 `min(size, 64 KB)` 字节（INFO/INAM 在这里）
    pub head: Vec<u8>,
    /// 文件后 `min(size, 64 KB)` 字节 —— 指纹要"头尾同样采样"，
    /// 否则"扫描到的文件"与"导入同一文件"会算成两个库（见前端 `fingerprintOfParts`）
    pub tail: Vec<u8>,
}

/// 只读头/尾各 64 KB：SF2 的 `LIST INFO` 在最前面，`pdta`（音色表）在最后面。
/// 这两个窗口刚好是前端指纹的采样窗口（`FP_WINDOW = 65536`）——**两处必须一致**。
const SF_HEAD_MAX: usize = 64 * 1024;
/// 导入体积上限（防手滑选到超大文件把磁盘写满）：512 MB
const SF_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// 库 id 白名单（`generaluser_gs` / `imported_ab12cd34` / `fluidr3_gm`）。
/// **绝不能含路径分隔符或 `..`** —— 它会被拼进文件名。
fn valid_lib_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err(format!("库 id 长度非法（{}）", id.len()));
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Err(format!("库 id 只允许小写字母/数字/下划线：{id}"));
    }
    Ok(())
}

/// 只认 `.sf2` / `.sf3`（大小写都行）。**这是文件白名单**：其它扩展名一律不读不写。
fn is_sf_name(p: &Path) -> bool {
    matches!(
        p.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("sf2") | Some("sf3")
    )
}

/// 我的音色库目录（可写）：`<app_data>/soundfonts`
fn user_soundfont_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("soundfonts"))
}

/// 把一个目录里的音色库文件追加进结果（目录不存在/无权限 ⇒ 静默跳过，**不报错**：
/// 首次安装时 `我的音色库目录` 本来就不存在，报错会把面板变成红字）。
fn scan_dir_into(dir: &Path, origin: &str, out: &mut Vec<ScannedSoundfont>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let p = entry.path();
        if !is_sf_name(&p) || !p.is_file() {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let mtime_ms = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(ScannedSoundfont {
            path: p.display().to_string(),
            file_name: entry.file_name().to_string_lossy().into_owned(),
            size_bytes: md.len(),
            mtime_ms,
            origin: origin.to_string(),
        });
    }
}

/// 扫描四处：安装目录根、安装目录 `soundfonts/`、我的音色库目录、资源安装包目录。
///
/// 前端拿到结果后按**内容**认库（引擎 `readSf2Info` + 指纹），文件名只做兜底显示。
#[tauri::command]
fn sf_soundfont_scan(app: tauri::AppHandle) -> Result<Vec<ScannedSoundfont>, String> {
    let mut out = Vec::new();
    let install = app.path().resource_dir().map_err(|e| e.to_string())?;
    scan_dir_into(&install, "install", &mut out);
    scan_dir_into(&install.join("soundfonts"), "install", &mut out);
    scan_dir_into(&user_soundfont_dir(&app)?, "appdata", &mut out);
    // adj1025：资源安装包（%LOCALAPPDATA%\iJipu\soundfonts）—— 独立来源，界面单独报数
    if let Some(dir) = resource_soundfont_dir(&app) {
        scan_dir_into(&dir, "resource", &mut out);
    }
    out.sort_by(|a, b| a.origin.cmp(&b.origin).then(a.file_name.cmp(&b.file_name)));
    Ok(out)
}

/// 只读文件前 `max` 字节（按需读，**不按文件大小分配内存**）
fn read_head(p: &Path, max: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let f = std::fs::File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let mut buf = Vec::with_capacity(max.min(64 * 1024));
    f.take(max as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(buf)
}

/// 只读文件**后** `max` 字节（从末尾往前定位；不读中间那几十上百 MB）
fn read_tail(p: &Path, max: usize) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let len = f.metadata().map_err(|e| format!("{}: {e}", p.display()))?.len();
    let take = max.min(len as usize);
    if take == 0 {
        return Ok(Vec::new());
    }
    f.seek(SeekFrom::End(-(take as i64)))
        .map_err(|e| format!("{}: {e}", p.display()))?;
    let mut buf = Vec::with_capacity(take);
    f.take(take as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(buf)
}

/// 读文件头 + 文件尾（前端据此认库、算指纹；`.sf2/.sf3` 之外的扩展名一律拒）。
#[tauri::command]
fn sf_soundfont_peek(path: String) -> Result<SoundfontPeek, String> {
    let p = PathBuf::from(&path);
    if !is_sf_name(&p) {
        return Err("只接受 .sf2 / .sf3 文件".into());
    }
    let md = std::fs::metadata(&p).map_err(|e| format!("{path}: {e}"))?;
    if !md.is_file() {
        return Err(format!("不是文件：{path}"));
    }
    let head = read_head(&p, SF_HEAD_MAX)?;
    let tail = read_tail(&p, SF_HEAD_MAX)?;
    let file_name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    Ok(SoundfontPeek {
        file_name,
        size_bytes: md.len(),
        head,
        tail,
    })
}

/// 把用户选的文件**复制**进"我的音色库目录"（`<app_data>/soundfonts/<id>.sf2`）。
///
/// 为什么不走 IPC 传字节：SF2 有 32–141 MB，按 JSON 数组传会膨胀数倍且极慢（E-2026-146）；
/// 这里只传**源路径**，Rust 直接 `fs::copy`（不占前端内存）。
#[tauri::command]
fn sf_soundfont_store(app: tauri::AppHandle, id: String, source: String) -> Result<String, String> {
    valid_lib_id(&id)?;
    let src = PathBuf::from(&source);
    if !is_sf_name(&src) {
        return Err("只接受 .sf2 / .sf3 文件".into());
    }
    let md = std::fs::metadata(&src).map_err(|e| format!("{source}: {e}"))?;
    if !md.is_file() {
        return Err(format!("不是文件：{source}"));
    }
    if md.len() == 0 {
        return Err("文件是空的（下载可能没完成）".into());
    }
    if md.len() > SF_MAX_BYTES {
        return Err(format!(
            "文件太大（{} MB，上限 512 MB）",
            md.len() / 1_000_000
        ));
    }
    let dir = user_soundfont_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{id}.sf2"));
    std::fs::copy(&src, &dest).map_err(|e| format!("写入 {} 失败：{e}", dest.display()))?;
    Ok(dest.display().to_string())
}

/// 删除"我的音色库目录"里的某个库文件（**只删这一处**；安装目录的随包文件永远不动）。
#[tauri::command]
fn sf_soundfont_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    valid_lib_id(&id)?;
    let p = user_soundfont_dir(&app)?.join(format!("{id}.sf2"));
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(())
}

/// 下载地址白名单：只允许 http(s)。
///
/// 为什么单独写：这个地址会被直接交给 `curl` 执行，**不能**让 `file://` / `-o` 之类的注入进来
/// （虽然 Tauri 命令只有本应用能调，但"能把任意本地文件读成音源"是不必要的攻击面）。
fn valid_download_url(url: &str) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) {
        return Err("下载地址必须是 http(s) 开头".into());
    }
    if u.contains(char::is_whitespace) {
        return Err("下载地址里不能有空白字符".into());
    }
    Ok(())
}

/// adj1021：**桌面端自己下载**音色库（绕过浏览器 CORS），落到"我的音色库目录"。
///
/// 为什么不在 WebView 里 `fetch`：多数音源站不返回 `Access-Control-Allow-Origin`，
/// 浏览器会直接拦死（FluidR3 的 SourceForge 页就是 HTML，连文件流都不是）。
/// 桌面端用系统 `curl`（Win10+ 自带）下载，不受 CORS 限制，还能边下边发进度。
///
/// 落点：`<app_data>/soundfonts/<id>.part` → 成功后改名为 `<id>.sf2`
/// （先写 `.part`：中途失败/被杀不会留下一个"看起来完整"的半截音源）。
#[tauri::command]
async fn sf_soundfont_download(
    app: tauri::AppHandle,
    id: String,
    url: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || download_bank_blocking(&app, &id, &url))
        .await
        .map_err(|e| format!("下载任务异常：{e}"))?
}

fn download_bank_blocking(app: &tauri::AppHandle, id: &str, url: &str) -> Result<String, String> {
    valid_lib_id(id)?;
    valid_download_url(url)?;
    let dir = user_soundfont_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(format!("{id}.sf2"));
    let part = dir.join(format!("{id}.sf2.part"));
    let _ = std::fs::remove_file(&part);

    // `curl` 在 Windows 10 1803+ 自带；没有时明确报错（前端会回退到浏览器下载/下载页）
    let mut child = std::process::Command::new("curl.exe")
        .args(["-L", "--fail", "--silent", "--show-error", "-o"])
        .arg(&part)
        .arg(url.trim())
        .spawn()
        .map_err(|e| format!("调不起系统 curl（{e}）；可用「下载页」手动下载后导入"))?;

    // 每 250ms 把"已收字节"发给前端（总大小前端知道，用于百分比）
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    let _ = std::fs::remove_file(&part);
                    return Err(format!(
                        "下载失败（curl 退出码 {:?}）；可点「下载页」手动下载后导入",
                        status.code()
                    ));
                }
                break;
            }
            Ok(None) => {
                let got = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
                let _ = app.emit(
                    "ijipu://sf-download",
                    serde_json::json!({ "id": id, "bytes": got }),
                );
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            Err(e) => {
                let _ = std::fs::remove_file(&part);
                return Err(format!("等待 curl 失败：{e}"));
            }
        }
    }
    if !part.exists() {
        return Err("下载没有产生文件（地址可能不是文件流）".into());
    }
    let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        let _ = std::fs::remove_file(&part);
        return Err("下载到的文件是空的".into());
    }
    std::fs::rename(&part, &dest).map_err(|e| format!("改名失败：{e}"))?;
    Ok(dest.display().to_string())
}

/// adj1020：打开"我的音色库目录"（不存在就建）。
///
/// 为什么需要它：去掉随包音色库之后，用户最常见的动作是"把 .sf2 拖进那个目录再重新扫描"，
/// 而 `%APPDATA%\<app>\soundfonts` 对普通用户来说并不好找。
#[tauri::command]
fn sf_soundfont_open_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = user_soundfont_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

// ============================================================================
// adj568：桌面端「工作区」——原生选文件夹 + 按路径读写
//
// 为什么桌面端要另起一套（而不是继续用网页版的 File System Access）：
// Chromium 把「下载 / 桌面 / 文档 / 用户主目录」**整个目录**列进了敏感目录黑名单
// （`chrome_file_system_access_permission_context.cc` 的 `GenerateBlockPaths()`，
// BlockType = kDontBlockChildren ⇒ **只有该目录自身被封，子文件夹放行**），
// 于是"把「下载」直接设为工作区"必然被拒。更麻烦的是：
//   ① 该拦截**没有 API 可绕过**，网页层无法覆盖；
//   ② 抛出的错误是 **AbortError —— 与"用户点了取消"完全同一个错误**，
//      前端因此无法区分、只能静默（用户只看到浏览器弹框，App 一声不响）。
// 桌面壳里我们本就不受这条 **Web** 安全策略约束（用户在自己的电脑上显式选自己的目录），
// 所以直接用原生选择器拿**磁盘路径**，读写交给 Rust 侧的 `std::fs`。
// 附带好处：桌面端不再有"重开应用要重新授权目录"这一步。
//
// 安全口径不变：**所有相对段都在 Rust 侧再校验一次**（`check_ws_seg`），
// 前端 `normalizeRelPath` 不是唯一防线；写入同样**回读校验**（与 FSA 分支、`write_external_file` 一致）。
//
// ⚠ 这些命令一律写成 `#[tauri::command(async)]`：Tauri 的**同步命令跑在主线程上**，
// 而"列目录"在一次工作区扫描里会被调用几百次（还带并发）⇒ 同步实现会把整个窗口卡住、
// 并发也退化成串行。标 `async` 后 Tauri 把它们丢进线程池执行（函数体里是阻塞的 `std::fs`，正合适）。
// ============================================================================

/// 工作区目录里的一项（前端 `DirEntry` 的镜像；`mtime` 供"新的在上"排序用）
#[derive(serde::Serialize)]
struct WsEntry {
    name: String,
    /// 是否目录（`dir` 而非 `is_dir`：与前端 `DirEntry.kind` 的分流更直观）
    dir: bool,
    /// 修改时间（Unix 毫秒；取不到时为 0）
    mtime: u64,
}

/// 校验一段相对路径：非空、不是 `.` / `..`、不含路径分隔符与控制字符。
///
/// 前端 `normalizeRelPath()` 已经规整过一次，这里**必须再挡一次**——Rust 这侧拿到的是
/// 普通字符串，拼接前不校验的话一个 `..` 就能越出工作区；前端那道防线不该是唯一一道。
fn check_ws_seg(seg: &str) -> Result<(), String> {
    let bad = seg.is_empty()
        || seg == "."
        || seg == ".."
        || seg.contains('/')
        || seg.contains('\\')
        || seg.contains('\0');
    if bad {
        return Err(format!("非法路径段：{}", seg));
    }
    Ok(())
}

/// 工作区根 + 相对段 ⇒ 绝对路径（逐段校验，防路径穿越）
fn ws_path(root: &str, segs: &[String]) -> Result<PathBuf, String> {
    let mut p = PathBuf::from(root);
    for s in segs {
        check_ws_seg(s)?;
        p.push(s);
    }
    Ok(p)
}

/// 列目录——**刻意不过滤**（隐藏项 / 扩展名的口径留给前端，与 FSA 分支完全一致，
/// 免得两套后端对"什么该显示"出现分歧）。单条读元数据失败就跳过该条，不让整个列表失败。
#[tauri::command(async)]
fn ws_list_dir(root: String, segs: Vec<String>) -> Result<Vec<WsEntry>, String> {
    let dir = ws_path(&root, &segs)?;
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    let mut out: Vec<WsEntry> = Vec::new();
    for item in rd.flatten() {
        let Ok(meta) = item.metadata() else { continue };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(WsEntry {
            name: item.file_name().to_string_lossy().to_string(),
            dir: meta.is_dir(),
            mtime,
        });
    }
    Ok(out)
}

/// 目录是否存在——工作区根被外部删掉/改名时，前端据此提示"目录已不在"而不是空列表
#[tauri::command(async)]
fn ws_dir_exists(root: String, segs: Vec<String>) -> bool {
    ws_path(&root, &segs).map(|p| p.is_dir()).unwrap_or(false)
}

/// 目录是否**完全为空**（判"空目录"必须列全部条目，不能只看 `.jps`——与 FSA 分支同口径）
#[tauri::command(async)]
fn ws_is_dir_empty(root: String, segs: Vec<String>) -> Result<bool, String> {
    let dir = ws_path(&root, &segs)?;
    let mut rd = std::fs::read_dir(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    Ok(rd.next().is_none())
}

/// 读一个文件的文本
#[tauri::command(async)]
fn ws_read_text(root: String, segs: Vec<String>) -> Result<String, String> {
    let p = ws_path(&root, &segs)?;
    std::fs::read_to_string(&p).map_err(|e| format!("{}: {}", p.display(), e))
}

// ============================================================================
// adj965（方案 docs/OVERLAY-PLAN.md「OVL」§四.1）：读「水印 / 背景图」的原始字节
//
// 为什么必须在 Rust 侧读：桌面端**双击打开**的 `.jps` 前端只拿到一串绝对路径（`nativePath`），
// 而 WebView 侧没有任何"按绝对路径读文件"的能力（既有的 `ws_read_text` 要求"工作区根 + 相对段"）。
//
// 安全边界（**两个命令共用**，见方案 §八.10）：
//   · 只接受**图片扩展名**（png/jpg/jpeg/webp/gif/bmp）——`svg` 明确排除（SVG 可内嵌脚本）；
//   · 单文件 ≤ 16MB（超过它当背景基本也糊，且会让每页 SVG 巨大）；
//   · 返回 `tauri::ipc::Response`（原始字节，照 `sf_soundfont_resource_read` 的写法），
//     不经 JSON/base64 ⇒ 不额外膨胀 33%。前端拿到 `ArrayBuffer`（既有消费先例见 spessaSynthBackend）。
//
// `.jps` 是纯文本、可能来自别人 ⇒ 这两条边界就是"不让一句路径把任意文件读进来当图"的闸门。
// ============================================================================

/// 图片资源的字节上限（与前端 `assetSource.ts` 的 `MAX_ASSET_BYTES` **同一口径**，改一处要改两处）
const ASSET_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// 读一张图片资源（扩展名白名单 + 大小上限都在这里判，两个命令共用）
fn read_asset_bytes(p: &std::path::Path) -> Result<tauri::ipc::Response, String> {
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp") {
        return Err(format!(
            "只接受图片扩展名（png/jpg/jpeg/webp/gif/bmp）：{}",
            p.display()
        ));
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("{}: {}", p.display(), e))?;
    if meta.len() > ASSET_MAX_BYTES {
        return Err(format!(
            "图片太大（超过 {}MB）：{}",
            ASSET_MAX_BYTES / 1024 / 1024,
            p.display()
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("{}: {}", p.display(), e))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 按**绝对路径**读一张图片（桌面端双击打开 `.jps` 的那条路：前端只有 `nativePath`）
#[tauri::command(async)]
fn read_asset_file(path: String) -> Result<tauri::ipc::Response, String> {
    read_asset_bytes(std::path::Path::new(&path))
}

/// 按**工作区相对路径**读一张图片（桌面端"工作区"那条路；路径穿越校验复用 `ws_path`）
#[tauri::command(async)]
fn ws_read_binary(root: String, segs: Vec<String>) -> Result<tauri::ipc::Response, String> {
    let p = ws_path(&root, &segs)?;
    read_asset_bytes(&p)
}

/// 写一个文件并**回读校验**——与 FSA 分支、`write_external_file` 同一口径：
/// 宁可如实报失败，也绝不谎报"已保存"。
#[tauri::command(async)]
fn ws_write_text(root: String, segs: Vec<String>, text: String) -> Result<(), String> {
    let p = ws_path(&root, &segs)?;
    // 与 FSA 分支同口径：FSA 那条路 `getFileHandle(..., {create:true})` 会**顺带建出缺失的父目录**，
    // 桌面这条若只 `fs::write` 就会在"另存到子目录"时直接失败 ⇒ 这里显式补上，保持两套后端行为一致。
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {}", parent.display(), e))?;
    }
    std::fs::write(&p, &text).map_err(|e| format!("{}: {}", p.display(), e))?;
    let back = std::fs::read_to_string(&p).map_err(|e| format!("回读失败 {}: {}", p.display(), e))?;
    if back != text {
        return Err("写入后回读内容与预期不一致".to_string());
    }
    Ok(())
}

/// 写二进制文件（乐谱包 assets 解压）——与 `ws_write_text` 同样的父目录补建 + 回读校验。
#[tauri::command(async)]
fn ws_write_binary(root: String, segs: Vec<String>, base64: String) -> Result<(), String> {
    let p = ws_path(&root, &segs)?;
    let bytes = crate::b64::decode(&base64).ok_or_else(|| "不是合法 base64".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {}", parent.display(), e))?;
    }
    std::fs::write(&p, &bytes).map_err(|e| format!("{}: {}", p.display(), e))?;
    let back = std::fs::read(&p).map_err(|e| format!("回读失败 {}: {}", p.display(), e))?;
    if back != bytes {
        return Err("写入后回读内容与预期不一致".to_string());
    }
    Ok(())
}

/// 新建目录（同名已存在 ⇒ 返回 `EXISTS` 交给前端提示，不静默复用）
#[tauri::command(async)]
fn ws_create_dir(root: String, segs: Vec<String>) -> Result<(), String> {
    let p = ws_path(&root, &segs)?;
    if p.exists() {
        return Err("EXISTS".to_string());
    }
    std::fs::create_dir(&p).map_err(|e| format!("{}: {}", p.display(), e))
}

/// 删除一个文件
#[tauri::command(async)]
fn ws_remove_file(root: String, segs: Vec<String>) -> Result<(), String> {
    let p = ws_path(&root, &segs)?;
    std::fs::remove_file(&p).map_err(|e| format!("{}: {}", p.display(), e))
}

/// 删除一个**空**目录（非空 ⇒ 返回 `NOT_EMPTY`）
///
/// 为什么不做递归删除（与 FSA 分支同一理由）：工作区是用户自己的文件夹，
/// 里面可能混着照片/文档等**非 `.jps`** 的东西，`remove_dir_all` 会一起抹掉，**且没有回收站**。
#[tauri::command(async)]
fn ws_remove_empty_dir(root: String, segs: Vec<String>) -> Result<(), String> {
    let p = ws_path(&root, &segs)?;
    let mut rd = std::fs::read_dir(&p).map_err(|e| format!("{}: {}", p.display(), e))?;
    if rd.next().is_some() {
        return Err("NOT_EMPTY".to_string());
    }
    std::fs::remove_dir(&p).map_err(|e| format!("{}: {}", p.display(), e))
}

/// 原生「选文件夹」（adj568）——返回绝对路径；用户取消 ⇒ `None`。
///
/// 必须放在 `spawn_blocking` 里等：`blocking_pick_folder()` 是**阻塞**调用，
/// 直接在命令线程（主线程）上等会让窗口假死。
#[tauri::command]
async fn ws_pick_dir(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择工作区文件夹")
            .blocking_pick_folder()
    })
    .await
    .ok()
    .flatten()
    .and_then(|fp| fp.as_path().map(|p| p.to_string_lossy().into_owned()))
}

/// adj1156（用户 2026-10-25 实报「桌面壳里保存 sidecar 跑到下载目录」）：
/// 桌面壳的「打开」必须走**原生文件对话框**，拿到真实绝对路径（`nativePath`）。
///
/// 在此之前 Ctrl+O 走的是 WebView2 的 `showOpenFilePicker()`：拿到的只是浏览器文件句柄，
/// 桌面壳**不知道它在哪个目录**，于是 sidecar 只能降级成"下载一份"。
#[tauri::command]
async fn pick_jps_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("打开乐谱")
            .add_filter("iJipu 乐谱", &["jps"])
            .blocking_pick_file()
    })
    .await
    .ok()
    .flatten()
    .and_then(|fp| fp.as_path().map(|p| p.to_string_lossy().into_owned()))
}

/// adj1157（用户 2026-10-25 实报「刷新后每次都找不到伴奏」）：
/// 桌面壳的「选择伴奏」也走**原生文件对话框**，拿真实绝对路径 —— 这样 sidecar 能记住
/// "伴奏到底在哪"，下次刷新按路径自动读，不再只靠"和 .jps 同目录"猜。
#[tauri::command]
async fn pick_audio_file(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择伴奏")
            .add_filter("音频", &["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "webm"])
            .blocking_pick_file()
    })
    .await
    .ok()
    .flatten()
    .and_then(|fp| fp.as_path().map(|p| p.to_string_lossy().into_owned()))
}

/// adj1181（用户 2026-11-02 追问「本机字体列表依据什么选、为什么没有我要的字体」）：
/// 列出系统已安装字体族，供卡片风格「本机字体」下拉使用。
///
/// 为什么走 GDI 而不是只靠 WebView 的 `queryLocalFonts()`：后者是实验性 API，
/// 在部分 WebView2 里不可用/被拒绝；GDI 是系统自带、无需新增 crate
/// （`windows-sys` 已在依赖树，本轮只加 `Win32_Graphics_Gdi` feature）。
/// 返回的是**字体族名**（中文系统下常见「微软雅黑 / 宋体 / 楷体」这类名字），前端直接当
/// `font-family` 用；`@` 开头的竖排别名去重。
#[cfg(windows)]
#[tauri::command]
fn list_system_fonts() -> Result<Vec<String>, String> {
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::{
        EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
    };

    unsafe extern "system" fn collect(
        lf: *const LOGFONTW,
        _tm: *const TEXTMETRICW,
        _font_type: u32,
        lparam: LPARAM,
    ) -> i32 {
        if lf.is_null() {
            return 1;
        }
        let face = &(*lf).lfFaceName;
        let end = face.iter().position(|&c| c == 0).unwrap_or(face.len());
        if end > 0 {
            let name = String::from_utf16_lossy(&face[..end]);
            // '@' 开头是竖排字体（同一族的另一份），列表里不要重复
            if !name.starts_with('@') {
                let out = &mut *(lparam as *mut Vec<String>);
                out.push(name);
            }
        }
        1
    }

    let dc = unsafe { GetDC(std::ptr::null_mut()) };
    if dc.is_null() {
        return Err("拿不到屏幕 DC".to_string());
    }
    let mut lf = LOGFONTW::default();
    lf.lfCharSet = DEFAULT_CHARSET;
    let mut names: Vec<String> = Vec::new();
    unsafe {
        EnumFontFamiliesExW(dc, &lf, Some(collect), &mut names as *mut _ as LPARAM, 0);
        ReleaseDC(std::ptr::null_mut(), dc);
    }
    names.sort();
    names.dedup();
    Ok(names)
}

/// 非 Windows 目标（Android 等）没有 GDI：返回空表，前端会退回浏览器 `queryLocalFonts`/手打。
#[cfg(not(windows))]
#[tauri::command]
fn list_system_fonts() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

/// adj1183（用户 2026-11-02）：「桌面壳导出后无提示，建议添加导出成功的提示，并提示打开文件/文件夹」。
///
/// 原生「另存为 MP4」：对话框 → 写字节 → 回读长度校验 → 返回绝对路径。
/// 前端拿到路径后弹成功提示，并提供「打开文件 / 打开文件夹」两个动作。
#[tauri::command]
async fn save_mp4_file(
    app: tauri::AppHandle,
    name: String,
    b64: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("保存视频")
            .set_file_name(&name)
            .add_filter("MP4 视频", &["mp4"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(fp) = picked else {
        return Ok(None); // 用户取消
    };
    let mut p = fp
        .as_path()
        .ok_or_else(|| "保存对话框没有返回本地路径".to_string())?
        .to_path_buf();
    if p.extension().is_none() {
        p.set_extension("mp4");
    }
    let bytes = crate::b64::decode(&b64).ok_or_else(|| "视频数据不是合法 base64".to_string())?;
    std::fs::write(&p, &bytes).map_err(|e| format!("{}: {}", p.display(), e))?;
    let back = std::fs::metadata(&p).map_err(|e| format!("回读失败 {}: {}", p.display(), e))?;
    if back.len() != bytes.len() as u64 {
        return Err("写入后文件长度与预期不一致".to_string());
    }
    Ok(Some(p.to_string_lossy().into_owned()))
}

/// adj1183：打开刚导出的文件，或在资源管理器里定位它（reveal=true）。
///
/// 走 `tauri-plugin-opener` 的 Rust API（不经过前端 scope 检查）；路径只来自我们自己的保存对话框。
#[tauri::command]
fn open_local_path(app: tauri::AppHandle, path: String, reveal: bool) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if reveal {
        app.opener()
            .reveal_item_in_dir(path.as_str())
            .map_err(|e| e.to_string())
    } else {
        app.opener()
            .open_path(path, None::<&str>)
            .map_err(|e| e.to_string())
    }
}

/// adj1158（用户 2026-10-25 口径：操作要简单统一）：
/// 桌面壳「另存为」也走**原生保存对话框**，并在同一个命令里写盘 + 回读校验。
///
/// 为什么不能只返回路径让前端用 FSA 写：FSA 的 `showSaveFilePicker` 同样拿不到真实路径，
/// 存完 sidecar 又要"重新打开一次"——这正是用户说"太复杂"的那一步。这里一次做完：
/// 对话框 → 写盘 → 回读校验 → 返回绝对路径（前端据此设置 `nativePath`）。
#[tauri::command]
async fn save_jps_file(
    app: tauri::AppHandle,
    name: String,
    text: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("另存为")
            .set_file_name(&name)
            .add_filter("iJipu 乐谱", &["jps"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(fp) = picked else {
        return Ok(None); // 用户取消
    };
    let mut p = fp
        .as_path()
        .ok_or_else(|| "保存对话框没有返回本地路径".to_string())?
        .to_path_buf();
    // 用户在对话框里只写了名字、没写扩展名 ⇒ 补 .jps（与另存为的默认名同口径）
    if p.extension().is_none() {
        p.set_extension("jps");
    }
    std::fs::write(&p, &text).map_err(|e| format!("{}: {}", p.display(), e))?;
    let back = std::fs::read_to_string(&p).map_err(|e| format!("回读失败 {}: {}", p.display(), e))?;
    if back != text {
        return Err("写入后回读内容与预期不一致".to_string());
    }
    Ok(Some(p.to_string_lossy().into_owned()))
}

/// adj539：桌面端**不使用** Service Worker（前端资源随二进制内嵌，见 `src/main.tsx` 的 adj443 决定）。
///
/// 但**历史版本注册过的 SW 会跨版本存活在 WebView2 用户数据目录里**（实测：`com.ijipu.app\EBWebView\
/// Default\Service Worker\CacheStorage` 下堆了十几份 index.html，最早可追到 2026-09-13）。它会：
///   ① 在 SW 上下文里 fetch Tauri 自定义协议（拿不到，浏览器还会报
///      "cross-world service worker resource mismatch"）→ 回退到**缓存的旧 index.html**；
///   ② 旧 index.html 引用的 `/assets/<旧 hash>.js` 在新安装里已不存在 → Tauri 资源协议对未知路径
///      回 index.html（HTTP 200 + `text/html`）→ 模块脚本 MIME 校验失败 ⇒ **整个前端加载失败 = 白屏**。
/// 致命之处：`main.tsx` 里"卸载旧 SW + 清缓存"的补救代码**就在页面 JS 里**，而页面 JS 恰恰被这个 SW
/// 挡住 ⇒ 自我修复永远跑不到（死锁）。因此必须在 **webview 启动之前**从进程外清掉它的存储。
///
/// 只删 `Service Worker`（纯缓存），**不动** `Local Storage` / `IndexedDB` —— 用户设置、草稿、
/// 音色库缓存都在后者里，删了等于把用户数据清了。
fn purge_stale_service_worker(app_local_dir: &Path) {
    let sw = app_local_dir
        .join("EBWebView")
        .join("Default")
        .join("Service Worker");
    if !sw.is_dir() {
        return;
    }
    match std::fs::remove_dir_all(&sw) {
        Ok(()) => println!("[iJipu] 已清理遗留的 Service Worker 存储：{}", sw.display()),
        // 失败不致命：下次启动再试（例如目录被另一个实例占用）
        Err(e) => eprintln!("[iJipu] 清理 Service Worker 存储失败（忽略）：{}", e),
    }
}

/**
 * adj1084：出片窗口的三条命令（只在该窗口里有意义，普通窗口调用会被 `cli_video` 拒绝）。
 *
 * 为什么不合成一条"导出并返回字节"的命令：MP4 动辄几十上百 MB，
 * 一次性跨 IPC 传会先复制好几份；这里改成"**分块写盘**"，内存占用只有一块。
 */
#[tauri::command]
fn cli_video_job() -> Option<String> {
    cli_video::job_json()
}

#[tauri::command]
fn cli_video_write(path: String, b64: String, append: bool) -> Result<(), String> {
    cli_video::write_chunk(&path, &b64, append)
}

#[tauri::command]
fn cli_video_progress(p: f64, phase: String) {
    cli_video::write_progress(p, &phase)
}

#[tauri::command]
fn cli_video_result(app: tauri::AppHandle, ok: bool, bytes: u64, audio: bool, message: String) {
    cli_video::write_result(ok, bytes, audio, &message);
    app.exit(if ok { 0 } else { 1 });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // adj539：必须在 webview 起来之前清（否则旧 SW 已经抢先把页面喂成白屏）——见函数注释。
    // WebView2 的用户数据目录 = `%LOCALAPPDATA%\<identifier>\EBWebView`（identifier 取自配置，不写死）。
    // 上下文只构造一次：既用来取 identifier，也交给下面的 `.build()`；
    // 显式标注运行时类型——`Context<R>::config()` 需要 `R: Runtime`，不给标注时 rustc 无法推断（E0283）。
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    #[cfg(target_os = "windows")]
    {
        let identifier = context.config().identifier.clone();
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            purge_stale_service_worker(&PathBuf::from(local).join(identifier));
        }
    }
    // adj1084：先认"出片窗口"这个内部开关（见 `cli_video.rs`）。
    // 它要完整起 Tauri，但窗口隐藏、也不该被"单实例"插件转交给在跑的界面窗口。
    cli_video::init_from_args();
    // adj1084：出片窗口**不注册单实例插件** —— 它是 CLI 起的独立子进程，
    // 若被转交给正在运行的界面窗口，父进程会立刻拿到"子进程退出"而误判失败。
    let mut builder = tauri::Builder::default();
    if !cli_video::is_worker() {
        builder = builder
        // adj538：单实例插件**必须第一个注册**（插件按注册顺序执行；官方 README 要求）。
        // 作用：应用已在运行时再次双击 `.jps`，不再启动第二个进程，而是走这个回调——
        // 把窗口置前，并把文件路径入队通知前端打开。不做这一步就会出现"两个窗口、两份编辑状态"。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            queue_open_paths(app, jps_paths_from_string_args(argv));
        }));
    }
    builder
        // adj568：原生文件夹选择器（工作区）。同单实例插件：**只作 Rust 依赖**，
        // 我们用自己的 command 调它，故不需要 npm 包，也不需要补 ACL 权限。
        .plugin(tauri_plugin_dialog::init())
        // adj652：外部链接（预览里点了 `a.jp-link`）→ 交给系统默认浏览器。
        // 前端用 `core.invoke('plugin:opener|open_url', { url })` 调它（见 src/preview/openUrl.ts）。
        .plugin(tauri_plugin_opener::init())
        .manage(PendingOpen::default())
        /*
         * adj968（用户要求）：**把 `.jps` 从资源管理器拖进窗口就能打开**。
         *
         * 桌面端必须走**原生拖放事件**（不是网页的 HTML5 `drop`）：WebView2 默认由原生层接管拖放
         * （Tauri 的 `dragDropEnabled` 默认 `true`，本仓 `tauri.conf.json` 没写这一项 ⇒ 默认接管），
         * 页面里的 `dragover/drop` 在桌面端**收不到**。好在原生事件给的是**真实绝对路径** ⇒
         * 直接复用双击关联那条链（`queue_open_paths` 入队 + `ijipu://open-files` 通知前端）：
         * 于是它能写回原文件、能参与外部改动轮询，**不需要任何授权弹窗**，前端一行都不用改。
         *
         * 另外发一个 `ijipu://drag-hover`（带上要打开的文件名）给前端画"松开即打开 xxx.jps"的高亮层；
         * 拖走的瞬间（`Leave`）也发一次，避免高亮卡住。
         *（写成普通块注释而不是 `/** */`：链式调用位置上不接受文档注释，rustc 会报 E0585。）
         */
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(drag) = event {
                match drag {
                    tauri::DragDropEvent::Enter { paths, .. } => {
                        // 只把**认识的**类型说给用户听（拖进来的是图片/压缩包时不该说"松开即打开"）
                        let names: Vec<String> = paths
                            .iter()
                            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
                            .filter(|n| n.to_ascii_lowercase().ends_with(".jps"))
                            .collect();
                        let _ = window.app_handle().emit("ijipu://drag-hover", names.first().cloned());
                    }
                    tauri::DragDropEvent::Leave => {
                        let _ = window
                            .app_handle()
                            .emit("ijipu://drag-hover", Option::<String>::None);
                    }
                    tauri::DragDropEvent::Drop { paths, .. } => {
                        let _ = window
                            .app_handle()
                            .emit("ijipu://drag-hover", Option::<String>::None);
                        // 与双击关联**同一条链**：`.jps` 之外的路径由 `jps_paths_from_string_args` 过滤掉
                        let strs: Vec<String> = paths
                            .iter()
                            .map(|p| p.to_string_lossy().to_string())
                            .collect();
                        queue_open_paths(window.app_handle(), jps_paths_from_string_args(strs));
                    }
                    tauri::DragDropEvent::Over { .. } => {}
                    // `DragDropEvent` 标了 `#[non_exhaustive]`（上游将来可能加相位）⇒ 必须留通配臂
                    _ => {}
                }
            }
        })
        .setup(|app| {
            // 冷启动：双击 `.jps` 时路径就在本进程的命令行参数里（NSIS 写的是 `"ijipu.exe" "%1"`）。
            // v2 的 `Env` 默认已 manage（内容即 `std::env::args_os()`），用它避免非 UTF-8 参数 panic。
            queue_open_paths(app.handle(), jps_paths_from_os_args(app.env().args_os.clone()));
            // 窗口图标（用户 2026-11-11）：与「爱出片 iJipu CP」区分开。
            // 品牌图标（界面里的 logo）不变，只换窗口/任务栏图标；编译进 exe，不依赖安装目录里有没有 png。
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(icon) =
                    tauri::image::Image::from_bytes(include_bytes!("../../public/icons/Logo-jp.png"))
                {
                    let _ = w.set_icon(icon);
                }
            }
            // adj1084：出片窗口只干活、不给人看（前端跑完会自己退出）。
            // 隐藏而不是"不创建"：WebView2 里隐藏窗口照样能画离屏画布/编码。
            if cli_video::is_worker() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            // adj875：命令行能力宿主（命名管道）。**默认不开** —— 只有显式给了
            // `IJIPU_CLI_HOST=1` 或内部开关 `--cli-host` 才起 ⇒ 双击打开的现状行为一字不变 ✓。
            cli_host::start_if_enabled(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sf_cache_read,
            sf_cache_write,
            sf_cache_remove,
            sf_soundfont_builtin_path,
            sf_soundfont_resource_read,
            // adj1013：音色库"发现"——扫描目录 / 读文件头 / 复制进我的音色库目录 / 删除
            sf_soundfont_scan,
            sf_soundfont_peek,
            sf_soundfont_store,
            sf_soundfont_delete,
            sf_soundfont_download,
            sf_soundfont_open_dir,
            take_pending_open_files,
            write_external_file,
            // adj1128：对拍边车文件（`赤伶.jps.sync.json`）读写——**允许新建**
            sync_read_file,
            sync_write_file,
            // adj1154：按 sidecar 记的路径自动读伴奏（原始字节；扩展名/大小白名单）
            sync_read_audio,
            // adj966：按绝对路径读系统文件 + 取 mtime（外部改动检测的轮询 IO）
            read_native_probe,
            // adj568：桌面端工作区（原生选目录 + 按路径读写）
            ws_pick_dir,
            // adj1156：桌面壳「打开」走原生长路径（sidecar 才能写到 .jps 同目录）
            pick_jps_file,
            // adj1157：桌面壳选伴奏也拿真实路径（sidecar 记住位置，刷新自动读）
            pick_audio_file,
            // adj1158：桌面壳「另存为」原生保存（一次完成写盘 + 回读，设置 nativePath）
            save_jps_file,
            // adj1181：卡片风格「本机字体」列表（GDI 枚举系统字体族）
            list_system_fonts,
            // adj1183：导出视频成功提示 —— 原生保存 MP4 + 打开文件/文件夹
            save_mp4_file,
            open_local_path,
            ws_list_dir,
            ws_dir_exists,
            ws_is_dir_empty,
            ws_read_text,
            ws_write_text,
            ws_write_binary,
            // adj965：读水印/背景图的原始字节（绝对路径 + 工作区相对路径两条；含扩展名白名单与大小上限）
            read_asset_file,
            ws_read_binary,
            ws_create_dir,
            ws_remove_file,
            ws_remove_empty_dir,
            // adj944：注册/解除 iJipu CLI（把安装目录写进/摘出当前用户 PATH）
            cli_path::cli_path_status,
            cli_path::cli_path_register,
            cli_path::cli_path_unregister,
            // adj1084：命令行导出视频（隐藏出片窗口取任务 / 分块写盘 / 回报结果）
            cli_video_job,
            cli_video_write,
            cli_video_progress,
            cli_video_result,
            // adj1085：桌面壳本机配置（%APPDATA%\iJipu\settings.json）
            prefs::prefs_load,
            prefs::prefs_save,
            prefs::prefs_path,
            // adj1085：配置目录打开 + 卡片背景图等附件（P1 大图外置）
            prefs::prefs_open_dir,
            prefs::prefs_blob_write,
            prefs::prefs_blob_read,
            prefs::prefs_blob_delete,
            // adj957：`cli_manual::cli_manual_open` 已删除（命令行手册改走应用内 DocDialog）
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS/iOS 不用命令行参数传"要打开的文件"，而是这个事件（该变体在 Windows/Linux 上不存在，
            // 故必须 cfg 门控——直接写会编译不过）。
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            {
                if let tauri::RunEvent::Opened { urls } = event {
                    let paths: Vec<String> = urls
                        .iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .map(|p| p.display().to_string())
                        .collect();
                    queue_open_paths(app, paths);
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            {
                let _ = (app, event);
            }
        });
}

/**
 * adj965（方案 `docs/OVERLAY-PLAN.md`「OVL」EP-08）单测：读图命令的**安全边界**。
 *
 * 为什么值得有：这条边界是"`.jps` 是纯文本、可能来自别人"的唯一防线（方案 §八.10）——
 * 扩展名白名单与大小上限**只有真调一次才现形**（写错了照样能编译、UI 上也只是"图没出来"）。
 * 与 `cli_host.rs` 的管道测试同一个道理：**边界类的东西必须有真跑的判据**。
 */
#[cfg(test)]
mod asset_tests {
    use super::*;

    /// 写一个临时文件（内容随意；这里只测"读得出来/读不出来"，不测解码）
    fn tmp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ijipu-asset-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn accepts_allowed_image_extensions() {
        for ext in ["png", "jpg", "jpeg", "webp", "gif", "bmp", "PNG"] {
            let p = tmp_file(&format!("ok.{ext}"), &[1, 2, 3]);
            assert!(read_asset_bytes(&p).is_ok(), "{ext} 应当被接受");
        }
    }

    #[test]
    fn rejects_non_image_extensions() {
        // ⚠ `svg` 是**故意**排除的：SVG 能内嵌脚本，当"图片"塞进产物等于开了个投递通道
        for ext in ["svg", "exe", "jps", "txt", "png.exe"] {
            let p = tmp_file(&format!("no.{ext}"), &[1, 2, 3]);
            // 注意：`tauri::ipc::Response` **没有实现 `Debug`** ⇒ 不能用 `unwrap_err()`，
            // 只能走 `.err()`（这样也不要求 Ok 类型可 Debug）
            let e = read_asset_bytes(&p).err().expect("应当被拒");
            assert!(e.contains("只接受图片扩展名"), "{ext} 应当被拒：{e}");
        }
        // 没有扩展名也要拒
        let p = tmp_file("noext", &[1]);
        assert!(read_asset_bytes(&p).is_err());
    }

    #[test]
    fn rejects_oversized_and_missing() {
        // 造一个超过上限的文件（只写够上限+1 字节；用 set_len 免得真占 16MB 内存）
        let p = tmp_file("big.png", &[]);
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_len(ASSET_MAX_BYTES + 1).unwrap();
        drop(f);
        let e = read_asset_bytes(&p).err().expect("应当报太大");
        assert!(e.contains("图片太大"), "应当报太大：{e}");

        let missing = std::env::temp_dir().join("ijipu-asset-does-not-exist.png");
        let _ = std::fs::remove_file(&missing);
        assert!(read_asset_bytes(&missing).is_err());
    }
}

/// adj1013：音色库"发现"那一组命令的纯逻辑单测（不碰 Tauri 运行时）。
#[cfg(test)]
mod soundfont_tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ijipu-sf-test-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 库 id 会被拼进文件名 ⇒ 必须**挡掉路径分隔符与 `..`**（这是本条命令的安全边界）
    #[test]
    fn lib_id_must_be_filename_safe() {
        for ok in ["generaluser_gs", "fluidr3_gm", "imported_ab12cd34"] {
            assert!(valid_lib_id(ok).is_ok(), "{ok} 应当被接受");
        }
        for bad in ["", "../x", "a/b", "a\\b", "ABC", "a-b", "a b", ".."] {
            assert!(valid_lib_id(bad).is_err(), "{bad} 应当被拒");
        }
        assert!(valid_lib_id(&"a".repeat(65)).is_err(), "超长应当被拒");
    }

    #[test]
    fn only_sf2_sf3_are_accepted() {
        for ok in ["a.sf2", "a.SF2", "a.sf3", "a.SF3", "FluidR3_GM.sf2"] {
            assert!(is_sf_name(Path::new(ok)), "{ok} 应当被接受");
        }
        for bad in ["a.txt", "a.sf2.exe", "a", "a.js", "a.sf2.bak"] {
            assert!(!is_sf_name(Path::new(bad)), "{bad} 应当被拒");
        }
    }

    /// 只读头必须真的"只读头"——否则扫描目录会把 141 MB 整个读进内存
    #[test]
    fn head_read_is_capped() {
        let d = tmp_dir("head");
        let p = d.join("big.sf2");
        std::fs::write(&p, vec![7u8; SF_HEAD_MAX + 1024]).unwrap();
        assert_eq!(read_head(&p, SF_HEAD_MAX).unwrap().len(), SF_HEAD_MAX);
        let small = d.join("small.sf2");
        std::fs::write(&small, [1u8, 2, 3]).unwrap();
        assert_eq!(read_head(&small, SF_HEAD_MAX).unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 尾巴必须是**文件最后那一段**（不是头）：指纹要"头尾同采样"，取错位置会让
    /// "扫描到的文件"与"导入同一文件"算成两个库
    #[test]
    fn tail_read_takes_the_end() {
        let d = tmp_dir("tail");
        let p = d.join("big.sf2");
        let mut data = vec![0u8; SF_HEAD_MAX * 2];
        for (i, b) in data.iter_mut().enumerate() {
            *b = (i % 251) as u8;
        }
        std::fs::write(&p, &data).unwrap();
        let tail = read_tail(&p, SF_HEAD_MAX).unwrap();
        assert_eq!(tail.len(), SF_HEAD_MAX);
        assert_eq!(tail, &data[data.len() - SF_HEAD_MAX..], "必须是文件最后那一段");
        let small = d.join("small.sf2");
        std::fs::write(&small, [1u8, 2, 3]).unwrap();
        assert_eq!(read_tail(&small, SF_HEAD_MAX).unwrap(), vec![1, 2, 3]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn scan_lists_only_soundfonts() {
        let d = tmp_dir("scan");
        std::fs::write(d.join("a.sf2"), [1u8]).unwrap();
        std::fs::write(d.join("b.SF3"), [1u8]).unwrap();
        std::fs::write(d.join("note.txt"), [1u8]).unwrap();
        std::fs::create_dir(d.join("sub.sf2")).unwrap(); // 目录即便叫 .sf2 也不算
        let mut out = Vec::new();
        scan_dir_into(&d, "appdata", &mut out);
        let names: Vec<&str> = out.iter().map(|x| x.file_name.as_str()).collect();
        assert_eq!(names.len(), 2, "只应列出 2 个：{names:?}");
        assert!(names.contains(&"a.sf2") && names.contains(&"b.SF3"));
        assert!(out.iter().all(|x| x.origin == "appdata"));
        assert!(out.iter().all(|x| x.size_bytes == 1));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 首次安装时"我的音色库目录"并不存在 ⇒ 必须当成空目录，而不是报错（否则面板整块变红）
    #[test]
    fn scan_missing_dir_is_empty_not_error() {
        let mut out = Vec::new();
        scan_dir_into(
            &std::env::temp_dir().join("ijipu-sf-definitely-missing-dir"),
            "appdata",
            &mut out,
        );
        assert!(out.is_empty());
    }

    /// adj1025：资源安装包目录 = `%LOCALAPPDATA%\iJipu\soundfonts`（用户 2026-10-21 给定）
    #[test]
    fn resource_dir_is_localappdata_ijipu_soundfonts() {
        let p = resource_dir_under(Path::new("C:/Users/x/AppData/Local"));
        assert!(p.ends_with("soundfonts"), "{}", p.display());
        assert!(p.to_string_lossy().contains("iJipu"), "{}", p.display());
    }

    /// adj1021：下载地址会直接交给 curl ⇒ 只允许 http(s)，且不许空白（防参数注入）
    #[test]
    fn download_url_must_be_http() {        for ok in ["https://example.com/a.sf2", "http://example.com/a.sf2"] {
            assert!(valid_download_url(ok).is_ok(), "{ok} 应当被接受");
        }
        for bad in [
            "",
            "file:///C:/Windows/win.ini",
            "C:\\Windows\\win.ini",
            "https://example.com/a b.sf2",
            "-o",
            "ftp://example.com/a.sf2",
        ] {
            assert!(valid_download_url(bad).is_err(), "{bad} 应当被拒");
        }
    }
}
