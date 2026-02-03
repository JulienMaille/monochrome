import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { Store } from '@tauri-apps/plugin-store';

// Tauri Integration
const IS_TAURI = window.__TAURI__ !== undefined;
let store = null;

async function initStore() {
    if (IS_TAURI && !store) {
        store = new Store('settings.dat');
    }
}

// Initialize Discord Presence
if (IS_TAURI) {
    console.log("Monochrome Desktop: Tauri environment detected.");
    initStore().catch(console.error);

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

    invoke('update_discord_presence', {
        details: title,
        stateText: `by ${artist}`,
        largeImage: "logo",
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

export async function setDownloadFolder() {
    if (!IS_TAURI) return;
    await initStore();
    try {
        const defaultPath = await store.get('download_path');
        const selected = await open({
            directory: true,
            multiple: false,
            defaultPath: defaultPath || undefined
        });

        if (selected) {
            await store.set('download_path', selected);
            await store.save();
            alert(`Download folder set to: ${selected}`);
            return selected;
        }
    } catch (e) {
        console.error("Failed to set download folder:", e);
        alert("Failed to set download folder: " + e.message);
    }
}

export async function getDownloadFolder() {
    if (!IS_TAURI) return null;
    await initStore();
    return await store.get('download_path');
}

export async function saveBlobToFolder(blob, filename) {
    if (!IS_TAURI) return false;
    const folder = await getDownloadFolder();
    if (!folder) return false;

    try {
        const arrayBuffer = await blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const path = `${folder}/${filename}`; // Simple concatenation, might need separator handling or join function

        await writeFile(path, uint8Array);
        return true;
    } catch (e) {
        console.error("Failed to save via Tauri:", e);
        return false;
    }
}
