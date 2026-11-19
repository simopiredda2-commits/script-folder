import { buildFiscalCode, PATIENT_STATUSES, REMINDER_CHANNELS } from '@mmg/domain';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  archiveGrant,
  changeHistory,
  exemption,
  family,
  patient,
  patientChoice,
  patientStatus,
  refExemption,
  referenceDataset,
  reminderChannel,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
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

type Who = 'titolare' | 'collega' | 'segreteria' | 'sostituto' | 'amministratore';

interface AdminView {
  paziente: {
    id: string;
    archivio: { id: string; nome: string; titolare: string };
    identita: Record<string, string | null>;
    dati: Record<string, string | null>;
    nucleo: {
      id: string;
      etichetta: string;
      componenti: { id: string; cognome: string; nome: string; nascita: string }[];
    } | null;
  };
  esenzioni: {
    id: string;
    codice: string;
    dal: string;
    al: string | null;
    codiceRicetta: string | null;
    fonte: string;
    stato: string;
    nelCatalogo: boolean | null;
  }[];
  scelte: {
    id: string;
    medicoId: string;
    medico: string;
    dal: string;
    cessataIl: string | null;
    motivoCessazione: string | null;
    stato: string;
  }[];
  correzioni: { quando: string; utente: string | null; campi: string[]; motivo: string }[];
  medici: { id: string; nome: string }[];
  stati: { chiave: string; nome: string }[];
  canali: { chiave: string; nome: string }[];
  catalogoEsenzioni: boolean;
  puoScrivere: boolean;
}

/** Identità inventata: luogo di nascita con la X, che nessun comune ha (D12). */
function person(n: number, overrides: Partial<Record<string, string>> = {}) {
  const cognome = overrides.cognome ?? `Ginepri${'abcdefghij'[n % 10]}`;
  const nome = overrides.nome ?? 'Albina';
  const sesso = (overrides.sesso ?? 'F') as 'M' | 'F';
  const nascita = overrides.nascita ?? `${1940 + n}-03-${String((n % 27) + 1).padStart(2, '0')}`;
  const luogoNascitaCodice = overrides.luogoNascitaCodice ?? `X${String(100 + n).padStart(3, '0')}`;
  return {
    cognome,
    nome,
    sesso,
    nascita,
    luogoNascitaCodice,
    luogoNascita: `Comune immaginario ${100 + n}`,
    codiceFiscale:
      overrides.codiceFiscale ??
      buildFiscalCode({
        surname: cognome,
        name: nome,
        birthDate: nascita,
        sex: sesso,
        placeCode: luogoNascitaCodice,
      }),
  };
}

describe('pannello amministrativo del paziente (tappa 15)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const cookies = {} as Record<Who, string>;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    for (const who of ['titolare', 'collega', 'segreteria', 'sostituto', 'amministratore'] as const)
      cookies[who] = await login(s, who);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const day = (offset: number) => studioDayFrom(s.clock.now(), offset);
  const req = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, who: Who, payload?: object) =>
    s.app.inject({
      method,
      url,
      headers: { cookie: cookies[who] },
      ...(payload ? { payload } : {}),
    });
  const create = (who: Who, body: object) => req('POST', '/api/pazienti', who, body);
  const createOk = async (who: Who, body: object) => {
    const res = await create(who, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string; avvisi: string[] }>();
  };
  const view = async (id: string, who: Who = 'titolare') => {
    const res = await req('GET', `/api/pazienti/${id}/amministrazione`, who);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<AdminView>();
  };
  const lastLog = async (patientId: string | null, action: string) => {
    const [row] = await s.db
      .select()
      .from(accessLog)
      .where(
        and(
          patientId ? eq(accessLog.patientId, patientId) : sql`${accessLog.patientId} is null`,
          eq(accessLog.action, action),
        ),
      )
      .orderBy(desc(accessLog.seq))
      .limit(1);
    return row;
  };
  const problems = (body: string) =>
    (JSON.parse(body) as { dettagli?: { problemi?: string[] } }).dettagli?.problemi ?? [];

  it('stati e canali del dominio sono quelli del database', () => {
    expect(PATIENT_STATUSES.map((x) => x.db)).toEqual(patientStatus.enumValues);
    expect(REMINDER_CHANNELS.map((x) => x.db)).toEqual(reminderChannel.enumValues);
  });

  describe('nuovo paziente', () => {
    it('il modulo propone a ciascuno gli archivi in cui può registrare', async () => {
      const options = async (who: Who) => {
        const res = await req('GET', '/api/pazienti/nuovo', who);
        expect(res.statusCode, res.body).toBe(200);
        return res.json<{
          archivi: { id: string; proprio: boolean }[];
          archivioProposto: string | null;
        }>();
      };
      const own = await options('titolare');
      expect(own.archivi.map((a) => a.id)).toEqual([s.archives.titolare]);
      expect(own.archivioProposto).toBe(s.archives.titolare);
      const secretary = await options('segreteria');
      expect(secretary.archivi.map((a) => a.id).sort()).toEqual(
        [s.archives.titolare, s.archives.collega].sort(),
      );
      expect(secretary.archivioProposto).toBeNull();
      expect((await options('sostituto')).archivioProposto).toBe(s.archives.titolare);
      expect((await options('amministratore')).archivi).toEqual([]);
    });

    it('il titolare registra un paziente nel proprio archivio, con residenza e recapiti', async () => {
      const id = person(1);
      const { id: newId, avvisi } = await createOk('titolare', {
        identita: id,
        dati: {
          telefono: '000 0000101',
          email: 'paziente.101@esempio.invalid',
          residenzaVia: 'Via Immaginaria',
          residenzaCivico: '1',
          residenzaCap: '10100',
          residenzaComune: 'Comune immaginario',
          residenzaProvincia: 'xx',
        },
      });
      expect(avvisi).toEqual([]);
      const [row] = await s.db.select().from(patient).where(eq(patient.id, newId));
      expect(row).toMatchObject({
        archiveId: s.archives.titolare,
        lastName: id.cognome,
        fiscalCode: id.codiceFiscale,
        residencePostalCode: '10100',
        residenceProvince: 'XX',
        status: 'active',
      });
      // La cartella si apre subito, e il registro dice chi l'ha creata.
      expect((await req('GET', `/api/pazienti/${newId}`, 'titolare')).statusCode).toBe(200);
      const log = await lastLog(newId, 'nuovo_paziente');
      expect(log).toMatchObject({ outcome: 'consentito', userId: s.users.titolare.id });
      const [history] = await s.db
        .select()
        .from(changeHistory)
        .where(and(eq(changeHistory.tableName, 'patient'), eq(changeHistory.rowId, newId)));
      expect(history).toMatchObject({ operation: 'INSERT', userId: s.users.titolare.id });
    });

    it('la segreteria sceglie l’archivio: senza scelta lo chiede', async () => {
      const missing = await create('segreteria', { identita: person(2) });
      expect(missing.statusCode, missing.body).toBe(400);
      expect(missing.json().errore).toMatch(/Scegli l’archivio/);
      const { id } = await createOk('segreteria', {
        archivioId: s.archives.collega,
        identita: person(2),
      });
      const [row] = await s.db.select().from(patient).where(eq(patient.id, id));
      expect(row!.archiveId).toBe(s.archives.collega);
    });

    it('il sostituto autorizzato registra nell’archivio del titolare, non in un altro', async () => {
      const { id } = await createOk('sostituto', { identita: person(3) });
      const [row] = await s.db.select().from(patient).where(eq(patient.id, id));
      expect(row!.archiveId).toBe(s.archives.titolare);
      const other = await create('sostituto', {
        archivioId: s.archives.collega,
        identita: person(4),
      });
      expect(other.statusCode, other.body).toBe(403);
    });

    it('l’amministratore e il collega fuori dal proprio archivio: 403, registrato come negato', async () => {
      const admin = await create('amministratore', { identita: person(5) });
      expect(admin.statusCode, admin.body).toBe(403);
      expect(await lastLog(null, 'nuovo_paziente')).toMatchObject({
        outcome: 'negato',
        userId: s.users.amministratore.id,
      });
      const colleague = await create('collega', {
        archivioId: s.archives.titolare,
        identita: person(5),
      });
      expect(colleague.statusCode, colleague.body).toBe(403);
      const rows = await s.db
        .select()
        .from(patient)
        .where(eq(patient.fiscalCode, person(5).codiceFiscale));
      expect(rows).toHaveLength(0);
    });

    it('codice fiscale non valido: 400 con il problema spiegato', async () => {
      const bad = person(6);
      const last = bad.codiceFiscale.at(-1)!;
      bad.codiceFiscale = bad.codiceFiscale.slice(0, 15) + (last === 'A' ? 'B' : 'A');
      const res = await create('titolare', { identita: bad });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toMatch(/carattere di controllo del codice fiscale non torna/);
      const short = await create('titolare', { identita: { ...person(6), codiceFiscale: 'ABC' } });
      expect(short.body).toMatch(/il codice fiscale ha 16 caratteri/);
    });

    it('doppione: 409 con il nome a chi lo vede, senza a chi non lo vede', async () => {
      const id = person(7);
      const { id: first } = await createOk('titolare', { identita: id });
      const again = await create('titolare', { identita: { ...id, nome: 'Altra' } });
      expect(again.statusCode, again.body).toBe(409);
      expect(again.json().errore).toContain(id.cognome);
      expect(again.json().dettagli.paziente.id).toBe(first);
      const hidden = await create('collega', { identita: id });
      expect(hidden.statusCode, hidden.body).toBe(409);
      expect(hidden.json().errore).not.toContain(id.cognome);
      expect(hidden.json().dettagli.paziente).toBeNull();
      // Il tentativo resta nel registro del paziente che c'era già.
      expect(await lastLog(first, 'nuovo_paziente')).toMatchObject({
        outcome: 'negato',
        userId: s.users.collega.id,
      });
    });

    it('codice fiscale che non torna con i dati: avviso, e si registra lo stesso', async () => {
      // Codice costruito con un altro nome: può essere proprio quello della tessera.
      const id = { ...person(8), nome: 'Orsola' };
      const check = await req('POST', '/api/pazienti/verifica', 'titolare', {
        codiceFiscale: id.codiceFiscale,
        cognome: id.cognome,
        nome: id.nome,
        sesso: id.sesso,
        nascita: id.nascita,
        luogoNascitaCodice: id.luogoNascitaCodice,
      });
      expect(check.statusCode, check.body).toBe(200);
      expect(check.json().problema).toBeNull();
      expect(check.json().avvisi).toEqual([expect.stringMatching(/^Nome: dal nome si ottiene/)]);
      const { avvisi } = await createOk('titolare', { identita: id });
      expect(avvisi).toEqual(check.json().avvisi);
      const invalid = await req('POST', '/api/pazienti/verifica', 'titolare', {
        codiceFiscale: id.codiceFiscale.slice(0, 15),
      });
      expect(invalid.json()).toEqual({
        problema: 'il codice fiscale ha 16 caratteri',
        avvisi: [],
      });
    });

    it('i dati amministrativi del modulo hanno gli stessi controlli', async () => {
      const res = await create('titolare', {
        identita: person(9),
        dati: { canalePromemoria: 'email' },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(problems(res.body)).toEqual([
        'Per il canale scelto serve il recapito (R15)',
        'Serve la data in cui il paziente ha scelto il canale (R15)',
      ]);
      const future = await create('titolare', { identita: { ...person(9), nascita: day(3) } });
      expect(problems(future.body)).toContain('La data di nascita è nel futuro');
    });
  });

  describe('dati amministrativi', () => {
    let pid: string;
    beforeAll(async () => {
      pid = (await createOk('titolare', { identita: person(20) })).id;
    });

    it('si leggono con i nomi delle API, con le liste di valori', async () => {
      const v = await view(pid, 'segreteria');
      expect(v.paziente.identita.cognome).toBe(person(20).cognome);
      expect(v.paziente.dati.stato).toBe('attivo');
      expect(v.paziente.dati.residenzaCap).toBeNull();
      expect(v.paziente.archivio.id).toBe(s.archives.titolare);
      expect(v.stati.map((x) => x.chiave)).toEqual([
        'attivo',
        'revocato',
        'deceduto',
        'temporaneo',
      ]);
      expect(v.canali.map((x) => x.chiave)).toContain('fascicolo');
      expect(v.medici.map((m) => m.id).sort()).toEqual(
        [s.users.titolare.id, s.users.collega.id].sort(),
      );
      expect(v.puoScrivere).toBe(true);
      expect(await lastLog(pid, 'lettura_dati_amministrativi')).toMatchObject({
        outcome: 'consentito',
        userId: s.users.segreteria.id,
      });
      const denied = await req('GET', `/api/pazienti/${pid}/amministrazione`, 'collega');
      expect(denied.statusCode).toBe(403);
    });

    it('la modifica scrive solo i campi cambiati, con i nomi nel registro e lo storico', async () => {
      const res = await req('PATCH', `/api/pazienti/${pid}/amministrazione`, 'segreteria', {
        telefono: '000 0000120',
        residenzaCap: '10100',
        asl: 'ASL di prova',
        distretto: 'Distretto di prova',
        tipoAssistenza: 'Assistenza di prova',
        tesseraTeam: 'TEAM-PROVA-1',
        enteEstero: 'Ente estero di prova',
        condizioneProfessionale: 'Occupato',
        email: null,
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ campi: string[]; dati: Record<string, string | null> }>();
      // L'email era già vuota: non è un campo cambiato.
      expect(body.campi).toEqual([
        'telefono',
        'residenzaCap',
        'asl',
        'distretto',
        'tipoAssistenza',
        'tesseraTeam',
        'enteEstero',
        'condizioneProfessionale',
      ]);
      expect(body.dati.distretto).toBe('Distretto di prova');
      expect(await lastLog(pid, 'modifica_dati_amministrativi')).toMatchObject({
        outcome: 'riuscito',
        userId: s.users.segreteria.id,
        details: { campi: body.campi },
      });
      const [history] = await s.db
        .select()
        .from(changeHistory)
        .where(
          and(
            eq(changeHistory.tableName, 'patient'),
            eq(changeHistory.rowId, pid),
            eq(changeHistory.operation, 'UPDATE'),
          ),
        )
        .orderBy(desc(changeHistory.id))
        .limit(1);
      expect(history!.userId).toBe(s.users.segreteria.id);
      expect((history!.oldRow as { district: string | null }).district).toBeNull();
      expect((history!.newRow as { district: string }).district).toBe('Distretto di prova');
      // Lo stesso valore una seconda volta: niente da scrivere.
      const same = await req('PATCH', `/api/pazienti/${pid}/amministrazione`, 'titolare', {
        telefono: '000 0000120',
      });
      expect(same.json().campi).toEqual([]);
      const unknown = await req('PATCH', `/api/pazienti/${pid}/amministrazione`, 'titolare', {
        phone: '1',
      });
      expect(unknown.statusCode).toBe(400);
      const empty = await req('PATCH', `/api/pazienti/${pid}/amministrazione`, 'titolare', {});
      expect(empty.statusCode).toBe(400);
    });

    it('decesso: serve la data, non nel futuro, non prima della nascita; causa in ICD-9-CM', async () => {
      const patch = (body: object) =>
        req('PATCH', `/api/pazienti/${pid}/amministrazione`, 'titolare', body);
      expect(problems((await patch({ stato: 'deceduto' })).body)).toEqual([
        'Per un paziente deceduto serve la data',
      ]);
      expect(problems((await patch({ stato: 'deceduto', decedutoIl: day(2) })).body)).toEqual([
        'La data del decesso è nel futuro',
      ]);
      expect(problems((await patch({ stato: 'deceduto', decedutoIl: '1900-01-01' })).body)).toEqual(
        ['La data del decesso viene prima della nascita'],
      );
      expect(
        problems((await patch({ stato: 'deceduto', decedutoIl: day(-1), causaDecesso: 'X' })).body),
      ).toEqual(['Causa del decesso: non è nel formato ICD-9-CM (es. 410.9, V17.3)']);
      const ok = await patch({ stato: 'deceduto', decedutoIl: day(-1), causaDecesso: '410.9' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().dati).toMatchObject({ stato: 'deceduto', causaDecesso: '410.9' });
      // La causa del decesso è un dato clinico (D171): la segreteria non la vede e non la scrive.
      const sec = await req('GET', `/api/pazienti/${pid}/amministrazione`, 'segreteria');
      expect(sec.statusCode, sec.body).toBe(200);
      expect(sec.json().paziente.dati.causaDecesso).toBeUndefined();
      expect(sec.json().paziente.causaDecessoRiservata).toBe(true);
      expect(sec.body).not.toContain('410.9');
      const secWrite = await req('PATCH', `/api/pazienti/${pid}/amministrazione`, 'segreteria', {
        causaDecesso: '427.5',
      });
      expect(secWrite.statusCode).toBe(403);
      const doc = await req('GET', `/api/pazienti/${pid}/amministrazione`, 'titolare');
      expect(doc.json().paziente.dati.causaDecesso).toBe('410.9');
      expect(doc.json().paziente.causaDecessoRiservata).toBe(false);
      // Tornare «in carico» vuol dire togliere anche data e causa.
      expect(problems((await patch({ stato: 'attivo' })).body)).toEqual([
        'La data del decesso vale solo per un paziente deceduto',
        'La causa del decesso vale solo per un paziente deceduto',
      ]);
      const back = await patch({ stato: 'attivo', decedutoIl: null, causaDecesso: null });
      expect(back.statusCode, back.body).toBe(200);
      const [row] = await s.db.select().from(patient).where(eq(patient.id, pid));
      expect(row).toMatchObject({ status: 'active', deceasedOn: null, deathCauseIcd: null });
    });

    it('canale del promemoria (R15): canale, recapito e data della scelta', async () => {
      const patch = (body: object) =>
        req('PATCH', `/api/pazienti/${pid}/amministrazione`, 'segreteria', body);
      expect(problems((await patch({ canalePromemoria: 'sms' })).body)).toEqual([
        'Per il canale scelto serve il recapito (R15)',
        'Serve la data in cui il paziente ha scelto il canale (R15)',
      ]);
      expect(
        problems(
          (
            await patch({
              canalePromemoria: 'sms',
              recapitoPromemoria: '000 0000120',
              canaleSceltoIl: day(1),
            })
          ).body,
        ),
      ).toEqual(['La data della scelta del canale è nel futuro']);
      const ok = await patch({
        canalePromemoria: 'sms',
        recapitoPromemoria: '000 0000120',
        canaleSceltoIl: day(0),
      });
      expect(ok.statusCode, ok.body).toBe(200);
      const [row] = await s.db.select().from(patient).where(eq(patient.id, pid));
      // Le colonne che legge R15 (rules-check): canale, recapito, data della scelta.
      expect(row).toMatchObject({
        reminderChannel: 'sms',
        reminderContact: '000 0000120',
        reminderChannelChosenOn: day(0),
      });
      // La carta non vuole un recapito, ma la data della scelta sì.
      const paper = await patch({ canalePromemoria: 'carta', recapitoPromemoria: null });
      expect(paper.statusCode, paper.body).toBe(200);
      expect(paper.json().dati.canalePromemoria).toBe('carta');
    });
  });

  describe('correzione dell’identità', () => {
    let pid: string;
    beforeAll(async () => {
      pid = (await createOk('titolare', { identita: person(30) })).id;
    });

    it('vuole un motivo di almeno una frase', async () => {
      const res = await req('POST', `/api/pazienti/${pid}/identita`, 'segreteria', {
        cognome: 'Lauretani',
        motivo: 'errore',
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toMatch(/almeno 10 caratteri/);
      const none = await req('POST', `/api/pazienti/${pid}/identita`, 'segreteria', {
        cognome: person(30).cognome,
        motivo: 'Nessun cambiamento, per prova',
      });
      expect(none.statusCode, none.body).toBe(400);
    });

    it('corregge, registra campi e motivo, conserva il valore di prima e avvisa delle incoerenze', async () => {
      const motivo = 'Errore di trascrizione dalla tessera sanitaria';
      const res = await req('POST', `/api/pazienti/${pid}/identita`, 'segreteria', {
        cognome: 'Lauretani',
        motivo,
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json<{ campi: string[]; avvisi: string[] }>();
      expect(body.campi).toEqual(['cognome']);
      // Il codice fiscale è rimasto quello di prima: non torna più con il cognome.
      expect(body.avvisi).toEqual([expect.stringMatching(/^Cognome:/)]);
      expect(await lastLog(pid, 'correzione_identita')).toMatchObject({
        outcome: 'riuscito',
        userId: s.users.segreteria.id,
        details: { campi: ['cognome'], motivo },
      });
      const [history] = await s.db
        .select()
        .from(changeHistory)
        .where(
          and(
            eq(changeHistory.tableName, 'patient'),
            eq(changeHistory.rowId, pid),
            eq(changeHistory.operation, 'UPDATE'),
          ),
        )
        .orderBy(desc(changeHistory.id))
        .limit(1);
      expect((history!.oldRow as { last_name: string }).last_name).toBe(person(30).cognome);
      expect((history!.newRow as { last_name: string }).last_name).toBe('Lauretani');
      const v = await view(pid);
      expect(v.correzioni[0]).toMatchObject({
        campi: ['cognome'],
        motivo,
        utente: 'Lucia Bassi',
      });
    });

    it('il codice fiscale corretto non può essere di un altro paziente; nuovo, si controlla', async () => {
      const other = person(31);
      const { id: otherId } = await createOk('titolare', { identita: other });
      const clash = await req('POST', `/api/pazienti/${pid}/identita`, 'titolare', {
        codiceFiscale: other.codiceFiscale,
        motivo: 'Codice fiscale corretto dalla tessera',
      });
      expect(clash.statusCode, clash.body).toBe(409);
      // Lo dice il controllo dei doppioni, prima del vincolo del database, e resta nel registro.
      expect(clash.json().errore).toMatch(/^Il codice fiscale è già registrato: /);
      expect(await lastLog(otherId, 'correzione_identita')).toMatchObject({
        outcome: 'negato',
        userId: s.users.titolare.id,
      });
      const [unchanged] = await s.db.select().from(patient).where(eq(patient.id, pid));
      expect(unchanged!.fiscalCode).toBe(person(30).codiceFiscale);
      const invalid = await req('POST', `/api/pazienti/${pid}/identita`, 'titolare', {
        codiceFiscale: 'NONVALIDO',
        motivo: 'Codice fiscale corretto dalla tessera',
      });
      expect(invalid.statusCode).toBe(400);
      const fixed = buildFiscalCode({
        surname: 'Lauretani',
        name: person(30).nome,
        birthDate: person(30).nascita,
        sex: 'F',
        placeCode: person(30).luogoNascitaCodice,
      });
      const ok = await req('POST', `/api/pazienti/${pid}/identita`, 'titolare', {
        codiceFiscale: fixed.toLowerCase(),
        motivo: 'Codice fiscale corretto dalla tessera',
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ campi: ['codiceFiscale'], avvisi: [] });
      expect(ok.json().identita.codiceFiscale).toBe(fixed);
    });

    it('l’amministratore e il collega non correggono', async () => {
      for (const who of ['amministratore', 'collega'] as const) {
        const res = await req('POST', `/api/pazienti/${pid}/identita`, who, {
          nome: 'Altro',
          motivo: 'Tentativo senza permesso',
        });
        expect(res.statusCode).toBe(403);
      }
    });
  });

  describe('esenzioni', () => {
    let pid: string;
    beforeAll(async () => {
      pid = (await createOk('titolare', { identita: person(40) })).id;
    });
    const add = (body: object, who: Who = 'segreteria') =>
      req('POST', `/api/pazienti/${pid}/esenzioni`, who, body);

    it('si registrano con codice, validità e codice in ricetta; le date si controllano', async () => {
      const res = await add({ codice: 'p01', dal: day(-30), al: day(300), codiceRicetta: 'p01' });
      expect(res.statusCode, res.body).toBe(201);
      const [row] = await s.db.select().from(exemption).where(eq(exemption.id, res.json().id));
      expect(row).toMatchObject({ code: 'P01', prescriptionCode: 'P01', source: 'manual' });
      expect((await add({ codice: 'P02', dal: day(0), al: day(-1) })).statusCode).toBe(400);
      // Lo stesso codice in un periodo che si sovrappone: prima si chiude l'altra.
      const overlap = await add({ codice: 'P01', dal: day(10) });
      expect(overlap.statusCode, overlap.body).toBe(409);
      expect(overlap.json().errore).toMatch(/chiudi quella validità/);
      const v = await view(pid);
      expect(v.esenzioni[0]).toMatchObject({
        codice: 'P01',
        stato: 'valida',
        fonte: 'Inserita a mano',
      });
      expect(v.catalogoEsenzioni).toBe(false);
      expect(v.esenzioni[0]!.nelCatalogo).toBeNull();
    });

    it('si chiude la validità e si cambia il codice in ricetta; non si cancellano', async () => {
      const [row] = await s.db
        .select()
        .from(exemption)
        .where(and(eq(exemption.patientId, pid), eq(exemption.code, 'P01')));
      const url = `/api/pazienti/${pid}/esenzioni/${row!.id}`;
      const before = await req('PATCH', url, 'titolare', { al: day(-31) });
      expect(before.statusCode, before.body).toBe(400);
      const close = await req('PATCH', url, 'titolare', { al: day(-1) });
      expect(close.statusCode, close.body).toBe(200);
      const code = await req('PATCH', url, 'titolare', { codiceRicetta: 'P01A' });
      expect(code.statusCode, code.body).toBe(200);
      const v = await view(pid);
      expect(v.esenzioni.find((e) => e.id === row!.id)).toMatchObject({
        al: day(-1),
        codiceRicetta: 'P01A',
        stato: 'scaduta',
      });
      // Chiusa la prima, la nuova dello stesso codice entra.
      expect((await add({ codice: 'P01', dal: day(0) })).statusCode).toBe(201);
      expect(await lastLog(pid, 'modifica_esenzione')).toMatchObject({ outcome: 'consentito' });
      const history = await s.db
        .select()
        .from(changeHistory)
        .where(and(eq(changeHistory.tableName, 'exemption'), eq(changeHistory.rowId, row!.id)))
        .orderBy(changeHistory.id);
      expect(history.map((h) => h.operation)).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
      await rejectsWith(
        s.db.delete(exemption).where(eq(exemption.id, row!.id)),
        /non si cancellano/,
      );
      const other = await req(
        'PATCH',
        `/api/pazienti/${s.richPatient}/esenzioni/${row!.id}`,
        'titolare',
        {
          al: day(0),
        },
      );
      expect(other.statusCode).toBe(404);
    });

    it('con il catalogo delle esenzioni importato, avvisa se il codice non c’è', async () => {
      const [ds] = await s.db
        .insert(referenceDataset)
        .values({
          kind: 'esenzioni',
          series: 'esenzioni-prova',
          title: 'Catalogo delle esenzioni di prova',
          mappingVersion: '1',
          origin: 'trascrizione',
          sha256: 'prova-pannello',
          bytes: 1,
          validFrom: day(-60),
          validFromBasis: 'atto',
          rows: 1,
          importedBy: 'prova',
        })
        .returning();
      await s.db
        .insert(refExemption)
        .values({ datasetId: ds!.id, code: 'C01', description: 'Esenzione di prova' });
      const known = await add({ codice: 'C01', dal: day(-10) });
      expect(known.json().avvisi).toEqual([]);
      const unknown = await add({ codice: 'Z99', dal: day(-10) });
      expect(unknown.statusCode, unknown.body).toBe(201);
      expect(unknown.json().avvisi).toEqual([
        expect.stringMatching(
          /^Il codice Z99 non è nel catalogo delle esenzioni in vigore il .*né in quello in vigore oggi/,
        ),
      ]);
      // Prima del catalogo non si sa: nessun avviso per quella data.
      const old = await add({ codice: 'Z98', dal: day(-90), al: day(-70) });
      expect(old.json().avvisi).toEqual([]);
      const v = await view(pid);
      expect(v.catalogoEsenzioni).toBe(true);
      expect(v.esenzioni.find((e) => e.codice === 'Z99')!.nelCatalogo).toBe(false);
      expect(v.esenzioni.find((e) => e.codice === 'C01')!.nelCatalogo).toBe(true);
    });
  });

  describe('scelta del medico', () => {
    let pid: string;
    beforeAll(async () => {
      pid = (await createOk('titolare', { identita: person(50) })).id;
    });
    const add = (body: object) => req('POST', `/api/pazienti/${pid}/scelte`, 'segreteria', body);

    it('è di un medico titolare dello studio, una alla volta', async () => {
      const notDoctor = await add({ medicoId: s.users.segreteria.id, dal: day(-100) });
      expect(notDoctor.statusCode, notDoctor.body).toBe(400);
      expect(notDoctor.json().errore).toMatch(/non è un medico titolare/);
      const res = await add({ medicoId: s.users.titolare.id, dal: day(-100) });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().avvisi).toEqual([]);
      const [row] = await s.db
        .select()
        .from(patientChoice)
        .where(eq(patientChoice.id, res.json().id));
      expect(row).toMatchObject({ doctorUserId: s.users.titolare.id, source: 'manual' });
      const second = await add({ medicoId: s.users.collega.id, dal: day(-10) });
      expect(second.statusCode, second.body).toBe(409);
      const noReason = await add({
        medicoId: s.users.collega.id,
        dal: day(-300),
        cessataIl: day(-200),
      });
      expect(problems(noReason.body)).toEqual(['Per la cessazione serve il motivo']);
    });

    it('la cessazione vuole data e motivo; poi entra una scelta nuova', async () => {
      const [row] = await s.db.select().from(patientChoice).where(eq(patientChoice.patientId, pid));
      const url = `/api/pazienti/${pid}/scelte/${row!.id}`;
      expect((await req('PATCH', url, 'titolare', { cessataIl: day(-1) })).statusCode).toBe(400);
      expect(
        (await req('PATCH', url, 'titolare', { cessataIl: day(-200), motivoCessazione: 'Prova' }))
          .statusCode,
      ).toBe(400);
      const end = await req('PATCH', url, 'titolare', {
        cessataIl: day(-1),
        motivoCessazione: 'Revoca per trasferimento, dato di prova',
      });
      expect(end.statusCode, end.body).toBe(200);
      const again = await req('PATCH', url, 'titolare', {
        cessataIl: day(-1),
        motivoCessazione: 'Seconda volta',
      });
      expect(again.statusCode).toBe(409);
      // Il collega non è il titolare dell'archivio del paziente: si registra, con un avviso.
      const next = await add({ medicoId: s.users.collega.id, dal: day(0) });
      expect(next.statusCode, next.body).toBe(201);
      expect(next.json().avvisi).toEqual([
        expect.stringMatching(/non è il titolare dell’archivio/),
      ]);
      const v = await view(pid);
      expect(v.scelte.map((c) => c.stato)).toEqual(['in_corso', 'cessata']);
      expect(v.scelte[1]).toMatchObject({
        medico: 'Dott.ssa Elena Marchi',
        motivoCessazione: 'Revoca per trasferimento, dato di prova',
      });
      expect(await lastLog(pid, 'modifica_scelta')).toMatchObject({ outcome: 'consentito' });
      expect(await lastLog(pid, 'nuova_scelta')).toMatchObject({ outcome: 'consentito' });
      const history = await s.db
        .select()
        .from(changeHistory)
        .where(and(eq(changeHistory.tableName, 'patient_choice'), eq(changeHistory.rowId, row!.id)))
        .orderBy(changeHistory.id);
      expect(history.map((h) => h.operation)).toEqual(['INSERT', 'UPDATE']);
    });
  });

  describe('nucleo familiare', () => {
    let a: string;
    let b: string;
    let c: string;
    beforeAll(async () => {
      a = (await createOk('titolare', { identita: person(60) })).id;
      b = (await createOk('titolare', { identita: person(61) })).id;
      c = (await createOk('segreteria', { archivioId: s.archives.collega, identita: person(62) }))
        .id;
    });
    const put = (id: string, who: Who, body?: object) =>
      req('PUT', `/api/pazienti/${id}/nucleo`, who, body);

    it('si crea con un’etichetta e si unisce un altro paziente', async () => {
      const created = await put(a, 'titolare', { etichetta: 'Famiglia di prova' });
      expect(created.statusCode, created.body).toBe(200);
      const familyId = created.json().nucleo as string;
      const [f] = await s.db.select().from(family).where(eq(family.id, familyId));
      expect(f).toMatchObject({ label: 'Famiglia di prova', studioId: s.studioId });
      const joined = await put(b, 'titolare', { conPaziente: a });
      expect(joined.statusCode, joined.body).toBe(200);
      expect(joined.json().nucleo).toBe(familyId);
      // La lettura dell'altro paziente resta nel suo registro.
      expect(await lastLog(a, 'lettura_dati_amministrativi')).toMatchObject({
        outcome: 'consentito',
        userId: s.users.titolare.id,
      });
      expect(await lastLog(b, 'modifica_dati_amministrativi')).toMatchObject({
        outcome: 'riuscito',
        details: { campi: ['nucleo'] },
      });
      const v = await view(a);
      expect(v.paziente.nucleo).toMatchObject({ etichetta: 'Famiglia di prova' });
      expect(v.paziente.nucleo!.componenti.map((m) => m.id)).toEqual([b]);
      const history = await s.db
        .select()
        .from(changeHistory)
        .where(and(eq(changeHistory.tableName, 'family'), eq(changeHistory.rowId, familyId)));
      expect(history).toMatchObject([{ operation: 'INSERT', userId: s.users.titolare.id }]);
    });

    it('chi non vede un componente non lo vede nel nucleo, e non lo può unire', async () => {
      const joined = await put(c, 'segreteria', { conPaziente: a });
      expect(joined.statusCode, joined.body).toBe(200);
      expect(
        (await view(a, 'segreteria')).paziente.nucleo!.componenti.map((m) => m.id).sort(),
      ).toEqual([b, c].sort());
      expect((await view(a, 'titolare')).paziente.nucleo!.componenti.map((m) => m.id)).toEqual([b]);
      // Il titolare non vede il paziente del collega: 403, registrato nel registro di quel paziente.
      const denied = await put(b, 'titolare', { conPaziente: c });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(await lastLog(c, 'lettura_dati_amministrativi')).toMatchObject({
        outcome: 'negato',
        userId: s.users.titolare.id,
      });
    });

    it('si rinomina, si toglie un paziente; i casi senza senso si fermano', async () => {
      const renamed = await req('PATCH', `/api/pazienti/${b}/nucleo`, 'segreteria', {
        etichetta: 'Famiglia di prova, via immaginaria',
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect((await view(a)).paziente.nucleo!.etichetta).toBe('Famiglia di prova, via immaginaria');
      const left = await put(b, 'titolare', { nessuno: true });
      expect(left.statusCode, left.body).toBe(200);
      expect((await view(a)).paziente.nucleo!.componenti).toEqual([]);
      expect((await put(b, 'titolare', { nessuno: true })).statusCode).toBe(409);
      expect((await put(a, 'titolare', { conPaziente: a })).statusCode).toBe(400);
      // L'altro paziente non è in un nucleo: prima si crea.
      const lonely = await put(a, 'titolare', { conPaziente: b });
      expect(lonely.statusCode, lonely.body).toBe(409);
      expect((await put(a, 'titolare', {})).statusCode).toBe(400);
      expect((await put(a, 'titolare')).statusCode).toBe(400);
      const [row] = await s.db.select().from(patient).where(eq(patient.id, b));
      expect(row!.familyId).toBeNull();
    });
  });

  describe('sostituto senza autorizzazione', () => {
    beforeAll(async () => {
      await withActor(s.db, s.users.titolare.id, (tx) =>
        tx
          .update(archiveGrant)
          .set({ revokedAt: new Date() })
          .where(eq(archiveGrant.granteeUserId, s.users.sostituto.id)),
      );
    });

    it('non registra pazienti e non tocca i dati amministrativi', async () => {
      const res = await create('sostituto', { identita: person(70) });
      expect(res.statusCode, res.body).toBe(403);
      expect((await req('GET', '/api/pazienti/nuovo', 'sostituto')).json().archivi).toEqual([]);
      const patch = await req(
        'PATCH',
        `/api/pazienti/${s.richPatient}/amministrazione`,
        'sostituto',
        { telefono: '000 0000170' },
      );
      expect(patch.statusCode).toBe(403);
      expect(await lastLog(s.richPatient, 'modifica_dati_amministrativi')).toMatchObject({
        outcome: 'negato',
        userId: s.users.sostituto.id,
      });
    });
  });
});
