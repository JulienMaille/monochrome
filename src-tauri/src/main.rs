use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Manager, Emitter,
};
use tauri_plugin_store::StoreExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState, Shortcut};
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use std::str::FromStr;

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
        .invoke_handler(tauri::generate_handler![update_discord_presence])
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
            let shortcut_play = Shortcut::from_str("MediaPlayPause").unwrap();
            let shortcut_next = Shortcut::from_str("MediaNextTrack").unwrap();
            let shortcut_prev = Shortcut::from_str("MediaPrevTrack").unwrap();

            app.global_shortcut().register(shortcut_play).ok();
            app.global_shortcut().register(shortcut_next).ok();
            app.global_shortcut().register(shortcut_prev).ok();

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
