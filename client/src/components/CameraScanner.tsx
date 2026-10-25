import { useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import type { BarcodeReader } from '../isbn/scanner';
import { Muted } from '../styles/ui';
import { t } from '../i18n';

const Viewfinder = styled.div<{ $square: boolean }>`
  position: relative;
  margin: 16px 0 8px;
  border-radius: var(--radius);
  overflow: hidden;
  background: #000;
  aspect-ratio: 4 / 3;

  video {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* Where to hold the code: a wide strip for a barcode, a square for a QR code. */
  &::after {
    content: '';
    position: absolute;
    inset: ${(p) => (p.$square ? '15% 27.5%' : '30% 12%')};
    border: 2px solid var(--highlight);
    border-radius: 8px;
    box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.25);
  }
`;

const CameraNote = styled(Muted)`
  position: absolute;
  inset: auto 0 8px;
  z-index: 1;
  text-align: center;
  color: #fff;
  font-size: 0.85rem;
  text-shadow: 0 1px 2px #000;
`;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The camera, read for codes several times a second while it's shown. A value counts once two
 * frames in a row agree on it: a blurred or skewed frame can misread a barcode as another number
 * whose check digit happens to work.
 */
export function CameraScanner({
  reader,
  onValue,
  onError,
  hint,
  otherwise,
  square = false,
}: {
  reader(): Promise<BarcodeReader>;
  onValue(value: string): void;
  onError(message: string): void;
  /** What to do, once the camera is running, e.g. "Hold the barcode inside the frame." */
  hint: string;
  /** What to do instead if there's no camera, e.g. "Use a photo of the barcode, or type the ISBN." */
  otherwise: string;
  /** A square frame, for QR codes. */
  square?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [note, setNote] = useState(t('camera.starting'));
  const callbacks = useRef({ onValue, onError, reader, hint, otherwise });
  callbacks.current = { onValue, onError, reader, hint, otherwise };

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        setNote(t('camera.loading'));
        const reader = await callbacks.current.reader();
        if (stopped) return;
        setNote(callbacks.current.hint);
        let previous: string[] = [];
        const scan = async () => {
          if (stopped) return;
          const frame = video.current;
          try {
            if (frame && frame.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              const read = await reader.read(frame);
              for (const value of read) if (previous.includes(value)) callbacks.current.onValue(value);
              previous = read;
            }
          } catch {
            // A frame that can't be read (e.g. while the camera settles) is skipped.
          }
          timer = setTimeout(() => void scan(), 150);
        };
        void scan();
      } catch (e) {
        if (stopped) return;
        const name = e instanceof DOMException ? e.name : '';
        callbacks.current.onError(
          name === 'NotAllowedError'
            ? t('camera.refused', { otherwise: lowerFirst(callbacks.current.otherwise) })
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? t('camera.none', { otherwise: callbacks.current.otherwise })
              : t('camera.failed', { message: errorMessage(e) }),
        );
      }
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <Viewfinder $square={square}>
      <video ref={video} muted playsInline />
      <CameraNote as="p">{note}</CameraNote>
    </Viewfinder>
  );
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
