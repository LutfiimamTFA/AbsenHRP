'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
import { httpsCallable, getFunctions } from 'firebase/functions';
import { useAuth, useFirestore, useUser, useCollection } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MapPin, User as UserIcon, LogOut, CheckCircle2, XCircle, AlertTriangle, Loader2, Info, AlertCircle, History, Clock } from 'lucide-react';
import { useDeviceId } from '@/hooks/use-device-id';
import { useToast } from '@/hooks/use-toast';
import { getDistance } from '@/lib/geo-utils';
import { CameraCapture } from '@/components/camera-capture';
import { format } from 'date-fns';
import { id } from 'date-fns/locale';

export default function AbsenPage() {
  const { user, loading: userLoading } = useUser();
  const auth = useAuth();
  const db = useFirestore();
  const router = useRouter();
  const { toast } = useToast();
  
  const [authReady, setAuthReady] = useState(false);
  const [internalReady, setInternalReady] = useState(false);
  const [isInternalUser, setIsInternalUser] = useState(false);

  const [location, setLocation] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [isWithinRadius, setIsWithinRadius] = useState(false);
  const [workLocation, setWorkLocation] = useState<any>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [geofenceChecked, setGeofenceChecked] = useState(false);
  const [geofenceError, setGeofenceError] = useState<string | null>(null);
  
  const deviceId = useDeviceId();

  // Guard: Verifikasi Auth dan Role Internal
  useEffect(() => {
    if (!userLoading) {
      setAuthReady(true);
      if (user) {
        if (user.isInternal && user.role !== 'kandidat') {
          setIsInternalUser(true);
          setInternalReady(true);
        } else {
          router.push('/unauthorized');
        }
      } else {
        router.push('/login');
      }
    }
  }, [user, userLoading, router]);

  // Query Riwayat Pribadi: WAJIB filter UID dan urutkan tsServer desc
  const personalHistoryQuery = useMemo(() => {
    if (!authReady || !internalReady || !isInternalUser || !user) return null;
    return query(
      collection(db, 'attendance_events'),
      where('uid', '==', user.uid),
      orderBy('tsServer', 'desc'),
      limit(10)
    );
  }, [authReady, internalReady, isInternalUser, user, db]);

  const { data: events, loading: eventsLoading } = useCollection(personalHistoryQuery);
  
  const lastEvent = useMemo(() => {
    if (!events || events.length === 0) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = events[0].tsServer?.toDate() || new Date();
    return eventDate >= today ? events[0] : null;
  }, [events]);

  // Pantau Lokasi Real-time
  useEffect(() => {
    if (!authReady || !internalReady || !isInternalUser) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => {
        console.warn('Geolocation error:', err);
        toast({
          variant: 'destructive',
          title: 'Gagal Akses GPS',
          description: 'Mohon izinkan akses lokasi untuk melakukan absensi.',
        });
      },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [authReady, internalReady, isInternalUser, toast]);

  // Cek Geofence: Hanya ambil lokasi kantor jika user sudah terverifikasi
  useEffect(() => {
    const checkGeofence = async () => {
      if (!authReady || !internalReady || !isInternalUser || !location || geofenceChecked) return;
      
      try {
        const locationsSnap = await getDocs(collection(db, 'work_locations'));
        
        if (locationsSnap.empty) {
          setGeofenceError('Lokasi kantor belum diatur. Hubungi Admin/HRD.');
          setGeofenceChecked(true);
          return;
        }

        let nearest: any = null;
        let minDistance = Infinity;

        locationsSnap.forEach((doc) => {
          const data = doc.data();
          const dist = getDistance(location.lat, location.lng, data.center.lat, data.center.lng);
          if (dist < minDistance) {
            minDistance = dist;
            nearest = data;
          }
        });

        if (nearest) {
          setWorkLocation(nearest);
          setIsWithinRadius(minDistance <= nearest.radiusM);
          setGeofenceChecked(true);
          setGeofenceError(null);
        }
      } catch (err: any) {
        console.warn('Firestore error in checkGeofence:', err);
        setGeofenceError('Gagal memuat data lokasi kantor.');
        setGeofenceChecked(true);
      }
    };
    
    checkGeofence();
  }, [authReady, internalReady, isInternalUser, location, db, geofenceChecked]);

  const handleTap = async (selfieBase64?: string) => {
    if (!authReady || !internalReady || !isInternalUser || !location || !deviceId || !user) return;
    
    // Anomali: Di luar radius atau akurasi GPS buruk (> 80m)
    const isAnomaly = location.accuracy > 80 || !isWithinRadius;
    
    if (isAnomaly && !selfieBase64) {
      setShowCamera(true);
      return;
    }

    setSubmitting(true);

    try {
      const functions = getFunctions();
      const submitAttendance = httpsCallable(functions, 'submitAttendance');
      const type = lastEvent?.type === 'IN' ? 'OUT' : 'IN';
      
      await submitAttendance({
        type,
        tsClient: new Date().toISOString(),
        location: { lat: location.lat, lng: location.lng },
        accuracyM: location.accuracy,
        deviceId,
        selfieBase64: selfieBase64?.split(',')[1],
        selfieMime: 'image/jpeg'
      });

      toast({
        title: 'Berhasil!',
        description: `Berhasil melakukan Tap ${type}.`,
      });
      setShowCamera(false);
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Gagal Absen',
        description: error.message || 'Terjadi kesalahan sistem.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!authReady || !internalReady) {
    return (
      <div className="min-h-svh flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const type = lastEvent?.type === 'IN' ? 'OUT' : 'IN';
  const mode = isWithinRadius ? 'ONSITE' : 'OFFSITE';

  return (
    <div className="min-h-svh bg-background flex flex-col p-6 max-w-md mx-auto">
      {/* Header User */}
      <div className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center text-primary">
            <UserIcon className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-bold text-lg leading-tight">{user?.displayName || 'User'}</h1>
            <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">{user?.role}</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={() => signOut(auth)} className="text-muted-foreground rounded-full">
          <LogOut className="w-5 h-5" />
        </Button>
      </div>

      {/* Info Web Khusus */}
      <div className="mb-6 px-4 py-2 bg-muted/50 rounded-xl flex items-start gap-3">
        <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed italic">
          Web ini khusus untuk absensi dan riwayat pribadi. Monitoring HRD dan laporan perusahaan dapat diakses melalui portal HRP.
        </p>
      </div>

      {geofenceError ? (
        <Card className="border-none shadow-xl rounded-[2.5rem] mb-6 bg-white overflow-hidden p-8 text-center">
          <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2">Peringatan</h2>
          <p className="text-sm text-muted-foreground mb-6">{geofenceError}</p>
          <Button variant="outline" onClick={() => setGeofenceChecked(false)} className="rounded-full w-full">Coba Lagi</Button>
        </Card>
      ) : (
        <Card className="border-none shadow-xl shadow-primary/5 rounded-[2.5rem] mb-6 bg-white overflow-hidden">
          <CardContent className="pt-8 flex flex-col items-center text-center">
            <div className="mb-6">
              {location ? (
                <Badge variant={isWithinRadius ? 'default' : 'secondary'} className="px-5 py-1.5 rounded-full text-xs font-semibold gap-2">
                  <MapPin className="w-3.5 h-3.5" /> {mode}
                </Badge>
              ) : (
                <Badge variant="outline" className="animate-pulse rounded-full px-5 py-1.5">Mencari GPS...</Badge>
              )}
            </div>

            <button
              onClick={() => handleTap()}
              disabled={!location || submitting}
              className={`
                relative w-52 h-52 rounded-full flex flex-col items-center justify-center gap-2 shadow-2xl transition-all tap-button-active mb-8
                ${type === 'IN' ? 'bg-primary text-white shadow-primary/30' : 'bg-secondary text-white shadow-secondary/30'}
                ${(!location || submitting) ? 'opacity-50 grayscale cursor-not-allowed' : ''}
              `}
            >
              {submitting ? (
                <Loader2 className="w-12 h-12 animate-spin" />
              ) : (
                <>
                  <span className="text-4xl font-black tracking-tighter">TAP {type}</span>
                  <span className="text-[10px] uppercase font-bold tracking-widest opacity-80">Klik untuk Absen</span>
                </>
              )}
            </button>

            <div className="grid grid-cols-2 gap-4 w-full">
              <div className="p-4 rounded-[1.5rem] bg-muted/40 text-left">
                <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1 tracking-wider">Zona</p>
                <div className="flex items-center gap-2 font-bold text-sm">
                  {isWithinRadius ? (
                    <><CheckCircle2 className="w-4 h-4 text-green-500" /> <span className="truncate">{workLocation?.name || 'Onsite'}</span></>
                  ) : (
                    <><XCircle className="w-4 h-4 text-red-500" /> <span className="text-red-500">Offsite</span></>
                  )}
                </div>
              </div>
              <div className="p-4 rounded-[1.5rem] bg-muted/40 text-left">
                <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1 tracking-wider">Sinyal GPS</p>
                <div className="flex items-center gap-2 font-bold text-sm">
                  {location ? `${location.accuracy.toFixed(0)}m` : '--'}
                  {location && location.accuracy > 80 && <AlertTriangle className="w-4 h-4 text-orange-500" />}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Riwayat Pribadi Real-time */}
      <div className="mt-4 flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-2 mb-4">
          <History className="w-4 h-4 text-muted-foreground" />
          <p className="text-[11px] font-black text-muted-foreground uppercase tracking-widest">Riwayat Absen Pribadi</p>
        </div>
        
        <div className="flex-1 overflow-y-auto space-y-3 pb-6">
          {eventsLoading ? (
            <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : events?.map((event: any, i: number) => (
            <div key={i} className="flex items-center justify-between p-4 bg-white rounded-2xl border border-muted-foreground/5 shadow-sm">
              <div className="flex items-center gap-4">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${event.type === 'IN' ? 'bg-primary/10 text-primary' : 'bg-secondary/10 text-secondary'}`}>
                  <Clock className="w-5 h-5" />
                </div>
                <div>
                  <p className="text-xs font-bold text-foreground">TAP {event.type}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {event.tsServer ? format(event.tsServer.toDate(), 'eeee, d MMM yyyy', { locale: id }) : 'Pending'}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm font-black text-foreground">
                  {event.tsServer ? format(event.tsServer.toDate(), 'HH:mm') : '--:--'}
                </p>
                <Badge variant="outline" className="text-[9px] h-4 py-0 font-bold uppercase tracking-tighter">
                  {event.mode}
                </Badge>
              </div>
            </div>
          ))}
          {(!events || events.length === 0) && !eventsLoading && (
            <div className="text-center p-12 bg-muted/20 rounded-3xl border border-dashed">
              <p className="text-xs text-muted-foreground font-medium">Belum ada riwayat absensi.</p>
            </div>
          )}
        </div>
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
