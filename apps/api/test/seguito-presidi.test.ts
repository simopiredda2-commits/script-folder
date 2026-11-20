import { createHash, randomBytes } from 'node:crypto';
import { supplyEndOn } from '@mmg/domain';
import { sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { referenceDataset, refSupply } from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { studioDayFrom } from './helpers/dates';

/** Un PDF minimo inventato: basta la firma %PDF- e un po' di testo. */
const PDF = Buffer.from('%PDF-1.4\n% referto di prova, paziente inventato\n%%EOF\n', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

interface FollowUp {
  prestazioni: {
    rigaId: string;
    descrizione: string;
    quantita: number;
    eseguite: number;
    esecuzioni: {
      id: string;
      data: string;
      struttura: string | null;
      esito: string | null;
      seduta: number | null;
      stato: string;
      referto: { allegatoId: string; nome: string; tipo: string; dimensione: number } | null;
    }[];
  }[];
  puoScrivere: boolean;
}

describe('seguito delle prestazioni prescritte (tappa 10)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let secretary: string;
  let visitLine: string;
  let cycleLine: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    secretary = await login(s, 'segreteria');
    const res = await req('POST', `/api/pazienti/${s.richPatient}/ricette`, doctor, {
      kind: 'specialist_ssn',
      accessType: 'first',
      priority: 'P',
      diagnosticQuestion: 'Quesito di prova',
      lines: [
        {
          serviceCode: 'PROVA.V',
          serviceNationalCode: 'PROVA.V',
          serviceDescription: 'Visita di prova',
          quantity: 1,
        },
        {
          serviceCode: 'PROVA.R',
          serviceNationalCode: 'PROVA.R',
          serviceDescription: 'Ciclo di prova',
          quantity: 3,
        },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const sent = await req('POST', `/api/ricette/${res.json().id}/firma-e-invia`, doctor, {});
    expect(sent.statusCode, sent.body).toBe(200);
    const f = await followUp();
    visitLine = f.prestazioni.find((p) => p.descrizione === 'Visita di prova')!.rigaId;
    cycleLine = f.prestazioni.find((p) => p.descrizione === 'Ciclo di prova')!.rigaId;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const day = (offset: number) => studioDayFrom(s.clock.now(), offset);
  function req(method: 'GET' | 'POST', url: string, cookie: string, payload?: object) {
    return s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  }
  const url = () => `/api/pazienti/${s.richPatient}/seguito`;
  async function followUp(cookie = doctor) {
    const res = await req('GET', url(), cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<FollowUp>();
  }
  const pdf = (bytes = PDF, tipo = 'application/pdf') => ({
    nome: 'referto di prova.pdf',
    tipo,
    contenuto: bytes.toString('base64'),
  });

  it('le prestazioni prescritte, con quante sono eseguite', async () => {
    const f = await followUp();
    expect(f.puoScrivere).toBe(true);
    expect(f.prestazioni.find((p) => p.rigaId === cycleLine)).toMatchObject({
      quantita: 3,
      eseguite: 0,
      esecuzioni: [],
    });
  });

  it('esecuzione con struttura, esito e referto: il file si scarica uguale, senza script', async () => {
    const res = await req('POST', url(), doctor, {
      rigaId: visitLine,
      data: day(0),
      struttura: 'Struttura di prova',
      esito: 'Esito di prova',
      referto: pdf(),
    });
    expect(res.statusCode, res.body).toBe(201);
    const v = (await followUp()).prestazioni.find((p) => p.rigaId === visitLine)!;
    expect(v.eseguite).toBe(1);
    const x = v.esecuzioni[0]!;
    expect(x).toMatchObject({ struttura: 'Struttura di prova', esito: 'Esito di prova' });
    expect(x.referto).toMatchObject({ tipo: 'application/pdf', dimensione: PDF.length });
    const file = await req(
      'GET',
      `/api/pazienti/${s.richPatient}/allegati/${x.referto!.allegatoId}`,
      doctor,
    );
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-security-policy']).toBe('sandbox');
    expect(Buffer.from(file.rawPayload).equals(PDF)).toBe(true);
    // Il referto è anche una voce della cronologia.
    const timeline = (await req('GET', `/api/pazienti/${s.richPatient}/cronologia`, doctor)).json()
      .cronologia as { tipo: string; titolo: string }[];
    expect(timeline).toContainEqual(
      expect.objectContaining({ tipo: 'report', titolo: 'Visita di prova' }),
    );
  });

  it('controlli: date, sedute, tipo e dimensione del file, righe che non sono del seguito', async () => {
    const bad = async (body: object, pattern: RegExp, status = 400) => {
      const res = await req('POST', url(), doctor, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 120)).toBe(status);
      expect(JSON.stringify(res.json())).toMatch(pattern);
    };
    await bad({ rigaId: cycleLine, data: day(1) }, /nel futuro/);
    await bad({ rigaId: cycleLine, data: day(-1) }, /prima della prescrizione/);
    await bad({ rigaId: cycleLine, data: day(0), seduta: 4 }, /ne prevede 3/);
    await bad(
      { rigaId: visitLine, data: day(0), referto: pdf(PDF, 'image/png') },
      /tipo dichiarato/,
    );
    await bad({ rigaId: visitLine, data: day(0), referto: pdf(PNG) }, /tipo dichiarato/);
    await bad(
      {
        rigaId: visitLine,
        data: day(0),
        referto: { ...pdf(), contenuto: 'non è base64!' },
      },
      /base64/,
    );
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x20);
    PDF.copy(big);
    await bad({ rigaId: visitLine, data: day(0), referto: pdf(big) }, /supera 5 MB/);
    // Una riga di un altro paziente non si trova; una riga di farmaci non ha seguito.
    const other = s.patients.titolare.find((x) => x !== s.richPatient)!;
    const foreign = await req('POST', `/api/pazienti/${other}/seguito`, doctor, {
      rigaId: visitLine,
      data: day(0),
    });
    expect(foreign.statusCode).toBe(404);
    const draft = await req('POST', `/api/pazienti/${s.richPatient}/ricette`, doctor, {
      kind: 'pharma_ssn',
      lines: [{ drugName: 'Farmaco di prova 5 mg', quantity: 1 }],
    });
    const lineId = (
      await t.db.execute<{ id: string }>(
        sql`select id from prescription_line where prescription_id = ${draft.json().id}`,
      )
    ).rows[0]!.id;
    await bad({ rigaId: lineId, data: day(0) }, /ricetta specialistica/);
  });

  it('sedute di un ciclo: una per numero; annullata, il numero si può riusare', async () => {
    const add = (seduta: number) =>
      req('POST', url(), doctor, { rigaId: cycleLine, data: day(0), seduta });
    expect((await add(1)).statusCode).toBe(201);
    const second = await add(2);
    expect(second.statusCode).toBe(201);
    const dup = await add(2);
    expect(dup.statusCode).toBe(400);
    expect(dup.json().errore).toMatch(/già registrata/);
    let c = (await followUp()).prestazioni.find((p) => p.rigaId === cycleLine)!;
    expect(c.eseguite).toBe(2);
    const annul = `${url()}/${second.json().id}/annulla`;
    expect((await req('POST', annul, doctor, {})).statusCode).toBe(400);
    expect((await req('POST', annul, doctor, { motivo: 'Seduta saltata' })).statusCode).toBe(200);
    expect((await req('POST', annul, doctor, { motivo: 'Ancora' })).statusCode).toBe(409);
    c = (await followUp()).prestazioni.find((p) => p.rigaId === cycleLine)!;
    expect(c.eseguite).toBe(1);
    expect(c.esecuzioni.find((x) => x.id === second.json().id)!.stato).toBe('annullata');
    expect((await add(2)).statusCode).toBe(201);
  });

  it('annullata l’esecuzione, anche il suo referto è annullato', async () => {
    const res = await req('POST', url(), doctor, {
      rigaId: visitLine,
      data: day(0),
      esito: 'Da annullare',
      referto: pdf(),
    });
    const id = res.json().id as string;
    await req('POST', `${url()}/${id}/annulla`, doctor, { motivo: 'Referto di un altro' });
    const [row] = (
      await t.db.execute<{ status: string; annul_reason: string }>(sql`
        select e.status, e.annul_reason from service_execution x
        join clinical_entry e on e.id = x.report_entry_id where x.id = ${id}`)
    ).rows;
    expect(row).toEqual({ status: 'annulled', annul_reason: 'Referto di un altro' });
  });

  it('la segreteria non scrive, non legge il seguito e non scarica i referti', async () => {
    expect(
      (await req('POST', url(), secretary, { rigaId: visitLine, data: day(0) })).statusCode,
    ).toBe(403);
    expect((await req('GET', url(), secretary)).statusCode).toBe(403);
    const x = (await followUp()).prestazioni.flatMap((p) => p.esecuzioni).find((e) => e.referto)!;
    const file = await req(
      'GET',
      `/api/pazienti/${s.richPatient}/allegati/${x.referto!.allegatoId}`,
      secretary,
    );
    expect(file.statusCode).toBe(403);
  });

  it('i referti sono nell’esportazione: nel JSON in base64, nello ZIP come file', async () => {
    const json = await req('GET', '/api/esportazione', doctor);
    expect(json.statusCode).toBe(200);
    const doc = json.json<{
      allegati: { id: string; sha256: string; contenuto_base64: string }[];
      tabelle: { service_execution: unknown[]; supply_prescription: unknown[] };
    }>();
    expect(doc.tabelle.service_execution.length).toBeGreaterThan(0);
    const a = doc.allegati[0]!;
    const bytes = Buffer.from(a.contenuto_base64, 'base64');
    expect(bytes.equals(PDF)).toBe(true);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(a.sha256);
    const zip = await req('GET', '/api/esportazione?formato=csv', doctor);
    const files = unzipSync(new Uint8Array(zip.rawPayload));
    const name = Object.keys(files).find((f) => f.startsWith(`allegati/${a.id}-`))!;
    expect(Buffer.from(files[name]!).equals(PDF)).toBe(true);
    expect(Object.keys(files)).toContain('allegati.csv');
  });

  it('il contenuto degli allegati non si modifica e non si cancella', async () => {
    await expect(
      t.db.execute(sql`update attachment_content set content = '\\x00'`),
    ).rejects.toThrow();
    await expect(t.db.execute(sql`delete from attachment_content`)).rejects.toThrow();
  });
});

interface Supplies {
  presidi: {
    id: string;
    categoria: string;
    nomeCategoria: string;
    fonte: string | null;
    dal: string;
    al: string;
    mesi: number;
    stato: string;
    rinnovaId: string | null;
    riservato: boolean;
    primoSpecialista: string | null;
  }[];
  puoScrivere: boolean;
}

describe('presidi e assistenza integrativa (tappa 10)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let secretary: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    secretary = await login(s, 'segreteria');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const day = (offset: number) => studioDayFrom(s.clock.now(), offset);
  const req = (method: 'GET' | 'POST', url: string, cookie: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const url = () => `/api/pazienti/${s.richPatient}/presidi`;
  const list = async (cookie = doctor) => {
    const res = await req('GET', url(), cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Supplies>();
  };
  const strips = (extra: object = {}) => ({
    categoria: 'diabetici',
    prodotto: 'Strisce reattive di prova',
    quantitaMensile: 50,
    unita: 'strisce',
    mesi: 6,
    dal: day(0),
    ...extra,
  });

  it('il medico prescrive un presidio con fabbisogno mensile e durata; la segreteria lo vede', async () => {
    const res = await req('POST', url(), doctor, strips());
    expect(res.statusCode, res.body).toBe(201);
    expect((await req('POST', url(), secretary, strips())).statusCode).toBe(403);
    const seen = await list(secretary);
    expect(seen.puoScrivere).toBe(false);
    const p = seen.presidi.find((x) => x.id === res.json().id)!;
    expect(p).toMatchObject({ categoria: 'diabetici', stato: 'in_corso', dal: day(0) });
    expect(p.al).toBe(supplyEndOn(day(0), 6));
    expect(p.fonte).toMatch(/DPCM 12\/1\/2017 \(LEA\), art\. 13/);
  });

  it('medicazioni avanzate: prima prescrizione dello specialista, poi il medico per al massimo 6 mesi', async () => {
    const adv = (extra: object) =>
      req(
        'POST',
        url(),
        doctor,
        strips({
          categoria: 'medicazione_avanzata',
          prodotto: 'Medicazione avanzata di prova',
          unita: 'pezzi',
          ...extra,
        }),
      );
    const r1 = await adv({});
    expect(r1.statusCode).toBe(400);
    expect(r1.json().errore).toMatch(/la prima prescrizione è dello specialista/);
    const specialist = { primoSpecialista: 'Specialista di prova', primoSpecialistaIl: day(-30) };
    const r2 = await adv({ ...specialist, mesi: 7 });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().errore).toMatch(/al massimo 6 mesi/);
    expect((await adv({ ...specialist, primoSpecialistaIl: day(1) })).statusCode).toBe(400);
    const ok = await adv({ ...specialist, mesi: 6 });
    expect(ok.statusCode, ok.body).toBe(201);
    // Prescritto dallo specialista: il limite del medico di famiglia non vale.
    expect((await adv({ prescrittore: 'specialista', mesi: 12 })).statusCode).toBe(201);
    // Il rinnovo resta del medico di famiglia: 8 mesi no.
    const renew = await req('POST', `${url()}/${ok.json().id}/rinnova`, doctor, { mesi: 8 });
    expect(renew.statusCode).toBe(400);
  });

  it('rinnovo: riparte dal giorno dopo, la precedente si conclude; non si rinnova due volte', async () => {
    const first = (
      await req('POST', url(), doctor, strips({ prodotto: 'Aghi di prova', mesi: 3 }))
    ).json().id as string;
    const renew = await req('POST', `${url()}/${first}/rinnova`, doctor, {});
    expect(renew.statusCode, renew.body).toBe(201);
    const all = await list();
    const old = all.presidi.find((x) => x.id === first)!;
    const next = all.presidi.find((x) => x.id === renew.json().id)!;
    expect(old.stato).toBe('conclusa');
    expect(next).toMatchObject({ rinnovaId: first, mesi: 3, stato: 'in_corso' });
    expect(next.dal > old.al).toBe(true);
    expect((await req('POST', `${url()}/${first}/rinnova`, doctor, {})).statusCode).toBe(409);
  });

  it('annullamento con motivo; i riservati non li vede la segreteria; indicazione del paziente', async () => {
    const id = (await req('POST', url(), doctor, strips({ prodotto: 'Da annullare' }))).json()
      .id as string;
    const annul = `${url()}/${id}/annulla`;
    expect((await req('POST', annul, doctor, {})).statusCode).toBe(400);
    expect((await req('POST', annul, doctor, { motivo: 'Errore di prova' })).statusCode).toBe(200);
    expect((await req('POST', annul, doctor, { motivo: 'Ancora' })).statusCode).toBe(409);
    expect((await list()).presidi.find((x) => x.id === id)!.stato).toBe('annullata');

    const reserved = (
      await req('POST', url(), doctor, strips({ prodotto: 'Riservato di prova', riservato: true }))
    ).json().id as string;
    expect((await list()).presidi.map((x) => x.id)).toContain(reserved);
    expect((await list(secretary)).presidi.map((x) => x.id)).not.toContain(reserved);

    const other = s.patients.titolare.find((x) => x !== s.richPatient)!;
    const [problem] = (
      await t.db.execute<{ id: string }>(sql`
        select e.id from clinical_entry e join problem_detail d on d.entry_id = e.id
        where e.patient_id = ${s.richPatient} limit 1`)
    ).rows;
    expect(
      (
        await req(
          'POST',
          `/api/pazienti/${other}/presidi`,
          doctor,
          strips({ indicazione: problem!.id }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await req('POST', url(), doctor, strips({ indicazione: problem!.id }))).statusCode,
    ).toBe(201);
  });

  it('le categorie hanno la loro fonte', async () => {
    const res = await req('GET', '/api/presidi/categorie', secretary);
    const cats = res.json<{ categorie: { chiave: string; fonte: string | null }[] }>().categorie;
    expect(cats.find((c) => c.chiave === 'monouso')!.fonte).toMatch(/art\. 11 e allegato 2/);
    expect(cats.find((c) => c.chiave === 'medicazione_avanzata')!.fonte).toMatch(/6 mesi/);
  });

  it('i presidi non si cancellano', async () => {
    await expect(t.db.execute(sql`delete from supply_prescription`)).rejects.toThrow();
  });

  it('nomenclatore dell’allegato 3 (D218): vuoto senza banca dati, poi presidi e malattie rare', async () => {
    const catalog = async () => {
      const res = await req('GET', '/api/presidi/nomenclatore', secretary);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{
        presidi: { codice: string; descrizione: string; gruppo: string; allegato: string }[];
        malattieRare: { codice: string; descrizione: string }[];
      }>();
    };
    expect(await catalog()).toEqual({ presidi: [], malattieRare: [] });
    // Due serie inventate: la seconda, più recente, riscrive una voce e ne aggiunge una; una
    // terza comincia domani e oggi non vale.
    const series = async (name: string, validFrom: string, rows: string[][]) => {
      const [d] = await t.db
        .insert(referenceDataset)
        .values({
          kind: 'presidi',
          series: name,
          title: `Nomenclatore di prova ${name}`,
          mappingVersion: 'prova',
          origin: 'trascrizione',
          sha256: randomBytes(32).toString('hex'),
          bytes: 1,
          validFrom,
          validFromBasis: 'atto',
          act: `Atto di prova ${name}`,
          rows: rows.length,
          importedBy: 'prova',
        })
        .returning();
      await t.db.insert(refSupply).values(
        rows.map(([entryType, code, description, group]) => ({
          datasetId: d!.id,
          entryType: entryType!,
          code: code!,
          description: description!,
          group: group!,
          annex: '3',
        })),
      );
    };
    await series('presidi-prova-1', day(-400), [
      ['presidio', 'V0104', 'Lancette pungidito di prova', 'Lancette pungidito'],
      ['presidio', 'A01010102', 'Ago per penna di prova', 'Aghi'],
      ['malattia_rara', 'RCG061', 'MALATTIA RARA DI PROVA', 'Malattie rare'],
    ]);
    await series('presidi-prova-2', day(-10), [
      ['presidio', 'V0104', 'Lancette pungidito di prova', 'Lancette pungidito'],
      ['presidio', 'V9009', 'Penna pungidito di prova', 'Penna pungidito'],
    ]);
    await series('presidi-prova-3', day(1), [
      ['presidio', 'Z0000', 'Presidio di domani', 'Futuro'],
    ]);
    const c = await catalog();
    expect(c.presidi.map((p) => `${p.codice} ${p.descrizione}`).sort()).toEqual([
      'A01010102 Ago per penna di prova',
      'V0104 Lancette pungidito di prova',
      'V9009 Penna pungidito di prova',
    ]);
    expect(c.presidi.find((p) => p.codice === 'V0104')).toMatchObject({
      allegato: '3',
      atto: 'Atto di prova presidi-prova-2',
    });
    expect(c.malattieRare).toEqual([
      expect.objectContaining({ codice: 'RCG061', descrizione: 'MALATTIA RARA DI PROVA' }),
    ]);
    // Le categorie dicono quale allegato le descrive.
    const cats = (await req('GET', '/api/presidi/categorie', secretary)).json<{
      categorie: { chiave: string; allegato: string | null }[];
    }>().categorie;
    expect(cats.find((x) => x.chiave === 'diabetici')!.allegato).toBe('3');
    expect(cats.find((x) => x.chiave === 'monouso')!.allegato).toBe('2');
    expect(cats.find((x) => x.chiave === 'dietetici')!.allegato).toBeNull();
    // Il nomenclatore importato non si modifica.
    await expect(t.db.execute(sql`update ref_supply set code = 'X'`)).rejects.toThrow();
  });
});
