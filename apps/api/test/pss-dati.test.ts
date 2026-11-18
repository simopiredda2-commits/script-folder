import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
