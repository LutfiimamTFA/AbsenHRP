
'use client';

import { useEffect, useState } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useAuth, useFirestore } from '../provider';

export type UserRole = 'employee' | 'karyawan' | 'hrd' | 'manager' | 'superadmin';

export interface ExtendedUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  isPrivileged: boolean;
}

export function useUser() {
  const auth = useAuth();
  const db = useFirestore();
  const [user, setUser] = useState<ExtendedUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        setUser(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        let resolvedRole: UserRole = 'employee';

        // 1. Check users/{uid}
        const userDocRef = doc(db, 'users', firebaseUser.uid);
        const userDoc = await getDoc(userDocRef);
        
        if (userDoc.exists() && userDoc.data()?.role) {
          resolvedRole = userDoc.data().role;
        } else {
          // 2. Fallbacks
          const adminCheck = await getDoc(doc(db, 'roles_admin', firebaseUser.uid));
          if (adminCheck.exists()) {
            resolvedRole = 'superadmin';
          } else {
            const hrdCheck = await getDoc(doc(db, 'roles_hrd', firebaseUser.uid));
            if (hrdCheck.exists()) {
              resolvedRole = 'hrd';
            } else {
              const managerCheck = await getDoc(doc(db, 'roles_manager', firebaseUser.uid));
              if (managerCheck.exists()) {
                resolvedRole = 'manager';
              }
            }
          }
        }

        const isPrivileged = ['hrd', 'manager', 'superadmin'].includes(resolvedRole);

        setUser({
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName || userDoc.data()?.name || null,
          role: resolvedRole,
          isPrivileged
        });
      } catch (err) {
        // Fallback to basic user if firestore fails
        setUser({
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName,
          role: 'employee',
          isPrivileged: false
        });
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [auth, db]);

  return { user, loading };
}
