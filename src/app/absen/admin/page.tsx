'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminRedirect() {
  const router = useRouter();

  useEffect(() => {
    // Portal monitoring admin ada di HRP, web absen hanya untuk absensi mandiri
    router.replace('/absen');
  }, [router]);

  return null;
}
