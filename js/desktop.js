import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { Store } from '@tauri-apps/plugin-store';
import { open as openUrl } from '@tauri-apps/plugin-shell';

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
        const path = `${folder}/${filename}`;

        await writeFile(path, uint8Array);
        return true;
    } catch (e) {
        console.error("Failed to save via Tauri:", e);
        return false;
    }
}

// Google Login Helpers
async function generateCodeVerifier() {
    const array = new Uint8Array(32);
    window.crypto.getRandomValues(array);
    return base64UrlEncode(array);
}

async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await window.crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(hash));
}

function base64UrlEncode(array) {
    return btoa(String.fromCharCode(...array))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export async function loginWithGoogleNative(clientId) {
    if (!IS_TAURI) return null;

    const port = 8080; // Fixed port for simplicity, could be random
    const redirectUri = `http://127.0.0.1:${port}`;
    const codeVerifier = await generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    console.log("Starting Auth Server on port", port);
    // Start local server to catch the callback
    await invoke('start_auth_server', { port });

    // Construct Auth URL
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(clientId)}&` +
        `redirect_uri=${encodeURIComponent(redirectUri)}&` +
        `response_type=code&` +
        `scope=openid%20email%20profile&` +
        `code_challenge=${codeChallenge}&` +
        `code_challenge_method=S256`;

    // Open System Browser
    await openUrl(authUrl);

    // Wait for code from backend
    return new Promise((resolve, reject) => {
        const unlistenPromise = listen('google-auth-code', async (event) => {
            const code = event.payload;
            console.log("Received Auth Code");

            // Exchange code for token
            try {
                const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id: clientId,
                        code: code,
                        code_verifier: codeVerifier,
                        redirect_uri: redirectUri,
                        grant_type: 'authorization_code'
                    })
                });

                const tokens = await tokenResponse.json();
                if (tokens.id_token) {
                    resolve(tokens.id_token);
                } else {
                    reject(new Error("No ID token returned: " + JSON.stringify(tokens)));
                }
            } catch (e) {
                reject(e);
            } finally {
               // unlistenPromise.then(unlisten => unlisten()); // Tauri v2 listen returns a promise resolving to unlisten function
            }
        });

        // Timeout after 2 minutes
        setTimeout(() => {
            reject(new Error("Login timed out"));
        }, 120000);
    });
}
