import { NextRequest, NextResponse } from 'next/server';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

function getRpConfig(req: NextRequest) {
  const origin = req.headers.get('origin') ?? req.nextUrl.origin;
  try { return { rpID: new URL(origin).hostname, origin }; }
  catch { return { rpID: 'localhost', origin: 'http://localhost:9002' }; }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { challengeId, response } = body;

    if (!challengeId || !response) {
      return NextResponse.json({ error: 'challengeId dan response diperlukan' }, { status: 400 });
    }

    const { rpID, origin } = getRpConfig(req);
    const db = getAdminFirestore();

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
    const credentialId = response.id as string; // base64url
    const passkeySnap  = await db.collection('passkeys').doc(credentialId).get();
    if (!passkeySnap.exists) {
      return NextResponse.json(
        { error: 'Passkey tidak ditemukan. Silakan login dengan email dan password.' },
        { status: 404 }
      );
    }
    const pk = passkeySnap.data()!;

    if (!pk.isActive) {
      return NextResponse.json({ error: 'Passkey ini sudah dinonaktifkan.' }, { status: 403 });
    }

    // Verifikasi assertion WebAuthn
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeData.challenge,
      expectedOrigin:    origin,
      expectedRPID:      rpID,
      credential: {
        id:         pk.credentialId,
        publicKey:  Buffer.from(pk.publicKey, 'base64url'),
        counter:    pk.counter,
        transports: pk.transports,
      },
      requireUserVerification: false,
    });

    if (!verified) {
      return NextResponse.json({ error: 'Verifikasi passkey gagal.' }, { status: 401 });
    }

    // Update counter dan lastUsedAt
    await passkeySnap.ref.update({
      counter:    authenticationInfo.newCounter,
      lastUsedAt: Timestamp.now(),
    });

    // Hapus challenge setelah dipakai
    await challengeRef.delete();

    // Buat Firebase custom token untuk user pemilik passkey
    const adminAuth   = getAdminAuth();
    const customToken = await adminAuth.createCustomToken(pk.uid);

    console.log('[passkey/auth-finish] Login berhasil uid=', pk.uid);
    return NextResponse.json({ customToken, uid: pk.uid });
  } catch (err: any) {
    console.error('[PASSKEY AUTH FINISH ERROR]', err?.message ?? err);
    return NextResponse.json(
      {
        success: false,
        message: 'Gagal verifikasi Login Cepat.',
        error:   err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
