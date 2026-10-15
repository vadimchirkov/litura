// Stilura desktop shell.
//
// The editor is the same Node server the npm package runs; this process picks
// the writing folder, starts that server on a free port, points a window at it,
// and owns the update path. Nothing about the document, the model, or the
// review lives here — moving any of it would mean two implementations of the
// same product.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

/// The running server. Killed when the app exits so a crash-and-restart does
/// not leave a second one holding the draft's lock file.
#[derive(Default)]
struct Server {
    child: Mutex<Option<CommandChild>>,
    url: Mutex<Option<String>>,
    exit_allowed: AtomicBool,
    closing: AtomicBool,
}

/// Which folder holds the writing. One line of text next to the app's own
/// config — a file the writer can read, and delete to be asked again.
fn folder_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("folder.txt"))
}

fn saved_folder(app: &AppHandle) -> Option<PathBuf> {
    // STILURA_FOLDER wins over the saved choice. The smoke test needs it: on
    // Windows the config directory comes from the shell API, not APPDATA, so
    // a test cannot point it elsewhere.
    let path = match std::env::var_os("STILURA_FOLDER") {
        Some(folder) => PathBuf::from(folder),
        None => PathBuf::from(std::fs::read_to_string(folder_file(app).ok()?).ok()?.trim()),
    };
    // A remembered folder is reused only while it stays readable: macOS can
    // revoke Documents consent after the fact, and serving an unreadable
    // folder is a startup of errors. Unreadable means ask again.
    if !path.is_dir() || std::fs::read_dir(&path).is_err() {
        return None;
    }
    Some(path)
}

fn save_folder(app: &AppHandle, folder: &Path) {
    if let Ok(file) = folder_file(app) {
        let _ = std::fs::write(file, folder.to_string_lossy().as_bytes());
    }
}

/// Ask for the writing folder and hand the answer to `next`.
///
/// The callback form, not the blocking one: a blocking pick answered from
/// whichever thread called it returned a default folder nobody chose.
fn pick_folder(app: &AppHandle, next: impl FnOnce(Option<PathBuf>) + Send + 'static) {
    app.dialog()
        .file()
        .set_title("Choose the folder that holds your writing")
        .pick_folder(move |folder| next(folder.and_then(|folder| folder.into_path().ok())));
}

fn fatal(app: &AppHandle, message: &str) {
    // Said twice: once to whoever is looking at the window, once to whoever is
    // reading the output of a build or a smoke run.
    eprintln!("[stilura] {message}");
    app.dialog()
        .message(message)
        .title("Stilura could not start")
        .blocking_show();
    app.exit(1);
}

/// Start the server for `folder` and return the URL it bound to.
///
/// The server prints one machine-readable line when it is listening; anything
/// else on its output is a log, and anything on stderr is worth keeping in the
/// console for a bug report.
async fn start_server(app: &AppHandle, folder: &Path) -> Result<String, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let server_js = resources.join("server.mjs");
    if !server_js.is_file() {
        return Err(format!("{} is missing from the app bundle", server_js.display()));
    }

    let env = HashMap::<String, String>::from([
        ("STILURA_SIDECAR".into(), "1".into()),
        ("STILURA_OFFLINE_MODELS".into(), "1".into()),
        // Port 0: the operating system hands out a free one, so a second copy
        // of Stilura — or anything else on 3456 — is not a startup failure.
        ("PORT".into(), "0".into()),
        ("STILURA_ROOT".into(), resources.to_string_lossy().into_owned()),
        ("STILURA_STATE_DIR".into(), std::env::var_os("STILURA_STATE_DIR").map(PathBuf::from)
            .unwrap_or(app.path().app_data_dir().map_err(|e| e.to_string())?.join("editor-state")).to_string_lossy().into_owned()),
        ("DRAFT_FILE".into(), folder.join("draft.md").to_string_lossy().into_owned()),
        ("STYLE_FILE".into(), folder.join("style.md").to_string_lossy().into_owned()),
    ]);

    let (mut rx, child) = app
        .shell()
        .sidecar("stilura-server")
        .map_err(|e| e.to_string())?
        .args([server_js.to_string_lossy().to_string()])
        .envs(env)
        .spawn()
        .map_err(|e| e.to_string())?;

    app.state::<Server>().child.lock().unwrap().replace(child);

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let line = String::from_utf8_lossy(&line);
                // Forwarded rather than swallowed: it is how a smoke test
                // outside the app learns which port to talk to.
                print!("{line}");
                if let Some(url) = line.trim().strip_prefix("STILURA_READY ") {
                    *app.state::<Server>().url.lock().unwrap() = Some(url.to_string());
                    // The page reads the marker to leave room for the window
                    // buttons. It is a query string rather than a header so
                    // that it survives a reload the writer triggers.
                    let url = format!("{url}/?shell=desktop");
                    // This function is done once the window has a URL, but the
                    // server keeps talking, and its later complaints are the
                    // ones worth having in a bug report.
                    tauri::async_runtime::spawn(async move {
                        while let Some(event) = rx.recv().await {
                            match event {
                                CommandEvent::Stdout(line) => print!("{}", String::from_utf8_lossy(&line)),
                                CommandEvent::Stderr(line) => eprint!("{}", String::from_utf8_lossy(&line)),
                                _ => {}
                            }
                        }
                    });
                    return Ok(url);
                }
            }
            CommandEvent::Stderr(line) => eprint!("{}", String::from_utf8_lossy(&line)),
            CommandEvent::Terminated(status) => {
                return Err(format!("The server stopped before it was ready (code {:?})", status.code))
            }
            _ => {}
        }
    }
    Err("The server stopped before it was ready".into())
}

async fn editor_request(app: &AppHandle, action: &str) -> Result<(), String> {
    let url = app.state::<Server>().url.lock().unwrap().clone().ok_or("The editor is not ready.")?;
    let response = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(25))
        .build().map_err(|e| e.to_string())?
        .post(format!("{url}/api/desktop/{action}"))
        .header("Content-Type", "application/json").body("{}")
        .send().await.map_err(|e| e.to_string())?;
    if response.status().is_success() { return Ok(()); }
    let body = response.text().await.unwrap_or_default();
    let value: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    Err(value["error"].as_str().unwrap_or("The editor could not save.").to_string())
}

async fn save_before_exit(app: &AppHandle) -> bool {
    if let Err(error) = editor_request(app, "flush").await {
        app.dialog().message(error).title("Not saved — app kept open").blocking_show();
        return false;
    }
    true
}

/// Ask, download, install, restart. Called on launch and from the menu; only
/// the menu wants to hear that there is nothing to install.
async fn update(app: AppHandle, announce_current: bool) {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            if announce_current {
                app.dialog().message(error.to_string()).title("Update check failed").blocking_show();
            }
            return;
        }
    };
    let found = match updater.check().await {
        Ok(found) => found,
        Err(error) => {
            // A launch-time check that cannot reach GitHub is not news. The
            // writer who asked for it by hand deserves the reason.
            if announce_current {
                app.dialog().message(error.to_string()).title("Update check failed").blocking_show();
            }
            return;
        }
    };
    let Some(update) = found else {
        if announce_current {
            app.dialog()
                .message(format!("Stilura {} is the current version.", app.package_info().version))
                .title("No update")
                .blocking_show();
        }
        return;
    };

    let accepted = app
        .dialog()
        .message(format!(
            "Stilura {} is available. Install it and restart?\n\nYour draft is saved to disk before the restart.",
            update.version
        ))
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Later".into()))
        .blocking_show();
    if !accepted {
        return;
    }

    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(error) => {
            app.dialog().message(error.to_string()).title("Update failed").blocking_show();
            return;
        }
    };
    // Windows may exit during installation, so confirm the save first.
    if !save_before_exit(&app).await { return; }
    app.state::<Server>().exit_allowed.store(true, Ordering::SeqCst);
    match update.install(bytes) {
        Ok(()) => {
            app.restart();
        }
        Err(error) => {
            app.state::<Server>().exit_allowed.store(false, Ordering::SeqCst);
            let _ = editor_request(&app, "resume").await;
            app.dialog().message(error.to_string()).title("Update failed").blocking_show();
        }
    }
}

/// Start the server for `folder` and point the window at it. Off the main
/// thread: this waits for a process to bind a port.
fn serve(app: AppHandle, window: WebviewWindow, folder: PathBuf) {
    std::thread::spawn(move || match tauri::async_runtime::block_on(start_server(&app, &folder)) {
        Ok(url) => {
            if let Ok(url) = url.parse() {
                let _ = window.navigate(url);
            }
            tauri::async_runtime::spawn(update(app, false));
        }
        Err(error) => fatal(&app, &error),
    });
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open-folder", "Open Folder…", true, Some("CmdOrCtrl+O"))?;
    let check = MenuItem::with_id(app, "check-update", "Check for Updates…", true, None::<&str>)?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&open, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::close_window(app, None)?],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    // The app submenu is where macOS users look for About and Quit; on Windows
    // and Linux the same two items are the tail of File.
    let app_menu = Submenu::with_items(
        app,
        "Stilura",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &check,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit])
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Server::default())
        .setup(|app| {
            let handle = app.handle().clone();
            app.set_menu(build_menu(&handle)?)?;

            // The window opens on a local holding page first: the folder
            // dialog and the server start take a moment, and a writer who
            // double-clicked an icon should see the app, not the desktop.
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Stilura")
                .inner_size(1200.0, 820.0)
                .min_inner_size(640.0, 480.0);
            // The draft's own header is the title bar. macOS can drop its bar
            // and leave the window buttons floating over the page, which keeps
            // dragging, zooming, and full screen native — no custom controls,
            // and no Tauri API in a page that otherwise needs none. Windows and
            // Linux keep their frame: the same trick there means reimplementing
            // minimise, maximise, and close.
            #[cfg(target_os = "macos")]
            let window = window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            let window = window.build()?;

            match saved_folder(&handle) {
                Some(folder) => serve(handle, window, folder),
                None => {
                    let handle = handle.clone();
                    pick_folder(&handle.clone(), move |folder| match folder {
                        Some(folder) => {
                            save_folder(&handle, &folder);
                            serve(handle, window, folder);
                        }
                        // Nothing was chosen. Leaving a window on the holding
                        // page would be a hang with a nice background.
                        None => handle.exit(0),
                    });
                }
            }

            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open-folder" => {
                let app = app.clone();
                pick_folder(&app.clone(), move |folder| {
                    if let Some(folder) = folder {
                        tauri::async_runtime::spawn(async move {
                            if !save_before_exit(&app).await { return; }
                            save_folder(&app, &folder);
                            app.state::<Server>().exit_allowed.store(true, Ordering::SeqCst);
                            app.restart();
                        });
                    }
                });
            }
            "check-update" => {
                tauri::async_runtime::spawn(update(app.clone(), true));
            }
            _ => {}
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("Stilura failed to start")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, code, .. } = &event {
                let server = app.state::<Server>();
                if !server.exit_allowed.load(Ordering::SeqCst) && server.url.lock().unwrap().is_some() {
                    api.prevent_exit();
                    if !server.closing.swap(true, Ordering::SeqCst) {
                        let app = app.clone();
                        let code = code.unwrap_or(0);
                        tauri::async_runtime::spawn(async move {
                            if save_before_exit(&app).await {
                                app.state::<Server>().exit_allowed.store(true, Ordering::SeqCst);
                                app.exit(code);
                            } else {
                                app.state::<Server>().closing.store(false, Ordering::SeqCst);
                            }
                        });
                    }
                }
            }
            // Exit and restart both come through here, and both must take the
            // server with them.
            if matches!(event, RunEvent::Exit) {
                if let Some(child) = app.state::<Server>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
