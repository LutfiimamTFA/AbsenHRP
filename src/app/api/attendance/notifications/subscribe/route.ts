import { NextRequest, NextResponse } from 'next/server';
import { getAdminFirestore, getAdminAuth } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { subscription, uid, employeeName, employeeEmail, brandId, siteId, platform, userAgent } = body;

    if (!subscription?.endpoint || !uid) {
      return NextResponse.json({ error: 'subscription dan uid wajib diisi' }, { status: 400 });
    }

    // Verify uid via Firebase Admin Auth token
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

    // Cari token yang sudah ada untuk endpoint ini
    const existing = await db.collection('attendance_notification_tokens')
      .where('uid', '==', uid)
      .where('subscription.endpoint', '==', subscription.endpoint)
      .limit(1)
      .get();

    const data = {
      uid,
      employeeName: employeeName || null,
      employeeEmail: employeeEmail || null,
      brandId: brandId || null,
      siteId: siteId || null,
      subscription,
      platform: platform || 'web',
      userAgent: userAgent || null,
      enabled: true,
      reminderCheckIn: true,
      reminderCheckOut: true,
      reminderMinutesBefore: 15,
      permissionStatus: 'granted',
      updatedAt: FieldValue.serverTimestamp(),
      lastUsedAt: FieldValue.serverTimestamp(),
    };

    if (!existing.empty) {
      await existing.docs[0].ref.update(data);
      return NextResponse.json({ success: true, action: 'updated', id: existing.docs[0].id });
    } else {
      const ref = await db.collection('attendance_notification_tokens').add({
        ...data,
        createdAt: FieldValue.serverTimestamp(),
      });
      return NextResponse.json({ success: true, action: 'created', id: ref.id });
    }
  } catch (err: any) {
    console.error('[subscribe]', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
