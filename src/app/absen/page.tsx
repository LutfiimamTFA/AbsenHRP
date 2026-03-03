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
  Timestamp 
} from 'firebase/firestore';
import { getStorage, ref, uploadString, getDownloadURL } from 'firebase/storage';
import { useAuth, useFirestore, useUser, useCollection } from '@/firebase';
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
  MapPin
} from 'lucide-react';
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

  // 1. Role Check & Auth Redirect
  useEffect(() => {
    if (!userLoading) {
      if (!user) {
        router.push('/login');
      } else if (user.role === 'kandidat') {
        router.push('/unauthorized');
      }
    }
  }, [user, userLoading, router]);

  // 2. Multi-Site Loading (Dynamic from attendance_sites)
  useEffect(() => {
    const loadSites = async () => {
      if (!user?.brandId) {
        console.warn("[SITE RESOLVER] brandId user kosong. User:", user?.displayName);
        setLoadingSites(false);
        return;
      }
      
      setLoadingSites(true);
      try {
        console.log("[SITE RESOLVER] Mencari site untuk userBrandId:", user.brandId);
        
        const q = query(
          collection(db, 'attendance_sites'),
          where('isActive', '==', true)
        );
        const snap = await getDocs(q);
        const allSites = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // Filter ketat berdasarkan brandId user (mendukung string atau array)
        const brandSites = allSites.filter((s: any) => {
          if (!s.brandIds || !Array.isArray(s.brandIds)) return false;
          
          if (Array.isArray(user.brandId)) {
            // User multi-brand (array) -> site harus punya salah satu brand user
            return s.brandIds.some(bid => user.brandId.includes(bid));
          }
          // User single brand (string)
          return s.brandIds.includes(user.brandId);
        });

        console.log("[SITE RESOLVER] Kandidat Site Terfilter:", brandSites.map(s => `${s.id} (${s.name})`));
        setSites(brandSites);
      } catch (err: any) {
        console.error("[SITE ERROR] Gagal load sites:", err.message);
      } finally {
        setLoadingSites(false);
      }
    };
    loadSites();
  }, [db, user?.brandId]);

  // 3. High Accuracy GPS Tracking
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

  // 4. Site Selection (Nearest Gedung A/B dari kandidat yang sudah terfilter)
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
    } else if (sites.length === 0) {
      setActiveSite(null);
      setDistance(null);
    }
  }, [location, sites]);

  // 5. History Loading
  const historyQuery = useMemo(() => {
    if (!user?.uid) return null;
    return query(
      collection(db, 'attendance_events'),
      where('uid', '==', user.uid)
    );
  }, [user?.uid, db]);

  const { data: rawEvents, loading: eventsLoading } = useCollection(historyQuery);

  const sortedEvents = useMemo(() => {
    if (!rawEvents) return [];
    return [...rawEvents].sort((a, b) => {
      const ta = a.tsClient instanceof Timestamp ? a.tsClient.toDate().getTime() : 0;
      const tb = b.tsClient instanceof Timestamp ? b.tsClient.toDate().getTime() : 0;
      return tb - ta;
    });
  }, [rawEvents]);

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

  const canTapNormal = isInsideRadius && isAccuracyOk && activeSite;

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
        const wmHeight = canvas.height * 0.22;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(0, canvas.height - wmHeight, canvas.width, wmHeight);

        ctx.fillStyle = 'white';
        ctx.textBaseline = 'top';
        const p = 40;
        
        ctx.font = 'bold 38px Inter, sans-serif';
        ctx.fillText(user?.displayName?.toUpperCase() || 'USER', p, canvas.height - wmHeight + 35);
        
        ctx.font = '28px Inter, sans-serif';
        ctx.fillText(`${user?.brandName || ''} • ${user?.division || ''}`, p, canvas.height - wmHeight + 85);
        ctx.fillText(format(new Date(), 'dd MMMM yyyy, HH:mm', { locale: localeId }) + ' WIB', p, canvas.height - wmHeight + 125);
        
        ctx.font = '22px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        const words = address.split(' ');
        let line = '';
        let y = canvas.height - wmHeight + 175;
        for(let n = 0; n < words.length; n++) {
          let test = line + words[n] + ' ';
          if (ctx.measureText(test).width > canvas.width - (p*2)) {
            ctx.fillText(line, p, y);
            line = words[n] + ' ';
            y += 30;
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
    if (!user || !location || submitting || isFinished) return;
    setSubmitting(true);
    try {
      const now = new Date();
      const address = await getAddressFromLatLng(location.lat, location.lng);
      
      let photoUrl = null;
      if (mode === 'photo' && photoBase64) {
        const watermarked = await applyWatermark(photoBase64, address, 'OFFSITE/DINAS');
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
        photoUrl,
        flags: !isInsideRadius ? ['OFFSITE'] : []
      });

      toast({ title: 'Sukses!', description: `Absen ${nextAction} berhasil dicatat.` });
      setShowCamera(false);
    } catch (err: any) {
      toast({ variant: 'destructive', title: 'Gagal', description: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  if (userLoading || loadingSites) {
    return <div className="min-h-svh flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>;
  }

  return (
    <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto relative shadow-2xl border-x">
      <div className="flex-1 overflow-auto pb-20">
        <div className="p-4 flex justify-between items-center bg-white/90 backdrop-blur-md sticky top-0 z-10 border-b">
          <div className="flex items-center gap-3">
            <Avatar className="w-10 h-10 ring-2 ring-primary/5">
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
            {!loadingSites && sites.length === 0 && (
              <Card className="border-destructive/50 bg-destructive/5">
                <CardContent className="pt-6 flex items-center gap-3 text-destructive">
                  <AlertTriangle className="w-5 h-5 shrink-0" />
                  <p className="text-xs font-bold uppercase tracking-tight">
                    Brand kamu belum punya site absensi. Hubungi HRD.
                  </p>
                </CardContent>
              </Card>
            )}

            <Card className="border-none shadow-sm rounded-3xl overflow-hidden bg-white">
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
                    {activeSite?.minGpsAccuracyM && (
                      <p className="text-[8px] opacity-60">Batas: ≤{activeSite.minGpsAccuracyM}m</p>
                    )}
                  </div>
                </div>
                {activeSite && <p className="text-center text-[10px] font-bold text-primary uppercase tracking-tighter">Site: {activeSite.name}</p>}
              </CardContent>
            </Card>

            <div className="flex flex-col items-center gap-8 py-4">
              <button
                onClick={() => handleTap('normal')}
                disabled={!canTapNormal || submitting || isFinished}
                className={`
                  relative w-48 h-48 rounded-full flex flex-col items-center justify-center gap-2 shadow-2xl transition-all active:scale-95
                  ${nextAction === 'IN' ? 'bg-primary text-white' : 'bg-secondary text-white'}
                  ${(isFinished || !canTapNormal) ? 'opacity-30 grayscale cursor-not-allowed' : 'hover:scale-105'}
                  ${submitting ? 'animate-pulse' : ''}
                `}
              >
                {submitting ? <Loader2 className="w-12 h-12 animate-spin" /> : (
                  <>
                    <Clock className="w-10 h-10 mb-1" />
                    <span className="text-2xl font-black uppercase tracking-tighter">TAP {nextAction}</span>
                    <span className="text-[9px] font-bold opacity-70 uppercase">No Photo Mode</span>
                  </>
                )}
              </button>

              {(!canTapNormal && !isFinished && sites.length > 0) && (
                <div className="text-center px-4 space-y-4 animate-in fade-in slide-in-from-bottom-2">
                  <p className="text-xs text-muted-foreground font-medium italic">
                    Anda berada di luar radius atau GPS belum stabil.
                  </p>
                  <Button 
                    onClick={() => setShowCamera(true)} 
                    variant="outline" 
                    className="rounded-full px-8 py-7 h-auto border-primary/20 bg-primary/5 hover:bg-primary/10 gap-3"
                  >
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
                {todayStatus.events.length === 0 ? <p className="text-center text-xs text-muted-foreground py-8 italic">Belum ada aktivitas.</p> :
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
              <h3 className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Log Absensi Terbaru</h3>
              <div className="space-y-3">
                {eventsLoading ? <Loader2 className="w-6 h-6 animate-spin mx-auto opacity-20" /> :
                 sortedEvents.map((ev: any, i: number) => {
                  const dt = ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date();
                  return (
                    <div key={i} className="bg-white p-4 rounded-3xl border shadow-sm">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="text-[10px] font-bold text-muted-foreground mb-0.5">{format(dt, 'EEEE, dd MMM yyyy', { locale: localeId })}</p>
                          <p className="text-xs font-black uppercase tracking-tight">TAP {ev.type} • {ev.siteName}</p>
                        </div>
                        <Badge variant="outline" className="text-[9px] rounded-full px-3">
                          {ev.mode?.toUpperCase() || 'NORMAL'}
                        </Badge>
                      </div>
                      <div className="flex items-start gap-2 mt-2">
                        <MapPin className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />
                        <span className="text-[10px] text-muted-foreground leading-tight">{ev.address || 'Alamat tidak tercatat'}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <Clock className="w-3 h-3 text-muted-foreground" />
                        <span className="text-xs font-bold">{format(dt, 'HH:mm')} WIB</span>
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
