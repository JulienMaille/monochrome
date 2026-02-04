use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState, Shortcut};
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use std::str::FromStr;
use std::thread;
use tiny_http::{Server, Response};
use url::Url;

struct DiscordState {
    client: Option<DiscordIpcClient>,
}

#[tauri::command]
fn update_discord_presence(
    state: tauri::State<Arc<Mutex<DiscordState>>>,
    details: String,
    state_text: String,
    large_image: Option<String>,
    _small_image: Option<String>,
) -> Result<(), String> {
    let mut discord = state.lock().map_err(|e| e.to_string())?;

    if let Some(client) = &mut discord.client {
        let start = SystemTime::now();
        let _since_the_epoch = start
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();

        let mut activity = activity::Activity::new()
            .details(&details)
            .state(&state_text);

        if let Some(img) = &large_image {
             activity = activity.assets(activity::Assets::new().large_image(img));
        }

        client.set_activity(activity).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn start_auth_server(app_handle: tauri::AppHandle, port: u16) -> Result<(), String> {
    println!("DEBUG: Attempting to start auth server on port {}", port);
    let server = Server::http(format!("127.0.0.1:{}", port)).map_err(|e| e.to_string())?;
    println!("DEBUG: Auth server started successfully on port {}", port);

    // Spawn a thread to handle the request so we don't block the main thread
    thread::spawn(move || {
        println!("DEBUG: Waiting for incoming auth request...");
        if let Ok(request) = server.recv() {
            println!("DEBUG: Received request: {}", request.url());
            let url_string = format!("http://127.0.0.1:{}{}", port, request.url());
            if let Ok(url) = Url::parse(&url_string) {
                if let Some((_, code)) = url.query_pairs().find(|(key, _)| key == "code") {
                    println!("DEBUG: Auth code found! Emitting event to frontend...");
                    if let Err(e) = app_handle.emit("google-auth-code", code.to_string()) {
                        println!("DEBUG: Failed to emit event: {}", e);
                    } else {
                        println!("DEBUG: Event emitted successfully.");
                    }
                } else {
                    println!("DEBUG: No 'code' query parameter found in URL.");
                }
            } else {
                println!("DEBUG: Failed to parse URL: {}", url_string);
            }

            let response = Response::from_string("Login successful! You can close this window now and return to the application.");
            let _ = request.respond(response);
        } else {
             println!("DEBUG: Server failed to receive request.");
        }
    });

    Ok(())
}

fn main() {
    let discord_client = DiscordIpcClient::new("1345424754388402176").ok(); // Placeholder ID
    let discord_state = Arc::new(Mutex::new(DiscordState {
        client: discord_client,
    }));

    // Connect Discord if possible
    if let Ok(mut state) = discord_state.lock() {
        if let Some(client) = &mut state.client {
            let _ = client.connect();
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(move |app, shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let shortcut_str = shortcut.to_string();
                if shortcut_str == "MediaPlayPause" {
                    app.emit("media-play-pause", ()).unwrap();
                } else if shortcut_str == "MediaNextTrack" {
                    app.emit("media-next-track", ()).unwrap();
                } else if shortcut_str == "MediaPrevTrack" {
                    app.emit("media-prev-track", ()).unwrap();
                }
            }
        }).build())
        .manage(discord_state)
        .invoke_handler(tauri::generate_handler![update_discord_presence, start_auth_server])
        .setup(|app| {
            // System Tray
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_i])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Register Shortcuts
            if let Ok(shortcut_play) = Shortcut::from_str("MediaPlayPause") {
                app.global_shortcut().register(shortcut_play).ok();
            }
            if let Ok(shortcut_next) = Shortcut::from_str("MediaNextTrack") {
                app.global_shortcut().register(shortcut_next).ok();
            }
            if let Ok(shortcut_prev) = Shortcut::from_str("MediaPrevTrack") {
                app.global_shortcut().register(shortcut_prev).ok();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
