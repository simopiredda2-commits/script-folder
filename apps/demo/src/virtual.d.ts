/** Moduli generati da vite.config.ts per la dimostrazione (D221). */
declare module 'virtual:demo-fs' {
  /** Percorso sotto /repo → contenuto, in testo o in base64. */
  const files: Record<string, { text?: string; base64?: string }>;
  export default files;
}

declare module 'virtual:demo-rsa-keys' {
  /** Chiavi RSA 2048 di prova, PKCS#8 DER in base64, nuove a ogni costruzione. */
  const keys: string[];
  export default keys;
}
