import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  absenceProblems,
  DEFAULT_ABSENCES,
  keepChoices,
  type PssContent,
} from '../src/fse/compose';
import { studioDate } from '../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** I dati che il Profilo Sanitario Sintetico chiede alla cartella (tappa 11). */
describe('dati della cartella per il Profilo Sanitario Sintetico', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const today = () => studioDate(s.clock.now());
  const req = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie: doctor }, ...(payload ? { payload } : {}) });
  const voci = () => `/api/pazienti/${s.richPatient}/voci`;
  const create = async (body: object) => {
    const res = await req('POST', voci(), { data: today(), ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const rejected = async (body: object) => {
    const res = await req('POST', voci(), { data: today(), ...body });
    expect(res.statusCode, res.body).toBe(400);
    return res.json<{ errore: string }>().errore;
  };
  const detail = async (id: string) => {
    const res = await req('GET', voci());
    const v = res
      .json<{ voci: { id: string; dettaglio: Record<string, unknown> }[] }>()
      .voci.find((x) => x.id === id);
    return v!.dettaglio;
  };

  it('problemi: cronico, organo mancante dal dizionario ufficiale', async () => {
    const chronic = await create({
      tipo: 'problema',
      descrizione: 'Diabete di prova',
      codice: '250.00',
      cronico: true,
    });
    expect(await detail(chronic)).toMatchObject({ cronico: true, categoria: 'diagnosi' });
    const organ = await create({
      tipo: 'problema',
      descrizione: 'Colecistectomia di prova',
      categoria: 'organo_mancante',
      codice: 'Z90.4',
      stato: 'risolto',
      dal: '2012-02-01',
      risoltoIl: '2012-03-01',
    });
    expect(await detail(organ)).toMatchObject({
      categoria: 'organo_mancante',
      codice: 'Z90.4',
      sistema: 'Organi mancanti (ICD-10)',
    });
    expect(
      await rejected({
        tipo: 'problema',
        descrizione: 'Organo inventato',
        categoria: 'organo_mancante',
        codice: 'Z99.9',
      }),
    ).toMatch(/non è nell’elenco ufficiale «Organi mancanti»/);
    expect(
      await rejected({
        tipo: 'problema',
        descrizione: 'Senza codice',
        categoria: 'organo_mancante',
      }),
    ).toMatch(/scegli il codice/);
    // Un problema già scritto si segna cronico.
    const later = await create({ tipo: 'problema', descrizione: 'Ipertensione', codice: '401.9' });
    expect((await req('PATCH', `${voci()}/${later}`, { cronico: true })).statusCode).toBe(200);
    expect(await detail(later)).toMatchObject({ cronico: true });
  });

  it('allergie: natura, agente, codice dell’agente, criticità; attiva o no', async () => {
    const drug = await create({
      tipo: 'allergia',
      sostanza: 'Amoxicillina',
      agente: 'farmaco',
      codiceAgente: 'j01ca04',
      criticita: 'alta',
    });
    expect(await detail(drug)).toMatchObject({
      natura: 'allergia',
      agente: 'farmaco',
      daFarmaco: true,
      codiceAgente: 'J01CA04',
      sistemaAgente: 'ATC',
      criticita: 'alta',
      attiva: true,
    });
    const venom = await create({
      tipo: 'allergia',
      sostanza: "Veleno d'api",
      agente: 'veleno_imenotteri',
      codiceAgente: '288328004',
    });
    expect(await detail(venom)).toMatchObject({ sistemaAgente: 'ALLERGENI', daFarmaco: false });
    const food = await create({
      tipo: 'allergia',
      sostanza: 'Latte',
      natura: 'intolleranza',
      agente: 'alimento',
    });
    expect(await detail(food)).toMatchObject({ natura: 'intolleranza', agente: 'alimento' });
    expect(
      await rejected({ tipo: 'allergia', sostanza: 'X', agente: 'alimento', codiceAgente: '123' }),
    ).toMatch(/non è nell’elenco ufficiale degli allergeni/);
    expect(
      await rejected({ tipo: 'allergia', sostanza: 'X', agente: 'farmaco', codiceAgente: '12AB' }),
    ).toMatch(/AIC \(9 cifre\) o l’ATC/);
    expect(
      await rejected({ tipo: 'allergia', sostanza: 'X', daFarmaco: true, agente: 'alimento' }),
    ).toMatch(/l’agente dev’essere un farmaco/);
    expect(await rejected({ tipo: 'allergia', sostanza: 'X', codiceAgente: 'J01' })).toMatch(
      /indica prima di che agente/,
    );
    expect((await req('PATCH', `${voci()}/${food}`, { allergiaAttiva: false })).statusCode).toBe(
      200,
    );
    expect(await detail(food)).toMatchObject({ attiva: false });
  });

  it('anamnesi familiare con parente, patologia ed età all’esordio', async () => {
    const id = await create({
      tipo: 'anamnesi',
      sezione: 'familiare',
      testo: 'Infarto del padre',
      parente: 'padre',
      codice: '410.9',
      etaEsordio: 55,
    });
    expect(await detail(id)).toMatchObject({ parente: 'padre', codice: '410.9', etaEsordio: 55 });
    expect(
      await rejected({ tipo: 'anamnesi', sezione: 'fisiologica', testo: 'X', parente: 'madre' }),
    ).toMatch(/solo per l’anamnesi familiare/);
  });

  it('capacità motoria con il codice del dizionario ufficiale', async () => {
    const id = await create({ tipo: 'capacita_motoria', capacita: 'assistito' });
    expect(await detail(id)).toEqual({ capacita: 'assistito', codice: 'LA21286-5' });
  });

  it('il catalogo dà gli elenchi ufficiali da cui scegliere', async () => {
    const c = (await req('GET', '/api/voci-cliniche/catalogo')).json<{
      organiMancanti: unknown[];
      allergeni: { codice: string; nome: string }[];
      parenti: unknown[];
      capacitaMotorie: unknown[];
      vieSomministrazione: string[];
    }>();
    expect(c.organiMancanti).toHaveLength(20);
    expect(c.allergeni).toHaveLength(158);
    expect(c.allergeni).toContainEqual({ codice: '288328004', nome: "Veleno d'api" });
    expect(c.parenti).toHaveLength(12);
    expect(c.capacitaMotorie).toHaveLength(4);
    expect(c.vieSomministrazione).toContain('per bocca');
  });

  it('nome, cognome e recapiti di studio: li cambia solo il medico stesso', async () => {
    const mine = (await req('GET', '/api/profilo/recapiti')).json<Record<string, unknown>>();
    expect(mine).toMatchObject({ nome: 'Elena', cognome: 'Marchi', mancaPerIlProfilo: [] });
    const put = (cookie: string, body: object) =>
      s.app.inject({
        method: 'PUT',
        url: '/api/profilo/recapiti',
        headers: { cookie },
        payload: body,
      });
    // Senza recapiti il Profilo non si può firmare: lo dice il profilo stesso.
    const empty = await put(doctor, {
      nome: 'Elena',
      cognome: 'Marchi',
      telefono: '',
      email: '',
      pec: '',
    });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json<{ mancaPerIlProfilo: string[] }>().mancaPerIlProfilo).toEqual([
      'Medico: serve almeno un recapito di studio (telefono, email o PEC)',
    ]);
    const back = await put(doctor, {
      nome: 'Elena',
      cognome: 'Marchi',
      telefono: '000 0000001',
      email: 'studio.marchi@esempio.invalid',
      pec: '',
    });
    expect(back.json()).toMatchObject({ telefono: '000 0000001', mancaPerIlProfilo: [] });
    expect(
      (await put(doctor, { nome: 'E', cognome: 'M', telefono: 'abc', email: '', pec: '' }))
        .statusCode,
    ).toBe(400);
    const secretary = await login(s, 'segreteria');
    expect(
      (
        await s.app.inject({
          method: 'GET',
          url: '/api/profilo/recapiti',
          headers: { cookie: secretary },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('impostazioni del Fascicolo: le legge chi lavora nello studio, le cambia l’amministratore', async () => {
    const at = (cookie: string, method: 'GET' | 'PUT', payload?: object) =>
      s.app.inject({
        method,
        url: '/api/studio/fascicolo',
        headers: { cookie },
        ...(payload ? { payload } : {}),
      });
    interface Settings {
      impostazioni: { attivitaClinica: string | null; regime: string | null } | null;
      daCompletare: string[];
      valori: { attivitaClinica: { codice: string; nome: string }[]; regime: unknown[] };
      puoModificare: boolean;
    }
    const seen = (await at(doctor, 'GET')).json<Settings>();
    expect(seen).toMatchObject({ daCompletare: [], puoModificare: false });
    expect(seen.impostazioni).toMatchObject({ attivitaClinica: 'OBS', regime: 'SSN' });
    // Codici e nomi delle tabelle 57 e 63 della specifica del Gateway.
    expect(seen.valori.attivitaClinica).toContainEqual({
      codice: 'OBS',
      nome: 'Documento stato di salute',
    });
    expect(seen.valori.regime).toContainEqual({ codice: 'SSN', nome: 'Regime SSN' });
    const body = {
      radiceDocumenti: '2.999.10.1',
      repository: '2.999.10.2',
      radiceInvii: '2.999.10.3',
      custode: {
        radice: '2.999.10.4',
        codice: 'CUSTODE-PROVA',
        nome: 'Custode di prova',
        via: 'Via del Custode 1',
        comune: 'Comune di prova',
        istat: '999999',
        provincia: 'XX',
      },
      struttura: 'STUDIO DI PROVA^^^^^&2.999.10.5&ISO^^^^000001',
      attivitaClinica: 'OBS',
      regime: 'NOSSN',
    };
    const denied = await at(doctor, 'PUT', body);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ errore: string }>().errore).toBe(
      'Le impostazioni del Fascicolo le cambia l’amministratore dello studio',
    );
    const admin = await login(s, 'amministratore');
    expect((await at(admin, 'GET')).json<Settings>().puoModificare).toBe(true);
    for (const wrong of [
      { ...body, radiceDocumenti: '2.999.x' },
      { ...body, struttura: 'STUDIO DI PROVA' },
      { ...body, attivitaClinica: 'XYZ' },
      { ...body, custode: { ...body.custode, istat: '12345' } },
    ])
      expect((await at(admin, 'PUT', wrong)).statusCode).toBe(400);
    const saved = await at(admin, 'PUT', body);
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await at(doctor, 'GET')).json<Settings>().impostazioni).toMatchObject({
      regime: 'NOSSN',
    });
    expect((await at(admin, 'PUT', { ...body, regime: 'SSN' })).statusCode).toBe(200);
  });
});

/** Le assenze dicono il vero (audit D259): «nessuna … nota» solo con la sezione vuota. */
describe('assenze del Profilo', () => {
  const content = (over: Partial<PssContent> = {}): PssContent => ({
    composto: '2026-11-24T10:00:00Z',
    paziente: { cf: '', nome: '', cognome: '', sesso: null, nascita: '', luogoNascita: null },
    sezioni: {
      allergie: [],
      terapie: [],
      problemi: [],
      anamnesiFamiliare: [],
      parametri: [],
      stiliDiVita: [],
      capacitaMotoria: [],
    },
    assenze: { ...DEFAULT_ABSENCES },
    esclusi: { oscurate: 0, riservate: 0 },
    nonInseribili: [],
    ...over,
  });
  const therapy = { id: 't1', etichetta: 'Farmaco inventato', incluso: false, manca: [], dati: {} };

  it('con la sezione vuota «nessuna nota» va bene; con una voce esclusa no; con una inclusa non conta', () => {
    const known = { ...DEFAULT_ABSENCES, terapie: 'no-known-medications' as const };
    expect(absenceProblems(content({ assenze: known }))).toEqual([]);
    const withItem = content({
      assenze: known,
      sezioni: { ...content().sezioni, terapie: [therapy as never] },
    });
    expect(absenceProblems(withItem)).toEqual([
      expect.stringMatching(/^Terapie farmacologiche: in cartella ci sono voci/),
    ]);
    const included = content({
      assenze: known,
      sezioni: { ...content().sezioni, terapie: [{ ...therapy, incluso: true } as never] },
    });
    expect(absenceProblems(included)).toEqual([]);
    // Una voce che non può entrare conta, se è di quella sezione.
    const notInsertable = content({
      assenze: { ...DEFAULT_ABSENCES, anamnesiFamiliare: 'no-known-problems' },
      nonInseribili: [{ etichetta: 'x', motivo: 'y', sezione: 'anamnesiFamiliare' }],
    });
    expect(absenceProblems(notInsertable)).toEqual([expect.stringMatching(/^Anamnesi familiare/)]);
  });

  it('ricomponendo, una «nessuna nota» che non vale più torna «nessuna informazione»', () => {
    const before = content({
      assenze: {
        ...DEFAULT_ABSENCES,
        terapie: 'no-known-medications',
        allergie: 'no-known-allergies',
      },
    });
    const fresh = content({ sezioni: { ...content().sezioni, terapie: [therapy as never] } });
    const kept = keepChoices(fresh, before);
    expect(kept.assenze.terapie).toBe('no-medication-info');
    // Dove la sezione è ancora vuota la scelta resta.
    expect(kept.assenze.allergie).toBe('no-known-allergies');
  });
});
