import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

function getRpConfig(origin: string) {
  try { return { rpID: new URL(origin).hostname, origin }; }
  catch { return { rpID: 'localhost', origin }; }
}

export async function POST(req: NextRequest) {
  try {
    const { challengeId, response } = await req.json();
    if (!challengeId || !response) {
      return NextResponse.json({ error: 'challengeId dan response diperlukan' }, { status: 400 });
    }

    const origin = req.headers.get('origin') || 'http://localhost:9002';
    const { rpID } = getRpConfig(origin);

    const db = getAdminFirestore();
    const { Timestamp } = require('firebase-admin/firestore');

    // Ambil dan validasi challenge
    const challengeRef  = db.collection('passkey_challenges').doc(challengeId);
    const challengeSnap = await challengeRef.get();
    if (!challengeSnap.exists) {
      return NextResponse.json({ error: 'Challenge tidak valid atau sudah kedaluwarsa.' }, { status: 400 });
    }
    const challengeData = challengeSnap.data()!;
    if (challengeData.expiresAt.toMillis() < Date.now()) {
      await challengeRef.delete();
      return NextResponse.json({ error: 'Challenge kedaluwarsa. Coba lagi.' }, { status: 400 });
    }

    // Temukan passkey berdasarkan credentialId yang dikirim browser
    const credentialId  = response.id as string; // base64url
    const passkeyRef    = db.collection('passkeys').doc(credentialId);
    const passkeySnap   = await passkeyRef.get();
    if (!passkeySnap.exists) {
      return NextResponse.json({
        error: 'Passkey tidak ditemukan. Silakan login dengan email dan password.'
      }, { status: 404 });
    }
    const pk = passkeySnap.data()!;

    if (!pk.isActive) {
      return NextResponse.json({ error: 'Passkey ini sudah dinonaktifkan.' }, { status: 403 });
    }

    // Verifikasi assertion WebAuthn
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id:         pk.credentialId,                           // base64url string
        publicKey:  Buffer.from(pk.publicKey, 'base64url'),   // Uint8Array
        counter:    pk.counter,
        transports: pk.transports,
      },
      requireUserVerification: false,
    });

    if (!verified) {
      return NextResponse.json({ error: 'Verifikasi passkey gagal.' }, { status: 401 });
    }

    // Update counter dan lastUsedAt
    await passkeyRef.update({
      counter: authenticationInfo.newCounter,
      lastUsedAt: Timestamp.now(),
    });

    // Hapus challenge setelah dipakai
    await challengeRef.delete();

    // Buat Firebase custom token untuk user pemilik passkey ini
    const adminAuth   = getAdminAuth();
    const customToken = await adminAuth.createCustomToken(pk.uid);

    return NextResponse.json({ customToken, uid: pk.uid });
  } catch (err: any) {
    console.error('[passkey/auth-finish]', err.message);
    return NextResponse.json({ error: err.message || 'Error tidak diketahui' }, { status: 500 });
  }
}
