import { levenshteinDistance } from './utils.js';
import { db } from './db.js';
import { syncManager } from './firebase/sync.js';

export async function fetchSpotifyTracks(playlistUrl) {
    let embedUrl = playlistUrl;

    // Convert regular URL to Embed URL if needed
    // Regular: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
    // Embed: https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M
    if (!playlistUrl.includes('/embed/')) {
        const idMatch = playlistUrl.match(/playlist\/([a-zA-Z0-9]+)/);
        if (idMatch) {
            embedUrl = `https://open.spotify.com/embed/playlist/${idMatch[1]}`;
        } else {
            throw new Error('Invalid Spotify Playlist URL');
        }
    }

    // Use corsproxy.io for reliability
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(embedUrl)}`;

    try {
        const response = await fetch(proxyUrl);
        if (!response.ok) throw new Error('Failed to fetch Spotify data');

        const html = await response.text();

        // Parse the __NEXT_DATA__ script
        const scriptRegex = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/;
        const match = html.match(scriptRegex);

        if (!match) throw new Error('Could not find playlist data in page');

        const json = JSON.parse(match[1]);
        const entity = json?.props?.pageProps?.state?.data?.entity;

        if (!entity || !entity.trackList) throw new Error('Invalid data structure found');

        return {
            title: entity.name || 'Imported Playlist',
            description: entity.description || '',
            tracks: entity.trackList.map(t => ({
                title: t.title,
                artist: t.subtitle, // Spotify embed uses 'subtitle' for artist
                duration: t.duration / 1000 // duration is in ms
            }))
        };

    } catch (error) {
        console.error('Spotify import error:', error);
        throw new Error('Failed to import from Spotify. Ensure the playlist is Public.');
    }
}

export async function importSpotifyPlaylist(url, api, onProgress) {
    try {
        if (onProgress) onProgress(0, 'Fetching playlist data...');

        const spotifyData = await fetchSpotifyTracks(url);
        const total = spotifyData.tracks.length;
        const matchedTracks = [];

        for (let i = 0; i < total; i++) {
            const spTrack = spotifyData.tracks[i];
            const query = `${spTrack.title} ${spTrack.artist}`;

            if (onProgress) onProgress((i / total) * 100, `Searching: ${spTrack.title}`);

            try {
                // Search for the track
                const results = await api.searchTracks(query);

                if (results.items && results.items.length > 0) {
                    // Fuzzy match to find best result
                    let bestMatch = null;
                    let bestScore = Infinity;

                    const normalize = str => str.toLowerCase().replace(/[^a-z0-9]/g, '');
                    const targetTitle = normalize(spTrack.title);
                    const targetArtist = normalize(spTrack.artist);

                    for (const item of results.items) {
                        const itemTitle = normalize(item.title);
                        const itemArtist = normalize(item.artist?.name || '');

                        // Exact match bonus
                        if (itemTitle === targetTitle && itemArtist === targetArtist) {
                            bestMatch = item;
                            break;
                        }

                        // Distance calculation
                        const titleDist = levenshteinDistance(targetTitle, itemTitle);
                        const artistDist = levenshteinDistance(targetArtist, itemArtist);
                        const score = titleDist + artistDist;

                        // Heuristic: If score is low enough relative to length
                        if (score < bestScore) {
                            bestScore = score;
                            bestMatch = item;
                        }
                    }

                    // Only accept if match is reasonable (e.g. < 40% difference)
                    const totalLen = targetTitle.length + targetArtist.length;
                    if (bestMatch && (bestScore <= Math.max(3, totalLen * 0.4))) {
                        matchedTracks.push(bestMatch);
                    }
                }
            } catch (err) {
                console.warn(`Failed to match track: ${spTrack.title}`, err);
            }

            // Small delay to avoid rate limits
            await new Promise(r => setTimeout(r, 100));
        }

        if (matchedTracks.length === 0) {
            throw new Error('No tracks could be matched from this playlist.');
        }

        if (onProgress) onProgress(100, 'Creating playlist...');

        const playlist = await db.createPlaylist(spotifyData.title, matchedTracks, '');
        await syncManager.syncUserPlaylist(playlist, 'create');

        return playlist;

    } catch (error) {
        throw error;
    }
}
