"use client";

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
  capturedAt: Date;
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

function StepPills({ current, isOut = false }: { current: number; isOut?: boolean }) {
  // IN: Lokasi → Foto → Preview → Kirim
  // OUT: Lokasi → Konfirmasi → Kirim
  const steps = isOut
    ? ["Lokasi", "Konfirmasi", "Kirim"]
    : ["Lokasi", "Foto", "Preview", "Kirim"];
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
  useEffect(() => {
    locationRef.current = liveLocation;
  }, [liveLocation]);

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

  // History filters
  const [historyFilterMode, setHistoryFilterMode] = useState<
    "quick" | "custom" | "month"
  >("quick");
  const [selectedQuickFilter, setSelectedQuickFilter] = useState<
    "today" | "week" | "month" | "year"
  >("month");
  const [customStartDate, setCustomStartDate] = useState(
    () => new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0],
  );
  const [customEndDate, setCustomEndDate] = useState(
    () => new Date().toISOString().split("T")[0],
  );
  const [selectedMonth, setSelectedMonth] = useState(() =>
    new Date().toISOString().slice(0, 7),
  );
  const [statusFilter, setStatusFilter] = useState("all");

  // Photo modal state
  const [photoModal, setPhotoModal] = useState<{
    fileId: string;
    date: string;
    dateLabel: string;
    checkInTime: string | null;
  } | null>(null);

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

  // ── Site loader ────────────────────────────────────────────────
  useEffect(() => {
    if (userLoading || !user || !isAttendanceAllowed || !user.brandId) {
      setLoadingSites(false);
      return;
    }
    setLoadingSites(true);
    (async () => {
      try {
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

  // ── Active site resolver ───────────────────────────────────────
  useEffect(() => {
    if (!liveLocation || !sites.length) {
      setActiveSite(null);
      return;
    }
    let closest: any = null,
      minD = Infinity;
    sites.forEach((s) => {
      const d = getDistance(
        liveLocation.lat,
        liveLocation.lng,
        s.office.lat,
        s.office.lng,
      );
      if (d < minD) {
        minD = d;
        closest = s;
      }
    });
    setActiveSite(closest);
  }, [liveLocation, sites]);

  // ── Attendance event queries ───────────────────────────────────
  const historyQuery = useMemo(() => {
    if (!user?.uid || !isAttendanceAllowed) return null;
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

  // ── History filters ────────────────────────────────────────────
  const getDateRange = useCallback((): [Date, Date] => {
    const now = new Date();
    let start: Date, end: Date;
    if (historyFilterMode === "quick") {
      end = new Date(now);
      switch (selectedQuickFilter) {
        case "today":
          start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case "week":
          start = new Date(now);
          start.setDate(now.getDate() - now.getDay());
          break;
        case "year":
          start = new Date(now.getFullYear(), 0, 1);
          break;
        default:
          start = new Date(now.getFullYear(), now.getMonth(), 1);
      }
    } else if (historyFilterMode === "custom") {
      start = customStartDate
        ? new Date(customStartDate)
        : new Date(now.getFullYear(), now.getMonth(), 1);
      end = customEndDate ? new Date(customEndDate) : now;
    } else {
      const [y, m] = selectedMonth.split("-").map(Number);
      start = new Date(y, m - 1, 1);
      end = new Date(y, m, 0);
    }
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
    return [start, end];
  }, [
    historyFilterMode,
    selectedQuickFilter,
    customStartDate,
    customEndDate,
    selectedMonth,
  ]);

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

  // Group history by date — statusFilter diapply setelah group
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

  // Apply statusFilter pada grouped history
  const filteredGroups = useMemo(() => {
    if (statusFilter === "all") return groupedHistory;
    return groupedHistory.filter(({ checkIn, checkOut, dailyStatus }) => {
      switch (statusFilter) {
        case "COMPLETE":     return dailyStatus === "COMPLETE";
        case "LATE":         return checkIn?.status === "LATE";
        case "EARLY_LEAVE":  return checkOut?.status === "EARLY_LEAVE";
        // Hanya tampilkan tanggal lampau — hari ini yang belum pulang bukan "lupa"
        case "MISSING_OUT":  return dailyStatus === "MISSING_OUT";
        case "MISSING_IN":   return dailyStatus === "MISSING_IN";
        default:             return true;
      }
    });
  }, [groupedHistory, statusFilter]);

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
      if (!site?.shift) return { status: "NORMAL", lateMinutes: 0 };
      const { startTime, endTime, graceLateMinutes } = site.shift;
      const [sh, sm] = startTime.split(":").map(Number);
      const [eh, em] = endTime.split(":").map(Number);
      const sched = new Date(now);
      sched.setHours(sh, sm, 0, 0);
      const schedEnd = new Date(now);
      schedEnd.setHours(eh, em, 0, 0);
      if (type === "IN") {
        const grace = new Date(
          sched.getTime() + (graceLateMinutes || 0) * 60000,
        );
        if (now > grace)
          return {
            status: "LATE",
            lateMinutes: Math.ceil((now.getTime() - sched.getTime()) / 60000),
          };
        return { status: "ON_TIME", lateMinutes: 0 };
      }
      return now < schedEnd
        ? { status: "EARLY_LEAVE", lateMinutes: 0 }
        : { status: "ON_TIME", lateMinutes: 0 };
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
          let cy = y0 + Math.floor(lh * 0.5);

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
            cy += Math.floor(size * 1.4);
          };

          const zone = gps.insideRadius ? "ONSITE" : "OFFSITE";
          const zoneC = gps.insideRadius ? "#22c55e" : "#f97316";
          const eventType =
            type === "IN" ? "KEHADIRAN MASUK" : "KEHADIRAN PULANG";
          const badge = `${eventType}  ${zone}`;
          ctx.font = `bold ${Math.floor(lh * 1.0)}px Inter,Arial,sans-serif`;
          ctx.fillStyle = zoneC;
          ctx.textAlign = "right";
          ctx.fillText(badge, canvas.width - p, y0 + Math.floor(lh * 0.5));
          ctx.textAlign = "left";

          write(
            user?.displayName?.toUpperCase() || "USER",
            Math.floor(lh * 1.1),
            "white",
            true,
          );
          const idLine = [
            user?.employeeId ? `EMP ${user.employeeId}` : null,
            user?.brandName,
            user?.division,
          ]
            .filter(Boolean)
            .join("  •  ");
          write(idLine, Math.floor(lh * 0.8), "rgba(255,255,255,0.85)");
          write(wibString(now), Math.floor(lh * 0.88), "#93c5fd", true);

          const sa = addr ? shortAddr(addr) || addr.displayName : null;
          if (sa) write(sa, Math.floor(lh * 0.74), "rgba(255,255,255,0.78)");

          write(
            `${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}   ±${Math.round(gps.accuracyM)}m GPS`,
            Math.floor(lh * 0.68),
            "rgba(255,255,255,0.58)",
          );

          if (gps.distanceToSiteM !== null && activeSite) {
            write(
              `Jarak ke ${activeSite.name}: ${Math.round(gps.distanceToSiteM)}m`,
              Math.floor(lh * 0.68),
              "rgba(255,255,255,0.58)",
            );
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
      let inside = false;
      if (activeSite?.office) {
        distToSite = getDistance(
          loc.lat,
          loc.lng,
          activeSite.office.lat,
          activeSite.office.lng,
        );
        inside = distToSite <= (activeSite.radiusM || 150);
      }

      const flags: string[] = [];
      if (loc.accuracy > 100) flags.push("gps_low_accuracy");
      if (!inside && activeSite) flags.push("outside_radius");

      setTapGps({
        lat: loc.lat,
        lng: loc.lng,
        accuracyM: loc.accuracy,
        altitude: loc.altitude,
        heading: loc.heading,
        speed: loc.speed,
        distanceToSiteM: distToSite,
        insideRadius: inside,
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

  // OUT tidak butuh foto — langsung ke preview
  const proceedToPreview = useCallback(() => {
    setTapPhoto(null);
    setTapStep("preview");
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

  // ── Final submit ───────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    // IN wajib foto, OUT tidak perlu
    if (tapType === 'IN' && !tapPhoto) {
      toast({
        variant: "destructive",
        title: "Foto diperlukan",
        description: "Foto wajah harus diambil untuk absen masuk.",
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
      const { status, lateMinutes } = calculateStatus(tapType, now, activeSite);

      let driveFileId: string | null = null;
      let driveViewUrl: string | null = null;
      let driveDownload: string | null = null;
      let driveFolderId: string | null = null;
      let selfieUrl: string | null = null;

      // Upload foto HANYA untuk absen masuk (IN)
      if (tapType === 'IN' && tapPhoto) {
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
            capturedAt: now,
          },
          addr,
          now,
        );

        const ts       = format(now, 'yyyyMMdd-HHmmss');
        const idStr    = user.employeeId || user.uid.slice(0, 8);
        const fileName = `attendance-${idStr}-kehadiran_masuk-${ts}.jpg`;

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
            lat: activeSite.office?.lat,
            lng: activeSite.office?.lng,
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
        flags: flags || [],
        siteId: activeSite?.id || "OFFSITE",
        siteName: activeSite?.name || "Luar Kantor",
        siteSnapshot,
        photoUrl: selfieUrl,
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

      await addDoc(collection(db, "attendance_events"), payload);
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
  ]);

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
              Web Absen
            </Badge>
            {showCancel ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={cancelTap}
                className="rounded-full w-9 h-9 text-muted-foreground"
              >
                <X className="w-4 h-4" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => signOut(auth)}
                className="rounded-full w-9 h-9"
              >
                <LogOut className="w-4 h-4" />
              </Button>
            )}
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
          <StepPills current={0} isOut={tapType === "OUT"} />

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
            <div className="bg-white rounded-2xl border shadow-sm p-4 space-y-3">
              <p className="text-[8px] font-black text-muted-foreground uppercase tracking-widest">
                Lokasi terdeteksi
              </p>
              {tapAddress ? (
                <div className="space-y-1.5 text-[9px] text-muted-foreground">
                  {tapAddress.road && (
                    <p>
                      <span className="font-bold">Jalan:</span>{" "}
                      {tapAddress.road}
                    </p>
                  )}
                  {tapAddress.kelurahan && (
                    <p>
                      <span className="font-bold">Kelurahan/Desa:</span>{" "}
                      {tapAddress.kelurahan}
                    </p>
                  )}
                  {tapAddress.kecamatan && (
                    <p>
                      <span className="font-bold">Kecamatan:</span>{" "}
                      {tapAddress.kecamatan}
                    </p>
                  )}
                  {tapAddress.kabupatenKota && (
                    <p>
                      <span className="font-bold">Kabupaten/Kota:</span>{" "}
                      {tapAddress.kabupatenKota}
                    </p>
                  )}
                  {tapAddress.province && (
                    <p>
                      <span className="font-bold">Provinsi:</span>{" "}
                      {tapAddress.province}
                    </p>
                  )}
                  {tapAddress.postcode && (
                    <p>
                      <span className="font-bold">Kode Pos:</span>{" "}
                      {tapAddress.postcode}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-[9px] text-muted-foreground italic">
                  Memuat lokasi...
                </p>
              )}
            </div>
          </div>

          <div className="px-4 space-y-2">
            {tapType === "IN" ? (
              <Button
                onClick={proceedToSelfie}
                className="w-full h-12 rounded-2xl font-bold gap-2"
              >
                <Camera className="w-4 h-4" /> Lanjut Ambil Foto
              </Button>
            ) : (
              <Button
                onClick={proceedToPreview}
                className="w-full h-12 rounded-2xl font-bold gap-2 bg-secondary hover:bg-secondary/90"
              >
                <CheckCircle2 className="w-4 h-4" /> Konfirmasi Pulang
              </Button>
            )}
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

  // ─── Step: Selfie (hanya untuk IN) ─────────────────────────────
  if (tapStep === "selfie") {
    return <CameraCapture onCapture={handleSelfie} onCancel={cancelTap} />;
  }

  // ─── Step: Preview ─────────────────────────────────────────────
  if (tapStep === "preview") {
    return (
      <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto shadow-2xl border-x">
        {renderHeader(true)}
        <div className="flex-1 overflow-auto pb-6">
          <StepPills current={tapType === "OUT" ? 1 : 2} isOut={tapType === "OUT"} />

          {/* Foto hanya ditampilkan untuk IN */}
          {tapType === "IN" && tapPhoto && (
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
            </div>
          </div>

          <div className="px-4 space-y-2">
            <Button
              onClick={handleSubmit}
              className={`w-full h-12 rounded-2xl font-bold gap-2 ${tapType === "OUT" ? "bg-secondary hover:bg-secondary/90" : ""}`}
            >
              <CheckCircle2 className="w-4 h-4" />
              {tapType === "IN" ? "Kirim Kehadiran Masuk" : "Kirim Kehadiran Pulang"}
            </Button>
            {tapType === "IN" && (
              <Button
                variant="outline"
                onClick={retakeSelfie}
                className="w-full h-11 rounded-2xl gap-2"
              >
                <Camera className="w-4 h-4" /> Ulangi Selfie
              </Button>
            )}
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
    const { status, lateMinutes } = calculateStatus(
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
      <div className="flex-1 overflow-auto pb-6">
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
                  <>
                    <LogIn className="w-5 h-5" /> Kehadiran Masuk
                  </>
                ) : (
                  <>
                    <LogOut className="w-5 h-5" /> Kehadiran Pulang
                  </>
                )}
              </Button>
            )}

            {isFinished && (
              <div className="flex items-center justify-center gap-2 py-3 bg-green-50 rounded-2xl border border-green-200">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                <p className="text-xs font-bold text-green-700">
                  Kehadiran hari ini selesai
                </p>
              </div>
            )}

            {!isAttendanceAllowed && <div className="h-2" />}

            {/* ── Additional compact sections (mobile-first) ── */}
            <div className="space-y-3">
              {/* A. Ringkasan Kehadiran Hari Ini */}
              <div className="bg-white rounded-2xl border shadow-sm p-3">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] font-black text-muted-foreground uppercase">
                    Ringkasan Kehadiran Hari Ini
                  </p>
                  <span className="text-[11px] font-bold text-muted-foreground">
                    {todayStatus.hasIn
                      ? todayStatus.hasOut
                        ? "Selesai"
                        : "Sedang Bekerja"
                      : "Belum Kehadiran"}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <div className="text-[12px]">
                    <p className="text-[9px] text-muted-foreground">Masuk</p>
                    <p className="font-black tabular-nums">
                      {todayCheckIn ? format(todayCheckIn._date, "HH:mm") : "-"}
                    </p>
                  </div>
                  <div className="text-[12px]">
                    <p className="text-[9px] text-muted-foreground">Pulang</p>
                    <p className="font-black tabular-nums">
                      {todayCheckOut
                        ? format(todayCheckOut._date, "HH:mm")
                        : "-"}
                    </p>
                  </div>
                  <div className="text-[12px]">
                    <p className="text-[9px] text-muted-foreground">
                      Lokasi terakhir
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {(todayCheckIn?.addressDetail &&
                        shortAddr(
                          todayCheckIn.addressDetail as AddressDetail,
                        )) ||
                        (todayCheckOut?.addressDetail &&
                          shortAddr(
                            todayCheckOut.addressDetail as AddressDetail,
                          )) ||
                        "-"}
                    </p>
                  </div>
                </div>
              </div>

              {/* B. Alur Kehadiran */}
              <div className="bg-white rounded-2xl border shadow-sm p-3">
                <p className="text-[9px] font-black text-muted-foreground uppercase mb-2">
                  Alur Kehadiran
                </p>
                <div className="flex items-center justify-between text-[12px]">
                  <div className="flex-1 text-center">
                    <div className="w-7 h-7 mx-auto rounded-full bg-primary/10 text-primary flex items-center justify-center font-black">
                      1
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Ambil Lokasi
                    </p>
                  </div>
                  <div className="flex-1 text-center">
                    <div className="w-7 h-7 mx-auto rounded-full bg-primary/10 text-primary flex items-center justify-center font-black">
                      2
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Ambil Foto
                    </p>
                  </div>
                  <div className="flex-1 text-center">
                    <div className="w-7 h-7 mx-auto rounded-full bg-primary/10 text-primary flex items-center justify-center font-black">
                      3
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Preview Bukti
                    </p>
                  </div>
                  <div className="flex-1 text-center">
                    <div className="w-7 h-7 mx-auto rounded-full bg-primary/10 text-primary flex items-center justify-center font-black">
                      4
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      Kirim Kehadiran
                    </p>
                  </div>
                </div>
              </div>

              {/* C. Aktivitas Terakhir */}
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
                      } catch {
                        dt = null;
                      }
                      if (!dt) return null;
                      return (
                        <div
                          key={ev.id || ev.tsClient}
                          className="flex items-center justify-between"
                        >
                          <div>
                            <p className="text-[11px] font-black">
                              {format(dt, "dd MMM", { locale: localeId })}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {ev.type === "IN"
                                ? "Kehadiran Masuk"
                                : "Kehadiran Pulang"}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="font-black tabular-nums">
                              {format(dt, "HH:mm")}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {ev.status || "-"}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Belum ada aktivitas kehadiran.
                    </p>
                  )}
                </div>
              </div>

              {/* D. Informasi Singkat */}
              <div className="bg-muted/5 rounded-2xl border p-3 text-[12px] text-muted-foreground">
                Pastikan lokasi aktif dan wajah terlihat jelas saat mengambil
                foto kehadiran.
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
                {/* Filters */}
                <div className="bg-white rounded-2xl border shadow-sm p-3 space-y-2">
                  {/* Period mode tabs */}
                  <div className="flex items-center gap-1 p-0.5 bg-muted/40 rounded-xl">
                    {(["quick", "custom", "month"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => setHistoryFilterMode(m)}
                        className={`flex-1 text-[8px] font-bold h-6 rounded-[9px] transition-colors ${
                          historyFilterMode === m
                            ? "bg-white shadow-sm text-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {m === "quick" ? "Cepat" : m === "custom" ? "Rentang" : "Bulan"}
                      </button>
                    ))}
                  </div>

                  {historyFilterMode === "quick" && (
                    <div className="flex gap-1">
                      {(["today", "week", "month", "year"] as const).map((f) => (
                        <button
                          key={f}
                          onClick={() => setSelectedQuickFilter(f)}
                          className={`flex-1 text-[8px] font-bold h-6 rounded-lg transition-colors ${
                            selectedQuickFilter === f
                              ? "bg-primary/10 text-primary border border-primary/25"
                              : "text-muted-foreground border border-transparent"
                          }`}
                        >
                          {f === "today" ? "Hari ini" : f === "week" ? "Minggu" : f === "month" ? "Bulan" : "Tahun"}
                        </button>
                      ))}
                    </div>
                  )}
                  {historyFilterMode === "custom" && (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="date"
                        value={customStartDate}
                        onChange={(e) => setCustomStartDate(e.target.value)}
                        className="flex-1 text-[9px] h-7 px-2 rounded-lg border bg-white"
                      />
                      <span className="text-[8px] text-muted-foreground shrink-0">–</span>
                      <input
                        type="date"
                        value={customEndDate}
                        onChange={(e) => setCustomEndDate(e.target.value)}
                        className="flex-1 text-[9px] h-7 px-2 rounded-lg border bg-white"
                      />
                    </div>
                  )}
                  {historyFilterMode === "month" && (
                    <input
                      type="month"
                      value={selectedMonth}
                      onChange={(e) => setSelectedMonth(e.target.value)}
                      className="text-[9px] h-7 px-2 rounded-lg border bg-white w-full"
                    />
                  )}

                  {/* Status filter */}
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="w-full text-[9px] h-7 px-2 rounded-lg border bg-white text-muted-foreground"
                  >
                    <option value="all">Semua status</option>
                    <option value="COMPLETE">Lengkap (masuk + pulang)</option>
                    <option value="LATE">Terlambat masuk</option>
                    <option value="EARLY_LEAVE">Pulang awal</option>
                    <option value="MISSING_OUT">Lupa absen pulang</option>
                    <option value="MISSING_IN">Lupa absen masuk</option>
                  </select>
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
                  <div className="py-10 flex flex-col items-center gap-3 opacity-40">
                    <FileText className="w-8 h-8 text-muted-foreground" />
                    <p className="text-xs italic text-muted-foreground text-center">
                      Tidak ada riwayat pada periode ini.
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Ringkasan statistik periode */}
                    {groupedHistory.length > 0 && (
                      <div className="bg-white rounded-2xl border shadow-sm p-3">
                        <p className="text-[8px] font-black text-muted-foreground uppercase mb-2">
                          Ringkasan Periode
                        </p>
                        <div className="grid grid-cols-4 gap-1 text-center">
                          <div>
                            <p className="text-base font-black text-primary">{historySummary.totalPresent}</p>
                            <p className="text-[8px] text-muted-foreground leading-tight">Hadir</p>
                          </div>
                          <div>
                            <p className="text-base font-black text-red-500">{historySummary.totalLate}</p>
                            <p className="text-[8px] text-muted-foreground leading-tight">Terlambat</p>
                          </div>
                          <div>
                            <p className="text-base font-black text-orange-500">{historySummary.totalMissingOut}</p>
                            <p className="text-[8px] text-muted-foreground leading-tight">Lupa Pulang</p>
                          </div>
                          <div>
                            <p className="text-base font-black text-blue-500">
                              {historySummary.totalWorkMinutes > 0
                                ? `${Math.floor(historySummary.totalWorkMinutes / 60)}j`
                                : "-"}
                            </p>
                            <p className="text-[8px] text-muted-foreground leading-tight">Total Jam</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {filteredGroups.length === 0 ? (
                      <div className="py-8 flex flex-col items-center gap-3 opacity-40">
                        <FileText className="w-7 h-7 text-muted-foreground" />
                        <p className="text-xs italic text-muted-foreground text-center">
                          Tidak ada riwayat dengan status ini pada periode yang dipilih.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {filteredGroups.map(({ date, dateLabel, checkIn, checkOut, durationMinutes, dailyStatus }) => {
                          const addrIn = checkIn?.addressDetail
                            ? shortAddr(checkIn.addressDetail as AddressDetail) || checkIn.address
                            : checkIn?.address || null;
                          const addrOut = checkOut?.addressDetail
                            ? shortAddr(checkOut.addressDetail as AddressDetail) || checkOut.address
                            : checkOut?.address || null;

                          // Resolve Drive fileId: prefer explicit field, fall back to extracting from URL
                          const driveFileId = checkIn?.evidence?.driveFileId
                            || extractDriveFileId(checkIn?.evidence?.driveViewUrl)
                            || extractDriveFileId(checkIn?.evidence?.selfieUrl)
                            || extractDriveFileId(checkIn?.photoUrl)
                            || null;
                          const photoAccessible = driveFileId ? isPhotoWithin7Days(date) : false;

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
                              <div className="flex items-center justify-between px-3 py-2 bg-muted/20 border-b">
                                <p className="text-[9px] font-black uppercase text-muted-foreground">{dateLabel}</p>
                                <Badge className={`text-[7px] border-none shrink-0 ${dailyBadge.cls}`}>
                                  {dailyBadge.label}
                                </Badge>
                              </div>

                              <div className="p-3 space-y-2">
                                {/* Row masuk */}
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <div className="w-7 h-7 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                                      <LogIn className="w-3.5 h-3.5 text-primary" />
                                    </div>
                                    <div>
                                      <p className="text-[8px] font-bold text-muted-foreground uppercase">Masuk</p>
                                      <p className="text-sm font-black tabular-nums">
                                        {checkIn ? format(checkIn._date, "HH:mm") : "--:--"}
                                        {checkIn && <span className="text-[8px] font-normal text-muted-foreground ml-1">WIB</span>}
                                      </p>
                                    </div>
                                  </div>
                                  {checkIn && (
                                    <Badge className={`text-[7px] border-none shrink-0 ${statusBadgeCls(checkIn.status)}`}>
                                      {statusLabel(checkIn)}
                                    </Badge>
                                  )}
                                </div>

                                {/* Row pulang */}
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <div className="w-7 h-7 rounded-xl bg-secondary/10 flex items-center justify-center shrink-0">
                                      <LogOut className="w-3.5 h-3.5 text-secondary" />
                                    </div>
                                    <div>
                                      <p className="text-[8px] font-bold text-muted-foreground uppercase">Pulang</p>
                                      <p className="text-sm font-black tabular-nums">
                                        {checkOut ? format(checkOut._date, "HH:mm") : "--:--"}
                                        {checkOut && <span className="text-[8px] font-normal text-muted-foreground ml-1">WIB</span>}
                                      </p>
                                    </div>
                                  </div>
                                  {checkOut && (
                                    <Badge className={`text-[7px] border-none shrink-0 ${statusBadgeCls(checkOut.status)}`}>
                                      {statusLabel(checkOut)}
                                    </Badge>
                                  )}
                                </div>

                                {/* Durasi kerja */}
                                {durasiStr && (
                                  <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground border-t pt-2">
                                    <Clock className="w-3 h-3 shrink-0" />
                                    <span>Durasi kerja: <span className="font-black text-foreground">{durasiStr}</span></span>
                                  </div>
                                )}

                                {/* Lokasi masuk */}
                                {addrIn && (
                                  <div className="flex items-start gap-1.5 text-[8px] text-muted-foreground bg-muted/20 rounded-lg px-2 py-1.5">
                                    <MapPin className="w-3 h-3 mt-0.5 shrink-0 text-primary/60" />
                                    <div className="min-w-0">
                                      <span className="font-bold text-[7px] uppercase text-primary/60">Masuk: </span>
                                      <span className="line-clamp-1">{addrIn}</span>
                                    </div>
                                  </div>
                                )}

                                {/* Lokasi pulang (jika beda dengan masuk) */}
                                {addrOut && addrOut !== addrIn && (
                                  <div className="flex items-start gap-1.5 text-[8px] text-muted-foreground bg-muted/20 rounded-lg px-2 py-1.5">
                                    <MapPin className="w-3 h-3 mt-0.5 shrink-0 text-secondary/60" />
                                    <div className="min-w-0">
                                      <span className="font-bold text-[7px] uppercase text-secondary/60">Pulang: </span>
                                      <span className="line-clamp-1">{addrOut}</span>
                                    </div>
                                  </div>
                                )}

                                {/* Foto bukti masuk — link kecil, hanya ≤7 hari */}
                                {driveFileId && (
                                  photoAccessible ? (
                                    <button
                                      onClick={() => setPhotoModal({ fileId: driveFileId, date, dateLabel, checkInTime: checkIn ? format(checkIn._date, "HH:mm") : null })}
                                      className="flex items-center gap-1 text-[8px] text-primary font-semibold underline underline-offset-2 hover:text-primary/70 transition-colors"
                                    >
                                      <Camera className="w-2.5 h-2.5 shrink-0" /> Lihat foto masuk
                                    </button>
                                  ) : (
                                    <p className="text-[8px] text-muted-foreground italic flex items-center gap-1">
                                      <Camera className="w-2.5 h-2.5 shrink-0 opacity-40" /> Foto bukti sudah kedaluwarsa (&gt;7 hari)
                                    </p>
                                  )
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>

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
                <p className="text-xs font-bold">Foto Bukti Masuk</p>
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
    </div>
  );
}
