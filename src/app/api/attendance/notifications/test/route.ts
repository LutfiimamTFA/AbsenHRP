import { NextRequest, NextResponse } from 'next/server';
import { getAdminFirestore, getAdminAuth } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import webpush from 'web-push';

export const runtime = 'nodejs';

const VAPID_PUBLIC  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

export async function POST(req: NextRequest) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return NextResponse.json({ error: 'VAPID keys tidak dikonfigurasi' }, { status: 500 });
  }

  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return NextResponse.json({ error: 'Authorization wajib' }, { status: 401 });
  }

  let uid: string;
  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    uid = decoded.uid;
  } catch (err: any) {
    return NextResponse.json({ error: 'Token tidak valid' }, { status: 401 });
  }

  const db = getAdminFirestore();
  const tokensSnap = await db.collection('attendance_notification_tokens')
    .where('uid', '==', uid)
    .limit(10)
    .get();
  const activeTokenDocs = tokensSnap.docs.filter(doc => {
    const data = doc.data();
    return data.enabled !== false && data.isActive !== false && !!data.subscription?.endpoint;
  }).slice(0, 5);

  if (activeTokenDocs.length === 0) {
    return NextResponse.json({ error: 'Tidak ada subscription aktif untuk akun ini' }, { status: 404 });
  }

  const payload = JSON.stringify({
    title: 'Notifikasi Tes — EGS Attendance',
    body: 'Push notification berhasil! Sistem notifikasi absen siap digunakan.',
    url: '/absen',
    type: 'test',
  });

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const tokenDoc of activeTokenDocs) {
    const tokenData = tokenDoc.data();
    try {
      await webpush.sendNotification(tokenData.subscription, payload);
      await tokenDoc.ref.update({
        lastUsedAt: FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
        enabled: true,
        isActive: true,
      });
      await db.collection('notification_tokens').doc(tokenDoc.id).set({
        lastUsedAt: FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
        enabled: true,
        isActive: true,
      }, { merge: true });
      sent++;
    } catch (err: any) {
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        await tokenDoc.ref.update({
          enabled: false,
          isActive: false,
          updatedAt: FieldValue.serverTimestamp(),
          lastError: err?.message || 'invalid_push_subscription',
        });
        await db.collection('notification_tokens').doc(tokenDoc.id).set({
          enabled: false,
          isActive: false,
          updatedAt: FieldValue.serverTimestamp(),
          lastError: err?.message || 'invalid_push_subscription',
        }, { merge: true });
      }
      failed++;
      errors.push(err?.message || 'unknown');
    }
  }

  if (sent > 0) {
    return NextResponse.json({ success: true, sent, failed });
  } else {
    return NextResponse.json({
      success: false,
      sent,
      failed,
      errors,
      error: 'Token notifikasi tidak valid. Silakan aktifkan ulang.',
    }, { status: 500 });
  }
}
