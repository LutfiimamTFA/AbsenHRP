import { NextRequest, NextResponse } from 'next/server';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

function getRpConfig(req: NextRequest) {
  const origin = req.headers.get('origin') ?? req.nextUrl.origin;
  try {
    return { rpID: new URL(origin).hostname, origin };
  } catch {
    return { rpID: 'localhost', origin: 'http://localhost:9002' };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { idToken, challengeId, response, deviceName } = body;

    if (!idToken || !challengeId || !response) {
      return NextResponse.json(
        { error: 'idToken, challengeId, dan response diperlukan' },
        { status: 400 }
      );
    }

    // Verifikasi Firebase ID token
    const adminAuth = getAdminAuth();
    const decoded   = await adminAuth.verifyIdToken(idToken);
    const uid       = decoded.uid;

    const { rpID, origin } = getRpConfig(req);
    console.log('[passkey/register-finish] uid=', uid, 'rpID=', rpID);

    const db = getAdminFirestore();

    // Ambil dan validasi challenge
    const challengeRef  = db.collection('passkey_challenges').doc(challengeId);
    const challengeSnap = await challengeRef.get();
    if (!challengeSnap.exists) {
      return NextResponse.json({ error: 'Challenge tidak valid atau sudah kedaluwarsa.' }, { status: 400 });
    }
    const challengeData = challengeSnap.data()!;
    if (challengeData.uid !== uid) {
      return NextResponse.json({ error: 'Challenge tidak cocok dengan user.' }, { status: 403 });
    }
    if (challengeData.expiresAt.toMillis() < Date.now()) {
      await challengeRef.delete();
      return NextResponse.json({ error: 'Challenge kedaluwarsa. Coba lagi.' }, { status: 400 });
    }

    // Verifikasi respons WebAuthn
    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeData.challenge,
      expectedOrigin:    origin,
      expectedRPID:      rpID,
      requireUserVerification: false,
    });

    if (!verified || !registrationInfo) {
      return NextResponse.json({ error: 'Verifikasi passkey gagal.' }, { status: 401 });
    }

    const { credential } = registrationInfo;
    const credentialId   = Buffer.from(credential.id).toString('base64url');
    const publicKey      = Buffer.from(credential.publicKey).toString('base64url');
    const transports     = (response.response?.transports as string[] | undefined) ?? [];

    // Simpan passkey di Firestore (via Admin SDK — bypass security rules)
    await db.collection('passkeys').doc(credentialId).set({
      credentialId,
      publicKey,
      counter:    credential.counter,
      transports,
      uid,
      deviceName: deviceName || req.headers.get('user-agent')?.match(/\(([^)]+)\)/)?.[1] || 'Perangkat',
      userAgent:  req.headers.get('user-agent') ?? '',
      isActive:   true,
      createdAt:  Timestamp.now(),
      lastUsedAt: Timestamp.now(),
    });

    // Hapus challenge setelah dipakai
    await challengeRef.delete();

    console.log('[passkey/register-finish] Passkey disimpan credentialId=', credentialId);
    return NextResponse.json({ success: true, credentialId });
  } catch (err: any) {
    console.error('[PASSKEY REGISTER FINISH ERROR]', err?.message ?? err);
    return NextResponse.json(
      {
        success: false,
        message: 'Gagal menyelesaikan registrasi Login Cepat.',
        error:   err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
