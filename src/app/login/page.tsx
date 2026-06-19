'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signInWithEmailAndPassword, signInWithCustomToken } from 'firebase/auth';
import { useAuth, useUser } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LogIn, Fingerprint, Loader2, Eye, EyeOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

export default function LoginPage() {
  const [email, setEmail]           = useState('');
  const [password, setPassword]     = useState('');
  const [showPw, setShowPw]         = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [passkeyLoading, setPasskeyLoading]     = useState(false);
  const [passkeySupported, setPasskeySupported] = useState(false);

  const router    = useRouter();
  const { toast } = useToast();
  const auth      = useAuth();
  const { user, loading } = useUser();

  useEffect(() => {
    if (!loading && user) router.push('/absen');
  }, [user, loading, router]);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.PublicKeyCredential) {
      setPasskeySupported(true);
    }
  }, []);

  // ── Login email & password ────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
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

  // ── Login Cepat (Passkey/WebAuthn) ────────────────────────────────────────
  const handlePasskeyLogin = async () => {
    if (!passkeySupported) {
      toast({
        title: 'Login Cepat tidak tersedia',
        description: 'Perangkat ini belum mendukung Login Cepat. Silakan masuk dengan email dan password.',
      });
      return;
    }
    setPasskeyLoading(true);
    try {
      const startRes = await fetch('/api/passkey/auth-start', { method: 'POST' });
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => ({}));
        throw new Error(err.error || 'Gagal memulai Login Cepat.');
      }
      const { challengeId, ...authOptions } = await startRes.json();

      const { startAuthentication } = await import('@simplewebauthn/browser');
      const response = await startAuthentication({ optionsJSON: authOptions });

      const finishRes = await fetch('/api/passkey/auth-finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId, response }),
      });
      if (!finishRes.ok) {
        const err = await finishRes.json().catch(() => ({}));
        throw new Error(err.error || 'Verifikasi gagal.');
      }
      const { customToken } = await finishRes.json();

      await signInWithCustomToken(auth, customToken);
      router.push('/absen');
    } catch (error: any) {
      const msg =
        error.name === 'NotAllowedError'
          ? 'Dibatalkan. Silakan coba lagi.'
          : error.name === 'NotSupportedError'
          ? 'Perangkat ini tidak mendukung Passkey.'
          : error.message || 'Login Cepat gagal. Coba masuk dengan email dan password.';
      toast({ variant: 'destructive', title: 'Login Cepat gagal', description: msg });
    } finally {
      setPasskeyLoading(false);
    }
  };

  if (loading) return null;

  return (
    <div
      className="min-h-svh flex flex-col items-center justify-center p-4"
      style={{ background: 'linear-gradient(135deg, #0f172a 0%, #134e4a 60%, #0f766e 100%)' }}
    >
      {/* Card utama */}
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-2xl overflow-hidden">

        {/* Header branding */}
        <div
          className="px-7 pt-8 pb-6 text-center"
          style={{ background: 'linear-gradient(135deg, #0f766e 0%, #134e4a 100%)' }}
        >
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg"
            style={{ background: 'rgba(255,255,255,0.15)', border: '2px solid rgba(255,255,255,0.3)' }}
          >
            <span className="text-white font-black text-3xl tracking-tight">H</span>
          </div>
          <h1 className="text-xl font-black text-white tracking-tight">HRP Environesia</h1>
          <p className="text-sm text-teal-200 mt-0.5 font-medium">Human Capital Portal</p>
        </div>

        {/* Form area */}
        <div className="px-6 pt-6 pb-5 space-y-3">

          {/* Email */}
          <Input
            type="email"
            placeholder="Alamat email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={submitting || passkeyLoading}
            className="h-12 rounded-xl text-sm border-slate-200 focus-visible:ring-teal-500"
          />

          {/* Password dengan toggle show/hide */}
          <div className="relative">
            <Input
              type={showPw ? 'text' : 'password'}
              placeholder="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={submitting || passkeyLoading}
              className="h-12 rounded-xl text-sm border-slate-200 focus-visible:ring-teal-500 pr-11"
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowPw(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1"
            >
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {/* Baris aksi: [Masuk (flex-1)] [Sidik Jari (kotak)] */}
          <form onSubmit={handleLogin}>
            <div className="flex gap-2">
              {/* Tombol Masuk utama */}
              <Button
                type="submit"
                disabled={submitting || passkeyLoading}
                className="flex-1 h-12 rounded-xl text-sm font-semibold gap-2 bg-slate-800 hover:bg-slate-700 active:bg-slate-900 text-white"
              >
                {submitting
                  ? <><Loader2 className="w-4 h-4 animate-spin" />Masuk…</>
                  : <><LogIn className="w-4 h-4" />Masuk</>
                }
              </Button>

              {/* Tombol Login Cepat — icon sidik jari, selalu tampil */}
              <button
                type="button"
                onClick={handlePasskeyLogin}
                disabled={submitting || passkeyLoading}
                title="Login Cepat (sidik jari / Face ID / PIN)"
                aria-label="Login Cepat"
                className="w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 border-2 transition-all active:scale-95 disabled:opacity-40"
                style={{
                  borderColor: '#0f766e',
                  background: passkeyLoading ? '#0f766e10' : 'transparent',
                  color: '#0f766e',
                  minWidth: '3rem',
                  flexShrink: 0,
                }}
              >
                {passkeyLoading
                  ? <Loader2 className="w-5 h-5 animate-spin" />
                  : <Fingerprint className="w-5 h-5" />
                }
                <span className="text-[7px] font-bold leading-none tracking-tight">
                  {passkeyLoading ? '…' : 'Cepat'}
                </span>
              </button>
            </div>
          </form>
        </div>

        {/* Footer info */}
        <div className="px-6 pb-6">
          <p className="text-center text-[9px] text-slate-400 leading-relaxed">
            <Fingerprint className="inline w-2.5 h-2.5 mb-px mr-0.5 opacity-60" />
            Login Cepat: sidik jari, Face ID, Windows Hello, atau PIN perangkat
            <br />
            Perlu diaktifkan pada setiap perangkat yang digunakan
          </p>
        </div>
      </div>

      <p className="mt-5 text-[10px] text-teal-300/40 text-center">
        © Environesia · Human Capital Portal
      </p>
    </div>
  );
}
