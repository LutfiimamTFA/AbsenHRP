'use client';

import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useAuth, useFirestore } from '../provider';
import { errorEmitter } from '../error-emitter';
import { FirestorePermissionError } from '../errors';

export type UserRole = 'employee' | 'karyawan' | 'hrd' | 'manager' | 'superadmin' | 'super-admin' | 'kandidat';

export interface ExtendedUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  isPrivileged: boolean;
  isInternal: boolean;
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

        const checkDoc = async (path: string) => {
          const docRef = doc(db, path);
          try {
            return await getDoc(docRef);
          } catch (err: any) {
            if (err.code === 'permission-denied') {
              const permissionError = new FirestorePermissionError({
                path: docRef.path,
                operation: 'get',
              });
              errorEmitter.emit('permission-error', permissionError);
            }
            throw err;
          }
        };

        // 1. Check users/{uid}
        const userDoc = await checkDoc(`users/${firebaseUser.uid}`);
        
        if (userDoc.exists() && userDoc.data()?.role) {
          resolvedRole = userDoc.data().role;
        } else {
          // 2. Fallbacks to markers
          const adminCheck = await checkDoc(`roles_admin/${firebaseUser.uid}`);
          if (adminCheck.exists()) {
            resolvedRole = 'superadmin';
          } else {
            const hrdCheck = await checkDoc(`roles_hrd/${firebaseUser.uid}`);
            if (hrdCheck.exists()) {
              resolvedRole = 'hrd';
            } else {
              const managerCheck = await checkDoc(`roles_manager/${firebaseUser.uid}`);
              if (managerCheck.exists()) {
                resolvedRole = 'manager';
              }
            }
          }
        }

        // Normalize staff roles
        const internalRoles: UserRole[] = ['superadmin', 'super-admin', 'hrd', 'manager', 'karyawan', 'employee'];
        const isInternal = internalRoles.includes(resolvedRole);
        const isPrivileged = ['hrd', 'manager', 'superadmin', 'super-admin'].includes(resolvedRole);

        setUser({
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName || userDoc.data()?.name || null,
          role: resolvedRole,
          isPrivileged,
          isInternal
        });
      } catch (err) {
        // Safe fallback for error states
        setUser({
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName,
          role: 'employee',
          isPrivileged: false,
          isInternal: true
        });
      } finally {
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [auth, db]);

  return { user, loading };
}