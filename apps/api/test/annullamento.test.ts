import type { DispensingState } from '@mmg/domain';
import { SimulatedGateway } from '@mmg/integrations';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { externalSubmission, prescription } from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * D70 (richiesta di Simone): una ricetta già lavorata dall'ente (presa in carico, prenotata,
 * erogata) non si annulla; l'annullamento, quando è possibile, cambia solo lo stato e la ricetta
 * resta nello storico.
 */
describe('annullamento secondo lo stato di erogazione (D70)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let cookie: string;
  const states = new Map<string, DispensingState | 'unreachable'>();
  let cancelCalls = 0;
  const sar = new SimulatedGateway('sar', {
    decideStatus: (nre) => states.get(nre) ?? 'non_erogata',
    decideCancel: () => {
      cancelCalls++;
      return 'accepted';
    },
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      {},
      { gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') } },
    );
    cookie = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

  /** Una visita specialistica inviata: restituisce id e NRE. */
  async function sentVisit(description = 'Visita chirurgica - primo accesso') {
    const res = await req('POST', `/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'specialist_ssn',
      accessType: 'first',
      priority: 'P',
      diagnosticQuestion: 'Quesito di prova',
      lines: [
        {
          serviceCode: 'PROVA.CH',
          serviceNationalCode: 'PROVA.CH',
          serviceDescription: description,
          quantity: 1,
        },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    const sent = await req('POST', `/api/ricette/${id}/firma-e-invia`, {});
    expect(sent.statusCode, sent.body).toBe(200);
    return { id, nre: sent.json<{ nre: string }>().nre };
  }

  it('già erogata: l’annullamento è rifiutato prima di chiederlo all’ente, la ricetta resta inviata', async () => {
    const { id, nre } = await sentVisit();
    states.set(nre, 'erogata');
    const before = cancelCalls;
    const res = await req('POST', `/api/ricette/${id}/annulla`, {
      motivo: 'Il paziente dice di non averla prenotata',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().errore).toMatch(/Non annullabile: per l'ente la ricetta risulta «erogata»/);
    expect(res.json().errore).toMatch(/Resta nello storico/);
    expect(cancelCalls).toBe(before);
    const [row] = await t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(row).toMatchObject({ status: 'sent', dispensingState: 'erogata' });
    expect(row!.dispensingCheckedAt).toBeInstanceOf(Date);
    const asked = await t.db
      .select()
      .from(externalSubmission)
      .where(
        and(eq(externalSubmission.prescriptionId, id), eq(externalSubmission.operation, 'stato')),
      );
    expect(asked.map((a) => a.outcome)).toEqual(['ok']);
  });

  it('presa in carico o prenotata: neanche questa si annulla', async () => {
    const { id, nre } = await sentVisit();
    states.set(nre, 'presa_in_carico');
    const status = await req('GET', `/api/ricette/${id}/stato-erogazione`);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      inviata: true,
      stato: 'presa_in_carico',
      etichetta: 'Presa in carico o prenotata',
      annullabile: false,
    });
    expect((await req('POST', `/api/ricette/${id}/annulla`, { motivo: 'Prova' })).statusCode).toBe(
      409,
    );
  });

  it('non ancora presa in carico: si annulla, e resta nello storico come annullata, con chi e perché', async () => {
    const { id } = await sentVisit('Visita da annullare');
    const status = (await req('GET', `/api/ricette/${id}/stato-erogazione`)).json();
    expect(status).toMatchObject({ stato: 'non_erogata', annullabile: true });
    const res = await req('POST', `/api/ricette/${id}/annulla`, {
      motivo: 'Prescritta per errore',
    });
    expect(res.statusCode, res.body).toBe(200);
    const history = (
      await req('GET', `/api/pazienti/${s.richPatient}/storico-prescrizioni?prestazione=PROVA.CH`)
    ).json();
    const v = history.voci.find((x: { ricetta: { id: string } }) => x.ricetta.id === id);
    expect(v.ricetta).toMatchObject({
      stato: 'cancelled',
      annullataDa: 'Dott.ssa Elena Marchi',
      motivoAnnullamento: 'Prescritta per errore',
      statoErogazione: 'non_erogata',
    });
    expect(
      v.enti.map((e: { operazione: string; esito: string }) => `${e.operazione}:${e.esito}`),
    ).toEqual(['invio:accepted', 'stato:ok', 'stato:ok', 'annullamento:accepted']);
    // Le altre due visite (erogata e presa in carico) restano prescritte; questa è annullata.
    expect(history.ultimi12Mesi).toBe(2);
    expect(history.annullateUltimi12Mesi).toBe(1);
  });

  it('se lo stato non si sa, decide l’ente', async () => {
    const { id, nre } = await sentVisit('Visita con stato non disponibile');
    states.set(nre, 'unreachable');
    const status = (await req('GET', `/api/ricette/${id}/stato-erogazione`)).json();
    expect(status).toMatchObject({ inviata: true, stato: null, annullabile: null });
    expect(status.motivo).toMatch(/decide l'ente/);
    const before = cancelCalls;
    expect((await req('POST', `/api/ricette/${id}/annulla`, { motivo: 'Prova' })).statusCode).toBe(
      200,
    );
    expect(cancelCalls).toBe(before + 1);
  });

  it('una bozza si annulla nel prodotto, senza chiedere all’ente', async () => {
    const res = await req('POST', `/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      lines: [
        { drugName: 'Farmaco di prova', activeIngredient: 'principio di prova', quantity: 1 },
      ],
    });
    const status = (await req('GET', `/api/ricette/${res.json().id}/stato-erogazione`)).json();
    expect(status).toMatchObject({ inviata: false, annullabile: true });
  });
});
