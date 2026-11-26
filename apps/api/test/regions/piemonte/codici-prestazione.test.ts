import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedGateway } from '@mmg/integrations';
import { loadMappings } from '@mmg/reference';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prescription, prescriptionCheck, prescriptionLine } from '../../../src/db/schema';
import { EXAMPLE_TRANSCRIPTIONS } from '../../../src/reference/example-site';
import { importReferenceData } from '../../../src/reference/importer';
import { createScenario, login, type Scenario } from '../../helpers/scenario';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-db';
import { SimulatedSar } from '@mmg/regions/piemonte';

/**
 * I due codici della specialistica e il codice scritto a mano (D154). Specifiche del Sistema TS,
 * prescrizione (5/12/2024): codProdPrest (nomenclatore, «codice DM») e codCatalogoPrescr (catalogo
 * regionale) obbligatori; il Sistema TS, e prima il SAR, controllano la coppia sul catalogo che la
 * Regione ha trasmesso, non sulla nostra copia.
 */
describe('due codici della specialistica e codice scritto a mano (D154)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let work: string;
  // Il catalogo che la Regione ha trasmesso (simulato): conosce anche un codice nuovo, che la
  // nostra copia del catalogo non ha ancora.
  const sar = new SimulatedSar({
    regionalCatalog: (national, catalog) =>
      (catalog === '89.7' && national === '89.7') ||
      (catalog === 'NUOVO.1' && national === '99.99.1'),
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    work = mkdtempSync(join(tmpdir(), 'mmg-codici-'));
    // Nessun file scaricato da sync/: uno stato vuoto.
    writeFileSync(join(work, 'stato.json'), JSON.stringify({ versione: 1, file: {} }));
    // Solo le trascrizioni d'esempio: c'è il catalogo regionale («Visita di prova», 89.7).
    await importReferenceData({
      db: t.db,
      syncDir: work,
      transcriptionsDir: EXAMPLE_TRANSCRIPTIONS,
      mappings: loadMappings(),
      importedBy: 'prova',
    });
    s = await createScenario(
      t.db,
      {},
      {
        gateways: { regional: sar, sistema_ts: new SimulatedGateway('sistema_ts') },
      },
    );
    doctor = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
    rmSync(work, { recursive: true, force: true });
  });

  const post = (url: string, payload?: object) =>
    s.app.inject({
      method: 'POST',
      url,
      headers: { cookie: doctor },
      ...(payload ? { payload } : {}),
    });
  const draft = async (line: object) => {
    const res = await post(`/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'specialist_ssn',
      accessType: 'first',
      priority: 'P',
      diagnosticQuestion: 'Quesito di prova',
      lines: [{ quantity: 1, ...line }],
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const lineOf = async (id: string) =>
    (await t.db.select().from(prescriptionLine).where(eq(prescriptionLine.prescriptionId, id)))[0]!;

  it('dal catalogo: la riga conserva anche il codice del nomenclatore, e al SAR arrivano entrambi', async () => {
    const id = await draft({ serviceCode: '89.7', serviceDescription: 'Visita di prova' });
    expect(await lineOf(id)).toMatchObject({ serviceCode: '89.7', serviceNationalCode: '89.7' });
    const res = await post(`/api/ricette/${id}/firma-e-invia`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(sar.received.at(-1)!.lines[0]).toMatchObject({
      serviceCode: '89.7',
      serviceNationalCode: '89.7',
    });
  });

  it('codice nuovo scritto a mano: avvisa e chiede un motivo; con il motivo il SAR lo accetta', async () => {
    const id = await draft({
      serviceCode: 'NUOVO.1',
      serviceNationalCode: '99.99.1',
      serviceDescription: 'PRESTAZIONE NUOVA DI PROVA',
    });
    const blocked = await post(`/api/ricette/${id}/firma-e-invia`, {});
    expect(blocked.statusCode).toBe(422);
    const r18 = blocked
      .json()
      .dettagli.problemi.find((p: { ruleId: string }) => p.ruleId === 'R18');
    expect(r18).toMatchObject({ severity: 'warn', needs: 'reason' });
    const reason = 'Codice nuovo, il catalogo del programma non è ancora aggiornato';
    const ok = await post(`/api/ricette/${id}/firma-e-invia`, { motivi: { R18: reason } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(sar.received.at(-1)!.lines[0]).toMatchObject({
      serviceCode: 'NUOVO.1',
      serviceNationalCode: '99.99.1',
    });
    // Il motivo resta registrato con il controllo.
    const checks = await t.db
      .select()
      .from(prescriptionCheck)
      .where(eq(prescriptionCheck.prescriptionId, id));
    expect(JSON.stringify(checks.map((c) => c.reasons))).toContain(reason);
  });

  it('codice scritto a mano senza il codice del nomenclatore: R10 ferma l’invio', async () => {
    const id = await draft({
      serviceCode: 'NUOVO.2',
      serviceDescription: 'ALTRA PRESTAZIONE DI PROVA',
    });
    const res = await post(`/api/ricette/${id}/firma-e-invia`, { motivi: { R18: 'Codice nuovo' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().errore).toMatch(/manca il codice del nomenclatore/);
  });

  it('codice che neanche la Regione conosce: il SAR rifiuta e dice quale', async () => {
    const id = await draft({
      serviceCode: 'SBAGLIATO.1',
      serviceNationalCode: '99.99.9',
      serviceDescription: 'PRESTAZIONE SBAGLIATA DI PROVA',
    });
    const res = await post(`/api/ricette/${id}/firma-e-invia`, { motivi: { R18: 'Prova' } });
    expect(res.json().esito).toBe('rejected');
    const [row] = await t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(row!.status).toBe('error');
    expect(row!.lastErrorMessage).toMatch(/SBAGLIATO\.1.*non è nel catalogo regionale/);
  });
});
