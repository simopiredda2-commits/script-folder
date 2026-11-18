import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
// Import relativo: la configurazione di Vite gira in Node e deve includere il file nel suo bundle.
import { PRODUCT_FULL_NAME } from '../../packages/brand/brand';

/** Inserisce il nome del prodotto nel titolo della pagina, senza scriverlo in index.html. */
function productTitle(): Plugin {
  return {
    name: 'titolo-prodotto',
    transformIndexHtml: (html) => html.replace('%TITOLO_PRODOTTO%', PRODUCT_FULL_NAME),
  };
}

export default defineConfig({
  plugins: [react(), productTitle()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      '/api': `http://127.0.0.1:${process.env.API_PORT ?? 3001}`,
    },
  },
  build: {
    // Tutte le risorse, caratteri compresi, finiscono in dist/ e sono servite dal nostro dominio.
    assetsInlineLimit: 0,
  },
});
