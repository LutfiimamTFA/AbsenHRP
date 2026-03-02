
'use client';

/**
 * @fileOverview Firebase Initialization Module
 * 
 * This module ensures that the Firebase modular SDK is initialized exactly once.
 * It provides singleton instances for Firestore and Auth to the rest of the app.
 */

import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getFirestore, Firestore } from 'firebase/firestore';
import { getAuth, Auth } from 'firebase/auth';
import { firebaseConfig } from './config';

/**
 * Initializes or retrieves the existing Firebase application instance.
 * 
 * @returns {Object} An object containing the initialized FirebaseApp, Firestore, and Auth instances.
 */
export function initializeFirebase(): {
  firebaseApp: FirebaseApp;
  firestore: Firestore;
  auth: Auth;
} {
  // Check if an app instance already exists to avoid multi-initialization errors in dev mode.
  const firebaseApp = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
  const firestore = getFirestore(firebaseApp);
  const auth = getAuth(firebaseApp);

  // Debug logging for development environment only
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[Firebase Dev] Initialized with Project ID: ${firebaseConfig.projectId}`);
  }

  return { firebaseApp, firestore, auth };
}

// Barrel exports for easier consumption
export * from './provider';
export * from './client-provider';
export * from './auth/use-user';
export * from './firestore/use-collection';
export * from './firestore/use-doc';
