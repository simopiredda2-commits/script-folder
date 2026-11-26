import {
  FseGatewayClient,
  SIMULATED_FSE_AUDIENCE,
  SimulatedDocumentSigner,
  SimulatedFseGateway,
  extractCda,
  pssSchematron,
  readPades,
  type SimulatedFseOutcome,
} from '@mmg/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archiveGrant, fseTransmission, patient, pssDocument, therapy } from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { studioDate } from '../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface Item {
  id: string;
  etichetta: string;
  incluso: boolean;
  manca: string[];
}
interface Pss {
  id: string;
  stato: string;
  versione: number;
  documento: string;
  sostituisce: string | null;
  contenuto: {
    sezioni: Record<string, Item[]>;
    esclusi: { oscurate: number; riservate: number };
    nonInseribili: { etichetta: string; motivo: string }[];
    assenze: Record<string, string>;
  };
}

describe('Profilo Sanitario Sintetico nel Fascicolo (tappa 11)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let mode: SimulatedFseOutcome = 'ok';

  beforeAll(async () => {
    t = await createTestDatabase();
    // L'orologio dello scenario c'è solo dopo la sua creazione: fino ad allora quello vero.
    let clock = () => new Date();
    const now = () => clock();
    const simulator = new SimulatedFseGateway({ now, decide: () => mode });
    s = await createScenario(
      t.db,
      {},
      {
        fse: {
          gateway: new FseGatewayClient(simulator, simulator.issueCredentials('Prova'), now),
          audience: SIMULATED_FSE_AUDIENCE,
          signer: new SimulatedDocumentSigner({ now }),
          // Il Fascicolo della regione dello studio, simulato, pubblica su questo Gateway (D297).
          simulator,
        },
      },
    );
    clock = () => s.clock.now();
    doctor = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const base = () => `/api/pazienti/${s.richPatient}/profilo-sanitario`;
  const req = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object, cookie = doctor) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const ok = async <T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => {
    const res = await req(method, url, payload);
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json<T>();
  };
  const entry = (body: object) =>
    ok('POST', `/api/pazienti/${s.richPatient}/voci`, { data: studioDate(s.clock.now()), ...body });
  const item = (p: Pss, section: string, label: RegExp) =>
    p.contenuto.sezioni[section]!.find((i) => label.test(i.etichetta))!;

  it('compone dalla cartella: obbligatori proposti, oscurate fuori, riservate non proposte', async () => {
    await entry({
      tipo: 'problema',
      descrizione: 'Diabete di prova',
      codice: '250.00',
      cronico: true,
    });
    await entry({
      tipo: 'problema',
      descrizione: 'Problema oscurato',
      codice: '300.0',
      cronico: true,
      oscurata: true,
    });
    await entry({
      tipo: 'anamnesi',
      sezione: 'familiare',
      testo: 'Infarto del padre',
      parente: 'padre',
      codice: '410.9',
      etaEsordio: 55,
    });
    await entry({ tipo: 'anamnesi', sezione: 'familiare', testo: 'Testo libero senza codice' });
    await entry({ tipo: 'misura', parametro: 'peso', valore: '70' });
    await entry({ tipo: 'stile_di_vita', fattore: 'Fumo', valore: 'Ex fumatrice', fumo: 'no' });
    await entry({ tipo: 'stile_di_vita', fattore: 'Dieta', valore: 'Mediterranea' });
    await entry({ tipo: 'capacita_motoria', capacita: 'autonomo' });
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx.insert(therapy).values({
        patientId: s.richPatient,
        drugAic: '000000001',
        atc: 'C09AA02',
        drugName: 'Farmaco con codice 20 mg',
        activeIngredient: 'Enalapril',
        dose: '1',
        doseUnit: 'compressa',
        route: 'per bocca',
        kind: 'chronic',
        startOn: '2026-01-01',
        createdBy: s.users.titolare.id,
      }),
    );
    const before = await ok<{ inLavorazione: null; versioni: unknown[]; mancano: string[] }>(
      'GET',
      base(),
    );
    expect(before).toMatchObject({ inLavorazione: null, versioni: [], mancano: [] });
    const p = await ok<Pss>('POST', `${base()}/bozza`);
    expect(p).toMatchObject({ stato: 'draft', versione: 1, sostituisce: null });
    const c = p.contenuto;
    expect(item(p, 'problemi', /Diabete/)).toMatchObject({ incluso: true, manca: [] });
    expect(item(p, 'problemi', /^Problema di prova/)).toMatchObject({ incluso: false });
    expect(c.sezioni.problemi!.some((i) => /oscurato/.test(i.etichetta))).toBe(false);
    expect(item(p, 'allergie', /Sostanza di prova/)).toMatchObject({ incluso: true });
    expect(item(p, 'terapie', /Farmaco con codice/)).toMatchObject({ incluso: true, manca: [] });
    expect(item(p, 'terapie', /Farmaco di prova/)).toMatchObject({
      incluso: false,
      manca: [
        'Manca il codice AIC o ATC del farmaco',
        'Scegli la via di somministrazione nella scheda della terapia',
      ],
    });
    expect(c.sezioni.terapie!.some((i) => /riservato/.test(i.etichetta))).toBe(false);
    expect(item(p, 'anamnesiFamiliare', /Padre/)).toMatchObject({ incluso: true });
    expect(item(p, 'parametri', /Peso/)).toMatchObject({ incluso: true });
    expect(item(p, 'stiliDiVita', /Fumo/)).toMatchObject({ incluso: true });
    expect(item(p, 'capacitaMotoria', /Autonomo/)).toMatchObject({ incluso: true });
    expect(c.esclusi).toEqual({ oscurate: 1, riservate: 2 });
    expect(c.nonInseribili.map((n) => n.motivo)).toEqual(
      expect.arrayContaining([
        'Indica il parente e il codice ICD-9-CM della patologia',
        'Il Profilo ha i codici solo per fumo, alcol e attività fisica',
      ]),
    );
    expect(c.assenze).toMatchObject({ allergie: 'no-allergy-info' });
  });

  it('il medico sceglie; una voce a cui manca qualcosa non entra', async () => {
    const draft = (await ok<{ inLavorazione: Pss }>('GET', base())).inLavorazione;
    const smoke = item(draft, 'stiliDiVita', /Fumo/);
    const blocked = item(draft, 'terapie', /Farmaco di prova/);
    const res = await req('PATCH', `${base()}/${draft.id}`, {
      scelte: { terapie: { [blocked.id]: true } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ errore: string }>().errore).toMatch(/Manca il codice AIC o ATC/);
    const p = await ok<Pss>('PATCH', `${base()}/${draft.id}`, {
      scelte: { stiliDiVita: { [smoke.id]: false } },
      assenze: { allergie: 'no-known-allergies' },
    });
    expect(item(p, 'stiliDiVita', /Fumo/).incluso).toBe(false);
    expect(p.contenuto.assenze.allergie).toBe('no-known-allergies');
    // Ricomporre tiene le scelte fatte.
    const again = await ok<Pss>('POST', `${base()}/bozza`);
    expect(again.id).toBe(draft.id);
    expect(item(again, 'stiliDiVita', /Fumo/).incluso).toBe(false);
  });

  it('«Nessuna terapia nota» non si scrive con terapie in cartella, anche se nessuna entra (audit D259)', async () => {
    const draft = (await ok<{ inLavorazione: Pss }>('GET', base())).inLavorazione;
    const none = Object.fromEntries(draft.contenuto.sezioni.terapie!.map((i) => [i.id, false]));
    const untrue = await req('PATCH', `${base()}/${draft.id}`, {
      scelte: { terapie: none },
      assenze: { terapie: 'no-known-medications' },
    });
    expect(untrue.statusCode).toBe(400);
    expect(untrue.json<{ errore: string }>().errore).toMatch(
      /^Terapie farmacologiche: in cartella ci sono voci, quindi «Nessuna terapia nota» non si può scrivere/,
    );
    // Niente è cambiato: la terapia con il codice è ancora dentro.
    const still = (await ok<{ inLavorazione: Pss }>('GET', base())).inLavorazione;
    expect(item(still, 'terapie', /Farmaco con codice/).incluso).toBe(true);
    // «Nessuna informazione» sì: è vero.
    const honest = await ok<Pss>('PATCH', `${base()}/${draft.id}`, {
      scelte: { terapie: none },
      assenze: { terapie: 'no-medication-info' },
    });
    expect(honest.contenuto.assenze.terapie).toBe('no-medication-info');
    // Anche l'anamnesi familiare senza codice conta come voce in cartella.
    const family = Object.fromEntries(
      draft.contenuto.sezioni.anamnesiFamiliare!.map((i) => [i.id, false]),
    );
    const noFamily = await req('PATCH', `${base()}/${draft.id}`, {
      scelte: { anamnesiFamiliare: family },
      assenze: { anamnesiFamiliare: 'no-known-problems' },
    });
    expect(noFamily.statusCode).toBe(400);
    expect(noFamily.json<{ errore: string }>().errore).toMatch(/^Anamnesi familiare: /);
    // Si rimette com'era, per le prove che seguono.
    await ok('PATCH', `${base()}/${draft.id}`, {
      scelte: {
        terapie: { [item(still, 'terapie', /Farmaco con codice/).id]: true },
        anamnesiFamiliare: Object.fromEntries(Object.keys(family).map((k) => [k, true])),
      },
    });
  });

  it('valida dopo la conferma del medico; il PDF ha dentro il CDA, che rispetta lo schematron', async () => {
    const draft = (await ok<{ inLavorazione: Pss }>('GET', base())).inLavorazione;
    expect((await req('POST', `${base()}/${draft.id}/valida`, {})).statusCode).toBe(400);
    // Una «Nessuna terapia nota» non vera, scritta nel database senza passare dalla scelta: la
    // validazione la ferma lo stesso (audit D259).
    const [row] = await t.db.select().from(pssDocument).where(eq(pssDocument.id, draft.id));
    const good = row!.content as Pss['contenuto'];
    const untrue = structuredClone(good);
    for (const i of untrue.sezioni.terapie!) i.incluso = false;
    untrue.assenze.terapie = 'no-known-medications';
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx.update(pssDocument).set({ content: untrue }).where(eq(pssDocument.id, draft.id)),
    );
    const stopped = await req('POST', `${base()}/${draft.id}/valida`, { confermo: true });
    expect(stopped.statusCode).toBe(422);
    expect(stopped.json<{ errore: string }>().errore).toMatch(
      /Terapie farmacologiche: in cartella ci sono voci/,
    );
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx.update(pssDocument).set({ content: good }).where(eq(pssDocument.id, draft.id)),
    );
    const p = await ok<Pss>('POST', `${base()}/${draft.id}/valida`, { confermo: true });
    expect(p.stato).toBe('validated');
    const pdf = await req('GET', `${base()}/${draft.id}/pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const xml = (await extractCda(new Uint8Array(pdf.rawPayload)))!;
    expect(xml).toContain('Diabete di prova');
    expect(xml).not.toContain('Problema oscurato');
    expect(xml).not.toContain('Farmaco riservato');
    expect(pssSchematron().validate(xml).errors).toEqual([]);
    // Validato, non si sceglie più.
    expect((await req('PATCH', `${base()}/${draft.id}`, { assenze: {} })).statusCode).toBe(409);
  });

  it('firma e pubblica: preso in carico, poi pubblicato; ogni chiamata nel registro degli invii', async () => {
    const open = (await ok<{ inLavorazione: Pss }>('GET', base())).inLavorazione;
    const p = await ok<Pss>('POST', `${base()}/${open.id}/firma-e-pubblica`);
    expect(p.stato).toBe('published');
    const pdf = await req('GET', `${base()}/${open.id}/pdf`);
    expect(readPades(new Uint8Array(pdf.rawPayload))?.subFilter).toBe('ETSI.CAdES.detached');
    const calls = await t.db
      .select()
      .from(fseTransmission)
      .where(eq(fseTransmission.documentId, open.id));
    // Validazione sul Gateway, poi il Fascicolo regionale: CREATE ed esito (V09, scenario 1).
    expect(calls.map((c) => `${c.operation} ${c.outcome}`).sort()).toEqual([
      'regional_create ok',
      'regional_outcome ok',
      'validation ok',
    ]);
    const published = p as Pss & {
      identificativoFascicolo: string | null;
      fascicolo: { operazione: string; stato: string } | null;
    };
    expect(published.identificativoFascicolo).toMatch(
      /^2\.16\.840\.1\.113883\.2\.9\.2\.10\.4\.4\^\d+$/,
    );
    expect(published.fascicolo).toMatchObject({ operazione: 'create', stato: 'done' });
    // Nel registro il messaggio intero, senza credenziali e con il documento indicato dall'impronta.
    const create = calls.find((c) => c.operation === 'regional_create')!;
    expect(create.request).toContain('<tipoAttivita>CREATE</tipoAttivita>');
    expect(create.request).toContain('<tip:TipoAttivitaClinica>ERP</tip:TipoAttivitaClinica>');
    expect(create.request).toContain('<pinCode>[omessa]</pinCode>');
    expect(create.request).toMatch(
      /<documento>\[documento: sha256 [0-9a-f]{64}, \d+ byte, in pss_file\]<\/documento>/,
    );
    expect(create.request).not.toContain('parola-di-prova');
    expect(create.response).toContain('TEMP_010_');
    const overview = await ok<{ versioni: Pss[]; inLavorazione: Pss | null }>('GET', base());
    expect(overview.inLavorazione).toBeNull();
    expect(overview.versioni.map((v) => [v.versione, v.stato])).toEqual([[1, 'published']]);
  });

  it('una versione nuova sostituisce la precedente, che resta consultabile', async () => {
    await entry({
      tipo: 'allergia',
      sostanza: 'Amoxicillina',
      agente: 'farmaco',
      codiceAgente: 'J01CA04',
    });
    const v2 = await ok<Pss>('POST', `${base()}/bozza`);
    expect(v2).toMatchObject({ versione: 2 });
    expect(v2.sostituisce).not.toBeNull();
    await ok('POST', `${base()}/${v2.id}/valida`, { confermo: true });
    expect((await ok<Pss>('POST', `${base()}/${v2.id}/firma-e-pubblica`)).stato).toBe('published');
    const overview = await ok<{ versioni: Pss[] }>('GET', base());
    expect(overview.versioni.map((v) => [v.versione, v.stato])).toEqual([
      [2, 'published'],
      [1, 'replaced'],
    ]);
    const rows = await t.db
      .select()
      .from(pssDocument)
      .where(eq(pssDocument.patientId, s.richPatient));
    const set = new Set(rows.map((r) => `${r.setRoot}^${r.setExtension}`));
    expect(set.size).toBe(1);
  });

  it('la rete che manca non cambia il Profilo e resta nel registro; si riprova', async () => {
    const draft = await ok<Pss>('POST', `${base()}/bozza`);
    mode = 'unreachable';
    const res = await req('POST', `${base()}/${draft.id}/valida`, { confermo: true });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ errore: string }>().errore).toBe('Gateway non raggiungibile');
    mode = 'ok';
    const after = await ok<{ inLavorazione: Pss }>('GET', base());
    expect(after.inLavorazione.stato).toBe('draft');
    const calls = await t.db
      .select()
      .from(fseTransmission)
      .where(eq(fseTransmission.documentId, draft.id));
    expect(calls.map((c) => c.outcome)).toEqual(['unreachable']);
    expect((await ok<Pss>('POST', `${base()}/${draft.id}/valida`, { confermo: true })).stato).toBe(
      'validated',
    );
    expect((await ok<Pss>('POST', `${base()}/${draft.id}/scarta`)).stato).toBe('discarded');
  });

  it('preso in carico ma non ancora a INI: resta in lavorazione finché lo stato non lo conferma', async () => {
    const v3 = await ok<Pss>('POST', `${base()}/bozza`);
    await ok('POST', `${base()}/${v3.id}/valida`, { confermo: true });
    mode = 'ini-pending';
    expect((await ok<Pss>('POST', `${base()}/${v3.id}/firma-e-pubblica`)).stato).toBe('submitted');
    const waiting = await ok<{ versioni: Pss[]; inLavorazione: Pss }>('GET', base());
    expect(waiting.inLavorazione).toMatchObject({ id: v3.id, stato: 'submitted' });
    // La versione precedente resta quella pubblicata finché INI non ha la nuova.
    expect(waiting.versioni.map((v) => [v.versione, v.stato])).toEqual([
      [2, 'published'],
      [1, 'replaced'],
    ]);
    expect((await ok<Pss>('POST', `${base()}/${v3.id}/stato`)).stato).toBe('submitted');
    mode = 'ok';
    expect((await ok<Pss>('POST', `${base()}/${v3.id}/stato`)).stato).toBe('published');
    const after = await ok<{ versioni: Pss[]; inLavorazione: Pss | null }>('GET', base());
    expect(after.inLavorazione).toBeNull();
    expect(after.versioni.map((v) => [v.versione, v.stato])).toEqual([
      [3, 'published'],
      [2, 'replaced'],
      [1, 'replaced'],
    ]);
    expect((await req('POST', `${base()}/${v3.id}/stato`)).statusCode).toBe(409);
    const calls = await t.db
      .select()
      .from(fseTransmission)
      .where(eq(fseTransmission.documentId, v3.id));
    // Sostituzione regionale (V09, scenario 3): ricerca dell'UUID, REPLACE, poi tre esiti (due
    // «ELAB» finché i metadati non sono a INI, poi «OK»).
    expect(calls.map((c) => c.operation).sort()).toEqual([
      'regional_outcome',
      'regional_outcome',
      'regional_outcome',
      'regional_replace',
      'regional_search',
      'validation',
    ]);
  });

  it('chi può: il collega di gruppo e la segreteria no; il contenuto validato non cambia nel database', async () => {
    // Il collega della medicina di gruppo, autorizzato: legge la cartella, non firma il Profilo.
    const [rich] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
    await t.db.insert(archiveGrant).values({
      archiveId: rich!.archiveId,
      granteeUserId: s.users.collega.id,
      kind: 'group_colleague',
      validFrom: new Date(s.clock.now().getTime() - 86_400_000),
      validTo: new Date(s.clock.now().getTime() + 86_400_000),
      reason: 'Medicina di gruppo di prova',
      grantedBy: s.users.titolare.id,
    });
    const colleague = await login(s, 'collega');
    const seen = await req('GET', base(), undefined, colleague);
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json<{ puoFirmare: boolean }>().puoFirmare).toBe(false);
    const denied = await req('POST', `${base()}/bozza`, undefined, colleague);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ errore: string }>().errore).toBe(
      'Il Profilo lo firma il medico di famiglia del paziente o il suo sostituto',
    );
    expect((await ok<{ puoFirmare: boolean }>('GET', base())).puoFirmare).toBe(true);
    const secretary = await login(s, 'segreteria');
    expect((await req('GET', base(), undefined, secretary)).statusCode).toBe(403);
    const [published] = await t.db
      .select()
      .from(pssDocument)
      .where(eq(pssDocument.status, 'published'));
    /** Il messaggio del database, dentro l'errore della libreria. */
    const dbError = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'nessun errore';
      } catch (e) {
        const err = e as { cause?: { message?: string }; message: string };
        return err.cause?.message ?? err.message;
      }
    };
    expect(
      await dbError(
        withActor(t.db, s.users.titolare.id, (tx) =>
          tx
            .update(pssDocument)
            .set({ cdaXml: '<cambiato/>' })
            .where(eq(pssDocument.id, published!.id)),
        ),
      ),
    ).toMatch(/non si modifica/);
    expect(
      await dbError(
        withActor(t.db, s.users.titolare.id, (tx) =>
          tx.update(pssDocument).set({ status: 'draft' }).where(eq(pssDocument.id, published!.id)),
        ),
      ),
    ).toMatch(/passaggio non ammesso/);
  });
});
