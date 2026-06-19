// Firebase Admin SDK — server-side only (API routes).
// Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY di .env.local
// Private key: Firebase Console → Project Settings → Service Accounts → Generate new private key

import type { App } from 'firebase-admin/app';

let adminApp: App | undefined;

function getAdminApp(): App {
  if (adminApp) return adminApp;

  // Lazy require to avoid loading firebase-admin in client bundles
  const { initializeApp, getApps, cert } = require('firebase-admin/app');

  const existing = (getApps() as App[])[0];
  if (existing) {
    adminApp = existing;
    return adminApp;
  }

  const projectId   = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const rawKey      = process.env.FIREBASE_PRIVATE_KEY?.trim();
  const privateKey  = rawKey?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      '[Firebase Admin] Variabel FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, dan FIREBASE_PRIVATE_KEY wajib diisi di .env.local'
    );
  }
  if (privateKey.includes('ISI_PRIVATE_KEY')) {
    throw new Error(
      '[Firebase Admin] FIREBASE_PRIVATE_KEY masih placeholder. ' +
      'Download service account JSON dari Firebase Console → Project Settings → Service Accounts → ' +
      'Generate new private key, lalu salin nilai "private_key" ke .env.local.'
    );
  }

  const app: App = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  adminApp = app;
  return app;
}

export function getAdminFirestore() {
  const { getFirestore } = require('firebase-admin/firestore');
  return getFirestore(getAdminApp()) as import('firebase-admin/firestore').Firestore;
}

export function getAdminAuth() {
  const { getAuth } = require('firebase-admin/auth');
  return getAuth(getAdminApp()) as import('firebase-admin/auth').Auth;
}
