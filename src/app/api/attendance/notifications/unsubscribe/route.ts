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

    const snap = await db.collection('attendance_notification_tokens')
      .where('uid', '==', uid)
      .limit(20)
      .get();
    const docsToDisable = snap.docs.filter(doc => {
      const data = doc.data();
      if (endpoint) return data.subscription?.endpoint === endpoint;
      return data.enabled !== false || data.isActive !== false;
    });
    const batch = db.batch();
    docsToDisable.forEach(d => batch.update(d.ref, {
      enabled: false,
      isActive: false,
      updatedAt: FieldValue.serverTimestamp(),
    }));
    docsToDisable.forEach(d => batch.set(
      db.collection('notification_tokens').doc(d.id),
      {
        enabled: false,
        isActive: false,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    ));
    await batch.commit();

    return NextResponse.json({ success: true, disabled: docsToDisable.length });
  } catch (err: any) {
    console.error('[unsubscribe]', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
