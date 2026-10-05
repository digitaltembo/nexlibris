import { useMemo } from 'react';
import styled from 'styled-components';
import { encode } from 'uqr';

const Svg = styled.svg`
  display: block;
  width: 220px;
  max-width: 100%;
  height: auto;
  /* Always dark on light, whatever the scheme (scanners expect it), in the theme's colours. */
  background: var(--qr-paper);
  color: var(--qr-ink);
  border-radius: var(--radius);
`;

/** A QR code of `text`, drawn as one SVG path. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const { size, data } = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    data.forEach((row, y) => row.forEach((dark, x) => dark && (d += `M${x} ${y}h1v1h-1z`)));
    return { size, path: d };
  }, [text]);
  return (
    <Svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <path d={path} fill="currentColor" />
    </Svg>
  );
}
