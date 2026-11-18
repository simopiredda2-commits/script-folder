import { PRODUCT_NAME, productMark } from '@mmg/brand';

/** Segno del prodotto (proposta B, scelta alla prima fermata) con il nome da PRODUCT_NAME. */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <span className="brand-logo">
      <svg
        width={size}
        height={size}
        viewBox={productMark.viewBox}
        aria-hidden="true"
        focusable="false"
        data-segno="prodotto"
      >
        {productMark.paths.map((d) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke={productMark.color}
            strokeWidth={productMark.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
      <span>{PRODUCT_NAME}</span>
    </span>
  );
}
