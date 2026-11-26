import type { Action, ServiceUse } from '@mmg/domain';
import {
  CONTEXT_CALL_KINDS,
  isOptionOf,
  type ContextCallKind,
  type RegionalContextCall,
} from '@mmg/integrations';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccessAction } from '../audit/access-log';
import type { createCredentialService } from '../credentials/service';
import type { Database } from '../db/client';
import { guardPatient } from '../patients/access';
import type { RegionalChoice } from '../regions/integrations';
import { studioRegion } from '../regions/region';
import { HttpError } from './errors';

const params = z.object({ id: z.uuid() });
const body = z
  .object({
    /** Le scelte dei parametri della destinazione; una scelta vuota vale «tutti». */
    parametri: z.record(z.string().max(40), z.string().trim().max(40).nullable()).optional(),
  })
  .strict();

/**
 * Per ogni tipo di destinazione: chi la apre (permesso), che cosa resta nel registro degli accessi
 * alla cartella, quali credenziali del medico servono, e che cosa dire quando la regione dello
 * studio non ce l'ha (D297).
 */
export const CONTEXT_CALL_RULES: Record<
  ContextCallKind,
  { permission: Action; log: AccessAction; credentials: ServiceUse; missing: string }
> = {
  fascicolo: {
    permission: 'fse.consult',
    log: 'apertura_fascicolo_regionale',
    credentials: 'fascicolo_regionale',
    missing:
      'La regione dello studio non ha ancora, nel programma, l’apertura del suo Fascicolo dalla cartella',
  },
};

export interface ContextCallDeps {
  db: Database;
  credentials: Pick<ReturnType<typeof createCredentialService>, 'authFor' | 'authRefused'>;
  /** Le destinazioni della regione dello studio (D297). */
  calls: RegionalChoice<readonly RegionalContextCall[]>;
  environment: 'prova' | 'produzione';
}

/**
 * Chiamate di contesto (D220, D297): una pagina dei servizi della regione dello studio del medico,
 * aperta con il contesto del paziente. Il servizio della regione chiede l'accesso con le
 * credenziali del medico e restituisce l'indirizzo da aprire, che vale una volta. Ogni richiesta
 * resta nel registro degli accessi alla cartella, con la voce del suo tipo.
 */
export function registerContextCallRoutes(app: FastifyInstance, deps: ContextCallDeps) {
  const { db, credentials, environment } = deps;
  const scoped = { config: { patientScoped: true } };
  // I simulatori non aprono le pagine vere: in produzione restano spenti (regola 7).
  const activeFor = (call: RegionalContextCall) =>
    !(call.environment === 'simulator' && environment === 'produzione');
  const callsOf = async (studioId: string) =>
    deps.calls.for(await studioRegion(db, studioId)) ?? [];

  /** Per le pagine: le destinazioni della regione dello studio, con parametri e parole. */
  app.get('/api/chiamate-di-contesto', async (req) => ({
    destinazioni: (await callsOf(req.actor!.studioId)).map((c) => ({
      tipo: c.kind,
      parametri: c.parameters.map((p) => ({
        chiave: p.key,
        etichetta: p.label,
        tutti: p.anyLabel,
        valori: Object.entries(p.options).map(([codice, nome]) => ({ codice, nome })),
      })),
      simulato: c.environment === 'simulator',
      attivo: activeFor(c),
      testi: {
        introduzione: c.texts.intro,
        simulato: c.texts.simulated,
        nonAttivo: c.texts.notActive,
      },
    })),
  }));

  // Una rotta per ogni tipo che il nucleo conosce: prima la guardia, che registra l'accesso alla
  // cartella anche quando la richiesta è sbagliata; un tipo sconosciuto non è una rotta (404).
  for (const tipo of CONTEXT_CALL_KINDS)
    app.post(`/api/pazienti/:id/chiamate-di-contesto/${tipo}`, scoped, (req) =>
      openCall(req, tipo),
    );

  async function openCall(req: FastifyRequest, tipo: ContextCallKind) {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const rules = CONTEXT_CALL_RULES[tipo];
    const { patient: pt } = await guardPatient(db, actor, id, rules.permission, rules.log);
    const { parametri = {} } = body.parse(req.body ?? {});
    const call = (await callsOf(actor.studioId)).find((c) => c.kind === tipo);
    if (!call) throw new HttpError(503, rules.missing);
    const chosen: Record<string, string> = {};
    for (const [key, value] of Object.entries(parametri)) {
      const parameter = call.parameters.find((p) => p.key === key);
      if (!parameter) throw new HttpError(400, `Parametro non previsto: «${key}»`);
      if (!value) continue;
      if (!isOptionOf(parameter, value))
        throw new HttpError(400, `Scelta non prevista dalla regione per «${parameter.label}»`);
      chosen[key] = value;
    }
    if (!activeFor(call)) throw new HttpError(503, call.texts.notActive);
    // Credenziali del medico per i servizi della regione; se mancano, l'errore porta a
    // «Credenziali dei servizi».
    const auth = await credentials.authFor(actor.userId, rules.credentials);
    const result = await call.open(
      { patientFiscalCode: pt.fiscalCode, clientIp: req.ip || null, parameters: chosen },
      auth,
    );
    if (result.outcome === 'success')
      return { indirizzo: result.url, simulato: call.environment === 'simulator' };
    if (result.outcome === 'unreachable')
      throw new HttpError(503, `${result.message}: riprova più tardi`);
    // Credenziali rifiutate o incomplete, come le dice il servizio della regione: si annota, come
    // per gli invii (D102), e si porta il medico alla pagina.
    if (result.outcome === 'credentials') {
      await credentials.authRefused(
        { userId: actor.userId, workstation: actor.workstation },
        rules.credentials,
        'credentials',
        `${result.code}: ${result.message}`,
      );
      throw new HttpError(422, `${result.message} (${result.code}). ${call.texts.credentials}`, {
        codice: 'CREDENZIALI_RIFIUTATE',
        servizio: call.credentialService,
        codiceRegione: result.code,
      });
    }
    throw new HttpError(422, `${result.message} (${result.code})`, { codiceRegione: result.code });
  }

  /**
   * La pagina della regione simulata: al posto di quella vera, dice per chi e con quali scelte si
   * sarebbe aperta, con le parole del simulatore. Il token vale una volta; un token che nessun
   * simulatore ha dato apre la pagina d'errore del primo. Senza simulatori la pagina non c'è.
   */
  app.get('/api/simulatori/chiamate-di-contesto', async (req, reply) => {
    const simulators = deps.calls
      .created()
      .flat()
      .filter((c) => 'simulatedPage' in c);
    if (simulators.length === 0) return reply.callNotFound();
    const { token } = z.object({ token: z.string().max(100) }).parse(req.query);
    const pages = simulators.map((c) => c.simulatedPage!(token, req.ip || null));
    const page = pages.find((p) => p.status === 200) ?? pages[0]!;
    return reply
      .status(page.status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'no-store')
      .send(
        `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Servizio della regione (simulatore)</title></head><body><p>${escapeHtml(page.text)}</p></body></html>`,
      );
  });
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
