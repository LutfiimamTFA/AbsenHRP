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
  employeeId?: string;
  employmentType?: string;
  attendanceMethod?: string;
  employeeProfileFound?: boolean;
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
        // PRIORITAS UTAMA: ambil dari employee_profiles (source of truth HRP utama)
        const employeeProfileDoc = await getDoc(doc(db, 'employee_profiles', firebaseUser.uid));
        const ep = employeeProfileDoc.exists() ? employeeProfileDoc.data() : null;
        const employeeProfileFound = !!ep;

        // [DEBUG] Dump seluruh isi employee_profiles supaya bisa trace field yang dipakai
        console.log('[EMPLOYEE SYNC] authUid:', firebaseUser.uid);
        console.log('[EMPLOYEE SYNC] employeeProfile (raw):', ep ? JSON.parse(JSON.stringify(ep)) : null);

        // ── NAMA ──────────────────────────────────────────────────────────────
        let resolvedName: string | undefined =
          ep?.fullName || ep?.namaLengkap || ep?.displayName || ep?.name;

        // ── BRAND (string langsung) ───────────────────────────────────────────
        // Coba baca nilai string brand/perusahaan dari employee_profiles terlebih dulu
        let resolvedBrand: string | undefined =
          ep?.brandName    || ep?.companyName  || ep?.companyLabel ||
          ep?.company      || ep?.unitName     || ep?.brand        ||
          ep?.perusahaan   || ep?.namaPerusahaan;

        // ── BRAND (via reference ID) ──────────────────────────────────────────
        // Jika employee_profiles menyimpan brandId / companyId sebagai reference,
        // resolve ke nama dari collection brands / companies.
        const epBrandRefId: string | undefined =
          ep?.brandId || ep?.companyId || ep?.brandRef;

        if (!resolvedBrand && epBrandRefId) {
          // Coba kedua kemungkinan nama collection
          const [brandSnap, companySnap] = await Promise.all([
            getDoc(doc(db, 'brands', epBrandRefId)).catch(() => null),
            getDoc(doc(db, 'companies', epBrandRefId)).catch(() => null),
          ]);
          const refData = brandSnap?.exists()
            ? brandSnap.data()
            : companySnap?.exists() ? companySnap.data() : null;
          if (refData) {
            resolvedBrand =
              refData.brandName || refData.companyName || refData.name || refData.label;
          }
          console.log('[EMPLOYEE SYNC] brand via epBrandRefId', epBrandRefId, '→', resolvedBrand);
        }

        // ── DIVISI ────────────────────────────────────────────────────────────
        let division: string | undefined =
          ep?.divisionName || ep?.division || ep?.divisi ||
          ep?.departement  || ep?.department;

        // ── NOMOR INDUK KARYAWAN ──────────────────────────────────────────────
        // PENTING: JANGAN masukkan nik / nomorKtp / ktpNumber / identityNumber
        let resolvedEmployeeId: string | undefined =
          ep?.employeeId           || ep?.employeeNumber  ||
          ep?.employeeCode         || ep?.nomorIndukKaryawan ||
          ep?.nomorInduk           || ep?.nip             ||
          ep?.nomorKaryawan        || ep?.noKaryawan      ||
          ep?.kodeKaryawan         || ep?.nomorPegawai;

        let employmentType: string | undefined = ep?.employmentType;
        let attendanceMethod: string | undefined = ep?.attendanceMethod;

        // ── FALLBACK role dari users/{uid} ────────────────────────────────────
        let resolvedRole: UserRole = 'employee';
        const userDocRef = doc(db, 'users', firebaseUser.uid);
        const userDoc = await getDoc(userDocRef);
        const userData = userDoc.exists() ? userDoc.data() : null;

        if (userData?.role) resolvedRole = userData.role;

        // Fallback nama jika employee_profiles tidak ada
        if (!resolvedName) {
          resolvedName =
            firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User';
        }

        // Fallback brand — HANYA jika employee_profiles benar-benar tidak punya brand
        if (!resolvedBrand) {
          const fallbackBrandId = userData?.brandId;
          if (fallbackBrandId) {
            const brandDoc = await getDoc(doc(db, 'brands', fallbackBrandId));
            if (brandDoc.exists()) {
              const bd = brandDoc.data();
              resolvedBrand = bd?.brandName || bd?.companyName || bd?.name;
            }
          }
          if (!resolvedBrand) resolvedBrand = userData?.brandName;
        }

        // [DEBUG] Ringkasan nilai yang akan dipakai di UI
        console.log('[EMPLOYEE SYNC] resolved →', {
          resolvedBrand,
          resolvedEmployeeId,
          attendanceMethod,
          division,
          resolvedName,
        });

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

        const internalRoles: UserRole[] = ['superadmin', 'super-admin', 'hrd', 'manager', 'karyawan', 'employee'];
        const isInternal = internalRoles.includes(resolvedRole);
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
          division: division || userData?.division,
          employeeId,
          employmentType: employmentType || userData?.employmentType,
          attendanceMethod,
          employeeProfileFound,
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
