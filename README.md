
# PresenGO - Mobile-First Attendance

A fast, secure, single-screen attendance web application with AI-powered anomaly explanations.

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

## Role-Based Access Control (RBAC)
The app priority-checks roles in this order:
1. `users/{uid}.role` field.
2. `roles_admin/{uid}` exists.
3. `roles_hrd/{uid}` exists.
4. `roles_manager/{uid}` exists.

Privileged roles (`hrd`, `manager`, `superadmin`) have access to the Admin Dashboard.

## Security Rules (Implemented in firestore.rules)
Security rules are configured to protect user data while allowing admins to monitor activity. 
- **Users**: Read their own profile.
- **Attendance Events**: Users read their own; Admins read all.
- **Work Locations**: All authed users read (for geofencing).
