'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { 
  collection, 
  query, 
  where, 
  getDocs, 
  addDoc, 
  serverTimestamp, 
  Timestamp 
} from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { useAuth, useFirestore, useUser, useCollection, useFirebaseApp } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { 
  LogOut, 
  CheckCircle2, 
  AlertTriangle, 
  Loader2, 
  Clock, 
  Camera, 
  Navigation,
  FileText,
  MapPin,
  ShieldAlert
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getDistance, getAddressFromLatLng } from '@/lib/geo-utils';
import { CameraCapture } from '@/components/camera-capture';
import { format } from 'date-fns';
import { id as localeId } from 'date-fns/locale';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export default function AbsenPage() {
  const { user, loading: userLoading } = useUser();
  const auth = useAuth();
  const db = useFirestore();
  const firebaseApp = useFirebaseApp();
  const router = useRouter();
  const { toast } = useToast();
  
  const [location, setLocation] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [sites, setSites] = useState<any[]>([]);
  const [activeSite, setActiveSite] = useState<any>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadingSites, setLoadingSites] = useState(true);

  // LONG PRESS STATE (2 Detik untuk TAP OUT)
  const [holdProgress, setHoldProgress] = useState(0);
  const holdInterval = useRef<NodeJS.Timeout | null>(null);

  // HISTORY FILTER STATE
  const [historyFilterMode, setHistoryFilterMode] = useState<'quick' | 'custom' | 'month'>('quick');
  const [selectedQuickFilter, setSelectedQuickFilter] = useState<'today' | 'week' | 'month' | 'year'>('month');
  const [customStartDate, setCustomStartDate] = useState<string>(new Date(new Date().setDate(new Date().getDate() - 7)).toISOString().split('T')[0]);
  const [customEndDate, setCustomEndDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [selectedMonth, setSelectedMonth] = useState<string>(new Date().toISOString().slice(0, 7));
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [statusFilter, setStatusFilter] = useState<string>('all');

  // ACCESS CONTROL LOGIC — berdasarkan attendanceMethod dari employee_profiles
  const isAttendanceAllowed = useMemo(() => {
    if (!user) return false;
    return user.attendanceMethod === 'web_absen';
  }, [user]);

  const restrictedMessage = useMemo(() => {
    if (!user) return null;
    if (user.attendanceMethod === 'fingerprint') {
      return "Akun Anda menggunakan absensi fingerprint. Web absen tidak tersedia untuk akun ini.";
    }
    if (!user.attendanceMethod) {
      return "Metode absensi Anda belum diatur oleh HRD. Silakan hubungi HRD.";
    }
    return null;
  }, [user]);

  useEffect(() => {
    if (!userLoading) {
      if (!user) {
        router.push('/login');
      } else if (user.role === 'kandidat') {
        router.push('/unauthorized');
      }
    }
  }, [user, userLoading, router]);

  // SITE RESOLVER - STRICT BRAND FILTERING
  useEffect(() => {
    if (userLoading || !user) return; // Tunggu data user tersedia sebelum query

    const loadSites = async () => {
      if (!isAttendanceAllowed || !user.brandId) {
        setLoadingSites(false);
        return;
      }
      
      setLoadingSites(true);
      try {
        const q = query(
          collection(db, 'attendance_sites'),
          where('isActive', '==', true)
        );
        const snap = await getDocs(q);
        
        const allSites = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));
        
        console.log("[SITE RESOLVER] User Brand ID:", user.brandId);
        
        // Filter secara ketat berdasarkan brandId user
        const brandSites = allSites.filter(site => {
          const bIds = site.brandIds || [];
          const sBrandId = site.brandId;
          const userBrandId = user.brandId;
          
          const isBrandMatch = Array.isArray(bIds) 
            ? bIds.includes(userBrandId) 
            : bIds === userBrandId;
            
          const isDirectMatch = sBrandId === userBrandId;
          
          return isBrandMatch || isDirectMatch;
        });

        console.log("[SITE RESOLVER] Filtered Candidate Sites:", brandSites.map(s => s.name));
        setSites(brandSites);
      } catch (err: any) {
        console.error("[SITE ERROR]", err.message);
        toast({
          variant: 'destructive',
          title: 'Gagal Memuat Lokasi',
          description: 'Pastikan koneksi internet stabil dan GPS aktif.'
        });
      } finally {
        setLoadingSites(false);
      }
    };
    loadSites();
  }, [db, user, userLoading, isAttendanceAllowed, toast]);

  useEffect(() => {
    if (!navigator.geolocation || !isAttendanceAllowed) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        });
      },
      (err) => console.error("GPS Error:", err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [isAttendanceAllowed]);

  useEffect(() => {
    if (location && sites.length > 0) {
      let closest = null;
      let minD = Infinity;
      sites.forEach(site => {
        const d = getDistance(location.lat, location.lng, site.office.lat, site.office.lng);
        if (d < minD) {
          minD = d;
          closest = site;
        }
      });
      setActiveSite(closest);
      setDistance(minD);
    } else {
      setActiveSite(null);
      setDistance(null);
    }
  }, [location, sites]);

  // HELPER: Hitung date range berdasarkan filter aktif
  const getDateRangeForFilter = useCallback((): [Date, Date] => {
    const now = new Date();
    let start: Date, end: Date;

    if (historyFilterMode === 'quick') {
      end = new Date(now);
      switch (selectedQuickFilter) {
        case 'today':
          start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'week':
          start = new Date(now);
          start.setDate(now.getDate() - now.getDay());
          break;
        case 'month':
          start = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'year':
          start = new Date(now.getFullYear(), 0, 1);
          break;
        default:
          start = new Date(now.getFullYear(), now.getMonth(), 1);
      }
    } else if (historyFilterMode === 'custom') {
      start = customStartDate ? new Date(customStartDate) : new Date(now.getFullYear(), now.getMonth(), 1);
      end = customEndDate ? new Date(customEndDate) : now;
    } else {
      // month mode
      const [year, month] = selectedMonth.split('-').map(Number);
      start = new Date(year, month - 1, 1);
      end = new Date(year, month, 0);
    }

    // Ensure start is at 00:00 and end is at 23:59
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    return [start, end];
  }, [historyFilterMode, selectedQuickFilter, customStartDate, customEndDate, selectedMonth]);

  const [filterStartDate, filterEndDate] = useMemo(() => getDateRangeForFilter(), [getDateRangeForFilter]);

  const historyQuery = useMemo(() => {
    if (!user?.uid || !isAttendanceAllowed) return null;
    return query(
      collection(db, 'attendance_events'),
      where('uid', '==', user.uid)
    );
  }, [user?.uid, db, isAttendanceAllowed]);

  const { data: rawEvents, loading: eventsLoading } = useCollection(historyQuery);

  const sortedEvents = useMemo(() => {
    if (!rawEvents) return [];
    return [...rawEvents].sort((a, b) => {
      const ta = a.tsClient instanceof Timestamp ? a.tsClient.toDate().getTime() : 0;
      const tb = b.tsClient instanceof Timestamp ? b.tsClient.toDate().getTime() : 0;
      return tb - ta;
    });
  }, [rawEvents]);

  // FILTER events berdasarkan date range dan status
  const filteredHistoryEvents = useMemo(() => {
    let filtered = sortedEvents.filter((ev: any) => {
      const evDate = ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date(ev.tsClient);
      const isInRange = evDate >= filterStartDate && evDate <= filterEndDate;
      const statusMatch = statusFilter === 'all' || ev.status === statusFilter;
      return isInRange && statusMatch;
    });
    return filtered;
  }, [sortedEvents, filterStartDate, filterEndDate, statusFilter]);

  // CALCULATE summary untuk periode yang dipilih
  const historySummary = useMemo(() => {
    const summary = {
      totalRecords: 0,
      hadir: 0,
      terlambat: 0,
      pulangAwal: 0,
      belumTapOut: 0,
      totalHours: 0
    };

    const tapInMap: Record<string, any> = {};
    filteredHistoryEvents.forEach((ev: any) => {
      const dateKey = format(ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date(ev.tsClient), 'yyyy-MM-dd');
      if (ev.type === 'IN') {
        tapInMap[dateKey] = ev;
      } else if (ev.type === 'OUT' && tapInMap[dateKey]) {
        const inTime = tapInMap[dateKey].tsClient instanceof Timestamp ? tapInMap[dateKey].tsClient.toDate() : new Date(tapInMap[dateKey].tsClient);
        const outTime = ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date(ev.tsClient);
        const hours = (outTime.getTime() - inTime.getTime()) / (1000 * 60 * 60);
        summary.totalHours += hours;
      }
    });

    filteredHistoryEvents.forEach((ev: any) => {
      if (ev.type === 'IN') {
        summary.totalRecords++;
        if (ev.status === 'LATE') {
          summary.terlambat++;
        } else if (ev.status === 'ON_TIME') {
          summary.hadir++;
        }
      }
      if (ev.status === 'EARLY_LEAVE') {
        summary.pulangAwal++;
      }
    });

    // Hitung belum tap out (ada IN tapi tidak ada OUT di hari yang sama)
    const daysWithIn = new Set<string>();
    const daysWithOut = new Set<string>();
    filteredHistoryEvents.forEach((ev: any) => {
      const dateKey = format(ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date(ev.tsClient), 'yyyy-MM-dd');
      if (ev.type === 'IN') daysWithIn.add(dateKey);
      if (ev.type === 'OUT') daysWithOut.add(dateKey);
    });
    summary.belumTapOut = daysWithIn.size - Array.from(daysWithIn).filter(d => daysWithOut.has(d)).length;

    return summary;
  }, [filteredHistoryEvents]);

  const todayStatus = useMemo(() => {
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const todayEvents = sortedEvents.filter((ev: any) => {
      const d = ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date();
      return format(d, 'yyyy-MM-dd') === todayStr;
    });
    return {
      hasIn: todayEvents.some(e => e.type === 'IN'),
      hasOut: todayEvents.some(e => e.type === 'OUT'),
      events: todayEvents
    };
  }, [sortedEvents]);

  const nextAction = todayStatus.hasIn ? 'OUT' : 'IN';
  const isFinished = todayStatus.hasOut;

  const isInsideRadius = useMemo(() => {
    if (distance === null || !activeSite) return false;
    return distance <= (activeSite.radiusM || 150);
  }, [distance, activeSite]);

  const isAccuracyOk = useMemo(() => {
    if (!location || !activeSite) return true;
    const required = activeSite.minGpsAccuracyM;
    return required ? location.accuracy <= required : true;
  }, [location, activeSite]);

  const canTapNormal = isAttendanceAllowed && isInsideRadius && isAccuracyOk && activeSite;

  const calculateStatus = (type: 'IN' | 'OUT', now: Date, site: any) => {
    if (!site?.shift) return { status: 'NORMAL', lateMinutes: 0 };
    const { startTime, endTime, graceLateMinutes } = site.shift;
    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);
    const scheduledStart = new Date(now);
    scheduledStart.setHours(startH, startM, 0, 0);
    const scheduledEnd = new Date(now);
    scheduledEnd.setHours(endH, endM, 0, 0);

    if (type === 'IN') {
      const graceEnd = new Date(scheduledStart.getTime() + (graceLateMinutes || 0) * 60000);
      if (now > graceEnd) {
        const diff = Math.ceil((now.getTime() - scheduledStart.getTime()) / 60000);
        return { status: 'LATE', lateMinutes: diff };
      }
      return { status: 'ON_TIME', lateMinutes: 0 };
    } else {
      if (now < scheduledEnd) return { status: 'EARLY_LEAVE', lateMinutes: 0 };
      return { status: 'ON_TIME', lateMinutes: 0 };
    }
  };

  const applyWatermark = async (base64: string, address: string, statusText: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = base64;
      img.onerror = () => reject(new Error("Failed to load capture"));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(base64);
        ctx.drawImage(img, 0, 0);
        const wmHeight = canvas.height * 0.22;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(0, canvas.height - wmHeight, canvas.width, wmHeight);
        ctx.fillStyle = 'white';
        ctx.textBaseline = 'top';
        const p = 40;
        ctx.font = 'bold 38px Inter, sans-serif';
        ctx.fillText(user?.displayName?.toUpperCase() || 'USER', p, canvas.height - wmHeight + 35);
        ctx.font = '28px Inter, sans-serif';
        ctx.fillText(`${user?.brandName || ''}`, p, canvas.height - wmHeight + 85);
        ctx.fillText(format(new Date(), 'dd MMMM yyyy, HH:mm', { locale: localeId }) + ' WIB', p, canvas.height - wmHeight + 125);
        ctx.font = '22px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        const words = (address || "").split(' ');
        let line = '';
        let y = canvas.height - wmHeight + 175;
        for(let n = 0; n < words.length; n++) {
          let test = line + words[n] + ' ';
          if (ctx.measureText(test).width > canvas.width - (p*2)) {
            ctx.fillText(line, p, y);
            line = words[n] + ' ';
            y += 30;
            if (y > canvas.height - 20) break;
          } else { line = test; }
        }
        ctx.fillText(line, p, y);
        ctx.font = 'bold 44px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillStyle = '#FB923C';
        ctx.fillText(statusText, canvas.width - p, canvas.height - wmHeight + 35);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
    });
  };

  const handleTap = async (mode: 'normal' | 'photo', photoBase64?: string) => {
    if (!user || !location || submitting || isFinished || !isAttendanceAllowed) return;
    setSubmitting(true);
    try {
      const now = new Date();
      const address = await getAddressFromLatLng(location.lat, location.lng);
      const { status, lateMinutes } = calculateStatus(nextAction, now, activeSite);
      
      let photoUrl = null;
      if (mode === 'photo' && photoBase64) {
        const watermarked = await applyWatermark(photoBase64, address, 'OFFSITE/DINAS');
        const storage = getStorage(firebaseApp);
        const path = `attendance/${user.uid}/${Date.now()}.jpg`;
        const storageRef = ref(storage, path);
        const blobResponse = await fetch(watermarked);
        const blob = await blobResponse.blob();
        await uploadBytes(storageRef, blob);
        photoUrl = await getDownloadURL(storageRef);
      }

      await addDoc(collection(db, 'attendance_events'), {
        uid: user.uid,
        userName: user.displayName,
        brandId: user.brandId,
        siteId: activeSite?.id || 'OFFSITE',
        siteName: activeSite?.name || 'Luar Kantor',
        type: nextAction,
        tsClient: Timestamp.fromDate(now),
        tsServer: serverTimestamp(),
        mode,
        geo: { lat: location.lat, lng: location.lng, accuracyM: location.accuracy },
        address,
        photoUrl,
        status,
        lateMinutes,
        flags: !isInsideRadius ? ['OFFSITE'] : []
      });

      toast({ title: 'Sukses!', description: `Absen ${nextAction} berhasil.` });
      setShowCamera(false);
      setHoldProgress(0);
    } catch (err: any) {
      console.error("Attendance Error:", err);
      toast({ variant: 'destructive', title: 'Gagal', description: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const startHold = () => {
    if (nextAction !== 'OUT' || !canTapNormal || submitting || isFinished || !isAttendanceAllowed) return;
    
    setHoldProgress(0);
    const startTime = Date.now();
    const duration = 2000;

    holdInterval.current = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min((elapsed / duration) * 100, 100);
      setHoldProgress(progress);

      if (elapsed >= duration) {
        if (holdInterval.current) clearInterval(holdInterval.current);
        holdInterval.current = null;
        setHoldProgress(0);
        handleTap('normal');
      }
    }, 50);
  };

  const cancelHold = () => {
    if (holdInterval.current) {
      clearInterval(holdInterval.current);
      holdInterval.current = null;
    }
    setHoldProgress(0);
  };

  const handleButtonClick = () => {
    if (nextAction === 'IN') {
      handleTap('normal');
    }
  };

  if (userLoading || (loadingSites && isAttendanceAllowed)) {
    return <div className="min-h-svh flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto relative shadow-2xl border-x">
      <div className="flex-1 overflow-auto pb-20">
        {!user?.employeeProfileFound && user?.email && (
          <div className="bg-yellow-50 border-b border-yellow-200 p-3">
            <div className="flex items-start gap-2 text-[10px]">
              <AlertTriangle className="w-4 h-4 text-yellow-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-yellow-800">Data Profil Tidak Ditemukan</p>
                <p className="text-yellow-700 text-[9px] mt-0.5">Data karyawan Anda belum terdaftar di sistem HRP. Silakan hubungi HRD untuk melengkapi data profil.</p>
              </div>
            </div>
          </div>
        )}
        <div className="p-4 flex justify-between items-center bg-white/90 backdrop-blur-md sticky top-0 z-10 border-b">
          <div className="flex items-center gap-3">
            <Avatar className="w-10 h-10 ring-2 ring-primary/5">
              <AvatarFallback className="bg-primary text-white font-bold">{user?.displayName?.[0]}</AvatarFallback>
            </Avatar>
            <div className="space-y-0.5">
              <h1 className="font-bold text-sm leading-tight">{user?.displayName}</h1>
              <div className="text-[8px] text-muted-foreground space-y-0.5">
                <p className="uppercase font-black tracking-widest">{user?.brandName || "Brand belum diatur"}</p>
                {user?.division && <p className="text-[7px]">📍 {user.division}</p>}
                <p className="font-mono text-[7px] text-primary font-bold">
                  🆔 {user?.employeeId || "ID belum diatur"}
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {user?.attendanceMethod && (
              <Badge variant="outline" className="text-[8px] h-5 uppercase px-2 bg-muted/30">{user.attendanceMethod.replace('_', ' ')}</Badge>
            )}
            <Button variant="ghost" size="icon" onClick={() => signOut(auth)} className="rounded-full">
              <LogOut className="w-5 h-5" />
            </Button>
          </div>
        </div>

        <Tabs defaultValue="absen" className="w-full">
          <TabsList className="grid w-full grid-cols-2 rounded-none h-12 border-b bg-muted/20">
            <TabsTrigger value="absen" className="gap-2"><Navigation className="w-4 h-4" /> Absensi</TabsTrigger>
            <TabsTrigger value="history" className="gap-2"><FileText className="w-4 h-4" /> Riwayat</TabsTrigger>
          </TabsList>

          <TabsContent value="absen" className="p-4 space-y-6">
            {!isAttendanceAllowed && (
              <Alert variant="destructive" className="border-destructive/50 bg-destructive/5">
                <ShieldAlert className="h-4 w-4" />
                <AlertTitle className="text-xs font-black uppercase">Akses Dibatasi</AlertTitle>
                <AlertDescription className="text-[11px] leading-tight mt-1">
                  {restrictedMessage || "Hubungi HRD untuk akses absensi."}
                </AlertDescription>
              </Alert>
            )}

            {isAttendanceAllowed && !loadingSites && sites.length === 0 && (
              <Card className="border-destructive/50 bg-destructive/5">
                <CardContent className="pt-6 flex items-center gap-3 text-destructive">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <p className="text-xs font-bold uppercase tracking-tight">
                    Brand Anda belum memiliki site absensi yang terdaftar.
                  </p>
                </CardContent>
              </Card>
            )}

            <Card className={`border-none shadow-sm rounded-3xl overflow-hidden bg-white ${!isAttendanceAllowed ? 'opacity-40 grayscale pointer-events-none' : ''}`}>
              <CardContent className="pt-6 space-y-4">
                <div className="flex justify-center gap-2">
                  {isInsideRadius ? (
                    <Badge className="bg-green-600 text-white border-none rounded-full px-4 py-1.5 gap-2">
                      <CheckCircle2 className="w-3 h-3" /> ZONA ONSITE
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="rounded-full px-4 py-1.5 gap-2">
                      <AlertTriangle className="w-3 h-3" /> ZONA OFFSITE
                    </Badge>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-muted/30 rounded-2xl">
                    <p className="text-[9px] font-bold text-muted-foreground uppercase mb-1">Jarak</p>
                    <p className="text-sm font-black">{distance !== null ? `${Math.round(distance)}m` : '--'}</p>
                    <p className="text-[8px] opacity-60">Radius: {activeSite?.radiusM || 150}m</p>
                  </div>
                  <div className="p-3 bg-muted/30 rounded-2xl">
                    <p className="text-[9px] font-bold text-muted-foreground uppercase mb-1">Akurasi GPS</p>
                    <p className={`text-sm font-black ${!isAccuracyOk ? 'text-destructive' : ''}`}>
                      ±{location?.accuracy.toFixed(0)}m
                    </p>
                  </div>
                </div>
                {activeSite && <p className="text-center text-[10px] font-bold text-primary uppercase tracking-tighter">Site Aktif: {activeSite.name}</p>}
              </CardContent>
            </Card>

            <div className="flex flex-col items-center gap-8 py-4">
              <div className="relative">
                {isAttendanceAllowed && nextAction === 'OUT' && holdProgress > 0 && (
                  <svg className="absolute -inset-4 w-[calc(100%+32px)] h-[calc(100%+32px)] -rotate-90 pointer-events-none z-10">
                    <circle
                      cx="112" cy="112" r="104"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="6"
                      strokeDasharray="653.45"
                      strokeDashoffset={653.45 - (653.45 * holdProgress) / 100}
                      className="text-secondary transition-all duration-75"
                    />
                  </svg>
                )}
                
                <button
                  onPointerDown={startHold}
                  onPointerUp={cancelHold}
                  onPointerLeave={cancelHold}
                  onClick={handleButtonClick}
                  disabled={!canTapNormal || submitting || isFinished || !isAttendanceAllowed}
                  className={`
                    relative w-48 h-48 rounded-full flex flex-col items-center justify-center gap-2 shadow-2xl transition-all
                    ${nextAction === 'IN' ? 'bg-primary text-white active:scale-95' : 'bg-secondary text-white'}
                    ${(isFinished || !canTapNormal || !isAttendanceAllowed) ? 'opacity-30 grayscale cursor-not-allowed' : 'hover:scale-105'}
                    ${holdProgress > 0 ? 'scale-110' : ''}
                    ${submitting ? 'animate-pulse' : ''}
                  `}
                >
                  {submitting ? <Loader2 className="w-12 h-12 animate-spin" /> : (
                    <>
                      <Clock className="w-10 h-10 mb-1" />
                      <span className="text-2xl font-black uppercase tracking-tighter">TAP {nextAction}</span>
                      <span className="text-[9px] font-bold opacity-70 uppercase">
                        {nextAction === 'OUT' ? 'Tahan 2 Detik' : 'Sekali Klik'}
                      </span>
                    </>
                  )}
                </button>
              </div>

              {(isAttendanceAllowed && !canTapNormal && !isFinished && sites.length > 0) && (
                <div className="text-center px-4 space-y-4">
                  <p className="text-xs text-muted-foreground font-medium italic">Anda berada di luar radius kantor.</p>
                  <Button onClick={() => setShowCamera(true)} variant="outline" className="rounded-full px-8 py-7 h-auto border-primary/20 bg-primary/5 hover:bg-primary/10 gap-3">
                    <Camera className="w-6 h-6 text-primary" />
                    <div className="text-left">
                      <p className="text-xs font-bold leading-none mb-1 uppercase">Absen Foto</p>
                      <p className="text-[9px] text-muted-foreground uppercase font-black tracking-widest opacity-60">Dinas / Luar Kota</p>
                    </div>
                  </Button>
                </div>
              )}

              {isFinished && (
                <Badge variant="outline" className="py-2.5 px-8 rounded-full border-green-200 bg-green-50 text-green-700 font-bold uppercase tracking-wide">
                  Absensi Hari Ini Selesai
                </Badge>
              )}
            </div>

            <div className="space-y-4">
              <h2 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground px-1">Aktivitas Hari Ini</h2>
              <div className="space-y-3">
                {!isAttendanceAllowed ? (
                   <p className="text-center text-xs text-muted-foreground py-8 italic opacity-50">Riwayat tidak tersedia untuk tipe akun ini.</p>
                ) : todayStatus.events.length === 0 ? <p className="text-center text-xs text-muted-foreground py-8 italic">Belum ada aktivitas hari ini.</p> :
                 todayStatus.events.map((ev: any, i: number) => {
                   const dt = ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date();
                   return (
                     <div key={i} className="bg-white p-4 rounded-3xl border shadow-sm flex justify-between items-center">
                       <div className="flex gap-4">
                         <div className={`p-2.5 rounded-2xl ${ev.type === 'IN' ? 'bg-primary/10 text-primary' : 'bg-secondary/10 text-secondary'}`}>
                           <Clock className="w-5 h-5" />
                         </div>
                         <div>
                           <p className="text-xs font-black uppercase">TAP {ev.type}</p>
                           <p className="text-[10px] text-muted-foreground font-medium line-clamp-1 max-w-[150px]">{ev.siteName}</p>
                         </div>
                       </div>
                       <div className="text-right">
                         <p className="text-sm font-black">{format(dt, 'HH:mm')}</p>
                         <Badge variant="outline" className={`text-[8px] h-4 py-0 border-none ${ev.status === 'LATE' ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}`}>
                           {ev.status === 'LATE' ? `TERLAMBAT (${ev.lateMinutes}m)` : 'TEPAT WAKTU'}
                         </Badge>
                       </div>
                     </div>
                   );
                 })
                }
              </div>
            </div>
          </TabsContent>

          <TabsContent value="history" className="p-4 space-y-4">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Riwayat Absensi</h3>

            {!isAttendanceAllowed ? (
              <div className="py-12 flex flex-col items-center gap-3 text-muted-foreground opacity-50">
                <FileText className="w-8 h-8" />
                <p className="text-xs italic">Riwayat tidak tersedia untuk akun ini.</p>
              </div>
            ) : (
              <>
                {/* FILTER UI */}
                <div className="space-y-3 bg-white p-3 rounded-2xl border shadow-sm">
                  {/* Filter Mode Selector */}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={historyFilterMode === 'quick' ? 'default' : 'outline'}
                      onClick={() => setHistoryFilterMode('quick')}
                      className="text-[9px] h-7 px-2"
                    >
                      Cepat
                    </Button>
                    <Button
                      size="sm"
                      variant={historyFilterMode === 'custom' ? 'default' : 'outline'}
                      onClick={() => setHistoryFilterMode('custom')}
                      className="text-[9px] h-7 px-2"
                    >
                      Tanggal
                    </Button>
                    <Button
                      size="sm"
                      variant={historyFilterMode === 'month' ? 'default' : 'outline'}
                      onClick={() => setHistoryFilterMode('month')}
                      className="text-[9px] h-7 px-2"
                    >
                      Bulan
                    </Button>
                  </div>

                  {/* Quick Filters */}
                  {historyFilterMode === 'quick' && (
                    <div className="grid grid-cols-2 gap-2">
                      {(['today', 'week', 'month', 'year'] as const).map(filter => (
                        <Button
                          key={filter}
                          size="sm"
                          variant={selectedQuickFilter === filter ? 'default' : 'outline'}
                          onClick={() => setSelectedQuickFilter(filter)}
                          className="text-[9px] h-7"
                        >
                          {filter === 'today' && 'Hari Ini'}
                          {filter === 'week' && 'Minggu Ini'}
                          {filter === 'month' && 'Bulan Ini'}
                          {filter === 'year' && 'Tahun Ini'}
                        </Button>
                      ))}
                    </div>
                  )}

                  {/* Custom Date Range */}
                  {historyFilterMode === 'custom' && (
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="date"
                        value={customStartDate}
                        onChange={(e) => setCustomStartDate(e.target.value)}
                        className="text-[9px] h-7 px-2 rounded border"
                      />
                      <input
                        type="date"
                        value={customEndDate}
                        onChange={(e) => setCustomEndDate(e.target.value)}
                        className="text-[9px] h-7 px-2 rounded border"
                      />
                    </div>
                  )}

                  {/* Month Picker */}
                  {historyFilterMode === 'month' && (
                    <input
                      type="month"
                      value={selectedMonth}
                      onChange={(e) => setSelectedMonth(e.target.value)}
                      className="text-[9px] h-7 px-2 rounded border w-full"
                    />
                  )}

                  {/* Status Filter */}
                  <div>
                    <label className="text-[9px] font-bold text-muted-foreground block mb-1">Status</label>
                    <select
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                      className="w-full text-[9px] h-7 px-2 rounded border bg-white"
                    >
                      <option value="all">Semua Status</option>
                      <option value="ON_TIME">Hadir</option>
                      <option value="LATE">Terlambat</option>
                      <option value="EARLY_LEAVE">Pulang Awal</option>
                      <option value="NORMAL">Normal</option>
                    </select>
                  </div>
                </div>

                {/* SUMMARY CARDS */}
                {eventsLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <Card className="border-none shadow-sm rounded-2xl bg-green-50">
                        <CardContent className="pt-3 pb-2 text-center">
                          <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1">Hadir</p>
                          <p className="text-lg font-black text-green-600">{historySummary.hadir}</p>
                        </CardContent>
                      </Card>
                      <Card className="border-none shadow-sm rounded-2xl bg-red-50">
                        <CardContent className="pt-3 pb-2 text-center">
                          <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1">Terlambat</p>
                          <p className="text-lg font-black text-red-600">{historySummary.terlambat}</p>
                        </CardContent>
                      </Card>
                      <Card className="border-none shadow-sm rounded-2xl bg-orange-50">
                        <CardContent className="pt-3 pb-2 text-center">
                          <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1">Pulang Awal</p>
                          <p className="text-lg font-black text-orange-600">{historySummary.pulangAwal}</p>
                        </CardContent>
                      </Card>
                      <Card className="border-none shadow-sm rounded-2xl bg-yellow-50">
                        <CardContent className="pt-3 pb-2 text-center">
                          <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1">Belum Tap Out</p>
                          <p className="text-lg font-black text-yellow-600">{historySummary.belumTapOut}</p>
                        </CardContent>
                      </Card>
                    </div>

                    {/* HISTORY LIST */}
                    <div className="space-y-3">
                      {filteredHistoryEvents.length === 0 ? (
                        <div className="py-12 flex flex-col items-center gap-3 text-muted-foreground opacity-50">
                          <FileText className="w-8 h-8" />
                          <p className="text-xs italic">Belum ada riwayat absensi pada periode ini.</p>
                        </div>
                      ) : (
                        filteredHistoryEvents.map((ev: any, i: number) => {
                          const dt = ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date(ev.tsClient);
                          const statusColor = ev.status === 'LATE' ? 'bg-red-50 text-red-600 border-red-200' : ev.status === 'EARLY_LEAVE' ? 'bg-orange-50 text-orange-600 border-orange-200' : 'bg-green-50 text-green-600 border-green-200';
                          return (
                            <div key={i} className="bg-white p-3 rounded-2xl border shadow-sm">
                              <div className="flex justify-between items-start mb-2">
                                <div>
                                  <p className="text-[9px] font-bold text-muted-foreground mb-0.5">{format(dt, 'EEEE, dd MMM yyyy', { locale: localeId })}</p>
                                  <p className="text-[10px] font-black uppercase tracking-tight">
                                    {ev.type === 'IN' ? '📍 Tap Masuk' : '🚪 Tap Keluar'} • {format(dt, 'HH:mm')}
                                  </p>
                                </div>
                                <Badge variant="outline" className={`text-[8px] rounded-full px-2 py-0.5 h-auto border ${statusColor}`}>
                                  {ev.status === 'LATE' ? `TERLAMBAT (${ev.lateMinutes}m)` : ev.status === 'EARLY_LEAVE' ? 'PULANG AWAL' : 'TEPAT WAKTU'}
                                </Badge>
                              </div>
                              <div className="flex items-start gap-2 mt-2 text-[9px] text-muted-foreground">
                                <MapPin className="w-3 h-3 mt-0.5 shrink-0" />
                                <span className="leading-tight">{ev.siteName || ev.address || 'Lokasi tidak tercatat'}</span>
                              </div>
                              {ev.flags?.includes('OFFSITE') && (
                                <div className="mt-2 text-[8px] text-orange-600 bg-orange-50 px-2 py-1 rounded-lg inline-block">
                                  ⚠️ OFFSITE
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {showCamera && (
        <CameraCapture
          onCapture={(base64) => handleTap('photo', base64)}
          onCancel={() => setShowCamera(false)}
        />
      )}
    </div>
  );
}