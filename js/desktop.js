
// Tauri Integration
const IS_TAURI = window.__TAURI__ !== undefined;
const invoke = IS_TAURI ? window.__TAURI__.core.invoke : null;
const listen = IS_TAURI ? window.__TAURI__.event.listen : null;

// Initialize Discord Presence
if (IS_TAURI) {
    console.log("Monochrome Desktop: Tauri environment detected.");
    // Attempt to clear presence or set initial state
    invoke('update_discord_presence', {
        details: "Idling",
        stateText: "Monochrome Music",
        largeImage: "icon",
        smallImage: null
    }).catch(e => console.error("Failed to update Discord presence:", e));
}

export function updateDesktopPresence(track) {
    if (!IS_TAURI || !track) return;

    const title = track.title || "Unknown Title";
    const artist = track.artist || (track.artists ? track.artists[0] : "Unknown Artist");
    // const album = track.album?.title || "Unknown Album";
    // const cover = track.album?.cover ? `https://monochrome.samidy.com/api/cover/${track.album.cover}` : "icon";

    invoke('update_discord_presence', {
        details: title,
        stateText: `by ${artist}`,
        largeImage: "logo", // Fallback to key 'logo' as URLs often require whitelisting in Discord dev portal
        smallImage: null
    }).catch(e => console.error("Failed to update Discord presence:", e));
}

export function initializeDesktopEvents(player) {
    if (!IS_TAURI || !player) return;

    console.log("Initializing Desktop Media Keys...");

    listen('media-play-pause', () => {
        console.log("Desktop: Play/Pause");
        player.handlePlayPause();
    });

    listen('media-next-track', () => {
        console.log("Desktop: Next");
        player.playNext();
    });

    listen('media-prev-track', () => {
        console.log("Desktop: Prev");
        player.playPrev();
    });
}
