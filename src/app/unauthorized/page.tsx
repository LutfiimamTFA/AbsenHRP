'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { useAuth, useUser } from '@/firebase';
import { Button } from '@/components/ui/button';
import { ShieldAlert, LogOut, Home } from 'lucide-react';

export default function UnauthorizedPage() {
  const { user } = useUser();
  const auth = useAuth();
  const router = useRouter();

  const handleLogout = async () => {
    await signOut(auth);
    router.push('/login');
  };

  return (
    <div className="min-h-svh bg-background flex flex-col items-center justify-center p-6 text-center">
      <div className="w-20 h-20 bg-destructive/10 rounded-full flex items-center justify-center text-destructive mb-6">
        <ShieldAlert className="w-10 h-10" />
      </div>
      <h1 className="text-2xl font-black mb-2 tracking-tight">Akses Dibatasi</h1>
      <p className="text-muted-foreground text-sm max-w-xs mb-8">
        Sistem absensi ini hanya dapat diakses oleh karyawan internal dan staf. Peran Anda saat ini <strong>({user?.role || 'Guest'})</strong> tidak memiliki izin untuk fitur ini.
        <br/><br/>
        Jika Anda seorang kandidat, harap hubungi HRD untuk instruksi selanjutnya.
      </p>
      
      <div className="flex flex-col w-full max-w-xs gap-3">
        <Button onClick={() => router.push('/')} variant="outline" className="rounded-xl h-12">
          <Home className="mr-2 h-4 w-4" /> Kembali
        </Button>
        <Button onClick={handleLogout} className="rounded-xl h-12">
          <LogOut className="mr-2 h-4 w-4" /> Keluar
        </Button>
      </div>
    </div>
  );
}
