import { NextRequest, NextResponse } from 'next/server';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

function getRpConfig(origin: string) {
  try {
    const url = new URL(origin);
    return { rpID: url.hostname, origin };
  } catch {
    return { rpID: 'localhost', origin };
  }
}

export async function POST(req: NextRequest) {
  try {
    const { idToken, challengeId, response, deviceName } = await req.json();
    if (!idToken || !challengeId || !response) {
      return NextResponse.json({ error: 'idToken, challengeId, dan response diperlukan' }, { status: 400 });
    }

    const adminAuth = getAdminAuth();
    const decoded   = await adminAuth.verifyIdToken(idToken);
    const uid       = decoded.uid;

    const origin = req.headers.get('origin') || 'http://localhost:9002';
    const { rpID } = getRpConfig(origin);

    const db = getAdminFirestore();
    const { Timestamp } = require('firebase-admin/firestore');

    // Ambil dan validasi challenge
    const challengeRef = db.collection('passkey_challenges').doc(challengeId);
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
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });

    if (!verified || !registrationInfo) {
      return NextResponse.json({ error: 'Verifikasi passkey gagal.' }, { status: 401 });
    }

    const { credential } = registrationInfo;
    const credentialId  = Buffer.from(credential.id).toString('base64url');
    const publicKey     = Buffer.from(credential.publicKey).toString('base64url');
    const counter       = credential.counter;
    const transports    = (response.response?.transports as string[] | undefined) ?? [];

    // Simpan passkey di Firestore
    await db.collection('passkeys').doc(credentialId).set({
      credentialId,
      publicKey,
      counter,
      transports,
      uid,
      deviceName: deviceName || 'Perangkat',
      userAgent: req.headers.get('user-agent') || '',
      isActive: true,
      createdAt: Timestamp.now(),
      lastUsedAt: Timestamp.now(),
    });

    // Hapus challenge setelah dipakai
    await challengeRef.delete();

    return NextResponse.json({ success: true, credentialId });
  } catch (err: any) {
    console.error('[passkey/register-finish]', err.message);
    return NextResponse.json({ error: err.message || 'Error tidak diketahui' }, { status: 500 });
  }
}
