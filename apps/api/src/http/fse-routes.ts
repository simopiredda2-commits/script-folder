import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { REGIONAL_REGIMES, V09 } from '@mmg/integrations';
import { z } from 'zod';
import { logAccess } from '../audit/access-log';
import type { Database } from '../db/client';
import { fseSetting } from '../db/schema';
import { withActor } from '../db/tx';
import { settingsIssues, type createPssService } from '../fse/service';
import { HttpError } from './errors';

const patientParams = z.object({ id: z.uuid() });
/**
 * Prima il paziente, per la guardia (che registra l'accesso); l'identificativo del documento lo
 * controlla il servizio dopo la guardia, così anche una richiesta sbagliata resta nel registro.
 */
const ids = (params: unknown) => ({
  id: patientParams.parse(params).id,
  documentoId: (() => {
    const v = (params as { documentoId?: unknown }).documentoId;
    return typeof v === 'string' ? v : '';
  })(),
});

/** Le chiavi di una tabella dei valori, come elenco per zod. */
const keysOf = <T extends Record<string, string>>(t: T) =>
  Object.keys(t) as [keyof T & string, ...(keyof T & string)[]];
const options = (t: Record<string, string>) =>
  Object.entries(t).map(([codice, nome]) => ({ codice, nome }));

const oidText = z
  .string()
  .trim()
  .regex(/^[0-2](\.(0|[1-9]\d*))+$/, 'OID: numeri separati da punti (es. 2.16.840.1.113883.2.9)');
const settingsBody = z
  .object({
    radiceDocumenti: oidText,
    // Repository e invii li assegna il Fascicolo regionale quando pubblica sul Gateway (D280):
    // si possono ancora scrivere, ma non servono.
    repository: z.string().trim().min(1).max(200).optional(),
    radiceInvii: oidText.optional(),
    custode: z
      .object({
        radice: oidText,
        codice: z.string().trim().min(1).max(100),
        nome: z.string().trim().min(1).max(200),
        via: z.string().trim().min(1).max(200),
        comune: z.string().trim().min(1).max(100),
        istat: z
          .string()
          .trim()
          .regex(/^\d{6}$/, 'Codice ISTAT del comune: 6 cifre'),
        provincia: z.string().trim().max(2).optional(),
      })
      .strict(),
    struttura: z
      .string()
      .trim()
      .regex(
        /^[^^]+\^\^\^\^\^&[0-9.]+&ISO\^\^\^\^[^^]+$/,
        'Struttura nel formato XON: NOME^^^^^&OID&ISO^^^^CODICE',
      ),
    // Per il PSS la Regione vuole «ERP» (V09, 5.2.2): non si sceglie più.
    attivitaClinica: z.literal(V09.clinicalActivity).optional(),
    regime: z.enum(keysOf(REGIONAL_REGIMES)),
  })
  .strict();
const suspensionBody = z
  .object({ sospesi: z.boolean(), motivo: z.string().trim().max(500).optional() })
  .strict();

/**
 * Profilo Sanitario Sintetico (tappa 11): rotte della cartella, tutte dalla guardia (registro
 * degli accessi). Impostazioni del Fascicolo dello studio: le legge chi lavora nello studio, le
 * cambia l'amministratore; sono i valori dell'accreditamento («da completare», D133).
 */
export function registerFseRoutes(
  app: FastifyInstance,
  db: Database,
  service: ReturnType<typeof createPssService>,
) {
  const scoped = { config: { patientScoped: true } };
  const base = '/api/pazienti/:id/profilo-sanitario';

  app.get(base, scoped, async (req) =>
    service.overview(req.actor!, patientParams.parse(req.params).id),
  );
  app.post(`${base}/bozza`, scoped, async (req, reply) =>
    reply.status(201).send(await service.compose(req.actor!, patientParams.parse(req.params).id)),
  );
  app.patch(`${base}/:documentoId`, scoped, async (req) => {
    const p = ids(req.params);
    return service.choose(req.actor!, p.id, p.documentoId, req.body);
  });
  app.post(`${base}/:documentoId/valida`, scoped, async (req) => {
    const p = ids(req.params);
    return service.validate(req.actor!, p.id, p.documentoId, req.body);
  });
  app.post(`${base}/:documentoId/firma-e-pubblica`, scoped, async (req) => {
    const p = ids(req.params);
    return service.signAndPublish(req.actor!, p.id, p.documentoId);
  });
  app.post(`${base}/:documentoId/stato`, scoped, async (req) => {
    const p = ids(req.params);
    return service.refreshStatus(req.actor!, p.id, p.documentoId);
  });
  app.post(`${base}/:documentoId/scarta`, scoped, async (req) => {
    const p = ids(req.params);
    return service.discard(req.actor!, p.id, p.documentoId);
  });
  app.post(`${base}/:documentoId/oscuramento`, scoped, async (req) => {
    const p = ids(req.params);
    return service.obscure(req.actor!, p.id, p.documentoId, req.body);
  });
  app.post(`${base}/:documentoId/cancella`, scoped, async (req) => {
    const p = ids(req.params);
    return service.removeFromFse(req.actor!, p.id, p.documentoId, req.body);
  });
  app.get(`${base}/:documentoId/invii`, scoped, async (req) => {
    const p = ids(req.params);
    return { invii: await service.transmissions(req.actor!, p.id, p.documentoId) };
  });
  app.get(`${base}/:documentoId/pdf`, scoped, async (req, reply) => {
    const p = ids(req.params);
    const pdf = await service.pdf(req.actor!, p.id, p.documentoId);
    reply.header('content-type', 'application/pdf');
    reply.header(
      'content-disposition',
      `inline; filename="profilo-sanitario-${pdf.signed ? 'firmato' : 'da-firmare'}.pdf"`,
    );
    reply.header('cache-control', 'no-store');
    return reply.send(Buffer.from(pdf.bytes));
  });

  app.get('/api/studio/fascicolo', async (req) => {
    const [s] = await db
      .select()
      .from(fseSetting)
      .where(eq(fseSetting.studioId, req.actor!.studioId));
    return {
      impostazioni: s
        ? {
            organizzazione: { codice: s.organizationId, nome: s.organizationName },
            radiceDocumenti: s.documentIdRoot,
            repository: s.repositoryId,
            radiceInvii: s.submissionIdRoot,
            custode: {
              radice: s.custodianIdRoot,
              codice: s.custodianIdExtension,
              nome: s.custodianName,
              via: s.custodianStreet,
              comune: s.custodianCity,
              istat: s.custodianIstatCode,
              provincia: s.custodianProvince,
            },
            struttura: s.locality,
            tipologiaStruttura: s.facilityType,
            assettoOrganizzativo: s.practiceSetting,
            // Fissata dalla Regione per il PSS (V09): «ERP».
            attivitaClinica: V09.clinicalActivity,
            regime: s.administrativeRequest,
          }
        : null,
      daCompletare: settingsIssues(s),
      /** Valori ammessi: i regimi della V09 (5.2.2, tabella dei regimi). */
      valori: { regime: options(REGIONAL_REGIMES) },
      /** Invii al Fascicolo regionale sospesi (FSE-INT-SRS-01-V02, 3.4 e 4.5). */
      inviiSospesi: s?.regionalSendingSuspended
        ? { dal: s.regionalSuspendedAt, motivo: s.regionalSuspendedReason }
        : null,
      puoModificare: req.actor!.roles.includes('administrator'),
    };
  });

  /**
   * Sospendere o riprendere gli invii al Fascicolo regionale, per esempio su richiesta del
   * supporto del CSI: i messaggi restano in coda e partono alla ripresa (3.4, 4.5). Solo
   * l'amministratore; ogni cambio resta nel registro delle azioni di amministrazione.
   */
  app.put('/api/studio/fascicolo/invii', async (req) => {
    const actor = req.actor!;
    if (!actor.roles.includes('administrator'))
      throw new HttpError(403, 'Gli invii al Fascicolo li sospende l’amministratore dello studio');
    const b = suspensionBody.parse(req.body);
    const at = new Date();
    await withActor(db, actor.userId, async (tx) => {
      const values = {
        regionalSendingSuspended: b.sospesi,
        regionalSuspendedAt: b.sospesi ? at : null,
        regionalSuspendedReason: b.sospesi ? (b.motivo ?? null) : null,
        updatedAt: at,
        updatedBy: actor.userId,
      };
      await tx
        .insert(fseSetting)
        .values({ studioId: actor.studioId, ...values })
        .onConflictDoUpdate({ target: fseSetting.studioId, set: values });
      await logAccess(tx, {
        studioId: actor.studioId,
        userId: actor.userId,
        patientId: null,
        action: 'amministrazione',
        outcome: 'riuscito',
        workstation: actor.workstation,
        details: {
          area: 'fascicolo',
          azione: b.sospesi ? 'sospensione_invii_fascicolo' : 'ripresa_invii_fascicolo',
          ...(b.motivo ? { motivo: b.motivo } : {}),
        },
      });
    });
    return { sospesi: b.sospesi };
  });

  app.put('/api/studio/fascicolo', async (req) => {
    const actor = req.actor!;
    if (!actor.roles.includes('administrator'))
      throw new HttpError(
        403,
        'Le impostazioni del Fascicolo le cambia l’amministratore dello studio',
      );
    const b = settingsBody.parse(req.body);
    const values = {
      documentIdRoot: b.radiceDocumenti,
      repositoryId: b.repository ?? null,
      submissionIdRoot: b.radiceInvii ?? null,
      custodianIdRoot: b.custode.radice,
      custodianIdExtension: b.custode.codice,
      custodianName: b.custode.nome,
      custodianStreet: b.custode.via,
      custodianCity: b.custode.comune,
      custodianIstatCode: b.custode.istat,
      custodianProvince: b.custode.provincia || null,
      locality: b.struttura,
      clinicalActivity: V09.clinicalActivity,
      administrativeRequest: b.regime,
      updatedAt: new Date(),
      updatedBy: actor.userId,
    };
    await db
      .insert(fseSetting)
      .values({ studioId: actor.studioId, ...values })
      .onConflictDoUpdate({ target: fseSetting.studioId, set: values });
    return { daCompletare: [] };
  });
}
