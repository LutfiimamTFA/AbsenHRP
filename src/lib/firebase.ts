// Deprecated. Use imports from '@/firebase' instead.
import { initializeFirebase } from '@/firebase';

const { firebaseApp: app, firestore: db, auth } = initializeFirebase();

export { app, db, auth };
