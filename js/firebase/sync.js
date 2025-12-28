// js/firebase/sync.js
import { database } from './config.js';
import { ref, get, set, update, onValue, off, child, remove, runTransaction } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { db } from '../db.js';

export class SyncManager {
    constructor() {
        this.user = null;
        this.userRef = null;
        this.unsubscribeFunctions = [];
        this.isSyncing = false;
    }

    initialize(user) {
        if (!database || !user) return;
        this.user = user;
        this.userRef = ref(database, `users/${user.uid}`);
        
        console.log("Initializing SyncManager for user:", user.uid);
        this.performInitialSync();
    }

    disconnect() {
        if (this.userRef) {
            // Remove listeners
            this.unsubscribeFunctions.forEach(unsub => unsub());
            this.unsubscribeFunctions = [];
        }
        this.user = null;
        this.userRef = null;
        console.log("SyncManager disconnected");
    }

    async performInitialSync() {
        if (this.isSyncing) return;
        this.isSyncing = true;
        
        try {
            console.log("Starting initial sync...");
            
            // 1. Fetch Cloud Data
            const snapshot = await get(this.userRef);
            const cloudData = snapshot.val() || {};
            
            // 2. Fetch Local Data
            const localData = await db.exportData();

            // 3. Merge Data (Union Strategy)
            const mergedData = this.mergeData(localData, cloudData);

            // 4. Update Cloud (if different)
            // We optimize by just rewriting the whole node for simplicity in Phase 1, 
            // or we could diff. Rewriting is safer for "Initial Merge".
            await update(this.userRef, mergedData);

            // 5. Update Local (Import merged data)
            // Convert Cloud Schema back to Local Schema for IndexedDB
            const importData = {
                favorites_tracks: mergedData.library?.tracks ? Object.values(mergedData.library.tracks) : [],
                favorites_albums: mergedData.library?.albums ? Object.values(mergedData.library.albums) : [],
                favorites_artists: mergedData.library?.artists ? Object.values(mergedData.library.artists) : [],
                favorites_playlists: mergedData.library?.playlists ? Object.values(mergedData.library.playlists) : [],
                history_tracks: mergedData.history?.recentTracks || []
            };
            
            await db.importData(importData, true);

            console.log("Initial sync complete.");

            // 6. Setup Listeners for future changes
            this.setupListeners();

        } catch (error) {
            console.error("Initial sync failed:", error);
        } finally {
            this.isSyncing = false;
        }
    }

    mergeData(local, cloud) {
        // Helper to merge lists of objects based on ID/UUID
        // We assume 'favorites_*' structure from db.exportData()
        
        const mergeStores = (localItems, cloudItems, idKey = 'id') => {
            const map = new Map();
            
            // Add all local items
            if (Array.isArray(localItems)) {
                localItems.forEach(item => map.set(item[idKey], item));
            } else if (localItems && typeof localItems === 'object') {
                // Handle case where cloud stores as object keys
                Object.values(localItems).forEach(item => map.set(item[idKey], item));
            }

            // Add/Overwrite with cloud items (Union Strategy)
            if (cloudItems) {
                if (Array.isArray(cloudItems)) {
                    cloudItems.forEach(item => map.set(item[idKey], item));
                } else {
                    Object.keys(cloudItems).forEach(key => {
                        const val = cloudItems[key];
                        if (typeof val === 'object') {
                            map.set(val[idKey] || key, val);
                        }
                    });
                }
            }
            
            return Array.from(map.values());
        };

        const merged = {
            library: {
                tracks: this.arrayToObject(mergeStores(local.favorites_tracks, cloud.library?.tracks), 'id'),
                albums: this.arrayToObject(mergeStores(local.favorites_albums, cloud.library?.albums), 'id'),
                artists: this.arrayToObject(mergeStores(local.favorites_artists, cloud.library?.artists), 'id'),
                playlists: this.arrayToObject(mergeStores(local.favorites_playlists, cloud.library?.playlists, 'uuid'), 'uuid')
            },
            history: {
                recentTracks: this.mergeHistory(local.history_tracks, cloud.history?.recentTracks)
            },
            // Settings are NOT synced (device specific)
            lastUpdated: Date.now()
        };

        // Transform back to local structure for db.importData
        return merged;
    }
    
    // Helper to convert array to object with keys
    arrayToObject(arr, keyField) {
        const obj = {};
        arr.forEach(item => {
            if (item && item[keyField]) {
                obj[item[keyField]] = item;
            }
        });
        return obj;
    }

    mergeHistory(localHist, cloudHist) {
        // Combine and sort by timestamp desc, take top 1000
        const combined = [...(localHist || []), ...(cloudHist || [])];
        // Dedup by timestamp (unlikely collision but possible)
        const unique = Array.from(new Map(combined.map(item => [item.timestamp, item])).values());
        unique.sort((a, b) => b.timestamp - a.timestamp);
        return unique.slice(0, 1000);
    }

    setupListeners() {
        // Listen for changes in library
        const libraryRef = child(this.userRef, 'library');
        
        const unsubLibrary = onValue(libraryRef, (snapshot) => {
            if (this.isSyncing) return; 
            
            const val = snapshot.val();
            if (val) {
                const importData = {
                    favorites_tracks: val.tracks ? Object.values(val.tracks) : [],
                    favorites_albums: val.albums ? Object.values(val.albums) : [],
                    favorites_artists: val.artists ? Object.values(val.artists) : [],
                    favorites_playlists: val.playlists ? Object.values(val.playlists) : []
                };
                db.importData(importData, true).then(() => {
                    // Notify UI to refresh?
                    // We can dispatch a custom event
                    window.dispatchEvent(new Event('library-changed'));
                });
            }
        });
        
        this.unsubscribeFunctions.push(() => off(libraryRef, 'value', unsubLibrary));
    }

    // --- Public API for Broadcasters ---

    async syncLibraryItem(type, item, isAdded) {
        if (!this.user || !this.userRef) return;

        // type: 'track', 'album', 'artist', 'playlist'
        // item: the object (minified preferably)
        // isAdded: boolean

        const categoryMap = {
            'track': 'tracks',
            'album': 'albums',
            'artist': 'artists',
            'playlist': 'playlists'
        };
        const category = categoryMap[type];
        if (!category) return;

        const id = type === 'playlist' ? item.uuid : item.id;
        const path = `library/${category}/${id}`;
        const itemRef = child(this.userRef, path);

        if (isAdded) {
            // Ensure addedAt exists for IndexedDB indexing
            if (!item.addedAt) {
                item.addedAt = Date.now();
            }
            await set(itemRef, item);
        } else {
            await remove(itemRef);
        }
    }

    async syncHistoryItem(track) {
        if (!this.user || !this.userRef) return;
        
        const historyRef = child(this.userRef, 'history/recentTracks');
        
        try {
            await runTransaction(historyRef, (currentData) => {
                // If the node is null, currentData will be null.
                let history = currentData || [];

                // Add new track and dedup just in case
                const tempMap = new Map(history.map(t => [t.id, t]));
                tempMap.set(track.id, track);
                
                // Sort by timestamp and keep latest 1000
                const sortedHistory = Array.from(tempMap.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                return sortedHistory.slice(0, 1000);
            });
        } catch (error) {
            console.error("Failed to sync history item:", error);
        }
    }
}

export const syncManager = new SyncManager();
