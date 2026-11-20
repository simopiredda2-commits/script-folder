import {
  FSE_DOCUMENT_TYPES,
  SimulatedRegionalFseAccess,
  type RegionalFseAccess,
} from '@mmg/integrations';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { createCredentialService } from '../credentials/service';
import type { Database } from '../db/client';
import { guardPatient } from '../patients/access';
import { HttpError } from './errors';

const params = z.object({ id: z.uuid() });
const body = z
  .object({
    /** Filtro dell'elenco dei documenti (TIPO_DOCUMENTO delle specifiche); vuoto per tutti. */
    tipoDocumento: z.string().trim().max(40).nullable().optional(),
  })
  .strict();

export interface FseAccessDeps {
  db: Database;
  credentials: Pick<ReturnType<typeof createCredentialService>, 'authFor' | 'authRefused'>;
  access: RegionalFseAccess;
  environment: 'prova' | 'produzione';
}

/**
 * Aprire il Fascicolo regionale del paziente dalla cartella (D220), con il modulo di accesso del
 * CSI: il servizio chiede il token con le credenziali RUPAR del medico e restituisce l'indirizzo
 * da aprire, che vale una volta. Ogni richiesta resta nel registro degli accessi alla cartella.
 */
export function registerFseAccessRoutes(app: FastifyInstance, deps: FseAccessDeps) {
  const { db, credentials, access, environment } = deps;
  const scoped = { config: { patientScoped: true } };
  // Il simulatore non apre il Fascicolo vero: in produzione resta spento (regola 7).
  const active = !(access.environment === 'simulator' && environment === 'produzione');

  /** Per la pagina: i filtri delle specifiche e com'è il collegamento. */
  app.get('/api/fascicolo-regionale', () => ({
    tipiDocumento: Object.entries(FSE_DOCUMENT_TYPES).map(([codice, nome]) => ({ codice, nome })),
    simulato: access.environment === 'simulator',
    attivo: active,
  }));

  app.post('/api/pazienti/:id/fascicolo-regionale', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { patient: pt } = await guardPatient(
      db,
      actor,
      id,
      'fse.consult',
      'apertura_fascicolo_regionale',
    );
    const { tipoDocumento } = body.parse(req.body ?? {});
    const documentType = tipoDocumento || null;
    if (documentType !== null && !(documentType in FSE_DOCUMENT_TYPES))
      throw new HttpError(400, 'Tipo di documento non previsto dalle specifiche del Fascicolo');
    if (!active)
      throw new HttpError(
        503,
        'Il collegamento con il Fascicolo regionale non è ancora attivo: si attiva con il CSI Piemonte',
      );
    // Credenziali RUPAR del medico; se mancano, l'errore porta a «Credenziali dei servizi».
    const auth = await credentials.authFor(actor.userId, 'fascicolo_regionale');
    const result = await access.authenticate(
      { patientFiscalCode: pt.fiscalCode, clientIp: req.ip || null, documentType },
      auth,
    );
    if (result.outcome === 'success')
      return { indirizzo: result.url, simulato: access.environment === 'simulator' };
    if (result.outcome === 'unreachable')
      throw new HttpError(503, `${result.message}: riprova più tardi`);
    // Credenziali rifiutate: si annota, come per gli invii (D102), e si porta il medico alla pagina.
    if (result.code === 'AUTH_ER_501') {
      await credentials.authRefused(
        { userId: actor.userId, workstation: actor.workstation },
        'fascicolo_regionale',
        'credentials',
        `${result.code}: ${result.message}`,
      );
      throw new HttpError(
        422,
        `${result.message} (${result.code}). Controlla utente, password e PIN RUPAR in «Credenziali dei servizi».`,
        { codice: 'CREDENZIALI_RIFIUTATE', servizio: 'rupar', codiceFascicolo: result.code },
      );
    }
    throw new HttpError(422, `${result.message} (${result.code})`, {
      codiceFascicolo: result.code,
    });
  });

  /**
   * La pagina regionale simulata: al posto del Fascicolo vero, dice per chi e con quale filtro si
   * sarebbe aperta. Il token vale una volta e solo dall'IP che l'ha chiesto, come nelle specifiche.
   */
  if (access instanceof SimulatedRegionalFseAccess) {
    app.get('/api/simulatori/fascicolo', async (req, reply) => {
      const { token } = z.object({ token: z.string().max(100) }).parse(req.query);
      const page = access.open(token, req.ip || null);
      const text =
        page.outcome === 'opened'
          ? `Fascicolo Sanitario Elettronico regionale (simulatore). Qui si aprirebbe il Fascicolo dell’assistito ${page.patientFiscalCode}${
              page.documentType
                ? `, con i documenti di tipo ${FSE_DOCUMENT_TYPES[page.documentType]}`
                : ''
            }.`
          : `Fascicolo Sanitario Elettronico regionale (simulatore). ${page.message} (${page.code}).`;
      return reply
        .status(page.outcome === 'opened' ? 200 : 403)
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'no-store')
        .send(
          `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Fascicolo regionale (simulatore)</title></head><body><p>${escapeHtml(text)}</p></body></html>`,
        );
    });
  }
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
