/**
 * Nome del prodotto e del marchio.
 *
 * È l'unico punto del codice in cui il nome del prodotto è scritto (regola 6 di CLAUDE.md).
 * Ovunque serva il nome, si importa da qui. Un test controlla che non compaia altrove
 * in apps/, packages/, sync/, fixtures/ e scripts/.
 */
export const PRODUCT_NAME = 'Folder';

/** Marchio dello studio che firma il prodotto. */
export const COMPANY_BRAND = 'SCRIPT';

/** Firma breve che accompagna il nome: «by SCRIPT», da mostrare piccola. */
export const PRODUCT_SIGNATURE = `by ${COMPANY_BRAND}`;

/** Nome completo per titoli di pagina e testi di presentazione. */
export const PRODUCT_FULL_NAME = `${PRODUCT_NAME} ${PRODUCT_SIGNATURE}`;
