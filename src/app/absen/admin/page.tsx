'use client';

import React, { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { collection, query, orderBy, limit } from 'firebase/firestore';
import { useFirestore, useCollection, useUser } from '@/firebase';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MapPin, Users, History, ArrowLeft, Loader2, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';

export default function AdminDashboard() {
  const { user, loading: userLoading } = useUser();
  const db = useFirestore();
  const router = useRouter();

  const eventsQuery = useMemo(() => {
    // CRITICAL: Prevent unauthorized list operation if user is not resolved or not privileged
    // Returning null ensures useCollection doesn't start a forbidden query.
    if (userLoading || !user || !user.isPrivileged) return null;
    return query(collection(db, 'attendance_events'), orderBy('tsServer', 'desc'), limit(50));
  }, [db, user, userLoading]);

  const locationsQuery = useMemo(() => {
    // CRITICAL: Prevent unauthorized list operation if user is not resolved or not privileged
    if (userLoading || !user || !user.isPrivileged) return null;
    return query(collection(db, 'work_locations'));
  }, [db, user, userLoading]);

  const { data: events, loading: eventsLoading } = useCollection(eventsQuery);
  const { data: locations, loading: locationsLoading } = useCollection(locationsQuery);

  if (userLoading) {
    return (
      <div className="min-h-svh flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user || !user.isPrivileged) {
    return (
      <div className="min-h-svh flex flex-col items-center justify-center bg-background p-6 text-center">
        <AlertCircle className="w-12 h-12 text-destructive mb-4" />
        <h1 className="text-2xl font-bold mb-2">Access Denied</h1>
        <p className="text-muted-foreground mb-6">You do not have permission to view this page.</p>
        <Button onClick={() => router.push('/absen')}>Return to Home</Button>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-background p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <Button variant="ghost" size="icon" onClick={() => router.push('/absen')} className="rounded-full">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Admin Console</h1>
          <p className="text-sm text-muted-foreground">Monitor attendance and manage locations</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <Card className="border-none shadow-lg rounded-3xl">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Events</CardTitle>
            <History className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{events?.length || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Last 50 recorded sessions</p>
          </CardContent>
        </Card>
        <Card className="border-none shadow-lg rounded-3xl">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Work Locations</CardTitle>
            <MapPin className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{locations?.length || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Active geofence zones</p>
          </CardContent>
        </Card>
        <Card className="border-none shadow-lg rounded-3xl">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Your Role</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <Badge variant="outline" className="uppercase font-bold text-primary">{user.role}</Badge>
            <p className="text-xs text-muted-foreground mt-1">Logged in as {user.email}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <Card className="lg:col-span-2 border-none shadow-lg overflow-hidden rounded-3xl">
          <CardHeader className="border-b bg-muted/20">
            <CardTitle className="text-lg">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {eventsLoading ? (
              <div className="p-8 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto" /></div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User ID</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Flags</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events?.map((e: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-[10px] truncate max-w-[100px]">{e.uid}</TableCell>
                      <TableCell>
                        <Badge variant={e.type === 'IN' ? 'default' : 'secondary'}>{e.type}</Badge>
                      </TableCell>
                      <TableCell>
                        <span className="text-xs font-medium">{e.mode}</span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {e.tsServer ? format(e.tsServer.toDate(), 'HH:mm dd/MM') : 'Pending'}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1 flex-wrap">
                          {e.flags?.map((f: string, j: number) => (
                            <Badge key={j} variant="outline" className="text-[8px] px-1 h-4 border-orange-200 text-orange-700 bg-orange-50">{f}</Badge>
                          ))}
                          {(!e.flags || e.flags.length === 0) && <span className="text-[10px] text-muted-foreground italic">Clean</span>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {(!events || events.length === 0) && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No records found</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="border-none shadow-lg rounded-3xl">
          <CardHeader className="border-b bg-muted/20">
            <CardTitle className="text-lg">Work Locations</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            {locationsLoading ? (
               <Loader2 className="w-6 h-6 animate-spin mx-auto" />
            ) : (
              <div className="space-y-4">
                {locations?.map((loc: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 p-3 rounded-2xl bg-muted/30 border border-muted-foreground/5">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                      <MapPin className="w-4 h-4" />
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <p className="text-sm font-bold truncate">{loc.name}</p>
                      <p className="text-[10px] text-muted-foreground">Radius: {loc.radiusM}m</p>
                    </div>
                  </div>
                ))}
                {(!locations || locations.length === 0) && (
                  <p className="text-xs text-muted-foreground text-center py-4">No locations configured.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}