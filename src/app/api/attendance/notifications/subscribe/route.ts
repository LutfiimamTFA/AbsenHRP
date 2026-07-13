import { NextRequest, NextResponse } from 'next/server';
import { getAdminFirestore, getAdminAuth } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      subscription,
      uid,
      employeeName,
      employeeEmail,
      brandId,
      brandName,
      siteId,
      platform,
      userAgent,
    } = body;

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
      .limit(20)
      .get();
    const existingDoc = existing.docs.find(doc => doc.data()?.subscription?.endpoint === subscription.endpoint);

    const data = {
      uid,
      employeeUid: uid,
      employeeName: employeeName || null,
      employeeEmail: employeeEmail || null,
      brandId: brandId || null,
      brandName: brandName || null,
      siteId: siteId || null,         // boleh null — server resolve by brandId
      token: subscription.endpoint,
      subscription,
      platform: platform || 'web',
      userAgent: userAgent || null,
      enabled: true,
      isActive: true,
      reminderCheckIn: true,
      reminderCheckOut: true,
      reminderMinutesBefore: 15,
      permissionStatus: 'granted',
      updatedAt: FieldValue.serverTimestamp(),
      lastUsedAt: FieldValue.serverTimestamp(),
      lastSeenAt: FieldValue.serverTimestamp(),
    };

    let id: string;
    if (existingDoc) {
      await existingDoc.ref.update(data);
      id = existingDoc.id;
    } else {
      const ref = await db.collection('attendance_notification_tokens').add({
        ...data,
        createdAt: FieldValue.serverTimestamp(),
      });
      id = ref.id;
    }

    await db.collection('notification_tokens').doc(id).set({
      ...data,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log('[WEB_PUSH_TOKEN_DEBUG]', {
      uid,
      permission: 'granted',
      tokenExists: !!subscription.endpoint,
      tokenSaved: true,
      tokenId: id,
      platform: data.platform,
    });

    return NextResponse.json({ success: true, id });
  } catch (err: any) {
    console.error('[subscribe]', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
