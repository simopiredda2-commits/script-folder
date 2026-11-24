import { encode } from 'uqr';

/**
 * Un codice QR disegnato qui, senza servizi esterni (regola 8): il testo non esce dal browser. Scuro
 * su chiaro, con il margine bianco che i lettori vogliono (suggerimento S2 dell'audit, D259).
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, data } = encode(text, { ecc: 'M', border: 4 });
  // Un tracciato solo: un quadrato per ogni modulo scuro.
  let path = '';
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <svg
      className="codice-qr"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      width={200}
      height={200}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="var(--color-surface)" />
      <path d={path} fill="var(--color-text)" />
    </svg>
  );
}
