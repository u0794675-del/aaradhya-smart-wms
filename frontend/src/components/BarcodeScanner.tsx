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
  const doneRef = useRef(false);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveCamera = hasLiveCamera();

  const stop = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setActive(false);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const start = async () => {
    if (!videoRef.current) return;
    setError(null);
    setStarting(true);
    doneRef.current = false;
    try {
      const reader = new BrowserMultiFormatReader();
      const controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result, _error, scanner) => {
        if (!result || doneRef.current) return;
        doneRef.current = true;
        scanner.stop();
        controlsRef.current = null;
        setActive(false);
        onDetected(result.getText());
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
    const url = URL.createObjectURL(file);
    try {
      const result = await new BrowserMultiFormatReader().decodeFromImageUrl(url);
      onDetected(result.getText());
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
