(function() {
    if (window.discordRpcInjected) {
        return;
    }
    window.discordRpcInjected = true;

    // Helper to safely access Tauri API
    function getTauri() {
        return window.__TAURI__;
    }

    const originalOpen = window.open;
    window.open = function(url, target, features) {
        const urlStr = String(url || '');
        const isExternalAuth = urlStr.includes('last.fm') || 
                               urlStr.includes('spotify.com') || 
                               urlStr.includes('discord.com');

        if (isExternalAuth) {
            const tauri = getTauri();
            if (tauri && tauri.shell && typeof tauri.shell.open === 'function') {
                tauri.shell.open(urlStr);
                return { 
                    close: () => {}, 
                    focus: () => {}, 
                    blur: () => {}, 
                    postMessage: () => {},
                    closed: false,
                    location: { href: urlStr }
                };
            }
        }
        
        return originalOpen.apply(window, arguments);
    };

    document.addEventListener('contextmenu', e => e.preventDefault());
    let debounceTimer;
    let lastState = {};

    async function invoke(cmd, args) {
        const tauri = getTauri();
        try {
            if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
                return await tauri.core.invoke(cmd, args);
            }
            if (tauri && tauri.tauri && typeof tauri.tauri.invoke === 'function') {
                return await tauri.tauri.invoke(cmd, args);
            }
        } catch (e) {
            console.warn(`[Tauri] Invoke failed for ${cmd}:`, e);
        }
        return Promise.reject("Tauri API not ready");
    }

    function setupEventListeners() {
        const tauri = getTauri();
        if (tauri && tauri.event && typeof tauri.event.listen === 'function') {
            tauri.event.listen('media-toggle', () => {
                const audio = document.getElementById('audio-player');
                if (audio) {
                    if (audio.paused) audio.play(); else audio.pause();
                }
            }).catch(e => {
                if (!e.includes('ACL')) console.warn('[Tauri] Event listen failed:', e);
            });
        } else {
            // Retry later if not ready
            setTimeout(setupEventListeners, 1000);
        }
    }

    setupEventListeners();

    function updateRPC(force = false) {
        const titleEl = document.querySelector('.now-playing-bar .title');
        const artistEl = document.querySelector('.now-playing-bar .artist');
        const coverEl = document.querySelector('.now-playing-bar img.cover');
        const audioEl = document.getElementById('audio-player');

        if (titleEl && artistEl) {
            let title = titleEl.innerText.replace(/\s*HD\s*$/, '').trim();
            
            let image = 'logo';
            if (coverEl && coverEl.src && coverEl.src.startsWith('http') && coverEl.src.length < 256) {
                image = coverEl.src;
            }

            const isPaused = audioEl ? audioEl.paused : false;
            
            const currentState = {
                title: title,
                artist: artistEl.innerText,
                image: image,
                isPaused: isPaused
            };

            if (!force && JSON.stringify(currentState) === JSON.stringify(lastState)) {
                return;
            }

            lastState = currentState;

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                const currentSec = audioEl ? audioEl.currentTime : 0;
                
                invoke('update_discord_presence', {
                    details: title,
                    status: currentState.artist,
                    image: image,
                    isPaused: isPaused,
                    currentSec: currentSec
                }).catch(() => {});
            }, 500);
        }
    }

    let observer = null;
    
    function attachAudioListeners() {
        const audio = document.getElementById('audio-player');
        if (audio && !audio.dataset.rpcAttached) {
            audio.addEventListener('play', () => updateRPC(false));
            audio.addEventListener('pause', () => updateRPC(false));
            audio.addEventListener('seeked', () => updateRPC(true));
            audio.dataset.rpcAttached = "true";
        }
    }

    function initializeWatcher() {
        const bar = document.querySelector('.now-playing-bar');
        if (bar && !observer) {
            observer = new MutationObserver(() => {
                try {
                    updateRPC(false);
                } catch(e) {}
            });
            observer.observe(bar, { subtree: true, childList: true, characterData: true });
        }
        attachAudioListeners();
        updateRPC(false);
    }
    
    function tryInit() {
        initializeWatcher();
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryInit);
    } else {
        tryInit();
    }
    
    setInterval(tryInit, 2000);
})();
