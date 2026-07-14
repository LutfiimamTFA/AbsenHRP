"use client";

// Extend Window so TypeScript knows about the global install prompt slot
declare global {
  interface Window {
    deferredPwaPrompt?: any;
  }
}

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import {
  collection,
  doc,
  query,
  where,
  getDocs,
  getDoc,
  addDoc,
  updateDoc,
  writeBatch,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import {
  useAuth,
  useFirestore,
  useUser,
  useCollection,
} from "@/firebase";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  LogOut,
  LogIn,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Clock,
  Camera,
  Navigation,
  FileText,
  MapPin,
  ShieldAlert,
  X,
  CalendarDays,
  Bell,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  getDistance,
  getDetailedAddress,
  type AddressDetail,
} from "@/lib/geo-utils";
import { CameraCapture } from "@/components/camera-capture";
import { format, isThisMonth } from "date-fns";
import { id as localeId } from "date-fns/locale";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// ─── Types ────────────────────────────────────────────────────────────────────

type TapStep =
  | "idle"
  | "locating"
  | "verifyLocation"
  | "selfie"
  | "preview"
  | "submitting"
  | "success";

type LocationStatus = 'inside_radius' | 'gps_uncertain' | 'outside_radius' | 'gps_low_accuracy' | 'unknown';
type LocationConfidence = 'high' | 'medium' | 'low';

interface LiveLocation {
  lat: number;
  lng: number;
  accuracy: number;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
}

interface TapGpsData {
  lat: number;
  lng: number;
  accuracyM: number;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
  distanceToSiteM: number | null;
  insideRadius: boolean;
  locationStatus: LocationStatus;
  locationConfidence: LocationConfidence;
  capturedAt: Date;
}

// ─── Location evaluator ────────────────────────────────────────────────────────

function evaluateLocation(
  distanceM: number | null,
  radiusM: number,
  gpsAccuracy: number,
): { locationStatus: LocationStatus; locationConfidence: LocationConfidence; needsHrdReview: boolean; insideRadius: boolean } {
  if (distanceM === null) {
    return { locationStatus: 'unknown', locationConfidence: 'low', needsHrdReview: true, insideRadius: false };
  }
  if (gpsAccuracy > 100) {
    return { locationStatus: 'gps_low_accuracy', locationConfidence: 'low', needsHrdReview: true, insideRadius: false };
  }
  if (distanceM <= radiusM) {
    return { locationStatus: 'inside_radius', locationConfidence: 'high', needsHrdReview: false, insideRadius: true };
  }
  if (distanceM <= radiusM + gpsAccuracy) {
    return { locationStatus: 'gps_uncertain', locationConfidence: 'medium', needsHrdReview: true, insideRadius: false };
  }
  return { locationStatus: 'outside_radius', locationConfidence: 'low', needsHrdReview: true, insideRadius: false };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wibString(date: Date): string {
  return format(date, "dd MMMM yyyy, HH:mm:ss", { locale: localeId }) + " WIB";
}

function shortAddr(a: AddressDetail): string {
  return [a.road, a.district || a.kecamatan, a.city || a.kabupatenKota]
    .filter(Boolean)
    .join(", ");
}

// Extract Google Drive file ID from various Drive URL formats
function extractDriveFileId(url: string | null | undefined): string | null {
  if (!url) return null;
  let m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return null;
}

// Photo only accessible within 7 days of attendanceDate
function isPhotoWithin7Days(attendanceDate: string): boolean {
  try {
    const d = new Date(attendanceDate + 'T00:00:00');
    return !isNaN(d.getTime()) && Date.now() - d.getTime() <= 7 * 24 * 60 * 60 * 1000;
  } catch { return false; }
}

// Firestore tidak boleh simpan undefined — convert ke null atau hapus.
// Jangan process Timestamp, Date, atau FieldValue (Firestore special types).
function cleanUndefined(value: any): any {
  // Jangan process Timestamp, Date, FieldValue (Firestore special types)
  if (value instanceof Timestamp || value instanceof Date || value?.constructor?.name === 'FieldValue') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(cleanUndefined);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([_, v]) => v !== undefined)
        .map(([k, v]) => [k, cleanUndefined(v)])
    );
  }

  return value;
}

function formatAddressLines(a: AddressDetail): string[] {
  if (!a) return [];
  const lines: string[] = [];
  if (a.road) lines.push(a.road);
  // neighbourhood/hamlet
  if (a.neighbourhood) lines.push(a.neighbourhood);
  // village / kelurahan
  if (a.village) lines.push(a.village);
  if (a.kelurahan) lines.push(a.kelurahan);
  // district / kecamatan
  if (a.district) lines.push(`Kecamatan ${a.district}`);
  if (a.kecamatan) lines.push(`Kecamatan ${a.kecamatan}`);
  // city / regency / kabupaten
  if (a.city) lines.push(a.city);
  if (a.kabupatenKota) lines.push(a.kabupatenKota);
  if (a.regency) lines.push(a.regency);
  // province
  if (a.province) lines.push(a.province);
  // postcode
  if (a.postcode) lines.push(a.postcode);
  // fallback to displayName if nothing else
  if (lines.length === 0 && a.displayName) return [a.displayName];
  // remove duplicates while preserving order
  return Array.from(new Set(lines));
}

const FLAG_LABELS: Record<string, { label: string; color: string }> = {
  gps_low_accuracy: { label: "GPS kurang akurat", color: "text-yellow-600" },
  outside_radius: { label: "Di luar radius kantor", color: "text-orange-600" },
  gps_timeout: { label: "GPS timeout", color: "text-orange-500" },
  gps_unavailable: { label: "GPS tidak tersedia", color: "text-red-500" },
  address_not_found: {
    label: "Alamat tidak terbaca",
    color: "text-orange-400",
  },
  camera_retry: { label: "Foto diulang", color: "text-blue-500" },
  location_permission_warning: {
    label: "Izin GPS terbatas",
    color: "text-red-400",
  },
  OFFSITE: { label: "Di luar radius kantor", color: "text-orange-600" },
};

// ─── Step pills ───────────────────────────────────────────────────────────────

function StepPills({ current }: { current: number }) {
  // IN & OUT: Lokasi → Foto → Preview → Kirim
  const steps = ["Lokasi", "Foto", "Preview", "Kirim"];
  return (
    <div className="flex items-center gap-1.5 text-[8px] font-bold uppercase justify-center py-3">
      {steps.map((label, i) => (
        <React.Fragment key={label}>
          <span
            className={`px-2.5 py-0.5 rounded-full transition-colors ${
              i < current
                ? "bg-green-100 text-green-700"
                : i === current
                  ? "bg-primary text-white"
                  : "bg-muted text-muted-foreground opacity-40"
            }`}
          >
            {i < current ? "✓" : label}
          </span>
          {i < steps.length - 1 && <span className="opacity-20">›</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AbsenPage() {
  const { user, loading: userLoading } = useUser();
  const auth = useAuth();
  const db = useFirestore();
  const router = useRouter();
  const { toast } = useToast();

  // Realtime clock
  const [currentTime, setCurrentTime] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Live GPS watch
  const [liveLocation, setLiveLocation] = useState<LiveLocation | null>(null);
  const locationRef = useRef<LiveLocation | null>(null);
  // Condition report IDs — set synchronously after addDoc so handleSubmit never races onSnapshot
  const checkInReportIdRef  = useRef<string | null>(null);
  const checkOutReportIdRef = useRef<string | null>(null);
  useEffect(() => {
    locationRef.current = liveLocation;
  }, [liveLocation]);

  // Reverse geocode live location (cached — only re-geocode if moved >30 m)
  const [liveAddress, setLiveAddress] = useState<AddressDetail | null>(null);
  const lastGeocodedRef = useRef<{ lat: number; lng: number } | null>(null);

  const [sites, setSites] = useState<any[]>([]);
  const [activeSite, setActiveSite] = useState<any>(null);
  const [loadingSites, setLoadingSites] = useState(true);

  // Tap flow state
  const [tapStep, setTapStep] = useState<TapStep>("idle");
  const [tapType, setTapType] = useState<"IN" | "OUT">("IN");
  const [tapTime, setTapTime] = useState<Date>(new Date());
  const [tapGps, setTapGps] = useState<TapGpsData | null>(null);
  const [tapAddress, setTapAddress] = useState<AddressDetail | null>(null);
  const [tapPhoto, setTapPhoto] = useState<string | null>(null);
  const [tapFlags, setTapFlags] = useState<string[]>([]);
  // Condition report (lapor kondisi khusus — terpisah dari flow absen)
  const [conditionStep, setConditionStep] = useState<'idle' | 'form' | 'camera' | 'submitting'>('idle');
  const [conditionType, setConditionType] = useState<'check_in' | 'check_out'>('check_in');
  const [conditionReason, setConditionReason] = useState<string>('');
  const [conditionNote, setConditionNote] = useState<string>('');
  const [conditionPhoto, setConditionPhoto] = useState<string | null>(null);
  const [todayConditionReports, setTodayConditionReports] = useState<any[]>([]);
  const [loadingConditionReports, setLoadingConditionReports] = useState(false);
  // Push notification
  type NotifPermission = 'default' | 'granted' | 'denied' | 'unsupported' | 'loading';
  type NotifTokenStatus = 'checking' | 'not_enabled' | 'active' | 'expired';
  const [notifPermission, setNotifPermission] = useState<NotifPermission>('default');
  const [notifSubscribed, setNotifSubscribed] = useState(false);
  const [notifTokenStatus, setNotifTokenStatus] = useState<NotifTokenStatus>('checking');
  const [notifLoading, setNotifLoading] = useState(false);

  // PWA install — status machine
  type InstallStatus = 'checking' | 'ready' | 'installed' | 'unsupported' | 'ios' | 'dismissed';
  const [installStatus, setInstallStatus]     = useState<InstallStatus>('checking');
  const [isIosBrowser, setIsIosBrowser]       = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  // Derived helpers for backward compat with renderHeader
  const isInstalled = installStatus === 'installed';

  // History filters — simplified: "today" or "pick" (single date)
  const [historyMode, setHistoryMode] = useState<"today" | "pick">("today");
  const [pickedDate, setPickedDate] = useState(
    () => new Date().toISOString().split("T")[0],
  );
  const [customEndDate, setCustomEndDate] = useState(
    () => new Date().toISOString().split("T")[0],
  );
  // Logout loading state
  const [logoutLoading, setLogoutLoading] = useState(false);

  // Photo modal state (selfie kehadiran)
  const [photoModal, setPhotoModal] = useState<{
    fileId: string;
    date: string;
    dateLabel: string;
    checkInTime: string | null;
  } | null>(null);

  // Condition proof photo modal
  const [conditionPhotoModal, setConditionPhotoModal] = useState<{
    report: any;
    fileId: string | null;
    directUrl: string | null;
  } | null>(null);

  // Fetching condition report detail from history card (lazy)
  const [fetchingConditionId, setFetchingConditionId] = useState<string | null>(null);

  // ── Access control ─────────────────────────────────────────────
  const isAttendanceAllowed = useMemo(
    () => user?.attendanceMethod === "web_absen",
    [user],
  );

  const restrictedMessage = useMemo(() => {
    if (!user) return null;
    if (user.attendanceMethod === "fingerprint")
      return "Akun Anda menggunakan absensi fingerprint. Web absen tidak tersedia.";
    if (!user.attendanceMethod)
      return "Metode absensi Anda belum diatur oleh HRD. Silakan hubungi HRD.";
    return null;
  }, [user]);

  // ── Auth redirect ──────────────────────────────────────────────
  useEffect(() => {
    if (userLoading) return;
    if (!user) router.push("/login");
    else if (user.role === "kandidat") router.push("/unauthorized");
  }, [user, userLoading, router]);

  // ── PWA install prompt ────────────────────────────────────────
  useEffect(() => {
    // 1. Detect already-installed (standalone mode)
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true;
    if (standalone) {
      setInstallStatus('installed');
      return;
    }

    // 2. Detect iOS — no beforeinstallprompt support
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    setIsIosBrowser(ios);
    if (ios) {
      setInstallStatus('ios');
    }

    // 3. Check if the inline <script> already captured the prompt before hydration
    if (window.deferredPwaPrompt) {
      setInstallStatus('ready');
    } else if (!ios) {
      // Not standalone, not iOS, no prompt yet — stay 'checking'
      setInstallStatus('checking');
    }

    // 4. Listen for prompt becoming available (fires if browser fires it after hydration,
    //    or redispatched by the inline script's CustomEvent)
    const onInstallReady = () => {
      if (window.deferredPwaPrompt) setInstallStatus('ready');
    };
    const onAppInstalled = () => {
      window.deferredPwaPrompt = undefined;
      setInstallStatus('installed');
    };

    window.addEventListener('pwa-install-ready', onInstallReady);
    window.addEventListener('pwa-app-installed', onAppInstalled);

    // 5. Register / confirm service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(reg => {
          console.log('[SW] Registered, scope:', reg.scope);
          return navigator.serviceWorker.ready;
        })
        .then(() => {
          console.log('[SW] Active and ready.');
          // Re-check prompt after SW is ready (sometimes prompt fires just after SW ready)
          if (window.deferredPwaPrompt) setInstallStatus('ready');
        })
        .catch(err => {
          console.error('[SW] Registration failed:', err);
        });
    } else if (!ios) {
      setInstallStatus('unsupported');
    }

    return () => {
      window.removeEventListener('pwa-install-ready', onInstallReady);
      window.removeEventListener('pwa-app-installed', onAppInstalled);
    };
  }, []);

  // ── Push notification: init permission status ─────────────────
  useEffect(() => {
    let cancelled = false;
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setNotifPermission('unsupported');
      setNotifTokenStatus('not_enabled');
      return;
    }
    const perm = Notification.permission as NotifPermission;
    setNotifPermission(perm);
    if (perm !== 'granted' || !user?.uid) {
      setNotifSubscribed(false);
      setNotifTokenStatus(perm === 'denied' ? 'expired' : 'not_enabled');
      return;
    }

    setNotifTokenStatus('checking');
    (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration('/');
        const sub = await reg?.pushManager.getSubscription();
        if (!sub) {
          if (!cancelled) {
            setNotifSubscribed(false);
            setNotifTokenStatus('not_enabled');
          }
          return;
        }

        const { getAuth } = await import('firebase/auth');
        const idToken = await getAuth().currentUser?.getIdToken();
        if (!idToken) throw new Error('Sesi tidak ditemukan');

        const res = await fetch(`/api/attendance/notifications/status?endpoint=${encodeURIComponent(sub.endpoint)}`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const data = await res.json().catch(() => ({}));
        const active = res.ok && data.active === true;
        if (!cancelled) {
          setNotifSubscribed(active);
          setNotifTokenStatus(active ? 'active' : 'expired');
        }
        console.log("[WEB_PUSH_TOKEN_DEBUG]", {
          uid: user.uid,
          permission: perm,
          tokenExists: !!sub,
          tokenSaved: active,
        });
      } catch (err) {
        console.warn('[Notif] status check failed:', err);
        if (!cancelled) {
          setNotifSubscribed(false);
          setNotifTokenStatus('expired');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  // ── Site loader ────────────────────────────────────────────────
  useEffect(() => {
    if (userLoading || !user || !isAttendanceAllowed || !user.brandId) {
      setLoadingSites(false);
      return;
    }
    setLoadingSites(true);
    (async () => {
      try {
        console.log('[AbsenHRP] Query attendance_sites (isActive=true)');
        const snap = await getDocs(
          query(
            collection(db, "attendance_sites"),
            where("isActive", "==", true),
          ),
        );
        const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }) as any);
        const filtered = all.filter((s) => {
          const ids: string[] = s.brandIds || [];
          const uid = user.brandId!;
          return (
            (Array.isArray(ids) ? ids.includes(uid) : ids === uid) ||
            s.brandId === uid
          );
        });
        setSites(filtered);
      } catch (err: any) {
        toast({
          variant: "destructive",
          title: "Gagal Memuat Lokasi",
          description: err.message,
        });
      } finally {
        setLoadingSites(false);
      }
    })();
  }, [db, user, userLoading, isAttendanceAllowed, toast]);

  // ── Condition reports hari ini — realtime onSnapshot ──────────
  // Query SATU FIELD saja (uid atau employeeUid) agar tidak butuh composite index.
  // Filter tanggal dilakukan di client setelah data diterima.
  useEffect(() => {
    if (!user?.uid || !isAttendanceAllowed) {
      setTodayConditionReports([]);
      setLoadingConditionReports(false);
      return;
    }
    const todayDateKey = format(new Date(), "yyyy-MM-dd");
    setLoadingConditionReports(true);
    let active = true;

    // Merge dari dua query single-field: uid dan employeeUid
    const byUid:         Map<string, any> = new Map();
    const byEmployeeUid: Map<string, any> = new Map();
    let uidSettled = false;
    let empSettled = false;
    let uidFailed  = false;
    let empFailed  = false;

    const flush = () => {
      if (!active) return;
      const merged = new Map<string, any>();
      for (const row of [...byUid.values(), ...byEmployeeUid.values()]) {
        merged.set(row.id, { ...(merged.get(row.id) || {}), ...row });
      }
      // Filter client-side: hanya ambil laporan hari ini
      const today = Array.from(merged.values()).filter(r => {
        const dk = r.dateKey || r.reportDate || r.attendanceDate || null;
        return dk === todayDateKey;
      });
      setTodayConditionReports(today);
    };

    const checkSettled = () => {
      if (uidSettled && empSettled) {
        setLoadingConditionReports(false);
        if (uidFailed && empFailed) {
          console.error("[attendance_condition_reports] semua query gagal:", { uid: user.uid, todayDateKey });
          toast({
            variant: "destructive",
            title: "Laporan kondisi gagal dimuat",
            description: "Periksa koneksi internet dan coba refresh halaman.",
          });
        }
      }
    };

    console.log("[WEB_ABSEN_CONDITION_REPORT_QUERY_DEBUG]", {
      uid: user.uid, todayDateKey, queryMode: "single_field_client_date_filter",
      queries: ["uid == uid", "employeeUid == uid"],
    });

    // Query 1: berdasarkan uid (single-field, tidak perlu composite index)
    const unsubUid = onSnapshot(
      query(collection(db, "attendance_condition_reports"), where("uid", "==", user.uid)),
      snap => {
        byUid.clear();
        snap.docs.forEach(d => byUid.set(d.id, { id: d.id, ...d.data() }));
        flush();
        if (!uidSettled) { uidSettled = true; checkSettled(); }
      },
      err => {
        byUid.clear();
        console.error("[attendance_condition_reports] query uid gagal:", { code: err?.code, message: err?.message });
        flush();
        if (!uidSettled) { uidSettled = true; uidFailed = true; checkSettled(); }
      },
    );

    // Query 2: berdasarkan employeeUid (untuk kompatibilitas data lama)
    const unsubEmp = onSnapshot(
      query(collection(db, "attendance_condition_reports"), where("employeeUid", "==", user.uid)),
      snap => {
        byEmployeeUid.clear();
        snap.docs.forEach(d => byEmployeeUid.set(d.id, { id: d.id, ...d.data() }));
        flush();
        if (!empSettled) { empSettled = true; checkSettled(); }
      },
      err => {
        byEmployeeUid.clear();
        console.error("[attendance_condition_reports] query employeeUid gagal:", { code: err?.code, message: err?.message });
        flush();
        if (!empSettled) { empSettled = true; empFailed = true; checkSettled(); }
      },
    );

    return () => {
      active = false;
      unsubUid();
      unsubEmp();
    };
  }, [db, user?.uid, isAttendanceAllowed, toast]);

  // ── Live GPS watch ─────────────────────────────────────────────
  useEffect(() => {
    if (!isAttendanceAllowed) return;
    const id = navigator.geolocation.watchPosition(
      (pos) =>
        setLiveLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
        }),
      (err) => console.warn("GPS Watch:", err.message),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [isAttendanceAllowed]);

  // Reverse geocode live location when it moves >30 m
  useEffect(() => {
    if (!liveLocation) return;
    const last = lastGeocodedRef.current;
    if (last) {
      const d = getDistance(liveLocation.lat, liveLocation.lng, last.lat, last.lng);
      if (d < 30) return;
    }
    lastGeocodedRef.current = { lat: liveLocation.lat, lng: liveLocation.lng };
    getDetailedAddress(liveLocation.lat, liveLocation.lng)
      .then(addr => setLiveAddress(addr))
      .catch(() => {});
  }, [liveLocation]);

  // ── Active site resolver ───────────────────────────────────────
  useEffect(() => {
    if (!liveLocation || !sites.length) {
      setActiveSite(null);
      return;
    }
    let closest: any = null,
      minD = Infinity;
    sites.forEach((s) => {
      // Support both flat {lat,lng} and nested {office:{lat,lng}}
      const siteLat = s.lat ?? s.office?.lat;
      const siteLng = s.lng ?? s.office?.lng;
      if (siteLat == null || siteLng == null) return;
      const d = getDistance(liveLocation.lat, liveLocation.lng, siteLat, siteLng);
      if (d < minD) { minD = d; closest = s; }
    });
    setActiveSite(closest);
  }, [liveLocation, sites]);

  // ── Attendance event queries ───────────────────────────────────
  const historyQuery = useMemo(() => {
    if (!user?.uid || !isAttendanceAllowed) return null;
    console.log('[AbsenHRP] Query attendance_events uid=', user.uid);
    return query(
      collection(db, "attendance_events"),
      where("uid", "==", user.uid),
    );
  }, [user?.uid, db, isAttendanceAllowed]);

  const { data: rawEvents, loading: eventsLoading } =
    useCollection(historyQuery);

  const sortedEvents = useMemo(() => {
    if (!rawEvents) return [];
    return [...rawEvents].sort((a: any, b: any) => {
      const ta =
        a.tsClient instanceof Timestamp ? a.tsClient.toDate().getTime() : 0;
      const tb =
        b.tsClient instanceof Timestamp ? b.tsClient.toDate().getTime() : 0;
      return tb - ta;
    });
  }, [rawEvents]);

  const todayStatus = useMemo(() => {
    const todayStr = format(new Date(), "yyyy-MM-dd");
    const events = sortedEvents.filter((ev: any) => {
      // Prioritas: attendanceDate (disimpan sejak update ini), fallback ke tsClient
      if (ev.attendanceDate && typeof ev.attendanceDate === "string") {
        return ev.attendanceDate === todayStr;
      }
      // Fallback: parse tsClient — JANGAN default ke new Date() jika tidak valid
      if (!ev.tsClient) return false;
      let d: Date;
      try {
        d = ev.tsClient instanceof Timestamp
          ? ev.tsClient.toDate()
          : new Date(ev.tsClient);
        if (isNaN(d.getTime())) return false;
      } catch {
        return false;
      }
      return format(d, "yyyy-MM-dd") === todayStr;
    });
    return {
      hasIn: events.some((e: any) => e.type === "IN"),
      hasOut: events.some((e: any) => e.type === "OUT"),
      events,
    };
  }, [sortedEvents]);

  const todayCheckIn = useMemo<any | null>(() => {
    const ev = todayStatus.events.find((e: any) => e.type === "IN");
    if (!ev) return null;
    let dt: Date | null = null;
    try {
      dt = ev.tsClient instanceof Timestamp
        ? ev.tsClient.toDate()
        : ev.tsClient ? new Date(ev.tsClient) : null;
      if (dt && isNaN(dt.getTime())) dt = null;
    } catch {
      dt = null;
    }
    return {
      ...ev,
      _date: dt || new Date(),
    };
  }, [todayStatus.events]);

  const todayCheckOut = useMemo<any | null>(() => {
    const ev = todayStatus.events.find((e: any) => e.type === "OUT");
    if (!ev) return null;
    let dt: Date | null = null;
    try {
      dt = ev.tsClient instanceof Timestamp
        ? ev.tsClient.toDate()
        : ev.tsClient ? new Date(ev.tsClient) : null;
      if (dt && isNaN(dt.getTime())) dt = null;
    } catch {
      dt = null;
    }
    return {
      ...ev,
      _date: dt || new Date(),
    };
  }, [todayStatus.events]);

  const nextAction: "IN" | "OUT" = todayStatus.hasIn ? "OUT" : "IN";
  const isFinished = todayStatus.hasOut;

  // ── History filters ─────────────────────────────────────────────
  const getDateRange = useCallback((): [Date, Date] => {
    const now = new Date();
    let dateStr: string;
    if (historyMode === "today") {
      dateStr = format(now, "yyyy-MM-dd");
    } else {
      dateStr = pickedDate || format(now, "yyyy-MM-dd");
    }
    const start = new Date(dateStr + "T00:00:00");
    const end = new Date(dateStr + "T23:59:59.999");
    return [start, end];
  }, [historyMode, pickedDate]);

  const [filterStart, filterEnd] = useMemo(
    () => getDateRange(),
    [getDateRange],
  );

  // Ambil tanggal dari event dengan semua fallback field (support data lama)
  const getEventDate = useCallback((ev: any): Date | null => {
    try {
      let d: Date | null = null;
      if (ev.attendanceDate && typeof ev.attendanceDate === "string")
        d = new Date(ev.attendanceDate + "T00:00:00");
      else if (ev.datetime?.date && typeof ev.datetime.date === "string")
        d = new Date(ev.datetime.date + "T00:00:00");
      else if (ev.tsClient instanceof Timestamp)
        d = ev.tsClient.toDate();
      else if (ev.tsClient)
        d = new Date(ev.tsClient);
      else if (ev.timestamp instanceof Timestamp)
        d = ev.timestamp.toDate();
      else if (ev.timestamp)
        d = new Date(ev.timestamp);
      else if (ev.createdAt instanceof Timestamp)
        d = ev.createdAt.toDate();
      else if (ev.createdAt)
        d = new Date(ev.createdAt);
      return d && !isNaN(d.getTime()) ? d : null;
    } catch { return null; }
  }, []);

  // Ambil timestamp aktual event (bukan hanya tanggal)
  const getEventTime = useCallback((ev: any): Date | null => {
    try {
      let d: Date | null = null;
      if (ev.tsClient instanceof Timestamp) d = ev.tsClient.toDate();
      else if (ev.tsClient) d = new Date(ev.tsClient);
      else if (ev.timestamp instanceof Timestamp) d = ev.timestamp.toDate();
      else if (ev.timestamp) d = new Date(ev.timestamp);
      else if (ev.datetime?.iso) d = new Date(ev.datetime.iso);
      else if (ev.createdAt instanceof Timestamp) d = ev.createdAt.toDate();
      else if (ev.createdAt) d = new Date(ev.createdAt);
      return d && !isNaN(d.getTime()) ? d : null;
    } catch { return null; }
  }, []);

  const filteredEvents = useMemo(
    () =>
      sortedEvents.filter((ev: any) => {
        const d = getEventDate(ev);
        if (!d) return false;
        return d >= filterStart && d <= filterEnd;
        // statusFilter diapply di filteredGroups, bukan di sini
      }),
    [sortedEvents, filterStart, filterEnd, getEventDate],
  );

  // Group history by date
  const groupedHistory = useMemo(() => {
    const groups = new Map<string, any[]>();
    filteredEvents.forEach((ev: any) => {
      const dateKey = ev.attendanceDate && typeof ev.attendanceDate === "string"
        ? ev.attendanceDate
        : ev.datetime?.date && typeof ev.datetime.date === "string"
          ? ev.datetime.date
          : (() => { const d = getEventDate(ev); return d ? format(d, "yyyy-MM-dd") : null; })();
      if (!dateKey) return;
      const dt = getEventTime(ev) ?? new Date(dateKey + "T00:00:00");
      if (!groups.has(dateKey)) groups.set(dateKey, []);
      groups.get(dateKey)!.push({ ...ev, _date: dt });
    });

    return Array.from(groups.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, evts]) => {
        const checkIn  = evts.find((e: any) => e.type === "IN")  ?? null;
        const checkOut = evts.find((e: any) => e.type === "OUT") ?? null;

        // Hitung durasi kerja
        let durationMinutes: number | null = null;
        if (checkIn && checkOut) {
          const diff = checkOut._date.getTime() - checkIn._date.getTime();
          if (diff > 0) durationMinutes = Math.floor(diff / 60000);
        }

        // Bandingkan dengan hari ini dalam WIB (UTC+7) — tanggal berjalan tidak boleh dianggap "lupa"
        const todayWIB = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const isPast   = date < todayWIB;

        // Daily status
        let dailyStatus: "COMPLETE" | "MISSING_OUT" | "MISSING_IN" | "ABSENT" | "IN_PROGRESS";
        if (checkIn && checkOut) {
          dailyStatus = "COMPLETE";
        } else if (checkIn && !checkOut) {
          // Masih punya waktu pulang jika hari ini belum selesai
          dailyStatus = isPast ? "MISSING_OUT" : "IN_PROGRESS";
        } else if (!checkIn && checkOut) {
          dailyStatus = isPast ? "MISSING_IN" : "IN_PROGRESS";
        } else {
          dailyStatus = "ABSENT";
        }

        return {
          date,
          dateLabel: format(new Date(date + "T00:00:00"), "EEEE, dd MMMM yyyy", { locale: localeId }),
          checkIn,
          checkOut,
          durationMinutes,
          dailyStatus,
          events: evts,
        };
      });
  }, [filteredEvents, getEventDate, getEventTime]);

  const filteredGroups = groupedHistory;

  // Ringkasan statistik periode filter
  const historySummary = useMemo(() => {
    let totalPresent = 0, totalLate = 0, totalEarlyLeave = 0,
        totalMissingOut = 0, totalWorkMinutes = 0;
    groupedHistory.forEach(({ checkIn, checkOut, dailyStatus, durationMinutes }) => {
      if (checkIn) totalPresent++;
      if (checkIn?.status === "LATE") totalLate++;
      if (checkOut?.status === "EARLY_LEAVE") totalEarlyLeave++;
      // Hanya hitung sebagai lupa jika status benar-benar MISSING_OUT (tanggal lampau)
      if (dailyStatus === "MISSING_OUT") totalMissingOut++;
      if (durationMinutes) totalWorkMinutes += durationMinutes;
    });
    return { totalPresent, totalLate, totalEarlyLeave, totalMissingOut, totalWorkMinutes };
  }, [groupedHistory]);

  // ── Status calculator ──────────────────────────────────────────
  const calculateStatus = useCallback(
    (type: "IN" | "OUT", now: Date, site: any) => {
      if (!site?.shift) return {
        status: "NORMAL", lateMinutes: 0,
        scheduledCheckIn: null, allowedCheckInTime: null,
      };
      const startTime        = site.shift.startTime        || site.shift.jamMasuk        || "08:00";
      const endTime          = site.shift.endTime          || site.shift.jamPulang        || "17:00";
      const graceLateMinutes = site.shift.graceLateMinutes ?? site.shift.batasTelatMenit ?? 0;

      const [sh, sm] = startTime.split(":").map(Number);
      const [eh, em] = endTime.split(":").map(Number);

      const sched = new Date(now); sched.setHours(sh, sm, 0, 0);
      const grace = new Date(sched.getTime() + graceLateMinutes * 60000);
      const schedEnd = new Date(now); schedEnd.setHours(eh, em, 0, 0);

      const scheduledCheckIn  = `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}`;
      const allowedH = grace.getHours(), allowedM = grace.getMinutes();
      const allowedCheckInTime = `${String(allowedH).padStart(2,'0')}:${String(allowedM).padStart(2,'0')}`;

      if (type === "IN") {
        if (now > grace) {
          // lateMinutes = selisih dari allowedCheckInTime, bukan dari scheduledCheckIn
          const lateMinutes = Math.ceil((now.getTime() - grace.getTime()) / 60000);
          return { status: "LATE", lateMinutes, scheduledCheckIn, allowedCheckInTime };
        }
        return { status: "ON_TIME", lateMinutes: 0, scheduledCheckIn, allowedCheckInTime };
      }
      return now < schedEnd
        ? { status: "EARLY_LEAVE", lateMinutes: 0, scheduledCheckIn: null, allowedCheckInTime: null }
        : { status: "ON_TIME",     lateMinutes: 0, scheduledCheckIn: null, allowedCheckInTime: null };
    },
    [],
  );

  // ── Watermark ──────────────────────────────────────────────────
  const applyWatermark = useCallback(
    (
      base64: string,
      type: "IN" | "OUT",
      gps: TapGpsData,
      addr: AddressDetail | null,
      now: Date,
    ): Promise<string> =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.src = base64;
        img.onerror = () => reject(new Error("Gagal memuat gambar"));
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(base64);
            return;
          }
          ctx.drawImage(img, 0, 0);

          const wmH = Math.floor(canvas.height * 0.32);
          const y0 = canvas.height - wmH;
          const p = Math.floor(canvas.width * 0.045);
          const lh = Math.floor(wmH / 10);

          const grad = ctx.createLinearGradient(0, y0 - lh, 0, canvas.height);
          grad.addColorStop(0, "rgba(0,0,0,0)");
          grad.addColorStop(0.2, "rgba(0,0,0,0.78)");
          grad.addColorStop(1, "rgba(0,0,0,0.94)");
          ctx.fillStyle = grad;
          ctx.fillRect(0, y0 - lh, canvas.width, wmH + lh);

          ctx.textBaseline = "top";
          let cy = y0 + Math.floor(lh * 0.4);

          const write = (
            text: string,
            size: number,
            color = "white",
            bold = false,
          ) => {
            ctx.font = `${bold ? "bold " : ""}${size}px Inter,Arial,sans-serif`;
            ctx.fillStyle = color;
            ctx.textAlign = "left";
            ctx.fillText(text, p, cy, canvas.width - p * 2);
            cy += Math.floor(size * 1.5);
          };

          const zone  = gps.insideRadius ? "ONSITE" : "OFFSITE";
          const zoneC = gps.insideRadius ? "#86efac" : "#fb923c";
          const eventLabel = type === "IN" ? "KEHADIRAN MASUK" : "KEHADIRAN PULANG";

          // Baris 0: label event kecil — tidak menimpa nama
          write(eventLabel, Math.floor(lh * 0.68), "rgba(255,255,255,0.55)");

          // Baris 1: Nama — paling menonjol, tidak ada elemen lain di baris ini
          write(
            user?.displayName?.toUpperCase() || "USER",
            Math.floor(lh * 1.05),
            "white",
            true,
          );

          // Baris 2: EMP ID • Brand • Divisi
          const idLine = [
            user?.employeeId ? `EMP ${user.employeeId}` : null,
            user?.brandName,
            user?.division,
          ]
            .filter(Boolean)
            .join("  •  ");
          if (idLine) write(idLine, Math.floor(lh * 0.76), "rgba(255,255,255,0.82)");

          // Baris 3: Tanggal dan jam
          write(wibString(now), Math.floor(lh * 0.82), "#93c5fd", true);

          // Baris 4: Lokasi/alamat
          const sa = addr ? shortAddr(addr) || addr.displayName : null;
          if (sa) write(sa, Math.floor(lh * 0.72), "rgba(255,255,255,0.76)");

          // Baris 5: Koordinat dan akurasi GPS
          write(
            `${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}   ±${Math.round(gps.accuracyM)}m`,
            Math.floor(lh * 0.64),
            "rgba(255,255,255,0.52)",
          );

          // Baris 6: Jarak ke site + status ONSITE/OFFSITE
          if (gps.distanceToSiteM !== null && activeSite) {
            write(
              `Jarak ke ${activeSite.name}: ${Math.round(gps.distanceToSiteM)}m   •   ${zone}`,
              Math.floor(lh * 0.66),
              zoneC,
            );
          } else {
            write(zone, Math.floor(lh * 0.66), zoneC);
          }

          resolve(canvas.toDataURL("image/jpeg", 0.82));
        };
      }),
    [user, activeSite],
  );

  // ── Proceed with GPS data → selfie ─────────────────────────────
  const proceedWithLocation = useCallback(
    (loc: LiveLocation) => {
      const capturedAt = new Date();
      setTapTime(capturedAt);

      let distToSite: number | null = null;
      const siteLat = activeSite?.lat ?? activeSite?.office?.lat;
      const siteLng = activeSite?.lng ?? activeSite?.office?.lng;
      if (siteLat != null && siteLng != null) {
        distToSite = getDistance(loc.lat, loc.lng, siteLat, siteLng);
      }

      const eval_ = evaluateLocation(distToSite, activeSite?.radiusM || 150, loc.accuracy);

      const flags: string[] = [];
      if (eval_.locationStatus === 'gps_low_accuracy') flags.push("gps_low_accuracy");
      if (eval_.locationStatus === 'outside_radius') flags.push("outside_radius");
      if (eval_.locationStatus === 'gps_uncertain') flags.push("gps_uncertain");

      setTapGps({
        lat: loc.lat,
        lng: loc.lng,
        accuracyM: loc.accuracy,
        altitude: loc.altitude,
        heading: loc.heading,
        speed: loc.speed,
        distanceToSiteM: distToSite,
        insideRadius: eval_.insideRadius,
        locationStatus: eval_.locationStatus,
        locationConfidence: eval_.locationConfidence,
        capturedAt,
      });
      setTapFlags(flags);

      getDetailedAddress(loc.lat, loc.lng)
        .then((addr) => setTapAddress(addr))
        .catch(() =>
          setTapFlags((prev) => [...new Set([...prev, "address_not_found"])]),
        );

      setTapStep("verifyLocation");
    },
    [activeSite],
  );

  // ── Start tap flow ─────────────────────────────────────────────
  const startTapFlow = useCallback(
    (type: "IN" | "OUT") => {
      if (!isAttendanceAllowed || isFinished) return;
      setTapType(type);
      setTapPhoto(null);
      setTapAddress(null);
      setTapFlags([]);

      const loc = locationRef.current;
      if (loc) {
        proceedWithLocation(loc);
        return;
      }

      setTapStep("locating");
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          proceedWithLocation({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            altitude: pos.coords.altitude,
            heading: pos.coords.heading,
            speed: pos.coords.speed,
          }),
        (err) => {
          if (err.code === 1) {
            toast({
              variant: "destructive",
              title: "GPS Ditolak",
              description: "Aktifkan izin lokasi untuk absensi.",
            });
            setTapStep("idle");
          } else {
            setTapTime(new Date());
            setTapGps(null);
            setTapFlags(["gps_unavailable", "location_permission_warning"]);
            setTapStep("verifyLocation");
            toast({
              title: "GPS Tidak Tersedia",
              description: "Verifikasi lokasi dilanjutkan tanpa koordinat.",
            });
          }
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
      );
    },
    [isAttendanceAllowed, isFinished, proceedWithLocation, toast],
  );

  // ── PWA install handler ────────────────────────────────────────
  const handleInstallApp = useCallback(async () => {
    if (installStatus === 'installed') {
      toast({ title: 'Sudah terpasang', description: 'EGS Attendance sudah terpasang sebagai aplikasi di perangkat ini.' });
      return;
    }
    const prompt = window.deferredPwaPrompt;
    if (prompt) {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      window.deferredPwaPrompt = undefined;
      if (outcome === 'accepted') {
        setInstallStatus('installed');
        toast({ title: 'Berhasil dipasang', description: 'EGS Attendance berhasil dipasang ke layar utama.' });
      } else {
        setInstallStatus('dismissed');
      }
      return;
    }
    // iOS atau browser tanpa dukungan prompt
    setShowInstallGuide(true);
  }, [installStatus, toast]);

  // Normalisasi tipe laporan kondisi — mendukung berbagai nama field
  const normalizeReportType = (r: any): 'check_in' | 'check_out' | null => {
    const t = r?.reportType || r?.conditionType || null;
    if (t === 'check_in'  || t === 'IN')  return 'check_in';
    if (t === 'check_out' || t === 'OUT') return 'check_out';
    return null;
  };

  // ── Push Notification: helpers ────────────────────────────────
  function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  }

  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout: ${label} (${ms / 1000}s)`)), ms)
      ),
    ]);
  }

  // Mendaftarkan SW dan menunggu sampai statusnya `activated`.
  // Menangani semua status: installing → waiting → activated, dan redundant.
  function registerAndWaitForSW(): Promise<ServiceWorkerRegistration> {
    return new Promise((resolve, reject) => {
      const TIMEOUT_MS = 12000;
      let timer: ReturnType<typeof setTimeout>;

      function cleanup() { clearTimeout(timer); }
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Service worker tidak aktif dalam 12 detik. Coba muat ulang halaman.'));
      }, TIMEOUT_MS);

      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(reg => {
          console.log('[SW] registered, scope:', reg.scope);

          // Sudah aktif — langsung selesai
          if (reg.active) {
            cleanup();
            resolve(reg);
            return;
          }

          // Tunggu transisi state pada worker yang sedang installing/waiting
          function waitForWorker(worker: ServiceWorker) {
            if (worker.state === 'activated') { cleanup(); resolve(reg); return; }
            if (worker.state === 'redundant') {
              cleanup();
              reject(new Error('Service worker redundant — coba muat ulang halaman.'));
              return;
            }
            function onChange() {
              console.log('[SW] state:', worker.state);
              if (worker.state === 'activated') { cleanup(); worker.removeEventListener('statechange', onChange); resolve(reg); }
              else if (worker.state === 'redundant') { cleanup(); worker.removeEventListener('statechange', onChange); reject(new Error('Service worker redundant — coba muat ulang halaman.')); }
            }
            worker.addEventListener('statechange', onChange);
          }

          if (reg.installing) { waitForWorker(reg.installing); return; }
          if (reg.waiting)    { waitForWorker(reg.waiting);    return; }

          // Belum ada worker sama sekali — tunggu updatefound
          reg.addEventListener('updatefound', () => {
            if (reg.installing) waitForWorker(reg.installing);
          });
        })
        .catch(err => { cleanup(); reject(err); });
    });
  }

  const enableNotifications = useCallback(async () => {
    if (notifLoading || !user) return;

    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true;

    // Diagnostik awal
    console.log('[Notif] platform:', {
      isIOS,
      isStandalone,
      notificationApi: typeof Notification !== 'undefined',
      pushManager: 'PushManager' in window,
      serviceWorker: 'serviceWorker' in navigator,
      permission: typeof Notification !== 'undefined' ? Notification.permission : 'n/a',
    });

    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setNotifPermission('unsupported');
      toast({ variant: 'destructive', title: 'Browser tidak didukung', description: 'Gunakan Chrome/Edge Android atau Safari iOS 16.4+ dari Home Screen.' });
      return;
    }

    // iPhone: notifikasi hanya dari Home Screen (standalone)
    if (isIOS && !isStandalone) {
      toast({
        title: 'Buka dari Home Screen',
        description: 'Pasang EGS Attendance ke layar utama iPhone terlebih dahulu, lalu buka dari sana untuk mengaktifkan notifikasi.',
      });
      return;
    }

    setNotifLoading(true);
    try {
      // 1. Izin notifikasi
      console.log('[Notif] meminta izin…');
      const perm = await withTimeout(
        Promise.resolve(Notification.requestPermission()),
        20000,
        'izin notifikasi'
      );
      console.log('[Notif] permission:', perm);
      setNotifPermission(perm as any);

      if (perm === 'denied') {
        toast({
          variant: 'destructive',
          title: 'Izin notifikasi ditolak',
          description: isIOS
            ? 'Buka Pengaturan iPhone → EGS Attendance → Notifikasi, lalu aktifkan.'
            : 'Buka pengaturan browser → izinkan notifikasi untuk situs ini.',
        });
        return;
      }
      if (perm !== 'granted') return;

      // 2. Pastikan service worker aktif
      console.log('[Notif] menunggu service worker…');
      const reg = await withTimeout(registerAndWaitForSW(), 15000, 'aktivasi service worker');
      console.log('[Notif] SW active, scope:', reg.scope, 'state:', reg.active?.state);

      // 3. Ambil atau buat push subscription
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidKey) throw new Error('VAPID public key tidak dikonfigurasi');

      const existing = await reg.pushManager.getSubscription();
      console.log('[Notif] existing subscription:', !!existing);

      const applicationServerKey = urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer;
      const sub = existing || await withTimeout(
        reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }),
        15000,
        'push subscribe'
      );
      console.log('[Notif] subscription endpoint:', sub.endpoint.slice(0, 60) + '…');

      // 4. Kirim token ke server
      const { getAuth } = await import('firebase/auth');
      const idToken = await getAuth().currentUser?.getIdToken();
      if (!idToken) throw new Error('Sesi login tidak ditemukan. Silakan login ulang.');

      const platform = isStandalone ? 'pwa' : 'browser';
      console.log('[Notif] mengirim token ke server, platform:', platform);

      const res = await withTimeout(
        fetch('/api/attendance/notifications/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({
            subscription: sub.toJSON(),
            uid: user.uid,
            employeeName: user.displayName || null,
            employeeEmail: (user as any).email || null,
            brandId: user.brandId || null,
            brandName: user.brandName || null,
            siteId: activeSite?.id || null,
            platform,
            userAgent: navigator.userAgent,
          }),
        }),
        15000,
        'server subscribe'
      );
      const data = await res.json().catch(() => ({}));
      console.log('[Notif] server response:', res.status, data);

      if (!res.ok || !data.success) {
        throw new Error(data.error || `Server error ${res.status}`);
      }

      // 5. Simpan state hanya setelah token berhasil tersimpan di server
      setNotifSubscribed(true);
      setNotifTokenStatus('active');
      console.log("[WEB_PUSH_TOKEN_DEBUG]", {
        uid: user.uid,
        permission: perm,
        tokenExists: !!sub,
        tokenSaved: true,
      });
      toast({ title: 'Notifikasi Aktif', description: 'Anda akan mendapat pengingat sebelum jam masuk dan pulang.' });
    } catch (err: any) {
      console.error('[enableNotifications]', err);
      toast({ variant: 'destructive', title: 'Gagal mengaktifkan notifikasi', description: err.message || 'Coba lagi.' });
    } finally {
      setNotifLoading(false);
    }
  }, [notifLoading, user, activeSite, toast]);

  const disableNotifications = useCallback(async () => {
    if (!user) return;
    setNotifLoading(true);
    try {
      const reg = await withTimeout(registerAndWaitForSW(), 15000, 'aktivasi service worker');
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();

      const { getAuth } = await import('firebase/auth');
      const idToken = await getAuth().currentUser?.getIdToken();
      if (idToken) {
        await fetch('/api/attendance/notifications/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ uid: user.uid }),
        });
      }

      setNotifSubscribed(false);
      setNotifTokenStatus('not_enabled');
      toast({ title: 'Notifikasi Dinonaktifkan', description: 'Anda tidak akan menerima pengingat absen.' });
    } catch (err: any) {
      console.error('[disableNotifications]', err);
      toast({ variant: 'destructive', title: 'Gagal menonaktifkan', description: err.message || 'Coba lagi.' });
    } finally {
      setNotifLoading(false);
    }
  }, [user, toast]);

  const sendTestNotification = useCallback(async () => {
    if (!user) return;
    setNotifLoading(true);
    try {
      const { getAuth } = await import('firebase/auth');
      const idToken = await getAuth().currentUser?.getIdToken();
      if (!idToken) throw new Error('Sesi tidak ditemukan');
      const res = await fetch('/api/attendance/notifications/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `Server error ${res.status}`);
      setNotifSubscribed(true);
      setNotifTokenStatus('active');
      toast({ title: 'Notifikasi tes berhasil dikirim', description: 'Periksa notifikasi di perangkat Anda.' });
    } catch (err: any) {
      console.error('[sendTestNotification]', err);
      setNotifSubscribed(false);
      setNotifTokenStatus('expired');
      toast({ variant: 'destructive', title: 'Token notifikasi tidak valid', description: err.message || 'Silakan aktifkan ulang.' });
    } finally {
      setNotifLoading(false);
    }
  }, [user, toast]);

  // Buka modal bukti kondisi dari history (fetch doc by ID jika belum ada)
  const openConditionReportById = useCallback(async (reportId: string) => {
    if (fetchingConditionId) return;
    setFetchingConditionId(reportId);
    try {
      const snap = await getDoc(doc(db, "attendance_condition_reports", reportId));
      if (snap.exists()) {
        const r = { id: snap.id, ...snap.data() };
        const proofUrl = (r as any).conditionProofPhotoUrl || (r as any).proofPhotoUrl || null;
        setConditionPhotoModal({ report: r, fileId: extractDriveFileId(proofUrl), directUrl: proofUrl });
      } else {
        toast({ variant: 'destructive', title: 'Laporan tidak ditemukan', description: 'Data kondisi tidak tersedia.' });
      }
    } catch {
      toast({ variant: 'destructive', title: 'Gagal memuat', description: 'Coba lagi.' });
    } finally {
      setFetchingConditionId(null);
    }
  }, [db, fetchingConditionId, toast]);

  // Ambil ulang lokasi dari verifyLocation step
  const retakeLocation = useCallback(() => {
    setTapStep("locating");
    setTapGps(null);
    setTapAddress(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => proceedWithLocation({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        altitude: pos.coords.altitude,
        heading: pos.coords.heading,
        speed: pos.coords.speed,
      }),
      () => {
        toast({ variant: "destructive", title: "GPS Error", description: "Gagal mengambil ulang lokasi. Pastikan GPS aktif." });
        setTapStep("verifyLocation");
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  }, [proceedWithLocation, toast]);

  const cancelTap = useCallback(() => {
    setTapStep("idle");
    setTapGps(null);
    setTapAddress(null);
    setTapPhoto(null);
    setTapFlags([]);
  }, []);

  const proceedToSelfie = useCallback(() => {
    setTapStep("selfie");
  }, []);

  const handleSelfie = useCallback((base64: string) => {
    setTapPhoto(base64);
    setTapStep("preview");
  }, []);

  const retakeSelfie = useCallback(() => {
    setTapFlags((prev) =>
      prev.includes("camera_retry") ? prev : [...prev, "camera_retry"],
    );
    setTapPhoto(null);
    setTapStep("selfie");
  }, []);

  // ── Condition Report flow ──────────────────────────────────────
  const startConditionReport = useCallback((type: 'check_in' | 'check_out') => {
    setConditionType(type);
    setConditionReason('');
    setConditionNote('');
    setConditionPhoto(null);
    setConditionStep('form');
  }, []);

  const cancelConditionReport = useCallback(() => {
    setConditionStep('idle');
    setConditionReason('');
    setConditionNote('');
    setConditionPhoto(null);
  }, []);

  const handleConditionPhoto = useCallback((base64: string) => {
    setConditionPhoto(base64);
    setConditionStep('form');
  }, []);

  const submitConditionReport = useCallback(async () => {
    if (!conditionReason || !conditionNote.trim() || !conditionPhoto || !user) return;
    setConditionStep('submitting');
    try {
      const now = new Date();
      const todayStr = format(now, "yyyy-MM-dd");
      const gps = locationRef.current;

      let proofPhotoUrl: string | null = null;
      let conditionProofFileId: string | null = null;
      let driveViewUrl: string | null = null;
      let driveDownloadUrl: string | null = null;
      const ts = format(now, 'yyyyMMdd-HHmmss');
      const idStr = user.employeeId || user.uid.slice(0, 8);
      const fileName = `condition-report-${conditionType}-${idStr}-${ts}.jpg`;
      const uploadRes = await fetch('/api/upload-attendance-photo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName,
          mimeType: 'image/jpeg',
          base64: conditionPhoto,
          category: 'condition_report',
          ownerUid: user.uid,
          uploadedBy: user.uid,
        }),
      });
      const uploadData = await uploadRes.json().catch(() => null);
      if (!uploadRes.ok || !uploadData?.success) {
        throw new Error(uploadData?.error || 'Gagal mengunggah foto kondisi ke Google Drive.');
      }
      conditionProofFileId = uploadData.fileId || null;
      driveViewUrl = uploadData.viewUrl || null;
      driveDownloadUrl = uploadData.downloadUrl || null;
      proofPhotoUrl = driveViewUrl || driveDownloadUrl || null;

      // Gunakan liveAddress jika sudah ada (cached), else geocode sekarang
      let reportAddr: AddressDetail | null = liveAddress;
      if (!reportAddr && gps) {
        try { reportAddr = await getDetailedAddress(gps.lat, gps.lng); } catch {}
      }
      const addressStr = reportAddr
        ? [reportAddr.road, reportAddr.kecamatan, reportAddr.kabupatenKota, reportAddr.province].filter(Boolean).join(', ') || reportAddr.displayName
        : null;
      const typeLabel = conditionType === 'check_in' ? 'Kondisi Masuk' : 'Kondisi Pulang';

      const report = cleanUndefined({
        uid: user.uid,
        employeeUid: user.uid,
        userId: user.uid,
        employeeName: user.displayName || null,
        employeeId: user.employeeId || null,
        brandId: user.brandId || null,
        brandName: user.brandName || null,
        siteId: activeSite?.id || null,
        siteName: activeSite?.name || null,
        dateKey: todayStr,
        reportDate: todayStr,
        conditionType,
        conditionTypeLabel: typeLabel,
        reportType: conditionType,
        reasonKey: conditionReason,
        reasonLabel: conditionReason,
        note: conditionNote.trim(),
        specialCondition: conditionReason,
        conditionCategory: conditionType === 'check_in' ? 'kendala_masuk' : 'kondisi_pulang',
        conditionNote: conditionNote.trim(),
        conditionProofPhotoUrl: proofPhotoUrl,
        proofPhotoUrl,
        conditionProofFileId,
        proofPhotoFileId: conditionProofFileId,
        driveFileId: conditionProofFileId,
        driveViewUrl,
        driveDownloadUrl,
        attachmentUrls: proofPhotoUrl ? [proofPhotoUrl] : [],
        attachments: conditionProofFileId ? [{
          fileId: conditionProofFileId,
          viewUrl: driveViewUrl,
          downloadUrl: driveDownloadUrl,
          type: 'condition_proof',
          fileName,
        }] : [],
        conditionProofType: 'reason_proof',
        conditionProofTakenAt: proofPhotoUrl ? now.toISOString() : null,
        reportLocationLat: gps?.lat ?? null,
        reportLocationLng: gps?.lng ?? null,
        reportGpsAccuracy: gps?.accuracy ?? null,
        reportLocationAddress: addressStr,
        address: addressStr,
        status: 'pending_review',
        linkedAttendanceId: null,
        linkedAt: null,
        reviewedByUid: null,
        reviewedAt: null,
        reviewStatus: 'pending',
        reviewNote: '',
        reportedAt: now.toISOString(),
      });

      const payload = {
        ...report,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      console.log("[WEB_ABSEN_CONDITION_REPORT_CREATE_DEBUG]", {
        uid: payload.uid,
        employeeUid: payload.employeeUid,
        dateKey: payload.dateKey,
        reportDate: payload.reportDate,
        conditionProofPhotoUrl: payload.conditionProofPhotoUrl,
        proofPhotoUrl: payload.proofPhotoUrl,
        driveFileId: payload.driveFileId,
      });

      const docRef = await addDoc(collection(db, "attendance_condition_reports"), payload);
      const newId = docRef.id;

      // Simpan ID ke ref agar handleSubmit tidak bergantung pada onSnapshot (mencegah race condition)
      if (conditionType === 'check_in') checkInReportIdRef.current  = newId;
      else                              checkOutReportIdRef.current = newId;

      // Optimistic upsert ke state — onSnapshot akan menyinkronkan ulang, tapi state sudah akurat sekarang
      setTodayConditionReports(prev => {
        const without = prev.filter(r => r.id !== newId && !(r.conditionType === conditionType && !r.id));
        return [...without, { id: newId, ...report, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]
          .sort((a, b) => (a.reportedAt ?? '').localeCompare(b.reportedAt ?? ''));
      });

      cancelConditionReport();
      const attendanceTypeLabel = conditionType === 'check_in' ? 'masuk' : 'pulang';
      toast({ title: 'Laporan terkirim', description: `Kondisi ${attendanceTypeLabel} telah dilaporkan ke HRD untuk direview.` });
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Gagal mengirim laporan', description: err.message || 'Coba lagi.' });
      setConditionStep('form');
    }
  }, [conditionType, conditionReason, conditionNote, conditionPhoto, user, activeSite, db, toast, locationRef, cancelConditionReport, liveAddress]);

  // ── Final submit ───────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!tapPhoto) {
      toast({
        variant: "destructive",
        title: "Foto diperlukan",
        description: tapType === 'IN'
          ? "Foto wajah harus diambil untuk absen masuk."
          : "Foto pulang wajib diambil sebelum mengirim kehadiran pulang.",
      });
      return;
    }
    if (!user) return;
    setTapStep("submitting");
    try {
      const now = tapTime;
      const gps = tapGps;
      const addr = tapAddress;
      const flags = [...tapFlags];
      const { status, lateMinutes, scheduledCheckIn, allowedCheckInTime } = calculateStatus(tapType, now, activeSite);
      const locationStatus = tapGps?.locationStatus ?? (tapGps?.insideRadius === false ? 'outside_radius' : 'inside_radius');
      const needsHrdReview = locationStatus !== 'inside_radius';
      const allowedRadius = activeSite?.radiusM ?? 150;
      const distanceFromSite = gps?.distanceToSiteM ?? null;
      const isOutsideRadius = distanceFromSite !== null ? distanceFromSite > allowedRadius : false;
      const outsideRadiusNote = isOutsideRadius
        ? `Absensi dilakukan di luar radius kantor. Jarak terdeteksi ${Math.round(distanceFromSite!)} meter dari batas ${allowedRadius} meter.`
        : null;

      let driveFileId: string | null = null;
      let driveViewUrl: string | null = null;
      let driveDownload: string | null = null;
      let driveFolderId: string | null = null;
      let selfieUrl: string | null = null;

      if (tapPhoto) {
        const watermarked = await applyWatermark(
          tapPhoto,
          tapType,
          gps ?? {
            lat: 0,
            lng: 0,
            accuracyM: 0,
            altitude: null,
            heading: null,
            speed: null,
            distanceToSiteM: null,
            insideRadius: false,
            locationStatus: 'unknown' as LocationStatus,
            locationConfidence: 'low' as LocationConfidence,
            capturedAt: now,
          },
          addr,
          now,
        );

        const ts       = format(now, 'yyyyMMdd-HHmmss');
        const idStr    = user.employeeId || user.uid.slice(0, 8);
        const eventLabel = tapType === 'IN' ? 'kehadiran_masuk' : 'kehadiran_pulang';
        const fileName = `attendance-${idStr}-${eventLabel}-${ts}.jpg`;

        const uploadRes = await fetch('/api/upload-attendance-photo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName,
            mimeType: 'image/jpeg',
            base64: watermarked,
            category: 'attendance',
            ownerUid: user.uid,
            uploadedBy: user.uid,
          }),
        });
        const uploadData = await uploadRes.json().catch(() => null);
        if (!uploadData?.success) {
          throw new Error(uploadData?.error || 'Gagal mengunggah foto ke Google Drive. Coba lagi.');
        }

        driveFileId   = uploadData.fileId    || null;
        driveViewUrl  = uploadData.viewUrl   || null;
        driveDownload = uploadData.downloadUrl || null;
        driveFolderId = uploadData.folderId  || null;
        selfieUrl     = driveViewUrl || driveDownload || null;
      }

      const datetime = {
        iso: now.toISOString(),
        date: format(now, "yyyy-MM-dd"),
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        hour: now.getHours(),
        minute: now.getMinutes(),
        second: now.getSeconds(),
        timezone: "Asia/Jakarta",
        formatted: wibString(now),
      };

      const siteSnapshot = activeSite
        ? {
            siteId: activeSite.id,
            siteName: activeSite.name,
            siteAddress: activeSite.address || null,
            radiusM: activeSite.radiusM || 150,
            lat: activeSite.lat ?? activeSite.office?.lat ?? null,
            lng: activeSite.lng ?? activeSite.office?.lng ?? null,
            shift: activeSite.shift || null,
            timezone: activeSite.timezone || null,
          }
        : null;

      // Base payload (tanpa Timestamp, akan di-clean)
      const basePayload = {
        uid: user.uid,
        employeeUid: user.uid,
        userName: user.displayName || null,
        brandName: user.brandName || null,
        divisionName: user.division || null,
        employeeId: user.employeeId || null,
        attendanceMethod: "web_absen",
        type: tapType, // "IN" atau "OUT"
        attendanceDate: format(now, "yyyy-MM-dd"),
        attendanceMonth: format(now, "yyyy-MM"),
        attendanceYear: now.getFullYear(),
        datetime,
        address: addr?.displayName || null,
        addressDetail: addr ? {
          displayName: addr.displayName || null,
          road: addr.road || null,
          neighbourhood: addr.neighbourhood || null,
          village: addr.village || null,
          kelurahan: addr.kelurahan || null,
          district: addr.district || null,
          kecamatan: addr.kecamatan || null,
          city: addr.city || null,
          regency: addr.regency || null,
          kabupatenKota: addr.kabupatenKota || null,
          province: addr.province || null,
          postcode: addr.postcode || null,
          country: addr.country || null,
        } : null,
        geo: gps ? {
          lat: gps.lat ?? null,
          lng: gps.lng ?? null,
          accuracyM: gps.accuracyM ?? null,
          distanceToSiteM: gps.distanceToSiteM ?? null,
          insideRadius: gps.insideRadius ?? false,
        } : null,
        status,
        lateMinutes: lateMinutes ?? 0,
        scheduledCheckIn: scheduledCheckIn || null,
        allowedCheckInTime: allowedCheckInTime || null,
        locationStatus,
        // Status lokasi per tipe absen
        ...(tapType === 'IN' ? {
          checkInLocationStatus: locationStatus,
          checkInDistanceFromSite: gps?.distanceToSiteM ?? null,
          checkInNeedsReview: needsHrdReview,
          checkInGpsAccuracy: gps?.accuracyM ?? null,
          checkInLocationConfidence: gps?.locationConfidence ?? null,
          checkInLocationAddress: addr?.displayName || null,
          checkInLocationRoad: addr?.road || null,
          checkInLocationDistrict: addr?.kecamatan || null,
          checkInLocationCity: addr?.kabupatenKota || null,
          needsHrdReview,
        } : {
          checkOutLocationStatus: locationStatus,
          checkOutDistanceFromSite: gps?.distanceToSiteM ?? null,
          checkOutNeedsReview: needsHrdReview,
          checkOutGpsAccuracy: gps?.accuracyM ?? null,
          checkOutLocationConfidence: gps?.locationConfidence ?? null,
          checkOutLocationAddress: addr?.displayName || null,
          checkOutLocationRoad: addr?.road || null,
          checkOutLocationDistrict: addr?.kecamatan || null,
          checkOutLocationCity: addr?.kabupatenKota || null,
          needsHrdReview,
        }),
        // GPS teknis
        gpsAccuracy: gps?.accuracyM ?? null,
        locationConfidence: gps?.locationConfidence ?? null,
        effectiveRadius: activeSite ? (activeSite.radiusM || 150) + (gps?.accuracyM ?? 0) : null,
        allowedRadius,
        isOutsideRadius,
        outsideRadiusNote,
        latitude: gps?.lat ?? null,
        longitude: gps?.lng ?? null,
        locationAddress: addr?.displayName || null,
        // Brand + date canonical key (baca oleh HRP)
        brandId: user.brandId || null,
        dateKey: format(now, "yyyy-MM-dd"),
        // Condition report links
        // Gunakan ref (sinkron, langsung dari addDoc) sebagai primary; state sebagai fallback
        ...(() => {
          const isIn = tapType === 'IN';
          const typeKey = isIn ? 'check_in' : 'check_out';
          // Ref paling andal — tidak bergantung onSnapshot
          const refId = isIn ? checkInReportIdRef.current : checkOutReportIdRef.current;
          // Fallback ke state: pilih laporan terbaru berdasarkan reportedAt
          const stateReport = todayConditionReports
            .filter(r => normalizeReportType(r) === typeKey)
            .sort((a, b) => (b.reportedAt ?? '').localeCompare(a.reportedAt ?? ''))
            [0] ?? null;
          const reportId    = refId ?? stateReport?.id ?? null;
          const reportData  = stateReport ?? null;
          return isIn ? {
            checkInConditionReportId: reportId,
            specialCondition:    reportData?.specialCondition   ?? null,
            conditionNote:       reportData?.conditionNote      ?? null,
            conditionCategory:   reportData?.conditionCategory  ?? null,
            conditionReasonLabel:reportData?.reasonLabel        ?? null,
          } : {
            checkOutConditionReportId: reportId,
            specialCondition:    reportData?.specialCondition   ?? null,
            conditionNote:       reportData?.conditionNote      ?? null,
            conditionCategory:   reportData?.conditionCategory  ?? null,
            conditionReasonLabel:reportData?.reasonLabel        ?? null,
          };
        })(),
        // Hanya sertakan laporan yang sesuai tap type agar tidak mencampur masuk/pulang
        linkedConditionReportIds: (() => {
          const typeKey = tapType === 'IN' ? 'check_in' : 'check_out';
          const refId   = tapType === 'IN' ? checkInReportIdRef.current : checkOutReportIdRef.current;
          const stateIds = todayConditionReports
            .filter(r => normalizeReportType(r) === typeKey)
            .map(r => r.id);
          return refId && !stateIds.includes(refId) ? [refId, ...stateIds] : stateIds;
        })(),
        hasConditionReport: (() => {
          const typeKey = tapType === 'IN' ? 'check_in' : 'check_out';
          const refId   = tapType === 'IN' ? checkInReportIdRef.current : checkOutReportIdRef.current;
          return !!refId || todayConditionReports.some(r => normalizeReportType(r) === typeKey);
        })(),
        // Fields sesuai spec untuk HRD review
        locationLat: gps?.lat ?? null,
        locationLng: gps?.lng ?? null,
        siteLat: (activeSite?.lat ?? activeSite?.office?.lat) || null,
        siteLng: (activeSite?.lng ?? activeSite?.office?.lng) || null,
        distanceFromSite: gps?.distanceToSiteM ?? null,
        radiusM: activeSite?.radiusM ?? null,
        scheduledCheckOut: activeSite?.shift?.endTime ?? null,
        lateToleranceMinutes: activeSite?.shift?.graceLateMinutes ?? null,
        timezone: activeSite?.timezone ?? 'Asia/Jakarta',
        flags: flags || [],
        siteId: activeSite?.id || "OFFSITE",
        siteName: activeSite?.name || "Luar Kantor",
        siteSnapshot,
        photoUrl: selfieUrl,
        ...(tapType === 'IN' ? {
          checkInSelfieUrl: selfieUrl,
          checkInPhotoUrl: selfieUrl,
          checkInPhotoTakenAt: selfieUrl ? now.toISOString() : null,
        } : {
          checkOutSelfieUrl: selfieUrl,
          checkOutPhotoUrl: selfieUrl,
          checkOutPhotoTakenAt: selfieUrl ? now.toISOString() : null,
        }),
        evidence: {
          selfieUrl: driveViewUrl || null,
          watermarkedSelfieUrl: driveViewUrl || null,
          driveFileId: driveFileId || null,
          driveFolderId: driveFolderId || null,
          driveViewUrl: driveViewUrl || null,
          driveDownloadUrl: driveDownload || null,
          storageProvider: "google_drive_apps_script",
          watermarked: true,
          source: "web_absen_hrp",
          userAgent: navigator.userAgent,
          platform: navigator.platform,
        },
      };

      // Clean undefined dari basePayload
      const cleanedPayload = cleanUndefined(basePayload);

      // Tambah Timestamp fields setelah clean
      const payload = {
        ...cleanedPayload,
        tsClient: Timestamp.fromDate(now),
        tsServer: serverTimestamp(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };

      // Buat eventRef lebih dulu agar bisa dipakai untuk linking
      const eventRef = doc(collection(db, "attendance_events"));
      const batch = writeBatch(db);
      batch.set(eventRef, payload);

      // Update linkedAttendanceId — ref sinkron lebih andal daripada state (menghindari race condition)
      const typeKey      = tapType === 'IN' ? 'check_in' : 'check_out';
      const refReportId  = tapType === 'IN' ? checkInReportIdRef.current : checkOutReportIdRef.current;
      const stateReport  = todayConditionReports
        .filter(r => normalizeReportType(r) === typeKey)
        .sort((a, b) => (b.reportedAt ?? '').localeCompare(a.reportedAt ?? ''))[0] ?? null;
      const linkedReportId = refReportId ?? stateReport?.id ?? null;
      if (linkedReportId) {
        const reportRef = doc(db, "attendance_condition_reports", linkedReportId);
        batch.update(reportRef, {
          linkedAttendanceId: eventRef.id,
          linkedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      await batch.commit();
      setTapStep("success");
    } catch (err: any) {
      console.error("Submit error:", err);
      const msg = err.message || "Gagal menyimpan data.";
      toast({
        variant: "destructive",
        title: "Gagal Simpan",
        description: msg,
      });
      setTapStep("preview");
    }
  }, [
    tapPhoto,
    tapTime,
    tapGps,
    tapAddress,
    tapFlags,
    tapType,
    user,
    activeSite,
    calculateStatus,
    applyWatermark,
    db,
    toast,
    todayConditionReports,
  ]);

  // ─── Realtime jarak ke kantor (live, update setiap gps watch) ──
  const liveDistanceToSite = useMemo(() => {
    if (!liveLocation || !activeSite) return null;
    const siteLat = activeSite.lat ?? activeSite.office?.lat;
    const siteLng = activeSite.lng ?? activeSite.office?.lng;
    if (siteLat == null || siteLng == null) return null;
    return getDistance(liveLocation.lat, liveLocation.lng, siteLat, siteLng);
  }, [liveLocation, activeSite]);

  const liveLocationEval = useMemo(() => {
    if (liveDistanceToSite == null || !activeSite || !liveLocation) return null;
    return evaluateLocation(liveDistanceToSite, activeSite.radiusM || 150, liveLocation.accuracy);
  }, [liveDistanceToSite, activeSite, liveLocation]);

  const liveInsideRadius = useMemo(() => {
    if (!liveLocationEval) return null;
    return liveLocationEval.locationStatus === 'inside_radius';
  }, [liveLocationEval]);

  // ─── Shift info dari activeSite ────────────────────────────────
  const shiftInfo = useMemo(() => {
    if (!activeSite?.shift) return null;
    const startTime        = activeSite.shift.startTime        ?? '—';
    const endTime          = activeSite.shift.endTime          ?? '—';
    const graceLateMinutes = activeSite.shift.graceLateMinutes ?? 0;
    const radiusM          = activeSite.radiusM                ?? 150;
    let allowedCheckInTime = '—';
    if (startTime !== '—') {
      const [h, m] = startTime.split(':').map(Number);
      const grace = new Date(0); grace.setHours(h, m + graceLateMinutes, 0, 0);
      allowedCheckInTime = `${String(grace.getHours()).padStart(2,'0')}:${String(grace.getMinutes()).padStart(2,'0')}`;
    }
    return { startTime, endTime, graceLateMinutes, radiusM, allowedCheckInTime };
  }, [activeSite]);

  // ─── Logout ────────────────────────────────────────────────────
  const handleLogout = useCallback(async () => {
    if (logoutLoading) return;
    setLogoutLoading(true);
    try {
      await signOut(auth);
      router.push("/login");
    } catch (err: any) {
      console.error("[AbsenHRP] logout error:", err);
      toast({ variant: "destructive", title: "Gagal keluar", description: err?.message || "Coba lagi." });
    } finally {
      setLogoutLoading(false);
    }
  }, [logoutLoading, auth, router, toast]);

  // ─── Loading guard ─────────────────────────────────────────────
  if (userLoading || (loadingSites && isAttendanceAllowed)) {
    return (
      <div className="min-h-svh flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // ─── Shared header ─────────────────────────────────────────────
  const renderHeader = (showCancel = false) => (
    <>
      {!user?.employeeProfileFound && user?.email && (
        <div className="bg-yellow-50 border-b border-yellow-200 px-4 py-2">
          <div className="flex items-start gap-2 text-[9px]">
            <AlertTriangle className="w-3.5 h-3.5 text-yellow-600 shrink-0 mt-0.5" />
            <p className="text-yellow-800 font-bold">
              Data profil tidak ditemukan di HRP. Hubungi HRD.
            </p>
          </div>
        </div>
      )}
      <div className="bg-white border-b sticky top-0 z-20 shadow-sm">
        <div className="px-4 py-4">
          <div className="flex items-start gap-3 min-w-0">
            <Avatar className="w-11 h-11 shrink-0">
              <AvatarFallback className="bg-primary text-white text-base font-black">
                {user?.displayName
                  ?.split(" ")
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join("") || "?"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="text-base font-black leading-tight truncate">
                {user?.displayName}
              </p>
              {user?.employeeId && (
                <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground mt-1">
                  EMP {user.employeeId}
                </p>
              )}
              <p className="text-sm font-semibold text-slate-700 truncate mt-2">
                {user?.brandName || "Brand belum diatur"}
              </p>
              {user?.division && (
                <p className="text-sm text-muted-foreground truncate">
                  {user.division}
                </p>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <Badge className="text-[9px] font-bold bg-primary/10 text-primary border-primary/20 border py-1 px-2 rounded-full">
              EGS Attendance
            </Badge>
            <div className="flex items-center gap-1.5">
              {!showCancel && isInstalled && (
                <span className="text-[9px] text-green-700 font-bold px-2">✓ App terpasang</span>
              )}
              {showCancel ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={cancelTap}
                  aria-label="Batal"
                  title="Batal"
                  className="rounded-full w-10 h-10 text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-2"
                >
                  <X className="w-4 h-4" aria-hidden="true" />
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleLogout}
                  disabled={logoutLoading}
                  aria-label="Keluar dari aplikasi"
                  title="Keluar"
                  className="rounded-full w-10 h-10 text-muted-foreground hover:text-destructive hover:bg-destructive/10 focus-visible:ring-2 disabled:opacity-50"
                >
                  {logoutLoading
                    ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    : <LogOut className="w-4 h-4" aria-hidden="true" />}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );

  // ─── Step: Locating ────────────────────────────────────────────
  if (tapStep === "locating") {
    return (
      <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto shadow-2xl border-x">
        {renderHeader(true)}
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-4">
          <StepPills current={0} />
          <div className="w-full max-w-xs bg-white rounded-2xl border shadow-sm p-6 text-center space-y-4">
            <div className="w-14 h-14 rounded-full mx-auto flex items-center justify-center bg-primary/10">
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
            </div>
            <p className="font-black text-sm uppercase tracking-tight">
              Mengambil Lokasi...
            </p>
            {/* live GPS accuracy intentionally hidden from UI */}
          </div>
          <Button
            variant="ghost"
            onClick={cancelTap}
            className="text-muted-foreground text-xs"
          >
            Batal
          </Button>
        </div>
      </div>
    );
  }

  // ─── Step: Verify Location ─────────────────────────────────────
  if (tapStep === "verifyLocation") {
    const eventLabel =
      tapType === "IN" ? "Kehadiran Masuk" : "Kehadiran Pulang";
    return (
      <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto shadow-2xl border-x">
        {renderHeader(true)}
        <div className="flex-1 overflow-auto pb-6">
          <StepPills current={0} />

          <div className="p-4 space-y-4">
            {/* Event & Time */}
            <div className="bg-white rounded-2xl border shadow-sm p-4 space-y-3">
              <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest">
                Event & Waktu
              </p>
              <p className="text-lg font-black">{eventLabel}</p>
              <div className="space-y-1">
                <p className="text-sm font-black text-primary tabular-nums">
                  {format(tapTime, "HH:mm:ss")}
                </p>
                <p className="text-[9px] text-muted-foreground">
                  {format(tapTime, "EEEE, dd MMMM yyyy", { locale: localeId })}
                </p>
                <p className="text-[9px] text-muted-foreground">
                  Zona Waktu: WIB (UTC+7)
                </p>
              </div>
            </div>

            {/* Lokasi terdeteksi */}
            {(() => {
              const insideRadius = tapGps?.locationStatus === 'inside_radius';
              const outsideRadius = tapGps?.locationStatus === 'outside_radius';
              const distM = tapGps?.distanceToSiteM ?? null;
              const radiusM = activeSite?.radiusM ?? 150;
              return (
                <div className={`rounded-2xl border shadow-sm p-4 space-y-2 ${insideRadius ? 'bg-emerald-50 border-emerald-200' : outsideRadius ? 'bg-amber-50 border-amber-200' : 'bg-white'}`}>
                  <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest">
                    Lokasi Terdeteksi
                  </p>
                  {tapAddress ? (
                    <p className="text-[13px] font-semibold text-foreground leading-snug">
                      {[tapAddress.road, tapAddress.kecamatan, tapAddress.kabupatenKota, tapAddress.province]
                        .filter(Boolean).join(', ') || tapAddress.displayName}
                    </p>
                  ) : tapGps ? (
                    <p className="text-[11px] text-muted-foreground italic flex items-center gap-1">
                      <Loader2 className="w-3 h-3 animate-spin" /> Memuat alamat…
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground italic">Alamat belum terbaca. Lokasi tetap tersimpan untuk review HRD.</p>
                  )}
                  {/* Status radius */}
                  {tapGps && (
                    insideRadius ? (
                      <div className="space-y-0.5">
                        <p className="text-[11px] font-bold text-emerald-700">✓ Anda berada di area kantor</p>
                        {distM !== null && (
                          <p className="text-[10px] text-emerald-600">Jarak sekitar {Math.round(distM)} m dari titik absensi</p>
                        )}
                      </div>
                    ) : outsideRadius ? (
                      <div className="space-y-1">
                        <p className="text-[11px] font-bold text-amber-700">⚠ Anda berada di luar radius kantor</p>
                        {distM !== null && (
                          <p className="text-[10px] text-amber-600">Jarak terdeteksi {Math.round(distM)} m (radius kantor {radiusM} m)</p>
                        )}
                        <p className="text-[10px] text-amber-700 leading-snug">Anda tetap dapat melakukan absensi. Lokasi dan jarak ini akan dicatat dan dapat ditinjau oleh HRD.</p>
                      </div>
                    ) : (
                      <p className="text-[11px] font-bold text-amber-700">Lokasi akan ditinjau HRD jika diperlukan.</p>
                    )
                  )}
                  {/* Tombol ambil ulang jika GPS kurang presisi */}
                  {tapGps && (tapGps.locationStatus === 'gps_uncertain' || tapGps.locationStatus === 'gps_low_accuracy') && (
                    <Button variant="outline" onClick={retakeLocation} className="w-full h-9 rounded-xl text-[11px] font-bold gap-1.5 mt-1">
                      <Navigation className="w-3.5 h-3.5" /> Ambil Ulang Lokasi
                    </Button>
                  )}
                </div>
              );
            })()}
          </div>

          <div className="px-4 space-y-2">
            <Button
              onClick={proceedToSelfie}
              className={`w-full h-12 rounded-2xl font-bold gap-2${tapType === "OUT" ? " bg-secondary hover:bg-secondary/90" : ""}`}
            >
              <Camera className="w-4 h-4" /> Lanjut Ambil Foto
            </Button>
            <Button
              variant="ghost"
              onClick={cancelTap}
              className="w-full rounded-2xl text-xs text-muted-foreground"
            >
              Batal
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Condition Report: Camera (kamera belakang) ───────────────
  if (conditionStep === 'camera') {
    return <CameraCapture onCapture={handleConditionPhoto} onCancel={() => setConditionStep('form')} facingMode="environment" mode="proof" />;
  }

  // ─── Condition Report: Form / Submitting ───────────────────────
  if (conditionStep === 'form' || conditionStep === 'submitting') {
    const isCheckIn = conditionType === 'check_in';
    const conditionReasonOptions = isCheckIn ? [
      'Ban bocor',
      'Kendala kendaraan',
      'Macet ekstrem',
      'Kendala kesehatan ringan',
      'Tugas luar sebelum ke kantor',
      'Diminta langsung ke lokasi klien/DLH',
      'Lainnya',
    ] : [
      'Tugas luar setelah dari kantor',
      'Langsung pulang dari lokasi klien/DLH',
      'Meeting luar kantor',
      'Perjalanan dinas lokal',
      'Kegiatan lapangan',
      'Kondisi khusus disetujui atasan',
      'Lainnya',
    ];
    const formTitle = isCheckIn ? 'Lapor Kondisi Masuk' : 'Lapor Kondisi Pulang';
    const formSubtitle = isCheckIn
      ? 'Laporan ini sebagai bukti kondisi sebelum masuk. HRD akan melakukan review.'
      : 'Gunakan ini jika Anda absen pulang dari lokasi tugas luar, klien, DLH, lapangan, atau kondisi khusus lainnya.';
    const canSubmit = !!conditionReason && conditionNote.trim().length > 0 && !!conditionPhoto && conditionStep !== 'submitting';
    return (
      <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto shadow-2xl border-x">
        {renderHeader(true)}
        <div className="flex-1 overflow-auto pb-8">
          <div className="px-4 pt-4 pb-2">
            <div className="flex items-center gap-2 mb-1">
              <ShieldAlert className="w-4 h-4 text-amber-600" />
              <p className="font-black text-sm">{formTitle}</p>
            </div>
            <p className="text-[11px] text-muted-foreground leading-snug">
              {formSubtitle}
            </p>
          </div>

          <div className="p-4 space-y-4">
            {/* Reason picker */}
            <div className="bg-white rounded-2xl border shadow-sm p-4 space-y-2">
              <p className="text-[9px] font-black text-muted-foreground uppercase tracking-widest">
                Jenis Kondisi <span className="text-red-500">*</span>
              </p>
              <div className="space-y-1.5">
                {conditionReasonOptions.map(opt => (
                  <button
                    key={opt}
                    onClick={() => setConditionReason(opt)}
                    className={`w-full text-left px-4 py-2.5 rounded-xl border text-sm font-semibold transition-colors ${
                      conditionReason === opt
                        ? 'bg-amber-600 text-white border-amber-600'
                        : 'bg-white text-slate-700 border-slate-200 active:bg-slate-50'
                    }`}
                  >
                    {conditionReason === opt ? '✓ ' : ''}{opt}
                  </button>
                ))}
              </div>
            </div>

            {/* Note */}
            <div className="bg-white rounded-2xl border shadow-sm p-4 space-y-2">
              <p className="text-[9px] font-black text-muted-foreground uppercase tracking-widest">
                Catatan Singkat <span className="text-red-500">*</span>
              </p>
              <textarea
                value={conditionNote}
                onChange={e => setConditionNote(e.target.value)}
                placeholder="Jelaskan kondisi secara singkat, misal: ban bocor di Jl. Sudirman, sedang diperbaiki..."
                rows={4}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm bg-white resize-none focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>

            {/* Foto bukti */}
            <div className="bg-white rounded-2xl border shadow-sm p-4 space-y-2">
              <p className="text-[9px] font-black text-muted-foreground uppercase tracking-widest">
                Foto Bukti Kondisi <span className="text-red-500">*</span>
              </p>
              {conditionPhoto ? (
                <div className="space-y-2">
                  <div className="w-full rounded-xl overflow-hidden border bg-black">
                    <img src={conditionPhoto} alt="Bukti kondisi" className="w-full h-[40vw] max-h-[240px] object-cover bg-black" />
                  </div>
                  <button
                    onClick={() => setConditionStep('camera')}
                    className="text-[11px] font-bold text-amber-700 underline underline-offset-2"
                  >
                    Ulangi foto
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConditionStep('camera')}
                  className="w-full h-24 rounded-xl border-2 border-dashed border-slate-300 flex flex-col items-center justify-center gap-2 text-slate-500 active:bg-slate-50"
                >
                  <Camera className="w-6 h-6" />
                  <span className="text-[11px] font-bold">Ambil Foto Bukti</span>
                </button>
              )}
              <p className="text-[9px] text-muted-foreground">Gunakan kamera belakang. Foto kondisi kendaraan, lokasi tugas, atau situasi lapangan.</p>
            </div>

            {/* Lokasi GPS */}
            <div className="bg-muted/10 rounded-2xl border p-3 space-y-1">
              <div className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <p className="text-[9px] font-black text-muted-foreground uppercase">Lokasi Saat Laporan</p>
              </div>
              {liveLocation ? (
                <>
                  {liveAddress ? (
                    <p className="text-[11px] font-semibold text-foreground leading-snug">
                      {[liveAddress.road, liveAddress.kelurahan, liveAddress.kecamatan, liveAddress.kabupatenKota, liveAddress.province]
                        .filter(Boolean).join(', ') || liveAddress.displayName}
                    </p>
                  ) : (
                    <p className="text-[10px] text-muted-foreground italic">Memuat alamat… Lokasi tetap tersimpan untuk review HRD.</p>
                  )}
                  <p className="text-[9px] text-muted-foreground">Akurasi GPS: ±{Math.round(liveLocation.accuracy)} m</p>
                </>
              ) : (
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Mendeteksi lokasi…
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 pb-6 pt-2 space-y-2 border-t bg-background">
          {conditionStep === 'submitting' && (
            <div className="flex items-center justify-center gap-2 py-2">
              <Loader2 className="w-4 h-4 animate-spin text-amber-600" />
              <p className="text-sm font-bold text-amber-700">Mengirim laporan…</p>
            </div>
          )}
          <Button
            onClick={submitConditionReport}
            disabled={!canSubmit}
            className="w-full h-12 rounded-2xl font-bold gap-2 bg-amber-600 hover:bg-amber-500 text-white"
          >
            <CheckCircle2 className="w-4 h-4" /> {conditionType === 'check_in' ? 'Kirim Laporan Kondisi Masuk' : 'Kirim Laporan Kondisi Pulang'}
          </Button>
          {!conditionReason && <p className="text-[9px] text-muted-foreground text-center">Pilih jenis kondisi</p>}
          {conditionReason && !conditionNote.trim() && <p className="text-[9px] text-muted-foreground text-center">Isi catatan singkat</p>}
          {conditionReason && conditionNote.trim() && !conditionPhoto && <p className="text-[9px] text-muted-foreground text-center">Ambil foto bukti</p>}
          <Button
            variant="ghost"
            onClick={cancelConditionReport}
            className="w-full rounded-2xl text-xs text-muted-foreground"
          >
            Batal
          </Button>
        </div>
      </div>
    );
  }

  // ─── Step: Selfie (kamera depan) ──────────────────────────────
  if (tapStep === "selfie") {
    return <CameraCapture onCapture={handleSelfie} onCancel={cancelTap} facingMode="user" mode="selfie" />;
  }

  // ─── Step: Preview ─────────────────────────────────────────────
  if (tapStep === "preview") {
    return (
      <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto shadow-2xl border-x">
        {renderHeader(true)}
        <div className="flex-1 overflow-auto pb-6">
          <StepPills current={2} />

          {tapPhoto && (
            <div className="px-4">
              <div className="w-full rounded-2xl border shadow-sm overflow-hidden bg-black">
                <img
                  src={tapPhoto}
                  alt="selfie preview"
                  className="w-full h-[64vw] max-h-[760px] object-contain bg-black"
                />
              </div>
            </div>
          )}

          <div className="p-4 space-y-3">
            {/* Identity */}
            <div className="bg-white rounded-2xl border shadow-sm p-4 space-y-1.5">
              <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest">
                Identitas
              </p>
              <p className="text-sm font-black">{user?.displayName}</p>
              {user?.employeeId && (
                <p className="text-[9px] font-mono font-bold text-primary">
                  ID {user.employeeId}
                </p>
              )}
              <p className="text-[9px] text-muted-foreground">
                {user?.brandName}
              </p>
              {user?.division && (
                <p className="text-[9px] text-muted-foreground">
                  {user.division}
                </p>
              )}
            </div>

            {/* Event & time */}
            <div className="bg-white rounded-2xl border shadow-sm p-4">
              <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest mb-2">
                Event
              </p>
              <div className="flex justify-between items-center">
                <span
                  className={`font-black text-sm ${tapType === "IN" ? "text-primary" : "text-secondary"}`}
                >
                  {tapType === "IN"
                    ? "▶ Kehadiran Masuk"
                    : "◀ Kehadiran Pulang"}
                </span>
                <span className="text-sm font-black tabular-nums">
                  {format(tapTime, "HH:mm:ss")}
                </span>
              </div>
              <p className="text-[9px] text-muted-foreground mt-1">
                {format(tapTime, "EEEE, dd MMMM yyyy", { locale: localeId })}
              </p>
            </div>

            {/* Location */}
            <div className="bg-white rounded-2xl border shadow-sm p-4 space-y-2">
              <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest">
                Lokasi
              </p>
              {tapAddress ? (
                <div className="text-[11px] text-muted-foreground leading-tight">
                  <div className="flex items-start gap-2">
                    <MapPin className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
                    <div className="flex-1">
                      {formatAddressLines(tapAddress).length > 0 ? (
                        <div className="space-y-0.5">
                          {formatAddressLines(tapAddress)
                            .slice(0, 6)
                            .map((ln, i) => (
                              <p
                                key={i}
                                className={`truncate ${i === 0 ? "font-black" : "text-[11px] text-muted-foreground"}`}
                              >
                                {ln}
                              </p>
                            ))}
                        </div>
                      ) : (
                        <p className="truncate">{tapAddress.displayName}</p>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-[9px] text-muted-foreground italic flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" /> Memuat alamat...
                </p>
              )}
              {/* Radius status di preview */}
              {tapGps && (
                <div className={`mt-2 rounded-xl px-3 py-2 text-[10px] font-semibold ${tapGps.insideRadius ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                  {tapGps.insideRadius
                    ? `✓ Dalam radius (${Math.round(tapGps.distanceToSiteM ?? 0)} m dari kantor)`
                    : `⚠ Di luar radius — ${Math.round(tapGps.distanceToSiteM ?? 0)} m dari kantor (radius ${activeSite?.radiusM ?? 150} m) · Akan ditinjau HRD`}
                </div>
              )}
            </div>

            {/* Info status di preview */}
            {(() => {
              const { status, lateMinutes: lm, allowedCheckInTime: aci } = calculateStatus(tapType, tapTime, activeSite);
              const isLate    = tapType === 'IN'  && status === 'LATE';
              const isEarly   = tapType === 'OUT' && status === 'EARLY_LEAVE';
              const isOutside = tapGps?.insideRadius === false;
              if (!isLate && !isEarly && !isOutside) return null;
              return (
                <div className="rounded-2xl border shadow-sm overflow-hidden bg-amber-50 border-amber-200">
                  <div className="px-4 py-3 space-y-1.5">
                    {isLate && (
                      <div className="flex items-center gap-2 text-red-700">
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        <p className="text-[11px] font-black">Terlambat {lm} menit · batas {aci} WIB</p>
                      </div>
                    )}
                    {isOutside && (
                      <div className="flex items-center gap-2 text-amber-700">
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        <p className="text-[11px] font-black">
                          Di luar radius · {Math.round(tapGps?.distanceToSiteM ?? 0)} m dari kantor
                        </p>
                      </div>
                    )}
                    {(isLate || isOutside) && todayConditionReports.length > 0 && (
                      <p className="text-[10px] text-teal-700 font-semibold">
                        ✓ Laporan kondisi hari ini tersedia — akan ditautkan ke absen ini.
                      </p>
                    )}
                    {(isLate || isOutside) && todayConditionReports.length === 0 && (
                      <p className="text-[10px] text-muted-foreground">
                        Belum ada laporan kondisi hari ini. Anda bisa melapor kondisi dari halaman utama.
                      </p>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>

          <div className="px-4 space-y-2">
            <Button
              onClick={handleSubmit}
              disabled={false}
              className={`w-full h-12 rounded-2xl font-bold gap-2 ${tapType === "OUT" ? "bg-secondary hover:bg-secondary/90" : ""}`}
            >
              <CheckCircle2 className="w-4 h-4" />
              {tapType === "IN" ? "Kirim Kehadiran Masuk" : "Kirim Kehadiran Pulang"}
            </Button>
            <Button
              variant="outline"
              onClick={retakeSelfie}
              className="w-full h-11 rounded-2xl gap-2"
            >
              <Camera className="w-4 h-4" /> Ulangi Foto
            </Button>
            <Button
              variant="ghost"
              onClick={cancelTap}
              className="w-full rounded-2xl text-xs text-muted-foreground"
            >
              Batal
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Step: Submitting ──────────────────────────────────────────
  if (tapStep === "submitting") {
    return (
      <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto shadow-2xl border-x">
        {renderHeader()}
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <Loader2 className="w-12 h-12 animate-spin text-primary" />
          <div className="text-center">
            <p className="font-black uppercase tracking-tight">
              Menyimpan Absensi
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {tapType === "IN" ? "Mengunggah foto & menyimpan data..." : "Menyimpan data kehadiran pulang..."}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ─── Step: Success ─────────────────────────────────────────────
  if (tapStep === "success") {
    const { status, lateMinutes, allowedCheckInTime } = calculateStatus(
      tapType,
      tapTime,
      activeSite,
    );
    const sa = tapAddress ? shortAddr(tapAddress) : null;
    return (
      <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto shadow-2xl border-x">
        {renderHeader()}
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-5">
          <div className="w-full max-w-xs space-y-4">
            <div className="text-center space-y-2">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
              <h2 className="font-black text-xl text-green-700">
                Absensi Berhasil!
              </h2>
              <p className="text-sm text-muted-foreground font-bold">
                {tapType === "IN"
                  ? "Kehadiran Masuk Tercatat"
                  : "Kehadiran Pulang Tercatat"}
              </p>
            </div>
            <div className="bg-white rounded-2xl border shadow-sm p-4 space-y-2">
              <div className="flex justify-between">
                <p className="text-xs text-muted-foreground font-bold">Waktu</p>
                <p className="text-xs font-black tabular-nums">
                  {format(tapTime, "HH:mm:ss")} WIB
                </p>
              </div>
              <div className="flex justify-between">
                <p className="text-xs text-muted-foreground font-bold">
                  Tanggal
                </p>
                <p className="text-xs font-black">
                  {format(tapTime, "dd MMMM yyyy", { locale: localeId })}
                </p>
              </div>
              <div className="flex justify-between items-center">
                <p className="text-xs text-muted-foreground font-bold">
                  Status
                </p>
                <Badge
                  className={`text-[8px] border-none ${status === "LATE" ? "bg-red-100 text-red-700" : status === "EARLY_LEAVE" ? "bg-orange-100 text-orange-700" : "bg-green-100 text-green-700"}`}
                >
                  {status === "LATE"
                    ? `TERLAMBAT ${lateMinutes}m`
                    : status === "EARLY_LEAVE"
                      ? "PULANG AWAL"
                      : "TEPAT WAKTU"}
                </Badge>
              </div>
              {status === "LATE" && allowedCheckInTime && (
                <div className="flex justify-between text-[9px] text-red-600">
                  <span>Batas toleransi</span>
                  <span className="font-black tabular-nums">{allowedCheckInTime} WIB</span>
                </div>
              )}
              {/* Zona badge hidden per simplified UI */}
              {sa && (
                <p className="text-[8px] text-muted-foreground pt-1 border-t">
                  {sa}
                </p>
              )}
            </div>
            <Button
              className="w-full h-12 rounded-2xl font-bold"
              onClick={cancelTap}
            >
              Selesai
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Status badge helper ───────────────────────────────────────
  const statusBadgeCls = (status: string) =>
    status === "LATE"
      ? "bg-red-100    text-red-600"
      : status === "EARLY_LEAVE"
        ? "bg-orange-100 text-orange-600"
        : status === "ON_TIME"
          ? "bg-green-100  text-green-700"
          : "bg-muted      text-muted-foreground";

  const statusLabel = (ev: any) =>
    ev.status === "LATE"
      ? `Terlambat ${ev.lateMinutes}m`
      : ev.status === "EARLY_LEAVE"
        ? "Pulang Awal"
        : ev.status === "ON_TIME"
          ? "Tepat Waktu"
          : "Hadir";

  // ─── Main UI (idle) ────────────────────────────────────────────
  return (
    <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto shadow-2xl border-x">
      <div className="flex-1 overflow-auto pb-24">
        {renderHeader()}

        <Tabs defaultValue="absen" className="w-full">
          <TabsList className="grid w-full grid-cols-2 rounded-none h-11 border-b bg-muted/20 sticky top-[57px] z-10">
            <TabsTrigger value="absen" className="gap-1.5 text-xs">
              <Navigation className="w-3.5 h-3.5" /> Absensi
            </TabsTrigger>
            <TabsTrigger value="history" className="gap-1.5 text-xs">
              <FileText className="w-3.5 h-3.5" /> Riwayat
            </TabsTrigger>
          </TabsList>

          {/* ════════════════════════════════════════════════════ */}
          {/*  TAB: ABSENSI                                        */}
          {/* ════════════════════════════════════════════════════ */}
          <TabsContent value="absen" className="p-4 space-y-4">
            {/* Access denied */}
            {!isAttendanceAllowed && (
              <Alert
                variant="destructive"
                className="border-destructive/50 bg-destructive/5"
              >
                <ShieldAlert className="h-4 w-4" />
                <AlertTitle className="text-xs font-black uppercase">
                  Akses Dibatasi
                </AlertTitle>
                <AlertDescription className="text-[11px] mt-1 leading-snug">
                  {restrictedMessage || "Hubungi HRD untuk akses absensi."}
                </AlertDescription>
              </Alert>
            )}

            {/* ── Kartu Hari Ini ───────────────────────────────── */}
            <div className="bg-white rounded-2xl border shadow-sm p-4 flex justify-between items-center">
              <div>
                <p className="text-[9px] font-bold text-muted-foreground uppercase flex items-center gap-1 mb-1">
                  <CalendarDays className="w-3 h-3" /> Hari Ini
                </p>
                <p className="text-sm font-black leading-tight">
                  {format(currentTime, "EEEE, dd MMMM yyyy", {
                    locale: localeId,
                  })}
                </p>
                <p className="text-2xl font-black tabular-nums mt-1 text-primary">
                  {format(currentTime, "HH:mm:ss")}
                  <span className="text-xs font-bold text-muted-foreground ml-1">
                    WIB
                  </span>
                </p>
              </div>
              <div className="text-right">
                {!todayStatus.hasIn && !todayStatus.hasOut && (
                  <Badge className="bg-orange-100 text-orange-700 border-none text-[8px]">
                    Belum Kehadiran Masuk
                  </Badge>
                )}
                {todayStatus.hasIn && !todayStatus.hasOut && (
                  <Badge className="bg-green-100 text-green-700 border-none text-[8px]">
                    Sedang Bekerja
                  </Badge>
                )}
                {todayStatus.hasIn && todayStatus.hasOut && (
                  <Badge className="bg-blue-100 text-blue-700 border-none text-[8px]">
                    Selesai
                  </Badge>
                )}
              </div>
            </div>

            {/* ── Kartu Kehadiran Masuk / Pulang ─────────────────────── */}
            <div className="grid grid-cols-2 gap-3">
              {/* Kehadiran Masuk card */}
              <div
                className={`bg-white rounded-2xl border shadow-sm p-3.5 space-y-2 ${todayCheckIn ? "border-green-200" : ""}`}
              >
                <p className="text-[8px] font-black text-muted-foreground uppercase flex items-center gap-1">
                  <LogIn className="w-3 h-3 text-primary" /> Kehadiran Masuk
                </p>
                {todayCheckIn ? (
                  <>
                    <p className="text-2xl font-black tabular-nums text-primary leading-none">
                      {format(todayCheckIn._date, "HH:mm:ss")}
                    </p>
                    <Badge
                      className={`text-[7px] border-none ${statusBadgeCls(todayCheckIn.status)}`}
                    >
                      {statusLabel(todayCheckIn)}
                    </Badge>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground italic pt-1">
                    Belum kehadiran masuk
                  </p>
                )}
              </div>

              {/* Kehadiran Pulang card */}
              <div
                className={`bg-white rounded-2xl border shadow-sm p-3.5 space-y-2 ${todayCheckOut ? "border-blue-200" : ""}`}
              >
                <p className="text-[8px] font-black text-muted-foreground uppercase flex items-center gap-1">
                  <LogOut className="w-3 h-3 text-secondary" /> Kehadiran Pulang
                </p>
                {todayCheckOut ? (
                  <>
                    <p className="text-2xl font-black tabular-nums text-secondary leading-none">
                      {format(todayCheckOut._date, "HH:mm:ss")}
                    </p>
                    <Badge
                      className={`text-[7px] border-none ${statusBadgeCls(todayCheckOut.status)}`}
                    >
                      {statusLabel(todayCheckOut)}
                    </Badge>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground italic pt-1">
                    Belum kehadiran pulang
                  </p>
                )}
              </div>
            </div>

            {/* ── Aturan Hari Ini (dari attendance_sites) ────────── */}
            {isAttendanceAllowed && shiftInfo && (
              <div className="bg-white rounded-2xl border shadow-sm p-4">
                <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest mb-3 flex items-center gap-1.5">
                  <Clock className="w-3 h-3" /> Aturan Hari Ini
                </p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
                  <div>
                    <p className="text-muted-foreground text-[9px]">Jam Masuk</p>
                    <p className="font-black tabular-nums">{shiftInfo.startTime} WIB</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-[9px]">Batas Telat</p>
                    <p className="font-black tabular-nums text-amber-700">{shiftInfo.allowedCheckInTime} WIB</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-[9px]">Jam Pulang</p>
                    <p className="font-black tabular-nums">{shiftInfo.endTime} WIB</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-[9px]">Radius Kantor</p>
                    <p className="font-black tabular-nums">{shiftInfo.radiusM} m</p>
                  </div>
                </div>
                {shiftInfo.graceLateMinutes > 0 && (
                  <p className="text-[9px] text-muted-foreground mt-2 border-t pt-2">
                    Toleransi keterlambatan: <span className="font-bold">{shiftInfo.graceLateMinutes} menit</span>
                  </p>
                )}
              </div>
            )}

            {/* ── Status Lokasi Realtime ──────────────────────────── */}
            {isAttendanceAllowed && (() => {
              const liveInside = liveLocationEval?.locationStatus === 'inside_radius';
              const liveOutside = liveLocationEval?.locationStatus === 'outside_radius';
              const liveDistM = liveDistanceToSite;
              const liveRadiusM = activeSite?.radiusM ?? 150;
              const liveAccuracy = liveLocation?.accuracy ?? null;
              return (
                <div className={`rounded-2xl border shadow-sm p-4 ${
                  liveInside ? 'bg-emerald-50 border-emerald-200' : liveOutside ? 'bg-amber-50 border-amber-200' : 'bg-white'
                }`}>
                  <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest mb-2 flex items-center gap-1.5">
                    <MapPin className="w-3 h-3" /> Lokasi Anda Sekarang
                  </p>
                  {liveLocation ? (
                    <div className="space-y-2">
                      {/* Alamat */}
                      {liveAddress ? (
                        <p className="text-[12px] font-semibold text-foreground leading-snug">
                          {[liveAddress.road, liveAddress.kecamatan, liveAddress.kabupatenKota, liveAddress.province]
                            .filter(Boolean).join(', ') || liveAddress.displayName}
                        </p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground italic flex items-center gap-1">
                          <Loader2 className="w-3 h-3 animate-spin" /> Memuat alamat…
                        </p>
                      )}

                      {/* Status radius */}
                      {liveLocationEval ? (
                        liveInside ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-1.5">
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700">
                                <span className="text-base leading-none">✓</span> Anda berada dalam radius kantor
                              </span>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="bg-emerald-100/60 rounded-xl px-3 py-2">
                                <p className="text-[8px] text-emerald-600 font-bold uppercase">Jarak Anda</p>
                                <p className="text-sm font-black text-emerald-800 tabular-nums">{liveDistM !== null ? `${Math.round(liveDistM)} m` : '— m'}</p>
                              </div>
                              <div className="bg-emerald-100/60 rounded-xl px-3 py-2">
                                <p className="text-[8px] text-emerald-600 font-bold uppercase">Batas Radius</p>
                                <p className="text-sm font-black text-emerald-800 tabular-nums">{liveRadiusM} m</p>
                              </div>
                            </div>
                            <p className="text-[10px] text-emerald-700">Lokasi Anda sesuai area absensi kantor.</p>
                            {liveAccuracy !== null && (
                              <p className="text-[9px] text-emerald-600/70">Akurasi GPS: ±{Math.round(liveAccuracy)} m</p>
                            )}
                          </div>
                        ) : liveOutside ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-1.5">
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-700">
                                <span className="text-base leading-none">⚠</span> Anda berada di luar radius kantor
                              </span>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="bg-amber-100/60 rounded-xl px-3 py-2">
                                <p className="text-[8px] text-amber-600 font-bold uppercase">Jarak Anda</p>
                                <p className="text-sm font-black text-amber-800 tabular-nums">{liveDistM !== null ? `${Math.round(liveDistM)} m` : '— m'}</p>
                              </div>
                              <div className="bg-amber-100/60 rounded-xl px-3 py-2">
                                <p className="text-[8px] text-amber-600 font-bold uppercase">Batas Radius</p>
                                <p className="text-sm font-black text-amber-800 tabular-nums">{liveRadiusM} m</p>
                              </div>
                            </div>
                            <p className="text-[10px] text-amber-700 leading-snug">Anda tetap dapat melakukan absensi, tetapi data lokasi ini akan dicatat untuk ditinjau oleh HRD.</p>
                            {liveAccuracy !== null && (
                              <p className="text-[9px] text-amber-600/70">Akurasi GPS: ±{Math.round(liveAccuracy)} m</p>
                            )}
                          </div>
                        ) : (
                          <p className="text-[11px] text-muted-foreground">Mendeteksi jarak ke kantor…</p>
                        )
                      ) : (
                        <p className="text-[11px] text-muted-foreground">Mendeteksi kantor terdekat…</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                      <Loader2 className="w-3 h-3 animate-spin" /> Mendeteksi lokasi…
                    </p>
                  )}
                </div>
              );
            })()}

            {/* ── Card: Kondisi Khusus Hari Ini ─────────────────── */}
            {isAttendanceAllowed && (() => {
              const checkInReports  = todayConditionReports.filter(r => normalizeReportType(r) === 'check_in');
              const checkOutReports = todayConditionReports.filter(r => normalizeReportType(r) === 'check_out');

              // Compact chip — 1 baris, klik untuk buka detail modal
              const renderCompactChip = (r: any, label: string) => {
                const proofUrl = r.conditionProofPhotoUrl || r.proofPhotoUrl || null;
                const proofFileId = extractDriveFileId(proofUrl);
                const reviewBadge = r.reviewStatus === 'accepted'
                  ? { cls: 'bg-green-100 text-green-700', txt: 'Diterima' }
                  : r.reviewStatus === 'rejected'
                  ? { cls: 'bg-red-100 text-red-700', txt: 'Ditolak' }
                  : { cls: 'bg-yellow-100 text-yellow-800', txt: 'Menunggu Review' };
                return (
                  <div key={r.id} className="flex items-center justify-between gap-2 bg-slate-50 rounded-xl border px-3 py-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ShieldAlert className="w-3 h-3 text-amber-500 shrink-0" />
                      <span className="text-[10px] font-bold text-slate-700 truncate">{label}: {r.reasonLabel}</span>
                      <Badge className={`text-[7px] border-none shrink-0 ${reviewBadge.cls}`}>{reviewBadge.txt}</Badge>
                    </div>
                    <button
                      onClick={() => setConditionPhotoModal({ report: r, fileId: proofFileId, directUrl: proofUrl })}
                      className="text-[9px] text-teal-700 font-bold underline underline-offset-2 shrink-0 hover:text-teal-600"
                    >
                      Lihat Detail
                    </button>
                  </div>
                );
              };

              // Phase: belum_check_in | checked_in | checked_out
              const phase = !todayStatus.hasIn ? 'belum_check_in' : !todayStatus.hasOut ? 'checked_in' : 'checked_out';

              return (
                <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
                  <div className="px-4 py-2.5 border-b bg-amber-50/60 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />
                      <p className="text-[8px] font-black text-amber-800 uppercase tracking-widest">Kondisi Khusus Hari Ini</p>
                    </div>
                    {loadingConditionReports && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                  </div>

                  <div className="p-4 space-y-3">
                    {/* ── Phase: belum_check_in — fokus Kondisi Masuk ── */}
                    {phase === 'belum_check_in' && (
                      <>
                        <p className="text-[10px] text-muted-foreground leading-snug">
                          Laporkan jika ada kendala sebelum sampai kantor atau sebelum absen masuk.
                        </p>
                        {checkInReports.length > 0 ? (
                          <div className="space-y-1.5">
                            {checkInReports.map(r => {
                              const proofUrl = r.conditionProofPhotoUrl || r.proofPhotoUrl || null;
                              const proofFileId = extractDriveFileId(proofUrl);
                              const reviewBadge = r.reviewStatus === 'accepted'
                                ? { cls: 'bg-green-100 text-green-700', txt: 'Diterima HRD' }
                                : r.reviewStatus === 'rejected'
                                ? { cls: 'bg-red-100 text-red-700', txt: 'Ditolak HRD' }
                                : { cls: 'bg-yellow-100 text-yellow-800', txt: 'Menunggu Review' };
                              return (
                                <div key={r.id} className="bg-amber-50 rounded-xl border border-amber-200 p-3 space-y-1.5">
                                  <div className="flex items-start justify-between gap-2">
                                    <p className="text-[11px] font-black text-amber-800">{r.reasonLabel}</p>
                                    <Badge className={`text-[7px] border-none shrink-0 ${reviewBadge.cls}`}>{reviewBadge.txt}</Badge>
                                  </div>
                                  {r.note && <p className="text-[10px] text-slate-700">{r.note}</p>}
                                  {r.reportedAt && (
                                    <p className="text-[9px] text-muted-foreground">
                                      Dilaporkan: {format(new Date(r.reportedAt), "HH:mm", { locale: localeId })} WIB
                                    </p>
                                  )}
                                  {proofUrl && (
                                    <button
                                      onClick={() => setConditionPhotoModal({ report: r, fileId: proofFileId, directUrl: proofUrl })}
                                      className="flex items-center gap-1 text-[9px] text-teal-700 font-bold underline underline-offset-2 hover:text-teal-600"
                                    >
                                      <Camera className="w-2.5 h-2.5 shrink-0" /> Lihat Foto Bukti
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                        <Button
                          variant="outline"
                          onClick={() => startConditionReport('check_in')}
                          className="w-full h-10 rounded-xl text-[11px] font-black gap-1.5 border-amber-300 text-amber-700 hover:bg-amber-100 hover:text-amber-800 hover:border-amber-400"
                        >
                          <ShieldAlert className="w-3.5 h-3.5" /> Lapor Kondisi Masuk
                        </Button>
                      </>
                    )}

                    {/* ── Phase: checked_in — fokus Kondisi Pulang ── */}
                    {phase === 'checked_in' && (
                      <>
                        {/* Kondisi Masuk ringkasan jika ada */}
                        {checkInReports.length > 0 && (
                          <div className="space-y-1">
                            <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest">Kondisi Masuk Tersimpan</p>
                            <div className="space-y-1">{checkInReports.map(r => renderCompactChip(r, 'Masuk'))}</div>
                          </div>
                        )}

                        <p className="text-[10px] text-muted-foreground leading-snug">
                          Laporkan jika ada kondisi khusus saat absen pulang, misalnya pulang dari lokasi tugas luar.
                        </p>
                        {checkOutReports.length > 0 ? (
                          <div className="space-y-1.5">
                            {checkOutReports.map(r => {
                              const proofUrl = r.conditionProofPhotoUrl || r.proofPhotoUrl || null;
                              const proofFileId = extractDriveFileId(proofUrl);
                              const reviewBadge = r.reviewStatus === 'accepted'
                                ? { cls: 'bg-green-100 text-green-700', txt: 'Diterima HRD' }
                                : r.reviewStatus === 'rejected'
                                ? { cls: 'bg-red-100 text-red-700', txt: 'Ditolak HRD' }
                                : { cls: 'bg-yellow-100 text-yellow-800', txt: 'Menunggu Review' };
                              return (
                                <div key={r.id} className="bg-blue-50 rounded-xl border border-blue-200 p-3 space-y-1.5">
                                  <div className="flex items-start justify-between gap-2">
                                    <p className="text-[11px] font-black text-blue-800">{r.reasonLabel}</p>
                                    <Badge className={`text-[7px] border-none shrink-0 ${reviewBadge.cls}`}>{reviewBadge.txt}</Badge>
                                  </div>
                                  {r.note && <p className="text-[10px] text-slate-700">{r.note}</p>}
                                  {r.reportedAt && (
                                    <p className="text-[9px] text-muted-foreground">
                                      Dilaporkan: {format(new Date(r.reportedAt), "HH:mm", { locale: localeId })} WIB
                                    </p>
                                  )}
                                  {proofUrl && (
                                    <button
                                      onClick={() => setConditionPhotoModal({ report: r, fileId: proofFileId, directUrl: proofUrl })}
                                      className="flex items-center gap-1 text-[9px] text-teal-700 font-bold underline underline-offset-2 hover:text-teal-600"
                                    >
                                      <Camera className="w-2.5 h-2.5 shrink-0" /> Lihat Foto Bukti
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                        <Button
                          variant="outline"
                          onClick={() => startConditionReport('check_out')}
                          className="w-full h-10 rounded-xl text-[11px] font-black gap-1.5 border-blue-300 text-blue-700 hover:bg-blue-100 hover:text-blue-800 hover:border-blue-400"
                        >
                          <ShieldAlert className="w-3.5 h-3.5" /> Lapor Kondisi Pulang
                        </Button>
                      </>
                    )}

                    {/* ── Phase: checked_out — ringkasan saja ── */}
                    {phase === 'checked_out' && (
                      <>
                        {checkInReports.length === 0 && checkOutReports.length === 0 ? (
                          <p className="text-[10px] text-muted-foreground italic text-center py-1">Tidak ada laporan kondisi hari ini.</p>
                        ) : (
                          <div className="space-y-1.5">
                            {checkInReports.length > 0 && (
                              <div className="space-y-1">
                                <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest">Kondisi Masuk</p>
                                <div className="space-y-1">{checkInReports.map(r => renderCompactChip(r, 'Masuk'))}</div>
                              </div>
                            )}
                            {checkOutReports.length > 0 && (
                              <div className="space-y-1">
                                <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest mt-1">Kondisi Pulang</p>
                                <div className="space-y-1">{checkOutReports.map(r => renderCompactChip(r, 'Pulang'))}</div>
                              </div>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* ── Card: Notifikasi Absen ────────────────────────── */}
            {isAttendanceAllowed && (() => {
              const isIOS = /iphone|ipad|ipod/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : '');
              const isStandalone = typeof window !== 'undefined' && (
                window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true
              );
              const iOSNeedsInstall = isIOS && !isStandalone;
              const startTime = activeSite?.shift?.startTime || activeSite?.shift?.jamMasuk || null;
              const endTime = activeSite?.shift?.endTime || activeSite?.shift?.jamPulang || null;
              const reminderTime = (time: string | null) => {
                if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return null;
                const [h, m] = time.split(':').map(Number);
                const total = ((h * 60 + m - 15) % 1440 + 1440) % 1440;
                return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
              };
              const checkInReminder = reminderTime(startTime);
              const checkOutReminder = reminderTime(endTime);

              return (
                <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
                  <div className="px-4 py-2.5 border-b bg-slate-50/80 flex items-center gap-1.5">
                    <Bell className="w-3.5 h-3.5 text-slate-500" />
                    <p className="text-[8px] font-black text-slate-600 uppercase tracking-widest">Notifikasi Absen</p>
                  </div>
                  <div className="p-4 space-y-3">
                    {notifPermission === 'unsupported' ? (
                      <div className="space-y-1.5">
                        <p className="text-[10px] text-muted-foreground leading-snug">
                          Browser ini belum mendukung push notification. Gunakan Chrome/Edge di Android atau pasang EGS Attendance ke Home Screen.
                        </p>
                        {iOSNeedsInstall && (
                          <div className="bg-blue-50 rounded-xl border border-blue-200 px-3 py-2">
                            <p className="text-[10px] text-blue-700 font-semibold">
                              iPhone: Pasang EGS Attendance ke Home Screen terlebih dahulu agar notifikasi dapat berjalan.
                            </p>
                          </div>
                        )}
                      </div>
                    ) : notifPermission === 'denied' ? (
                      <div className="space-y-1.5">
                        <p className="text-[10px] text-muted-foreground leading-snug">
                          Izin notifikasi ditolak. Aktifkan melalui pengaturan browser/HP.
                        </p>
                        <div className="bg-red-50 rounded-xl border border-red-200 px-3 py-2">
                          <p className="text-[10px] text-red-700 font-semibold">
                            Buka Pengaturan → Situs / Notifikasi → izinkan untuk halaman ini.
                          </p>
                        </div>
                      </div>
                    ) : notifPermission === 'granted' && notifTokenStatus === 'checking' ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-500" />
                          <p className="text-[11px] font-bold text-slate-700">Memeriksa token notifikasi</p>
                        </div>
                        <p className="text-[9px] text-muted-foreground leading-snug">
                          Sistem sedang memastikan token push tersimpan di server.
                        </p>
                      </div>
                    ) : notifPermission === 'granted' && notifTokenStatus === 'expired' ? (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-amber-500" />
                          <p className="text-[11px] font-bold text-amber-700">Notifikasi perlu diaktifkan ulang</p>
                        </div>
                        <p className="text-[9px] text-muted-foreground leading-snug">
                          Token push belum tersimpan atau sudah tidak valid. Aktifkan ulang agar pengingat bisa dikirim.
                        </p>
                        <Button
                          onClick={enableNotifications}
                          disabled={notifLoading || iOSNeedsInstall}
                          variant="outline"
                          className="w-full h-10 rounded-xl text-[11px] font-black gap-1.5 border-amber-300 text-amber-700 hover:bg-amber-50"
                        >
                          {notifLoading
                            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Mengaktifkan…</>
                            : <><Bell className="w-3.5 h-3.5" /> Aktifkan Ulang</>
                          }
                        </Button>
                      </div>
                    ) : notifSubscribed && notifPermission === 'granted' && notifTokenStatus === 'active' ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-green-500" />
                          <p className="text-[11px] font-bold text-green-700">Notifikasi Aktif</p>
                        </div>
                        <p className="text-[9px] text-muted-foreground leading-snug">
                          Pengingat masuk {checkInReminder ? `pukul ${checkInReminder}` : 'mengikuti jadwal'} dan pulang {checkOutReminder ? `pukul ${checkOutReminder}` : 'mengikuti jadwal'}.
                        </p>
                        <div className="flex gap-3">
                          <button
                            onClick={sendTestNotification}
                            disabled={notifLoading}
                            className="text-[9px] text-primary font-bold underline underline-offset-2 hover:text-primary/70 disabled:opacity-50"
                          >
                            {notifLoading ? 'Mengirim…' : 'Kirim notifikasi tes'}
                          </button>
                          <button
                            onClick={disableNotifications}
                            disabled={notifLoading}
                            className="text-[9px] text-muted-foreground underline underline-offset-2 hover:text-slate-700 disabled:opacity-50"
                          >
                            Nonaktifkan
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-[10px] text-muted-foreground leading-snug">
                          Aktifkan pengingat agar Anda mendapat notifikasi sebelum jam masuk dan sebelum jam pulang.
                        </p>
                        {iOSNeedsInstall && (
                          <div className="bg-blue-50 rounded-xl border border-blue-200 px-3 py-2">
                            <p className="text-[10px] text-blue-700 font-semibold">
                              iPhone: Pasang EGS Attendance ke Home Screen terlebih dahulu agar notifikasi dapat berjalan.
                            </p>
                          </div>
                        )}
                        <Button
                          onClick={enableNotifications}
                          disabled={notifLoading || iOSNeedsInstall}
                          variant="outline"
                          className="w-full h-10 rounded-xl text-[11px] font-black gap-1.5 border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-800 hover:border-slate-400"
                        >
                          {notifLoading
                            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Mengaktifkan…</>
                            : <><Bell className="w-3.5 h-3.5" /> Aktifkan Notifikasi</>
                          }
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* ── Action button ─────────────────────────────────── */}
            {isAttendanceAllowed && !isFinished && (
              <Button
                onClick={() => startTapFlow(nextAction)}
                disabled={loadingSites}
                className={`w-full h-14 rounded-2xl font-black text-base gap-3 shadow-md ${
                  nextAction === "IN"
                    ? "bg-primary hover:bg-primary/90"
                    : "bg-secondary hover:bg-secondary/90"
                }`}
              >
                {nextAction === "IN" ? (
                  <><LogIn className="w-5 h-5" /> Kehadiran Masuk</>
                ) : (
                  <><LogOut className="w-5 h-5" /> Kehadiran Pulang</>
                )}
              </Button>
            )}

            {isFinished && (
              <div className="flex items-center justify-center gap-2 py-3 bg-green-50 rounded-2xl border border-green-200">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                <p className="text-xs font-bold text-green-700">Kehadiran hari ini selesai</p>
              </div>
            )}

            {!isAttendanceAllowed && <div className="h-2" />}

            {/* ── Additional compact sections (mobile-first) ── */}
            <div className="space-y-3">
              {/* A. Ringkasan Kehadiran Hari Ini */}
              <div className="bg-white rounded-2xl border shadow-sm p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[9px] font-black text-muted-foreground uppercase">
                    Ringkasan Kehadiran Hari Ini
                  </p>
                  <span className="text-[11px] font-bold text-muted-foreground">
                    {todayStatus.hasIn ? (todayStatus.hasOut ? "Selesai" : "Sedang Bekerja") : "Belum Kehadiran"}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-muted/10 rounded-xl p-2">
                    <p className="text-[9px] text-muted-foreground">Masuk</p>
                    <p className="font-black tabular-nums text-sm">
                      {todayCheckIn ? format(todayCheckIn._date, "HH:mm") : "—"}
                    </p>
                    {todayCheckIn?.status === 'LATE' && (
                      <p className="text-[9px] text-red-600 font-bold">
                        Terlambat {todayCheckIn.lateMinutes}m
                        {todayCheckIn.allowedCheckInTime && ` · batas ${todayCheckIn.allowedCheckInTime}`}
                      </p>
                    )}
                    {todayCheckIn?.status === 'ON_TIME' && (
                      <p className="text-[9px] text-green-600 font-bold">Tepat Waktu</p>
                    )}
                  </div>
                  <div className="bg-muted/10 rounded-xl p-2">
                    <p className="text-[9px] text-muted-foreground">Pulang</p>
                    <p className="font-black tabular-nums text-sm">
                      {todayCheckOut ? format(todayCheckOut._date, "HH:mm") : "—"}
                    </p>
                    {todayCheckOut?.status === 'EARLY_LEAVE' && (
                      <p className="text-[9px] text-orange-600 font-bold">Pulang Awal</p>
                    )}
                  </div>
                </div>
              </div>

              {/* D. Aktivitas Terakhir */}
              <div className="bg-white rounded-2xl border shadow-sm p-3">
                <p className="text-[9px] font-black text-muted-foreground uppercase mb-2">
                  Aktivitas Terakhir
                </p>
                <div className="space-y-2">
                  {sortedEvents && sortedEvents.length > 0 ? (
                    sortedEvents.slice(0, 3).map((ev: any) => {
                      let dt: Date | null = null;
                      try {
                        dt = ev.tsClient instanceof Timestamp
                          ? ev.tsClient.toDate()
                          : ev.tsClient ? new Date(ev.tsClient) : null;
                        if (dt && isNaN(dt.getTime())) dt = null;
                      } catch { dt = null; }
                      if (!dt) return null;
                      return (
                        <div key={ev.id || ev.tsClient} className="flex items-center justify-between">
                          <div>
                            <p className="text-[11px] font-black">
                              {format(dt, "dd MMM", { locale: localeId })}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {ev.type === "IN" ? "Kehadiran Masuk" : "Kehadiran Pulang"}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-black tabular-nums">{format(dt, "HH:mm")}</p>
                            <p className={`text-[10px] ${ev.status === 'LATE' ? 'text-red-600 font-bold' : 'text-muted-foreground'}`}>
                              {ev.status === 'LATE' ? `Terlambat ${ev.lateMinutes}m` : ev.status === 'ON_TIME' ? 'Tepat Waktu' : ev.status || "—"}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-[11px] text-muted-foreground">Belum ada aktivitas kehadiran.</p>
                  )}
                </div>
              </div>

              {/* E. Informasi Singkat */}
              <div className="bg-muted/5 rounded-2xl border p-3 text-[11px] text-muted-foreground">
                Pastikan lokasi aktif dan wajah terlihat jelas saat mengambil foto kehadiran.
              </div>
            </div>
          </TabsContent>

          {/* ════════════════════════════════════════════════════ */}
          {/*  TAB: RIWAYAT                                        */}
          {/* ════════════════════════════════════════════════════ */}
          <TabsContent value="history" className="p-4 space-y-4">
            {!isAttendanceAllowed ? (
              <div className="py-12 flex flex-col items-center gap-3 text-muted-foreground opacity-50">
                <FileText className="w-8 h-8" />
                <p className="text-xs italic">
                  Riwayat tidak tersedia untuk akun ini.
                </p>
              </div>
            ) : (
              <>
                {/* Filters — Hari Ini / Pilih Tanggal */}
                <div className="bg-white rounded-2xl border shadow-sm p-3 space-y-2.5">
                  <div className="flex gap-2">
                    {(["today", "pick"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setHistoryMode(m)}
                        className={`flex-1 h-9 rounded-xl text-[11px] font-bold transition-colors border ${
                          historyMode === m
                            ? "bg-primary text-white border-primary"
                            : "text-foreground border-muted bg-muted/30 hover:bg-muted/60"
                        }`}
                      >
                        {m === "today" ? "Hari Ini" : "Pilih Tanggal"}
                      </button>
                    ))}
                  </div>
                  {historyMode === "pick" && (
                    <input
                      type="date"
                      value={pickedDate}
                      max={format(new Date(), "yyyy-MM-dd")}
                      onChange={(e) => setPickedDate(e.target.value)}
                      className="w-full text-[11px] h-9 px-3 rounded-xl border bg-white text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  )}
                </div>

                {eventsLoading ? (
                  <div className="space-y-3">
                    {[1,2,3].map(i => (
                      <div key={i} className="bg-white rounded-2xl border shadow-sm p-4 space-y-3 animate-pulse">
                        <div className="h-3 bg-muted rounded w-2/3" />
                        <div className="h-2 bg-muted rounded w-1/3" />
                        <div className="h-2 bg-muted rounded w-1/2" />
                      </div>
                    ))}
                  </div>
                ) : groupedHistory.length === 0 ? (
                  <div className="py-12 flex flex-col items-center gap-3 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-muted/40 flex items-center justify-center">
                      <FileText className="w-7 h-7 text-muted-foreground/50" />
                    </div>
                    <div>
                      {historyMode === "today" ? (
                        <>
                          <p className="text-sm font-bold text-foreground">Belum ada riwayat absensi</p>
                          <p className="text-[11px] text-muted-foreground mt-1">Anda belum melakukan absensi hari ini.</p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm font-bold text-foreground">Tidak ada riwayat absensi</p>
                          <p className="text-[11px] text-muted-foreground mt-1">Tidak ada data absensi pada tanggal ini.</p>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Judul tanggal aktif */}
                    <div className="px-1">
                      <p className="text-[9px] font-black text-muted-foreground uppercase tracking-widest">
                        {historyMode === "today" ? "Riwayat Hari Ini" : "Riwayat Tanggal"}
                      </p>
                      <p className="text-sm font-bold text-foreground mt-0.5">
                        {historyMode === "today"
                          ? format(new Date(), "EEEE, dd MMMM yyyy", { locale: localeId })
                          : pickedDate
                            ? format(new Date(pickedDate + "T00:00:00"), "EEEE, dd MMMM yyyy", { locale: localeId })
                            : ""}
                      </p>
                    </div>

                    <div className="space-y-3">
                        {filteredGroups.map(({ date, dateLabel, checkIn, checkOut, durationMinutes, dailyStatus }) => {
                          const addrIn = checkIn?.addressDetail
                            ? shortAddr(checkIn.addressDetail as AddressDetail) || checkIn.address
                            : checkIn?.address || null;
                          const addrOut = checkOut?.addressDetail
                            ? shortAddr(checkOut.addressDetail as AddressDetail) || checkOut.address
                            : checkOut?.address || null;

                          // Resolve Drive fileId untuk foto masuk
                          const driveFileId = checkIn?.evidence?.driveFileId
                            || extractDriveFileId(checkIn?.evidence?.driveViewUrl)
                            || extractDriveFileId(checkIn?.evidence?.selfieUrl)
                            || extractDriveFileId(checkIn?.checkInSelfieUrl)
                            || extractDriveFileId(checkIn?.checkInPhotoUrl)
                            || extractDriveFileId(checkIn?.photoUrl)
                            || null;
                          const photoAccessible = driveFileId ? isPhotoWithin7Days(date) : false;
                          // Resolve Drive fileId untuk foto pulang
                          const driveFileIdOut = checkOut?.evidence?.driveFileId
                            || extractDriveFileId(checkOut?.evidence?.driveViewUrl)
                            || extractDriveFileId(checkOut?.checkOutSelfieUrl)
                            || extractDriveFileId(checkOut?.checkOutPhotoUrl)
                            || extractDriveFileId(checkOut?.photoUrl)
                            || null;
                          const photoOutAccessible = driveFileIdOut ? isPhotoWithin7Days(date) : false;

                          const dailyBadge = (() => {
                            switch (dailyStatus) {
                              case "COMPLETE":    return { label: "Selesai",           cls: "bg-green-100 text-green-700" };
                              case "IN_PROGRESS": return { label: "Belum Pulang",      cls: "bg-blue-100 text-blue-700" };
                              case "MISSING_OUT": return { label: "Lupa Absen Pulang", cls: "bg-orange-100 text-orange-700" };
                              case "MISSING_IN":  return { label: "Lupa Absen Masuk",  cls: "bg-red-100 text-red-700" };
                              default:            return { label: "Tidak Lengkap",     cls: "bg-gray-100 text-gray-600" };
                            }
                          })();

                          const durasiStr = durationMinutes != null
                            ? (() => {
                                const h = Math.floor(durationMinutes / 60);
                                const m = durationMinutes % 60;
                                return h > 0 ? `${h} jam ${m > 0 ? m + " menit" : ""}`.trim() : `${m} menit`;
                              })()
                            : null;

                          return (
                            <div key={date} className="bg-white rounded-2xl border shadow-sm overflow-hidden">
                              {/* Header tanggal + daily badge */}
                              <div className="flex items-center justify-between px-4 py-2.5 bg-muted/20 border-b">
                                <p className="text-[11px] font-black text-foreground">{dateLabel}</p>
                                <Badge className={`text-[7px] border-none shrink-0 ${dailyBadge.cls}`}>
                                  {dailyBadge.label}
                                </Badge>
                              </div>

                              <div className="p-3 space-y-3">
                                {/* Row masuk + pulang side-by-side */}
                                <div className="grid grid-cols-2 gap-2">
                                  {/* Masuk */}
                                  <div className={`rounded-xl px-3 py-2 ${checkIn ? 'bg-primary/5' : 'bg-muted/30'}`}>
                                    <div className="flex items-center gap-1 mb-0.5">
                                      <LogIn className="w-3 h-3 text-primary shrink-0" />
                                      <p className="text-[8px] font-bold text-primary uppercase">Masuk</p>
                                    </div>
                                    <p className={`text-base font-black tabular-nums ${checkIn ? 'text-foreground' : 'text-muted-foreground/40'}`}>
                                      {checkIn ? format(checkIn._date, "HH:mm") : "--:--"}
                                    </p>
                                    {checkIn && (
                                      <div className="flex items-center gap-1 mt-1">
                                        <span className="text-[8px] text-muted-foreground">WIB</span>
                                        <Badge className={`text-[7px] border-none ${statusBadgeCls(checkIn.status)}`}>
                                          {statusLabel(checkIn)}
                                        </Badge>
                                      </div>
                                    )}
                                  </div>
                                  {/* Pulang */}
                                  <div className={`rounded-xl px-3 py-2 ${checkOut ? 'bg-secondary/5' : 'bg-muted/30'}`}>
                                    <div className="flex items-center gap-1 mb-0.5">
                                      <LogOut className="w-3 h-3 text-secondary shrink-0" />
                                      <p className="text-[8px] font-bold text-secondary uppercase">Pulang</p>
                                    </div>
                                    <p className={`text-base font-black tabular-nums ${checkOut ? 'text-foreground' : 'text-muted-foreground/40'}`}>
                                      {checkOut ? format(checkOut._date, "HH:mm") : "--:--"}
                                    </p>
                                    {checkOut ? (
                                      <div className="flex items-center gap-1 mt-1">
                                        <span className="text-[8px] text-muted-foreground">WIB</span>
                                        <Badge className={`text-[7px] border-none ${statusBadgeCls(checkOut.status)}`}>
                                          {statusLabel(checkOut)}
                                        </Badge>
                                      </div>
                                    ) : checkIn ? (
                                      <p className="text-[8px] text-amber-600 font-semibold mt-1">Belum absen pulang</p>
                                    ) : null}
                                  </div>
                                </div>

                                {/* Durasi kerja */}
                                {durasiStr && (
                                  <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
                                    <Clock className="w-3 h-3 shrink-0" />
                                    <span>Durasi kerja: <span className="font-black text-foreground">{durasiStr}</span></span>
                                  </div>
                                )}

                                {/* Lokasi + radius */}
                                {(() => {
                                  const checkInCondId = checkIn?.checkInConditionReportId || null;
                                  const checkOutCondId = checkOut?.checkOutConditionReportId || null;
                                  const hasCondition = !!(checkIn?.hasConditionReport || checkInCondId || checkOutCondId);
                                  const needsReview = !!(checkIn?.needsHrdReview || checkIn?.checkInNeedsReview || checkOut?.needsHrdReview || checkOut?.checkOutNeedsReview);
                                  const isOutsideRadiusIn = checkIn?.isOutsideRadius === true || checkIn?.checkInLocationStatus === 'outside_radius';
                                  const isOutsideRadiusOut = checkOut?.isOutsideRadius === true || checkOut?.checkOutLocationStatus === 'outside_radius';
                                  const siteName = checkIn?.siteName || checkOut?.siteName || null;

                                  return (
                                    <div className="space-y-2 border-t pt-2.5">
                                      {/* Nama lokasi kantor */}
                                      {siteName && (
                                        <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
                                          <MapPin className="w-3 h-3 shrink-0 text-primary/50" />
                                          <span className="font-semibold text-foreground">{siteName}</span>
                                        </div>
                                      )}

                                      {/* Alamat masuk */}
                                      {addrIn && (
                                        <div className="flex items-start gap-1.5 text-[8px] text-muted-foreground bg-muted/20 rounded-lg px-2 py-1.5">
                                          <MapPin className="w-3 h-3 mt-0.5 shrink-0 text-primary/50" />
                                          <div className="min-w-0">
                                            <span className="font-bold text-[7px] uppercase text-primary/60">Masuk: </span>
                                            <span className="line-clamp-1">{addrIn}</span>
                                          </div>
                                        </div>
                                      )}

                                      {/* Alamat pulang (jika beda) */}
                                      {addrOut && addrOut !== addrIn && (
                                        <div className="flex items-start gap-1.5 text-[8px] text-muted-foreground bg-muted/20 rounded-lg px-2 py-1.5">
                                          <MapPin className="w-3 h-3 mt-0.5 shrink-0 text-secondary/50" />
                                          <div className="min-w-0">
                                            <span className="font-bold text-[7px] uppercase text-secondary/60">Pulang: </span>
                                            <span className="line-clamp-1">{addrOut}</span>
                                          </div>
                                        </div>
                                      )}

                                      {/* Radius badges — prominently shown */}
                                      {checkIn && (
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                          <Badge className={`text-[8px] py-0.5 border-none ${isOutsideRadiusIn ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700'}`}>
                                            <MapPin className="w-2.5 h-2.5 mr-0.5" />
                                            {isOutsideRadiusIn ? 'Di Luar Radius (Masuk)' : 'Dalam Radius (Masuk)'}
                                          </Badge>
                                          {checkOut && (
                                            <Badge className={`text-[8px] py-0.5 border-none ${isOutsideRadiusOut ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700'}`}>
                                              <MapPin className="w-2.5 h-2.5 mr-0.5" />
                                              {isOutsideRadiusOut ? 'Di Luar Radius (Pulang)' : 'Dalam Radius (Pulang)'}
                                            </Badge>
                                          )}
                                        </div>
                                      )}

                                      {/* Foto selfie */}
                                      <div className="flex items-center gap-3 flex-wrap">
                                        {driveFileId && (
                                          photoAccessible ? (
                                            <button
                                              onClick={() => setPhotoModal({ fileId: driveFileId, date, dateLabel, checkInTime: checkIn ? format(checkIn._date, "HH:mm") : null })}
                                              className="flex items-center gap-1 text-[8px] text-primary font-semibold underline underline-offset-2 hover:text-primary/70 transition-colors"
                                            >
                                              <Camera className="w-2.5 h-2.5 shrink-0" /> Selfie Masuk
                                            </button>
                                          ) : (
                                            <p className="text-[8px] text-muted-foreground/50 italic flex items-center gap-1">
                                              <Camera className="w-2.5 h-2.5 shrink-0" /> Selfie Masuk kedaluwarsa
                                            </p>
                                          )
                                        )}
                                        {driveFileIdOut && (
                                          photoOutAccessible ? (
                                            <button
                                              onClick={() => setPhotoModal({ fileId: driveFileIdOut, date, dateLabel, checkInTime: checkOut ? format(checkOut._date, "HH:mm") : null })}
                                              className="flex items-center gap-1 text-[8px] text-secondary font-semibold underline underline-offset-2 hover:text-secondary/70 transition-colors"
                                            >
                                              <Camera className="w-2.5 h-2.5 shrink-0" /> Selfie Pulang
                                            </button>
                                          ) : (
                                            <p className="text-[8px] text-muted-foreground/50 italic flex items-center gap-1">
                                              <Camera className="w-2.5 h-2.5 shrink-0" /> Selfie Pulang kedaluwarsa
                                            </p>
                                          )
                                        )}
                                      </div>

                                      {/* Kondisi khusus */}
                                      {hasCondition && (
                                        <div className="space-y-1 mt-0.5">
                                          <div className="flex items-center gap-1.5 flex-wrap">
                                            <Badge className="text-[7px] border-none bg-amber-100 text-amber-800">
                                              <ShieldAlert className="w-2 h-2 mr-0.5" /> Ada laporan kondisi khusus
                                            </Badge>
                                            {needsReview && (
                                              <Badge className="text-[7px] border-none bg-yellow-100 text-yellow-800">
                                                Perlu Review HRD
                                              </Badge>
                                            )}
                                          </div>
                                          {/* Bukti Kondisi Masuk */}
                                          {checkInCondId && (
                                            <button
                                              onClick={() => openConditionReportById(checkInCondId)}
                                              disabled={fetchingConditionId === checkInCondId}
                                              className="flex items-center gap-1 text-[8px] text-amber-700 font-semibold underline underline-offset-2 hover:text-amber-600 transition-colors disabled:opacity-50"
                                            >
                                              {fetchingConditionId === checkInCondId
                                                ? <Loader2 className="w-2.5 h-2.5 shrink-0 animate-spin" />
                                                : <ShieldAlert className="w-2.5 h-2.5 shrink-0" />
                                              }
                                              Lihat Bukti Kondisi Masuk
                                            </button>
                                          )}
                                          {/* Bukti Kondisi Pulang */}
                                          {checkOutCondId && (
                                            <button
                                              onClick={() => openConditionReportById(checkOutCondId)}
                                              disabled={fetchingConditionId === checkOutCondId}
                                              className="flex items-center gap-1 text-[8px] text-blue-700 font-semibold underline underline-offset-2 hover:text-blue-600 transition-colors disabled:opacity-50"
                                            >
                                              {fetchingConditionId === checkOutCondId
                                                ? <Loader2 className="w-2.5 h-2.5 shrink-0 animate-spin" />
                                                : <ShieldAlert className="w-2.5 h-2.5 shrink-0" />
                                              }
                                              Lihat Bukti Kondisi Pulang
                                            </button>
                                          )}
                                          {/* Fallback: hasConditionReport tapi belum ada typed ID */}
                                          {checkIn?.hasConditionReport && !checkInCondId && !checkOutCondId && (
                                            <p className="text-[8px] text-amber-700 font-semibold flex items-center gap-1">
                                              <ShieldAlert className="w-2.5 h-2.5 shrink-0" /> Bukti kondisi tersimpan di laporan
                                            </p>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                  </>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* ── Sticky Install CTA ──────────────────────────────────────────────── */}
      {installStatus !== 'installed' && (
        <div className="sticky bottom-0 z-40 max-w-md mx-auto w-full px-4 pb-4 pt-2 bg-gradient-to-t from-background via-background/95 to-transparent pointer-events-none">
          <div className="pointer-events-auto bg-white border shadow-lg rounded-2xl px-4 py-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white border border-teal-100 shadow-sm overflow-hidden shrink-0">
              <img src="/icon-192.png" alt="" aria-hidden="true" className="w-full h-full object-cover" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-black text-slate-800 leading-tight">Pasang EGS Attendance</p>
              <p className="text-[9px] text-muted-foreground leading-snug">
                {installStatus === 'dismissed'
                  ? 'Instalasi dibatalkan. Tekan Pasang kapan saja.'
                  : 'Akses lebih cepat dan dapatkan pengingat kehadiran.'}
              </p>
            </div>
            <Button
              onClick={handleInstallApp}
              size="sm"
              disabled={installStatus === 'checking'}
              className="rounded-xl text-[11px] font-black h-9 px-3 shrink-0 bg-primary text-white hover:bg-primary/90 disabled:opacity-60"
            >
              {installStatus === 'checking'
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />Menyiapkan…</>
                : installStatus === 'ios' ? 'Lihat Cara Pasang'
                : 'Pasang'}
            </Button>
          </div>
        </div>
      )}

      {/* ── Photo modal ───────────────────────────────────────────────────────── */}
      {photoModal && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-end justify-center"
          onClick={() => setPhotoModal(null)}
        >
          <div
            className="bg-white w-full max-w-md rounded-t-3xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div>
                <p className="text-xs font-bold">Selfie Kehadiran</p>
                <p className="text-[9px] text-muted-foreground">
                  {photoModal.dateLabel}
                  {photoModal.checkInTime ? ` · ${photoModal.checkInTime} WIB` : ""}
                </p>
              </div>
              <button
                onClick={() => setPhotoModal(null)}
                className="p-1.5 rounded-full hover:bg-muted transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Image */}
            <div className="bg-black flex items-center justify-center min-h-[200px]">
              <img
                src={`/api/attendance-photo?fileId=${encodeURIComponent(photoModal.fileId)}&date=${encodeURIComponent(photoModal.date)}`}
                alt="Foto bukti masuk"
                className="w-full max-h-[60vh] object-contain"
                onError={(e) => {
                  const el = e.currentTarget;
                  el.style.display = "none";
                  el.parentElement!.insertAdjacentHTML(
                    "beforeend",
                    '<p class="text-white text-xs p-6 text-center opacity-70">Foto tidak dapat dimuat.</p>'
                  );
                }}
              />
            </div>

            {/* Footer note */}
            <div className="px-4 py-3 bg-muted/20">
              <p className="text-[9px] text-muted-foreground text-center">
                Foto bukti hanya tersedia dalam 7 hari sejak tanggal absen.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Foto Bukti Kondisi Khusus ───────────────────────────────────── */}
      {conditionPhotoModal && (() => {
        const { report, fileId, directUrl } = conditionPhotoModal;
        const reportedTime = report.reportedAt
          ? format(new Date(report.reportedAt), "HH:mm", { locale: localeId })
          : null;
        const addr = report.reportLocationAddress || report.address?.full || null;
        const typeLabel = report.reportType === 'check_out' ? 'Bukti Kondisi Pulang' : 'Bukti Kondisi Masuk';
        const reviewBadgeStyle = report.reviewStatus === 'accepted'
          ? 'bg-green-100 text-green-700'
          : report.reviewStatus === 'rejected'
          ? 'bg-red-100 text-red-700'
          : 'bg-yellow-100 text-yellow-800';
        const reviewLabel = report.reviewStatus === 'accepted' ? 'Diterima HRD' : report.reviewStatus === 'rejected' ? 'Ditolak HRD' : 'Menunggu Review HRD';

        return (
          <div
            className="fixed inset-0 z-50 bg-black/70 flex items-end justify-center"
            onClick={() => setConditionPhotoModal(null)}
          >
            <div
              className="bg-white w-full max-w-md rounded-t-3xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <div>
                  <p className="text-xs font-bold">{typeLabel}</p>
                  <p className="text-[9px] text-muted-foreground">
                    {report.reasonLabel}
                    {reportedTime ? ` · ${reportedTime} WIB` : ""}
                  </p>
                </div>
                <button
                  onClick={() => setConditionPhotoModal(null)}
                  className="p-1.5 rounded-full hover:bg-muted transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Image */}
              <div className="bg-black flex items-center justify-center min-h-[180px]">
                {fileId ? (
                  <img
                    src={`/api/attendance-photo?fileId=${encodeURIComponent(fileId)}&date=${encodeURIComponent(report.reportDate || "")}`}
                    alt="Foto bukti kondisi"
                    className="w-full max-h-[55vh] object-contain"
                    onError={(e) => {
                      const el = e.currentTarget;
                      el.style.display = "none";
                      const fallback = document.createElement("p");
                      fallback.className = "text-white text-xs p-6 text-center opacity-70";
                      fallback.textContent = "Foto bukti tidak bisa dimuat. Coba ulangi atau hubungi HRD/Admin.";
                      el.parentElement?.appendChild(fallback);
                    }}
                  />
                ) : directUrl ? (
                  <img
                    src={directUrl}
                    alt="Foto bukti kondisi"
                    className="w-full max-h-[55vh] object-contain"
                    onError={(e) => {
                      const el = e.currentTarget;
                      el.style.display = "none";
                      const fallback = document.createElement("p");
                      fallback.className = "text-white text-xs p-6 text-center opacity-70";
                      fallback.textContent = "Foto bukti tidak bisa dimuat. Coba ulangi atau hubungi HRD/Admin.";
                      el.parentElement?.appendChild(fallback);
                    }}
                  />
                ) : (
                  <p className="text-white text-xs p-6 text-center opacity-70">
                    Foto bukti tidak tersedia.
                  </p>
                )}
              </div>

              {/* Detail */}
              <div className="px-4 py-3 space-y-1.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Badge className={`text-[7px] border-none ${reviewBadgeStyle}`}>{reviewLabel}</Badge>
                </div>
                {report.note && (
                  <p className="text-[10px] text-slate-700">
                    <span className="font-semibold text-slate-500">Catatan: </span>
                    {report.note}
                  </p>
                )}
                {reportedTime && (
                  <p className="text-[9px] text-muted-foreground">Dilaporkan pukul {reportedTime} WIB</p>
                )}
                {addr && (
                  <p className="text-[9px] text-muted-foreground line-clamp-2">📍 {addr}</p>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Modal: Panduan Install (iOS + browser lain) ───────────── */}
      {showInstallGuide && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4">
          <div className="w-full max-w-md bg-white rounded-3xl shadow-2xl overflow-hidden">
            <div className="px-6 pt-6 pb-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <img src="/icon-192.png" alt="" aria-hidden="true" className="w-8 h-8 rounded-lg shadow-sm" />
                  <p className="font-black text-base">Pasang EGS Attendance</p>
                </div>
                <button onClick={() => setShowInstallGuide(false)} className="text-muted-foreground p-1">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {isIosBrowser ? (
                /* iOS / Safari */
                <>
                  <p className="text-[11px] text-muted-foreground mb-4">
                    Buka halaman ini di <strong>Safari</strong>, lalu ikuti langkah berikut:
                  </p>
                  <ol className="space-y-3">
                    {[
                      ['1', 'Tekan tombol Share ↑ di toolbar bawah Safari'],
                      ['2', 'Scroll ke bawah, pilih "Add to Home Screen"'],
                      ['3', 'Beri nama "EGS Attendance", tekan "Add"'],
                      ['4', 'Buka EGS Attendance dari ikon di layar utama (Home Screen)'],
                      ['5', 'Aktifkan notifikasi di dalam aplikasi agar pengingat absen berjalan'],
                    ].map(([n, text]) => (
                      <li key={n} className="flex items-start gap-3">
                        <span className="w-6 h-6 rounded-full bg-primary/10 text-primary font-black text-xs flex items-center justify-center shrink-0 mt-0.5">{n}</span>
                        <span className="text-sm text-slate-700">{text}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="mt-3 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                    <p className="text-[10px] text-amber-700 leading-snug">
                      Push notification iPhone hanya tersedia saat aplikasi dibuka dari Home Screen (iOS 16.4+).
                    </p>
                  </div>
                </>
              ) : (
                /* Android / browser lain */
                <>
                  <p className="text-[11px] text-muted-foreground mb-3">
                    Install otomatis belum tersedia di browser ini. Gunakan menu browser:
                  </p>
                  <div className="bg-slate-50 rounded-xl p-3 space-y-2 text-sm text-slate-700">
                    <p>• <strong>Chrome Android:</strong> Menu ⋮ → <em>Install App</em> / <em>Add to Home Screen</em></p>
                    <p>• <strong>Edge Android:</strong> Menu … → <em>Add to Phone</em></p>
                    <p>• <strong>Samsung Browser:</strong> Menu → <em>Tambah ke Beranda</em></p>
                    <p>• <strong>Firefox:</strong> Menu → <em>Install</em></p>
                  </div>
                </>
              )}
            </div>
            <div className="px-6 pb-6 pt-2">
              <button
                onClick={() => setShowInstallGuide(false)}
                className="w-full h-12 rounded-2xl bg-primary text-white font-black text-sm"
              >
                Mengerti
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
