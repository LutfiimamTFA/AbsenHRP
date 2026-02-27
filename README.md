
# PresenGO - Mobile-First Attendance

A fast, secure, single-screen attendance web application.

## Prerequisites
- Firebase Project ID: `studio-9262077557-bc9c9`

## Environment Setup
Add these to your `.env.local`:
```env
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSyDqMdXWhOikeYNqJo9XTMvZ63Hmmgixsfk
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=studio-9262077557-bc9c9.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=studio-9262077557-bc9c9
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=studio-9262077557-bc9c9.firebasestorage.app
NEXT_PUBLIC_FIREBASE_APP_ID=1:80532457942:web:aa51bae0a3a5bd0b243c77
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=80532457942
```

## Security Rules (Apply in Firebase Console)

### Firestore
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /attendance_events/{event} {
      allow write: if false; // Only server (functions)
      allow read: if request.auth != null && request.auth.uid == resource.data.uid;
    }
    match /work_locations/{loc} {
      allow read: if request.auth != null;
    }
    match /users/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
    // Roles fallbacks for HRP compatibility
    match /roles_admin/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
    match /roles_hrd/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
    match /roles_manager/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

### Storage
```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /attendance_raw/{uid}/{allPaths=**} {
      allow write: if false; // Only server
      allow read: if request.auth != null && request.auth.uid == uid;
    }
    match /attendance_wm/{uid}/{allPaths=**} {
      allow write: if false; // Only server
      allow read: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```
