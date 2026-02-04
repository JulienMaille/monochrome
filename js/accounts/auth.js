// js/accounts/auth.js
import { auth, provider } from './config.js';
import {
    signInWithPopup,
    signInWithCredential,
    GoogleAuthProvider,
    signOut as firebaseSignOut,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { loginWithGoogleNative } from '../desktop.js';

export class AuthManager {
    constructor() {
        this.user = null;
        this.unsubscribe = null;
        this.authListeners = [];
        this.init();
    }

    init() {
        if (!auth) return;

        this.unsubscribe = onAuthStateChanged(auth, (user) => {
            this.user = user;
            this.updateUI(user);

            this.authListeners.forEach((listener) => listener(user));
        });
    }

    onAuthStateChanged(callback) {
        this.authListeners.push(callback);
        // If we already have a user state, trigger immediately
        if (this.user !== null) {
            callback(this.user);
        }
    }

    async signInWithGoogle() {
        console.log('Initiating Google Sign-In...');
        if (!auth) {
            alert('Firebase is not configured. Please check console.');
            return;
        }

        try {
            if (window.__TAURI__) {
                console.log('Tauri environment detected.');

                const clientId = localStorage.getItem('google_client_id');
                if (clientId) {
                    console.log('Found Google Client ID, attempting native loopback flow...');
                    const idToken = await loginWithGoogleNative(clientId);
                    const credential = GoogleAuthProvider.credential(idToken);
                    const result = await signInWithCredential(auth, credential);
                    return result.user;
                } else {
                    // Fallback to Popup
                    console.log(
                        'No Google Client ID found (localStorage "google_client_id"). Falling back to Popup flow.'
                    );
                    alert('Using Popup Login. Please ensure a new window opens. If not, check if it was blocked.');

                    try {
                        const result = await signInWithPopup(auth, provider);
                        console.log('Popup Login successful:', result.user);
                        return result.user;
                    } catch (popupError) {
                        console.error('Popup Login failed:', popupError);
                        alert(
                            `Popup Login Failed: ${popupError.message}\n\nMake sure "google_client_id" is set in localStorage if you want to use the native flow.`
                        );
                        throw popupError;
                    }
                }
            } else {
                console.log('Web environment detected. Using standard popup.');
                const result = await signInWithPopup(auth, provider);
                return result.user;
            }
        } catch (error) {
            console.error('Login process failed:', error);
            alert(`Login failed: ${error.message}`);
            throw error;
        }
    }

    async signInWithEmail(email, password) {
        if (!auth) {
            alert('Firebase is not configured.');
            return;
        }
        try {
            const result = await signInWithEmailAndPassword(auth, email, password);
            return result.user;
        } catch (error) {
            console.error('Email Login failed:', error);
            alert(`Login failed: ${error.message}`);
            throw error;
        }
    }

    async signUpWithEmail(email, password) {
        if (!auth) {
            alert('Firebase is not configured.');
            return;
        }
        try {
            const result = await createUserWithEmailAndPassword(auth, email, password);
            return result.user;
        } catch (error) {
            console.error('Sign Up failed:', error);
            alert(`Sign Up failed: ${error.message}`);
            throw error;
        }
    }

    async signOut() {
        if (!auth) return;

        try {
            await firebaseSignOut(auth);
            // The onAuthStateChanged listener will handle the rest
        } catch (error) {
            console.error('Logout failed:', error);
            throw error;
        }
    }

    updateUI(user) {
        const connectBtn = document.getElementById('firebase-connect-btn');
        const clearDataBtn = document.getElementById('firebase-clear-cloud-btn');
        const statusText = document.getElementById('firebase-status');
        const emailContainer = document.getElementById('email-auth-container');
        const emailToggleBtn = document.getElementById('toggle-email-auth-btn');

        if (!connectBtn) return; // UI might not be rendered yet

        if (user) {
            connectBtn.textContent = 'Sign Out';
            connectBtn.classList.add('danger');
            connectBtn.onclick = () => this.signOut();

            if (clearDataBtn) clearDataBtn.style.display = 'block';
            if (emailContainer) emailContainer.style.display = 'none';
            if (emailToggleBtn) emailToggleBtn.style.display = 'none';

            if (statusText) statusText.textContent = `Signed in as ${user.email}`;
        } else {
            connectBtn.textContent = 'Connect with Google';
            connectBtn.classList.remove('danger');
            connectBtn.onclick = () => this.signInWithGoogle();

            if (clearDataBtn) clearDataBtn.style.display = 'none';
            if (emailToggleBtn) emailToggleBtn.style.display = 'inline-block';

            if (statusText) statusText.textContent = 'Sync your library across devices';
        }
    }
}

export const authManager = new AuthManager();
