import { NextRequest, NextResponse } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminFirestore } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const origin = req.headers.get('origin') ?? req.nextUrl.origin;
    let rpID = 'localhost';
    try { rpID = new URL(origin).hostname; } catch { /* noop */ }

    // allowCredentials kosong = discoverable credentials (browser tampilkan picker semua passkey)
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
      allowCredentials: [],
      timeout: 60000,
    });

    const db = getAdminFirestore();
    const challengeDoc = await db.collection('passkey_challenges').add({
      challenge: options.challenge,
      uid:       null,
      purpose:   'auth',
      expiresAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
      createdAt: Timestamp.now(),
    });

    return NextResponse.json({ ...options, challengeId: challengeDoc.id });
  } catch (err: any) {
    console.error('[PASSKEY AUTH START ERROR]', err?.message ?? err);
    return NextResponse.json(
      {
        success: false,
        message: 'Gagal memulai Login Cepat.',
        error:   err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
