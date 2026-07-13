import { NextRequest, NextResponse } from 'next/server';
import { getAdminFirestore, getAdminAuth } from '@/lib/firebase-admin';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return NextResponse.json({ error: 'Authorization wajib' }, { status: 401 });
  }

  let uid: string;
  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    uid = decoded.uid;
  } catch {
    return NextResponse.json({ error: 'Token tidak valid' }, { status: 401 });
  }

  const endpoint = req.nextUrl.searchParams.get('endpoint');
  const db = getAdminFirestore();
  const snap = await db.collection('attendance_notification_tokens')
    .where('uid', '==', uid)
    .limit(20)
    .get();
  const activeTokens = snap.docs.filter(doc => {
    const data = doc.data();
    if (endpoint && data.subscription?.endpoint !== endpoint) return false;
    return data.enabled !== false && data.isActive !== false && !!data.subscription?.endpoint;
  });

  return NextResponse.json({
    success: true,
    active: activeTokens.length > 0,
    tokenCount: activeTokens.length,
    status: activeTokens.length > 0 ? 'active' : 'not_enabled',
    tokenIds: activeTokens.map(doc => doc.id),
  });
}
