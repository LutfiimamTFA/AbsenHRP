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
import { MapPin, User as UserIcon, LogOut, CheckCircle2, XCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { useDeviceId } from '@/hooks/use-device-id';
import { useToast } from '@/hooks/use-toast';
import { getDistance } from '@/lib/geo-utils';
import { CameraCapture } from '@/components/camera-capture';

export default function AbsenPage() {
  const { user, loading: authLoading } = useUser();
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
  const deviceId = useDeviceId();

  // Redirect if not logged in
  useEffect(() => {
    if (!authLoading && !user) {
      router.push('/login');
    }
  }, [user, authLoading, router]);

  // Fetch last event for today
  const lastEventQuery = useMemo(() => {
    if (!user) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
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

  // Location tracking
  useEffect(() => {
    if (!user) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => {
        // We avoid console.error here to prevent confusing error overlays. 
        // User notification is handled via the toast.
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

  // Geofencing logic
  useEffect(() => {
    const checkGeofence = async () => {
      if (!location) return;
      const locationsSnap = await getDocs(collection(db, 'work_locations'));
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
    };
    checkGeofence();
  }, [location, db]);

  const handleTap = async (selfieBase64?: string) => {
    if (!location || !deviceId) return;
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

  if (authLoading || !user) {
    return (
      <div className="min-h-svh flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const type = lastEvent?.type === 'IN' ? 'OUT' : 'IN';
  const mode = isWithinRadius ? 'ONSITE' : 'OFFSITE';
  const isAnomaly = (location?.accuracy || 0) > 80 || isNearBoundary;

  return (
    <div className="min-h-svh bg-background flex flex-col p-6 max-w-md mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center text-primary">
            <UserIcon className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-bold text-lg leading-tight">{user.displayName || 'PresenGO User'}</h1>
            <p className="text-xs text-muted-foreground">{user.email}</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={() => signOut(auth)} className="text-muted-foreground">
          <LogOut className="w-5 h-5" />
        </Button>
      </div>

      <Card className="border-none shadow-xl shadow-primary/5 rounded-3xl mb-6 bg-white">
        <CardContent className="pt-6 flex flex-col items-center text-center">
          <div className="mb-4">
            {location ? (
              <Badge variant={isWithinRadius ? 'default' : 'secondary'} className="px-4 py-1 rounded-full text-xs font-semibold gap-1">
                <MapPin className="w-3 h-3" /> {mode}
              </Badge>
            ) : (
              <Badge variant="outline" className="animate-pulse">Locating...</Badge>
            )}
          </div>

          <button
            onClick={() => handleTap()}
            disabled={!location || submitting}
            className={`
              relative w-48 h-48 rounded-full flex flex-col items-center justify-center gap-2 shadow-2xl transition-all tap-button-active mb-6
              ${type === 'IN' ? 'bg-primary text-white shadow-primary/30' : 'bg-secondary text-white shadow-secondary/30'}
              ${(!location || submitting) ? 'opacity-50 grayscale cursor-not-allowed' : ''}
            `}
          >
            {submitting ? (
              <Loader2 className="w-10 h-10 animate-spin" />
            ) : (
              <>
                <span className="text-4xl font-black tracking-tighter">TAP {type}</span>
                <span className="text-[10px] uppercase font-bold tracking-widest opacity-80">Click to finish</span>
              </>
            )}
          </button>

          <div className="grid grid-cols-2 gap-4 w-full">
            <div className="p-4 rounded-2xl bg-muted/50 text-left">
              <p className="text-[10px] text-muted-foreground font-bold uppercase mb-1">Location</p>
              <div className="flex items-center gap-2 font-semibold text-sm">
                {isWithinRadius ? (
                  <><CheckCircle2 className="w-4 h-4 text-green-500" /> <span className="truncate">{workLocation?.name || 'Valid'}</span></>
                ) : (
                  <><XCircle className="w-4 h-4 text-red-500" /> <span>Outside Area</span></>
                )}
              </div>
            </div>
            <div className="p-4 rounded-2xl bg-muted/50 text-left">
              <p className="text-[10px] text-muted-foreground font-bold uppercase mb-1">Accuracy</p>
              <div className="flex items-center gap-2 font-semibold text-sm">
                {location?.accuracy.toFixed(1)}m
                {location && location.accuracy > 80 && <AlertTriangle className="w-4 h-4 text-orange-500" />}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {isAnomaly && (
        <div className="p-4 rounded-2xl bg-orange-50 border border-orange-100 flex items-start gap-3 mb-6">
          <AlertTriangle className="w-5 h-5 text-orange-600 shrink-0 mt-0.5" />
          <div className="text-xs text-orange-800">
            <p className="font-bold mb-0.5">Anomaly Detected</p>
            <p>Verification selfie will be required for this tap.</p>
          </div>
        </div>
      )}

      <div className="mt-auto">
        <p className="text-[10px] font-bold text-muted-foreground uppercase text-center mb-3">Today&apos;s Last Activity</p>
        <div className="flex justify-center items-center gap-4 text-sm font-medium">
          {lastEvent ? (
            <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-full shadow-sm">
              <Badge variant={lastEvent.type === 'IN' ? 'default' : 'secondary'} className="rounded-full">{lastEvent.type}</Badge>
              <span className="text-muted-foreground">at {lastEvent.tsServer?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          ) : (
            <span className="text-muted-foreground italic">No activity yet today</span>
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
