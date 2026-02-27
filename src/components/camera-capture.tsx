
'use client';

import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Camera, RefreshCw, X } from 'lucide-react';

interface CameraCaptureProps {
  onCapture: (base64: string) => void;
  onCancel: () => void;
}

export function CameraCapture({ onCapture, onCancel }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startCamera = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      setStream(s);
      if (videoRef.current) {
        videoRef.current.srcObject = s;
      }
    } catch (err) {
      setError('Cannot access camera. Please check permissions.');
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [startCamera]);

  const capture = () => {
    if (!videoRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(videoRef.current, 0, 0);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      onCapture(dataUrl);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col items-center justify-center p-4">
      <div className="relative w-full max-w-md aspect-[3/4] rounded-2xl overflow-hidden bg-muted flex items-center justify-center">
        {error ? (
          <div className="text-white text-center p-6">
            <p className="mb-4">{error}</p>
            <Button onClick={onCancel} variant="outline" className="text-white border-white">Close</Button>
          </div>
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover scale-x-[-1]"
          />
        )}
      </div>

      <div className="mt-8 flex gap-6 items-center">
        <button
          onClick={onCancel}
          className="p-4 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
        >
          <X className="w-6 h-6" />
        </button>
        <button
          onClick={capture}
          className="p-6 rounded-full bg-secondary text-white shadow-lg shadow-secondary/30 tap-button-active"
        >
          <Camera className="w-8 h-8" />
        </button>
        <button
          onClick={() => {
            stream?.getTracks().forEach((track) => track.stop());
            startCamera();
          }}
          className="p-4 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
        >
          <RefreshCw className="w-6 h-6" />
        </button>
      </div>
    </div>
  );
}
