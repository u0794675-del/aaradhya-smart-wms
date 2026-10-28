import { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser';
import { Icon } from '../ui';

export function BarcodeScanner({
  onDetected,
  disabled = false,
}: {
  onDetected: (text: string) => void;
  disabled?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const doneRef = useRef(false);
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } catch (reason) {
      setError(
        reason instanceof Error
          ? `Camera unavailable: ${reason.message}. Use a USB scanner or type the code instead.`
          : 'Camera unavailable. Use a USB scanner or type the code instead.',
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="scanner">
      <div className={`scanner-frame ${active ? 'live' : ''}`}>
        <video ref={videoRef} muted playsInline />
        {!active ? (
          <div className="scanner-placeholder">
            <Icon name="camera" size={30} />
            <span>{starting ? 'Requesting camera…' : 'Camera scanner'}</span>
            <small>Uses the device camera. Browser permission is required.</small>
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
        ) : (
          <button type="button" className="btn btn-subtle" onClick={() => void start()} disabled={disabled || starting}>
            <Icon name="camera" size={15} /> {starting ? 'Starting…' : 'Start camera'}
          </button>
        )}
        <span className="muted tiny">Aim the reticle at a box, batch, product or location barcode.</span>
      </div>
      {error ? <div className="alert alert-warning">{error}</div> : null}
    </div>
  );
}
