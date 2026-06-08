"use client";

import React, { useRef, useState, useCallback, useEffect } from "react";
import { RefreshCw, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface CameraCaptureProps {
  onCapture: (base64: string) => void;
  onCancel: () => void;
}

export function CameraCapture({ onCapture, onCancel }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const startCamera = useCallback(async () => {
    // stop any existing stream first
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setError(null);
    setReady(false);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 720 },
          height: { ideal: 1280 },
          aspectRatio: { ideal: 0.5625 },
        },
        audio: false,
      });
      streamRef.current = s;
      if (videoRef.current) {
        videoRef.current.srcObject = s;
        // try to play and mark ready when metadata loaded
        videoRef.current.onloadedmetadata = () => {
          try {
            videoRef.current?.play();
          } catch {}
          setReady(true);
        };
      }
    } catch (err) {
      console.error("startCamera error", err);
      setError(
        "Kamera tidak dapat dibuka. Izinkan akses kamera lalu coba lagi.",
      );
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) {
        try {
          videoRef.current.srcObject = null;
        } catch {}
      }
      streamRef.current = null;
      setReady(false);
      setPreview(null);
    };
  }, [startCamera]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !ready) return;
    const vw = video.videoWidth || 720;
    const vh = video.videoHeight || 1280;
    // target portrait ratio 9:16
    const targetRatio = 9 / 16;

    // create target canvas (portrait)
    const canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 1280;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // fill background neutral
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Mirror horizontally for selfie orientation
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);

    // compute scale to fit entire video into portrait canvas without cropping
    const scale = Math.min(canvas.width / vw, canvas.height / vh);
    const dw = Math.round(vw * scale);
    const dh = Math.round(vh * scale);
    const dx = Math.round((canvas.width - dw) / 2);
    const dy = Math.round((canvas.height - dh) / 2);

    ctx.drawImage(video, 0, 0, vw, vh, dx, dy, dw, dh);
    const data = canvas.toDataURL("image/jpeg", 0.92);
    setPreview(data);
  };

  const retake = () => {
    // Reset preview and reinitialize camera stream
    setPreview(null);
    setError(null);
    setReady(false);
    // Restart camera to ensure fresh stream
    startCamera();
  };

  const usePhoto = () => {
    if (!preview) return;
    // stop camera and cleanup
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) {
      try {
        videoRef.current.srcObject = null;
      } catch {}
    }
    streamRef.current = null;
    setReady(false);
    onCapture(preview);
  };

  const handleCancel = () => {
    // stop and cleanup
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (videoRef.current) {
      try {
        videoRef.current.srcObject = null;
      } catch {}
    }
    streamRef.current = null;
    setPreview(null);
    setReady(false);
    setError(null);
    onCancel();
  };

  // Post-capture preview
  if (preview) {
    return (
      <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
        <div className="w-full max-w-md h-[100dvh] bg-black flex flex-col">
          <div className="flex-1 relative overflow-hidden">
            <img
              src={preview}
              alt="selfie"
              className="w-full h-full object-contain bg-black"
            />
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
              <RefreshCw className="w-4 h-4" />
              Ulangi Foto
            </Button>
            <Button
              onClick={usePhoto}
              className="flex-1 h-14 rounded-2xl bg-primary gap-2 font-bold"
            >
              <Check className="w-4 h-4" />
              Gunakan Foto Ini
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
          <span className="text-white text-sm font-bold">Selfie</span>
          <div className="w-9" />
        </div>

        {/* Camera area */}
        <div className="flex-1 relative overflow-hidden">
          {error ? (
            <div className="flex flex-col items-center justify-center h-full gap-5 p-6">
              <p className="text-white text-sm text-center leading-relaxed">
                {error}
              </p>
              <Button
                onClick={startCamera}
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
                className="w-full h-full object-cover scale-x-[-1]"
              />
              {/* Face guide oval */}
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                style={{ paddingBottom: "10%" }}
              >
                <div
                  style={{
                    width: "62%",
                    aspectRatio: "9 / 16",
                    borderRadius: "50%",
                    border: "2.5px solid rgba(255,255,255,0.85)",
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.30)",
                  }}
                />
              </div>
              <div className="absolute bottom-6 inset-x-0 flex justify-center pointer-events-none">
                <span className="bg-black/50 text-white text-xs px-3 py-1.5 rounded-full">
                  Posisikan wajah di dalam lingkaran
                </span>
              </div>
            </>
          )}
        </div>

        {/* Shutter button */}
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
