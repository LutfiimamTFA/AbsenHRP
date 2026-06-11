import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const fileId = searchParams.get('fileId');
  const dateStr = searchParams.get('date'); // yyyy-MM-dd

  // Validate fileId format to prevent SSRF
  if (!fileId || !/^[a-zA-Z0-9_-]{10,}$/.test(fileId)) {
    return NextResponse.json({ error: 'fileId tidak valid' }, { status: 400 });
  }

  // 7-day expiry check
  if (dateStr) {
    const dateObj = new Date(dateStr + 'T00:00:00');
    if (!isNaN(dateObj.getTime())) {
      const diffMs = Date.now() - dateObj.getTime();
      if (diffMs > 7 * 24 * 60 * 60 * 1000) {
        return NextResponse.json(
          { error: 'Foto bukti sudah kedaluwarsa (lebih dari 7 hari sejak tanggal absen).' },
          { status: 403 }
        );
      }
    }
  }

  try {
    // Proxy via Google Drive thumbnail — works for files shared "Anyone with link"
    const driveUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=w800`;
    const resp = await fetch(driveUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AbsenHRP/1.0)' },
      redirect: 'follow',
    });

    if (!resp.ok) {
      return NextResponse.json(
        { error: `Gagal mengambil foto (Drive HTTP ${resp.status})` },
        { status: 502 }
      );
    }

    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    const buffer = await resp.arrayBuffer();

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error tidak diketahui' }, { status: 500 });
  }
}
