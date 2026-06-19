import { NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { getAdminFirestore } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

function getRpConfig(origin: string) {
  try { return { rpID: new URL(origin).hostname }; }
  catch { return { rpID: 'localhost' }; }
}

export async function POST(req: NextRequest) {
  try {
    const origin = req.headers.get('origin') || 'http://localhost:9002';
    const { rpID } = getRpConfig(origin);

    // allowCredentials kosong = discoverable credentials (browser tampilkan picker)
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
      allowCredentials: [],
      timeout: 60000,
    });

    const db = getAdminFirestore();
    const { Timestamp } = require('firebase-admin/firestore');

    const challengeDoc = await db.collection('passkey_challenges').add({
      challenge: options.challenge,
      uid: null,
      purpose: 'auth',
      expiresAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
      createdAt: Timestamp.now(),
    });

    return NextResponse.json({ ...options, challengeId: challengeDoc.id });
  } catch (err: any) {
    console.error('[passkey/auth-start]', err.message);
    return NextResponse.json({ error: err.message || 'Error tidak diketahui' }, { status: 500 });
  }
}
