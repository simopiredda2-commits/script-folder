import type { FastifyInstance } from 'fastify';
import type { AdminDeps } from './deps';
import { createPrintService } from './print-service';

/**
 * Preferenze di stampa per tipo di documento, dello studio e delle postazioni (tappa 14).
 *
 * - `GET /api/stampa/preferenze`: ogni utente, le preferenze che valgono per la postazione della
 *   sessione (postazione, poi studio, poi predefinite), per i suggerimenti accanto ai pulsanti.
 * - `GET /api/stampa/impostazioni`: l'amministratore (`admin.printers`), tutte le preferenze dello
 *   studio e delle postazioni attive.
 * - `PUT /api/stampa/impostazioni`: l'amministratore, la preferenza di un documento per lo studio o
 *   per una postazione. Ogni cambio, e ogni rifiuto, va nel registro come «amministrazione».
 */
export function registerPrintRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const service = createPrintService(deps);

  app.get('/api/stampa/preferenze', async (req) => service.effective(req.actor!));
  app.get('/api/stampa/impostazioni', async (req) => service.settings(req.actor!));
  app.put('/api/stampa/impostazioni', async (req) => service.update(req.actor!, req.body));
}
