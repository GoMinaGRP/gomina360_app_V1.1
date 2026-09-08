"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, RefreshCw, Trash2, UserRound, X } from "lucide-react";
import Avatar from "./Avatar";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentUser: any;
  /** Called after a successful save/remove so the app refreshes the user everywhere. */
  onSaved?: () => void;
}

/**
 * Profile Photo manager — any signed-in user manages THEIR OWN photo:
 * upload a picture or take one with the device camera, preview it, save it,
 * or remove it. Photos are downsized to a 256×256 JPEG data URL client-side
 * (fast + small) and stored on the user's profile (avatar_url) via
 * PUT /api/profile — the server always writes to the SESSION user only.
 */
export default function ProfilePhotoModal({ isOpen, onClose, currentUser, onSaved }: Props) {
  const [pending, setPending] = useState<string | null>(null); // newly chosen, not yet saved
  const [current, setCurrent] = useState<string | null>(null); // saved photo
  const [busy, setBusy] = useState(false);
  const [camBusy, setCamBusy] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Reset ONLY when the dialog opens (avatarUrl is deliberately NOT a dep —
  // after a save, onSaved refreshes the app user and would otherwise wipe the
  // "saved to your profile" confirmation while the dialog is still open).
  useEffect(() => {
    if (isOpen) {
      setPending(null);
      setCurrent(currentUser?.avatarUrl || null);
      setStatus("");
      setError("");
      setBusy(false);
    } else {
      stopCamera();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamOn(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  /** Downsize/crop any image source to a centered 256×256 JPEG data URL. */
  const toSquareDataUrl = (source: CanvasImageSource, sw: number, sh: number): string => {
    const side = Math.min(sw, sh);
    const sx = (sw - side) / 2;
    const sy = (sh - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(source, sx, sy, side, side, 0, 0, 256, 256);
    return canvas.toDataURL("image/jpeg", 0.85);
  };

  const acceptFile = (file: File | undefined | null) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) { setError("Please choose an image file (JPEG, PNG, WebP…)."); return; }
    setError("");
    const img = new Image();
    img.onload = () => {
      try {
        setPending(toSquareDataUrl(img, img.naturalWidth, img.naturalHeight));
        setStatus("Preview ready — Save to store it with your profile.");
      } catch {
        setError("Could not process that image. Try another one.");
      }
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => { setError("Could not read that image file."); URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(file);
  };

  const startCamera = async () => {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      // Camera API unavailable (old browser/webview) → native picker with camera hint.
      fileRef.current?.setAttribute("capture", "user");
      fileRef.current?.click();
      return;
    }
    setCamBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 640 } },
        audio: false,
      });
      streamRef.current = stream;
      setCamOn(true);
      // the <video> renders next frame — attach after state flip
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }, 50);
    } catch {
      setError("Camera unavailable or permission denied — use Upload Photo instead.");
      setCamOn(false);
    } finally {
      setCamBusy(false);
    }
  };

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) { setError("Camera is still starting… try again in a second."); return; }
    try {
      setPending(toSquareDataUrl(v, v.videoWidth, v.videoHeight));
      setStatus("Snapshot ready — Save to store it with your profile.");
      setError("");
      stopCamera();
    } catch {
      setError("Could not capture a photo. Try Upload instead.");
    }
  };

  const save = async (photo: string | null) => {
    setBusy(true);
    setError("");
    setStatus(photo ? "Saving photo to your profile…" : "Removing photo…");
    try {
      const r = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || "Save failed");
      setCurrent(d.photoUrl || null);
      setPending(null);
      setStatus(photo ? "✔ Profile photo saved to your profile." : "✔ Profile photo removed.");
      onSaved?.();
    } catch (e: any) {
      setError(e?.message || "Could not save the photo.");
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;
  const shown = pending ?? current;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" data-testid="ppm-root">
      <div className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <UserRound className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-extrabold text-white">My Profile Photo</h3>
          </div>
          <button onClick={() => { stopCamera(); onClose(); }} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400" data-testid="ppm-close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3.5">
          {/* Preview */}
          <div className="flex flex-col items-center gap-2">
            <div className="w-32 h-32 rounded-full overflow-hidden bg-emerald-500/15 border-2 border-emerald-500/40 flex items-center justify-center shadow-lg">
              {camOn ? (
                <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" data-testid="ppm-video" />
              ) : (
                <Avatar
                  name={currentUser?.name}
                  url={shown}
                  testid="ppm-preview"
                  fallbackTestid="ppm-initial"
                  imgClass="w-full h-full object-cover"
                  fallbackClass="w-full h-full flex items-center justify-center text-4xl font-black text-emerald-300"
                />
              )}
            </div>
            <p className="text-[11px] text-slate-400 text-center">
              {currentUser?.name} · <span className="text-emerald-400 font-bold">{currentUser?.role}</span>
              <br />Shown in the top-right Staff menu and to the OWNER in Signed-In Staff.
            </p>
          </div>

          {/* Actions */}
          {!camOn ? (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => { fileRef.current?.removeAttribute("capture"); fileRef.current?.click(); }}
                disabled={busy || camBusy}
                className="py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
                data-testid="ppm-upload-btn"
              >
                <ImagePlus className="w-3.5 h-3.5" /> Upload Photo
              </button>
              <button
                onClick={startCamera}
                disabled={busy || camBusy}
                className="py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-50"
                data-testid="ppm-camera-btn"
              >
                {camBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Camera className="w-3.5 h-3.5" />} Take Photo
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={snap}
                className="py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-extrabold flex items-center justify-center gap-1.5"
                data-testid="ppm-snap"
              >
                <Camera className="w-3.5 h-3.5" /> Capture
              </button>
              <button
                onClick={stopCamera}
                className="py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white text-xs font-bold flex items-center justify-center gap-1.5"
                data-testid="ppm-cancel-cam"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Cancel Camera
              </button>
            </div>
          )}

          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            data-testid="ppm-file"
            onChange={(e) => { acceptFile(e.target.files?.[0]); e.target.value = ""; }}
          />

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => save(pending)}
              disabled={busy || !pending}
              className="py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-extrabold flex items-center justify-center gap-1.5"
              data-testid="ppm-save"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} Save Photo
            </button>
            <button
              onClick={() => save(null)}
              disabled={busy || (!current && !pending)}
              className="py-2 rounded-lg bg-rose-600/80 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-extrabold flex items-center justify-center gap-1.5"
              data-testid="ppm-remove"
            >
              <Trash2 className="w-3.5 h-3.5" /> Remove
            </button>
          </div>

          {status && <p className="text-[11px] text-emerald-300 text-center" data-testid="ppm-status">{status}</p>}
          {error && <p className="text-[11px] text-rose-300 text-center" data-testid="ppm-error">{error}</p>}
        </div>
      </div>
    </div>
  );
}
