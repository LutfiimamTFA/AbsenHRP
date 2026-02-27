
'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { collection, query, where, orderBy, limit, getDoc, doc } from 'firebase/firestore';
import { httpsCallable, getFunctions } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { useAuth, useFirestore, useUser, useCollection } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { MapPin, LogOut, CheckCircle2, XCircle, AlertTriangle, Loader2, Info, AlertCircle, History, Clock, RefreshCw, Building2 } from 'lucide-react';
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
  const [zone, setZone] = useState<'onsite' | 'offsite' | 'unknown'>('unknown');
  const [attendanceConfig, setAttendanceConfig] = useState<any>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  
  const deviceId = useDeviceId();

  useEffect(() => {
    if (!userLoading) {
      setAuthReady(true);
      if (user) {
        if (process.env.NODE_ENV === 'development') {
          console.log('projectId', getApp().options.projectId);
          console.log('uid', user.uid);
        }
        
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

  const personalHistoryQuery = useMemo(() => {
    if (!authReady || !internalReady || !isInternalUser || !user?.uid) {
      return null;
    }
    
    return query(
      collection(db, 'attendance_events'),
      where('uid', '==', user.uid),
      orderBy('tsServer', 'desc'),
      limit(50)
    );
  }, [authReady, internalReady, isInternalUser, user?.uid, db]);

  const { data: events, loading: eventsLoading } = useCollection(personalHistoryQuery);
  
  const lastEvent = useMemo(() => {
    if (!events || events.length === 0) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = events[0].tsServer?.toDate() || new Date();
    return eventDate >= today ? events[0] : null;
  }, [events]);

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

  useEffect(() => {
    const loadConfig = async () => {
      if (!authReady || !internalReady || !isInternalUser || configLoaded) return;
      
      try {
        const configRef = doc(db, 'attendance_config', 'default');
        const snap = await getDoc(configRef);
        
        if (!snap.exists()) {
          setConfigError('Konfigurasi absensi belum diatur di HRP.');
          setConfigLoaded(true);
          return;
        }

        const data = snap.data();
        if (process.env.NODE_ENV === 'development') {
          console.log('attendance_config load success', data);
        }

        if (!data.office || typeof data.office.lat !== 'number' || typeof data.office.lng !== 'number') {
          setConfigError('Lokasi kantor belum lengkap diatur di HRP.');
        } else {
          setAttendanceConfig(data);
          setConfigError(null);
        }
        setConfigLoaded(true);
      } catch (err: any) {
        console.error('Error loading attendance_config:', err);
        setConfigError(err.code === 'permission-denied' 
          ? 'Anda tidak memiliki izin membaca konfigurasi.' 
          : 'Gagal memuat konfigurasi absensi.');
        setConfigLoaded(true);
      }
    };
    
    loadConfig();
  }, [authReady, internalReady, isInternalUser, db, configLoaded]);

  useEffect(() => {
    if (location && attendanceConfig?.office) {
      const distM = getDistance(
        location.lat, 
        location.lng, 
        attendanceConfig.office.lat, 
        attendanceConfig.office.lng
      );
      
      const accuracyM = location.accuracy;
      const radiusM = attendanceConfig.office.radiusM || 100;

      let currentZone: 'onsite' | 'offsite' | 'unknown' = 'unknown';
      if (accuracyM > 75) {
        currentZone = 'unknown';
      } else if (distM <= radiusM) {
        currentZone = 'onsite';
      } else {
        currentZone = 'offsite';
      }
      
      setZone(currentZone);

      if (process.env.NODE_ENV === 'development') {
        console.log('Geofence Debug:', {
          officeLat: attendanceConfig.office.lat,
          officeLng: attendanceConfig.office.lng,
          userLat: location.lat,
          userLng: location.lng,
          distanceM: distM,
          radiusM: radiusM,
          accuracyM: accuracyM,
          zone: currentZone
        });
      }
    }
  }, [location, attendanceConfig]);

  const handleTap = async (selfieBase64?: string) => {
    if (!authReady || !internalReady || !isInternalUser || !location || !deviceId || !user) return;
    
    if (zone === 'unknown') {
      toast({
        variant: 'destructive',
        title: 'Sinyal Lemah',
        description: 'Mohon tunggu hingga sinyal GPS stabil sebelum absen.',
      });
      return;
    }

    const isAnomaly = zone === 'offsite';
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
        selfieBase64: selfieBase64?.split(',')[1]
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
  const userName = user?.displayName || 'User';
  const userInitials = userName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() || 'U';

  return (
    <div className="min-h-svh bg-background flex flex-col max-w-md mx-auto relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-64 bg-gradient-to-b from-primary/10 to-transparent -z-10" />

      <div className="p-6 pb-2">
        <div className="flex justify-between items-start mb-6">
          <div className="flex items-center gap-4">
            <Avatar className="w-14 h-14 border-2 border-white shadow-md">
              <AvatarFallback className="bg-primary text-white font-bold text-lg">
                {userInitials}
              </AvatarFallback>
            </Avatar>
            <div className="space-y-0.5">
              <h1 className="font-extrabold text-xl tracking-tight leading-none text-foreground">
                {userName}
              </h1>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                <span>{user?.brandName}</span>
                <span className="opacity-30">•</span>
                {user?.division && (
                  <>
                    <span>{user?.division}</span>
                    <span className="opacity-30">•</span>
                  </>
                )}
                <span className="text-primary/80">{user?.roleLabel}</span>
              </div>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => signOut(auth)} className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded-full transition-colors">
            <LogOut className="w-5 h-5" />
          </Button>
        </div>

        <div className="bg-white/50 backdrop-blur-sm border border-white rounded-2xl p-4 flex items-center gap-3 shadow-sm mb-6">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
            <Info className="w-4 h-4" />
          </div>
          <div className="flex-1">
            <p className="text-[11px] text-muted-foreground font-medium">
              Anda login sebagai <span className="text-foreground font-bold">{userName}</span> ({user?.brandName}).
            </p>
            <p className="text-[10px] text-muted-foreground italic">
              Web ini khusus absensi & riwayat pribadi. Monitoring ada di HRP.
            </p>
          </div>
        </div>
      </div>

      <div className="px-6 flex-1 flex flex-col gap-6">
        {configError ? (
          <Card className="border-none shadow-xl rounded-[2rem] bg-white overflow-hidden p-8 text-center animate-in fade-in zoom-in duration-300">
            <div className="w-16 h-16 bg-destructive/10 text-destructive rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-8 h-8" />
            </div>
            <h2 className="text-lg font-bold text-foreground mb-2">Masalah Konfigurasi</h2>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
              {configError}
            </p>
            <Button 
              onClick={() => { setConfigLoaded(false); setConfigError(null); }} 
              className="rounded-full w-full h-12 gap-2"
            >
              <RefreshCw className="w-4 h-4" /> Coba Lagi
            </Button>
          </Card>
        ) : (
          <Card className="border-none shadow-2xl shadow-primary/5 rounded-[2.5rem] bg-white overflow-hidden">
            <CardContent className="pt-8 pb-10 flex flex-col items-center text-center">
              <div className="mb-8">
                {location ? (
                  zone === 'unknown' ? (
                    <Badge variant="outline" className="px-5 py-2 rounded-full text-[11px] font-bold gap-2 uppercase tracking-widest shadow-sm text-orange-500 border-orange-200">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      GPS Belum Akurat
                    </Badge>
                  ) : (
                    <Badge variant={zone === 'onsite' ? 'default' : 'secondary'} className="px-5 py-2 rounded-full text-[11px] font-bold gap-2 uppercase tracking-widest shadow-sm">
                      {zone === 'onsite' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <MapPin className="w-3.5 h-3.5" />}
                      Zona {zone === 'onsite' ? 'Onsite' : 'Offsite'}
                    </Badge>
                  )
                ) : (
                  <Badge variant="outline" className="animate-pulse rounded-full px-5 py-2 text-[11px] font-bold uppercase tracking-widest">
                    Mencari GPS...
                  </Badge>
                )}
              </div>

              <div className="relative mb-8">
                <div className={`absolute inset-0 rounded-full animate-ping opacity-20 ${type === 'IN' ? 'bg-primary' : 'bg-secondary'}`} />
                
                <button
                  onClick={() => handleTap()}
                  disabled={!location || submitting || !configLoaded || !!configError || zone === 'unknown'}
                  className={`
                    relative w-52 h-52 rounded-full flex flex-col items-center justify-center gap-1 shadow-2xl transition-all tap-button-active
                    ${type === 'IN' ? 'bg-primary text-white shadow-primary/30' : 'bg-secondary text-white shadow-secondary/30'}
                    ${(!location || submitting || !configLoaded || !!configError || zone === 'unknown') ? 'opacity-50 grayscale cursor-not-allowed' : 'hover:scale-105'}
                  `}
                >
                  {submitting ? (
                    <Loader2 className="w-12 h-12 animate-spin" />
                  ) : (
                    <>
                      <span className="text-4xl font-black tracking-tighter">TAP {type}</span>
                      <span className="text-[10px] uppercase font-black tracking-[0.2em] opacity-80">Absen Sekarang</span>
                    </>
                  )}
                </button>
              </div>
              
              <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest mb-8">
                {format(new Date(), 'eeee, d MMMM yyyy', { locale: id })}
              </p>

              <div className="grid grid-cols-2 gap-4 w-full">
                <div className="p-4 rounded-[1.8rem] bg-muted/40 text-left border border-white">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                    <p className="text-[9px] text-muted-foreground font-black uppercase tracking-wider">Status</p>
                  </div>
                  <div className="font-bold text-sm truncate text-foreground">
                    {zone === 'onsite' ? 'Dalam Kantor' : zone === 'offsite' ? 'Luar Jangkauan' : 'Sinyal Lemah'}
                  </div>
                </div>
                <div className="p-4 rounded-[1.8rem] bg-muted/40 text-left border border-white">
                  <div className="flex items-center gap-2 mb-1.5">
                    <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                    <p className="text-[9px] text-muted-foreground font-black uppercase tracking-wider">Akurasi</p>
                  </div>
                  <div className="flex items-center gap-2 font-bold text-sm text-foreground">
                    {location ? `${location.accuracy.toFixed(0)}m` : '--'}
                    {location && location.accuracy > 75 && <AlertTriangle className="w-4 h-4 text-orange-500" />}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col min-h-0 pb-10">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary/5 flex items-center justify-center text-primary">
                <History className="w-4 h-4" />
              </div>
              <p className="text-xs font-black text-foreground uppercase tracking-widest">Riwayat Absen</p>
            </div>
          </div>
          
          <div className="space-y-3">
            {eventsLoading ? (
              <div className="flex justify-center p-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
            ) : events?.map((event: any, i: number) => (
              <div key={i} className="group flex items-center justify-between p-4 bg-white/80 backdrop-blur-sm rounded-2xl border border-white shadow-sm hover:shadow-md transition-all">
                <div className="flex items-center gap-4">
                  <div className={`w-11 h-11 rounded-2xl flex items-center justify-center transition-colors ${event.type === 'IN' ? 'bg-primary/10 text-primary group-hover:bg-primary group-hover:text-white' : 'bg-secondary/10 text-secondary group-hover:bg-secondary group-hover:text-white'}`}>
                    <Clock className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-xs font-black text-foreground uppercase tracking-tight">TAP {event.type}</p>
                    <p className="text-[10px] text-muted-foreground font-medium">
                      {event.tsServer ? format(event.tsServer.toDate(), 'eeee, d MMM', { locale: id }) : 'Pending...'}
                    </p>
                  </div>
                </div>
                <div className="text-right space-y-1">
                  <p className="text-base font-black text-foreground tracking-tighter">
                    {event.tsServer ? format(event.tsServer.toDate(), 'HH:mm') : '--:--'}
                  </p>
                  <Badge variant="outline" className={`text-[9px] h-4 py-0 font-bold uppercase tracking-tighter border-none ${event.mode === 'ONSITE' ? 'bg-green-50 text-green-600' : 'bg-orange-50 text-orange-600'}`}>
                    {event.mode}
                  </Badge>
                </div>
              </div>
            ))}
            {(!events || events.length === 0) && !eventsLoading && (
              <div className="text-center p-12 bg-white/40 rounded-[2rem] border border-dashed border-muted-foreground/20">
                <History className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
                <p className="text-xs text-muted-foreground font-medium italic">Belum ada riwayat absensi.</p>
              </div>
            )}
          </div>
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
