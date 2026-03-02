'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { collection, query, where, limit, getDoc, doc, serverTimestamp, addDoc, Timestamp } from 'firebase/firestore';
import { getStorage, ref, uploadString, getDownloadURL } from 'firebase/storage';
import { useAuth, useFirestore, useUser, useCollection } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { MapPin, LogOut, CheckCircle2, AlertTriangle, Loader2, Info, AlertCircle, RefreshCw, Clock, History, Camera } from 'lucide-react';
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
  const [anomalyFlags, setAnomalyFlags] = useState<string[]>([]);
  
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

  useEffect(() => {
    const loadConfig = async () => {
      if (!authReady || !user || configLoaded) return;
      try {
        const configDocRef = doc(db, 'attendance_config', 'default');
        const snap = await getDoc(configDocRef);
        
        if (snap.exists()) {
          const data = snap.data();
          if (data.office && data.shift) {
            setConfig(data);
          } else {
            setConfigError('Pengaturan kantor belum lengkap di HRP.');
          }
        } else {
          setConfigError('Konfigurasi absensi belum diatur di HRP.');
        }
      } catch (err: any) {
        console.error('Load config error:', err);
        setConfigError(`Gagal memuat konfigurasi: ${err.message || 'Error tidak dikenal'}`);
      } finally {
        setConfigLoaded(true);
      }
    };
    loadConfig();
  }, [authReady, user, db, configLoaded]);

  const refreshLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const newLat = pos.coords.latitude;
        const newLng = pos.coords.longitude;
        const newAcc = pos.coords.accuracy;
        const now = Date.now();

        const currentFlags: string[] = [];
        if (prevLocation) {
          const dist = getDistance(prevLocation.lat, prevLocation.lng, newLat, newLng);
          const timeSec = (now - prevLocation.ts) / 1000;
          const speed = dist / (timeSec || 1); 
          if (speed > 500 && timeSec > 5) {
            currentFlags.push('location_jump');
          }
        }
        
        setAnomalyFlags(currentFlags);
        setIsAnomaly(currentFlags.length > 0 || newAcc > 75);
        setLocation({ lat: newLat, lng: newLng, accuracy: newAcc });
        setPrevLocation({ lat: newLat, lng: newLng, ts: now });
      },
      (err) => {
        toast({
          variant: 'destructive',
          title: 'Gagal Refresh Lokasi',
          description: 'Mohon izinkan akses GPS di pengaturan browser.',
        });
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  useEffect(() => {
    if (authReady && user) {
      refreshLocation();
    }
  }, [authReady, user]);

  useEffect(() => {
    if (location && config?.office) {
      const dist = getDistance(location.lat, location.lng, config.office.lat, config.office.lng);
      if (location.accuracy > 150) {
        setZone('unknown');
      } else if (dist <= config.office.radiusM) {
        setZone('onsite');
      } else {
        setZone('offsite');
      }
    }
  }, [location, config]);

  const historyQuery = useMemo(() => {
    if (!user?.uid) return null;
    return query(
      collection(db, 'attendance_events'),
      where('uid', '==', user.uid),
      limit(50)
    );
  }, [user?.uid, db]);

  const { data: rawEvents, error: historyError, loading: eventsLoading } = useCollection(historyQuery);

  const sortedEvents = useMemo(() => {
    if (!rawEvents) return [];
    return [...rawEvents].sort((a: any, b: any) => {
      const timeA = a.tsClient instanceof Timestamp ? a.tsClient.toMillis() : new Date(a.tsClient).getTime();
      const timeB = b.tsClient instanceof Timestamp ? b.tsClient.toMillis() : new Date(b.tsClient).getTime();
      return timeB - timeA;
    });
  }, [rawEvents]);

  const lastEvent = useMemo(() => {
    if (!sortedEvents || sortedEvents.length === 0) return null;
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    const todayEvents = sortedEvents.filter((ev: any) => {
      const date = ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date(ev.tsClient);
      return format(date, 'yyyy-MM-dd') === todayStr;
    });
    return todayEvents.length > 0 ? todayEvents[0] : null;
  }, [sortedEvents]);

  const checkShiftFlags = (type: 'tap_in' | 'tap_out', time: Date) => {
    if (!config?.shift) return [];
    const flags: string[] = [];
    
    try {
      const [startH, startM] = config.shift.startTime.split(':').map(Number);
      const [endH, endM] = config.shift.endTime.split(':').map(Number);
      const grace = config.shift.graceLateMinutes || 0;

      const currentTotal = time.getHours() * 60 + time.getMinutes();
      
      if (type === 'tap_in') {
        const startTotal = (startH * 60) + startM;
        if (currentTotal > (startTotal + grace)) {
          flags.push('TERLAMBAT');
        }
      } else if (type === 'tap_out') {
        const endTotal = (endH * 60) + endM;
        if (currentTotal < endTotal) {
          flags.push('PULANG_CEPAT');
        } else if (currentTotal > endTotal) {
          flags.push('LEMBUR');
        }
      }
    } catch (e) {
      console.error('Error checking shift flags:', e);
    }
    
    return flags;
  };

  const applyWatermark = async (base64: string, statusText: string): Promise<string> => {
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
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, canvas.height - 200, canvas.width, 200);

        ctx.fillStyle = 'white';
        const now = new Date();
        const timeStr = format(now, 'HH:mm:ss');
        const dateStr = format(now, 'dd MMM yyyy', { locale: localeId });
        
        ctx.font = 'bold 36px Inter, sans-serif';
        ctx.fillText(`${user?.displayName || 'Karyawan'}`, 40, canvas.height - 140);
        
        ctx.font = '26px Inter, sans-serif';
        ctx.fillText(`${user?.brandName || ''} • ${user?.division || ''}`, 40, canvas.height - 100);
        ctx.fillText(`${dateStr} - ${timeStr} WIB`, 40, canvas.height - 65);
        ctx.fillText(`GPS: ${location?.lat.toFixed(6)}, ${location?.lng.toFixed(6)} (±${location?.accuracy.toFixed(0)}m)`, 40, canvas.height - 30);
        
        ctx.font = 'bold 32px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(statusText.toUpperCase(), canvas.width - 40, canvas.height - 30);
        
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
    });
  };

  const handleTap = async (photoBase64?: string) => {
    if (!user || !location || submitting || !config) return;

    const requiresPhoto = zone === 'offsite' || location.accuracy > 80 || isAnomaly;
    if (requiresPhoto && !photoBase64) {
      setShowCamera(true);
      return;
    }

    setSubmitting(true);
    try {
      const type = lastEvent?.type === 'tap_in' ? 'tap_out' : 'tap_in';
      const now = new Date();
      
      const shiftFlags = checkShiftFlags(type, now);
      
      let photoUrl = '';
      if (photoBase64) {
        const statusLabel = `${type.replace('_',' ')} - ${zone} ${shiftFlags.join(' ')}`;
        const watermarked = await applyWatermark(photoBase64, statusLabel);
        const storage = getStorage();
        const path = `attendance/${user.uid}/${Date.now()}.jpg`;
        const storageRef = ref(storage, path);
        await uploadString(storageRef, watermarked, 'data_url');
        photoUrl = await getDownloadURL(storageRef);
      }

      const finalFlags = [...anomalyFlags, ...shiftFlags];
      if (zone === 'offsite') finalFlags.push('OFFSITE');
      if (location.accuracy > 80) finalFlags.push('LOW_ACCURACY');

      await addDoc(collection(db, 'attendance_events'), {
        uid: user.uid,
        displayName: user.displayName || 'Karyawan',
        brandId: user.brandId || '',
        division: user.division || '',
        type,
        tsClient: Timestamp.fromDate(now),
        tsServer: serverTimestamp(),
        location: { lat: location.lat, lng: location.lng },
        accuracyM: location.accuracy,
        isOnsite: zone === 'onsite',
        deviceId: deviceId || 'unknown',
        mode: zone.toUpperCase(),
        photoUrl: photoUrl || null,
        flags: finalFlags
      });

      toast({
        title: 'Berhasil!',
        description: `Absen ${type === 'tap_in' ? 'Masuk' : 'Keluar'} berhasil dicatat.`,
      });
      setShowCamera(false);
      refreshLocation();
    } catch (err: any) {
      console.error('Tap error:', err);
      toast({
        variant: 'destructive',
        title: 'Gagal Absen',
        description: `Error: ${err.message || 'Izin ditolak atau masalah koneksi.'}`,
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

  const type = lastEvent?.type === 'tap_in' ? 'tap_out' : 'tap_in';
  const isFinished = lastEvent?.type === 'tap_out';

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
                {user?.brandName} • {user?.division} • {user?.roleLabel}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => signOut(auth)} className="rounded-full">
            <LogOut className="w-5 h-5" />
          </Button>
        </div>

        <div className="bg-muted/50 p-3 rounded-xl flex items-center justify-between mb-6 border border-white/20">
          <p className="text-[11px] text-muted-foreground italic">
            Login: <span className="font-bold text-primary">{user?.displayName}</span> ({user?.brandName})
          </p>
          <Badge variant="outline" className="text-[8px] bg-white">ABSENSI PRIBADI</Badge>
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
                <div className="mb-8 flex flex-wrap justify-center gap-2">
                  {location ? (
                    <>
                      {location.accuracy > 75 ? (
                        <Badge variant="outline" className="px-5 py-2 rounded-full text-orange-500 border-orange-200 gap-2">
                          <AlertTriangle className="w-4 h-4" /> GPS BELUM AKURAT
                        </Badge>
                      ) : (
                        <Badge variant={zone === 'onsite' ? 'default' : 'secondary'} className="px-5 py-2 rounded-full gap-2">
                          {zone === 'onsite' ? <CheckCircle2 className="w-4 h-4" /> : <MapPin className="w-4 h-4" />}
                          ZONA {zone.toUpperCase()}
                        </Badge>
                      )}
                    </>
                  ) : (
                    <Badge variant="outline" className="animate-pulse px-5 py-2 rounded-full">
                      MENCARI LOKASI...
                    </Badge>
                  )}
                </div>

                <button
                  onClick={() => handleTap()}
                  disabled={!location || submitting || isFinished}
                  className={`
                    relative w-48 h-48 rounded-full flex flex-col items-center justify-center gap-1 shadow-2xl transition-all active:scale-95
                    ${type === 'tap_in' ? 'bg-primary text-white' : 'bg-secondary text-white'}
                    ${(!location || submitting || isFinished) ? 'opacity-50 grayscale' : ''}
                  `}
                >
                  {submitting ? (
                    <Loader2 className="w-12 h-12 animate-spin" />
                  ) : (
                    <>
                      <span className="text-3xl font-black uppercase tracking-tighter">
                        {isFinished ? 'SELESAI' : `TAP ${type.replace('_',' ').toUpperCase()}`}
                      </span>
                      <span className="text-[10px] font-bold opacity-80">
                        {isFinished ? 'Besok lagi ya!' : 'Tekan Sekali'}
                      </span>
                    </>
                  )}
                </button>

                <div className="mt-8 w-full grid grid-cols-2 gap-4">
                  <div className="p-4 bg-muted/40 rounded-3xl border border-white text-left">
                    <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1">Status Lokasi</p>
                    <p className="font-bold text-sm truncate">
                      {zone === 'onsite' ? 'Dalam Kantor' : zone === 'offsite' ? 'Luar Kantor' : 'GPS Lemah'}
                    </p>
                  </div>
                  <div className="p-4 bg-muted/40 rounded-3xl border border-white text-left">
                    <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1">Akurasi GPS</p>
                    <p className="font-bold text-sm flex items-center justify-between gap-2">
                      {location ? `±${location.accuracy.toFixed(0)}m` : '--'}
                      <button onClick={refreshLocation} className="p-1 hover:bg-white/50 rounded-full transition-colors">
                        <RefreshCw className="w-3 h-3 text-primary" />
                      </button>
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="bg-primary/5 p-4 rounded-2xl flex items-start gap-3 border border-primary/10">
              <Info className="w-5 h-5 text-primary shrink-0" />
              <div className="text-[11px] text-muted-foreground leading-relaxed">
                <p>Radius Area Kantor: <span className="font-bold">{config?.office?.radiusM || 150}m</span>.</p>
                <p className="font-bold text-primary underline">Wajib foto jika di luar area atau sinyal GPS lemah ({'>'}80m).</p>
              </div>
            </div>

            <div className="space-y-4 pb-10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <History className="w-4 h-4 text-muted-foreground" />
                  <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Riwayat Hari Ini</h2>
                </div>
              </div>
              
              <div className="space-y-3">
                {eventsLoading ? (
                  <div className="text-center p-8">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
                    <p className="text-[10px] mt-2 text-muted-foreground">Memuat data...</p>
                  </div>
                ) : historyError ? (
                  <div className="text-center p-8 bg-red-50 rounded-2xl border border-red-100">
                    <AlertCircle className="w-6 h-6 text-red-500 mx-auto mb-2" />
                    <p className="text-xs text-red-600 font-medium">Gagal memuat riwayat.</p>
                    <p className="text-[9px] text-red-400 mt-1">Pastikan koneksi internet stabil.</p>
                  </div>
                ) : sortedEvents?.map((ev: any, i: number) => {
                  const eventDate = ev.tsClient instanceof Timestamp ? ev.tsClient.toDate() : new Date(ev.tsClient);
                  
                  let isLate = ev.flags?.includes('TERLAMBAT');
                  let isEarly = ev.flags?.includes('PULANG_CEPAT');
                  let isOT = ev.flags?.includes('LEMBUR');

                  if (ev.type === 'tap_in' && !isLate && config?.shift) {
                    try {
                      const [sh, sm] = config.shift.startTime.split(':').map(Number);
                      const grace = config.shift.graceLateMinutes || 0;
                      const limit = (sh * 60) + sm + grace;
                      const current = (eventDate.getHours() * 60) + eventDate.getMinutes();
                      if (current > limit) isLate = true;
                    } catch(e) {}
                  }

                  return (
                    <div key={i} className="bg-white p-4 rounded-2xl border border-white shadow-sm flex justify-between items-center transition-all hover:shadow-md">
                      <div className="flex items-center gap-4">
                        <div className={`p-2 rounded-xl ${ev.type === 'tap_in' ? 'bg-primary/10 text-primary' : 'bg-secondary/10 text-secondary'}`}>
                          <Clock className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="font-bold text-sm uppercase">TAP {ev.type === 'tap_in' ? 'MASUK' : 'KELUAR'}</p>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {isLate && <Badge variant="destructive" className="text-[8px] h-4">TERLAMBAT</Badge>}
                            {isEarly && <Badge variant="secondary" className="text-[8px] h-4 bg-orange-500 text-white border-none">PULANG CEPAT</Badge>}
                            {isOT && <Badge variant="default" className="text-[8px] h-4 bg-green-600 border-none">LEMBUR</Badge>}
                            {!isLate && !isEarly && !isOT && <Badge variant="outline" className="text-[8px] h-4 border-green-200 text-green-600">TEPAT WAKTU</Badge>}
                          </div>
                        </div>
                      </div>
                      <div className="text-right flex flex-col items-end gap-1">
                        <p className="font-black text-lg">
                          {format(eventDate, 'HH:mm')}
                        </p>
                        <div className="flex gap-1">
                          <Badge variant="outline" className={`text-[8px] h-4 py-0 border-none ${ev.isOnsite ? 'bg-green-50 text-green-700' : 'bg-orange-50 text-orange-700'}`}>
                            {ev.mode}
                          </Badge>
                          {ev.photoUrl && <Camera className="w-3 h-3 text-muted-foreground" />}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {(!sortedEvents || sortedEvents.length === 0) && !eventsLoading && !historyError && (
                  <div className="text-center p-8 border-2 border-dashed rounded-3xl opacity-50">
                    <History className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
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
