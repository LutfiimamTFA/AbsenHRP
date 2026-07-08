import { NextRequest, NextResponse } from 'next/server';
import { getAdminFirestore } from '@/lib/firebase-admin';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import webpush from 'web-push';

export const runtime = 'nodejs';

const VAPID_PUBLIC  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY!;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

// Cron secret — optional, set CRON_SECRET in env to protect this endpoint
const CRON_SECRET = process.env.CRON_SECRET || null;

function parseHHMM(hhmm: string): { h: number; m: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { h: h ?? 0, m: m ?? 0 };
}

function toWIBDate(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(now);
}

function toLocalMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour')!.value);
  const m = parseInt(parts.find(p => p.type === 'minute')!.value);
  return h * 60 + m;
}

function getLocalWeekday(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now).toLowerCase();
}

const WEEKDAY_MAP: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

export async function POST(req: NextRequest) {
  // Auth check
  if (CRON_SECRET) {
    const auth = req.headers.get('Authorization') || req.headers.get('x-cron-secret') || '';
    if (!auth.includes(CRON_SECRET)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const db = getAdminFirestore();
  const now = new Date();
  const results = { sent: 0, failed: 0, skipped: 0, errors: [] as string[] };

  try {
    // 1. Ambil semua active sites
    const sitesSnap = await db.collection('attendance_sites')
      .where('isActive', '==', true).get();

    for (const siteDoc of sitesSnap.docs) {
      const site = siteDoc.data();
      const siteId = siteDoc.id;
      const tz = site.timezone || 'Asia/Jakarta';
      const startTime: string = site.shift?.startTime || '08:00';
      const endTime: string   = site.shift?.endTime   || '17:00';
      const workDays: number[] = site.shift?.workDays ?? [1, 2, 3, 4, 5];
      const reminderMinutes = 15;

      const nowLocalMin = toLocalMinutes(now, tz);
      const todayStr    = toWIBDate(now, tz);
      const weekday     = getLocalWeekday(now, tz);
      const weekdayNum  = WEEKDAY_MAP[weekday] ?? -1;

      // Cek hari kerja
      if (!workDays.includes(weekdayNum)) continue;

      const { h: sH, m: sM } = parseHHMM(startTime);
      const { h: eH, m: eM } = parseHHMM(endTime);
      const startMin = sH * 60 + sM;
      const endMin   = eH * 60 + eM;

      const isCheckInWindow  = nowLocalMin === startMin - reminderMinutes;
      const isCheckOutWindow = nowLocalMin === endMin   - reminderMinutes;
      if (!isCheckInWindow && !isCheckOutWindow) continue;

      // 2. Ambil tokens aktif untuk site ini
      const tokensSnap = await db.collection('attendance_notification_tokens')
        .where('siteId', '==', siteId)
        .where('enabled', '==', true)
        .get();

      if (tokensSnap.empty) continue;

      for (const tokenDoc of tokensSnap.docs) {
        const token = tokenDoc.data();
        const uid = token.uid as string;

        // 3. Cek apakah sudah ada attendance hari ini
        const type = isCheckInWindow ? 'check_in_reminder' : 'check_out_reminder';

        // Cek log — jangan kirim dobel
        const logKey = `${uid}_${type}_${todayStr}`;
        const logSnap = await db.collection('attendance_notification_logs')
          .where('uid', '==', uid)
          .where('type', '==', type)
          .where('date', '==', todayStr)
          .where('status', '==', 'sent')
          .limit(1)
          .get();
        if (!logSnap.empty) { results.skipped++; continue; }

        // 4. Cek status absen hari ini
        const attendanceSnap = await db.collection('attendance_events')
          .where('uid', '==', uid)
          .where('attendanceDate', '==', todayStr)
          .limit(2)
          .get();

        const events = attendanceSnap.docs.map(d => d.data());
        const hasIn  = events.some(e => e.type === 'IN');
        const hasOut = events.some(e => e.type === 'OUT');

        let skipReason: string | null = null;
        if (type === 'check_in_reminder') {
          if (!token.reminderCheckIn) skipReason = 'reminder_check_in_disabled';
          else if (hasIn) skipReason = 'already_checked_in';
        } else {
          if (!token.reminderCheckOut) skipReason = 'reminder_check_out_disabled';
          else if (!hasIn) skipReason = 'not_checked_in_yet';
          else if (hasOut) skipReason = 'already_checked_out';
        }

        const logBase = {
          uid,
          type,
          date: todayStr,
          scheduledFor: type === 'check_in_reminder'
            ? `${String(sH - Math.floor(reminderMinutes / 60)).padStart(2,'0')}:${String(sM - (reminderMinutes % 60)).padStart(2,'0')}`
            : `${String(eH - Math.floor(reminderMinutes / 60)).padStart(2,'0')}:${String(eM - (reminderMinutes % 60)).padStart(2,'0')}`,
          sentAt: now.toISOString(),
          siteId,
          createdAt: FieldValue.serverTimestamp(),
        };

        if (skipReason) {
          await db.collection('attendance_notification_logs').add({
            ...logBase, status: 'skipped', reason: skipReason,
          });
          results.skipped++;
          continue;
        }

        // 5. Kirim push notification
        const title = type === 'check_in_reminder'
          ? 'Pengingat Absen Masuk'
          : 'Pengingat Absen Pulang';
        const body = type === 'check_in_reminder'
          ? `Jam masuk hari ini ${startTime} WIB. Jangan lupa absen masuk.`
          : `Jam pulang hari ini ${endTime} WIB. Jangan lupa absen pulang.`;

        const payload = JSON.stringify({ title, body, url: '/absen', type });

        try {
          await webpush.sendNotification(token.subscription, payload);
          await db.collection('attendance_notification_logs').add({
            ...logBase, status: 'sent', reason: null,
          });
          await tokenDoc.ref.update({ lastUsedAt: FieldValue.serverTimestamp() });
          results.sent++;
        } catch (err: any) {
          const status = err?.statusCode;
          // 410 Gone / 404 = subscription tidak valid lagi
          if (status === 410 || status === 404) {
            await tokenDoc.ref.update({ enabled: false, updatedAt: FieldValue.serverTimestamp() });
          }
          await db.collection('attendance_notification_logs').add({
            ...logBase, status: 'failed', reason: err?.message || 'push_error',
          });
          results.failed++;
          results.errors.push(`${uid}: ${err?.message}`);
        }
      }
    }

    return NextResponse.json({ success: true, ...results, checkedAt: now.toISOString() });
  } catch (err: any) {
    console.error('[send-reminders]', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
