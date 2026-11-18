import { currentMark, PRODUCT_NAME } from '@mmg/brand';

/** Segno di oggi con il nome del prodotto, preso da PRODUCT_NAME. */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <span className="brand-logo">
      <svg
        width={size}
        height={size}
        viewBox={currentMark.viewBox}
        aria-hidden="true"
        focusable="false"
      >
        <polyline
          points={currentMark.points}
          fill="none"
          stroke={currentMark.color}
          strokeWidth={currentMark.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>{PRODUCT_NAME}</span>
    </span>
  );
}
