"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
import { RefreshCw, X, Check, SwitchCamera } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CameraCaptureProps {
  onCapture: (base64: string) => void;
  onCancel: () => void;
  facingMode?: "user" | "environment";
  mode?: "selfie" | "proof";
}

export function CameraCapture({
  onCapture,
  onCancel,
  facingMode: defaultFacingMode = "user",
  mode = "selfie",
}: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [currentFacing, setCurrentFacing] = useState<"user" | "environment">(defaultFacingMode);
  const [fallbackMsg, setFallbackMsg] = useState<string | null>(null);

  const isSelfie = mode === "selfie";

  const startCamera = useCallback(async (facing: "user" | "environment") => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setError(null);
    setReady(false);
    setFallbackMsg(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      // Deteksi apakah kamera yang aktif sesuai facing yang diminta
      const track = s.getVideoTracks()[0];
      const settings = track?.getSettings?.();
      if (settings?.facingMode && settings.facingMode !== facing) {
        setFallbackMsg("Kamera belakang tidak tersedia, menggunakan kamera yang aktif.");
      }
      streamRef.current = s;
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        videoRef.current.onloadedmetadata = () => {
          try { videoRef.current?.play(); } catch {}
          setReady(true);
        };
      }
    } catch {
      // Fallback: coba tanpa constraint facingMode
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        setFallbackMsg("Kamera belakang tidak tersedia, gunakan kamera yang aktif.");
        streamRef.current = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          videoRef.current.onloadedmetadata = () => {
            try { videoRef.current?.play(); } catch {}
            setReady(true);
          };
        }
      } catch {
        setError("Kamera tidak dapat dibuka. Izinkan akses kamera lalu coba lagi.");
      }
    }
  }, []);

  useEffect(() => {
    startCamera(defaultFacingMode);
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) {
        try { videoRef.current.srcObject = null; } catch {}
      }
      streamRef.current = null;
      setReady(false);
      setPreview(null);
    };
  }, [startCamera, defaultFacingMode]);

  const switchCamera = () => {
    const next = currentFacing === "user" ? "environment" : "user";
    setCurrentFacing(next);
    startCamera(next);
  };

  const capture = () => {
    const video = videoRef.current;
    if (!video || !ready) return;
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;

    const canvas = document.createElement("canvas");
    canvas.width = vw;
    canvas.height = vh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Mirror hanya untuk selfie (kamera depan)
    if (currentFacing === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, vw, vh);

    setPreview(canvas.toDataURL("image/jpeg", 0.92));
  };

  const retake = () => {
    setPreview(null);
    setError(null);
    setReady(false);
    startCamera(currentFacing);
  };

  const usePhoto = () => {
    if (!preview) return;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) {
      try { videoRef.current.srcObject = null; } catch {}
    }
    streamRef.current = null;
    setReady(false);
    onCapture(preview);
  };

  const handleCancel = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) {
      try { videoRef.current.srcObject = null; } catch {}
    }
    streamRef.current = null;
    setPreview(null);
    setReady(false);
    setError(null);
    onCancel();
  };

  const title = isSelfie ? "Selfie Kehadiran" : "Foto Bukti Kondisi";

  // Post-capture preview
  if (preview) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
        <div className="w-full max-w-md h-[100dvh] bg-black flex flex-col">
          <div className="flex-1 relative overflow-hidden">
            <img src={preview} alt={title} className="w-full h-full object-contain bg-black" />
            <div className="absolute inset-x-0 top-safe-top pt-4 flex justify-center pointer-events-none">
              <span className="bg-black/60 text-white text-xs font-bold px-4 py-1.5 rounded-full">
                Periksa foto Anda
              </span>
            </div>
          </div>
          <div className="p-6 bg-black flex gap-3 pb-safe-bottom">
            <Button
              onClick={retake}
              variant="outline"
              className="flex-1 h-14 rounded-2xl border-white/30 text-white bg-white/10 hover:bg-white/20 gap-2"
            >
              <RefreshCw className="w-4 h-4" /> Ulangi Foto
            </Button>
            <Button
              onClick={usePhoto}
              className="flex-1 h-14 rounded-2xl bg-primary gap-2 font-bold"
            >
              <Check className="w-4 h-4" /> Gunakan Foto Ini
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Live camera view
  return (
    <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
      <div className="w-full max-w-md h-[100dvh] bg-black flex flex-col">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 pt-safe-top py-3">
          <button
            onClick={handleCancel}
            className="p-2 rounded-full bg-white/15 active:bg-white/30"
          >
            <X className="w-5 h-5 text-white" />
          </button>
          <span className="text-white text-sm font-bold">{title}</span>
          {/* Tombol ganti kamera */}
          <button
            onClick={switchCamera}
            disabled={!!error}
            className="p-2 rounded-full bg-white/15 active:bg-white/30 disabled:opacity-30"
            aria-label="Ganti Kamera"
          >
            <SwitchCamera className="w-5 h-5 text-white" />
          </button>
        </div>

        {/* Camera area */}
        <div className="flex-1 relative overflow-hidden bg-black">
          {error ? (
            <div className="flex flex-col items-center justify-center h-full gap-5 p-6">
              <p className="text-white text-sm text-center leading-relaxed">{error}</p>
              <Button
                onClick={() => startCamera(currentFacing)}
                variant="outline"
                className="text-white border-white/50 bg-white/10 rounded-2xl"
              >
                Coba Lagi
              </Button>
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`w-full h-full object-contain ${currentFacing === "user" ? "scale-x-[-1]" : ""}`}
              />
              {isSelfie && currentFacing === "user" ? (
                /* Face guide oval — selfie depan saja */
                <>
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div
                      style={{
                        width: "55%",
                        aspectRatio: "3 / 4",
                        borderRadius: "50%",
                        border: "2.5px solid rgba(255,255,255,0.85)",
                        boxShadow: "0 0 0 9999px rgba(0,0,0,0.28)",
                      }}
                    />
                  </div>
                  <div className="absolute bottom-4 inset-x-0 flex justify-center pointer-events-none">
                    <span className="bg-black/50 text-white text-xs px-3 py-1.5 rounded-full">
                      Posisikan wajah di dalam lingkaran
                    </span>
                  </div>
                </>
              ) : (
                /* Instruksi umum */
                <div className="absolute bottom-4 inset-x-0 flex flex-col items-center gap-1.5 pointer-events-none">
                  {fallbackMsg && (
                    <span className="bg-black/70 text-yellow-300 text-[10px] px-3 py-1 rounded-full max-w-[90%] text-center">
                      {fallbackMsg}
                    </span>
                  )}
                  <span className="bg-black/50 text-white text-xs px-3 py-1.5 rounded-full text-center">
                    {isSelfie ? "Selfie — posisikan wajah Anda" : "Foto kondisi, kendaraan, lokasi, atau bukti pendukung"}
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Shutter */}
        <div className="flex justify-center items-center py-8 bg-black pb-safe-bottom">
          <button
            onClick={capture}
            disabled={!!error || !ready}
            className="w-20 h-20 rounded-full bg-white flex items-center justify-center shadow-xl active:scale-90 transition-transform disabled:opacity-30"
          >
            <div className="w-[68px] h-[68px] rounded-full bg-white border-[3px] border-gray-300" />
          </button>
        </div>
      </div>
    </div>
  );
}
