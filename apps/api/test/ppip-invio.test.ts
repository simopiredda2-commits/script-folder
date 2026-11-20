import type {
  AdditionalServicesPortal,
  AdditionalServicesReport,
  AdditionalServicesResult,
} from '@mmg/integrations';
import { and, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog, patient, ppipRecord, ppipReport } from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { importPpipCatalog } from './helpers/ppip';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { rmSync } from 'node:fs';

/**
 * Il portale delle prove: ferma ogni invio finché la prova non apre, oppure risponde con un errore
 * (il servizio non sa se la distinta è arrivata).
 */
class GatedPortal implements AdditionalServicesPortal {
  readonly environment = 'simulator' as const;
  readonly calls: AdditionalServicesReport[] = [];
  mode: 'accept' | 'throw' = 'accept';
  private gate: Promise<void> | null = null;
  private open: () => void = () => {};
  hold() {
    this.gate = new Promise((r) => (this.open = r));
  }
  release() {
    this.open();
    this.gate = null;
  }
  async submit(report: AdditionalServicesReport): Promise<AdditionalServicesResult> {
    this.calls.push(report);
    if (this.gate) await this.gate;
    if (this.mode === 'throw') throw new Error('Connessione interrotta a metà');
    return { outcome: 'accepted', protocol: `GATE-${this.calls.length}` };
  }
}

interface Riga {
  id: string;
  paziente: string;
  pazienteNellArchivio: boolean;
  codice: string;
  inviata: boolean;
  inInvioDal: string | null;
  protocolloInvio: string | null;
}

/**
 * La distinta delle prestazioni aggiuntive senza gare (D232): l'archivio dove la prestazione è
 * nata, un invio alla volta, nessun annullamento mentre parte, l'invio di ciò che il titolare ha
 * controllato, l'esito di un invio rimasto senza risposta segnato a mano, la consegna fuori dal
 * programma. Orologio fermo al 20/11/2026. Pazienti inventati.
 */
describe('distinta delle prestazioni aggiuntive senza gare (D232)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let work: string;
  let monitor: pg.Client;
  const portal = new GatedPortal();
  const cookies = { titolare: '', collega: '', segreteria: '', sostituto: '' };
  type Who = keyof typeof cookies;
  let mine: (typeof patient.$inferSelect)[];

  const req = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    s.app.inject({
      method,
      url,
      headers: { cookie: cookies[who] },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const register = async (who: Who, patientId: string, data: string, codice = 'A1') => {
    const res = await req(who, 'POST', `/api/pazienti/${patientId}/ppip`, {
      data,
      codice,
      luogo: 'studio',
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const archiveOf = (who: 'titolare' | 'collega') => s.archives[who];
  const distinta = (who: Who, mese: string, archive = archiveOf('titolare')) =>
    req(who, 'GET', `/api/archivi/${archive}/ppip?mese=${mese}`);
  const seen = async (mese: string, archive = archiveOf('titolare')) =>
    ((await distinta('titolare', mese, archive)).json().righe as Riga[])
      .filter((r) => !r.inviata && !r.inInvioDal)
      .map((r) => r.id);
  const send = async (who: Who, mese: string, righe?: string[]) =>
    req(who, 'POST', `/api/archivi/${archiveOf('titolare')}/ppip/invio`, {
      mese,
      righe: righe ?? (await seen(mese)),
    });
  const annul = (who: Who, patientId: string, id: string) =>
    req(who, 'POST', `/api/pazienti/${patientId}/ppip/${id}/annulla`, {
      motivo: 'Registrata per errore',
    });
  const waitFor = async (ok: () => boolean) => {
    for (let i = 0; !ok(); i++) {
      if (i > 400) throw new Error('Attesa troppo lunga');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const reportsOfMonth = (mese: string) =>
    t.db
      .select()
      .from(ppipReport)
      .where(and(eq(ppipReport.archiveId, archiveOf('titolare')), eq(ppipReport.month, mese)));

  beforeAll(async () => {
    t = await createTestDatabase();
    monitor = new pg.Client({ connectionString: t.url });
    await monitor.connect();
    // Senza il blocco per inattività: la prova fa passare l'orologio di 15 minuti.
    s = await createScenario(
      t.db,
      { idleLockMinutes: null },
      { clockAt: new Date('2026-11-20T11:00:00Z'), ppipPortal: portal },
    );
    for (const who of Object.keys(cookies) as Who[]) cookies[who] = await login(s, who);
    const imported = await importPpipCatalog(t.db);
    work = imported.work;
    expect(imported.outcomes).toEqual(['importato', 'importato']);
    mine = await t.db
      .select()
      .from(patient)
      .where(and(eq(patient.archiveId, archiveOf('titolare')), sql`deceased_on is null`))
      .orderBy(patient.lastName, patient.firstName);
    expect(mine.length).toBeGreaterThanOrEqual(3);
  });
  afterAll(async () => {
    await s?.app.close();
    await monitor?.end();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('due invii insieme della stessa distinta: parte una volta sola', async () => {
    await register('titolare', mine[0]!.id, '2026-03-05');
    await register('segreteria', mine[1]!.id, '2026-03-06');
    portal.hold();
    const first = send('titolare', '2026-03');
    await waitFor(() => portal.calls.length === 1);
    const second = await send('titolare', '2026-03');
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().errore).toMatch(/già in corso/);
    // Mentre aspetta il portale, la distinta lo dice.
    const during = (await distinta('titolare', '2026-03')).json();
    expect(during.inInvio).toMatchObject({ interrotto: false, righe: 2 });
    expect(during.daInviare).toBe(0);
    portal.release();
    const done = await first;
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ esito: 'accepted', righe: 2, protocollo: 'GATE-1' });
    expect(portal.calls).toHaveLength(1);
    expect(await reportsOfMonth('2026-03')).toHaveLength(1);
    const after = (await distinta('titolare', '2026-03')).json();
    expect(after.inInvio).toBeNull();
    expect((after.righe as Riga[]).every((r) => r.inviata && r.protocolloInvio === 'GATE-1')).toBe(
      true,
    );
    // Esito e registro insieme: una riga per paziente, a nome di chi ha mandato.
    const logged = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.action, 'invio_distinta_ppip'), eq(accessLog.outcome, 'riuscito')));
    expect(new Set(logged.map((l) => l.patientId))).toEqual(new Set([mine[0]!.id, mine[1]!.id]));
  });

  it('annullamento mentre la distinta parte: no; dopo, la prestazione è partita', async () => {
    const id = await register('titolare', mine[0]!.id, '2026-04-02');
    portal.hold();
    const sending = send('titolare', '2026-04');
    await waitFor(() => portal.calls.length === 2);
    const during = await annul('segreteria', mine[0]!.id, id);
    expect(during.statusCode, during.body).toBe(409);
    expect(during.json().errore).toMatch(/sta partendo con la distinta/);
    portal.release();
    expect((await sending).statusCode).toBe(200);
    const later = await annul('titolare', mine[0]!.id, id);
    expect(later.statusCode).toBe(409);
    expect(later.json().errore).toMatch(/già partita con la distinta GATE-2/);
    const [row] = await t.db.select().from(ppipRecord).where(eq(ppipRecord.id, id));
    expect(row).toMatchObject({ status: 'active', sendingSince: null });
    expect(row!.reportId).toBeTruthy();
  });

  it('l’annullamento aspetta chi tiene la prestazione, e poi la vede com’è', async () => {
    const id = await register('titolare', mine[1]!.id, '2026-05-04');
    // Un altro annullamento in corso: tiene la riga e la annulla, ma non ha ancora finito.
    await monitor.query('begin');
    await monitor.query('select id from ppip_record where id = $1 for update', [id]);
    await monitor.query(
      `update ppip_record set status = 'annulled', annulled_at = now(), annulled_by = $2,
         annul_reason = 'Il primo annullamento' where id = $1`,
      [id, s.users.segreteria.id],
    );
    let settled = false;
    const second = annul('titolare', mine[1]!.id, id).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    await monitor.query('commit');
    const res = await second;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().errore).toBe('La prestazione è già annullata');
    const [row] = await t.db.select().from(ppipRecord).where(eq(ppipRecord.id, id));
    expect(row).toMatchObject({ annulReason: 'Il primo annullamento' });
  });

  it('un annullamento a metà mentre si manda: la distinta va ricontrollata', async () => {
    const id = await register('titolare', mine[2]!.id, '2026-05-20');
    const ids = await seen('2026-05');
    expect(ids).toEqual([id]);
    await monitor.query('begin');
    await monitor.query('select id from ppip_record where id = $1 for update', [id]);
    await monitor.query(
      `update ppip_record set status = 'annulled', annulled_at = now(), annulled_by = $2,
         annul_reason = 'Annullata durante l’invio' where id = $1`,
      [id, s.users.titolare.id],
    );
    const sending = send('titolare', '2026-05', ids);
    await new Promise((r) => setTimeout(r, 300));
    await monitor.query('commit');
    const res = await sending;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().errore).toBe(
      'La distinta è cambiata dopo il controllo: ricontrollala prima di mandarla',
    );
    expect(portal.calls.filter((c) => c.month === '2026-05')).toEqual([]);
    const [row] = await t.db.select().from(ppipRecord).where(eq(ppipRecord.id, id));
    expect(row).toMatchObject({ status: 'annulled', sendingSince: null, reportId: null });
  });

  it('parte ciò che il titolare ha controllato: una prestazione arrivata dopo la fa ricontrollare', async () => {
    await register('titolare', mine[0]!.id, '2026-06-03');
    const checked = await seen('2026-06');
    await register('segreteria', mine[1]!.id, '2026-06-28', 'A3');
    const stale = await send('titolare', '2026-06', checked);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().errore).toBe(
      'La distinta è cambiata dopo il controllo: ricontrollala prima di mandarla',
    );
    const unknown = await send('titolare', '2026-06', [
      ...(await seen('2026-06')),
      '00000000-0000-4000-8000-000000000000',
    ]);
    expect(unknown.statusCode).toBe(409);
    const twice = await seen('2026-06');
    expect((await send('titolare', '2026-06', [...twice, twice[0]!])).statusCode).toBe(409);
    expect(portal.calls.filter((c) => c.month === '2026-06')).toEqual([]);
    const ok = await send('titolare', '2026-06');
    expect(ok.json()).toMatchObject({ esito: 'accepted', righe: 2 });
  });

  it('invio senza risposta: le prestazioni restano in invio, l’esito lo segna il titolare', async () => {
    const id = await register('titolare', mine[0]!.id, '2026-07-07');
    portal.mode = 'throw';
    const failed = await send('titolare', '2026-07');
    portal.mode = 'accept';
    expect(failed.statusCode, failed.body).toBe(502);
    expect(failed.json().errore).toMatch(/restano «in invio».*chiedi all’ASL/i);
    const d = (await distinta('titolare', '2026-07')).json();
    expect(d.inInvio).toMatchObject({ interrotto: false, righe: 1 });
    expect(d.daInviare).toBe(0);
    // Niente parte di nuovo da solo, e non si annulla.
    expect((await send('titolare', '2026-07')).json().errore).toMatch(/già in corso/);
    expect((await annul('titolare', mine[0]!.id, id)).statusCode).toBe(409);
    const settle = (who: Who, esito: string, riferimento?: string) =>
      req(who, 'POST', `/api/archivi/${archiveOf('titolare')}/ppip/esito`, {
        mese: '2026-07',
        esito,
        ...(riferimento ? { riferimento } : {}),
      });
    const early = await settle('titolare', 'non_arrivata');
    expect(early.statusCode).toBe(409);
    expect(early.json().errore).toMatch(/meno di 15 minuti/);
    s.clock.advance(15 * 60_000);
    expect((await distinta('titolare', '2026-07')).json().inInvio.interrotto).toBe(true);
    expect((await settle('segreteria', 'non_arrivata')).statusCode).toBe(403);
    expect((await settle('sostituto', 'non_arrivata')).statusCode).toBe(403);
    const back = await settle('titolare', 'non_arrivata');
    expect(back.statusCode, back.body).toBe(200);
    const after = (await distinta('titolare', '2026-07')).json();
    expect(after).toMatchObject({ inInvio: null, daInviare: 1 });
    expect(after.invii[0]).toMatchObject({ esito: 'unreachable', ambiente: 'manuale' });
    const again = await send('titolare', '2026-07');
    expect(again.json()).toMatchObject({ esito: 'accepted', righe: 1 });
    // Il registro: il tentativo senza risposta e l'esito segnato a mano.
    const unclear = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.action, 'invio_distinta_ppip'), eq(accessLog.outcome, 'fallito')));
    expect(unclear.map((l) => (l.details as { esito: string }).esito)).toContain('senza_risposta');
    const settled = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.action, 'esito_distinta_ppip'), eq(accessLog.outcome, 'riuscito')));
    expect(settled.map((l) => l.patientId)).toEqual([mine[0]!.id]);
  });

  it('invio senza risposta arrivato all’ASL: le prestazioni risultano partite con il riferimento', async () => {
    await register('titolare', mine[1]!.id, '2026-08-11');
    portal.mode = 'throw';
    expect((await send('titolare', '2026-08')).statusCode).toBe(502);
    portal.mode = 'accept';
    s.clock.advance(15 * 60_000);
    const res = await req('titolare', 'POST', `/api/archivi/${archiveOf('titolare')}/ppip/esito`, {
      mese: '2026-08',
      esito: 'arrivata',
      riferimento: 'Ricevuta ASL 77',
    });
    expect(res.statusCode, res.body).toBe(200);
    const d = (await distinta('titolare', '2026-08')).json();
    expect(d.daInviare).toBe(0);
    expect((d.righe as Riga[])[0]).toMatchObject({
      inviata: true,
      protocolloInvio: 'Ricevuta ASL 77',
    });
    expect((await send('titolare', '2026-08')).json().errore).toBe(
      'Nessuna prestazione da inviare per il mese',
    );
  });

  it('consegna fuori dal programma: le prestazioni risultano partite e non si annullano più', async () => {
    const a = await register('titolare', mine[0]!.id, '2026-09-01');
    await register('segreteria', mine[2]!.id, '2026-09-02');
    const deliver = (who: Who, mese: string, righe: string[]) =>
      req(who, 'POST', `/api/archivi/${archiveOf('titolare')}/ppip/consegna`, {
        mese,
        righe,
        riferimento: 'Caricata sul portale dell’ASL',
      });
    const ids = await seen('2026-09');
    expect((await deliver('segreteria', '2026-09', ids)).statusCode).toBe(403);
    expect((await deliver('titolare', '2026-11', [])).json().errore).toMatch(/non è finito/);
    const calls = portal.calls.length;
    const res = await deliver('titolare', '2026-09', ids);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ righe: 2 });
    expect(portal.calls).toHaveLength(calls);
    const d = (await distinta('titolare', '2026-09')).json();
    expect(d.daInviare).toBe(0);
    expect(d.invii[0]).toMatchObject({
      esito: 'accepted',
      ambiente: 'manuale',
      protocollo: 'Caricata sul portale dell’ASL',
    });
    expect((await annul('titolare', mine[0]!.id, a)).json().errore).toMatch(/già partita/);
    const logged = await t.db
      .select()
      .from(accessLog)
      .where(
        and(eq(accessLog.action, 'consegna_distinta_ppip'), eq(accessLog.outcome, 'riuscito')),
      );
    expect(new Set(logged.map((l) => l.patientId))).toEqual(new Set([mine[0]!.id, mine[2]!.id]));
  });

  it('il paziente passa a un altro medico: le prestazioni restano nella distinta di chi le ha registrate', async () => {
    const moved = mine[2]!;
    const byDoctor = await register('titolare', moved.id, '2026-10-03');
    const bySecretary = await register('segreteria', moved.id, '2026-10-04', 'A3');
    // Lo spostamento di D200 cambia l'archivio del paziente, e basta.
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .update(patient)
        .set({ archiveId: archiveOf('collega') })
        .where(eq(patient.id, moved.id)),
    );
    const old = (await distinta('titolare', '2026-10')).json();
    const rows = (old.righe as Riga[]).filter((r) => r.paziente === moved.id);
    expect(rows.map((r) => r.id)).toEqual([byDoctor, bySecretary]);
    expect(rows.every((r) => !r.pazienteNellArchivio)).toBe(true);
    const theirs = (await distinta('collega', '2026-10', archiveOf('collega'))).json();
    expect((theirs.righe as Riga[]).some((r) => r.paziente === moved.id)).toBe(false);
    // Nella cartella, ora della collega, le prestazioni di prima si leggono e basta.
    const list = (await req('collega', 'GET', `/api/pazienti/${moved.id}/ppip`)).json()
      .prestazioni as { id: string; altroArchivio: string | null }[];
    expect(list.filter((p) => [byDoctor, bySecretary].includes(p.id))).toMatchObject([
      { id: bySecretary, altroArchivio: expect.any(String) },
      { id: byDoctor, altroArchivio: expect.any(String) },
    ]);
    const refused = await annul('collega', moved.id, byDoctor);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().errore).toMatch(/si annulla da quella distinta/);
    // Una prestazione nuova della collega va nella sua distinta.
    const fresh = await register('collega', moved.id, '2026-10-30', 'A4');
    const now = (await distinta('collega', '2026-10', archiveOf('collega'))).json();
    expect((now.righe as Riga[]).map((r) => r.id)).toContain(fresh);
    expect(
      ((await distinta('titolare', '2026-10')).json().righe as Riga[]).map((r) => r.id),
    ).not.toContain(fresh);
    // Il titolare di prima la annulla dalla sua distinta; la collega da lì no.
    const fromReport = (who: Who, id: string) =>
      req(who, 'POST', `/api/archivi/${archiveOf('titolare')}/ppip/${id}/annulla`, {
        motivo: 'Registrata due volte',
      });
    expect((await fromReport('collega', bySecretary)).statusCode).toBe(403);
    expect((await annul('titolare', moved.id, bySecretary)).statusCode).toBe(403);
    const ok = await fromReport('titolare', bySecretary);
    expect(ok.statusCode, ok.body).toBe(200);
    const log = await t.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.action, 'annullamento_ppip'),
          eq(accessLog.patientId, moved.id),
          eq(accessLog.outcome, 'consentito'),
          eq(accessLog.userId, s.users.titolare.id),
        ),
      );
    expect(log.length).toBeGreaterThanOrEqual(1);
    // La distinta parte a nome del titolare di prima, con la prestazione del paziente spostato.
    const sent = await send('titolare', '2026-10');
    expect(sent.json()).toMatchObject({ esito: 'accepted' });
    const last = portal.calls.at(-1)!;
    expect(last.lines.map((l) => l.patient.fiscalCode)).toContain(moved.fiscalCode);
    expect((await send('collega', '2026-10')).statusCode).toBe(403);
  });

  it('il database tiene fermi i dati di una prestazione registrata', async () => {
    const id = await register('titolare', mine[1]!.id, '2026-02-10');
    const refused = async (statement: string) => {
      try {
        await t.db.execute(sql.raw(statement));
      } catch (err) {
        const e = err as { message: string; cause?: { message: string } };
        return e.cause?.message ?? e.message;
      }
      return '';
    };
    expect(await refused(`update ppip_record set quantity = 5 where id = '${id}'`)).toMatch(
      /non si modificano: si annulla/,
    );
    expect(
      await refused(
        `update ppip_record set archive_id = '${archiveOf('collega')}' where id = '${id}'`,
      ),
    ).toMatch(/non si modificano/);
    // In invio solo con chi manda; partita e in invio insieme no.
    expect(
      await refused(`update ppip_record set sending_since = now() where id = '${id}'`),
    ).toMatch(/ppip_record_sending_check/);
    const [sent] = await t.db
      .select()
      .from(ppipRecord)
      .where(sql`report_id is not null`)
      .limit(1);
    expect(
      await refused(`update ppip_record set report_id = null where id = '${sent!.id}'`),
    ).toMatch(/già partita con la distinta/);
    expect((await annul('titolare', mine[1]!.id, id)).statusCode).toBe(200);
    expect(await refused(`update ppip_record set status = 'active' where id = '${id}'`)).toMatch(
      /annullata: non cambia più/,
    );
  });

  it('la distinta la leggono il titolare e la segreteria; il sostituto no, nemmeno il CSV', async () => {
    const csv = (who: Who) =>
      req(who, 'GET', `/api/archivi/${archiveOf('titolare')}/ppip/esportazione?mese=2026-10`);
    expect((await csv('segreteria')).statusCode).toBe(200);
    const substitute = await csv('sostituto');
    expect(substitute.statusCode).toBe(403);
    expect(substitute.json().errore).toBe('Sostituzione: azione riservata al titolare');
    expect((await req('sostituto', 'GET', '/api/ppip/archivi')).json().archivi).toEqual([]);
    // Nella cartella del paziente, invece, il sostituto le legge e le registra.
    expect((await req('sostituto', 'GET', `/api/pazienti/${mine[0]!.id}/ppip`)).statusCode).toBe(
      200,
    );
  });
});

describe('in produzione con il simulatore (D212, D232)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let work: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      {},
      {
        clockAt: new Date('2026-11-20T11:00:00Z'),
        ppipPortal: new GatedPortal(),
        environment: 'produzione',
      },
    );
    work = (await importPpipCatalog(t.db)).work;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('l’invio dal programma è spento e la pagina lo sa; la consegna fuori dal programma resta', async () => {
    const cookie = await login(s, 'titolare');
    const [p] = await t.db
      .select()
      .from(patient)
      .where(and(eq(patient.archiveId, s.archives.titolare), sql`deceased_on is null`))
      .limit(1);
    const reg = await s.app.inject({
      method: 'POST',
      url: `/api/pazienti/${p!.id}/ppip`,
      headers: { cookie },
      payload: { data: '2026-10-05', codice: 'A1', luogo: 'studio' },
    });
    expect(reg.statusCode, reg.body).toBe(201);
    const d = (
      await s.app.inject({
        method: 'GET',
        url: `/api/archivi/${s.archives.titolare}/ppip?mese=2026-10`,
        headers: { cookie },
      })
    ).json();
    expect(d).toMatchObject({ invioAttivo: false, puoInviare: true, daInviare: 1 });
    const righe = (d.righe as Riga[]).map((r) => r.id);
    const sent = await s.app.inject({
      method: 'POST',
      url: `/api/archivi/${s.archives.titolare}/ppip/invio`,
      headers: { cookie },
      payload: { mese: '2026-10', righe },
    });
    expect(sent.statusCode).toBe(409);
    expect(sent.json().errore).toMatch(/non è ancora collegato/);
    const delivered = await s.app.inject({
      method: 'POST',
      url: `/api/archivi/${s.archives.titolare}/ppip/consegna`,
      headers: { cookie },
      payload: { mese: '2026-10', righe },
    });
    expect(delivered.statusCode, delivered.body).toBe(200);
  });
});
