'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminRedirect() {
  const router = useRouter();

  useEffect(() => {
    // Portal monitoring admin berada di HRP, web absen dialihkan ke halaman utama
    router.replace('/absen');
  }, [router]);

  return null;
}