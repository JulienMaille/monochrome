// js/db.js
// Rewritten to use Gun.js as the Unified Data Layer

export class MusicDatabase {
    constructor() {
        // Initialize Gun with public relay peers
        this.peers = [
            'https://gun-manhattan.herokuapp.com/gun',
            'https://bg-gun.herokuapp.com/gun',
            'https://gun-us.herokuapp.com/gun'
            // Add more peers if needed
        ];

        this.gun = window.Gun ? window.Gun({ peers: this.peers, localStorage: true }) : null;
        this.user = this.gun ? this.gun.user() : null;

        // Cache to store the library state locally for fast access
        this.cache = {
            favorites_tracks: [],
            favorites_albums: [],
            favorites_artists: [],
            favorites_playlists: [],
            history_tracks: []
        };

        this.init();
    }

    init() {
        if (!this.gun) {
            console.error("Gun.js not loaded!");
            return;
        }

        // On load, try to restore session
        this.user.recall({sessionStorage: true});

        // Setup listeners for data changes to update local cache
        this.setupListeners();
    }

    // --- Authentication ---

    async createUser(alias, pass) {
        return new Promise((resolve, reject) => {
            this.user.create(alias, pass, (ack) => {
                if (ack.err) {
                    reject(new Error(ack.err));
                } else {
                    // Auto login after create
                    this.login(alias, pass).then(resolve).catch(reject);
                }
            });
        });
    }

    async login(alias, pass) {
        return new Promise((resolve, reject) => {
            this.user.auth(alias, pass, (ack) => {
                if (ack.err) {
                    reject(new Error(ack.err));
                } else {
                    this.setupListeners(); // Re-bind listeners to new user
                    resolve(ack);
                }
            });
        });
    }

    logout() {
        this.user.leave();
        this.clearCache();
        window.location.reload(); // Simple way to clear state
    }

    isLoggedIn() {
        return this.user.is;
    }

    getUsername() {
        return this.user.is ? this.user.is.alias : null;
    }

    // --- Data Management & Caching ---

    clearCache() {
         this.cache = {
            favorites_tracks: [],
            favorites_albums: [],
            favorites_artists: [],
            favorites_playlists: [],
            history_tracks: []
        };
    }

    setupListeners() {
        if (!this.user.is) return;

        console.log("Setting up Gun listeners for user:", this.user.is.alias);

        // Helper to sync graph node to cache array
        const syncNode = (path, cacheKey, sortField = 'addedAt') => {
            this.user.get('library').get(path).map().on((data, id) => {
                if (!data) {
                    // Item removed (data is null)
                    this.cache[cacheKey] = this.cache[cacheKey].filter(i => i.id !== id && i.uuid !== id);
                    this.notifyChange();
                    return;
                }

                // Item added or updated
                // Filter out Gun metadata (_ property)
                const cleanData = { ...data };
                delete cleanData._;

                // Update or Add
                const idx = this.cache[cacheKey].findIndex(i => (i.id === cleanData.id || i.uuid === cleanData.uuid));
                if (idx > -1) {
                    this.cache[cacheKey][idx] = cleanData;
                } else {
                    this.cache[cacheKey].push(cleanData);
                }

                // Sort
                if (sortField) {
                     this.cache[cacheKey].sort((a, b) => (b[sortField] || 0) - (a[sortField] || 0));
                }

                this.notifyChange();
            });
        };

        syncNode('tracks', 'favorites_tracks');
        syncNode('albums', 'favorites_albums');
        syncNode('artists', 'favorites_artists');
        syncNode('playlists', 'favorites_playlists');

        // History Listener
        this.user.get('history').map().on((data, key) => {
             if (!data) return;
             // History is stored by timestamp keys in Gun, but we want a sorted list
             const cleanData = { ...data };
             delete cleanData._;

             // Deduplicate by ID if exists (though history is usually by timestamp)
             // We'll trust the timestamp key for sorting

             const exists = this.cache.history_tracks.find(t => t.timestamp === cleanData.timestamp);
             if (!exists) {
                 this.cache.history_tracks.push(cleanData);
                 this.cache.history_tracks.sort((a, b) => b.timestamp - a.timestamp);
                 // Limit local history size
                 if (this.cache.history_tracks.length > 1000) {
                     this.cache.history_tracks = this.cache.history_tracks.slice(0, 1000);
                 }
             }
        });
    }

    notifyChange() {
        // Debounce notification
        if (this._notifyTimeout) clearTimeout(this._notifyTimeout);
        this._notifyTimeout = setTimeout(() => {
            window.dispatchEvent(new Event('library-changed'));
        }, 100);
    }

    // --- Public API (Matching original interface) ---

    async addToHistory(track) {
        if (!this.user.is) return; // Only sync if logged in? Or use local Gun graph if not?
        // Gun allows writing to a graph even if not auth'd? No, user() requires auth for write usually unless using 'sea' pairs manually.
        // For unauthenticated users, we can use a local temporary user or just fail silently/store in memory.
        // For now, let's assume auth is required for persistence, OR we create a temporary keypair for anonymous users.
        // But user requirement is "replace firebase".

        if (!this.user.is) {
            // If not logged in, we can't write to a user graph.
            // We could use a public node, but that's bad.
            // We'll skip for now or maybe implement anonymous session later.
            // For now, let's just update local cache so it works in session?
            // Actually, without auth, Gun.user() is not writable.
            return;
        }

        const minified = this._minifyItem('track', track);
        const timestamp = Date.now();
        const entry = { ...minified, timestamp };

        // Use timestamp as key for sorting
        this.user.get('history').get(timestamp).put(entry);
    }

    async getHistory() {
        // Return from cache
        return this.cache.history_tracks;
    }

    async toggleFavorite(type, item) {
        if (!this.user.is) {
            alert("Please login to save favorites.");
            return false;
        }

        const id = type === 'playlist' ? item.uuid : item.id;
        const exists = await this.isFavorite(type, id);

        const node = this.user.get('library').get(type + 's').get(id);

        if (exists) {
            node.put(null); // Remove
            return false;
        } else {
            const minified = this._minifyItem(type, item);
            minified.addedAt = Date.now();
            node.put(minified);
            return true;
        }
    }

    async isFavorite(type, id) {
        if (!this.user.is) return false;
        // Check cache for speed
        const list = this.cache[`favorites_${type}s`];
        if (!list) return false;
        return list.some(i => (i.id === id || i.uuid === id));
    }

    async getFavorites(type) {
        return this.cache[`favorites_${type}s`] || [];
    }

    _minifyItem(type, item) {
        if (!item) return item;
        
        // Base properties to keep
        const base = {
            id: item.id,
        };

        if (type === 'track') {
            return {
                ...base,
                title: item.title,
                duration: item.duration,
                explicit: item.explicit,
                // Keep minimal artist info
                artists: item.artists?.map(a => ({ id: a.id, name: a.name })) || [],
                // Keep minimal album info
                album: item.album ? {
                    id: item.album.id,
                    cover: item.album.cover,
                    releaseDate: item.album.releaseDate || null
                } : null,
                // Fallback date
                streamStartDate: item.streamStartDate,
                // Keep version if exists
                version: item.version
            };
        }

        if (type === 'album') {
            return {
                ...base,
                title: item.title,
                cover: item.cover,
                releaseDate: item.releaseDate,
                explicit: item.explicit,
                // UI uses singular 'artist'
                artist: item.artist ? { name: item.artist.name, id: item.artist.id } : (item.artists?.[0] ? { name: item.artists[0].name, id: item.artists[0].id } : null),
                // Keep type and track count for UI labels
                type: item.type,
                numberOfTracks: item.numberOfTracks
            };
        }

        if (type === 'artist') {
            return {
                ...base,
                name: item.name,
                picture: item.picture || item.image // Handle both just in case
            };
        }

        if (type === 'playlist') {
            return {
                uuid: item.uuid,
                addedAt: item.addedAt,
                title: item.title,
                // UI checks squareImage || image || uuid
                image: item.image || item.squareImage,
                numberOfTracks: item.numberOfTracks,
                user: item.user ? { name: item.user.name } : null
            };
        }

        return item;
    }

    async exportData() {
        return {
            favorites_tracks: this.cache.favorites_tracks,
            favorites_albums: this.cache.favorites_albums,
            favorites_artists: this.cache.favorites_artists,
            favorites_playlists: this.cache.favorites_playlists,
            history_tracks: this.cache.history_tracks
        };
    }

    async importData(data) {
        if (!this.user.is) {
            alert("Please login to import data.");
            return;
        }

        const importStore = (storeName, items) => {
            if (!items || !Array.isArray(items)) return;
            const type = storeName.replace('favorites_', '').replace('s', ''); // rough mapping

            items.forEach(item => {
                if (storeName === 'history_tracks') {
                    const timestamp = item.timestamp || Date.now();
                    this.user.get('history').get(timestamp).put(item);
                } else {
                    // For favorites
                    const id = type === 'playlist' ? item.uuid : item.id;
                    if (id) {
                         this.user.get('library').get(storeName.replace('favorites_', '')).get(id).put(item);
                    }
                }
            });
        };

        importStore('favorites_tracks', data.favorites_tracks);
        importStore('favorites_albums', data.favorites_albums);
        importStore('favorites_artists', data.favorites_artists);
        importStore('favorites_playlists', data.favorites_playlists);
        importStore('history_tracks', data.history_tracks);
    }
}

export const db = new MusicDatabase();
