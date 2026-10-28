import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { Icon } from '../ui';

function hasLiveCamera() {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function BarcodeScanner({
  onDetected,
  disabled = false,
}: {
  onDetected: (text: string) => void;
  disabled?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const detectedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneRef = useRef(false);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [reading, setReading] = useState(false);
  const [detected, setDetected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveCamera = hasLiveCamera();

  const stop = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setActive(false);
  }, []);

  useEffect(
    () => () => {
      stop();
      if (detectedTimer.current) clearTimeout(detectedTimer.current);
      void audioRef.current?.close().catch(() => undefined);
    },
    [stop],
  );

  // iOS has no vibration API, so every scan also gets a short confirmation beep.
  const unlockAudio = () => {
    if (audioRef.current) return;
    const Ctor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      audioRef.current = new Ctor();
    } catch {
      audioRef.current = null;
    }
  };

  const confirmScan = (text: string) => {
    navigator.vibrate?.([80, 40, 80]);
    const ctx = audioRef.current;
    if (ctx) {
      try {
        if (ctx.state === 'suspended') void ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 1046;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      } catch {
        /* audio is optional feedback */
      }
    }
    setDetected(text);
    if (detectedTimer.current) clearTimeout(detectedTimer.current);
    detectedTimer.current = setTimeout(() => setDetected(null), 2500);
    onDetected(text);
  };

  const start = async () => {
    if (!videoRef.current) return;
    setError(null);
    setStarting(true);
    doneRef.current = false;
    unlockAudio();
    try {
      const reader = new BrowserMultiFormatReader();
      const controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result, _error, scanner) => {
        if (!result || doneRef.current) return;
        doneRef.current = true;
        scanner.stop();
        controlsRef.current = null;
        setActive(false);
        confirmScan(result.getText());
      });
      controlsRef.current = controls;
      setActive(true);
    } catch {
      setError('Live camera is unavailable or permission was denied. Scan a photo of the barcode instead.');
    } finally {
      setStarting(false);
    }
  };

  const readPhoto = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setReading(true);
    unlockAudio();
    const url = URL.createObjectURL(file);
    try {
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      confirmScan(result.getText());
    } catch {
      setError('No barcode found in that photo. Fill the frame with the barcode, hold steady and try again.');
    } finally {
      URL.revokeObjectURL(url);
      if (fileRef.current) fileRef.current.value = '';
      setReading(false);
    }
  };

  return (
    <div className="scanner">
      <div className={`scanner-frame ${active ? 'live' : ''}`}>
        <video ref={videoRef} muted playsInline />
        {!active ? (
          <div className="scanner-placeholder">
            <Icon name="camera" size={30} />
            <span>{starting ? 'Requesting camera…' : liveCamera ? 'Camera scanner' : 'Photo scanner'}</span>
            <small>
              {liveCamera
                ? 'Uses the device camera. Browser permission is required.'
                : 'Live camera needs HTTPS. Scan a photo of the barcode instead.'}
            </small>
          </div>
        ) : (
          <span className="scanner-live-badge">
            <span className="pill-dot" /> Scanning
          </span>
        )}
        {detected ? (
          <span className="scanner-detected-badge" role="status">
            <Icon name="check" size={14} /> {detected}
          </span>
        ) : null}
      </div>
      <div className="scanner-controls">
        {active ? (
          <button type="button" className="btn btn-subtle" onClick={stop}>
            <Icon name="close" size={15} /> Stop camera
          </button>
        ) : liveCamera ? (
          <button type="button" className="btn btn-subtle" onClick={() => void start()} disabled={disabled || starting}>
            <Icon name="camera" size={15} /> {starting ? 'Starting…' : 'Start camera'}
          </button>
        ) : null}
        <label className={`btn btn-subtle scanner-photo ${disabled || reading ? 'is-disabled' : ''}`}>
          <Icon name="camera" size={15} />
          {reading ? 'Reading photo…' : 'Scan with photo'}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            disabled={disabled || reading}
            onChange={(event) => void readPhoto(event.target.files?.[0])}
          />
        </label>
        <span className="muted tiny">
          {liveCamera
            ? 'Aim the reticle at a box, batch, product or location barcode.'
            : 'Scan with photo uses the phone camera. You can also type the code.'}
        </span>
      </div>
      {error ? <div className="alert alert-warning">{error}</div> : null}
    </div>
  );
}
