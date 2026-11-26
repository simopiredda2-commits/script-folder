import { isDocumentTypeOf, type RegionalFseAccess } from '@mmg/integrations';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { createCredentialService } from '../credentials/service';
import type { Database } from '../db/client';
import { guardPatient } from '../patients/access';
import type { RegionalChoice } from '../regions/integrations';
import { studioRegion } from '../regions/region';
import { HttpError } from './errors';

const params = z.object({ id: z.uuid() });
const body = z
  .object({
    /** Filtro dell'elenco dei documenti (TIPO_DOCUMENTO delle specifiche); vuoto per tutti. */
    tipoDocumento: z.string().trim().max(40).nullable().optional(),
  })
  .strict();

/** Quando la regione dello studio non ha, nel programma, l'apertura del suo Fascicolo (D297). */
export const NO_REGIONAL_FSE_ACCESS =
  'La regione dello studio non ha ancora, nel programma, l’apertura del suo Fascicolo dalla cartella';

export interface FseAccessDeps {
  db: Database;
  credentials: Pick<ReturnType<typeof createCredentialService>, 'authFor' | 'authRefused'>;
  /** L'apertura del Fascicolo della regione dello studio (D297). */
  access: RegionalChoice<RegionalFseAccess>;
  environment: 'prova' | 'produzione';
}

/**
 * Aprire il Fascicolo regionale del paziente dalla cartella (D220), con il servizio di accesso
 * della regione dello studio del medico (D297): il servizio chiede il token con le credenziali del
 * medico e restituisce l'indirizzo da aprire, che vale una volta. Ogni richiesta resta nel registro
 * degli accessi alla cartella.
 */
export function registerFseAccessRoutes(app: FastifyInstance, deps: FseAccessDeps) {
  const { db, credentials, environment } = deps;
  const scoped = { config: { patientScoped: true } };
  // Il simulatore non apre il Fascicolo vero: in produzione resta spento (regola 7).
  const activeFor = (access: RegionalFseAccess) =>
    !(access.environment === 'simulator' && environment === 'produzione');
  const accessOf = async (studioId: string) => deps.access.for(await studioRegion(db, studioId));

  /**
   * Per la pagina: i filtri e le parole della regione dello studio, e com'è il collegamento. Per
   * una regione senza pacchetto, solo la nota: la pagina non mostra il modulo.
   */
  app.get('/api/fascicolo-regionale', async (req) => {
    const access = await accessOf(req.actor!.studioId);
    if (!access)
      return { tipiDocumento: [], simulato: false, attivo: false, nota: NO_REGIONAL_FSE_ACCESS };
    return {
      tipiDocumento: Object.entries(access.documentTypes).map(([codice, nome]) => ({
        codice,
        nome,
      })),
      simulato: access.environment === 'simulator',
      attivo: activeFor(access),
      testi: {
        introduzione: access.texts.intro,
        simulato: access.texts.simulated,
        nonAttivo: access.texts.notActive,
      },
    };
  });

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
    const access = await accessOf(actor.studioId);
    if (!access) throw new HttpError(503, NO_REGIONAL_FSE_ACCESS);
    if (documentType !== null && !isDocumentTypeOf(access, documentType))
      throw new HttpError(400, 'Tipo di documento non previsto dalle specifiche del Fascicolo');
    if (!activeFor(access)) throw new HttpError(503, access.texts.notActive);
    // Credenziali del medico per i servizi della regione; se mancano, l'errore porta a
    // «Credenziali dei servizi».
    const auth = await credentials.authFor(actor.userId, 'fascicolo_regionale');
    const result = await access.authenticate(
      { patientFiscalCode: pt.fiscalCode, clientIp: req.ip || null, documentType },
      auth,
    );
    if (result.outcome === 'success')
      return { indirizzo: result.url, simulato: access.environment === 'simulator' };
    if (result.outcome === 'unreachable')
      throw new HttpError(503, `${result.message}: riprova più tardi`);
    // Credenziali rifiutate o incomplete, come le dice il servizio della regione: si annota, come
    // per gli invii (D102), e si porta il medico alla pagina.
    if (result.outcome === 'credentials') {
      await credentials.authRefused(
        { userId: actor.userId, workstation: actor.workstation },
        'fascicolo_regionale',
        'credentials',
        `${result.code}: ${result.message}`,
      );
      throw new HttpError(422, `${result.message} (${result.code}). ${access.texts.credentials}`, {
        codice: 'CREDENZIALI_RIFIUTATE',
        servizio: access.credentialService,
        codiceFascicolo: result.code,
      });
    }
    throw new HttpError(422, `${result.message} (${result.code})`, {
      codiceFascicolo: result.code,
    });
  });

  /**
   * La pagina regionale simulata: al posto del Fascicolo vero, dice per chi e con quale filtro si
   * sarebbe aperta, con le parole del simulatore della regione. Il token vale una volta; un token
   * che nessun simulatore ha dato apre la pagina d'errore del primo. Senza simulatori la pagina non
   * c'è.
   */
  app.get('/api/simulatori/fascicolo', async (req, reply) => {
    const simulators = deps.access.created().filter((a) => 'simulatedPage' in a);
    if (simulators.length === 0) return reply.callNotFound();
    const { token } = z.object({ token: z.string().max(100) }).parse(req.query);
    const pages = simulators.map((a) => a.simulatedPage!(token, req.ip || null));
    const page = pages.find((p) => p.status === 200) ?? pages[0]!;
    return reply
      .status(page.status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'no-store')
      .send(
        `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Fascicolo regionale (simulatore)</title></head><body><p>${escapeHtml(page.text)}</p></body></html>`,
      );
  });
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
