import { NextRequest, NextResponse } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { Timestamp } from 'firebase-admin/firestore';
import { getAdminAuth, getAdminFirestore } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

function getRpConfig(req: NextRequest) {
  const origin = req.headers.get('origin') ?? req.nextUrl.origin;
  try {
    const url = new URL(origin);
    return { rpID: url.hostname, rpName: 'EGS Attendance', origin };
  } catch {
    return { rpID: 'localhost', rpName: 'EGS Attendance', origin: 'http://localhost:9002' };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { idToken } = body;
    if (!idToken) {
      return NextResponse.json({ error: 'idToken diperlukan' }, { status: 400 });
    }

    // Verifikasi Firebase ID token
    const adminAuth = getAdminAuth();
    const decoded   = await adminAuth.verifyIdToken(idToken);
    const uid         = decoded.uid;
    const email       = decoded.email ?? uid;
    const displayName = decoded.name ?? email;

    const { rpID, rpName, origin } = getRpConfig(req);
    console.log('[passkey/register-start] uid=', uid, 'rpID=', rpID, 'origin=', origin);

    // Ambil passkey aktif yang sudah ada (untuk excludeCredentials)
    const db       = getAdminFirestore();
    const existing = await db.collection('passkeys')
      .where('uid', '==', uid)
      .where('isActive', '==', true)
      .get();

    const excludeCredentials = existing.docs.map(d => ({
      id:   d.data().credentialId as string,
      type: 'public-key' as const,
    }));

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID:          Buffer.from(uid),
      userName:        email,
      userDisplayName: displayName,
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        requireResidentKey:      true,
        residentKey:             'required',
        userVerification:        'preferred',
      },
      excludeCredentials,
      timeout: 60000,
    });

    // Simpan challenge sementara (TTL 5 menit)
    const challengeDoc = await db.collection('passkey_challenges').add({
      challenge: options.challenge,
      uid,
      purpose:   'register',
      expiresAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
      createdAt: Timestamp.now(),
    });

    return NextResponse.json({ ...options, challengeId: challengeDoc.id });
  } catch (err: any) {
    console.error('[PASSKEY REGISTER START ERROR]', err?.message ?? err);
    return NextResponse.json(
      {
        success: false,
        message: 'Gagal memulai registrasi Login Cepat.',
        error:   err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
