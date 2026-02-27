'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { collection, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
import { httpsCallable, getFunctions } from 'firebase/functions';
import { useAuth, useFirestore, useUser, useCollection } from '@/firebase';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MapPin, User as UserIcon, LogOut, CheckCircle2, XCircle, AlertTriangle, Loader2, LayoutDashboard, Info, ShieldAlert } from 'lucide-react';
import { useDeviceId } from '@/hooks/use-device-id';
import { useToast } from '@/hooks/use-toast';
import { getDistance } from '@/lib/geo-utils';
import { CameraCapture } from '@/components/camera-capture';
import { errorEmitter } from '@/firebase/error-emitter';
import { FirestorePermissionError } from '@/firebase/errors';
import { explainAttendanceAnomaly } from '@/ai/flows/explain-attendance-anomaly';

export default function AbsenPage() {
  const { user, loading: userLoading } = useUser();
  const auth = useAuth();
  const db = useFirestore();
  const router = useRouter();
  const { toast } = useToast();
  
  const [location, setLocation] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [isWithinRadius, setIsWithinRadius] = useState(false);
  const [isNearBoundary, setIsNearBoundary] = useState(false);
  const [workLocation, setWorkLocation] = useState<any>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [anomalyExplanation, setAnomalyExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  
  const deviceId = useDeviceId();

  // Guard: Block candidates or unauthenticated users
  useEffect(() => {
    if (!userLoading) {
      if (!user) {
        router.push('/login');
      } else if (user.role === 'kandidat' || !user.isInternal) {
        router.push('/unauthorized');
      }
    }
  }, [user, userLoading, router]);

  const lastEventQuery = useMemo(() => {
    // Prevent query if user is not resolved or is a candidate
    if (!user || user.role === 'kandidat') return null;
    // Mandatory filter by UID for security and compliance with rules
    return query(
      collection(db, 'attendance_events'),
      where('uid', '==', user.uid),
      orderBy('tsServer', 'desc'),
      limit(1)
    );
  }, [user, db]);

  const { data: events } = useCollection(lastEventQuery);
  const lastEvent = useMemo(() => {
    if (!events || events.length === 0) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = events[0].tsServer?.toDate() || new Date();
    return eventDate >= today ? events[0] : null;
  }, [events]);

  useEffect(() => {
    if (!user || user.role === 'kandidat' || !user.isInternal) return;
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
          title: 'Location Error',
          description: 'Please enable GPS for attendance.',
        });
      },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [user, toast]);

  useEffect(() => {
    const checkGeofence = async () => {
      // Ensure we are logged in and STAFF before querying
      if (!location || !user || !user.isInternal || user.role === 'kandidat') return;
      
      try {
        const collRef = collection(db, 'work_locations');
        const locationsSnap = await getDocs(collRef);
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
          setIsNearBoundary(Math.abs(minDistance - nearest.radiusM) <= 20);
        }
      } catch (err: any) {
        if (err.code === 'permission-denied') {
          const permissionError = new FirestorePermissionError({
            path: 'work_locations',
            operation: 'list',
          });
          errorEmitter.emit('permission-error', permissionError);
        }
      }
    };
    checkGeofence();
  }, [location, user, db]);

  useEffect(() => {
    const getExplanation = async () => {
      if (!location || !user || user.role === 'kandidat' || !user.isInternal) return;
      const isAnomaly = location.accuracy > 80 || isNearBoundary || !isWithinRadius;
      
      if (isAnomaly && !anomalyExplanation && !explaining) {
        setExplaining(true);
        try {
          const result = await explainAttendanceAnomaly({
            accuracyM: location.accuracy,
            distanceToBoundaryM: workLocation ? Math.abs(getDistance(location.lat, location.lng, workLocation.center.lat, workLocation.center.lng) - workLocation.radiusM) : null,
            isNewDevice: false,
            mode: isWithinRadius ? 'ONSITE' : 'OFFSITE',
            workLocationName: workLocation?.name,
            userName: user.displayName || 'User',
          });
          setAnomalyExplanation(result.explanation);
        } catch (error) {
          // Silent fail for AI explanation
        } finally {
          setExplaining(false);
        }
      } else if (!isAnomaly) {
        setAnomalyExplanation(null);
      }
    };
    getExplanation();
  }, [location, isWithinRadius, isNearBoundary, workLocation, user, anomalyExplanation, explaining]);

  const handleTap = async (selfieBase64?: string) => {
    if (!location || !deviceId || !user || user.role === 'kandidat' || !user.isInternal) return;
    setSubmitting(true);

    const isAnomaly = location.accuracy > 80 || isNearBoundary;
    const mode = isWithinRadius ? 'ONSITE' : 'OFFSITE';
    const needsSelfie = mode === 'OFFSITE' || isAnomaly;
    
    if (needsSelfie && !selfieBase64) {
      setShowCamera(true);
      setSubmitting(false);
      return;
    }

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
        title: 'Success!',
        description: `Successfully clocked ${type}.`,
      });
      setShowCamera(false);
      setAnomalyExplanation(null);
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Submission failed',
        description: error.message || 'An error occurred.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (userLoading || !user || user.role === 'kandidat' || !user.isInternal) {
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
      <div className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center text-primary relative">
            <UserIcon className="w-5 h-5" />
            {user.isPrivileged && (
               <Badge className="absolute -top-2 -right-2 px-1 text-[8px] h-4 bg-orange-500 hover:bg-orange-600">ADMIN</Badge>
            )}
          </div>
          <div>
            <h1 className="font-bold text-lg leading-tight">{user.displayName || 'User'}</h1>
            <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">{user.role}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {user.isPrivileged && (
            <Button variant="ghost" size="icon" onClick={() => router.push('/absen/admin')} className="text-muted-foreground rounded-full">
              <LayoutDashboard className="w-5 h-5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={() => signOut(auth)} className="text-muted-foreground rounded-full">
            <LogOut className="w-5 h-5" />
          </Button>
        </div>
      </div>

      <Card className="border-none shadow-xl shadow-primary/5 rounded-[2.5rem] mb-6 bg-white overflow-hidden">
        <CardContent className="pt-8 flex flex-col items-center text-center">
          <div className="mb-6">
            {location ? (
              <Badge variant={isWithinRadius ? 'default' : 'secondary'} className="px-5 py-1.5 rounded-full text-xs font-semibold gap-2">
                <MapPin className="w-3.5 h-3.5" /> {mode}
              </Badge>
            ) : (
              <Badge variant="outline" className="animate-pulse rounded-full px-5 py-1.5">Locating...</Badge>
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
                <span className="text-[10px] uppercase font-bold tracking-widest opacity-80">Finish Clock Session</span>
              </>
            )}
          </button>

          <div className="grid grid-cols-2 gap-4 w-full mb-2">
            <div className="p-4 rounded-[1.5rem] bg-muted/40 text-left">
              <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1 tracking-wider">Zone</p>
              <div className="flex items-center gap-2 font-bold text-sm">
                {isWithinRadius ? (
                  <><CheckCircle2 className="w-4 h-4 text-green-500" /> <span className="truncate">{workLocation?.name || 'Valid'}</span></>
                ) : (
                  <><XCircle className="w-4 h-4 text-red-500" /> <span className="text-red-500">Offsite</span></>
                )}
              </div>
            </div>
            <div className="p-4 rounded-[1.5rem] bg-muted/40 text-left">
              <p className="text-[9px] text-muted-foreground font-bold uppercase mb-1 tracking-wider">GPS Signal</p>
              <div className="flex items-center gap-2 font-bold text-sm">
                {location ? `${location.accuracy.toFixed(0)}m` : '--'}
                {location && location.accuracy > 80 && <AlertTriangle className="w-4 h-4 text-orange-500" />}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {(anomalyExplanation || explaining) && (
        <div className="p-5 rounded-[1.8rem] bg-orange-50/80 border border-orange-100 flex items-start gap-3 mb-6 animate-in fade-in slide-in-from-top-2 duration-500">
          {explaining ? (
            <Loader2 className="w-5 h-5 text-orange-600 shrink-0 mt-0.5 animate-spin" />
          ) : (
            <Info className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
          )}
          <div className="text-xs text-orange-900 leading-relaxed">
            <p className="font-black uppercase tracking-widest text-[10px] mb-1">Notice</p>
            {explaining ? <p>Generating context-aware guidance...</p> : <p>{anomalyExplanation}</p>}
          </div>
        </div>
      )}

      <div className="mt-auto pb-4">
        <p className="text-[9px] font-black text-muted-foreground uppercase text-center mb-4 tracking-[0.2em]">Daily Timeline</p>
        <div className="flex justify-center items-center gap-4 text-sm font-medium">
          {lastEvent ? (
            <div className="flex items-center gap-3 px-5 py-2.5 bg-white rounded-full shadow-sm border border-muted-foreground/10">
              <Badge variant={lastEvent.type === 'IN' ? 'default' : 'secondary'} className="rounded-full px-2">{lastEvent.type}</Badge>
              <span className="text-muted-foreground text-xs font-bold">Logged at {lastEvent.tsServer?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          ) : (
            <span className="text-muted-foreground italic text-[10px] font-bold uppercase tracking-widest opacity-60">First activity of the day</span>
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