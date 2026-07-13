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

    // Auth token WAJIB — jangan izinkan tanpa verifikasi
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) {
      return NextResponse.json({ error: 'Authorization token wajib disertakan' }, { status: 401 });
    }
    try {
      const decoded = await getAdminAuth().verifyIdToken(token);
      if (decoded.uid !== uid) {
        return NextResponse.json({ error: 'uid tidak cocok dengan token' }, { status: 403 });
      }
    } catch (authErr: any) {
      return NextResponse.json({ error: 'Token tidak valid: ' + (authErr.message || '') }, { status: 401 });
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
      siteId: siteId || null,         // boleh null — server resolve by brandId
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

    let id: string;
    if (!existing.empty) {
      await existing.docs[0].ref.update(data);
      id = existing.docs[0].id;
    } else {
      const ref = await db.collection('attendance_notification_tokens').add({
        ...data,
        createdAt: FieldValue.serverTimestamp(),
      });
      id = ref.id;
    }

    return NextResponse.json({ success: true, id });
  } catch (err: any) {
    console.error('[subscribe]', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
