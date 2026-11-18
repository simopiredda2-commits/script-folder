import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  appointment,
  clinicalEntry,
  labResultDetail,
  therapeuticPlan,
  therapy,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { startOfStudioDay } from '../src/http/today-routes';
import { studioDate } from '../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

const DAY = 86_400_000;
const plusDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

describe('rotte per l’interfaccia: storico, cronologia, esami, oggi', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let secretary: string;
  let therapyId: string;
  let reservedId: string;
  const today = studioDate(new Date());

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    secretary = await login(s, 'segreteria');
    const rows = await t.db.select().from(therapy).where(eq(therapy.patientId, s.richPatient));
    therapyId = rows.find((r) => !r.reserved)!.id;
    reservedId = rows.find((r) => r.reserved)!.id;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (method: 'GET' | 'POST', url: string, cookie: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const draft = async (body: object) => {
    const res = await req('POST', `/api/pazienti/${s.richPatient}/ricette`, doctor, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const send = async (id: string) => {
    const res = await req('POST', `/api/ricette/${id}/firma-e-invia`, doctor, {});
    expect(res.statusCode, res.body).toBe(200);
  };
  const history = (query: string, cookie = doctor) =>
    req('GET', `/api/pazienti/${s.richPatient}/storico-prescrizioni?${query}`, cookie);

  describe('storico delle prescrizioni (D65, D66)', () => {
    it('di un farmaco in terapia: le sue ricette e quelle con lo stesso principio, con tutti i dettagli', async () => {
      const line = {
        therapyId,
        drugName: 'Farmaco di prova 5 mg',
        activeIngredient: 'principio di prova',
        quantity: 2,
        posologyText: '1 compressa al mattino',
      };
      const first = await draft({ kind: 'pharma_ssn', lines: [line] });
      await send(first);
      await draft({ kind: 'pharma_ssn', lines: [{ ...line, quantity: 1 }] });
      // Riga senza terapia ma con lo stesso principio attivo: entra nello storico.
      const free = await draft({
        kind: 'white',
        lines: [{ drugName: 'Altro marchio', activeIngredient: 'Principio di prova', quantity: 1 }],
      });
      await send(free);
      // Un altro principio: non entra.
      await draft({
        kind: 'pharma_ssn',
        lines: [{ drugName: 'Altro', activeIngredient: 'altro principio', quantity: 1 }],
      });
      // Un'altra terapia dello stesso paziente, con la sua ricetta: non entra nello storico della prima.
      const [other] = await withActor(t.db, s.users.titolare.id, (tx) =>
        tx
          .insert(therapy)
          .values({
            patientId: s.richPatient,
            drugName: 'Secondo farmaco di prova',
            activeIngredient: 'secondo principio',
            kind: 'chronic',
            startOn: '2026-01-01',
            createdBy: s.users.titolare.id,
          })
          .returning(),
      );
      await draft({
        kind: 'pharma_ssn',
        lines: [
          {
            therapyId: other!.id,
            drugName: 'Secondo farmaco di prova',
            activeIngredient: 'secondo principio',
            quantity: 1,
          },
        ],
      });

      const res = await history(`terapia=${therapyId}`);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      // Più il paziente ha già una bozza dello scenario con lo stesso principio.
      expect(body.voci.length).toBe(4);
      const sent = body.voci.find((v: { ricetta: { id: string } }) => v.ricetta.id === first);
      expect(sent.ricetta).toMatchObject({ stato: 'sent', tipo: 'pharma_ssn' });
      expect(sent.ricetta.nre).toBeTruthy();
      expect(sent.ricetta.firmataDa).toBe('Dott.ssa Elena Marchi');
      expect(sent.ricetta.preparataDa).toBe('Dott.ssa Elena Marchi');
      expect(sent.riga).toMatchObject({ quantita: 2, posologia: '1 compressa al mattino' });
      expect(sent.controlli.map((c: { esito: string }) => c.esito)).toContain('superato');
      // Confezioni prescritte negli ultimi 12 mesi: solo le ricette inviate (2 + 1).
      expect(body.ultimi12Mesi).toBe(3);
    });

    it('di una prestazione: per codice regionale, oppure per descrizione se il codice manca', async () => {
      const spec = (lines: object[]) =>
        draft({
          kind: 'specialist_ssn',
          accessType: 'first',
          priority: 'P',
          diagnosticQuestion: 'Quesito di prova',
          lines,
        });
      await spec([{ serviceCode: '89.7', serviceDescription: 'Visita di prova', quantity: 1 }]);
      await spec([{ serviceDescription: 'Visita chirurgica - primo accesso', quantity: 1 }]);
      const byCode = (await history('prestazione=89.7')).json();
      expect(byCode.voci).toHaveLength(1);
      expect(byCode.voci[0].ricetta).toMatchObject({
        accesso: 'first',
        priorita: 'P',
        quesito: 'Quesito di prova',
      });
      const byText = (await history('descrizione=visita chirurgica - primo accesso')).json();
      expect(byText.voci).toHaveLength(1);
      expect(byText.voci[0].riga.prestazione).toBe('Visita chirurgica - primo accesso');
    });

    it('la terapia riservata non si vede senza il permesso; ogni lettura è registrata', async () => {
      expect((await history(`terapia=${reservedId}`, secretary)).statusCode).toBe(404);
      expect((await history(`terapia=${reservedId}`)).statusCode).toBe(200);
      const logged = await t.db
        .select()
        .from(accessLog)
        .where(
          and(
            eq(accessLog.patientId, s.richPatient),
            eq(accessLog.action, 'lettura_storico_prescrizioni'),
          ),
        );
      expect(logged.length).toBeGreaterThan(0);
    });

    it('senza farmaco né prestazione la richiesta è rifiutata, dopo la guardia', async () => {
      expect((await history('')).statusCode).toBe(400);
    });
  });

  describe('cronologia ed esami', () => {
    beforeAll(async () => {
      await withActor(t.db, s.users.titolare.id, async (tx) => {
        const [e] = await tx
          .insert(clinicalEntry)
          .values({
            patientId: s.richPatient,
            kind: 'lab_result',
            occurredOn: '2026-11-12',
            authorUserId: s.users.titolare.id,
          })
          .returning();
        await tx.insert(labResultDetail).values({
          entryId: e!.id,
          analyte: 'Esame di prova',
          value: '7,1',
          unit: '%',
          referenceText: '4,0–6,0 %',
        });
      });
    });

    it('tutto, visite, ricette ed esami, in ordine di data', async () => {
      const all = (await req('GET', `/api/pazienti/${s.richPatient}/cronologia`, doctor)).json();
      const kinds = new Set(all.cronologia.map((i: { tipo: string }) => i.tipo));
      expect(kinds).toContain('diary');
      expect(kinds).toContain('prescription');
      expect(kinds).toContain('lab_result');
      const dates = all.cronologia.map((i: { data: string }) => i.data);
      expect([...dates].sort().reverse()).toEqual(dates);
      const only = async (tipo: string) =>
        new Set(
          (await req('GET', `/api/pazienti/${s.richPatient}/cronologia?tipo=${tipo}`, doctor))
            .json()
            .cronologia.map((i: { tipo: string }) => i.tipo),
        );
      expect([...(await only('ricette'))]).toEqual(['prescription']);
      expect(await only('esami')).toEqual(new Set(['lab_result']));
      expect((await only('visite')).has('prescription')).toBe(false);
    });

    it('la segreteria non legge la cronologia clinica (diario spento per difetto)', async () => {
      const res = await req('GET', `/api/pazienti/${s.richPatient}/cronologia`, secretary);
      expect(res.statusCode).toBe(403);
    });

    it('esami: valore e intervallo del referto, nessun giudizio «sopra» o «sotto» (regola 3)', async () => {
      const res = await req('GET', `/api/pazienti/${s.richPatient}/esami`, doctor);
      expect(res.statusCode).toBe(200);
      const [e] = res.json().esami;
      expect(e).toMatchObject({ esame: 'Esame di prova', valore: '7,1', intervallo: '4,0–6,0 %' });
      expect(JSON.stringify(res.json())).not.toMatch(/sopra|sotto|alto|basso|anomal/i);
    });
  });

  describe('oggi', () => {
    beforeAll(async () => {
      const midnight = startOfStudioDay(today).getTime();
      await withActor(t.db, s.users.titolare.id, async (tx) => {
        await tx.insert(appointment).values([
          {
            studioId: s.studioId,
            patientId: s.richPatient,
            doctorUserId: s.users.titolare.id,
            startsAt: new Date(midnight + 9 * 3_600_000),
            endsAt: new Date(midnight + 9.25 * 3_600_000),
            kind: 'office',
            notes: 'Controllo di prova',
            createdBy: s.users.segreteria.id,
          },
          {
            studioId: s.studioId,
            patientId: s.richPatient,
            doctorUserId: s.users.titolare.id,
            startsAt: new Date(midnight + DAY + 9 * 3_600_000),
            endsAt: new Date(midnight + DAY + 9.25 * 3_600_000),
            kind: 'office',
            createdBy: s.users.segreteria.id,
          },
          {
            studioId: s.studioId,
            doctorUserId: s.users.collega.id,
            startsAt: new Date(midnight + 10 * 3_600_000),
            endsAt: new Date(midnight + 10.25 * 3_600_000),
            kind: 'home',
            createdBy: s.users.segreteria.id,
          },
        ]);
        await tx.insert(therapeuticPlan).values([
          {
            patientId: s.richPatient,
            drugName: 'Piano che scade presto',
            grantedOn: '2026-01-01',
            expiresOn: plusDays(today, 10),
          },
          {
            patientId: s.richPatient,
            drugName: 'Piano lontano',
            grantedOn: '2026-01-01',
            expiresOn: plusDays(today, 90),
          },
        ]);
      });
    });

    it('il medico vede i suoi appuntamenti di oggi, le code e i piani in scadenza secondo R5', async () => {
      const res = await req('GET', '/api/oggi', doctor);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.data).toBe(today);
      expect(body.appuntamenti).toHaveLength(1);
      expect(body.appuntamenti[0]).toMatchObject({ note: 'Controllo di prova', tipo: 'office' });
      expect(body.code.giorniAvvisoPiani).toBe(30);
      expect(body.code.pianiInScadenza.map((p: { farmaco: string }) => p.farmaco)).toEqual([
        'Piano che scade presto',
      ]);
      expect(typeof body.code.daFirmare).toBe('number');
    });

    it('la segreteria vede gli appuntamenti dello studio, non i piani (niente riepilogo clinico)', async () => {
      const body = (await req('GET', '/api/oggi', secretary)).json();
      expect(body.appuntamenti.length).toBe(2);
      expect(body.code.daFirmare).toBeNull();
      expect(body.code.pianiInScadenza).toEqual([]);
    });
  });
});
