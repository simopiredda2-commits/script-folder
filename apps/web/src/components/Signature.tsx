import { COMPANY_BRAND, PRODUCT_SIGNATURE } from '@mmg/brand';
import scriptSymbol from '@mmg/brand/assets/script/script_simbolo.svg';

/**
 * «by SCRIPT» piccolo, con accanto il simbolo ufficiale di SCRIPT usato identico al file.
 * Il simbolo è decorativo: il testo dice già il nome.
 */
export function Signature() {
  return (
    <span className="brand-signature" data-brand={COMPANY_BRAND}>
      <img src={scriptSymbol} alt="" width={16} height={16} />
      <span>{PRODUCT_SIGNATURE}</span>
    </span>
  );
}
