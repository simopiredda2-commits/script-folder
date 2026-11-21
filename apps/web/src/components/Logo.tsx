import { PRODUCT_NAME, productMark } from '@mmg/brand';

/**
 * Segno del prodotto (proposta B, scelta alla prima fermata) con il nome da PRODUCT_NAME. Il segno
 * poggia sulla base del nome (D242): la sua viewBox finisce al bordo in basso del tratto, e la riga
 * allinea le basi (`align-items: baseline` in `.brand-logo`).
 */
export function Logo({ size = 30 }: { size?: number }) {
  const { size: view, base } = productMark;
  return (
    <span className="brand-logo">
      <svg
        width={size}
        height={(size * base) / view}
        viewBox={`0 0 ${view} ${base}`}
        overflow="visible"
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
