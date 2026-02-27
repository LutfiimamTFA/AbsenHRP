
'use client';

import { useEffect, useState } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useAuth, useFirestore } from '../provider';

export type UserRole = 'employee' | 'karyawan' | 'hrd' | 'manager' | 'superadmin' | 'super-admin' | 'kandidat';

export interface ExtendedUser {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  isPrivileged: boolean;
  isInternal: boolean;
  brandName?: string;
  brandId?: string;
  division?: string;
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
        const userDocRef = doc(db, 'users', firebaseUser.uid);
        const userDoc = await getDoc(userDocRef);
        const userData = userDoc.data();
        
        if (userDoc.exists() && userData?.role) {
          resolvedRole = userData.role;
        }

        let brandName = userData?.brandName;
        if (!brandName && userData?.brandId) {
          const brandDoc = await getDoc(doc(db, 'brands', userData.brandId));
          if (brandDoc.exists()) {
            brandName = brandDoc.data()?.name;
          }
        }

        // Definisi Peran Internal (Semua staf HRP)
        const internalRoles: UserRole[] = ['superadmin', 'super-admin', 'hrd', 'manager', 'karyawan', 'employee'];
        const isInternal = internalRoles.includes(resolvedRole);
        
        // Privilege (HRD/Admin untuk dashboard monitoring jika ada di portal lain)
        const isPrivileged = ['hrd', 'manager', 'superadmin', 'super-admin'].includes(resolvedRole);

        setUser({
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: userData?.displayName || userData?.name || firebaseUser.displayName || null,
          role: resolvedRole,
          isPrivileged,
          isInternal,
          brandName: brandName || "Brand belum diatur",
          brandId: userData?.brandId,
          division: userData?.division
        });
      } catch (err) {
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
