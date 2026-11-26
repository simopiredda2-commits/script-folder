import { doctorIssues } from '@mmg/domain';
import { and, eq, ne, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { servicesNotice } from '../admin/user-service';
import { ALL_CREDENTIAL_SERVICES } from '../credentials/registry';
import { logAccess } from '../audit/access-log';
import type { Actor } from '../auth/service';
import { closeServiceSessions } from '../credentials/service';
import type { Database } from '../db/client';
import { appUser, doctorProfile } from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from './errors';

const contactsBody = z
  .object({
    /** Nome e cognome come nel codice fiscale, separati (il Profilo li vuole così). */
    nome: z.string().trim().min(1).max(100),
    cognome: z.string().trim().min(1).max(100),
    telefono: z
      .string()
      .trim()
      .max(30)
      .regex(/^[0-9 +./-]*$/, 'Telefono: solo cifre, spazi, «+», «.», «/» e «-»'),
    email: z.union([z.literal(''), z.email().max(200)]),
    pec: z.union([z.literal(''), z.email().max(200)]),
  })
  .strict();

/** La correzione che il medico ha davanti: si conferma o si rifiuta quella, non un'altra. */
const fiscalCodeBody = z.strictObject({
  proposto: z.string({ error: 'Il codice fiscale proposto' }).trim().toUpperCase().max(16),
});

/**
 * Nome, cognome e recapiti di studio del medico collegato (tappa 11): vanno nel Profilo
 * Sanitario Sintetico, che vuole nome e cognome separati e almeno un recapito (schematron,
 * ERRORE-38, ERRORE-40). Li cambia solo il medico stesso. Nome e cognome sono anche quelli che il
 * titolare ha visto alla conferma e che vanno sui documenti: ogni loro cambio va nel registro delle
 * azioni di amministrazione, con i nomi dei campi e mai i valori (tappa 14, dopo la revisione dei
 * poteri dell'amministratore).
 */
export function registerDoctorProfileRoutes(
  app: FastifyInstance,
  db: Database,
  now: () => Date = () => new Date(),
) {
  const doctorOnly = (roles: readonly string[]) => {
    if (!roles.includes('owner_doctor') && !roles.includes('substitute_doctor'))
      throw new HttpError(403, 'I recapiti di studio sono del medico');
  };

  async function read(userId: string) {
    const [p] = await db
      .select({
        cf: doctorProfile.fiscalCode,
        phone: doctorProfile.phone,
        email: doctorProfile.email,
        pec: doctorProfile.pec,
        firstName: doctorProfile.firstName,
        lastName: doctorProfile.lastName,
        pending: doctorProfile.pendingFiscalCode,
        pendingBy: doctorProfile.pendingFiscalCodeBy,
        pendingAt: doctorProfile.pendingFiscalCodeAt,
      })
      .from(appUser)
      .leftJoin(doctorProfile, eq(doctorProfile.userId, appUser.id))
      .where(eq(appUser.id, userId));
    const [by] = p?.pendingBy
      ? await db
          .select({ nome: appUser.displayName })
          .from(appUser)
          .where(eq(appUser.id, p.pendingBy))
      : [];
    return {
      /** Il codice fiscale in uso: lo cambia solo la conferma di una correzione (D181). */
      codiceFiscale: p?.cf ?? null,
      /** Correzione dell'amministratore che aspetta il medico: finché non la conferma vale l'altro. */
      correzioneCodiceFiscale: p?.pending
        ? { proposto: p.pending, da: by?.nome ?? null, il: p.pendingAt?.toISOString() ?? null }
        : null,
      nome: p?.firstName ?? '',
      cognome: p?.lastName ?? '',
      telefono: p?.phone ?? '',
      email: p?.email ?? '',
      pec: p?.pec ?? '',
      /** Che cosa manca per firmare il Profilo. */
      mancaPerIlProfilo: doctorIssues({
        fiscalCode: p?.cf,
        firstName: p?.firstName,
        lastName: p?.lastName,
        phone: p?.phone,
        email: p?.email,
        pec: p?.pec,
      }),
    };
  }

  app.get('/api/profilo/recapiti', async (req) => {
    doctorOnly(req.actor!.roles);
    return read(req.actor!.userId);
  });

  app.put('/api/profilo/recapiti', async (req) => {
    const actor = req.actor!;
    doctorOnly(actor.roles);
    const b = contactsBody.parse(req.body);
    const values = {
      firstName: b.nome,
      lastName: b.cognome,
      phone: b.telefono || null,
      email: b.email || null,
      pec: b.pec || null,
    };
    await withActor(db, actor.userId, async (tx) => {
      const [before] = await tx
        .select({ firstName: doctorProfile.firstName, lastName: doctorProfile.lastName })
        .from(doctorProfile)
        .where(eq(doctorProfile.userId, actor.userId))
        .for('update');
      await tx
        .insert(doctorProfile)
        .values({ userId: actor.userId, ...values })
        .onConflictDoUpdate({ target: doctorProfile.userId, set: values });
      const campi = [
        ...((before?.firstName ?? null) !== values.firstName ? ['medico.nome'] : []),
        ...((before?.lastName ?? null) !== values.lastName ? ['medico.cognome'] : []),
      ];
      if (campi.length === 0) return;
      const [me] = await tx
        .select({ username: appUser.username })
        .from(appUser)
        .where(eq(appUser.id, actor.userId));
      await logAccess(tx, {
        studioId: actor.studioId,
        userId: actor.userId,
        patientId: null,
        action: 'amministrazione',
        outcome: 'riuscito',
        workstation: actor.workstation,
        details: {
          area: 'profilo',
          azione: 'modifica',
          utente: me?.username ?? null,
          utenteId: actor.userId,
          campi,
        },
      });
    });
    return read(actor.userId);
  });

  /**
   * Il medico conferma o rifiuta la correzione del suo codice fiscale fatta dall'amministratore
   * (D181). Si decide su quella che ha davanti: se nel frattempo è cambiata o è stata ritirata, no.
   * Alla conferma il codice cambia e le sessioni dei servizi legate al codice di prima si chiudono.
   */
  async function decideFiscalCode(actor: Actor, body: unknown, accept: boolean) {
    doctorOnly(actor.roles);
    const { proposto } = fiscalCodeBody.parse(body ?? {});
    const t = now();
    return withActor(db, actor.userId, async (tx) => {
      const [p] = await tx
        .select({ pending: doctorProfile.pendingFiscalCode, by: doctorProfile.pendingFiscalCodeBy })
        .from(doctorProfile)
        .where(eq(doctorProfile.userId, actor.userId))
        .for('update');
      if (!p?.pending)
        throw new HttpError(409, 'Nessuna correzione del codice fiscale da confermare');
      if (p.pending !== proposto)
        throw new HttpError(409, 'La correzione è cambiata nel frattempo: rileggi la pagina');
      const cleared = {
        pendingFiscalCode: null,
        pendingFiscalCodeBy: null,
        pendingFiscalCodeAt: null,
      };
      let closed: Awaited<ReturnType<typeof closeServiceSessions>> = [];
      if (accept) {
        // Nessun altro utente dello studio con lo stesso codice, in uso o proposto.
        const clash = await tx
          .select({ id: doctorProfile.userId })
          .from(doctorProfile)
          .innerJoin(appUser, eq(appUser.id, doctorProfile.userId))
          .where(
            and(
              eq(appUser.studioId, actor.studioId),
              ne(doctorProfile.userId, actor.userId),
              or(
                eq(doctorProfile.fiscalCode, proposto),
                eq(doctorProfile.pendingFiscalCode, proposto),
              ),
            ),
          );
        if (clash.length > 0)
          throw new HttpError(
            409,
            'Codice fiscale già di un altro utente dello studio: ne parli con l’amministratore',
          );
        await tx
          .update(doctorProfile)
          .set({ fiscalCode: proposto, ...cleared })
          .where(eq(doctorProfile.userId, actor.userId));
        closed = await closeServiceSessions(tx, {
          userId: actor.userId,
          services: ALL_CREDENTIAL_SERVICES,
          at: t,
          workstation: actor.workstation,
          detail: 'codice fiscale corretto dall’amministratore, confermato dal medico',
        });
      } else {
        await tx.update(doctorProfile).set(cleared).where(eq(doctorProfile.userId, actor.userId));
      }
      const [me] = await tx
        .select({ username: appUser.username })
        .from(appUser)
        .where(eq(appUser.id, actor.userId));
      const [admin] = p.by
        ? await tx.select({ username: appUser.username }).from(appUser).where(eq(appUser.id, p.by))
        : [];
      await logAccess(tx, {
        studioId: actor.studioId,
        userId: actor.userId,
        patientId: null,
        action: 'amministrazione',
        outcome: 'riuscito',
        workstation: actor.workstation,
        details: {
          area: 'profilo',
          azione: accept ? 'conferma_codice_fiscale' : 'rifiuto_codice_fiscale',
          utente: me?.username ?? null,
          utenteId: actor.userId,
          campi: ['medico.codiceFiscale'],
          propostaDa: admin?.username ?? null,
          ...(closed.length > 0 ? { sessioniServiziChiuse: closed } : {}),
        },
      });
      return {
        avvisi: accept
          ? [
              'Codice fiscale aggiornato: da adesso è questo, anche per i servizi.',
              ...(closed.length > 0 ? [servicesNotice('Codice fiscale', closed)] : []),
            ]
          : [
              'Correzione rifiutata: resta il codice fiscale di prima. L’amministratore lo vede nel registro delle azioni di amministrazione.',
            ],
      };
    });
  }

  app.post('/api/profilo/codice-fiscale/conferma', async (req) => {
    const r = await decideFiscalCode(req.actor!, req.body, true);
    return { ...r, ...(await read(req.actor!.userId)) };
  });

  app.post('/api/profilo/codice-fiscale/rifiuta', async (req) => {
    const r = await decideFiscalCode(req.actor!, req.body, false);
    return { ...r, ...(await read(req.actor!.userId)) };
  });
}
