import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { getDistance } from "./utils/geo"; // Same Haversine logic
import { google } from "googleapis";
import { PassThrough } from "stream";

admin.initializeApp();

export const submitAttendance = functions.https.onCall(
  async (data, context) => {
    // 1. Auth check
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "User must be logged in.",
      );
    }

    const { type, tsClient, location, accuracyM, deviceId, selfieBase64 } =
      data;
    const uid = context.auth.uid;
    const db = admin.firestore();
    const bucket = admin.storage().bucket();

    // 2. Fetch User & Device Binding
    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();
    const userData = userDoc.data();

    let flags: string[] = [];
    if (!userData?.primaryDeviceId) {
      await userRef.set({ primaryDeviceId: deviceId }, { merge: true });
    } else if (userData.primaryDeviceId !== deviceId) {
      flags.push("NEW_DEVICE");
    }

    // 3. Geofencing
    const locationsSnap = await db.collection("work_locations").get();
    let workLoc: any = null;
    let minDistance = Infinity;

    locationsSnap.forEach((doc) => {
      const lData = doc.data();
      const d = getDistance(
        location.lat,
        location.lng,
        lData.center.lat,
        lData.center.lng,
      );
      if (d < minDistance) {
        minDistance = d;
        workLoc = lData;
      }
    });

    const mode =
      workLoc && minDistance <= workLoc.radiusM ? "ONSITE" : "OFFSITE";
    const isNearBoundary =
      workLoc && Math.abs(minDistance - workLoc.radiusM) <= 20;

    if (accuracyM > 80) flags.push("LOW_ACCURACY");
    if (isNearBoundary) flags.push("NEAR_BOUNDARY");
    if (mode === "OFFSITE") flags.push("OFFSITE_MODE");

    const needsSelfie = flags.length > 0 || mode === "OFFSITE";

    if (needsSelfie && !selfieBase64) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "SELFIE_REQUIRED",
      );
    }

    // 4. Handle Selfie & Watermarking
    let selfiePaths = null;
    if (selfieBase64) {
      const eventId = db.collection("attendance_events").doc().id;
      const rawPath = `attendance_raw/${uid}/${eventId}.jpg`;
      const wmPath = `attendance_wm/${uid}/${eventId}.jpg`;

      const buffer = Buffer.from(selfieBase64, "base64");
      await bucket.file(rawPath).save(buffer, { contentType: "image/jpeg" });

      // Watermark Logic Simulation (In production, use 'sharp' or 'canvas')
      // For this boilerplate, we'll store the same for now or a meta-updated version
      await bucket.file(wmPath).save(buffer, {
        contentType: "image/jpeg",
        metadata: {
          metadata: {
            watermark: `Name: ${userData?.name || uid}, Time: ${new Date().toISOString()}, Type: ${type}, Lat: ${location.lat}, Lng: ${location.lng}`,
          },
        },
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
      selfie: selfiePaths || undefined,
    };

    await db.collection("attendance_events").add(event);

    return { ok: true, mode, flags };
  },
);

// Callable function to upload base64 image to Google Drive into a specified folder
// HTTP endpoint for Drive upload with CORS handling
export const uploadToDrive = functions
  .region("us-central1")
  .https.onRequest(async (req, res) => {
    // Fixed allowed origins list
    const allowedOrigins = [
      "http://localhost:9002",
      "http://localhost:3000",
      // replace with your production domains
      "https://DOMAIN_HRP_PRODUCTION",
      "https://DOMAIN_WEB_ABSEN_PRODUCTION",
    ];

    function setCors(req: any, res: any) {
      const origin = req.headers?.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      }
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
    }

    try {
      // set CORS headers before any potential return
      const origin = req.headers?.origin;
      const corsAllowed = !origin || allowedOrigins.includes(origin);
      setCors(req, res);

      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({ success: false, error: "Method not allowed" });
        return;
      }

      if (!corsAllowed) {
        res.status(403).json({ success: false, error: "Origin not allowed" });
        return;
      }

      // Expect JSON body with either { fileName, mimeType, base64, folderId }
      const payload = (req.body && (req.body.data || req.body)) || {};
      const { fileName, mimeType, base64, folderId } = payload;
      if (!fileName || !base64) {
        res
          .status(400)
          .json({ success: false, error: "Missing fileName or base64" });
        return;
      }

      // Authenticate: expect Authorization: Bearer <idToken>
      const authHeader = String(req.get("Authorization") || "");
      const match = authHeader.match(/^Bearer (.*)$/);
      if (!match) {
        res
          .status(401)
          .json({
            success: false,
            error: "Missing Authorization Bearer token",
          });
        return;
      }
      const idToken = match[1];
      try {
        await admin.auth().verifyIdToken(idToken);
      } catch (e) {
        res.status(401).json({ success: false, error: "Invalid auth token" });
        return;
      }

      // Enforce folder ID for attendance
      const DRIVE_FOLDER_ID = "1lPkjD2kw2k9No4kHCuUJ07zOmGwuQ70I";
      const targetFolder = DRIVE_FOLDER_ID;

      // Prepare Drive auth
      let authClient;
      if (process.env.GOOGLE_SERVICE_ACCOUNT) {
        const cred = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
        const auth = new google.auth.GoogleAuth({
          credentials: cred,
          scopes: ["https://www.googleapis.com/auth/drive"],
        });
        authClient = await auth.getClient();
      } else {
        const auth = new google.auth.GoogleAuth({
          scopes: ["https://www.googleapis.com/auth/drive"],
        });
        authClient = await auth.getClient();
      }

      const drive = google.drive({ version: "v3", auth: authClient });

      const matches = String(base64).match(/^data:(image:\/\w+);base64,(.*)$/);
      const finalMime = matches ? matches[1] : mimeType || "image/jpeg";
      const b64data = matches ? matches[2] : base64;
      const buffer = Buffer.from(b64data, "base64");

      const stream = new PassThrough();
      stream.end(buffer);

      const createRes = await drive.files.create({
        requestBody: {
          name: fileName,
          parents: [targetFolder],
          mimeType: finalMime,
        },
        media: {
          mimeType: finalMime,
          body: stream,
        },
        fields: "id, webViewLink, webContentLink",
      });

      const fileId = createRes.data.id as string;

      try {
        await drive.permissions.create({
          fileId,
          requestBody: { role: "reader", type: "anyone" },
        });
      } catch (permErr) {
        console.warn("Failed to set public permission on Drive file", permErr);
      }

      const fileMeta = await drive.files.get({
        fileId,
        fields: "id, webViewLink, webContentLink",
      });

      // ensure CORS headers set for final response
      setCors(req, res);
      res.json({
        success: true,
        fileId: fileMeta.data.id,
        driveViewUrl: fileMeta.data.webViewLink || null,
        driveDownloadUrl: fileMeta.data.webContentLink || null,
      });
    } catch (err: any) {
      console.error("uploadToDrive error", err);
      try {
        setCors(req, res);
        res
          .status(500)
          .json({ success: false, error: "Failed to upload to Google Drive" });
      } catch (e) {
        // ignore secondary errors
      }
    }
  });
