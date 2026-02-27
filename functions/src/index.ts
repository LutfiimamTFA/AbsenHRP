
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { getDistance } from './utils/geo'; // Same Haversine logic

admin.initializeApp();

export const submitAttendance = functions.https.onCall(async (data, context) => {
  // 1. Auth check
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be logged in.');
  }

  const { type, tsClient, location, accuracyM, deviceId, selfieBase64 } = data;
  const uid = context.auth.uid;
  const db = admin.firestore();
  const bucket = admin.storage().bucket();

  // 2. Fetch User & Device Binding
  const userRef = db.collection('users').doc(uid);
  const userDoc = await userRef.get();
  const userData = userDoc.data();
  
  let flags: string[] = [];
  if (!userData?.primaryDeviceId) {
    await userRef.set({ primaryDeviceId: deviceId }, { merge: true });
  } else if (userData.primaryDeviceId !== deviceId) {
    flags.push('NEW_DEVICE');
  }

  // 3. Geofencing
  const locationsSnap = await db.collection('work_locations').get();
  let workLoc: any = null;
  let minDistance = Infinity;

  locationsSnap.forEach(doc => {
    const lData = doc.data();
    const d = getDistance(location.lat, location.lng, lData.center.lat, lData.center.lng);
    if (d < minDistance) {
      minDistance = d;
      workLoc = lData;
    }
  });

  const mode = (workLoc && minDistance <= workLoc.radiusM) ? 'ONSITE' : 'OFFSITE';
  const isNearBoundary = workLoc && Math.abs(minDistance - workLoc.radiusM) <= 20;
  
  if (accuracyM > 80) flags.push('LOW_ACCURACY');
  if (isNearBoundary) flags.push('NEAR_BOUNDARY');
  if (mode === 'OFFSITE') flags.push('OFFSITE_MODE');

  const needsSelfie = flags.length > 0 || mode === 'OFFSITE';

  if (needsSelfie && !selfieBase64) {
    throw new functions.https.HttpsError('failed-precondition', 'SELFIE_REQUIRED');
  }

  // 4. Handle Selfie & Watermarking
  let selfiePaths = null;
  if (selfieBase64) {
    const eventId = db.collection('attendance_events').doc().id;
    const rawPath = `attendance_raw/${uid}/${eventId}.jpg`;
    const wmPath = `attendance_wm/${uid}/${eventId}.jpg`;
    
    const buffer = Buffer.from(selfieBase64, 'base64');
    await bucket.file(rawPath).save(buffer, { contentType: 'image/jpeg' });

    // Watermark Logic Simulation (In production, use 'sharp' or 'canvas')
    // For this boilerplate, we'll store the same for now or a meta-updated version
    await bucket.file(wmPath).save(buffer, { 
      contentType: 'image/jpeg',
      metadata: { 
        metadata: {
          watermark: `Name: ${userData?.name || uid}, Time: ${new Date().toISOString()}, Type: ${type}, Lat: ${location.lat}, Lng: ${location.lng}`
        }
      }
    });

    selfiePaths = { rawPath, watermarkedPath: wmPath };
  }

  // 5. Final Save
  const event = {
    uid,
    type,
    mode,
    tsServer: admin.firestore.FieldValue.serverTimestamp(),
    tsClient: admin.firestore.Timestamp.fromDate(new Date(tsClient)),
    location,
    accuracyM,
    deviceId,
    flags,
    selfie: selfiePaths || undefined
  };

  await db.collection('attendance_events').add(event);

  return { ok: true, mode, flags };
});
