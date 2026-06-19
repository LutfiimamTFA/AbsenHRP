'use client';

/**
 * @fileOverview Firebase Initialization Module
 * 
 * Ensures the Firebase SDK is initialized exactly once with the correct project.
 */

import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getFirestore, Firestore } from 'firebase/firestore';
import { getAuth, Auth, browserLocalPersistence, setPersistence } from 'firebase/auth';
import { firebaseConfig } from './config';

export function initializeFirebase(): {
  firebaseApp: FirebaseApp;
  firestore: Firestore;
  auth: Auth;
} {
  const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  const firestore   = getFirestore(firebaseApp);
  const auth        = getAuth(firebaseApp);

  // Paksa persistence local (localStorage) agar session tetap aktif setelah tutup tab/browser.
  // Logout hanya saat user klik logout atau token expired.
  // Tidak perlu await — Firebase queue operasi ini sebelum request lain.
  if (typeof window !== 'undefined') {
    setPersistence(auth, browserLocalPersistence).catch(() => {
      // Silent — jika gagal (private browsing?), fallback ke default session persistence.
    });
  }

  return { firebaseApp, firestore, auth };
}

export * from './provider';
export * from './client-provider';
export * from './auth/use-user';
export * from './firestore/use-collection';
export * from './firestore/use-doc';
