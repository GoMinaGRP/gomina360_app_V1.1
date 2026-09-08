"use client";

import React, { useEffect, useRef, useState } from "react";
import { QrCode, Camera, CameraOff, Keyboard, X, ScanLine } from "lucide-react";
import jsQR from "jsqr";

/**
 * QrScanModal — scan an item/asset QR with the device camera, or type/paste
 * the QR content manually (desktop fallback & reliable automation path).
 * Parent runs the registry lookup on every emitted code.
 */
interface QrScanModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the decoded/entered QR content (existing or brand-new). */
  onCode: (code: string) => void;
  title?: string;
  /** While the parent is looking a code up — keeps the modal visibly busy. */
  busy?: boolean;
  error?: string;
}

export default function QrScanModal({
  open,
  onClose,
  onCode,
  title = "Scan QR Code",
  busy = false,
  error = "",
}: QrScanModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const [camState, setCamState] = useState<"starting" | "live" | "unavailable">("starting");
  const [camError, setCamError] = useState("");
  const [manual, setManual] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const stop = () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };

    const start = async () => {
      setCamState("starting");
      setCamError("");
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera API not available");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => {});
        setCamState("live");

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const tick = () => {
          if (cancelled) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            try {
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
              if (hit?.data) {
                stop();
                onCode(hit.data);
                return;
              }
            } catch { /* frame dropped — keep scanning */ }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e: any) {
        if (cancelled) return;
        setCamState("unavailable");
        setCamError(e?.message || "Camera access failed");
      }
    };

    start();
    return () => { cancelled = true; stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const submitManual = () => {
    const v = manual.trim();
    if (v) onCode(v);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" data-testid="qr-scanner">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-700/80 flex items-center justify-between">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <QrCode className="w-5 h-5 text-cyan-400" /> {title}
          </h3>
          <button onClick={onClose} data-testid="qr-scanner-close" className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white transition">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-slate-400 leading-relaxed">
            Point the camera at the item or asset QR label. If the code is
            already registered, its record opens; a new code starts a guided
            registration.
          </p>

          <div className="relative rounded-xl overflow-hidden border border-slate-700 bg-slate-950 aspect-[4/3]">
            {camState === "live" && (
              <div className="absolute inset-0 pointer-events-none z-10 flex items-center justify-center">
                <div className="w-40 h-40 border-2 border-cyan-400/80 rounded-2xl shadow-[0_0_0_9999px_rgba(2,6,23,0.45)]" />
                <ScanLine className="absolute w-32 h-32 text-cyan-400/60 animate-pulse" />
              </div>
            )}
            {camState !== "unavailable" ? (
              <video ref={videoRef} data-testid="qr-scanner-video" playsInline muted className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-center px-6" data-testid="qr-scanner-nocam">
                <CameraOff className="w-8 h-8 text-slate-600" />
                <p className="text-xs text-slate-400">
                  No camera available on this device{camError ? ` (${camError})` : ""}. Enter the QR content below instead.
                </p>
              </div>
            )}
            {camState === "starting" && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-950/70">
                <Camera className="w-8 h-8 text-slate-500 animate-pulse" />
              </div>
            )}
          </div>

          {busy && (
            <p className="text-[11px] text-cyan-300 font-semibold" data-testid="qr-scanner-busy">Checking the registry…</p>
          )}
          {error && (
            <p className="text-[11px] text-rose-400 font-semibold" data-testid="qr-scanner-error">{error}</p>
          )}

          <div className="flex items-center gap-2 pt-1 border-t border-slate-800">
            <Keyboard className="w-4 h-4 text-slate-500 shrink-0" />
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitManual()}
              data-testid="qr-scanner-manual"
              placeholder="…or type / paste the QR content"
              className="flex-1 px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white text-sm"
            />
            <button
              onClick={submitManual}
              disabled={!manual.trim() || busy}
              data-testid="qr-scanner-use"
              className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-xs font-bold transition"
            >
              Use Code
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
