'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { useAuth, useUser } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LogIn, Loader2, Eye, EyeOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

const REMEMBERED_EMAIL_KEY = 'hrp_remembered_email';

export default function LoginPage() {
  const [email, setEmail]           = useState('');
  const [password, setPassword]     = useState('');
  const [showPw, setShowPw]         = useState(false);
  const [rememberEmail, setRememberEmail] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const router    = useRouter();
  const { toast } = useToast();
  const auth      = useAuth();
  const { user, loading } = useUser();

  // Isi email dari localStorage saat halaman dibuka
  useEffect(() => {
    const saved = localStorage.getItem(REMEMBERED_EMAIL_KEY);
    if (saved) setEmail(saved);
  }, []);

  // Redirect ke /absen jika sudah login
  useEffect(() => {
    if (!loading && user) router.push('/absen');
  }, [user, loading, router]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);

      // Simpan atau hapus email sesuai pilihan user
      if (rememberEmail && email) {
        localStorage.setItem(REMEMBERED_EMAIL_KEY, email);
      } else {
        localStorage.removeItem(REMEMBERED_EMAIL_KEY);
      }

      router.push('/absen');
    } catch (error: any) {
      const msg =
        error.code === 'auth/invalid-credential' || error.code === 'auth/wrong-password'
          ? 'Email atau password salah.'
          : error.code === 'auth/user-not-found'
          ? 'Akun tidak ditemukan.'
          : error.code === 'auth/too-many-requests'
          ? 'Terlalu banyak percobaan. Coba lagi nanti.'
          : error.message || 'Login gagal.';
      toast({ variant: 'destructive', title: 'Login gagal', description: msg });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return null;

  return (
    <div
      className="min-h-svh flex flex-col items-center justify-center p-4"
      style={{ background: 'linear-gradient(135deg, #0f172a 0%, #134e4a 60%, #0f766e 100%)' }}
    >
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl overflow-hidden">

        {/* Header branding */}
        <div
          className="px-7 pt-8 pb-6 text-center"
          style={{ background: 'linear-gradient(135deg, #0f766e 0%, #134e4a 100%)' }}
        >
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg overflow-hidden bg-white"
            style={{ border: '2px solid rgba(255,255,255,0.45)' }}
          >
            <img src="/icon-192.png" alt="EGS Attendance" className="w-full h-full object-cover" />
          </div>
          <h1 className="text-xl font-black text-white tracking-tight">EGS Attendance</h1>
          <p className="text-sm text-teal-200 mt-0.5 font-medium">Attendance System</p>
        </div>

        {/* Form */}
        <form onSubmit={handleLogin} className="px-6 pt-6 pb-6 space-y-3">
          {/* Email */}
          <Input
            type="email"
            placeholder="Alamat email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={submitting}
            className="h-12 rounded-xl text-sm border-slate-200 focus-visible:ring-teal-500"
          />

          {/* Password */}
          <div className="relative">
            <Input
              type={showPw ? 'text' : 'password'}
              placeholder="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={submitting}
              className="h-12 rounded-xl text-sm border-slate-200 focus-visible:ring-teal-500 pr-11"
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowPw(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1"
              aria-label={showPw ? 'Sembunyikan password' : 'Tampilkan password'}
            >
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {/* Checkbox ingat email */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={rememberEmail}
              onChange={(e) => setRememberEmail(e.target.checked)}
              disabled={submitting}
              className="w-4 h-4 rounded accent-teal-600 cursor-pointer"
            />
            <span className="text-[11px] text-slate-500">Ingat email saya</span>
          </label>

          {/* Tombol masuk */}
          <Button
            type="submit"
            disabled={submitting}
            className="w-full h-12 rounded-xl text-sm font-semibold gap-2 bg-teal-700 hover:bg-teal-600 active:bg-teal-800 text-white mt-1"
          >
            {submitting
              ? <><Loader2 className="w-4 h-4 animate-spin" />Masuk…</>
              : <><LogIn className="w-4 h-4" />Masuk</>
            }
          </Button>

          {/* Hint password manager */}
          <p className="text-center text-[9px] text-slate-400 leading-relaxed pt-1">
            Gunakan password manager browser agar login berikutnya lebih cepat.
          </p>
        </form>
      </div>

      <p className="mt-5 text-[10px] text-teal-300/40 text-center">
        © Environesia Group & Greenlab · Attendance System
      </p>
    </div>
  );
}
