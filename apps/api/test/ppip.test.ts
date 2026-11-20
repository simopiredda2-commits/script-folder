import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SimulatedAdditionalServicesPortal,
  type AdditionalServicesResult,
} from '@mmg/integrations';
import { loadMappings } from '@mmg/reference';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/auth/service';
import { accessLog, patient, ppipRecord } from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { buildExport } from '../src/export/export';
import { DISTINTA_FIELDS, formatById, loadFormats } from '../src/ppip/formats';
import { reportDeadline, sendMonth, totalOf } from '../src/ppip/service';
import { importReferenceData } from '../src/reference/importer';
import { importPpipCatalog } from './helpers/ppip';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface Voce {
  codice: string;
  sezione: string;
  descrizione: string;
  autorizzazione: boolean;
  compenso: number | null;
}
interface Riga {
  id: string;
  data: string;
  cognome: string;
  nome: string;
  indirizzo: string | null;
  codiceFiscale: string;
  codice: string;
  quantita: number;
  importo: number | null;
  inviata: boolean;
  inInvioDal: string | null;
  protocolloInvio: string | null;
}

/**
 * Prestazioni aggiuntive (PPIP, D212): catalogo dell'allegato 6 dell'ACN 2022-2024 e dell'AIR del
 * Piemonte alla data, registrazione in cartella con i controlli formali, distinta del mese con il
 * CSV, invio all'ASL con il simulatore. Orologio fermo al 20/11/2026: ottobre è un mese finito.
 */
describe('prestazioni aggiuntive (PPIP, D212)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let work: string;
  let decide: AdditionalServicesResult['outcome'] = 'accepted';
  const portal = new SimulatedAdditionalServicesPortal({ decide: () => decide });
  const cookies = {
    titolare: '',
    collega: '',
    segreteria: '',
    sostituto: '',
    amministratore: '',
  };
  type Who = keyof typeof cookies;
  let pt: typeof patient.$inferSelect;
  let other: typeof patient.$inferSelect;

  const req = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    s.app.inject({
      method,
      url,
      headers: { cookie: cookies[who] },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  const register = (who: Who, patientId: string, body: Record<string, unknown>) =>
    req(who, 'POST', `/api/pazienti/${patientId}/ppip`, {
      data: '2026-10-05',
      luogo: 'studio',
      ...body,
    });
  const distinta = async (who: Who, month = '2026-10') =>
    req(who, 'GET', `/api/archivi/${s.archives.titolare}/ppip?mese=${month}`);

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      {},
      { clockAt: new Date('2026-11-20T11:00:00Z'), ppipPortal: portal },
    );
    for (const who of Object.keys(cookies) as Who[]) cookies[who] = await login(s, who);
    const imported = await importPpipCatalog(t.db);
    work = imported.work;
    expect(imported.outcomes).toEqual(['importato', 'importato']);
    const mine = await t.db
      .select()
      .from(patient)
      .where(eq(patient.archiveId, s.archives.titolare))
      .orderBy(patient.lastName, patient.firstName);
    [pt, other] = [mine[0]!, mine[1]!];
  });
  afterAll(async () => {
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('catalogo alla data: ACN dal 15/1/2026, AIR del Piemonte dal 1/1/2025, in ordine', async () => {
    const at = async (data: string) =>
      (await req('titolare', 'GET', `/api/prestazioni-aggiuntive/catalogo?data=${data}`)).json()
        .voci as Voce[];
    const october = await at('2026-10-15');
    expect(october.map((v) => v.codice)).toEqual([
      ...Array.from({ length: 12 }, (_, i) => `A${i + 1}`),
      'B1',
      'B2',
      'B3',
      'B4',
      'AIR35.4',
    ]);
    expect(october[0]).toMatchObject({
      codice: 'A1',
      sezione: 'A',
      descrizione: 'Prima medicazione',
      autorizzazione: false,
      compenso: 12.32,
    });
    expect(october.find((v) => v.codice === 'B2')).toMatchObject({
      autorizzazione: true,
      compenso: 6.16,
    });
    expect(october.find((v) => v.codice === 'AIR35.4')).toMatchObject({ compenso: 55 });
    // Prima dell'ACN 2022-2024 c'è solo l'accordo regionale; prima del 2025 nulla.
    expect((await at('2025-06-01')).map((v) => v.codice)).toEqual(['AIR35.4']);
    expect(await at('2024-06-01')).toEqual([]);
  });

  it('registrazione con i controlli formali: catalogo alla data, autorizzazione, date', async () => {
    const ok = await register('titolare', pt.id, { codice: 'A1' });
    expect(ok.statusCode, ok.body).toBe(201);
    const noAuth = await register('titolare', pt.id, { codice: 'B2', quantita: 3 });
    expect(noAuth.statusCode).toBe(400);
    expect(noAuth.json().errore).toMatch(/B2 è soggetta ad autorizzazione.*comma 5/);
    const withAuth = await register('titolare', pt.id, {
      codice: 'B2',
      quantita: 3,
      data: '2026-10-07',
      luogo: 'domicilio',
      autorizzazione: 'Distretto, autorizzazione n. 12 del 01/10/2026',
    });
    expect(withAuth.statusCode, withAuth.body).toBe(201);
    expect((await register('titolare', pt.id, { codice: 'A13' })).json().errore).toMatch(
      /A13 non è nel catalogo delle prestazioni aggiuntive in vigore il 05\/10\/2026/,
    );
    expect(
      (await register('titolare', pt.id, { codice: 'A1', data: '2026-11-21' })).json().errore,
    ).toBe('La data dell’esecuzione è nel futuro');
    // Prima del 15/1/2026 l'allegato 6 dell'ACN 2022-2024 non vale ancora; l'AIR sì.
    expect(
      (await register('titolare', pt.id, { codice: 'A1', data: '2025-12-01' })).statusCode,
    ).toBe(400);
    expect(
      (await register('titolare', pt.id, { codice: 'AIR35.4', data: '2025-12-01' })).statusCode,
    ).toBe(201);
    const list = (await req('titolare', 'GET', `/api/pazienti/${pt.id}/ppip`)).json();
    expect(list.puoScrivere).toBe(true);
    expect(
      list.prestazioni.map((p: { codice: string; importo: number; luogo: string }) => [
        p.codice,
        p.importo,
        p.luogo,
      ]),
    ).toEqual([
      ['B2', 18.48, 'domicilio'],
      ['A1', 12.32, 'studio'],
      ['AIR35.4', 55, 'studio'],
    ]);
  });

  it('dopo il decesso nessuna prestazione', async () => {
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .update(patient)
        .set({ status: 'deceased', deceasedOn: '2026-10-10' })
        .where(eq(patient.id, other.id)),
    );
    const late = await register('titolare', other.id, { codice: 'A3', data: '2026-10-12' });
    expect(late.json().errore).toBe(
      'La data dell’esecuzione viene dopo il decesso del paziente (10/10/2026)',
    );
    expect(
      (await register('titolare', other.id, { codice: 'A3', data: '2026-10-09' })).statusCode,
    ).toBe(201);
  });

  it('chi può: medici e segreteria registrano; amministratore e collega di un altro archivio no', async () => {
    expect(
      (await register('segreteria', pt.id, { codice: 'A7', data: '2026-10-20' })).statusCode,
    ).toBe(201);
    expect(
      (await register('sostituto', pt.id, { codice: 'A3', data: '2026-10-21' })).statusCode,
    ).toBe(201);
    expect((await register('amministratore', pt.id, { codice: 'A3' })).statusCode).toBe(403);
    expect((await register('collega', pt.id, { codice: 'A3' })).statusCode).toBe(403);
    expect((await req('amministratore', 'GET', `/api/pazienti/${pt.id}/ppip`)).statusCode).toBe(
      403,
    );
    const denied = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.action, 'nuova_ppip'), eq(accessLog.outcome, 'negato')));
    expect(denied.length).toBeGreaterThanOrEqual(2);
  });

  it('distinta del mese: i campi del comma 4, per voce, totale e scadenza del 15', async () => {
    const res = await distinta('titolare');
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json();
    expect(d.scadenza).toBe('2026-11-15');
    expect(reportDeadline('2026-12')).toBe('2027-01-15');
    const rows = d.righe as Riga[];
    expect(rows.map((r) => [r.data, r.codice])).toEqual([
      ['2026-10-05', 'A1'],
      ['2026-10-07', 'B2'],
      ['2026-10-09', 'A3'],
      ['2026-10-20', 'A7'],
      ['2026-10-21', 'A3'],
    ]);
    expect(rows[0]).toMatchObject({
      cognome: pt.lastName,
      nome: pt.firstName,
      codiceFiscale: pt.fiscalCode,
      inviata: false,
    });
    expect(rows[0]!.indirizzo).toBeTruthy();
    // 12,32 + 18,48 + 6,16 + 5,62 + 6,16, arrotondato al centesimo.
    expect(d.totale).toBe(48.74);
    expect(
      d.perVoce.map((v: { codice: string; quantita: number }) => [v.codice, v.quantita]),
    ).toEqual([
      ['A1', 1],
      ['A3', 2],
      ['A7', 1],
      ['B2', 3],
    ]);
    expect(d.daInviare).toBe(5);
    expect(d.puoInviare).toBe(true);
    expect(d.invioAttivo).toBe(true);
    expect(d.invioSimulato).toBe(true);
    expect(d.inInvio).toBeNull();
    // La segreteria la prepara e la legge; non la manda.
    expect((await distinta('segreteria')).json().puoInviare).toBe(false);
    // Il sostituto registra le prestazioni ma non legge la distinta, come i riepiloghi (D232).
    const substitute = await distinta('sostituto');
    expect(substitute.statusCode).toBe(403);
    expect(substitute.json().errore).toBe('Sostituzione: azione riservata al titolare');
    // Una riga del registro per paziente: la distinta ha i nomi.
    const logged = await t.db
      .select({ p: accessLog.patientId })
      .from(accessLog)
      .where(and(eq(accessLog.action, 'distinta_ppip'), eq(accessLog.outcome, 'consentito')));
    expect(new Set(logged.map((l) => l.p))).toEqual(new Set([pt.id, other.id]));
    expect((await distinta('amministratore')).statusCode).toBe(403);
    expect((await distinta('collega')).statusCode).toBe(403);
  });

  it('CSV nel formato dei dati: intestazioni, date e decimali come nel formato', async () => {
    const res = await req(
      'titolare',
      'GET',
      `/api/archivi/${s.archives.titolare}/ppip/esportazione?mese=2026-10`,
    );
    expect(res.statusCode, res.body).toBe(200);
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'Data di effettuazione;Cognome;Nome;Indirizzo;Codice fiscale;Codice prestazione;Prestazione;Quantità;Luogo;Autorizzazione;Compenso unitario (euro);Importo (euro)',
    );
    expect(lines).toHaveLength(6);
    expect(lines[1]).toMatch(/^05\/10\/2026;/);
    expect(lines[1]).toMatch(/;A1;Prima medicazione;1;In studio;;12,32;12,32$/);
    expect(lines[2]).toMatch(
      /;B2;.*;3;A domicilio;Distretto, autorizzazione n\. 12 del 01\/10\/2026;6,16;18,48$/,
    );
    expect(
      (
        await req(
          'titolare',
          'GET',
          `/api/archivi/${s.archives.titolare}/ppip/esportazione?mese=2026-10&formato=inesistente`,
        )
      ).statusCode,
    ).toBe(400);
  });

  it('invio: solo il titolare, solo un mese finito; poi le prestazioni non si annullano più qui', async () => {
    // Le prestazioni da inviare che il titolare ha visto nella distinta (D232).
    const seen = async (mese: string) =>
      ((await distinta('titolare', mese)).json().righe as Riga[])
        .filter((r) => !r.inviata && !r.inInvioDal)
        .map((r) => r.id);
    const send = async (who: Who, mese: string) =>
      req(who, 'POST', `/api/archivi/${s.archives.titolare}/ppip/invio`, {
        mese,
        righe: await seen(mese),
      });
    expect((await send('segreteria', '2026-10')).statusCode).toBe(403);
    // Il no è per il ruolo, non per un'autorizzazione scaduta (D232).
    const substitute = await send('sostituto', '2026-10');
    expect(substitute.statusCode).toBe(403);
    expect(substitute.json().errore).toBe('Sostituzione: azione riservata al titolare');
    expect((await send('titolare', '2026-11')).json().errore).toBe(
      'Il mese non è finito: la distinta si manda dal primo giorno del mese dopo',
    );
    // Il portale rifiuta: resta l'esito, le prestazioni restano da inviare.
    decide = 'rejected';
    const rejected = (await send('titolare', '2026-10')).json();
    expect(rejected).toMatchObject({ esito: 'rejected', righe: 5, protocollo: null });
    expect((await distinta('titolare')).json().daInviare).toBe(5);
    decide = 'accepted';
    s.clock.advance(60_000);
    const ok = (await send('titolare', '2026-10')).json();
    expect(ok).toMatchObject({ esito: 'accepted', righe: 5, protocollo: 'SIM-PPIP-2026-10-0001' });
    expect(portal.reports.at(-1)!.lines.map((l) => l.code)).toEqual(['A1', 'B2', 'A3', 'A7', 'A3']);
    expect(portal.reports.at(-1)!.lines[0]!.patient.fiscalCode).toBe(pt.fiscalCode);
    const after = (await distinta('titolare')).json();
    expect(after.daInviare).toBe(0);
    expect(
      (after.righe as Riga[]).every((r) => r.protocolloInvio === 'SIM-PPIP-2026-10-0001'),
    ).toBe(true);
    expect(after.invii.map((i: { esito: string }) => i.esito)).toEqual(['accepted', 'rejected']);
    expect((await send('titolare', '2026-10')).json().errore).toBe(
      'Nessuna prestazione da inviare per il mese',
    );
    // Una prestazione già partita non si annulla qui.
    const sent = (after.righe as Riga[])[0]!;
    const annul = await req('titolare', 'POST', `/api/pazienti/${pt.id}/ppip/${sent.id}/annulla`, {
      motivo: 'Registrata per errore',
    });
    expect(annul.statusCode).toBe(409);
    expect(annul.json().errore).toMatch(/già partita con la distinta SIM-PPIP-2026-10-0001/);
    // Una prestazione nuova dello stesso mese parte da sola, con un invio a sé.
    expect(
      (await register('titolare', pt.id, { codice: 'A9', data: '2026-10-30' })).statusCode,
    ).toBe(201);
    const again = (await send('titolare', '2026-10')).json();
    expect(again).toMatchObject({ esito: 'accepted', righe: 1 });
    expect(portal.reports.at(-1)!.lines.map((l) => l.code)).toEqual(['A9']);
  });

  it('annullamento con un motivo: esce dalla distinta, e non due volte', async () => {
    const res = await register('titolare', pt.id, { codice: 'A4', data: '2026-09-03' });
    const id = res.json().id as string;
    const annul = () =>
      req('titolare', 'POST', `/api/pazienti/${pt.id}/ppip/${id}/annulla`, {
        motivo: 'Registrata per errore',
      });
    expect((await annul()).statusCode).toBe(200);
    expect((await annul()).statusCode).toBe(409);
    expect((await distinta('titolare', '2026-09')).json().righe).toEqual([]);
    const list = (await req('titolare', 'GET', `/api/pazienti/${pt.id}/ppip`)).json();
    expect(list.prestazioni.find((p: { id: string }) => p.id === id)).toMatchObject({
      stato: 'annullata',
      motivoAnnullamento: 'Registrata per errore',
    });
  });

  it('con il simulatore, in produzione, la distinta non parte', async () => {
    const actor = {
      userId: s.users.titolare.id,
      studioId: s.studioId,
      roles: s.users.titolare.roles,
      workstation: null,
    } as unknown as Actor;
    await expect(
      sendMonth({
        db: t.db,
        portal,
        environment: 'produzione',
        actor,
        archiveId: s.archives.titolare,
        month: '2026-09',
        seen: [],
        today: '2026-11-20',
        at: new Date('2026-11-20T11:00:00Z'),
      }),
    ).rejects.toThrow(/non è ancora collegato/);
  });

  it('i dati sono del medico: prestazioni e invii nell’esportazione; niente si cancella', async () => {
    const exp = await buildExport(t.db, s.archives.titolare, new Date('2026-11-20T11:00:00Z'));
    const tables = (exp as unknown as { tabelle: Record<string, unknown[]> }).tabelle;
    expect(tables.ppip_record!.length).toBeGreaterThanOrEqual(8);
    expect(tables.ppip_report!.length).toBe(3);
    const refused = async (statement: string) => {
      try {
        await t.db.execute(sql.raw(statement));
      } catch (err) {
        const e = err as { message: string; cause?: { message: string } };
        return e.cause?.message ?? e.message;
      }
      return '';
    };
    expect(await refused('delete from ppip_record')).toMatch(/si annullano con un motivo/);
    expect(await refused('update ppip_report set lines = 0')).toMatch(/non si modificano/);
    expect(await refused('delete from ppip_report')).toMatch(/non si modificano/);
    const counted = await t.db.select().from(ppipRecord);
    expect(counted.length).toBeGreaterThanOrEqual(8);
  });

  it('un accordo aziendale nuovo è un file da importare: vale dalla sua data e solo nella sua ASL', async () => {
    // Accordi inventati. Quello dell'ASL del titolare vale dal 1/11/2026: A1 pagata di più e una
    // voce sua. Quello di un'altra ASL vale per i suoi medici e basta (D232). Un terzo, della
    // stessa ASL e con la data dell'ACN, vince sull'ACN perché è più vicino.
    const dir = join(work, 'trascrizioni-asl', 'ppip');
    mkdirSync(dir, { recursive: true });
    const sheet = (serie: string, atto: string, from: string, asl: string) => ({
      tipo: 'prestazioni_aggiuntive',
      serie,
      fonte: null,
      chiave: null,
      sha256_origine: null,
      atto,
      in_vigore_dal: from,
      ambito: { regione: 'Piemonte', asl },
      trascritto_da: 'Persona di prova',
      trascritto_il: '2026-11-20',
      controllato_da: 'Seconda persona di prova',
    });
    const header = 'codice;sezione;descrizione;autorizzazione;compenso;note\n';
    writeFileSync(
      join(dir, 'asl-di-prova-2026.json'),
      // Come nel profilo dei medici dello scenario, scritto in un altro modo.
      JSON.stringify(
        sheet(
          'asl-di-prova-prestazioni-aggiuntive',
          'Accordo aziendale di prova',
          '2026-11-01',
          'asl DI-prova',
        ),
      ),
    );
    writeFileSync(
      join(dir, 'asl-di-prova-2026.csv'),
      header +
        'A1;A;Prima medicazione;no;15,00;\n' +
        'ASL1;C;Prestazione di prova dell’accordo aziendale;no;10,00;\n',
    );
    writeFileSync(
      join(dir, 'asl-altra-2026.json'),
      JSON.stringify(
        sheet(
          'asl-altra-prestazioni-aggiuntive',
          'Accordo di un’altra ASL',
          '2026-11-01',
          'ASL di un’altra zona',
        ),
      ),
    );
    writeFileSync(
      join(dir, 'asl-altra-2026.csv'),
      header + 'A1;A;Prima medicazione;no;20,00;\n' + 'ALT1;C;Voce di un’altra ASL;no;8,00;\n',
    );
    writeFileSync(
      join(dir, 'asl-di-prova-gennaio.json'),
      JSON.stringify(
        sheet(
          'asl-di-prova-gennaio',
          'Accordo aziendale di prova di gennaio',
          '2026-01-15',
          'ASL di prova',
        ),
      ),
    );
    writeFileSync(join(dir, 'asl-di-prova-gennaio.csv'), header + 'A2;A;Seconda voce;no;9,99;\n');
    const report = await importReferenceData({
      db: t.db,
      syncDir: join(work, 'dati-pubblici'),
      transcriptionsDir: join(work, 'trascrizioni-asl'),
      mappings: loadMappings(),
      importedBy: 'prova',
    });
    expect(report.map((r) => r.outcome)).toEqual(['importato', 'importato', 'importato']);
    const at = async (data: string) =>
      (
        await req(
          'titolare',
          'GET',
          `/api/prestazioni-aggiuntive/catalogo?data=${data}&archivio=${s.archives.titolare}`,
        )
      ).json().voci as Voce[];
    const before = await at('2026-10-31');
    expect(before.find((v) => v.codice === 'A1')?.compenso).toBe(12.32);
    expect(before.some((v) => v.codice === 'ASL1')).toBe(false);
    // Stessa data dell'ACN: vale l'accordo dell'ASL, non l'ordine delle righe.
    expect(before.find((v) => v.codice === 'A2')?.compenso).toBe(9.99);
    const after = await at('2026-11-10');
    expect(after.find((v) => v.codice === 'A1')?.compenso).toBe(15);
    expect(after.filter((v) => v.codice === 'A1')).toHaveLength(1);
    expect(after.map((v) => v.codice).slice(-2)).toEqual(['AIR35.4', 'ASL1']);
    expect(after.some((v) => v.codice === 'ALT1')).toBe(false);
    // Senza l'archivio, gli accordi delle ASL non valgono: solo l'Italia e la regione dello studio.
    const studioOnly = (
      await req('segreteria', 'GET', '/api/prestazioni-aggiuntive/catalogo?data=2026-11-10')
    ).json().voci as Voce[];
    expect(studioOnly.find((v) => v.codice === 'A1')?.compenso).toBe(12.32);
    expect(studioOnly.map((v) => v.codice)).toContain('AIR35.4');
    // Registrata dopo, la prima medicazione ha il compenso nuovo; quella di ottobre resta com'era.
    expect(
      (await register('titolare', pt.id, { codice: 'A1', data: '2026-11-10' })).statusCode,
    ).toBe(201);
    // La voce dell'altra ASL non c'è per questo archivio.
    expect(
      (await register('titolare', pt.id, { codice: 'ALT1', data: '2026-11-10' })).statusCode,
    ).toBe(400);
    const list = (await req('titolare', 'GET', `/api/pazienti/${pt.id}/ppip`)).json()
      .prestazioni as { codice: string; data: string; compensoUnitario: number }[];
    expect(list.filter((p) => p.codice === 'A1').map((p) => [p.data, p.compensoUnitario])).toEqual([
      ['2026-11-10', 15],
      ['2026-10-05', 12.32],
    ]);
  });

  it('totale: vuoto se una voce non ha il compenso, non contata come zero', () => {
    expect(totalOf([{ importo: 12.32 }, { importo: 6.16 }])).toBe(18.48);
    expect(totalOf([{ importo: 12.32 }, { importo: null }])).toBeNull();
    expect(totalOf([])).toBe(0);
  });

  it('formati della distinta come dati: ogni colonna usa un campo che esiste', () => {
    const formats = loadFormats();
    expect(formats.formati.map((f) => f.id)).toContain('acn-allegato-6');
    for (const f of formats.formati)
      for (const c of f.colonne) expect(DISTINTA_FIELDS).toContain(c.campo);
    expect(formatById(undefined)?.id).toBe('acn-allegato-6');
    expect(formatById('inesistente')).toBeUndefined();
  });
});
