import { NextRequest, NextResponse } from 'next/server';
import { getAdminFirestore } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import type { Firestore, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import webpush from 'web-push';

export const runtime = 'nodejs';

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const CRON_SECRET = process.env.CRON_SECRET || null;
const WINDOW_MINUTES = Number(process.env.ATTENDANCE_REMINDER_WINDOW_MINUTES || 5);
const REMINDER_MINUTES = Number(process.env.ATTENDANCE_REMINDER_MINUTES_BEFORE || 15);
const DEFAULT_TZ = 'Asia/Jakarta';

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('[send-reminders] VAPID keys missing; push will not work');
} else {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

const DAY_ALIASES: Record<string, number> = {
  sunday: 0, sun: 0, minggu: 0, ahad: 0,
  monday: 1, mon: 1, senin: 1,
  tuesday: 2, tue: 2, selasa: 2,
  wednesday: 3, wed: 3, rabu: 3,
  thursday: 4, thu: 4, kamis: 4,
  friday: 5, fri: 5, jumat: 5, "jum'at": 5,
  saturday: 6, sat: 6, sabtu: 6,
};

function parseHHMM(value: unknown, fallback: string): { text: string; minutes: number } {
  const text = typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value) ? value : fallback;
  const [h, m] = text.split(':').map(Number);
  return { text, minutes: (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0) };
}

function minutesToHHMM(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getLocalParts(now: Date, tz: string) {
  const dateKey = new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(now);
  const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now).toLowerCase();
  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(timeParts.find(part => part.type === 'hour')?.value || 0);
  const minute = Number(timeParts.find(part => part.type === 'minute')?.value || 0);
  const second = Number(timeParts.find(part => part.type === 'second')?.value || 0);
  return {
    dateKey,
    weekdayNum: DAY_ALIASES[weekdayName] ?? -1,
    nowJakarta: `${dateKey} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')} ${tz}`,
    localMinutes: hour * 60 + minute,
  };
}

function dayValueToNumber(day: unknown): number | null {
  if (typeof day === 'number' && day >= 0 && day <= 6) return day;
  if (typeof day === 'number' && day >= 1 && day <= 7) return day % 7;
  if (typeof day === 'string') {
    const normalized = day.trim().toLowerCase();
    if (/^\d+$/.test(normalized)) {
      const parsed = Number(normalized);
      if (parsed >= 0 && parsed <= 6) return parsed;
      if (parsed >= 1 && parsed <= 7) return parsed % 7;
    }
    return DAY_ALIASES[normalized] ?? null;
  }
  return null;
}

function normalizeDays(value: unknown): number[] | null {
  if (!value) return null;
  const raw = Array.isArray(value) ? value : [value];
  const days = raw
    .map(dayValueToNumber)
    .filter((day): day is number => day !== null);
  return days.length > 0 ? Array.from(new Set(days)) : null;
}

function dateListIncludes(value: unknown, dateKey: string): boolean {
  if (!value) return false;
  const raw = Array.isArray(value) ? value : [value];
  return raw.some(item => {
    if (typeof item === 'string') return item === dateKey;
    if (item && typeof item === 'object') {
      const data = item as Record<string, unknown>;
      return data.date === dateKey || data.dateKey === dateKey;
    }
    return false;
  });
}

function getBrandIds(site: any): string[] {
  const raw = [
    ...(Array.isArray(site.brandIds) ? site.brandIds : []),
    site.brandId,
    site.companyId,
  ].filter(Boolean);
  return Array.from(new Set(raw.map(String)));
}

function resolveScheduleForToday(site: any, weekdayNum: number, dateKey: string) {
  if (
    dateListIncludes(site.holidays, dateKey) ||
    dateListIncludes(site.holidayDates, dateKey) ||
    dateListIncludes(site.nonWorkingDates, dateKey)
  ) {
    return { isHoliday: true as const, reason: 'site_holiday' };
  }

  const schedules = [
    ...(Array.isArray(site.workSchedules) ? site.workSchedules : []),
    ...(Array.isArray(site.schedules) ? site.schedules : []),
    ...(Array.isArray(site.shift?.workSchedules) ? site.shift.workSchedules : []),
  ];

  for (const schedule of schedules) {
    if (!schedule || schedule.isActive === false || schedule.enabled === false) continue;
    if (dateListIncludes(schedule.holidays, dateKey) || schedule.isHoliday === true) {
      return { isHoliday: true as const, reason: 'schedule_holiday' };
    }
    const days = normalizeDays(schedule.days ?? schedule.workDays ?? schedule.weekdays ?? schedule.dayOfWeek ?? schedule.day);
    if (days && !days.includes(weekdayNum)) continue;
    const start = parseHHMM(schedule.startTime ?? schedule.jamMasuk, '08:00');
    const end = parseHHMM(schedule.endTime ?? schedule.jamPulang, '17:00');
    return { isHoliday: false as const, startTime: start.text, endTime: end.text, startMinutes: start.minutes, endMinutes: end.minutes };
  }

  const shift = site.shift || site.workSchedule || site.schedule || {};
  const workDays = normalizeDays(shift.workDays ?? shift.days ?? shift.weekdays) || [1, 2, 3, 4, 5];
  if (!workDays.includes(weekdayNum)) return { isHoliday: true as const, reason: 'non_workday' };

  const start = parseHHMM(shift.startTime ?? shift.jamMasuk, '08:00');
  const end = parseHHMM(shift.endTime ?? shift.jamPulang, '17:00');
  return { isHoliday: false as const, startTime: start.text, endTime: end.text, startMinutes: start.minutes, endMinutes: end.minutes };
}

function inReminderWindow(nowMinutes: number, targetMinutes: number) {
  return nowMinutes >= targetMinutes && nowMinutes < targetMinutes + WINDOW_MINUTES;
}

function tokenMatchesSite(token: any, siteId: string, brandIds: string[]) {
  if (!token?.subscription?.endpoint) return false;
  if (token.enabled === false || token.isActive === false) return false;
  // Cocok jika siteId ATAU brandId sesuai — jangan berhenti di siteId saja
  const matchesSite  = token.siteId  && token.siteId === siteId;
  const matchesBrand = token.brandId && brandIds.includes(String(token.brandId));
  return !!(matchesSite || matchesBrand);
}

async function disableInvalidToken(db: Firestore, tokenDoc: QueryDocumentSnapshot, message: string) {
  const patch = {
    enabled: false,
    isActive: false,
    updatedAt: FieldValue.serverTimestamp(),
    lastError: message,
  };
  await Promise.all([
    tokenDoc.ref.update(patch),
    db.collection('notification_tokens').doc(tokenDoc.id).set(patch, { merge: true }),
  ]);
}

async function getAttendanceState(db: Firestore, uid: string, dateKey: string) {
  const [byAttendanceDate, byDateKey] = await Promise.all([
    db.collection('attendance_events').where('uid', '==', uid).where('attendanceDate', '==', dateKey).limit(6).get(),
    db.collection('attendance_events').where('uid', '==', uid).where('dateKey', '==', dateKey).limit(6).get(),
  ]);
  const events = new Map<string, any>();
  for (const doc of [...byAttendanceDate.docs, ...byDateKey.docs]) events.set(doc.id, doc.data());
  const rows = Array.from(events.values());
  return {
    hasIn: rows.some(event => event.type === 'IN' || event.type === 'check_in'),
    hasOut: rows.some(event => event.type === 'OUT' || event.type === 'check_out'),
  };
}

async function getEmployeeMethod(db: Firestore, uid: string, cache: Map<string, Promise<string | null>>) {
  if (!cache.has(uid)) {
    cache.set(uid, db.collection('employee_profiles').doc(uid).get().then(doc => {
      if (!doc.exists) return null;
      const data = doc.data() || {};
      return (data.attendanceMethod || data.hrdEmploymentInfo?.attendanceMethod || null) as string | null;
    }).catch(() => null));
  }
  return cache.get(uid)!;
}

async function runScheduler(req: NextRequest) {
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
  const results = {
    sitesChecked: 0,
    employeesChecked: 0,
    tokensFound: 0,
    sent: 0,
    failed: 0,
    skippedAlreadyTappedIn: 0,
    skippedAlreadyTappedOut: 0,
    skippedNotTappedIn: 0,
    skippedHoliday: 0,
    skippedDuplicate: 0,
    skippedNonWebAbsen: 0,
    skippedNotInWindow: 0,
    errors: [] as string[],
  };

  try {
    const [sitesSnap, tokensSnap] = await Promise.all([
      db.collection('attendance_sites').where('isActive', '==', true).get(),
      db.collection('attendance_notification_tokens').where('enabled', '==', true).get(),
    ]);
    const tokens = tokensSnap.docs;

    const employeeMethodCache = new Map<string, Promise<string | null>>();

    for (const siteDoc of sitesSnap.docs) {
      results.sitesChecked += 1;
      const site = siteDoc.data();
      const siteId = siteDoc.id;
      const siteName = site.name || site.siteName || siteId;
      const tz = site.timezone || site.shift?.timezone || DEFAULT_TZ;
      const local = getLocalParts(now, tz);
      const schedule = resolveScheduleForToday(site, local.weekdayNum, local.dateKey);
      const brandIds = getBrandIds(site);

      if (schedule.isHoliday) {
        results.skippedHoliday += 1;
        console.log('[ATTENDANCE_NOTIFICATION_SCHEDULER]', {
          nowJakarta: local.nowJakarta,
          dateKey: local.dateKey,
          siteName,
          brandId: brandIds[0] || null,
          reminderType: 'none',
          targetTime: null,
          employeesChecked: 0,
          tokensFound: 0,
          notificationsSent: 0,
          skippedAlreadyTappedIn: 0,
          skippedAlreadyTappedOut: 0,
          skippedHoliday: 1,
          skippedDuplicate: 0,
        });
        continue;
      }

      const reminders = [
        {
          type: 'check_in_reminder' as const,
          targetMinutes: schedule.startMinutes - REMINDER_MINUTES,
          targetTime: minutesToHHMM(schedule.startMinutes - REMINDER_MINUTES),
          title: 'Jangan lupa absen masuk',
          body: '15 menit lagi jam masuk kerja. Silakan siapkan absen masuk Anda.',
        },
        {
          type: 'check_out_reminder' as const,
          targetMinutes: schedule.endMinutes - REMINDER_MINUTES,
          targetTime: minutesToHHMM(schedule.endMinutes - REMINDER_MINUTES),
          title: 'Jangan lupa absen pulang',
          body: '15 menit lagi jam pulang kerja. Jangan lupa tap out sebelum meninggalkan lokasi kerja.',
        },
      ];

      const siteTokens = tokens.filter(doc => tokenMatchesSite(doc.data(), siteId, brandIds));
      results.tokensFound += siteTokens.length;

      for (const reminder of reminders) {
        const inWindow = inReminderWindow(local.localMinutes, reminder.targetMinutes);
        if (!inWindow) {
          results.skippedNotInWindow += siteTokens.length;
          continue;
        }

        const siteCounters = {
          employeesChecked: 0,
          tokensFound: siteTokens.length,
          notificationsSent: 0,
          skippedAlreadyTappedIn: 0,
          skippedAlreadyTappedOut: 0,
          skippedHoliday: 0,
          skippedDuplicate: 0,
        };

        for (const tokenDoc of siteTokens) {
          const token = tokenDoc.data();
          const uid = token.uid as string;
          if (!uid) continue;
          results.employeesChecked += 1;
          siteCounters.employeesChecked += 1;

          const employeeMethod = await getEmployeeMethod(db, uid, employeeMethodCache);
          if (employeeMethod && employeeMethod !== 'web_absen') {
            results.skippedNonWebAbsen += 1;
            continue;
          }

          const logDocId = `${uid}_${local.dateKey}_${reminder.type}`;
          const logRef = db.collection('attendance_notification_logs').doc(logDocId);
          const logSnap = await logRef.get();
          if (logSnap.exists) {
            const logData = logSnap.data() || {};
            // Jika sudah terkirim atau diskip secara permanen, jangan kirim ulang
            if (logData.status === 'sent' || logData.status === 'skipped') {
              results.skippedDuplicate += 1;
              siteCounters.skippedDuplicate += 1;
              continue;
            }
            // Jika gagal (failed), retry selama masih dalam reminder window
            // Batasi retry agar tidak loop tanpa batas
            const retryCount = Number(logData.retryCount ?? 0);
            if (logData.status === 'failed' && retryCount >= 3) {
              results.skippedDuplicate += 1;
              siteCounters.skippedDuplicate += 1;
              continue;
            }
          }

          const attendance = await getAttendanceState(db, uid, local.dateKey);
          let skipReason: string | null = null;
          if (reminder.type === 'check_in_reminder') {
            if (token.reminderCheckIn === false) skipReason = 'reminder_check_in_disabled';
            else if (attendance.hasIn) skipReason = 'already_tapped_in';
          } else {
            if (token.reminderCheckOut === false) skipReason = 'reminder_check_out_disabled';
            else if (!attendance.hasIn) skipReason = 'not_tapped_in';
            else if (attendance.hasOut) skipReason = 'already_tapped_out';
          }

          const logBase = {
            uid,
            employeeUid: uid,
            brandId: token.brandId || brandIds[0] || null,
            siteId,
            siteName,
            dateKey: local.dateKey,
            type: reminder.type,
            targetTime: reminder.targetTime,
            scheduledFor: `${local.dateKey} ${reminder.targetTime} ${tz}`,
            token: token.subscription?.endpoint || token.token || null,
            sentAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          };

          if (skipReason) {
            if (skipReason === 'already_tapped_in') {
              results.skippedAlreadyTappedIn += 1;
              siteCounters.skippedAlreadyTappedIn += 1;
            }
            if (skipReason === 'already_tapped_out') {
              results.skippedAlreadyTappedOut += 1;
              siteCounters.skippedAlreadyTappedOut += 1;
            }
            if (skipReason === 'not_tapped_in') results.skippedNotTappedIn += 1;
            await logRef.set({
              ...logBase,
              status: 'skipped',
              errorMessage: null,
              reason: skipReason,
              createdAt: FieldValue.serverTimestamp(),
            });
            continue;
          }

          try {
            await webpush.sendNotification(token.subscription, JSON.stringify({
              title: reminder.title,
              body: reminder.body,
              icon: '/icon-192.png',
              badge: '/notification-icon.png',
              url: '/absen',
              type: reminder.type,
            }));
            await logRef.set({
              ...logBase,
              status: 'sent',
              errorMessage: null,
              createdAt: FieldValue.serverTimestamp(),
            });
            await tokenDoc.ref.update({
              lastUsedAt: FieldValue.serverTimestamp(),
              lastSeenAt: FieldValue.serverTimestamp(),
              isActive: true,
              updatedAt: FieldValue.serverTimestamp(),
            });
            results.sent += 1;
            siteCounters.notificationsSent += 1;
          } catch (err: any) {
            const message = err?.message || 'push_error';
            if (err?.statusCode === 410 || err?.statusCode === 404) {
              await disableInvalidToken(db, tokenDoc, message);
            }
            const prevRetry = logSnap.exists ? Number((logSnap.data() || {}).retryCount ?? 0) : 0;
            await logRef.set({
              ...logBase,
              status: 'failed',
              errorMessage: message,
              reason: 'push_error',
              retryCount: prevRetry + 1,
              createdAt: logSnap.exists ? (logSnap.data()?.createdAt ?? FieldValue.serverTimestamp()) : FieldValue.serverTimestamp(),
            });
            results.failed += 1;
            results.errors.push(`${uid}: ${message}`);
          }
        }

        console.log('[ATTENDANCE_NOTIFICATION_SCHEDULER]', {
          nowJakarta: local.nowJakarta,
          dateKey: local.dateKey,
          siteName,
          brandId: brandIds[0] || null,
          reminderType: reminder.type,
          targetTime: reminder.targetTime,
          employeesChecked: siteCounters.employeesChecked,
          tokensFound: siteCounters.tokensFound,
          notificationsSent: siteCounters.notificationsSent,
          skippedAlreadyTappedIn: siteCounters.skippedAlreadyTappedIn,
          skippedAlreadyTappedOut: siteCounters.skippedAlreadyTappedOut,
          skippedHoliday: siteCounters.skippedHoliday,
          skippedDuplicate: siteCounters.skippedDuplicate,
        });
      }
    }

    return NextResponse.json({
      success: true,
      checkedAt: now.toISOString(),
      windowMinutes: WINDOW_MINUTES,
      reminderMinutesBefore: REMINDER_MINUTES,
      ...results,
    });
  } catch (err: any) {
    console.error('[send-reminders]', err);
    return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return runScheduler(req);
}

export async function GET(req: NextRequest) {
  return runScheduler(req);
}
