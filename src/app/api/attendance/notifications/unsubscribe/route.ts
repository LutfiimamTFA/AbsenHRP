import { NextRequest, NextResponse } from 'next/server';
import { getAdminFirestore, getAdminAuth } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { uid, endpoint } = body;

    if (!uid) {
      return NextResponse.json({ error: 'uid wajib diisi' }, { status: 400 });
    }

    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (token) {
      try {
        const decoded = await getAdminAuth().verifyIdToken(token);
        if (decoded.uid !== uid) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
        }
      } catch {
        return NextResponse.json({ error: 'Token tidak valid' }, { status: 401 });
      }
    }

    const db = getAdminFirestore();

    const q = endpoint
      ? db.collection('attendance_notification_tokens')
          .where('uid', '==', uid)
          .where('subscription.endpoint', '==', endpoint)
          .limit(1)
      : db.collection('attendance_notification_tokens')
          .where('uid', '==', uid)
          .where('enabled', '==', true);

    const snap = await q.get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.update(d.ref, {
      enabled: false,
      updatedAt: FieldValue.serverTimestamp(),
    }));
    await batch.commit();

    return NextResponse.json({ success: true, disabled: snap.size });
  } catch (err: any) {
    console.error('[unsubscribe]', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
