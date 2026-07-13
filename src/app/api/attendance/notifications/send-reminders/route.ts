import { NextRequest, NextResponse } from 'next/server';
import { getAdminFirestore } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import webpush from 'web-push';

export const runtime = 'nodejs';

const VAPID_PUBLIC  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('[send-reminders] VAPID keys missing — push will not work');
} else {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

const CRON_SECRET = process.env.CRON_SECRET || null;
// Toleransi window: kirim jika nowLocalMin berada dalam [target, target+WINDOW_MINUTES)
const WINDOW_MINUTES = 3;

function parseHHMM(hhmm: string): { h: number; m: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { h: isNaN(h) ? 0 : h, m: isNaN(m) ? 0 : m };
}

function toWIBDate(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(now);
}

function toLocalMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0');
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0');
  return h * 60 + m;
}

function getLocalWeekday(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now).toLowerCase();
}

/** Format HH:MM safely, subtracting minutes and handling carry */
function minutesToHHMM(totalMinutes: number): string {
  const normalised = ((totalMinutes % 1440) + 1440) % 1440; // wrap negative
  const h = Math.floor(normalised / 60);
  const m = normalised % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const WEEKDAY_MAP: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

export async function POST(req: NextRequest) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return NextResponse.json({ error: 'VAPID keys not configured' }, { status: 500 });
  }

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
      const weekdayNum  = WEEKDAY_MAP[getLocalWeekday(now, tz)] ?? -1;

      if (!workDays.includes(weekdayNum)) continue;

      const { h: sH, m: sM } = parseHHMM(startTime);
      const { h: eH, m: eM } = parseHHMM(endTime);
      const startMin = sH * 60 + sM;
      const endMin   = eH * 60 + eM;

      const checkInTarget  = startMin - reminderMinutes;
      const checkOutTarget = endMin   - reminderMinutes;

      // Window tolerance: [target, target + WINDOW_MINUTES)
      const isCheckInWindow  = nowLocalMin >= checkInTarget  && nowLocalMin < checkInTarget  + WINDOW_MINUTES;
      const isCheckOutWindow = nowLocalMin >= checkOutTarget && nowLocalMin < checkOutTarget + WINDOW_MINUTES;
      if (!isCheckInWindow && !isCheckOutWindow) continue;

      // Ambil tokens yang memiliki siteId ini ATAU brandId yang sama dan siteId null
      const brandId = site.brandId || null;
      const [tokensBySite, tokensByBrand] = await Promise.all([
        db.collection('attendance_notification_tokens')
          .where('siteId', '==', siteId)
          .where('enabled', '==', true)
          .get(),
        brandId
          ? db.collection('attendance_notification_tokens')
              .where('brandId', '==', brandId)
              .where('siteId', '==', null)
              .where('enabled', '==', true)
              .get()
          : Promise.resolve({ docs: [] as any[] }),
      ]);

      // Deduplicate by doc ID
      const tokenMap = new Map<string, any>();
      for (const d of [...tokensBySite.docs, ...tokensByBrand.docs]) tokenMap.set(d.id, d);

      for (const tokenDoc of tokenMap.values()) {
        const token = tokenDoc.data();
        const uid = token.uid as string;

        for (const [type, inWindow] of [
          ['check_in_reminder', isCheckInWindow],
          ['check_out_reminder', isCheckOutWindow],
        ] as [string, boolean][]) {
          if (!inWindow) continue;

          // Deterministic log ID untuk dedup
          const logDocId = `${uid}_${type}_${todayStr}`;
          const logRef = db.collection('attendance_notification_logs').doc(logDocId);
          const logSnap = await logRef.get();
          if (logSnap.exists && logSnap.data()?.status === 'sent') {
            results.skipped++;
            continue;
          }

          // Cek status absen hari ini
          const attendanceSnap = await db.collection('attendance_events')
            .where('uid', '==', uid)
            .where('attendanceDate', '==', todayStr)
            .limit(2)
            .get();

          const events = attendanceSnap.docs.map(d => d.data());
          const hasIn  = events.some(e => e.type === 'IN');
          const hasOut = events.some(e => e.type === 'OUT');

          const scheduledFor = type === 'check_in_reminder'
            ? minutesToHHMM(checkInTarget)
            : minutesToHHMM(checkOutTarget);

          const logBase = { uid, type, date: todayStr, scheduledFor, sentAt: now.toISOString(), siteId };

          let skipReason: string | null = null;
          if (type === 'check_in_reminder') {
            if (!token.reminderCheckIn) skipReason = 'reminder_check_in_disabled';
            else if (hasIn) skipReason = 'already_checked_in';
          } else {
            if (!token.reminderCheckOut) skipReason = 'reminder_check_out_disabled';
            else if (!hasIn) skipReason = 'not_checked_in_yet';
            else if (hasOut) skipReason = 'already_checked_out';
          }

          if (skipReason) {
            await logRef.set({ ...logBase, status: 'skipped', reason: skipReason, createdAt: FieldValue.serverTimestamp() });
            results.skipped++;
            continue;
          }

          const title = type === 'check_in_reminder' ? 'Pengingat Absen Masuk' : 'Pengingat Absen Pulang';
          const body  = type === 'check_in_reminder'
            ? `Jam masuk hari ini ${startTime} WIB. Jangan lupa absen masuk.`
            : `Jam pulang hari ini ${endTime} WIB. Jangan lupa absen pulang.`;
          const payload = JSON.stringify({ title, body, url: '/absen', type });

          try {
            await webpush.sendNotification(token.subscription, payload);
            await logRef.set({ ...logBase, status: 'sent', reason: null, createdAt: FieldValue.serverTimestamp() });
            await tokenDoc.ref.update({ lastUsedAt: FieldValue.serverTimestamp() });
            results.sent++;
          } catch (err: any) {
            if (err?.statusCode === 410 || err?.statusCode === 404) {
              await tokenDoc.ref.update({ enabled: false, updatedAt: FieldValue.serverTimestamp() });
            }
            await logRef.set({ ...logBase, status: 'failed', reason: err?.message || 'push_error', createdAt: FieldValue.serverTimestamp() }, { merge: true });
            results.failed++;
            results.errors.push(`${uid}: ${err?.message}`);
          }
        }
      }
    }

    return NextResponse.json({ success: true, ...results, checkedAt: now.toISOString() });
  } catch (err: any) {
    console.error('[send-reminders]', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
