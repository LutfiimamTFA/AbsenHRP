// Firebase Admin SDK — server-side only (API routes).
// Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY di .env / Vercel env vars.
// Private key: Firebase Console → Project Settings → Service Accounts → Generate new private key

import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getAuth, type Auth } from 'firebase-admin/auth';

let adminApp: App | undefined;

function getAdminApp(): App {
  if (adminApp) return adminApp;

  const existing = getApps()[0];
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
      '[Firebase Admin] FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, dan FIREBASE_PRIVATE_KEY wajib diisi di env vars'
    );
  }
  if (privateKey.includes('ISI_PRIVATE_KEY')) {
    throw new Error(
      '[Firebase Admin] FIREBASE_PRIVATE_KEY masih placeholder. ' +
      'Download service account JSON dari Firebase Console → Project Settings → Service Accounts → ' +
      'Generate new private key, lalu salin nilai "private_key" ke Vercel Environment Variables.'
    );
  }

  adminApp = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  return adminApp;
}

export function getAdminFirestore(): Firestore {
  return getFirestore(getAdminApp());
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}
