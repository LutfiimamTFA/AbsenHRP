'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { collection, query, where, orderBy, limit, getDoc, doc, serverTimestamp, addDoc, Timestamp } from 'firebase/firestore';
import { getStorage, ref, uploadString, getDownloadURL } from 'firebase/storage';
import { useAuth, useFirestore, useUser, useCollection } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { MapPin, LogOut, CheckCircle2, XCircle, AlertTriangle, Loader2, Info, AlertCircle, History, Clock, RefreshCw, Building2, Camera } from 'lucide-react';
import { useDeviceId } from '@/hooks/use-device-id';
import { useToast } from '@/hooks/use-toast';
import { getDistance } from '@/lib/geo-utils';
import { CameraCapture } from '@/components/camera-capture';
import { format } from 'date-fns';
import { id as localeId } from 'date-fns/locale';

export default function AbsenPage() {
  const { user, loading: userLoading } = useUser();
  const auth = useAuth();
  const db = useFirestore();
  const router = useRouter();
  const { toast } = useToast();
  
  const [authReady, setAuthReady] = useState(false);
  const [location, setLocation] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [prevLocation, setPrevLocation] = useState<{ lat: number; lng: number; ts: number } | null>(null);
  const [zone, setZone] = useState<'onsite' | 'offsite' | 'unknown'>('unknown');
  const [config, setConfig] = useState<any>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [isAnomaly, setIsAnomaly] = useState(false);
  
  const deviceId = useDeviceId();

  useEffect(() => {
    if (!userLoading) {
      setAuthReady(true);
      if (user) {
        if (user.role === 'kandidat') {
          router.push('/unauthorized');
        }
      } else {
        router.push('/login');
      }
    }
  }, [user, userLoading, router]);

  // Load Global Attendance Config
  useEffect(() => {
    const loadConfig = async () => {
      if (!authReady || !user || configLoaded) return;
      try {
        const snap = await getDoc(doc(db, 'attendance_config', 'default'));
        if (snap.exists()) {
          const data = snap.data();
          if (data.office && data.shift) {
            setConfig(data);
          } else {
            setConfigError('Pengaturan kantor/shift belum lengkap di HRP.');
          }
        } else {
          setConfigError('Konfigurasi absensi belum diatur di HRP.');
        }
      } catch (err: any) {
        console.error('Load config error:', err);
        setConfigError('Gagal memuat konfigurasi absensi.');
      } finally {
        setConfigLoaded(true);
      }
    };
    loadConfig();
  }, [authReady, user, db, configLoaded]);

  // Watch Position
  useEffect(() => {
    if (!authReady || !user) return;
    
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const newLat = pos.coords.latitude;
        const newLng = pos.coords.longitude;
        const newAcc = pos.coords.accuracy;
        const now = Date.now();

        // Heuristic Fake GPS detection
        if (prevLocation) {
          const dist = getDistance(prevLocation.lat, prevLocation.lng, newLat, newLng);
          const timeSec = (now - prevLocation.ts) / 1000;
          const speed = dist / (timeSec || 1); 
          if (speed > 500 && timeSec > 1) { // Lebih dari 1800km/jam
            setIsAnomaly(true);
          }
        }

        setLocation({ lat: newLat, lng: newLng, accuracy: newAcc });
        setPrevLocation({ lat: newLat, lng: newLng, ts: now });
      },
      (err) => {
        toast({
          variant: 'destructive',
          title: 'Akses Lokasi Ditolak',
          description: 'Mohon izinkan GPS untuk melakukan absensi.',
        });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [authReady, user, prevLocation, toast]);

  // Determine Zone
  useEffect(() => {
    if (location && config?.office) {
      const dist = getDistance(location.lat, location.lng, config.office.lat, config.office.lng);
      if (location.accuracy > 100) {
        setZone('unknown');
      } else if (dist <= config.office.radiusM) {
        setZone('onsite');
      } else {
        setZone('offsite');
      }
    }
  }, [location, config]);

  // Real-time Personal History
  const historyQuery = useMemo(() => {
    if (!user?.uid) return null;
    return query(
      collection(db, 'attendance_events'),
      where('uid', '==', user.uid),
      orderBy('tsServer', 'desc'),
      limit(20)
    );
  }, [user?.uid, db]);

  const { data: events, loading: eventsLoading } = useCollection(historyQuery);

  const lastEvent = useMemo(() => {
    if (!events || events.length === 0) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = (events[0] as any).tsServer?.toDate() || new Date();
    return eventDate >= today ? (events[0] as any) : null;
  }, [events]);

  const applyWatermark = async (base64: string): Promise<string> => {
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
        
        // Draw Overlay
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(0, canvas.height - 120, canvas.width, 120);

        // Draw Text
        ctx.fillStyle = 'white';
        ctx.font = 'bold 24px Inter, sans-serif';
        const now = new Date();
        const timeStr = format(now, 'HH:mm:ss');
        const dateStr = format(now, 'dd MMM yyyy', { locale: localeId });
        
        ctx.fillText(`${user?.displayName} (${user?.brandName || ''})`, 20, canvas.height - 80);
        ctx.font = '18px Inter, sans-serif';
        ctx.fillText(`${dateStr} - ${timeStr} WIB`, 20, canvas.height - 55);
        ctx.fillText(`Lokasi: ${location?.lat.toFixed(5)}, ${location?.lng.toFixed(5)} (${zone.toUpperCase()})`, 20, canvas.height - 30);
        
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
    });
  };

  const handleTap = async (photoBase64?: string) => {
    if (!user || !location || submitting || !config) return;

    if (location.accuracy > 100) {
      toast({
        variant: 'destructive',
        title: 'Akurasi GPS Rendah',
        description: 'Mohon refresh lokasi atau pindah ke area terbuka.',
      });
      return;
    }

    // Check if photo is required
    const requiresPhoto = zone === 'offsite' || isAnomaly;
    if (requiresPhoto && !photoBase64) {
      setShowCamera(true);
      return;
    }

    setSubmitting(true);
    try {
      let photoUrl = '';
      if (photoBase64) {
        const watermarked = await applyWatermark(photoBase64);
        const storage = getStorage();
        const path = `attendance/${user.uid}/${Date.now()}.jpg`;
        const storageRef = ref(storage, path);
        await uploadString(storageRef, watermarked, 'data_url');
        photoUrl = await getDownloadURL(storageRef);
      }

      const type = lastEvent?.type === 'IN' ? 'OUT' : 'IN';
      const now = new Date();
      const dist = getDistance(location.lat, location.lng, config.office.lat, config.office.lng);

      // Simple status flags
      const flags = [];
      if (zone === 'offsite') flags.push('OFFSITE');
      if (isAnomaly) flags.push('ANOMALY');
      if (location.accuracy > 80) flags.push('LOW_ACCURACY');

      await addDoc(collection(db, 'attendance_events'), {
        uid: user.uid,
        displayName: user.displayName,
        type,
        tsClient: now.toISOString(),
        tsServer: serverTimestamp(),
        location: { lat: location.lat, lng: location.lng },
        accuracyM: location.accuracy,
        distanceM: dist,
        deviceId,
        mode: zone.toUpperCase(),
        photoUrl,
        flags
      });

      toast({
        title: 'Absensi Berhasil!',
        description: `Berhasil melakukan TAP ${type}.`,
      });
      setShowCamera(false);
    } catch (err: any) {
      console.error('Tap error:', err);
      toast({
        variant: 'destructive',
        title: 'Gagal Absen',
        description: 'Terjadi kesalahan sistem. (Code: ' + (err.code || 'unknown') + ')',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (userLoading || !authReady) {
    return (
      <div className="min-h-svh flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const type = lastEvent?.type === 'IN' ? 'OUT' : 'IN';

  return (
    <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto relative overflow-hidden">
      <div className="p-6">
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-3">
            <Avatar className="w-12 h-12 border-2 border-white shadow-sm">
              <AvatarFallback className="bg-primary text-white">
                {user?.displayName?.[0] || 'U'}
              </AvatarFallback>
            </Avatar>
            <div>
              <h1 className="font-bold text-lg leading-tight">{user?.displayName}</h1>
              <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">
                {user?.brandName} • {user?.roleLabel}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => signOut(auth)} className="rounded-full">
            <LogOut className="w-5 h-5" />
          </Button>
        </div>

        {configError ? (
          <Card className="border-none shadow-xl bg-white p-8 text-center rounded-3xl">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
            <h2 className="font-bold mb-2">Masalah Konfigurasi</h2>
            <p className="text-sm text-muted-foreground mb-6">{configError}</p>
            <Button onClick={() => window.location.reload()} className="w-full rounded-2xl">
              <RefreshCw className="w-4 h-4 mr-2" /> Muat Ulang
            </Button>
          </Card>
        ) : (
          <div className="space-y-6">
            <Card className="border-none shadow-2xl rounded-[2.5rem] bg-white overflow-hidden">
              <CardContent className="pt-8 pb-10 flex flex-col items-center text-center">
                <div className="mb-8">
                  {location ? (
                    zone === 'unknown' ? (
                      <Badge variant="outline" className="px-5 py-2 rounded-full text-orange-500 border-orange-200 gap-2">
                        <AlertTriangle className="w-4 h-4" /> GPS BELUM AKURAT
                      </Badge>
                    ) : (
                      <Badge variant={zone === 'onsite' ? 'default' : 'secondary'} className="px-5 py-2 rounded-full gap-2">
                        {zone === 'onsite' ? <CheckCircle2 className="w-4 h-4" /> : <MapPin className="w-4 h-4" />}
                        ZONA {zone.toUpperCase()}
                      </Badge>
                    )
                  ) : (
                    <Badge variant="outline" className="animate-pulse px-5 py-2 rounded-full">
                      MENCARI LOKASI...
                    </Badge>
                  )}
                </div>

                <button
                  onClick={() => handleTap()}
                  disabled={!location || submitting || zone === 'unknown' || lastEvent?.type === 'OUT' && format(lastEvent.tsServer.toDate(), 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd')}
                  className={`
                    relative w-48 h-48 rounded-full flex flex-col items-center justify-center gap-1 shadow-2xl transition-all active:scale-95
                    ${type === 'IN' ? 'bg-primary text-white' : 'bg-secondary text-white'}
                    ${(!location || submitting || zone === 'unknown') ? 'opacity-50 grayscale' : ''}
                  `}
                >
                  {submitting ? (
                    <Loader2 className="w-12 h-12 animate-spin" />
                  ) : (
                    <>
                      <span className="text-3xl font-black uppercase tracking-tighter">TAP {type}</span>
                      <span className="text-[10px] font-bold opacity-80">Tekan Sekali</span>
                    </>
                  )}
                </button>

                <div className="mt-8 w-full grid grid-cols-2 gap-4">
                  <div className="p-4 bg-muted/40 rounded-3xl border border-white text-left">
                    <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1">Status</p>
                    <p className="font-bold text-sm truncate">
                      {zone === 'onsite' ? 'Dalam Kantor' : zone === 'offsite' ? 'Luar Jangkauan' : 'GPS Lemah'}
                    </p>
                  </div>
                  <div className="p-4 bg-muted/40 rounded-3xl border border-white text-left">
                    <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1">Akurasi</p>
                    <p className="font-bold text-sm flex items-center gap-2">
                      {location ? `${location.accuracy.toFixed(0)}m` : '--'}
                      {location && location.accuracy > 80 && <AlertTriangle className="w-4 h-4 text-orange-500" />}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="bg-primary/5 p-4 rounded-2xl flex items-start gap-3 border border-primary/10">
              <Info className="w-5 h-5 text-primary shrink-0" />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Web ini khusus absensi & riwayat pribadi. Monitoring HRD dilakukan terpisah melalui sistem HRP.
              </p>
            </div>

            <div className="space-y-4 pb-10">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-muted-foreground" />
                <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Riwayat Pribadi</h2>
              </div>
              
              <div className="space-y-3">
                {eventsLoading ? (
                  <div className="text-center p-8"><Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /></div>
                ) : events?.map((ev: any, i: number) => (
                  <div key={i} className="bg-white p-4 rounded-2xl border border-white shadow-sm flex justify-between items-center">
                    <div className="flex items-center gap-4">
                      <div className={`p-2 rounded-xl ${ev.type === 'IN' ? 'bg-primary/10 text-primary' : 'bg-secondary/10 text-secondary'}`}>
                        <Clock className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-bold text-sm uppercase">TAP {ev.type}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {ev.tsServer ? format(ev.tsServer.toDate(), 'eeee, d MMM', { locale: localeId }) : 'Memproses...'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-black text-lg">
                        {ev.tsServer ? format(ev.tsServer.toDate(), 'HH:mm') : '--:--'}
                      </p>
                      <Badge variant="outline" className="text-[8px] h-4 py-0 border-none bg-muted/50">
                        {ev.mode}
                      </Badge>
                    </div>
                  </div>
                ))}
                {(!events || events.length === 0) && !eventsLoading && (
                  <div className="text-center p-8 border-2 border-dashed rounded-3xl opacity-50">
                    <p className="text-sm italic">Belum ada riwayat.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {showCamera && (
        <CameraCapture
          onCapture={(base64) => handleTap(base64)}
          onCancel={() => setShowCamera(false)}
        />
      )}
    </div>
  );
}