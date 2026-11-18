/** Tipi minimi di opentype.js 2.0 per le sole funzioni usate da genera-proposte-logo.ts. */
declare module 'opentype.js' {
  export interface Path {
    toPathData(decimalPlaces?: number): string;
  }
  export interface Font {
    unitsPerEm: number;
    tables: { os2?: { sCapHeight: number; sxHeight: number } };
    getPath(text: string, x: number, y: number, fontSize: number): Path;
    getAdvanceWidth(text: string, fontSize: number): number;
  }
  const opentype: { parse(buffer: ArrayBuffer): Font };
  export default opentype;
}
