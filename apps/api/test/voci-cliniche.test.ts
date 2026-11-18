import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog, changeHistory, clinicalEntry } from '../src/db/schema';
import { studioDate } from '../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

const DAY = 86_400_000;

interface EntryList {
  voci: {
    id: string;
    tipo: string;
    stato: string;
    riservata: boolean;
    oscurata: boolean;
    promemoria: string | null;
    autore: string;
    motivoAnnullamento: string | null;
    dettaglio: Record<string, unknown>;
  }[];
  puoScrivere: boolean;
}

describe('voci cliniche dalla cartella (tappa 9)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let secretary: string;
  let substitute: string;
  let colleague: string;
  let admin: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    secretary = await login(s, 'segreteria');
    substitute = await login(s, 'sostituto');
    colleague = await login(s, 'collega');
    admin = await login(s, 'amministratore');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const day = (offset: number) => studioDate(new Date(s.clock.now().getTime() + offset * DAY));
  const req = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const voci = (patient = s.richPatient) => `/api/pazienti/${patient}/voci`;
  const list = async (query = '', cookie = doctor) => {
    const res = await req('GET', `${voci()}${query}`, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<EntryList>();
  };
  const create = async (body: object, cookie = doctor) => {
    const res = await req('POST', voci(), cookie, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };

  it('il medico scrive le sette voci e le ritrova con il dettaglio, con sé come autore', async () => {
    const data = day(0);
    const ids = {
      problema: await create({
        tipo: 'problema',
        data,
        descrizione: 'Ipertensione di prova',
        codice: '401.9',
        dal: day(-30),
        quesitoAperto: true,
      }),
      diario: await create({
        tipo: 'diario',
        data,
        contatto: 'domicilio',
        testo: 'Visita a domicilio di prova.',
      }),
      misura: await create({ tipo: 'misura', data, parametro: 'peso', valore: '72,5' }),
      anamnesi: await create({
        tipo: 'anamnesi',
        data,
        sezione: 'familiare',
        testo: 'Anamnesi familiare di prova.',
      }),
      allergia: await create({
        tipo: 'allergia',
        data,
        sostanza: 'Principio di prova',
        reazione: 'Orticaria di prova',
        daFarmaco: true,
      }),
      stile_di_vita: await create({
        tipo: 'stile_di_vita',
        data,
        fattore: 'Fumo',
        valore: 'Ex fumatore di prova',
      }),
      esame_obiettivo: await create({
        tipo: 'esame_obiettivo',
        data,
        testo: 'Esame obiettivo di prova.',
        scala: 'Scheda di prova',
        punteggio: '5/6',
        promemoria: day(90),
      }),
    };
    const { voci: all, puoScrivere } = await list();
    expect(puoScrivere).toBe(true);
    const byId = new Map(all.map((v) => [v.id, v]));
    for (const [tipo, id] of Object.entries(ids)) {
      expect(byId.get(id), tipo).toMatchObject({ tipo, stato: 'attiva' });
      expect(byId.get(id)!.autore).toBe('Dott.ssa Elena Marchi');
    }
    expect(byId.get(ids.problema)!.dettaglio).toEqual({
      descrizione: 'Ipertensione di prova',
      codice: '401.9',
      sistema: 'ICD-9-CM',
      stato: 'attivo',
      dal: day(-30),
      risoltoIl: null,
      quesitoAperto: true,
    });
    expect(byId.get(ids.diario)!.dettaglio).toEqual({
      contatto: 'domicilio',
      testo: 'Visita a domicilio di prova.',
    });
    // La virgola diventa il punto; l'unità viene dal parametro, non dall'utente.
    expect(byId.get(ids.misura)!.dettaglio).toEqual({
      parametro: 'Peso',
      valore: '72.5',
      unita: 'kg',
    });
    expect(byId.get(ids.anamnesi)!.dettaglio).toMatchObject({ sezione: 'familiare' });
    expect(byId.get(ids.allergia)!.dettaglio).toEqual({
      sostanza: 'Principio di prova',
      reazione: 'Orticaria di prova',
      daFarmaco: true,
    });
    expect(byId.get(ids.esame_obiettivo)!.promemoria).toBe(day(90));

    // Il riepilogo della cartella mostra subito problema, allergia e ultimo peso.
    const summary = (await req('GET', `/api/pazienti/${s.richPatient}`, doctor)).json().riepilogo;
    expect(summary.problemiAttivi.map((p: { id: string }) => p.id)).toContain(ids.problema);
    expect(summary.allergie.map((a: { sostanza: string }) => a.sostanza)).toContain(
      'Principio di prova',
    );
    expect(summary.parametri).toContainEqual(
      expect.objectContaining({ parametro: 'Peso', valore: '72.5', unita: 'kg' }),
    );
    // E la cronologia unica le ha tutte.
    const timeline = (await req('GET', `/api/pazienti/${s.richPatient}/cronologia`, doctor)).json()
      .cronologia as { id: string }[];
    for (const id of Object.values(ids)) expect(timeline.map((x) => x.id)).toContain(id);
  });

  it('il catalogo dà tipi, parametri con l’unità e consensi con la fonte, dal dominio', async () => {
    const res = await req('GET', '/api/voci-cliniche/catalogo', secretary);
    expect(res.statusCode, res.body).toBe(200);
    const c = res.json<{
      tipi: { chiave: string }[];
      parametri: { chiave: string; unita: string; massimo: number | null }[];
      consensi: { chiave: string; fonte: string | null }[];
    }>();
    expect(c.tipi.map((x) => x.chiave)).toContain('esame_obiettivo');
    expect(c.parametri.find((x) => x.chiave === 'saturazione')).toMatchObject({
      unita: '%',
      massimo: 100,
    });
    expect(c.consensi.find((x) => x.chiave === 'fse_cura')!.fonte).toMatch(/art\. 8/);
    // Senza sessione no.
    expect(
      (await s.app.inject({ method: 'GET', url: '/api/voci-cliniche/catalogo' })).statusCode,
    ).toBe(401);
  });

  it('filtri dell’elenco: per tipo e senza le voci annullate', async () => {
    const diaries = (await list('?tipo=diario')).voci;
    expect(diaries.length).toBeGreaterThan(0);
    expect(diaries.every((v) => v.tipo === 'diario')).toBe(true);
    expect((await req('GET', `${voci()}?tipo=ricetta`, doctor)).statusCode).toBe(400);
  });

  it('scrive solo il medico: segreteria, amministratore e collega senza autorizzazione no', async () => {
    const body = { tipo: 'diario', data: day(0), contatto: 'telefono', testo: 'Telefonata.' };
    for (const cookie of [secretary, admin, colleague]) {
      const res = await req('POST', voci(), cookie, body);
      expect(res.statusCode).toBe(403);
    }
    const [last] = await s.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.patientId, s.richPatient), eq(accessLog.action, 'nuova_voce')))
      .orderBy(desc(accessLog.seq))
      .limit(1);
    expect(last!.outcome).toBe('negato');
    // Il sostituto, con la sostituzione attiva, scrive a nome suo.
    const id = await create(body, substitute);
    const mine = (await list('', substitute)).voci.find((v) => v.id === id)!;
    expect(mine.autore).toBe('Dott. Marco Fiore');
  });

  it('controlli formali: date, codice ICD-9-CM, problemi risolti, valori dei parametri', async () => {
    const bad = async (body: object, pattern: RegExp) => {
      const res = await req('POST', voci(), doctor, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(res.json())).toMatch(pattern);
    };
    const data = day(0);
    await bad({ tipo: 'diario', data: day(1), contatto: 'studio', testo: 'x' }, /nel futuro/);
    await bad(
      { tipo: 'diario', data, contatto: 'studio', testo: 'x', promemoria: day(-1) },
      /Promemoria/,
    );
    await bad({ tipo: 'problema', data, descrizione: 'x', codice: '40A' }, /formato ICD-9-CM/);
    await bad(
      { tipo: 'problema', data, descrizione: 'x', stato: 'risolto' },
      /manca la data di risoluzione/,
    );
    await bad(
      { tipo: 'problema', data, descrizione: 'x', stato: 'attivo', risoltoIl: day(-1) },
      /solo sui problemi risolti/,
    );
    await bad(
      {
        tipo: 'problema',
        data,
        descrizione: 'x',
        stato: 'risolto',
        dal: day(-2),
        risoltoIl: day(-5),
      },
      /prima dell’inizio/,
    );
    await bad({ tipo: 'misura', data, parametro: 'peso', valore: 'settanta' }, /scrivi un numero/);
    await bad({ tipo: 'misura', data, parametro: 'peso', valore: '0' }, /maggiore di zero/);
    await bad({ tipo: 'misura', data, parametro: 'saturazione', valore: '101' }, /superare 100/);
    await bad({ tipo: 'misura', data, parametro: 'colesterolo', valore: '1' }, /parametro/);
    await bad({ tipo: 'diario', data, contatto: 'studio', testo: '   ' }, /testo/);
    await bad({ tipo: 'diario', data, contatto: 'studio', testo: 'x', extra: 1 }, /extra/);
    await bad({ tipo: 'vaccino', data }, /tipo/);
    // Il codice si scrive anche in minuscolo: si salva in maiuscolo.
    const id = await create({ tipo: 'problema', data, descrizione: 'Prova V', codice: 'v17.3' });
    const v = (await list('?tipo=problema')).voci.find((x) => x.id === id)!;
    expect(v.dettaglio.codice).toBe('V17.3');
  });

  it('parametri della stessa visita scritti insieme e andamento nel tempo', async () => {
    const url = `/api/pazienti/${s.richPatient}/parametri`;
    for (const [data, pas, pad] of [
      [day(-60), '150', '95'],
      [day(-30), '140', '90'],
    ] as const) {
      const res = await req('POST', url, doctor, {
        data,
        misure: [
          { parametro: 'pressione_sistolica', valore: pas },
          { parametro: 'pressione_diastolica', valore: pad },
        ],
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().ids).toHaveLength(2);
    }
    const dup = await req('POST', url, doctor, {
      data: day(0),
      misure: [
        { parametro: 'peso', valore: '70' },
        { parametro: 'peso', valore: '71' },
      ],
    });
    expect(dup.statusCode).toBe(400);
    // Un valore sbagliato blocca tutta la visita: nessuna voce a metà.
    const before = (await req('GET', url, doctor)).json().parametri;
    const half = await req('POST', url, doctor, {
      data: day(0),
      misure: [
        { parametro: 'altezza', valore: '170' },
        { parametro: 'saturazione', valore: '120' },
      ],
    });
    expect(half.statusCode).toBe(400);
    expect((await req('GET', url, doctor)).json().parametri).toEqual(before);

    const series = (await req('GET', url, doctor)).json().parametri as {
      parametro: string;
      unita: string;
      valori: { data: string; valore: string }[];
    }[];
    const systolic = series.find((x) => x.parametro === 'Pressione sistolica')!;
    expect(systolic.unita).toBe('mmHg');
    const mine = systolic.valori.filter((v) => v.data === day(-60) || v.data === day(-30));
    expect(mine.map((v) => v.valore)).toEqual(['150', '140']);
    // In ordine di data, dalla più vecchia.
    const dates = systolic.valori.map((v) => v.data);
    expect([...dates].sort()).toEqual(dates);
    // La segreteria non legge l'andamento (è nel diario clinico).
    expect((await req('GET', url, secretary)).statusCode).toBe(403);
  });

  it('annullamento con motivo: la voce resta, segnata, e lascia il riepilogo', async () => {
    const id = await create({
      tipo: 'allergia',
      data: day(0),
      sostanza: 'Sostanza da annullare',
    });
    const url = `${voci()}/${id}/annulla`;
    expect((await req('POST', url, doctor, {})).statusCode).toBe(400);
    expect((await req('POST', url, secretary, { motivo: 'Errore' })).statusCode).toBe(403);
    const res = await req('POST', url, doctor, { motivo: 'Scritta sul paziente sbagliato' });
    expect(res.statusCode, res.body).toBe(200);
    expect((await req('POST', url, doctor, { motivo: 'Ancora' })).statusCode).toBe(409);
    expect((await req('PATCH', `${voci()}/${id}`, doctor, { riservata: true })).statusCode).toBe(
      409,
    );

    const v = (await list()).voci.find((x) => x.id === id)!;
    expect(v).toMatchObject({
      stato: 'annullata',
      motivoAnnullamento: 'Scritta sul paziente sbagliato',
    });
    expect((await list('?annullate=no')).voci.map((x) => x.id)).not.toContain(id);
    const summary = (await req('GET', `/api/pazienti/${s.richPatient}`, doctor)).json().riepilogo;
    expect(summary.allergie.map((a: { sostanza: string }) => a.sostanza)).not.toContain(
      'Sostanza da annullare',
    );
    const timeline = (await req('GET', `/api/pazienti/${s.richPatient}/cronologia`, doctor)).json()
      .cronologia as { id: string; annullata: boolean }[];
    expect(timeline.find((x) => x.id === id)!.annullata).toBe(true);
    // Lo storico ha chi l'ha annullata.
    const history = await s.db
      .select()
      .from(changeHistory)
      .where(and(eq(changeHistory.tableName, 'clinical_entry'), eq(changeHistory.rowId, id)));
    expect(history.map((h) => h.operation)).toEqual(['INSERT', 'UPDATE']);
    expect(history[1]!.userId).toBe(s.users.titolare.id);
    // Nel database non si cancella.
    await expect(s.db.delete(clinicalEntry).where(eq(clinicalEntry.id, id))).rejects.toThrow();
  });

  it('modifica: problema risolto e di nuovo attivo, promemoria, campi dei soli problemi', async () => {
    const id = await create({
      tipo: 'problema',
      data: day(0),
      descrizione: 'Problema che si risolve',
      dal: day(-10),
    });
    const url = `${voci()}/${id}`;
    const patch = (body: object) => req('PATCH', url, doctor, body);
    expect((await patch({ stato: 'risolto' })).statusCode).toBe(400);
    expect((await patch({ stato: 'risolto', risoltoIl: day(-20) })).statusCode).toBe(400);
    const ok = await patch({ stato: 'risolto', risoltoIl: day(-1) });
    expect(ok.statusCode, ok.body).toBe(200);
    const problems = async () => (await list('?tipo=problema')).voci.find((x) => x.id === id)!;
    expect((await problems()).dettaglio).toMatchObject({ stato: 'risolto', risoltoIl: day(-1) });
    const summary = (await req('GET', `/api/pazienti/${s.richPatient}`, doctor)).json().riepilogo;
    expect(summary.problemiAttivi.map((p: { id: string }) => p.id)).not.toContain(id);
    // Di nuovo attivo: la data di risoluzione si toglie.
    expect((await patch({ stato: 'attivo' })).statusCode).toBe(200);
    expect((await problems()).dettaglio).toMatchObject({ stato: 'attivo', risoltoIl: null });
    expect((await patch({ quesitoAperto: true, promemoria: day(30) })).statusCode).toBe(200);
    expect(await problems()).toMatchObject({ promemoria: day(30) });
    expect((await problems()).dettaglio.quesitoAperto).toBe(true);
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ promemoria: day(-5) })).statusCode).toBe(400);

    const note = await create({ tipo: 'diario', data: day(0), contatto: 'studio', testo: 'x' });
    const res = await req('PATCH', `${voci()}/${note}`, doctor, { stato: 'risolto' });
    expect(res.statusCode).toBe(400);
    expect(res.json().errore).toMatch(/solo per i problemi/);
  });

  it('riservata e oscurata: la riservata la vede solo il medico', async () => {
    const settings = `/api/archivi/${s.archives.titolare}/impostazioni`;
    expect(
      (await req('PATCH', settings, doctor, { segreteriaLeggeRiepilogo: true })).statusCode,
    ).toBe(200);
    try {
      const id = await create({
        tipo: 'allergia',
        data: day(0),
        sostanza: 'Allergia riservata di prova',
        riservata: true,
      });
      const allergies = async (cookie: string) =>
        (await req('GET', `/api/pazienti/${s.richPatient}`, cookie))
          .json()
          .riepilogo.allergie.map((a: { sostanza: string }) => a.sostanza);
      expect(await allergies(doctor)).toContain('Allergia riservata di prova');
      expect(await allergies(secretary)).not.toContain('Allergia riservata di prova');
      // Tolta la riservatezza, la vede anche la segreteria che legge il riepilogo.
      expect((await req('PATCH', `${voci()}/${id}`, doctor, { riservata: false })).statusCode).toBe(
        200,
      );
      expect(await allergies(secretary)).toContain('Allergia riservata di prova');
      expect((await req('PATCH', `${voci()}/${id}`, doctor, { oscurata: true })).statusCode).toBe(
        200,
      );
      expect((await list()).voci.find((x) => x.id === id)!.oscurata).toBe(true);
    } finally {
      await req('PATCH', settings, doctor, { segreteriaLeggeRiepilogo: false });
    }
  });

  it('la segreteria che legge il diario non vede le note riservate', async () => {
    const settings = `/api/archivi/${s.archives.titolare}/impostazioni`;
    expect((await req('PATCH', settings, doctor, { segreteriaLeggeDiario: true })).statusCode).toBe(
      200,
    );
    try {
      const id = await create({
        tipo: 'diario',
        data: day(0),
        contatto: 'telefono',
        testo: 'Nota riservata della tappa 9.',
        riservata: true,
      });
      const seen = await list('?tipo=diario', secretary);
      expect(seen.puoScrivere).toBe(false);
      expect(seen.voci.length).toBeGreaterThan(0);
      expect(seen.voci.map((v) => v.id)).not.toContain(id);
      expect(seen.voci.every((v) => !v.riservata)).toBe(true);
      expect((await list('?tipo=diario')).voci.map((v) => v.id)).toContain(id);
      // Né la modifica né l'annullamento la scoprono: per la segreteria non c'è (403 prima).
      expect(
        (await req('PATCH', `${voci()}/${id}`, secretary, { oscurata: true })).statusCode,
      ).toBe(403);
    } finally {
      await req('PATCH', settings, doctor, { segreteriaLeggeDiario: false });
    }
  });

  it('una voce di un altro paziente non si tocca da questa cartella', async () => {
    const other = s.patients.titolare.find((x) => x !== s.richPatient)!;
    const res = await req('POST', voci(other), doctor, {
      tipo: 'diario',
      data: day(0),
      contatto: 'studio',
      testo: 'Nota di un altro paziente.',
    });
    expect(res.statusCode).toBe(201);
    const foreign = res.json().id;
    expect(
      (await req('PATCH', `${voci()}/${foreign}`, doctor, { riservata: true })).statusCode,
    ).toBe(404);
    expect(
      (await req('POST', `${voci()}/${foreign}/annulla`, doctor, { motivo: 'x' })).statusCode,
    ).toBe(404);
    expect((await list()).voci.map((v) => v.id)).not.toContain(foreign);
  });
});
