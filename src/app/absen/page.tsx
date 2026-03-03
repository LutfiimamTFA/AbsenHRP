'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { 
  collection, 
  query, 
  where, 
  getDocs, 
  addDoc, 
  serverTimestamp, 
  Timestamp, 
  orderBy, 
  limit 
} from 'firebase/firestore';
import { getStorage, ref, uploadString, getDownloadURL } from 'firebase/storage';
import { useAuth, useFirestore, useUser, useCollection } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { 
  MapPin, 
  LogOut, 
  CheckCircle2, 
  AlertTriangle, 
  Loader2, 
  Clock, 
  History, 
  Camera, 
  Navigation,
  MapPinned,
  FileText
} from 'lucide-react';
import { useDeviceId } from '@/hooks/use-device-id';
import { useToast } from '@/hooks/use-toast';
import { getDistance, getAddressFromLatLng } from '@/lib/geo-utils';
import { CameraCapture } from '@/components/camera-capture';
import { format } from 'date-fns';
import { id as localeId } from 'date-fns/locale';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function AbsenPage() {
  const { user, loading: userLoading } = useUser();
  const auth = useAuth();
  const db = useFirestore();
  const router = useRouter();
  const { toast } = useToast();
  
  const [location, setLocation] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [sites, setSites] = useState<any[]>([]);
  const [activeSite, setActiveSite] = useState<any>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadingSites, setLoadingSites] = useState(true);
  
  const deviceId = useDeviceId();

  // Role Restriction
  useEffect(() => {
    if (!userLoading) {
      if (!user) {
        router.push('/login');
      } else if (user.role === 'kandidat') {
        router.push('/unauthorized');
      }
    }
  }, [user, userLoading, router]);

  // Load Multi-Site Gedung A/B
  useEffect(() => {
    const loadSites = async () => {
      if (!user?.brandId) return;
      setLoadingSites(true);
      try {
        const q = query(
          collection(db, 'attendance_sites'),
          where('isActive', '==', true),
          where('brandIds', 'array-contains', user.brandId)
        );
        const snap = await getDocs(q);
        const siteData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setSites(siteData);
      } catch (err: any) {
        console.error("Error load sites:", err);
      } finally {
        setLoadingSites(false);
      }
    };
    loadSites();
  }, [db, user?.brandId]);

  // GPS Tracking with High Accuracy
  useEffect(() => {
    if (!navigator.geolocation) return;
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
  }, []);

  // Nearest Site Selection (Gedung A/B Selection)
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
    }
  }, [location, sites]);

  const historyQuery = useMemo(() => {
    if (!user?.uid) return null;
    return query(
      collection(db, 'attendance_events'),
      where('uid', '==', user.uid),
      orderBy('tsClient', 'desc'),
      limit(20)
    );
  }, [user?.uid, db]);

  const { data: rawEvents, loading: eventsLoading } = useCollection(historyQuery);

  const todayStatus = useMemo(() => {
    if (!rawEvents) return { hasIn: false, hasOut: false, events: [] };
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const todayEvents = rawEvents.filter((ev: any) => {
      const d = ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date(ev.tsClient);
      return format(d, 'yyyy-MM-dd') === todayStr;
    });
    return {
      hasIn: todayEvents.some(e => e.type === 'IN'),
      hasOut: todayEvents.some(e => e.type === 'OUT'),
      events: todayEvents
    };
  }, [rawEvents]);

  const nextAction = todayStatus.hasIn ? 'OUT' : 'IN';
  const isFinished = todayStatus.hasOut;

  const isInsideRadius = useMemo(() => {
    if (distance === null || !activeSite) return false;
    return distance <= activeSite.radiusM;
  }, [distance, activeSite]);

  const isAccuracyOk = useMemo(() => {
    if (!location || !activeSite) return true;
    const required = activeSite.minGpsAccuracyM;
    if (required) return location.accuracy <= required;
    return true;
  }, [location, activeSite]);

  const canTapNormal = isInsideRadius && isAccuracyOk;

  const calculateShiftStatus = (type: 'IN' | 'OUT', time: Date, shift: any) => {
    if (!shift) return { status: 'ON_TIME', minutes: 0 };
    try {
      const [sh, sm] = shift.startTime.split(':').map(Number);
      const [eh, em] = shift.endTime.split(':').map(Number);
      const grace = shift.graceLateMinutes || 0;
      const currentMinutes = time.getHours() * 60 + time.getMinutes();
      
      if (type === 'IN') {
        const startLimit = sh * 60 + sm + grace;
        if (currentMinutes > startLimit) {
          return { status: 'LATE', minutes: currentMinutes - (sh * 60 + sm) };
        }
      } else {
        const endLimit = eh * 60 + em;
        if (currentMinutes < endLimit) {
          return { status: 'EARLY_LEAVE', minutes: endLimit - currentMinutes };
        } else if (currentMinutes > endLimit) {
          return { status: 'OVERTIME', minutes: currentMinutes - endLimit };
        }
      }
    } catch (e) { console.error("Calc error:", e); }
    return { status: 'ON_TIME', minutes: 0 };
  };

  const applyWatermark = async (base64: string, address: string, statusText: string): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.src = base64;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(base64);

        ctx.drawImage(img, 0, 0);
        
        // Professional Watermark Box (Bottom ~20%)
        const wmHeight = canvas.height * 0.22;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(0, canvas.height - wmHeight, canvas.width, wmHeight);

        ctx.fillStyle = 'white';
        ctx.textBaseline = 'top';
        const padding = 40;
        
        // Name & Brand
        ctx.font = 'bold 38px Inter, sans-serif';
        ctx.fillText(user?.displayName?.toUpperCase() || 'KARYAWAN', padding, canvas.height - wmHeight + 35);
        
        ctx.font = '28px Inter, sans-serif';
        ctx.fillText(`${user?.brandName || ''} • ${user?.division || ''}`, padding, canvas.height - wmHeight + 85);
        ctx.fillText(`${format(new Date(), 'dd MMMM yyyy, HH:mm', { locale: localeId })} WIB`, padding, canvas.height - wmHeight + 125);
        
        // Address Text (No Lat/Lng as requested)
        ctx.font = '22px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        const maxWidth = canvas.width - (padding * 2);
        const words = address.split(' ');
        let line = '';
        let y = canvas.height - wmHeight + 175;
        for(let n = 0; n < words.length; n++) {
          let testLine = line + words[n] + ' ';
          if (ctx.measureText(testLine).width > maxWidth && n > 0) {
            ctx.fillText(line, padding, y);
            line = words[n] + ' ';
            y += 30;
          } else {
            line = testLine;
          }
        }
        ctx.fillText(line, padding, y);

        // Status Overlay
        ctx.font = 'bold 44px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillStyle = '#FB923C'; // Orange for Offsite
        ctx.fillText(statusText, canvas.width - padding, canvas.height - wmHeight + 35);
        
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
    });
  };

  const handleTap = async (mode: 'normal' | 'photo', photoBase64?: string) => {
    if (!user || !location || submitting || isFinished) return;
    
    setSubmitting(true);
    try {
      const now = new Date();
      const { status, minutes } = calculateShiftStatus(nextAction, now, activeSite?.shift);
      const address = await getAddressFromLatLng(location.lat, location.lng);
      
      let photoUrl = null;
      if (mode === 'photo' && photoBase64) {
        const wmStatus = `${nextAction === 'IN' ? 'MASUK' : 'PULANG'} - OFFSITE`;
        const watermarked = await applyWatermark(photoBase64, address, wmStatus);
        const storage = getStorage();
        const path = `attendance/${user.uid}/${Date.now()}.jpg`;
        const storageRef = ref(storage, path);
        await uploadString(storageRef, watermarked, 'data_url');
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
        insideRadius: isInsideRadius,
        distanceM: Math.round(distance || 0),
        address,
        status,
        minutes,
        photoUrl,
        deviceId: deviceId || 'web',
        flags: !isInsideRadius ? ['OFFSITE'] : location.accuracy > 100 ? ['GPS_WEAK'] : []
      });

      toast({
        title: 'Berhasil!',
        description: `Absen ${nextAction === 'IN' ? 'Masuk' : 'Pulang'} berhasil dicatat.`,
      });
      setShowCamera(false);
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Gagal Absen', description: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  if (userLoading || loadingSites) {
    return <div className="min-h-svh flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto relative shadow-2xl">
      <div className="flex-1 overflow-auto pb-20">
        <div className="p-4 flex justify-between items-center bg-white/80 backdrop-blur-md sticky top-0 z-10 border-b">
          <div className="flex items-center gap-3">
            <Avatar className="w-10 h-10 ring-2 ring-primary/10">
              <AvatarFallback className="bg-primary text-white font-bold">{user?.displayName?.[0]}</AvatarFallback>
            </Avatar>
            <div>
              <h1 className="font-bold text-sm leading-tight">{user?.displayName}</h1>
              <p className="text-[9px] text-muted-foreground uppercase font-black tracking-widest">{user?.brandName}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => signOut(auth)} className="rounded-full">
            <LogOut className="w-5 h-5" />
          </Button>
        </div>

        <Tabs defaultValue="absen" className="w-full">
          <TabsList className="grid w-full grid-cols-2 rounded-none h-12 border-b bg-muted/20">
            <TabsTrigger value="absen" className="gap-2"><Navigation className="w-4 h-4" /> Absensi</TabsTrigger>
            <TabsTrigger value="history" className="gap-2"><FileText className="w-4 h-4" /> Riwayat</TabsTrigger>
          </TabsList>

          <TabsContent value="absen" className="p-4 space-y-6">
            <Card className="border-none shadow-sm rounded-3xl overflow-hidden bg-gradient-to-br from-white to-muted/30">
              <CardContent className="pt-6">
                <div className="flex flex-col items-center gap-4">
                  <div className="flex flex-wrap justify-center gap-2">
                    {activeSite && (
                      <Badge variant="outline" className="rounded-full px-3 py-1 gap-1.5 border-primary/20">
                        <Navigation className="w-3 h-3 text-primary" /> {activeSite.name}
                      </Badge>
                    )}
                    {isInsideRadius ? (
                      <Badge className="bg-green-600 text-white border-none rounded-full px-4 py-1 gap-2">
                        <CheckCircle2 className="w-3 h-3" /> ZONA ONSITE
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="rounded-full px-4 py-1 gap-2">
                        <AlertTriangle className="w-3 h-3" /> ZONA OFFSITE
                      </Badge>
                    )}
                  </div>

                  <div className="grid grid-cols-2 w-full gap-3">
                    <div className="p-3 bg-white rounded-2xl border">
                      <p className="text-[9px] font-bold text-muted-foreground uppercase">Jarak Anda</p>
                      <p className="text-sm font-black">{distance !== null ? `${Math.round(distance)}m` : '--'}</p>
                      <p className="text-[8px] opacity-60">Radius: {activeSite?.radiusM || 150}m</p>
                    </div>
                    <div className="p-3 bg-white rounded-2xl border">
                      <p className="text-[9px] font-bold text-muted-foreground uppercase">Akurasi GPS</p>
                      <p className={`text-sm font-black ${!isAccuracyOk ? 'text-destructive' : ''}`}>
                        ±{location?.accuracy.toFixed(0)}m
                      </p>
                      {activeSite?.minGpsAccuracyM && (
                        <p className="text-[8px] opacity-60">Batas: ≤{activeSite.minGpsAccuracyM}m</p>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="flex flex-col items-center gap-8 py-4">
              <button
                onClick={() => handleTap('normal')}
                disabled={!canTapNormal || submitting || isFinished}
                className={`
                  relative w-44 h-44 rounded-full flex flex-col items-center justify-center gap-2 shadow-2xl transition-all active:scale-95
                  ${nextAction === 'IN' ? 'bg-primary text-white' : 'bg-secondary text-white'}
                  ${(isFinished || !canTapNormal) ? 'opacity-30 grayscale cursor-not-allowed' : 'hover:scale-105'}
                  ${submitting ? 'animate-pulse' : ''}
                `}
              >
                {submitting ? <Loader2 className="w-12 h-12 animate-spin" /> : (
                  <>
                    <Clock className="w-10 h-10 mb-1" />
                    <span className="text-xl font-black uppercase tracking-tighter">TAP {nextAction}</span>
                    <span className="text-[9px] font-bold opacity-70">Klik di Sini</span>
                  </>
                )}
              </button>

              {!canTapNormal && !isFinished && (
                <div className="text-center px-4 animate-in fade-in slide-in-from-bottom-2">
                  <p className="text-xs text-muted-foreground font-medium mb-4 italic leading-relaxed">
                    Sistem mendeteksi Anda berada di luar radius kantor atau GPS belum stabil.
                  </p>
                  <Button 
                    onClick={() => setShowCamera(true)} 
                    variant="outline" 
                    className="rounded-full px-8 py-7 h-auto border-primary/20 bg-primary/5 hover:bg-primary/10 gap-3"
                  >
                    <Camera className="w-6 h-6 text-primary" />
                    <div className="text-left">
                      <p className="text-xs font-bold leading-none mb-1">ABSEN FOTO</p>
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
              <h2 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground px-1">Riwayat Hari Ini</h2>
              <div className="space-y-3">
                {eventsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto opacity-20" /> : 
                 todayStatus.events.length === 0 ? <p className="text-center text-xs text-muted-foreground py-8 italic">Belum ada aktivitas hari ini.</p> :
                 todayStatus.events.map((ev: any, i: number) => {
                   const dt = ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date(ev.tsClient);
                   return (
                     <div key={i} className="bg-white p-4 rounded-3xl border shadow-sm flex justify-between items-center">
                       <div className="flex gap-4">
                         <div className={`p-2.5 rounded-2xl ${ev.type === 'IN' ? 'bg-primary/10 text-primary' : 'bg-secondary/10 text-secondary'}`}>
                           <Clock className="w-5 h-5" />
                         </div>
                         <div>
                           <p className="text-xs font-black uppercase">TAP {ev.type}</p>
                           <p className="text-[10px] text-muted-foreground font-medium line-clamp-1 max-w-[150px]">{ev.address || ev.siteName}</p>
                         </div>
                       </div>
                       <div className="text-right">
                         <p className="text-sm font-black">{format(dt, 'HH:mm')}</p>
                         <Badge variant="outline" className={`text-[8px] h-4 py-0 border-none ${ev.mode === 'photo' ? 'bg-orange-50 text-orange-600' : 'bg-green-50 text-green-600'}`}>
                           {ev.mode === 'photo' ? 'OFFSITE' : 'ONSITE'}
                         </Badge>
                       </div>
                     </div>
                   );
                 })
                }
              </div>
            </div>
          </TabsContent>

          <TabsContent value="history" className="p-4">
             <div className="space-y-4">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Log Aktivitas Terbaru</h3>
              <div className="space-y-3">
                {rawEvents?.map((ev: any, i: number) => {
                  const dt = ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date(ev.tsClient);
                  return (
                    <div key={i} className="bg-white p-4 rounded-3xl border shadow-sm">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="text-[10px] font-bold text-muted-foreground mb-0.5">{format(dt, 'EEEE, dd MMM yyyy', { locale: localeId })}</p>
                          <p className="text-xs font-black uppercase tracking-tight">TAP {ev.type} • {ev.siteName}</p>
                        </div>
                        <Badge variant={ev.status === 'LATE' ? 'destructive' : 'outline'} className="text-[9px] rounded-full px-3">
                          {ev.status || 'HADIR'}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <Clock className="w-3 h-3 text-muted-foreground" />
                        <span className="text-xs font-bold">{format(dt, 'HH:mm')} WIB</span>
                        <span className="mx-2 text-muted-foreground opacity-20">|</span>
                        <MapPin className="w-3 h-3 text-muted-foreground" />
                        <span className="text-[10px] text-muted-foreground line-clamp-1">{ev.address}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
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