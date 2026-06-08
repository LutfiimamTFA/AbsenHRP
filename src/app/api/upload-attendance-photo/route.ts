import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Google Apps Script tidak menerima Content-Type: application/json dari server eksternal
// karena menyebabkan error 405. Gunakan text/plain — body tetap JSON string,
// Apps Script baca lewat e.postData.contents lalu JSON.parse.
async function postToAppsScript(url: string, payload: object): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow'
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const { fileName, mimeType, base64 } = body || {};

    if (!fileName || !base64) {
      return NextResponse.json(
        { success: false, error: 'Missing fileName atau base64' },
        { status: 400 }
      );
    }

    const scriptUrl = process.env.GOOGLE_DRIVE_APPS_SCRIPT_URL?.trim();
    const secret    = process.env.GOOGLE_DRIVE_UPLOAD_SECRET?.trim();
    const folderId  = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim();

    if (!scriptUrl || !secret || !folderId) {
      const missing = [
        !scriptUrl && 'GOOGLE_DRIVE_APPS_SCRIPT_URL',
        !secret    && 'GOOGLE_DRIVE_UPLOAD_SECRET',
        !folderId  && 'GOOGLE_DRIVE_ROOT_FOLDER_ID',
      ].filter(Boolean).join(', ');
      return NextResponse.json(
        { success: false, error: `Env belum diatur di .env.local: ${missing}` },
        { status: 500 }
      );
    }

    if (scriptUrl.includes('ISI_URL_APPS_SCRIPT') || !scriptUrl.startsWith('https://script.google.com/')) {
      return NextResponse.json(
        { success: false, error: 'GOOGLE_DRIVE_APPS_SCRIPT_URL masih placeholder. Isi dengan URL /exec dari deployment Apps Script yang aktif.' },
        { status: 500 }
      );
    }

    const payload = {
      secret,
      folderId,
      fileName,
      mimeType: mimeType || 'image/jpeg',
      base64,
    };

    console.log('[upload-attendance] POST to Apps Script:', {
      url: scriptUrl,
      secret: secret ? '***' : 'MISSING',
      folderId,
      fileName,
      mimeType: payload.mimeType,
      base64Length: base64.length,
    });

    const resp = await postToAppsScript(scriptUrl, payload);
    console.log('[upload-attendance] Apps Script HTTP response:', resp.status, resp.statusText);

    // HTTP error spesifik
    if (resp.status === 401) {
      throw new Error(
        'Apps Script 401 Unauthorized. Di Google Apps Script → Deploy → Manage Deployments, ' +
        'pastikan "Who has access" = "Anyone" (bukan "Only myself"). ' +
        'Buat deployment baru jika perlu, lalu salin URL /exec baru ke .env.local.'
      );
    }
    if (resp.status === 403) {
      throw new Error(
        'Apps Script 403 Forbidden. Cek apakah akun Google kamu (pemilik script) ada kebijakan organisasi ' +
        'yang memblokir akses anonymous. Coba deploy dari akun Google personal.'
      );
    }
    if (resp.status === 405) {
      throw new Error(
        'Apps Script 405 Method Not Allowed. Kemungkinan URL sudah expired atau bukan URL /exec aktif. ' +
        'Deploy ulang: Apps Script → Deploy → New Deployment → Web App → "Anyone" → salin URL /exec baru.'
      );
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await resp.text();
      console.error('[upload-attendance] non-JSON HTTP', resp.status, ':', text.slice(0, 500));
      throw new Error(
        `Apps Script mengembalikan bukan JSON (HTTP ${resp.status}). ` +
        'Pastikan: URL adalah /exec aktif, deployed "Anyone can access", ' +
        'doPost() return ContentService.MimeType.JSON.'
      );
    }

    const data = await resp.json();
    console.log('[upload-attendance] Apps Script response:', JSON.stringify(data, null, 2));
    if (!data.success) {
      throw new Error(data.error || `Apps Script: upload gagal. Response: ${JSON.stringify(data)}`);
    }

    return NextResponse.json({
      success:     true,
      fileId:      data.fileId      || null,
      viewUrl:     data.viewUrl     || null,
      downloadUrl: data.downloadUrl || null,
      folderId,
    });
  } catch (err: any) {
    const message = err.message || 'Upload error tidak diketahui';
    console.error('[upload-attendance] error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
