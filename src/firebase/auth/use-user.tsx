
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
  roleLabel: string;
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

        // 1. Resolve Name with Priorities
        let resolvedName = userData?.displayName || userData?.name || userData?.fullName;
        
        // Fallback to profiles/uid if users/uid is missing it
        if (!resolvedName) {
          const profileDoc = await getDoc(doc(db, 'profiles', firebaseUser.uid));
          if (profileDoc.exists()) {
            resolvedName = profileDoc.data()?.fullName;
          }
        }

        if (!resolvedName) {
          resolvedName = firebaseUser.displayName;
        }

        if (!resolvedName && firebaseUser.email) {
          // Use part before @ as fallback
          resolvedName = firebaseUser.email.split('@')[0];
        }

        // 2. Map Role Labels
        const roleLabels: Record<string, string> = {
          'karyawan': 'Karyawan',
          'employee': 'Karyawan',
          'hrd': 'HRD',
          'manager': 'Manager',
          'super-admin': 'Super Admin',
          'superadmin': 'Super Admin',
          'kandidat': 'Kandidat'
        };
        const userRoleLabel = roleLabels[resolvedRole] || resolvedRole;

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
          displayName: resolvedName || null,
          role: resolvedRole,
          roleLabel: userRoleLabel,
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
          displayName: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User',
          role: 'employee',
          roleLabel: 'Karyawan',
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
