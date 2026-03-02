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
import { MapPin, LogOut, CheckCircle2, XCircle, AlertTriangle, Loader2, Info, AlertCircle, History, Clock, RefreshCw, Building2, Camera, Map } from 'lucide-react';
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
            setConfigError('Pengaturan kantor belum lengkap di HRP.');
          }
        } else {
          setConfigError('Konfigurasi absensi belum diatur di HRP.');
        }
      } catch (err: any) {
        console.error('Load config error:', err);
        setConfigError('Gagal memuat konfigurasi. Pastikan Anda memiliki akses.');
      } finally {
        setConfigLoaded(true);
      }
    };
    loadConfig();
  }, [authReady, user, db, configLoaded]);

  // Watch/Refresh Position
  const refreshLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const newLat = pos.coords.latitude;
        const newLng = pos.coords.longitude;
        const newAcc = pos.coords.accuracy;
        const now = Date.now();

        // Heuristic Anomaly Detection
        const currentFlags: string[] = [];
        if (prevLocation) {
          const dist = getDistance(prevLocation.lat, prevLocation.lng, newLat, newLng);
          const timeSec = (now - prevLocation.ts) / 1000;
          const speed = dist / (timeSec || 1); 
          if (speed > 500 && timeSec > 5) { // Faster than 1800km/h
            currentFlags.push('location_jump');
          }
          if (dist === 0 && timeSec > 30) {
            currentFlags.push('static_location');
          }
        }
        
        setAnomalyFlags(currentFlags);
        setIsAnomaly(currentFlags.length > 0);
        setLocation({ lat: newLat, lng: newLng, accuracy: newAcc });
        setPrevLocation({ lat: newLat, lng: newLng, ts: now });
      },
      (err) => {
        toast({
          variant: 'destructive',
          title: 'Gagal Refresh Lokasi',
          description: 'Mohon izinkan GPS untuk melakukan absensi.',
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
      orderBy('tsClient', 'desc'),
      limit(20)
    );
  }, [user?.uid, db]);

  const { data: events, error: historyError, loading: eventsLoading } = useCollection(historyQuery);

  const lastEvent = useMemo(() => {
    if (!events || events.length === 0) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = (events[0] as any).tsClient?.toDate() || new Date();
    return eventDate >= today ? (events[0] as any) : null;
  }, [events]);

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
        
        // Draw Overlay
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, canvas.height - 180, canvas.width, 180);

        // Draw Text
        ctx.fillStyle = 'white';
        const now = new Date();
        const timeStr = format(now, 'HH:mm:ss');
        const dateStr = format(now, 'dd MMM yyyy', { locale: localeId });
        
        ctx.font = 'bold 32px Inter, sans-serif';
        ctx.fillText(`${user?.displayName || 'User'}`, 30, canvas.height - 130);
        
        ctx.font = '24px Inter, sans-serif';
        ctx.fillText(`${user?.brandName || ''} • ${user?.division || ''}`, 30, canvas.height - 95);
        ctx.fillText(`${dateStr} - ${timeStr} WIB`, 30, canvas.height - 65);
        
        ctx.font = 'italic 20px Inter, sans-serif';
        ctx.fillText(`Lokasi: ${location?.lat.toFixed(6)}, ${location?.lng.toFixed(6)} (Acc: ${location?.accuracy.toFixed(0)}m)`, 30, canvas.height - 35);
        
        ctx.font = 'bold 28px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(statusText.toUpperCase(), canvas.width - 30, canvas.height - 35);
        
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
    });
  };

  const handleTap = async (photoBase64?: string) => {
    if (!user || !location || submitting || !config) return;

    // Strict requirements
    const requiresPhoto = zone === 'offsite' || location.accuracy > 100 || isAnomaly;
    if (requiresPhoto && !photoBase64) {
      setShowCamera(true);
      return;
    }

    setSubmitting(true);
    try {
      const type = lastEvent?.type === 'tap_in' ? 'tap_out' : 'tap_in';
      const now = new Date();
      const dist = getDistance(location.lat, location.lng, config.office.lat, config.office.lng);
      
      let photoUrl = '';
      if (photoBase64) {
        const statusLabel = `${type.replace('_',' ')} - ${zone}`;
        const watermarked = await applyWatermark(photoBase64, statusLabel);
        const storage = getStorage();
        const path = `attendance/${user.uid}/${Date.now()}.jpg`;
        const storageRef = ref(storage, path);
        await uploadString(storageRef, watermarked, 'data_url');
        photoUrl = await getDownloadURL(storageRef);
      }

      // Flags
      const flags = [...anomalyFlags];
      if (zone === 'offsite') flags.push('OFFSITE');
      if (location.accuracy > 80) flags.push('LOW_ACCURACY');

      await addDoc(collection(db, 'attendance_events'), {
        uid: user.uid,
        displayName: user.displayName,
        type,
        tsClient: Timestamp.fromDate(now),
        tsServer: serverTimestamp(),
        location: { lat: location.lat, lng: location.lng },
        accuracyM: location.accuracy,
        distanceM: dist,
        isOnsite: zone === 'onsite',
        deviceId,
        mode: zone.toUpperCase(),
        photoUrl,
        flags
      });

      toast({
        title: 'Berhasil!',
        description: `TAP ${type === 'tap_in' ? 'Masuk' : 'Keluar'} berhasil dicatat.`,
      });
      setShowCamera(false);
    } catch (err: any) {
      console.error('Tap error:', err);
      toast({
        variant: 'destructive',
        title: 'Gagal Absen',
        description: err.code === 'permission-denied' 
          ? 'Izin ditolak. Hubungi admin untuk akses Firestore.' 
          : 'Terjadi kesalahan sistem. Coba lagi.',
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
  const isFinished = lastEvent?.type === 'tap_out' && format(lastEvent.tsClient.toDate(), 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');

  return (
    <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto relative overflow-hidden">
      {/* Header Identitas */}
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

        {/* Banner Konfirmasi Login */}
        <div className="bg-muted/50 p-3 rounded-xl flex items-center justify-between mb-6 border border-white/20">
          <p className="text-[11px] text-muted-foreground italic">
            Login sebagai: <span className="font-bold text-primary">{user?.displayName}</span>
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
                      {zone === 'unknown' ? (
                        <Badge variant="outline" className="px-5 py-2 rounded-full text-orange-500 border-orange-200 gap-2">
                          <AlertTriangle className="w-4 h-4" /> GPS LEMAH
                        </Badge>
                      ) : (
                        <Badge variant={zone === 'onsite' ? 'default' : 'secondary'} className="px-5 py-2 rounded-full gap-2">
                          {zone === 'onsite' ? <CheckCircle2 className="w-4 h-4" /> : <MapPin className="w-4 h-4" />}
                          ZONA {zone.toUpperCase()}
                        </Badge>
                      )}
                      {isAnomaly && (
                        <Badge variant="destructive" className="px-5 py-2 rounded-full gap-2">
                          <AlertCircle className="w-4 h-4" /> ANOMALI LOKASI
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
                  disabled={!location || submitting || zone === 'unknown' || isFinished}
                  className={`
                    relative w-48 h-48 rounded-full flex flex-col items-center justify-center gap-1 shadow-2xl transition-all active:scale-95
                    ${type === 'tap_in' ? 'bg-primary text-white' : 'bg-secondary text-white'}
                    ${(!location || submitting || zone === 'unknown' || isFinished) ? 'opacity-50 grayscale' : ''}
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

                {/* Debug Info (Dev Mode) */}
                {process.env.NODE_ENV !== 'production' && config?.office && (
                  <div className="mt-4 p-2 bg-slate-100 rounded text-[9px] font-mono text-left w-full">
                    <p>Office: {config.office.lat}, {config.office.lng} (R:{config.office.radiusM})</p>
                    <p>User: {location?.lat}, {location?.lng} (Acc:{location?.accuracy.toFixed(1)}m)</p>
                    <p>Dist: {location ? getDistance(location.lat, location.lng, config.office.lat, config.office.lng).toFixed(1) : '-'}m</p>
                  </div>
                )}

                <div className="mt-8 w-full grid grid-cols-2 gap-4">
                  <div className="p-4 bg-muted/40 rounded-3xl border border-white text-left">
                    <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1">Status</p>
                    <p className="font-bold text-sm truncate">
                      {zone === 'onsite' ? 'Dalam Kantor' : zone === 'offsite' ? 'Luar Jangkauan' : 'GPS Lemah'}
                    </p>
                  </div>
                  <div className="p-4 bg-muted/40 rounded-3xl border border-white text-left relative overflow-hidden group">
                    <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1">Akurasi</p>
                    <p className="font-bold text-sm flex items-center justify-between gap-2">
                      {location ? `${location.accuracy.toFixed(0)}m` : '--'}
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
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Web ini khusus absensi & riwayat pribadi. Monitoring dilakukan di portal HRP. 
                <span className="font-bold text-primary ml-1 underline">Wajib foto jika di luar kantor atau GPS tidak akurat.</span>
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
                ) : historyError ? (
                  <div className="text-center p-8 bg-red-50 rounded-2xl border border-red-100">
                    <p className="text-xs text-red-600 font-medium">Riwayat tidak dapat dimuat. Pastikan Anda login dan aturan Firestore sudah benar.</p>
                  </div>
                ) : events?.map((ev: any, i: number) => (
                  <div key={i} className="bg-white p-4 rounded-2xl border border-white shadow-sm flex justify-between items-center transition-all hover:shadow-md">
                    <div className="flex items-center gap-4">
                      <div className={`p-2 rounded-xl ${ev.type === 'tap_in' ? 'bg-primary/10 text-primary' : 'bg-secondary/10 text-secondary'}`}>
                        <Clock className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-bold text-sm uppercase">TAP {ev.type === 'tap_in' ? 'MASUK' : 'KELUAR'}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {ev.tsClient ? format(ev.tsClient.toDate(), 'eeee, d MMM', { locale: localeId }) : 'Memproses...'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right flex flex-col items-end gap-1">
                      <p className="font-black text-lg">
                        {ev.tsClient ? format(ev.tsClient.toDate(), 'HH:mm') : '--:--'}
                      </p>
                      <div className="flex gap-1">
                        <Badge variant="outline" className={`text-[8px] h-4 py-0 border-none ${ev.isOnsite ? 'bg-green-50 text-green-700' : 'bg-orange-50 text-orange-700'}`}>
                          {ev.mode}
                        </Badge>
                        {ev.photoUrl && <Camera className="w-3 h-3 text-muted-foreground" />}
                      </div>
                    </div>
                  </div>
                ))}
                {(!events || events.length === 0) && !eventsLoading && (
                  <div className="text-center p-8 border-2 border-dashed rounded-3xl opacity-50">
                    <p className="text-sm italic">Belum ada riwayat hari ini.</p>
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
