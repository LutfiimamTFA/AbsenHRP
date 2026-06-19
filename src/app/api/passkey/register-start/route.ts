import { NextRequest, NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

function getRpConfig(origin: string) {
  try {
    const url = new URL(origin);
    return { rpID: url.hostname, rpName: 'HRP Environesia', origin };
  } catch {
    return { rpID: 'localhost', rpName: 'HRP Environesia', origin };
  }
}

export async function POST(req: NextRequest) {
  try {
    const { idToken } = await req.json();
    if (!idToken) return NextResponse.json({ error: 'idToken diperlukan' }, { status: 400 });

    const adminAuth = getAdminAuth();
    const decoded   = await adminAuth.verifyIdToken(idToken);
    const uid       = decoded.uid;
    const email     = decoded.email || uid;
    const displayName = decoded.name || email;

    const origin = req.headers.get('origin') || 'http://localhost:9002';
    const { rpID, rpName } = getRpConfig(origin);

    // Ambil passkey yang sudah ada untuk user ini (untuk excludeCredentials)
    const db        = getAdminFirestore();
    const existing  = await db.collection('passkeys')
      .where('uid', '==', uid)
      .where('isActive', '==', true)
      .get();

    const excludeCredentials = existing.docs.map(doc => ({
      id: doc.data().credentialId as string, // base64url string
      type: 'public-key' as const,
    }));

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: Buffer.from(uid),
      userName: email,
      userDisplayName: displayName,
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        requireResidentKey: true,
        residentKey: 'required',
        userVerification: 'preferred',
      },
      excludeCredentials,
      timeout: 60000,
    });

    // Simpan challenge sementara (5 menit TTL)
    const { Timestamp } = require('firebase-admin/firestore');
    const challengeDoc = await db.collection('passkey_challenges').add({
      challenge: options.challenge,
      uid,
      purpose: 'register',
      expiresAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
      createdAt: Timestamp.now(),
    });

    return NextResponse.json({ ...options, challengeId: challengeDoc.id });
  } catch (err: any) {
    console.error('[passkey/register-start]', err.message);
    return NextResponse.json({ error: err.message || 'Error tidak diketahui' }, { status: 500 });
  }
}
