import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  changeHistory,
  clinicalEntry,
  historicalPrescription,
  therapy,
} from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { studioDayFrom } from './helpers/dates';

interface Entry {
  id: string;
  tipo: string;
  stato: string;
  promemoria: string | null;
  motivoAnnullamento: string | null;
  dettaglio: Record<string, unknown>;
}

interface PastView {
  id: string;
  tipo: 'farmaco' | 'prestazione';
  data: string;
  farmaco: string | null;
  aic: string | null;
  codice: string | null;
  descrizione: string | null;
  quantita: number | null;
  nre: string | null;
  prescrittore: string | null;
  programma: string | null;
  importata: boolean;
  registrataDa: string | null;
  stato: 'attiva' | 'annullata';
  motivoAnnullamento: string | null;
}

interface Counted {
  chiave: string;
  storico: Record<string, string>;
  ricette: number;
  prescritte: number;
  ultimi12Mesi: number;
  altroProgramma: { ricette: number; ultimaIl: string | null };
}

interface DrugItem extends Counted {
  farmaco: string;
  aic: string | null;
  terapia: { id: string; stato: string; fine: string | null } | null;
}

interface ServiceItem extends Counted {
  codice: string | null;
  descrizione: string;
  gruppo: 'visita' | 'altro';
}

interface TimelineItem {
  id: string;
  tipo: string;
  titolo: string;
  testo: string | null;
  annullata: boolean;
}

/**
 * Destinazioni della tappa 15 che prima non si scrivevano: vaccinazioni, esami di laboratorio,
 * ricette fatte con altri programmi, terapie concluse. Ognuna con i suoi controlli formali, i
 * permessi (la segreteria non scrive voci cliniche) e il registro degli accessi.
 */
describe('destinazioni nuove: vaccinazioni, esami, ricette passate, terapie concluse (tappa 15)', () => {
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

  const day = (offset: number) => studioDayFrom(s.clock.now(), offset);
  const req = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH',
    url: string,
    cookie: string,
    payload?: object,
  ) => s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const patientUrl = (path: string, patient = s.richPatient) => `/api/pazienti/${patient}${path}`;
  const created = async (method: 'POST', url: string, body: object, cookie = doctor) => {
    const res = await req(method, url, cookie, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const rejected = async (url: string, body: object, pattern: RegExp, cookie = doctor) => {
    const res = await req('POST', url, cookie, body);
    expect(res.statusCode, JSON.stringify(body)).toBe(400);
    expect(JSON.stringify(res.json())).toMatch(pattern);
  };
  const entries = async (tipo: string, cookie = doctor) => {
    const res = await req('GET', patientUrl(`/voci?tipo=${tipo}`), cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ voci: Entry[] }>().voci;
  };
  const timeline = async (tipo = 'tutto') => {
    const res = await req('GET', patientUrl(`/cronologia?tipo=${tipo}`), doctor);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ cronologia: TimelineItem[] }>().cronologia;
  };
  const lastLog = async (action: string) => {
    const [row] = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.patientId, s.richPatient), eq(accessLog.action, action)))
      .orderBy(desc(accessLog.seq))
      .limit(1);
    return row;
  };

  describe('vaccinazioni', () => {
    it('il medico registra vaccino, lotto, dose e campagna; si ritrovano nelle voci e nella cronologia', async () => {
      const id = await created('POST', patientUrl('/voci'), {
        tipo: 'vaccinazione',
        data: day(-10),
        vaccino: 'Vaccino antinfluenzale di prova',
        lotto: 'LOT-PROVA-01',
        dose: 2,
        campagna: 'Campagna di prova 2026/2027',
        promemoria: day(20),
      });
      const v = (await entries('vaccinazione')).find((x) => x.id === id)!;
      expect(v).toMatchObject({ tipo: 'vaccinazione', stato: 'attiva', promemoria: day(20) });
      expect(v.dettaglio).toEqual({
        vaccino: 'Vaccino antinfluenzale di prova',
        lotto: 'LOT-PROVA-01',
        dose: 2,
        campagna: 'Campagna di prova 2026/2027',
      });
      const item = (await timeline()).find((x) => x.id === id)!;
      expect(item).toMatchObject({
        tipo: 'vaccination',
        titolo: 'Vaccinazione: Vaccino antinfluenzale di prova',
        testo: 'dose 2 · lotto LOT-PROVA-01 · Campagna di prova 2026/2027',
      });
      // Solo il vaccino è obbligatorio: lotto, dose e campagna si possono non sapere.
      const bare = await created('POST', patientUrl('/voci'), {
        tipo: 'vaccinazione',
        data: day(0),
        vaccino: 'Vaccino di prova senza lotto',
      });
      expect((await entries('vaccinazione')).find((x) => x.id === bare)!.dettaglio).toEqual({
        vaccino: 'Vaccino di prova senza lotto',
        lotto: null,
        dose: null,
        campagna: null,
      });
    });

    it('controlli formali: data, dose, vaccino, campi in più', async () => {
      const url = patientUrl('/voci');
      const base = { tipo: 'vaccinazione', data: day(0), vaccino: 'Vaccino di prova' };
      await rejected(url, { ...base, data: day(1) }, /nel futuro/);
      await rejected(url, { ...base, dose: 0 }, /dose/);
      await rejected(url, { ...base, dose: 100 }, /dose/);
      await rejected(url, { ...base, dose: 1.5 }, /dose/);
      await rejected(url, { ...base, vaccino: '   ' }, /vaccino/);
      await rejected(url, { ...base, promemoria: day(-1) }, /Promemoria/);
      await rejected(url, { ...base, codiceAic: '012345678' }, /codiceAic/);
    });

    it('scrive solo il medico: segreteria, amministratore e collega senza autorizzazione no', async () => {
      const body = { tipo: 'vaccinazione', data: day(0), vaccino: 'Vaccino di prova' };
      for (const cookie of [secretary, admin, colleague]) {
        expect((await req('POST', patientUrl('/voci'), cookie, body)).statusCode).toBe(403);
      }
      expect((await lastLog('nuova_voce'))!.outcome).toBe('negato');
      // Il sostituto, con la sostituzione attiva, sì.
      await created('POST', patientUrl('/voci'), body, substitute);
    });

    it('si annulla con un motivo e resta, segnata', async () => {
      const id = await created('POST', patientUrl('/voci'), {
        tipo: 'vaccinazione',
        data: day(0),
        vaccino: 'Vaccino registrato per errore',
      });
      const res = await req('POST', patientUrl(`/voci/${id}/annulla`), doctor, {
        motivo: 'Paziente sbagliato',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await entries('vaccinazione')).find((x) => x.id === id)).toMatchObject({
        stato: 'annullata',
        motivoAnnullamento: 'Paziente sbagliato',
      });
      expect((await timeline()).find((x) => x.id === id)!.annullata).toBe(true);
    });
  });

  describe('esami di laboratorio', () => {
    it('un risultato dalla pagina delle voci: valore e intervallo come sul referto', async () => {
      const id = await created('POST', patientUrl('/voci'), {
        tipo: 'esame_laboratorio',
        data: day(-5),
        esame: 'Emoglobina glicata di prova',
        valore: '7,1',
        unita: '%',
        intervallo: '4,0–6,0 %',
        codicePrestazione: 'pr.lab.1',
      });
      expect((await entries('esame_laboratorio')).find((x) => x.id === id)!.dettaglio).toEqual({
        esame: 'Emoglobina glicata di prova',
        valore: '7,1',
        unita: '%',
        minimo: null,
        massimo: null,
        intervallo: '4,0–6,0 %',
        codicePrestazione: 'PR.LAB.1',
      });
    });

    it('un referto con più esami, scritto insieme; la pagina Esami li legge e sa chi può scrivere', async () => {
      const res = await req('POST', patientUrl('/esami'), doctor, {
        data: day(-3),
        note: 'Referto di prova',
        risultati: [
          { esame: 'Glucosio di prova', valore: '98', unita: 'mg/dL', minimo: '70', massimo: '99' },
          { esame: 'Ricerca di prova', valore: 'negativo', intervallo: 'negativo' },
          { esame: 'Base di prova', valore: '-1', unita: 'mmol/L', minimo: '-2', massimo: '+2' },
        ],
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().ids).toHaveLength(3);
      const exams = (await req('GET', patientUrl('/esami'), doctor)).json<{
        esami: {
          esame: string;
          valore: string;
          minimo: string | null;
          intervallo: string | null;
        }[];
        puoScrivere: boolean;
      }>();
      expect(exams.puoScrivere).toBe(true);
      expect(exams.esami.find((e) => e.esame === 'Glucosio di prova')).toMatchObject({
        valore: '98',
        minimo: '70',
      });
      expect(exams.esami.find((e) => e.esame === 'Ricerca di prova')).toMatchObject({
        valore: 'negativo',
        intervallo: 'negativo',
      });
      // Nessun giudizio sul valore (regola 3, D71).
      expect(JSON.stringify(exams)).not.toMatch(/sopra|sotto|anomal|fuori intervallo/i);
      // E la cronologia li ha tra gli esami, non tra le visite.
      const ids = res.json().ids as string[];
      const onlyExams = (await timeline('esami')).map((x) => x.id);
      for (const id of ids) expect(onlyExams).toContain(id);
      expect((await timeline('visite')).map((x) => x.id)).not.toContain(ids[0]);
    });

    it('controlli formali: estremi numerici, minimo non oltre il massimo; un risultato sbagliato ferma il referto', async () => {
      const url = patientUrl('/voci');
      const base = { tipo: 'esame_laboratorio', data: day(0), esame: 'Esame', valore: '1' };
      await rejected(url, { ...base, minimo: 'basso' }, /Minimo dell’intervallo/);
      await rejected(url, { ...base, massimo: '< 200' }, /Massimo dell’intervallo/);
      await rejected(url, { ...base, minimo: '7,1', massimo: '4' }, /minimo è più grande/);
      await rejected(url, { ...base, valore: '' }, /valore/);
      await rejected(url, { ...base, esame: ' ' }, /esame/);

      const count = async () =>
        (
          await t.db
            .select()
            .from(clinicalEntry)
            .where(
              and(eq(clinicalEntry.patientId, s.richPatient), eq(clinicalEntry.kind, 'lab_result')),
            )
        ).length;
      const before = await count();
      await rejected(
        patientUrl('/esami'),
        {
          data: day(0),
          risultati: [
            { esame: 'Primo di prova', valore: '1' },
            { esame: 'Secondo di prova', valore: '2', minimo: '5', massimo: '1' },
          ],
        },
        /Secondo di prova: Intervallo: il minimo è più grande del massimo/,
      );
      expect(await count()).toBe(before);
      // La data è una per tutto il referto: il messaggio non si ripete per ogni esame.
      const future = await req('POST', patientUrl('/esami'), doctor, {
        data: day(1),
        risultati: [
          { esame: 'A', valore: '1' },
          { esame: 'B', valore: '2' },
        ],
      });
      expect(future.statusCode).toBe(400);
      expect(future.json().dettagli.problemi).toEqual(['Data della voce: è nel futuro']);
      await rejected(patientUrl('/esami'), { data: day(0), risultati: [] }, /risultati/);
      const tooMany = Array.from({ length: 101 }, (_, i) => ({ esame: `E${i}`, valore: '1' }));
      await rejected(patientUrl('/esami'), { data: day(0), risultati: tooMany }, /risultati/);
      expect(await count()).toBe(before);
    });

    it('la segreteria non li scrive; se legge il diario, li vede ma non può scrivere', async () => {
      const body = { data: day(0), risultati: [{ esame: 'Esame', valore: '1' }] };
      expect((await req('POST', patientUrl('/esami'), secretary, body)).statusCode).toBe(403);
      expect((await lastLog('nuova_voce'))!.outcome).toBe('negato');
      const settings = `/api/archivi/${s.archives.titolare}/impostazioni`;
      expect(
        (await req('PATCH', settings, doctor, { segreteriaLeggeDiario: true })).statusCode,
      ).toBe(200);
      try {
        const seen = await req('GET', patientUrl('/esami'), secretary);
        expect(seen.statusCode).toBe(200);
        expect(seen.json().puoScrivere).toBe(false);
      } finally {
        await req('PATCH', settings, doctor, { segreteriaLeggeDiario: false });
      }
    });
  });

  describe('ricette fatte con un altro programma', () => {
    const ids: Record<string, string> = {};
    const past = (body: object, cookie = doctor) =>
      req('POST', patientUrl('/ricette-passate'), cookie, body);
    const drugs = async (cookie = doctor) => {
      const res = await req('GET', patientUrl('/farmaci-prescritti'), cookie);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{
        farmaci: DrugItem[];
        ricettePassate: PastView[];
        puoRegistrare: boolean;
      }>();
    };
    const services = async (cookie = doctor) => {
      const res = await req('GET', patientUrl('/prestazioni-prescritte'), cookie);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{
        prestazioni: ServiceItem[];
        ricettePassate: PastView[];
        puoRegistrare: boolean;
      }>();
    };
    const history = async (query: Record<string, string>, cookie = doctor) => {
      const res = await req(
        'GET',
        patientUrl(`/storico-prescrizioni?${new URLSearchParams(query)}`),
        cookie,
      );
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{
        voci: { ricetta: { id: string } }[];
        ricettePassate: PastView[];
        altroProgramma: { ricette: number };
      }>();
    };

    beforeAll(async () => {
      const ok = async (body: object) => {
        const res = await past(body);
        expect(res.statusCode, res.body).toBe(201);
        return res.json<{ id: string }>().id;
      };
      // Lo stesso principio della terapia cronica dello scenario: è di quella terapia.
      ids.chronic = await ok({
        tipo: 'farmaco',
        data: '2025-03-10',
        farmaco: 'Marchio di prova di prima 5 mg',
        principioAttivo: 'Principio di prova',
        quantita: 2,
        posologia: '1 compressa la sera',
        nre: 'nre-di-prova-1',
        prescrittore: 'Dott. Medico Inventato',
        programma: 'Programma di prima',
      });
      // Un farmaco prescritto solo con il programma di prima: ha la sua voce, per AIC.
      ids.onlyPast = await ok({
        tipo: 'farmaco',
        data: '2024-11-02',
        aic: '900000045',
        farmaco: 'Solo di prima 10 mg',
        principioAttivo: 'principio di prima',
        atc: 'c08ca01',
        quantita: 1,
      });
      ids.onlyPastNewer = await ok({
        tipo: 'farmaco',
        data: '2025-01-15',
        aic: '900000045',
        farmaco: 'Solo di prima 10 mg',
      });
      // Lo stesso nome della terapia riservata: la segreteria non la deve vedere.
      ids.reserved = await ok({
        tipo: 'farmaco',
        data: '2025-02-01',
        farmaco: 'Farmaco riservato di prova',
      });
      ids.visit = await ok({
        tipo: 'prestazione',
        data: '2025-04-01',
        codice: 'pr.09',
        descrizione: 'VISITA DI PROVA DEL PROGRAMMA DI PRIMA',
        quantita: 1,
      });
    });

    it('si registrano con tutti i campi, e chi le ha registrate', async () => {
      const list = (await drugs()).ricettePassate;
      expect(list.find((x) => x.id === ids.chronic)).toMatchObject({
        tipo: 'farmaco',
        data: '2025-03-10',
        farmaco: 'Marchio di prova di prima 5 mg',
        quantita: 2,
        nre: 'NRE-DI-PROVA-1',
        prescrittore: 'Dott. Medico Inventato',
        programma: 'Programma di prima',
        importata: false,
        registrataDa: 'Dott.ssa Elena Marchi',
        stato: 'attiva',
      });
      // Dalla più recente; le prestazioni stanno nel loro elenco.
      const dates = list.map((x) => x.data);
      expect([...dates].sort().reverse()).toEqual(dates);
      expect(list.map((x) => x.id)).not.toContain(ids.visit);
      const [row] = await t.db
        .select()
        .from(historicalPrescription)
        .where(eq(historicalPrescription.id, ids.onlyPast!));
      expect(row).toMatchObject({ atcCode: 'C08CA01', archiveId: s.archives.titolare });
    });

    it('nei farmaci prescritti: con la terapia dello stesso farmaco, o con una voce loro; contate a parte', async () => {
      const { farmaci, puoRegistrare } = await drugs();
      expect(puoRegistrare).toBe(true);
      const chronic = farmaci.find((d) => d.terapia && d.farmaco === 'Farmaco di prova 5 mg')!;
      // Le nostre ricette non cambiano: c'è solo la bozza dello scenario.
      expect(chronic).toMatchObject({
        ricette: 1,
        prescritte: 0,
        altroProgramma: { ricette: 1, ultimaIl: '2025-03-10' },
      });
      const onlyPast = farmaci.find((d) => d.chiave === 'aic:900000045')!;
      expect(onlyPast).toMatchObject({
        terapia: null,
        farmaco: 'Solo di prima 10 mg',
        aic: '900000045',
        ricette: 0,
        ultimi12Mesi: 0,
        storico: { aic: '900000045' },
        altroProgramma: { ricette: 2, ultimaIl: '2025-01-15' },
      });
      // Le ricette passate di un farmaco in terapia (anche riservata) non fanno una voce a parte.
      expect(farmaci.filter((d) => !d.terapia).map((d) => d.chiave)).toEqual(['aic:900000045']);
      expect(
        farmaci.find((d) => d.terapia && d.farmaco === 'Farmaco riservato di prova'),
      ).toMatchObject({ altroProgramma: { ricette: 1, ultimaIl: '2025-02-01' } });
    });

    it('ogni voce apre lo storico con le stesse ricette, nostre e di prima', async () => {
      const { farmaci } = await drugs();
      const { prestazioni } = await services();
      for (const entry of [...farmaci, ...prestazioni]) {
        const h = await history(entry.storico);
        expect(new Set(h.voci.map((v) => v.ricetta.id)).size, entry.chiave).toBe(entry.ricette);
        expect(h.altroProgramma.ricette, entry.chiave).toBe(entry.altroProgramma.ricette);
        expect(
          h.ricettePassate.filter((x) => x.stato === 'attiva'),
          entry.chiave,
        ).toHaveLength(entry.altroProgramma.ricette);
      }
      const onlyPast = await history({ aic: '900000045' });
      expect(onlyPast.voci).toHaveLength(0);
      expect(onlyPast.ricettePassate.map((x) => x.id).sort()).toEqual(
        [ids.onlyPast, ids.onlyPastNewer].sort(),
      );
    });

    it('nelle visite ed esami prescritti, nel gruppo delle visite', async () => {
      const { prestazioni, ricettePassate } = await services();
      expect(prestazioni.find((x) => x.chiave === 'PR.09')).toMatchObject({
        codice: 'PR.09',
        descrizione: 'VISITA DI PROVA DEL PROGRAMMA DI PRIMA',
        gruppo: 'visita',
        ricette: 0,
        altroProgramma: { ricette: 1, ultimaIl: '2025-04-01' },
      });
      expect(ricettePassate.map((x) => x.id)).toEqual([ids.visit]);
    });

    it('nella cronologia, con il segno «fatta con un altro programma», tra le ricette', async () => {
      const all = await timeline();
      const item = all.find((x) => x.id === ids.chronic)!;
      expect(item).toMatchObject({
        tipo: 'historical_prescription',
        titolo: 'Farmaco, ricetta fatta con un altro programma',
        annullata: false,
      });
      expect(item.testo).toMatch(/Marchio di prova di prima 5 mg × 2/);
      expect(item.testo).toMatch(/NRE NRE-DI-PROVA-1/);
      expect(all.find((x) => x.id === ids.visit)!.titolo).toBe(
        'Prestazione, ricetta fatta con un altro programma',
      );
      expect((await timeline('ricette')).map((x) => x.id)).toContain(ids.chronic);
      for (const tipo of ['visite', 'esami'])
        expect((await timeline(tipo)).map((x) => x.id)).not.toContain(ids.chronic);
    });

    it('non entrano mai tra le ricette di questo programma: non si firmano, non si inviano, non si annullano verso il SAR', async () => {
      const ours = (await req('GET', patientUrl('/ricette'), doctor)).json<{
        ricette: { id: string }[];
      }>();
      const pastIds = Object.values(ids);
      for (const r of ours.ricette) expect(pastIds).not.toContain(r.id);
      for (const queue of ['/api/ricette/da-firmare', '/api/ricette/non-inviate']) {
        const body = JSON.stringify((await req('GET', queue, doctor)).json());
        for (const id of pastIds) expect(body, queue).not.toContain(id);
      }
      for (const action of ['da-firmare', 'firma-e-invia', 'annulla', 'ricetta-rossa']) {
        const res = await req('POST', `/api/ricette/${ids.chronic}/${action}`, doctor, {
          motivo: 'Prova',
        });
        expect(res.statusCode, action).toBe(404);
      }
      expect(
        (await req('GET', `/api/ricette/${ids.chronic}/stato-erogazione`, doctor)).statusCode,
      ).toBe(404);
    });

    it('le registra solo il medico; la segreteria le legge, ma non quelle di una terapia riservata', async () => {
      const body = { tipo: 'farmaco', data: day(0), farmaco: 'Farmaco di prova' };
      for (const cookie of [secretary, admin, colleague])
        expect((await past(body, cookie)).statusCode).toBe(403);
      expect((await lastLog('nuova_ricetta_passata'))!.outcome).toBe('negato');
      const res = await past(body, substitute);
      expect(res.statusCode, res.body).toBe(201);
      ids.bySubstitute = res.json().id;

      const forDoctor = await drugs();
      const forSecretary = await drugs(secretary);
      expect(forSecretary.puoRegistrare).toBe(false);
      expect(forDoctor.ricettePassate.map((x) => x.id)).toContain(ids.reserved);
      expect(forSecretary.ricettePassate.map((x) => x.id)).not.toContain(ids.reserved);
      expect(JSON.stringify(forSecretary)).not.toMatch(/Farmaco riservato/i);
      expect(forSecretary.ricettePassate.map((x) => x.id)).toContain(ids.chronic);
      // Né dallo storico per nome.
      const h = await history({ farmaco: 'Farmaco riservato di prova' }, secretary);
      expect(h.ricettePassate).toHaveLength(0);
    });

    it('controlli formali: data, farmaco o prestazione, AIC, ATC, quantità, campi in più', async () => {
      const url = patientUrl('/ricette-passate');
      const drug = { tipo: 'farmaco', data: day(0), farmaco: 'Farmaco di prova' };
      await rejected(url, { ...drug, data: day(1) }, /nel futuro/);
      await rejected(url, { tipo: 'farmaco', data: day(0) }, /almeno il nome/);
      await rejected(url, { ...drug, aic: '12345' }, /Codice AIC/);
      await rejected(url, { ...drug, atc: 'XYZ' }, /Codice ATC/);
      await rejected(url, { ...drug, quantita: 0 }, /quantita/);
      await rejected(url, { ...drug, quantita: 100 }, /quantita/);
      await rejected(url, { ...drug, nre: 'X'.repeat(21) }, /nre/);
      await rejected(url, { ...drug, codice: 'PR.01' }, /codice/);
      await rejected(url, { tipo: 'prestazione', data: day(0) }, /il codice o la descrizione/);
      await rejected(
        url,
        { tipo: 'prestazione', data: day(0), codice: 'X', posologia: 'x' },
        /posologia/,
      );
      await rejected(url, { tipo: 'ricetta', data: day(0) }, /tipo/);
    });

    it('annullamento con motivo: resta, segnata, e non si conta più', async () => {
      const url = patientUrl(`/ricette-passate/${ids.onlyPastNewer}/annulla`);
      expect((await req('POST', url, doctor, {})).statusCode).toBe(400);
      expect((await req('POST', url, secretary, { motivo: 'Errore' })).statusCode).toBe(403);
      expect((await lastLog('annullamento_ricetta_passata'))!.outcome).toBe('negato');
      const res = await req('POST', url, doctor, { motivo: 'Importata due volte' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ id: ids.onlyPastNewer, stato: 'annullata' });
      expect((await req('POST', url, doctor, { motivo: 'Ancora' })).statusCode).toBe(409);

      const { farmaci, ricettePassate } = await drugs();
      expect(farmaci.find((d) => d.chiave === 'aic:900000045')!.altroProgramma).toEqual({
        ricette: 1,
        ultimaIl: '2024-11-02',
      });
      expect(ricettePassate.find((x) => x.id === ids.onlyPastNewer)).toMatchObject({
        stato: 'annullata',
        motivoAnnullamento: 'Importata due volte',
      });
      // Lo storico della voce la mostra, annullata, e non la conta.
      const h = await history({ aic: '900000045' });
      expect(h.altroProgramma.ricette).toBe(1);
      expect(h.ricettePassate.find((x) => x.id === ids.onlyPastNewer)!.stato).toBe('annullata');
      expect((await timeline()).find((x) => x.id === ids.onlyPastNewer)!.annullata).toBe(true);

      // Una ricetta passata annullata, da sola, non fa una voce dei prescritti: resta nell'elenco.
      for (const body of [
        { tipo: 'farmaco', data: day(0), aic: '900000053', farmaco: 'Annullato di prova' },
        { tipo: 'prestazione', data: day(0), codice: 'PR.53', descrizione: 'ESAME ANNULLATO' },
      ]) {
        const res = await past(body);
        expect(res.statusCode, res.body).toBe(201);
        const annul = patientUrl(`/ricette-passate/${res.json().id}/annulla`);
        expect((await req('POST', annul, doctor, { motivo: 'Per errore' })).statusCode).toBe(200);
      }
      const after = await drugs();
      expect(after.farmaci.map((d) => d.aic)).not.toContain('900000053');
      expect(after.ricettePassate.find((x) => x.aic === '900000053')!.stato).toBe('annullata');
      const afterServices = await services();
      expect(afterServices.prestazioni.map((x) => x.codice)).not.toContain('PR.53');
      expect(afterServices.ricettePassate.find((x) => x.codice === 'PR.53')!.stato).toBe(
        'annullata',
      );
      // Lo storico dice chi l'ha annullata; nel database non si cancella.
      const changes = await t.db
        .select()
        .from(changeHistory)
        .where(
          and(
            eq(changeHistory.tableName, 'historical_prescription'),
            eq(changeHistory.rowId, ids.onlyPastNewer!),
          ),
        );
      expect(changes.map((c) => c.operation)).toEqual(['INSERT', 'UPDATE']);
      expect(changes[1]!.userId).toBe(s.users.titolare.id);
      await expect(
        t.db
          .delete(historicalPrescription)
          .where(eq(historicalPrescription.id, ids.onlyPastNewer!)),
      ).rejects.toThrow();
    });

    it('una ricetta passata di un altro paziente non si tocca da questa cartella', async () => {
      const other = s.patients.titolare.find((x) => x !== s.richPatient)!;
      const res = await req('POST', patientUrl('/ricette-passate', other), doctor, {
        tipo: 'farmaco',
        data: day(0),
        farmaco: 'Farmaco di un altro paziente',
      });
      expect(res.statusCode).toBe(201);
      const foreign = res.json().id;
      expect(
        (
          await req('POST', patientUrl(`/ricette-passate/${foreign}/annulla`), doctor, {
            motivo: 'x',
          })
        ).statusCode,
      ).toBe(404);
      expect((await drugs()).ricettePassate.map((x) => x.id)).not.toContain(foreign);
    });
  });

  describe('terapie concluse', () => {
    const url = (path = '') => patientUrl(`/terapie${path}`);
    const base = {
      drugName: 'Farmaco di prova concluso 20 mg',
      activeIngredient: 'principio concluso',
      kind: 'chronic',
      startOn: '2026-01-10',
      packsPerPrescription: 1,
    };
    const row = async (id: string) =>
      (await t.db.select().from(therapy).where(eq(therapy.id, id)))[0]!;

    it('si registra una terapia già conclusa, con inizio e fine', async () => {
      const id = await created('POST', url(), { ...base, concluded: true, endOn: day(-10) });
      expect(await row(id)).toMatchObject({ status: 'ended', endOn: day(-10) });
      const listed = (await req('GET', url(), doctor))
        .json()
        .terapie.find((x: { id: string }) => x.id === id);
      expect(listed).toMatchObject({ status: 'ended' });
      const item = (
        (await req('GET', patientUrl('/farmaci-prescritti'), doctor)).json().farmaci as DrugItem[]
      ).find((d) => d.terapia?.id === id)!;
      expect(item.terapia).toMatchObject({ stato: 'ended', fine: day(-10) });
      // Senza il segno «conclusa» è una terapia in corso, come prima.
      expect(await row(await created('POST', url(), base))).toMatchObject({ status: 'active' });
    });

    it('controlli: la fine c’è, non è nel futuro e non viene prima dell’inizio', async () => {
      await rejected(url(), { ...base, concluded: true }, /manca la data di fine/);
      await rejected(url(), { ...base, concluded: true, endOn: day(1) }, /nel futuro/);
      await rejected(url(), { ...base, concluded: true, endOn: '2026-01-01' }, /prima dell’inizio/);
    });

    it('si conclude una terapia in corso con la data di fine; poi non si sospende, non si riprende, non si ripete', async () => {
      const id = await created('POST', url(), base);
      const conclude = (body: object, cookie = doctor) =>
        req('POST', url(`/${id}/concludi`), cookie, body);
      expect((await conclude({ fine: day(0) }, secretary)).statusCode).toBe(403);
      expect((await conclude({})).statusCode).toBe(400);
      expect((await conclude({ fine: day(1) })).statusCode).toBe(400);
      expect((await conclude({ fine: '2026-01-01' })).statusCode).toBe(400);
      const res = await conclude({ fine: day(0) });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ stato: 'ended', fine: day(0) });
      expect(await row(id)).toMatchObject({ status: 'ended', endOn: day(0) });
      expect((await conclude({ fine: day(0) })).statusCode).toBe(409);
      expect((await req('POST', url(`/${id}/sospendi`), doctor, { motivo: 'x' })).statusCode).toBe(
        409,
      );
      expect((await req('POST', url(`/${id}/riprendi`), doctor)).statusCode).toBe(409);
      const repeat = await req('POST', patientUrl('/ricette/ripeti'), doctor, { terapie: [id] });
      expect(repeat.statusCode).toBe(409);
      expect(repeat.json().errore).toMatch(/Terapia non attiva/);
      expect((await lastLog('modifica_terapia'))!.outcome).toBe('consentito');
    });

    it('anche una terapia sospesa si conclude: il motivo della sospensione lascia la scheda', async () => {
      const id = await created('POST', url(), base);
      expect(
        (await req('POST', url(`/${id}/sospendi`), doctor, { motivo: 'Motivo di prova' }))
          .statusCode,
      ).toBe(200);
      expect((await req('POST', url(`/${id}/concludi`), doctor, { fine: day(0) })).statusCode).toBe(
        200,
      );
      expect(await row(id)).toMatchObject({ status: 'ended', suspendedReason: null });
    });

    it('la modifica di una terapia conclusa tiene la fine vera; «conclusa» non si cambia dalla modifica', async () => {
      const id = await created('POST', url(), { ...base, concluded: true, endOn: day(-3) });
      const put = (body: object) => req('PUT', url(`/${id}`), doctor, body);
      expect((await put({ ...base, endOn: null })).statusCode).toBe(400);
      expect((await put({ ...base, endOn: day(2) })).statusCode).toBe(400);
      const ok = await put({ ...base, endOn: day(-2), dose: '1' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await row(id)).toMatchObject({ status: 'ended', endOn: day(-2), dose: '1' });
      expect((await put({ ...base, endOn: day(-2), concluded: true })).statusCode).toBe(400);
      // Una terapia in corso non si conclude dalla modifica.
      const active = await created('POST', url(), base);
      const res = await req('PUT', url(`/${active}`), doctor, { ...base, concluded: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().errore).toMatch(/«Concludi»/);
      expect(await row(active)).toMatchObject({ status: 'active' });
    });
  });
});
