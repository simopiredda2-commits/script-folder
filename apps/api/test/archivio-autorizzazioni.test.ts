import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAccessLog } from '../src/audit/access-log';
import {
  accessLog,
  appUser,
  archiveGrant,
  changeHistory,
  doctorProfile,
  patient,
  studio,
} from '../src/db/schema';
import { startOfStudioDay } from '../src/http/today-routes';
import { studioDayFrom } from './helpers/dates';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** Drizzle avvolge l'errore di Postgres: il messaggio del trigger sta in `cause`. */
async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const e = err as { message: string; cause?: { message: string } };
    expect(e.cause?.message ?? e.message).toMatch(pattern);
    return;
  }
  throw new Error(`Doveva fallire con ${pattern}`);
}

/**
 * Le rotte dei pazienti decidono con l'ora vera, le autorizzazioni con l'orologio delle prove, che
 * a ogni accesso avanza di 30 secondi: dopo gli accessi lo si riporta all'ora vera, così anche
 * vicino a mezzanotte «oggi» è lo stesso giorno per tutti e due.
 */
function alignClock(s: Scenario) {
  s.clock.advance(Date.now() - s.clock.now().getTime());
}

const romeFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Rome',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** L'istante in cui a Roma è quel giorno a quell'ora, anche nei giorni del cambio dell'ora. */
function romeTime(date: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const base = startOfStudioDay(date).getTime() + (h! * 60 + m!) * 60_000;
  for (const shift of [0, -3_600_000, 3_600_000]) {
    const t = new Date(base + shift);
    if (romeFormat.format(t) === `${date} ${hhmm}`) return t;
  }
  throw new Error(`Ora che a Roma non c'è: ${date} ${hhmm}`);
}

type Who = keyof Scenario['users'];
const EVERYONE: Who[] = ['titolare', 'collega', 'segreteria', 'sostituto', 'amministratore'];

const call = (
  s: Scenario,
  cookie: string,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
) => s.app.inject({ method, url, headers: { cookie }, payload });

interface GrantView {
  id: string;
  medico: { id: string; nome: string };
  tipo: { codice: string; nome: string };
  dal: string;
  al: string;
  inizio: string;
  fine: string;
  motivo: string;
  stato: { codice: string; nome: string };
  revocabile: boolean;
}
interface AdminRow {
  numero: number;
  quando: string;
  utente: string | null;
  postazione: string | null;
  area: string;
  azione: string;
  dettaglio: string | null;
  esito: string;
}
interface Alert {
  tipo: string;
  utente: { id: string; nome: string; studio: string | null; io: boolean };
  giorno: string;
  conteggio: number;
  cartelle: number;
  soglia: number | null;
  fascia: { dalle: number; alle: number } | null;
  descrizione: string;
}

/**
 * Archivio del titolare (tappa 14): autorizzazioni a sostituti e colleghi di gruppo, registro delle
 * azioni di amministrazione, avvisi sugli accessi anomali, dati dell'AFT. Due studi inventati nello
 * stesso database: il secondo serve per la separazione dei dati e per gli avvisi.
 */
describe('archivio del titolare: autorizzazioni, registro di amministrazione, avvisi, AFT', () => {
  let t: TestDatabase;
  let s: Scenario;
  let other: Scenario;
  const c = {} as Record<Who, string>;
  const o = {} as Record<Who, string>;
  let seededGrant = '';
  let suspendedId = '';

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, { name: 'Studio di gruppo di prova' });
    other = await createScenario(t.db, { name: 'Altro studio di prova' });
    for (const who of EVERYONE) c[who] = await login(s, who);
    for (const who of EVERYONE) o[who] = await login(other, who);
    alignClock(s);
    alignClock(other);
    const [g] = await t.db
      .select()
      .from(archiveGrant)
      .where(eq(archiveGrant.archiveId, s.archives.titolare));
    seededGrant = g!.id;
  });
  afterAll(async () => {
    await s?.app.close();
    await other?.app.close();
    await t?.drop();
  });

  const grantsUrl = () => `/api/archivi/${s.archives.titolare}/autorizzazioni`;
  const doctorsUrl = () => `/api/archivi/${s.archives.titolare}/medici-autorizzabili`;
  const day = (offset: number) => studioDayFrom(s.clock.now(), offset);
  const body = (over: Record<string, unknown> = {}) => ({
    medico: s.users.sostituto.id,
    tipo: 'substitution',
    dal: day(0),
    al: day(6),
    motivo: 'Ferie estive del titolare',
    ...over,
  });
  const grantCount = async () =>
    (
      await t.db
        .select({ id: archiveGrant.id })
        .from(archiveGrant)
        .where(eq(archiveGrant.archiveId, s.archives.titolare))
    ).length;

  describe('autorizzazioni sull’archivio', () => {
    it('solo il titolare le vede e le dà sul proprio archivio; ogni rifiuto è nel registro', async () => {
      for (const who of ['sostituto', 'segreteria', 'amministratore', 'collega'] as const) {
        const attempts = [
          ['GET', grantsUrl(), undefined],
          ['GET', doctorsUrl(), undefined],
          ['POST', grantsUrl(), body()],
          ['POST', `${grantsUrl()}/${seededGrant}/revoca`, undefined],
        ] as const;
        for (const [method, url, payload] of attempts) {
          const res = await call(s, c[who], method, url, payload);
          expect(res.statusCode, `${who} ${method} ${url}`).toBe(403);
          expect(res.json().errore).toMatch(/solo il medico titolare/);
        }
      }
      const refusals = await t.db
        .select()
        .from(accessLog)
        .where(
          and(
            eq(accessLog.studioId, s.studioId),
            inArray(accessLog.action, ['autorizzazione_archivio', 'revoca_autorizzazione']),
            eq(accessLog.outcome, 'negato'),
          ),
        );
      expect(refusals).toHaveLength(16);
      for (const r of refusals) {
        expect(r.patientId).toBeNull();
        expect(r.details).toMatchObject({
          archivio: s.archives.titolare,
          permesso: 'archive.grants',
          motivo: expect.any(String),
        });
      }
      expect(await grantCount()).toBe(1);
      // Il titolare sì; il collega sul suo archivio, dove nessuno è autorizzato.
      expect((await call(s, c.titolare, 'GET', grantsUrl())).statusCode).toBe(200);
      const own = await call(
        s,
        c.collega,
        'GET',
        `/api/archivi/${s.archives.collega}/autorizzazioni`,
      );
      expect(own.statusCode, own.body).toBe(200);
      expect(own.json().autorizzazioni).toEqual([]);
      // Il titolare di un altro studio non vede l'archivio.
      expect((await call(other, o.titolare, 'GET', grantsUrl())).statusCode).toBe(403);
    });

    it('medici autorizzabili: i sostituti per la sostituzione, gli altri titolari per il gruppo; mai sé stessi né i sospesi', async () => {
      const [suspended] = await t.db
        .insert(appUser)
        .values({
          studioId: s.studioId,
          username: 'sostituto-sospeso-di-prova',
          displayName: 'Dott. Sospeso di prova',
          passwordHash: 'non-usata',
          roles: ['substitute_doctor'],
          status: 'suspended',
        })
        .returning();
      suspendedId = suspended!.id;
      const res = await call(s, c.titolare, 'GET', doctorsUrl());
      expect(res.statusCode, res.body).toBe(200);
      const tipi = res.json().tipi as {
        codice: string;
        nome: string;
        medici: { id: string; nome: string; codiceRegionale: string | null }[];
        nota: string | null;
      }[];
      expect(tipi.map((x) => [x.codice, x.nome])).toEqual([
        ['substitution', 'Sostituzione'],
        ['group_colleague', 'Medicina di gruppo'],
      ]);
      expect(tipi[0]!.medici).toEqual([
        { id: s.users.sostituto.id, nome: 'Dott. Marco Fiore', codiceRegionale: 'MMG-PROVA-3' },
      ]);
      expect(tipi[1]!.medici).toEqual([
        { id: s.users.collega.id, nome: 'Dott. Paolo Serra', codiceRegionale: 'MMG-PROVA-2' },
      ]);
      expect(tipi.map((x) => x.nota)).toEqual([null, null]);
      // Per il collega, sul suo archivio: il titolare dell'altro archivio, mai sé stesso.
      const colleague = await call(
        s,
        c.collega,
        'GET',
        `/api/archivi/${s.archives.collega}/medici-autorizzabili`,
      );
      expect(colleague.json().tipi[1].medici.map((m: { id: string }) => m.id)).toEqual([
        s.users.titolare.id,
      ]);
    });

    it('tipo coerente con il ruolo, medico dello studio, date e motivo', async () => {
      const cases: [object, number, RegExp][] = [
        [body({ medico: s.users.collega.id }), 400, /ruolo di sostituto/],
        [body({ tipo: 'group_colleague' }), 400, /altro medico titolare/],
        [body({ medico: s.users.segreteria.id }), 400, /ruolo di sostituto/],
        [
          body({ medico: s.users.amministratore.id, tipo: 'group_colleague' }),
          400,
          /altro medico titolare/,
        ],
        [body({ medico: s.users.titolare.id }), 400, /sei il titolare/],
        [body({ medico: suspendedId }), 409, /sospeso/],
        [body({ medico: other.users.sostituto.id }), 404, /non trovato nello studio/],
        [body({ medico: randomUUID() }), 404, /non trovato nello studio/],
        [body({ dal: day(-1) }), 400, /non può cominciare nel passato/],
        [body({ dal: day(3), al: day(2) }), 400, /prima dell’inizio/],
        [body({ al: '2027-02-30' }), 400, /Al: una data valida/],
        [body({ dal: '19/11/2026' }), 400, /Dal: una data valida/],
        [body({ motivo: 'Ferie' }), 400, /almeno 10 caratteri/],
        [body({ motivo: 'x'.repeat(301) }), 400, /al massimo 300/],
        [body({ tipo: 'altro' }), 400, /Tipo: sostituzione o medicina di gruppo/],
        [body({ medico: 'non-un-id' }), 400, /Medico: da scegliere/],
        [{ ...body(), extra: true }, 400, /extra/],
      ];
      for (const [b, status, message] of cases) {
        const res = await call(s, c.titolare, 'POST', grantsUrl(), b);
        expect(res.statusCode, `${JSON.stringify(b)} → ${res.body}`).toBe(status);
        expect(res.json().errore).toMatch(message);
      }
      expect(await grantCount()).toBe(1);
    });

    it('medicina di gruppo solo in uno studio di gruppo (D18)', async () => {
      await t.db.update(studio).set({ kind: 'single' }).where(eq(studio.id, s.studioId));
      try {
        const res = await call(
          s,
          c.titolare,
          'POST',
          grantsUrl(),
          body({ medico: s.users.collega.id, tipo: 'group_colleague' }),
        );
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().errore).toMatch(/non è di medicina di gruppo/);
        const group = (await call(s, c.titolare, 'GET', doctorsUrl())).json().tipi[1];
        expect(group.medici).toEqual([]);
        expect(group.nota).toMatch(/non è di medicina di gruppo/);
      } finally {
        await t.db.update(studio).set({ kind: 'group' }).where(eq(studio.id, s.studioId));
      }
      expect(await grantCount()).toBe(1);
    });

    it('un’autorizzazione apre l’archivio al sostituto solo nel periodo, e la revoca lo chiude subito', async () => {
      const opens = async () =>
        (await call(s, c.sostituto, 'GET', `/api/pazienti/${s.richPatient}`)).statusCode;
      const listed = async () =>
        (
          (await call(s, c.sostituto, 'GET', '/api/pazienti')).json().pazienti as { id: string }[]
        ).map((p) => p.id);
      const list = async () =>
        (await call(s, c.titolare, 'GET', grantsUrl())).json().autorizzazioni as GrantView[];

      // L'autorizzazione dello scenario, da ieri a domani: l'archivio è aperto.
      expect(await opens()).toBe(200);
      expect(await list()).toEqual([
        expect.objectContaining({
          id: seededGrant,
          medico: { id: s.users.sostituto.id, nome: 'Dott. Marco Fiore' },
          tipo: { codice: 'substitution', nome: 'Sostituzione' },
          motivo: 'Ferie del titolare',
          stato: { codice: 'attiva', nome: 'Attiva' },
          revocabile: true,
        }),
      ]);
      const revoked = await call(s, c.titolare, 'POST', `${grantsUrl()}/${seededGrant}/revoca`);
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(revoked.json().autorizzazione).toMatchObject({
        stato: { codice: 'revocata', nome: 'Revocata' },
        revocabile: false,
        revocataIl: expect.any(String),
      });
      // Chiuso subito: niente cartella, niente elenco.
      expect(await opens()).toBe(403);
      expect(await listed()).toEqual([]);
      const again = await call(s, c.titolare, 'POST', `${grantsUrl()}/${seededGrant}/revoca`);
      expect(again.statusCode).toBe(409);
      expect(again.json().errore).toMatch(/già revocata/);

      // Futura: non apre ancora.
      const future = await call(
        s,
        c.titolare,
        'POST',
        grantsUrl(),
        body({ dal: day(2), al: day(9) }),
      );
      expect(future.statusCode, future.body).toBe(201);
      expect(future.json().autorizzazione.stato.codice).toBe('futura');
      expect(await opens()).toBe(403);

      // Da oggi: apre, per giorni interi dello studio.
      const current = await call(s, c.titolare, 'POST', grantsUrl(), body());
      expect(current.statusCode, current.body).toBe(201);
      const g = current.json().autorizzazione as GrantView & { concessaDa: string };
      expect(g).toMatchObject({
        dal: day(0),
        al: day(6),
        stato: { codice: 'attiva' },
        motivo: 'Ferie estive del titolare',
        concessaDa: 'Dott.ssa Elena Marchi',
        revocabile: true,
      });
      expect(g.inizio).toBe(startOfStudioDay(day(0)).toISOString());
      expect(g.fine).toBe(new Date(startOfStudioDay(day(7)).getTime() - 1).toISOString());
      expect(await opens()).toBe(200);
      expect(await listed()).toContain(s.richPatient);

      // Le attive e le future prima, poi le altre.
      expect((await list()).map((x) => [x.id, x.stato.codice])).toEqual([
        [g.id, 'attiva'],
        [future.json().autorizzazione.id, 'futura'],
        [seededGrant, 'revocata'],
      ]);

      // Revoca: chiude subito.
      const closed = await call(s, c.titolare, 'POST', `${grantsUrl()}/${g.id}/revoca`);
      expect(closed.statusCode, closed.body).toBe(200);
      expect(await opens()).toBe(403);
      // Anche la futura si revoca prima che cominci.
      const futureId = future.json().autorizzazione.id as string;
      expect(
        (await call(s, c.titolare, 'POST', `${grantsUrl()}/${futureId}/revoca`)).statusCode,
      ).toBe(200);
      // Un'autorizzazione che non è di questo archivio non si trova.
      const elsewhere = await call(s, c.titolare, 'POST', `${grantsUrl()}/${randomUUID()}/revoca`);
      expect(elsewhere.statusCode).toBe(404);
    });

    it('una scaduta non si revoca; nessuna si cancella; lo storico dice chi ha concesso e revocato', async () => {
      const dayMs = 86_400_000;
      const [expired] = await t.db
        .insert(archiveGrant)
        .values({
          archiveId: s.archives.titolare,
          granteeUserId: s.users.sostituto.id,
          kind: 'substitution',
          validFrom: new Date(Date.now() - 10 * dayMs),
          validTo: new Date(Date.now() - 3 * dayMs),
          reason: 'Sostituzione passata di prova',
          grantedBy: s.users.titolare.id,
        })
        .returning();
      const view = (
        (await call(s, c.titolare, 'GET', grantsUrl())).json().autorizzazioni as GrantView[]
      ).find((x) => x.id === expired!.id);
      expect(view).toMatchObject({
        stato: { codice: 'scaduta', nome: 'Scaduta' },
        revocabile: false,
      });
      const res = await call(s, c.titolare, 'POST', `${grantsUrl()}/${expired!.id}/revoca`);
      expect(res.statusCode).toBe(409);
      expect(res.json().errore).toMatch(/già scaduta/);
      expect((await call(s, c.sostituto, 'GET', `/api/pazienti/${s.richPatient}`)).statusCode).toBe(
        403,
      );

      await rejectsWith(t.db.execute(sql`delete from archive_grant`), /si revoca/);

      const created = await t.db
        .select()
        .from(accessLog)
        .where(
          and(
            eq(accessLog.studioId, s.studioId),
            eq(accessLog.action, 'autorizzazione_archivio'),
            eq(accessLog.outcome, 'riuscito'),
          ),
        );
      const ids = created.map((r) => (r.details as { autorizzazione: string }).autorizzazione);
      expect(ids).toHaveLength(2);
      const history = await t.db
        .select()
        .from(changeHistory)
        .where(
          and(eq(changeHistory.tableName, 'archive_grant'), inArray(changeHistory.rowId, ids)),
        );
      expect(history.map((h) => [h.operation, h.userId]).sort()).toEqual(
        [
          ['INSERT', s.users.titolare.id],
          ['INSERT', s.users.titolare.id],
          ['UPDATE', s.users.titolare.id],
          ['UPDATE', s.users.titolare.id],
        ].sort(),
      );
    });

    it('medicina di gruppo: il collega titolare lavora sull’archivio nel periodo, senza registro né autorizzazioni', async () => {
      const res = await call(
        s,
        c.titolare,
        'POST',
        grantsUrl(),
        body({
          medico: s.users.collega.id,
          tipo: 'group_colleague',
          motivo: 'Copertura reciproca nel gruppo',
        }),
      );
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().autorizzazione.tipo).toEqual({
        codice: 'group_colleague',
        nome: 'Medicina di gruppo',
      });
      const opens = async () =>
        (await call(s, c.collega, 'GET', `/api/pazienti/${s.richPatient}`)).statusCode;
      expect(await opens()).toBe(200);
      // Il registro e le autorizzazioni restano al titolare (D21).
      expect(
        (await call(s, c.collega, 'GET', `/api/pazienti/${s.richPatient}/registro`)).statusCode,
      ).toBe(403);
      expect((await call(s, c.collega, 'GET', grantsUrl())).statusCode).toBe(403);
      const revoked = await call(
        s,
        c.titolare,
        'POST',
        `${grantsUrl()}/${res.json().autorizzazione.id}/revoca`,
      );
      expect(revoked.statusCode).toBe(200);
      expect(await opens()).toBe(403);
    });

    it('ogni concessione e revoca è nel registro: chi, quale medico, tipo e periodo; mai il motivo né dati dei pazienti', async () => {
      const rows = await t.db
        .select()
        .from(accessLog)
        .where(
          and(
            eq(accessLog.studioId, s.studioId),
            inArray(accessLog.action, ['autorizzazione_archivio', 'revoca_autorizzazione']),
            eq(accessLog.outcome, 'riuscito'),
          ),
        );
      expect(rows.filter((r) => r.action === 'autorizzazione_archivio')).toHaveLength(3);
      expect(rows.filter((r) => r.action === 'revoca_autorizzazione')).toHaveLength(4);
      for (const r of rows) {
        expect(r.patientId).toBeNull();
        expect(r.userId).toBe(s.users.titolare.id);
        expect(r.workstation).toBe('postazione-titolare');
        expect(r.details).toMatchObject({
          archivio: s.archives.titolare,
          medico: expect.any(String),
          tipo: expect.stringMatching(/^(substitution|group_colleague)$/),
          dal: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
          al: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        });
        expect(JSON.stringify(r.details)).not.toMatch(/Ferie estive|Copertura reciproca/);
      }
      expect(await verifyAccessLog(t.db)).toBeNull();
    });
  });

  describe('dati dell’AFT', () => {
    let aftId = '';
    const patch = (cookie: string, payload: object) =>
      call(s, cookie, 'PATCH', `/api/aft/${aftId}`, payload);

    beforeAll(async () => {
      // Codice regionale distinto dagli altri studi: lo scenario usa sempre gli stessi.
      await t.db
        .update(doctorProfile)
        .set({ regionalCode: 'MMG-PROVA-S2' })
        .where(eq(doctorProfile.userId, s.users.collega.id));
      const created = await call(s, c.titolare, 'POST', '/api/aft', {
        nome: 'AFT di prova',
        asl: 'ASL di prova',
      });
      expect(created.statusCode, created.body).toBe(201);
      aftId = created.json().id;
    });

    it('nome, ASL e codice li cambia un medico titolare che ne fa parte', async () => {
      for (const who of ['collega', 'segreteria', 'amministratore', 'sostituto'] as const) {
        const res = await patch(c[who], { nome: 'AFT cambiata da chi non può' });
        expect(res.statusCode, who).toBe(403);
      }
      const ok = await patch(c.titolare, {
        nome: 'AFT Torino Nord di prova',
        asl: '',
        codice: 'AFT-01',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().aft).toEqual({
        id: aftId,
        nome: 'AFT Torino Nord di prova',
        asl: null,
        codice: 'AFT-01',
      });
      expect((await call(s, c.titolare, 'GET', '/api/aft')).json().aft).toMatchObject({
        nome: 'AFT Torino Nord di prova',
        asl: null,
        codice: 'AFT-01',
      });
      // Gli stessi valori: niente da registrare.
      expect((await patch(c.titolare, { codice: 'AFT-01' })).statusCode).toBe(200);
      for (const bad of [{}, { nome: 'AB' }, { nome: 'AFT', altro: 1 }, { codice: 'x'.repeat(41) }])
        expect((await patch(c.titolare, bad)).statusCode, JSON.stringify(bad)).toBe(400);

      // Invitato ma non ancora entrato: no. Entrato: sì. Uscito: no.
      const invited = await call(s, c.titolare, 'POST', `/api/aft/${aftId}/inviti`, {
        codiceRegionale: 'MMG-PROVA-S2',
      });
      expect(invited.statusCode, invited.body).toBe(201);
      expect((await patch(c.collega, { codice: 'AFT-02' })).statusCode).toBe(403);
      const invitation = (await call(s, c.collega, 'GET', '/api/aft')).json().inviti[0].id;
      expect(
        (await call(s, c.collega, 'POST', `/api/aft/inviti/${invitation}/accetta`)).statusCode,
      ).toBe(200);
      const byColleague = await patch(c.collega, { codice: 'AFT-02' });
      expect(byColleague.statusCode, byColleague.body).toBe(200);
      expect(byColleague.json().aft.codice).toBe('AFT-02');
      // Chi resta membro ma non è più medico titolare (ruolo cambiato dall'amministratore): no.
      await t.db
        .update(appUser)
        .set({ roles: ['substitute_doctor'] })
        .where(eq(appUser.id, s.users.collega.id));
      try {
        expect((await patch(c.collega, { codice: 'AFT-09' })).statusCode).toBe(403);
      } finally {
        await t.db
          .update(appUser)
          .set({ roles: ['owner_doctor'] })
          .where(eq(appUser.id, s.users.collega.id));
      }
      expect((await call(s, c.collega, 'POST', `/api/aft/${aftId}/esci`)).statusCode).toBe(200);
      expect((await patch(c.collega, { codice: 'AFT-03' })).statusCode).toBe(403);

      // Nel registro: i campi cambiati, mai i valori; i rifiuti con il motivo.
      const rows = await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.action, 'impostazioni_aft'), eq(accessLog.studioId, s.studioId)))
        .orderBy(accessLog.seq);
      const done = rows.filter((r) => r.outcome === 'riuscito');
      expect(done.map((r) => [r.userId, (r.details as { campi: string[] }).campi])).toEqual([
        [s.users.titolare.id, ['nome', 'asl', 'codice']],
        [s.users.collega.id, ['codice']],
      ]);
      expect(JSON.stringify(done.map((r) => r.details))).not.toMatch(/Torino|AFT-0/);
      expect(rows.filter((r) => r.outcome === 'negato')).toHaveLength(7);
    });
  });

  describe('registro delle azioni di amministrazione', () => {
    const logUrl = '/api/studio/registro-amministrazione';
    const page = async (cookie: string, query = '') => {
      const res = await call(s, cookie, 'GET', `${logUrl}${query}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ righe: AdminRow[]; prossima: number | null }>();
    };

    it('lo leggono i medici titolari e l’amministratore, non la segreteria né il sostituto', async () => {
      for (const who of ['titolare', 'collega', 'amministratore'] as const)
        expect((await call(s, c[who], 'GET', logUrl)).statusCode, who).toBe(200);
      for (const who of ['segreteria', 'sostituto'] as const) {
        const res = await call(s, c[who], 'GET', logUrl);
        expect(res.statusCode, who).toBe(403);
        expect(res.json().errore).toMatch(/titolari e l’amministratore/);
      }
      const reads = await t.db
        .select()
        .from(accessLog)
        .where(
          and(
            eq(accessLog.studioId, s.studioId),
            eq(accessLog.action, 'lettura_registro_amministrazione'),
          ),
        );
      expect(reads.map((r) => r.outcome).sort()).toEqual([
        'consentito',
        'consentito',
        'consentito',
        'negato',
        'negato',
      ]);
    });

    it('righe in parole: chi, quando, postazione, area, azione e dettaglio, senza dati dei pazienti né valori', async () => {
      // Un'azione sugli utenti come la scrive la sezione «Utenti e ruoli», con i valori di prima e
      // dopo; una riga con un paziente (non dovrebbe esserci: non deve comunque uscire); un cambio
      // della password; le impostazioni dell'archivio lette dal titolare.
      const [p] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
      await t.db.insert(accessLog).values([
        {
          studioId: s.studioId,
          userId: s.users.amministratore.id,
          action: 'amministrazione',
          outcome: 'riuscito',
          workstation: 'postazione-amministratore',
          details: {
            area: 'utenti',
            azione: 'modifica',
            utente: 'Lucia Bassi',
            utenteId: s.users.segreteria.id,
            ruoliPrima: ['secretary'],
            ruoliDopo: ['secretary', 'administrator'],
            campi: ['email', 'ruoli'],
            prima: { email: 'vecchia@esempio.invalid' },
            dopo: { email: 'nuova@esempio.invalid' },
          },
        },
        {
          studioId: s.studioId,
          userId: s.users.amministratore.id,
          patientId: s.richPatient,
          action: 'amministrazione',
          outcome: 'riuscito',
          workstation: 'postazione-amministratore',
          details: {
            area: 'studio',
            azione: 'modifica',
            campi: ['telefono'],
            codiceFiscale: p!.fiscalCode,
          },
        },
      ]);
      await t.db.insert(accessLog).values({
        studioId: s.studioId,
        userId: s.users.segreteria.id,
        action: 'cambio_password',
        outcome: 'riuscito',
        workstation: 'postazione-segreteria',
        details: { obbligato: true, altreSessioniChiuse: 0 },
      });
      expect(
        (await call(s, c.titolare, 'GET', `/api/archivi/${s.archives.titolare}/impostazioni`))
          .statusCode,
      ).toBe(200);

      const res = await call(s, c.amministratore, 'GET', logUrl);
      expect(res.statusCode).toBe(200);
      const { righe } = res.json<{ righe: AdminRow[] }>();
      expect(res.body).not.toMatch(/vecchia@|nuova@/);
      expect(res.body).not.toContain(s.richPatient);
      expect(res.body).not.toContain(p!.fiscalCode);
      expect(righe.map((r) => r.numero)).toEqual(
        [...righe.map((r) => r.numero)].sort((a, b) => b - a),
      );

      expect(
        righe.find((r) => r.area === 'Utenti e ruoli' && r.azione === 'Modifica'),
      ).toMatchObject({
        utente: 'Andrea Conti',
        postazione: 'postazione-amministratore',
        esito: 'riuscito',
        dettaglio:
          'Utente Lucia Bassi · ruoli: Segreteria → Segreteria, Amministratore dello studio · campi cambiati: email, ruoli',
      });
      expect(righe.find((r) => r.area === 'Dati dello studio')).toMatchObject({
        azione: 'Modifica',
        dettaglio: 'Campi cambiati: telefono',
      });
      expect(righe.find((r) => r.azione === 'Cambio della password')).toMatchObject({
        area: 'Utenti e ruoli',
        utente: 'Lucia Bassi',
        dettaglio: 'Password temporanea, al primo accesso',
      });
      expect(righe.find((r) => r.area === 'Impostazioni dell’archivio')).toMatchObject({
        utente: 'Dott.ssa Elena Marchi',
        postazione: 'postazione-titolare',
        esito: 'consentito',
        dettaglio: 'Archivio «Archivio Marchi»',
      });
      const granted = righe.find(
        (r) =>
          r.azione === 'Autorizzazione concessa' && r.dettaglio?.startsWith('Medicina di gruppo'),
      );
      expect(granted).toMatchObject({ utente: 'Dott.ssa Elena Marchi', esito: 'riuscito' });
      expect(granted!.dettaglio).toBe(
        `Medicina di gruppo · Dott. Paolo Serra · dal ${day(0).split('-').reverse().join('/')} al ${day(6).split('-').reverse().join('/')} · archivio «Archivio Marchi»`,
      );
      expect(righe.filter((r) => r.azione === 'Autorizzazione revocata')).toHaveLength(4);
      const refused = righe.filter(
        (r) => r.area === 'Autorizzazioni sull’archivio' && r.esito === 'negato',
      );
      // I 16 della prima prova e il collega di gruppo che chiede l'elenco.
      expect(refused).toHaveLength(17);
      for (const r of refused)
        expect(r.dettaglio).toMatch(/^Archivio «Archivio Marchi» · motivo: /);
      // Un tentativo negato non è un'azione fatta.
      expect(refused.map((r) => r.azione).sort()).toEqual(
        [
          ...Array<string>(5).fill('Consultazione delle autorizzazioni'),
          ...Array<string>(4).fill('Consultazione dei medici autorizzabili'),
          ...Array<string>(4).fill('Concessione di un’autorizzazione'),
          ...Array<string>(4).fill('Revoca di un’autorizzazione'),
        ].sort(),
      );
      expect(
        righe.filter((r) => r.area === 'AFT' && r.esito === 'negato').map((r) => r.azione),
      ).toEqual(Array<string>(7).fill('Modifica dei dati dell’AFT'));
      expect(righe.find((r) => r.area === 'AFT' && r.esito === 'riuscito')).toMatchObject({
        azione: 'Dati dell’AFT modificati',
        dettaglio: 'AFT «AFT Torino Nord di prova» · campi cambiati: codice',
      });
      // Le letture del registro non sono azioni di amministrazione.
      expect(righe.some((r) => r.azione.includes('registro'))).toBe(false);
    });

    it('le impostazioni dell’archivio: consultazione e modifica distinte, con i campi e senza i valori', async () => {
      const url = `/api/archivi/${s.archives.titolare}/impostazioni`;
      expect((await call(s, c.titolare, 'GET', url)).statusCode).toBe(200);
      const patch = await call(s, c.titolare, 'PATCH', url, { segreteriaLeggeDiario: false });
      expect(patch.statusCode, patch.body).toBe(200);
      const righe = (await page(c.titolare, '?limite=10')).righe.filter(
        (r) => r.area === 'Impostazioni dell’archivio',
      );
      expect(righe.slice(0, 2).map((r) => [r.azione, r.dettaglio])).toEqual([
        [
          'Che cosa vede la segreteria: modifica',
          'Archivio «Archivio Marchi» · campi cambiati: segreteria legge diario',
        ],
        ['Che cosa vede la segreteria: consultazione', 'Archivio «Archivio Marchi»'],
      ]);
      expect(JSON.stringify(righe)).not.toMatch(/false|true/);
    });

    it('a pagine, dalle più recenti, solo le righe dello studio', async () => {
      // Un'azione nell'altro studio: non deve comparire.
      expect(
        (
          await call(
            other,
            o.titolare,
            'GET',
            `/api/archivi/${other.archives.titolare}/impostazioni`,
          )
        ).statusCode,
      ).toBe(200);
      const expected = (
        await t.db
          .select({ seq: accessLog.seq })
          .from(accessLog)
          .where(
            and(
              eq(accessLog.studioId, s.studioId),
              inArray(accessLog.action, [
                'amministrazione',
                'autorizzazione_archivio',
                'revoca_autorizzazione',
                'cambio_password',
                'impostazioni_archivio',
                'impostazioni_aft',
              ]),
            ),
          )
      )
        .map((r) => r.seq)
        .sort((a, b) => b - a);
      expect(expected.length).toBeGreaterThan(10);
      const seen: number[] = [];
      let cursor: number | null = null;
      let pages = 0;
      do {
        const p = await page(c.titolare, `?limite=4${cursor ? `&prima=${cursor}` : ''}`);
        expect(p.righe.length).toBeLessThanOrEqual(4);
        seen.push(...p.righe.map((r) => r.numero));
        cursor = p.prossima;
        pages++;
      } while (cursor !== null && pages < 50);
      expect(seen).toEqual(expected);
      for (const bad of ['?limite=0', '?limite=201', '?prima=0', '?prima=abc'])
        expect((await call(s, c.titolare, 'GET', `${logUrl}${bad}`)).statusCode, bad).toBe(400);
    });
  });

  describe('avvisi sugli accessi anomali', () => {
    const url = (query = '') => `/api/archivi/${other.archives.titolare}/avvisi-accessi${query}`;
    const read = async (query = '') => {
      const res = await call(other, o.titolare, 'GET', url(query));
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{
        periodo: { giorni: number; dal: string; al: string };
        regole: { codice: string; stato: string; soglia: string | null }[];
        daCompletare: string[];
        nonValide: string[];
        fonte: string;
        avvisi: Alert[];
      }>();
    };
    const thresholds = (v: Partial<typeof studio.$inferInsert>) =>
      t.db
        .update(studio)
        .set({
          alertDailyRecords: null,
          alertNightFromHour: null,
          alertNightToHour: null,
          alertAftDaily: null,
          ...v,
        })
        .where(eq(studio.id, other.studioId));
    const compact = (a: Alert[]) =>
      a.map((x) => [x.tipo, x.utente.id, x.giorno, x.conteggio, x.cartelle]);

    let d1 = '';
    let d2 = '';
    let d40 = '';
    beforeAll(async () => {
      d1 = studioDayFrom(other.clock.now(), -1);
      d2 = studioDayFrom(other.clock.now(), -2);
      d40 = studioDayFrom(other.clock.now(), -40);
      const P = other.patients.titolare;
      const u = other.users;
      const aftColleague = s.users.titolare.id;
      const rows: [string, string, string, string, string?, string?][] = [
        // La segreteria apre 4 cartelle diverse l'altro ieri (una due volte).
        [u.segreteria.id, P[0]!, d2, '10:00'],
        [u.segreteria.id, P[1]!, d2, '10:05'],
        [u.segreteria.id, P[2]!, d2, '10:10'],
        [u.segreteria.id, P[3]!, d2, '10:15'],
        [u.segreteria.id, P[0]!, d2, '10:20'],
        // Il sostituto ne apre 3: non più di 3.
        [u.sostituto.id, P[0]!, d2, '10:30'],
        [u.sostituto.id, P[1]!, d2, '10:35'],
        [u.sostituto.id, P[2]!, d2, '10:40'],
        // Il collega dello studio: 2 consultazioni dell'AFT e 2 tentativi negati. Le consultazioni
        // dell'AFT non contano tra le cartelle aperte.
        [u.collega.id, P[3]!, d2, '11:00', 'consultazione_aft'],
        [u.collega.id, P[4]!, d2, '11:05', 'consultazione_aft'],
        [u.collega.id, P[0]!, d2, '11:10', 'apertura_cartella', 'negato'],
        [u.collega.id, P[1]!, d2, '11:15', 'apertura_cartella', 'negato'],
        // Un collega dell'AFT di un altro studio: 3 consultazioni su 2 pazienti, una negata.
        [aftColleague, P[0]!, d2, '15:00', 'consultazione_aft'],
        [aftColleague, P[1]!, d2, '15:05', 'consultazione_aft', 'negato'],
        [aftColleague, P[0]!, d2, '15:10', 'consultazione_aft'],
        // Il titolare: prima delle 10 e alle 12 (fuori dalla fascia 10–12).
        [u.titolare.id, P[2]!, d2, '09:59'],
        [u.titolare.id, P[2]!, d2, '12:00'],
        // Accessi di notte: 23:30 e 00:10 sono giorni diversi; le 06:00 e le 21:59 sono fuori.
        [u.segreteria.id, P[0]!, d2, '23:30'],
        [u.segreteria.id, P[4]!, d1, '00:10'],
        [u.sostituto.id, P[2]!, d1, '05:59'],
        [u.sostituto.id, P[3]!, d1, '06:00'],
        [u.titolare.id, P[1]!, d1, '21:59'],
        [u.titolare.id, P[1]!, d1, '22:00'],
        // Quaranta giorni fa: fuori dal periodo di 30 giorni.
        [u.segreteria.id, P[0]!, d40, '10:00'],
        [u.segreteria.id, P[1]!, d40, '10:05'],
        [u.segreteria.id, P[2]!, d40, '10:10'],
        [u.segreteria.id, P[3]!, d40, '10:15'],
      ];
      for (const [userId, patientId, date, time, action, outcome] of rows)
        await t.db.insert(accessLog).values({
          studioId: other.studioId,
          userId,
          patientId,
          action: action ?? 'apertura_cartella',
          outcome: outcome ?? 'consentito',
          workstation: 'postazione-di-prova',
          at: romeTime(date, time),
          details: {},
        });
    });

    it('con le soglie vuote nessun calcolo: la risposta dice che cosa completare, con la fonte', async () => {
      await thresholds({});
      const b = await read();
      expect(b.avvisi).toEqual([]);
      expect(b.daCompletare).toEqual([
        'Cartelle diverse aperte da un utente in un giorno',
        'Fascia oraria degli accessi',
        'Consultazioni dell’AFT di un collega in un giorno',
      ]);
      expect(b.nonValide).toEqual([]);
      expect(b.regole.map((r) => [r.codice, r.stato, r.soglia])).toEqual([
        ['cartelle_al_giorno', 'da_completare', null],
        ['fascia_oraria', 'da_completare', null],
        ['consultazioni_aft_al_giorno', 'da_completare', null],
      ]);
      expect(b.fonte).toMatch(/Garante.*dossier sanitario.*4\/6\/2015.*par\. 7, lett\. c/);
      expect(b.periodo).toEqual({
        giorni: 30,
        dal: studioDayFrom(other.clock.now(), -29),
        al: studioDayFrom(other.clock.now(), 0),
      });
      // Una sola ora della fascia: ancora da completare.
      await thresholds({ alertNightFromHour: 22 });
      expect((await read()).daCompletare).toContain('Fascia oraria degli accessi');
    });

    it('li legge solo il titolare dell’archivio; ogni lettura, consentita o negata, va nel registro', async () => {
      for (const who of ['segreteria', 'sostituto', 'amministratore', 'collega'] as const) {
        const res = await call(other, o[who], 'GET', url());
        expect(res.statusCode, who).toBe(403);
        expect(res.json().errore).toMatch(/solo il medico titolare/);
      }
      expect((await call(s, c.titolare, 'GET', url())).statusCode).toBe(403);
      const rows = await t.db
        .select()
        .from(accessLog)
        .where(eq(accessLog.action, 'lettura_avvisi_accessi'));
      expect(rows.filter((r) => r.outcome === 'consentito')).toHaveLength(2);
      expect(rows.filter((r) => r.outcome === 'negato')).toHaveLength(5);
      for (const r of rows) {
        expect(r.patientId).toBeNull();
        expect(r.details).toMatchObject({ archivio: other.archives.titolare, giorni: 30 });
      }
    });

    it('con le soglie impostate: cartelle in un giorno, fascia che passa la mezzanotte, consultazioni dell’AFT', async () => {
      await thresholds({
        alertDailyRecords: 3,
        alertNightFromHour: 22,
        alertNightToHour: 6,
        alertAftDaily: 2,
      });
      const u = other.users;
      const b = await read();
      expect(b.daCompletare).toEqual([]);
      expect(b.regole.map((r) => r.soglia)).toEqual([
        'più di 3 al giorno',
        'dalle 22:00 alle 06:00, comprende la mezzanotte',
        'più di 2 al giorno',
      ]);
      expect(compact(b.avvisi)).toEqual([
        // Ieri, nello stesso tipo e conteggio, per nome: Fiore, Marchi, Bassi.
        ['fascia_oraria', u.sostituto.id, d1, 1, 1],
        ['fascia_oraria', u.titolare.id, d1, 1, 1],
        ['fascia_oraria', u.segreteria.id, d1, 1, 1],
        ['cartelle_al_giorno', u.segreteria.id, d2, 4, 4],
        ['fascia_oraria', u.segreteria.id, d2, 1, 1],
        ['consultazioni_aft_al_giorno', s.users.titolare.id, d2, 3, 2],
      ]);
      const aft = b.avvisi.find((a) => a.tipo === 'consultazioni_aft_al_giorno')!;
      expect(aft.utente).toEqual({
        id: s.users.titolare.id,
        nome: 'Dott.ssa Elena Marchi',
        studio: 'Studio di gruppo di prova',
        io: false,
      });
      expect(aft.soglia).toBe(2);
      expect(aft.descrizione).toBe(
        '3 consultazioni dell’AFT in un giorno, su 2 pazienti: la soglia è più di 2 al giorno',
      );
      const mine = b.avvisi.find((a) => a.utente.id === u.titolare.id)!;
      expect(mine.utente).toMatchObject({ io: true, studio: null });
      expect(mine.fascia).toEqual({ dalle: 22, alle: 6 });
      expect(mine.descrizione).toBe(
        '1 accesso a 1 cartella dalle 22:00 alle 06:00, comprende la mezzanotte',
      );
      expect(b.avvisi.find((a) => a.tipo === 'cartelle_al_giorno')!.descrizione).toBe(
        '4 cartelle diverse in un giorno: la soglia è più di 3 al giorno',
      );

      // Il periodo: 2 giorni (ieri e oggi), poi 60 giorni con quelli di 40 giorni fa.
      expect(compact((await read('?giorni=2')).avvisi)).toEqual(compact(b.avvisi).slice(0, 3));
      expect(compact((await read('?giorni=60')).avvisi)).toEqual([
        ...compact(b.avvisi),
        ['cartelle_al_giorno', u.segreteria.id, d40, 4, 4],
      ]);
      expect((await read('?giorni=1')).avvisi).toEqual([]);
      for (const bad of ['?giorni=0', '?giorni=366', '?giorni=abc'])
        expect((await call(other, o.titolare, 'GET', url(bad))).statusCode, bad).toBe(400);
    });

    it('fascia nello stesso giorno, ora di fine esclusa; soglie non valide segnalate', async () => {
      await thresholds({ alertNightFromHour: 10, alertNightToHour: 12 });
      const u = other.users;
      const b = await read();
      expect(compact(b.avvisi)).toEqual([
        ['fascia_oraria', u.segreteria.id, d2, 5, 4],
        ['fascia_oraria', u.collega.id, d2, 4, 4],
        ['fascia_oraria', u.sostituto.id, d2, 3, 3],
      ]);
      expect(b.daCompletare).toEqual([
        'Cartelle diverse aperte da un utente in un giorno',
        'Consultazioni dell’AFT di un collega in un giorno',
      ]);

      await thresholds({ alertDailyRecords: 0, alertNightFromHour: 5, alertNightToHour: 5 });
      const invalid = await read();
      expect(invalid.avvisi).toEqual([]);
      expect(invalid.nonValide).toEqual([
        'Cartelle diverse aperte da un utente in un giorno',
        'Fascia oraria degli accessi',
      ]);
      expect(invalid.daCompletare).toEqual(['Consultazioni dell’AFT di un collega in un giorno']);
      expect(await verifyAccessLog(t.db)).toBeNull();
    });
  });
});
