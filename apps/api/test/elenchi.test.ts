import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  changeHistory,
  refService,
  referenceDataset,
  studioListItem,
} from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface Service {
  regionalCode: string;
  nationalCode: string | null;
  description: string;
}
interface Item {
  id: string;
  tipo: string;
  etichetta: string;
  dati: Record<string, unknown>;
  creataDa: string | null;
  archiviataIl: string | null;
  catalogo?: {
    prestazioni: { codice: string; descrizione: string; voce: Service | null }[];
  } | null;
}
interface Lists {
  voci: Item[];
  archiviate: Item[];
  catalogo: boolean | null;
  puoModificare: boolean;
  tipiContatto: { codice: string; nome: string }[];
}

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

/**
 * Elenchi dello studio (tappa 14): medici suggeritori, posologie, pacchetti di prestazioni,
 * contatti utili. Due studi nello stesso database; medici, strutture, recapiti e catalogo
 * inventati.
 */
describe('elenchi dello studio (tappa 14)', () => {
  let t: TestDatabase;
  let a: Scenario;
  let b: Scenario;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await createScenario(t.db, { name: 'Studio A di prova' });
    b = await createScenario(t.db, { name: 'Studio B di prova' });
    cookies.titolare = await login(a, 'titolare');
    cookies.segreteria = await login(a, 'segreteria');
    cookies.sostituto = await login(a, 'sostituto');
    cookies.amministratore = await login(a, 'amministratore');
    cookies.altroStudio = await login(b, 'titolare');
  });
  afterAll(async () => {
    await a?.app.close();
    await b?.app.close();
    await t?.drop();
  });

  const req = (
    cookie: string,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
    s: Scenario = a,
  ) => s.app.inject({ method, url, headers: { cookie }, payload });
  const create = (tipo: string, dati: object, cookie = cookies.titolare!, s: Scenario = a) =>
    req(cookie, 'POST', '/api/studio/elenchi', { tipo, dati }, s);
  const patch = (id: string, dati: object, cookie = cookies.titolare!, s: Scenario = a) =>
    req(cookie, 'PATCH', `/api/studio/elenchi/${id}`, { dati }, s);
  const archive = (id: string, cookie = cookies.titolare!, s: Scenario = a) =>
    req(cookie, 'POST', `/api/studio/elenchi/${id}/archivia`, {}, s);
  const list = async (query = '', cookie = cookies.titolare!, s: Scenario = a) => {
    const r = await req(cookie, 'GET', `/api/studio/elenchi${query}`, undefined, s);
    expect(r.statusCode, r.body).toBe(200);
    return r.json<Lists>();
  };
  const adminLog = async (studioId = a.studioId) =>
    (
      await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.studioId, studioId), eq(accessLog.action, 'amministrazione')))
        .orderBy(accessLog.seq)
    ).map((r) => ({ ...r, details: r.details as Record<string, unknown> }));

  /** Una versione inventata del catalogo delle prestazioni, in vigore dalla data. */
  async function insertCatalog(validFrom: string, rows: [string, string | null, string][]) {
    const [d] = await t.db
      .insert(referenceDataset)
      .values({
        kind: 'prestazioni',
        series: 'catalogo-prova-elenchi',
        title: 'Catalogo di prova degli elenchi',
        mappingVersion: 'prova',
        origin: 'trascrizione',
        sha256: randomBytes(32).toString('hex'),
        bytes: 1,
        validFrom,
        validFromBasis: 'atto',
        rows: rows.length,
        importedBy: 'prova',
      })
      .returning();
    await t.db.insert(refService).values(
      rows.map(([regionalCode, nationalCode, description]) => ({
        datasetId: d!.id,
        regionalCode,
        nationalCode,
        description,
        branch: 'Branca di prova',
      })),
    );
  }

  it('la segreteria legge gli elenchi ma non li scrive; il tentativo negato resta nel registro', async () => {
    const seen = await list('', cookies.segreteria);
    expect(seen.puoModificare).toBe(false);
    expect(seen.voci).toEqual([]);
    expect(seen.tipiContatto.map((k) => k.codice)).toEqual([
      'struttura',
      'specialista',
      'laboratorio',
      'altro',
    ]);
    const denied = await create('posologia', { testo: '1 compressa la sera' }, cookies.segreteria);
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ errore: string }>().errore).toBe(
      'Gli elenchi dello studio li modificano i medici e l’amministratore dello studio',
    );
    const last = (await adminLog()).at(-1)!;
    expect(last).toMatchObject({ outcome: 'negato', userId: a.users.segreteria.id });
    expect(last.details).toMatchObject({
      area: 'elenchi',
      azione: 'creazione',
      tipo: 'posologia',
      permesso: 'studio.lists',
    });
    expect(await t.db.select().from(studioListItem)).toEqual([]);
  });

  it('medici e amministratore scrivono: ogni tipo con i suoi campi, controllati', async () => {
    const s = await create('suggeritore', {
      nome: ' Dott.ssa Anna Prova ',
      struttura: 'Ospedale di prova',
      specialita: 'Cardiologia',
      telefono: '000 0000010',
    });
    expect(s.statusCode, s.body).toBe(201);
    const sug = s.json<Item>();
    ids.suggeritore = sug.id;
    expect(sug).toMatchObject({
      tipo: 'suggeritore',
      etichetta: 'Dott.ssa Anna Prova',
      creataDa: 'Dott.ssa Elena Marchi',
      archiviataIl: null,
      dati: {
        nome: 'Dott.ssa Anna Prova',
        struttura: 'Ospedale di prova',
        specialita: 'Cardiologia',
        telefono: '000 0000010',
      },
    });

    const p = await create(
      'posologia',
      {
        testo: '1 compressa una volta al giorno, la sera, per bocca',
        dose: '1',
        unita: 'compressa',
        frequenza: '1 volta al giorno',
        momento: 'la sera',
        via: 'per bocca',
      },
      cookies.sostituto,
    );
    expect(p.statusCode, p.body).toBe(201);
    ids.posologia = p.json<Item>().id;

    const c = await create(
      'contatto',
      {
        nome: 'Laboratorio di prova',
        tipo: 'laboratorio',
        telefono: '000 0000011',
        email: 'laboratorio@esempio.invalid',
        indirizzo: 'Via di Prova 2, Comune di prova',
        note: 'Prelievi dalle 7.30 alle 9.30',
      },
      cookies.amministratore,
    );
    expect(c.statusCode, c.body).toBe(201);
    ids.contatto = c.json<Item>().id;

    // I controlli di ogni tipo, detti in chiaro.
    const problem = async (tipo: string, dati: object) => {
      const r = await create(tipo, dati);
      expect(r.statusCode, r.body).toBe(400);
      return r.json<{ errore: string }>().errore;
    };
    expect(await problem('suggeritore', { struttura: 'Ospedale di prova' })).toBe(
      'Nome del medico: campo obbligatorio',
    );
    expect(await problem('contatto', { nome: 'Farmacia di prova', tipo: 'farmacia' })).toBe(
      'Tipo di contatto: struttura, specialista, laboratorio o altro',
    );
    expect(await problem('contatto', { nome: 'Altro', tipo: 'altro', email: 'nessuna' })).toBe(
      'Email: indirizzo non valido',
    );
    expect(await problem('posologia', { testo: '2 gocce', colore: 'blu' })).toBe(
      'Campi non previsti: colore',
    );
    expect(await problem('farmaco', { nome: 'Farmaco di prova' })).toBe(
      'Tipo di elenco: suggeritore, posologia, pacchetto o contatto',
    );

    // La stessa voce due volte no: maiuscole e spazi non contano.
    const twice = await create('posologia', {
      testo: '1 COMPRESSA una volta al giorno,  la sera, per bocca',
    });
    expect(twice.statusCode).toBe(409);
    expect(twice.json<{ errore: string }>().errore).toMatch(/c’è già la posologia/);

    const all = await list();
    expect(all.puoModificare).toBe(true);
    expect(all.voci.map((v) => v.tipo)).toEqual(['suggeritore', 'posologia', 'contatto']);
    expect((await list('?tipo=posologia')).voci.map((v) => v.id)).toEqual([ids.posologia]);
    expect(
      (await req(cookies.titolare!, 'GET', '/api/studio/elenchi?tipo=farmaco')).statusCode,
    ).toBe(400);
  });

  it('un pacchetto si compone dal catalogo: senza catalogo non si crea, con almeno una prestazione', async () => {
    const pkg = {
      nome: 'Controllo di prova',
      prestazioni: [
        { codice: '89.7', descrizione: 'Visita di prova' },
        { codice: 'prova.03', descrizione: 'Descrizione scritta a mano' },
      ],
    };
    const none = await create('pacchetto', pkg);
    expect(none.statusCode).toBe(409);
    expect(none.json<{ errore: string }>().errore).toMatch(/Nessun catalogo delle prestazioni/);
    expect((await list('?tipo=pacchetto')).catalogo).toBe(false);

    await insertCatalog('2000-01-01', [
      ['89.7', '89.7', 'VISITA DI PROVA'],
      ['PROVA.02', null, 'ESAME DI PROVA'],
      ['PROVA.03', 'PROVA.03', 'ALTRO ESAME DI PROVA'],
    ]);
    const empty = await create('pacchetto', { nome: 'Vuoto', prestazioni: [] });
    expect(empty.statusCode).toBe(400);
    expect(empty.json<{ errore: string }>().errore).toBe('Un pacchetto ha almeno una prestazione');

    const invented = await create('pacchetto', {
      nome: 'Inventato',
      prestazioni: [
        { codice: '89.7', descrizione: 'Visita di prova' },
        { codice: '99.99.9', descrizione: 'Prestazione inventata' },
      ],
    });
    expect(invented.statusCode).toBe(400);
    const body = invented.json<{ errore: string; dettagli: { codici: string[] } }>();
    expect(body.errore).toMatch(
      /^Non è nel catalogo delle prestazioni in vigore il .*: 99\.99\.9\./,
    );
    expect(body.dettagli.codici).toEqual(['99.99.9']);

    const ok = await create('pacchetto', pkg);
    expect(ok.statusCode, ok.body).toBe(201);
    ids.pacchetto = ok.json<Item>().id;
    // Codice e descrizione dal catalogo, non da chi scrive.
    expect(ok.json<Item>().dati.prestazioni).toEqual([
      { codice: '89.7', descrizione: 'VISITA DI PROVA' },
      { codice: 'PROVA.03', descrizione: 'ALTRO ESAME DI PROVA' },
    ]);
    const lists = await list('?tipo=pacchetto');
    expect(lists.catalogo).toBe(true);
    expect(lists.voci[0]!.catalogo!.prestazioni.map((s) => s.voce?.nationalCode)).toEqual([
      '89.7',
      'PROVA.03',
    ]);
  });

  it('il catalogo cambia: la prestazione uscita si segnala e non torna, il pacchetto si corregge', async () => {
    // Nuova versione: PROVA.03 esce, entra PROVA.04.
    await insertCatalog('2000-06-01', [
      ['89.7', '89.7', 'VISITA DI PROVA'],
      ['PROVA.02', null, 'ESAME DI PROVA'],
      ['PROVA.04', 'PROVA.04', 'ESAME NUOVO DI PROVA'],
    ]);
    const today = (await list('?tipo=pacchetto')).voci[0]!.catalogo!.prestazioni;
    expect(today.map((s) => [s.codice, s.voce?.regionalCode ?? null])).toEqual([
      ['89.7', '89.7'],
      ['PROVA.03', null],
    ]);
    // Alla data di prima, il catalogo di prima (A5).
    const before = (await list('?tipo=pacchetto&data=2000-03-01')).voci[0]!.catalogo!.prestazioni;
    expect(before.every((s) => s.voce !== null)).toBe(true);

    // Si rinomina e si aggiunge una prestazione in vigore; quella uscita resta finché non si toglie.
    const renamed = await patch(ids.pacchetto!, {
      nome: 'Controllo di prova, nuovo nome',
      prestazioni: [
        { codice: '89.7', descrizione: 'x' },
        { codice: 'PROVA.03', descrizione: 'x' },
        { codice: 'PROVA.04', descrizione: 'x' },
      ],
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json<Item>().dati.prestazioni).toEqual([
      { codice: '89.7', descrizione: 'VISITA DI PROVA' },
      { codice: 'PROVA.03', descrizione: 'ALTRO ESAME DI PROVA' },
      { codice: 'PROVA.04', descrizione: 'ESAME NUOVO DI PROVA' },
    ]);
    const removed = await patch(ids.pacchetto!, {
      prestazioni: [
        { codice: '89.7', descrizione: 'VISITA DI PROVA' },
        { codice: 'PROVA.04', descrizione: 'ESAME NUOVO DI PROVA' },
      ],
    });
    expect(removed.statusCode, removed.body).toBe(200);
    // Tolta, non si rimette: oggi non è nel catalogo in vigore.
    const back = await patch(ids.pacchetto!, {
      prestazioni: [
        { codice: '89.7', descrizione: 'VISITA DI PROVA' },
        { codice: 'PROVA.03', descrizione: 'ALTRO ESAME DI PROVA' },
      ],
    });
    expect(back.statusCode).toBe(400);
    expect(back.json<{ dettagli: { codici: string[] } }>().dettagli.codici).toEqual(['PROVA.03']);
    expect(
      (await patch(ids.pacchetto!, { prestazioni: [] })).json<{ errore: string }>().errore,
    ).toBe('Un pacchetto ha almeno una prestazione');
  });

  it('si modificano i campi indicati; senza cambiamenti non si scrive nulla', async () => {
    const r = await patch(ids.suggeritore!, { telefono: '000 0000012' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<Item>().dati).toMatchObject({
      nome: 'Dott.ssa Anna Prova',
      struttura: 'Ospedale di prova',
      telefono: '000 0000012',
    });
    const logged = (await adminLog()).length;
    const same = await patch(ids.suggeritore!, { telefono: ' 000 0000012 ' });
    expect(same.statusCode).toBe(200);
    expect((await adminLog()).length).toBe(logged);
    // Il tipo non cambia e i campi sconosciuti non entrano.
    expect((await patch(ids.suggeritore!, { tipo: 'contatto' })).statusCode).toBe(400);
    expect(
      (
        await req(cookies.titolare!, 'PATCH', `/api/studio/elenchi/${ids.suggeritore}`, {
          tipo: 'contatto',
          dati: {},
        })
      ).statusCode,
    ).toBe(400);
    expect((await patch('non-un-id', { telefono: '1' })).statusCode).toBe(404);
    // La segreteria non modifica e non archivia.
    expect((await patch(ids.suggeritore!, { telefono: '1' }, cookies.segreteria)).statusCode).toBe(
      403,
    );
    expect((await archive(ids.suggeritore!, cookies.segreteria)).statusCode).toBe(403);
  });

  it('una voce non si cancella: si archivia, e non si modifica più', async () => {
    const r = await archive(ids.suggeritore!);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json<Item>().archiviataIl).not.toBeNull();
    const after = await list('?tipo=suggeritore');
    expect(after.voci).toEqual([]);
    expect(after.archiviate.map((v) => v.id)).toEqual([ids.suggeritore]);
    expect((await archive(ids.suggeritore!)).statusCode).toBe(409);
    const changed = await patch(ids.suggeritore!, { telefono: '000 0000013' });
    expect(changed.statusCode).toBe(409);
    expect(changed.json<{ errore: string }>().errore).toBe(
      'La voce è archiviata: non si modifica più',
    );
    await rejectsWith(
      t.db.delete(studioListItem).where(eq(studioListItem.id, ids.suggeritore!)),
      /Una voce degli elenchi non si cancella: si archivia/,
    );
    // Archiviata, la stessa voce si può scrivere di nuovo.
    const again = await create('suggeritore', {
      nome: 'Dott.ssa Anna Prova',
      struttura: 'Ospedale di prova',
    });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('elenchi separati per studio', async () => {
    const other = await list('', cookies.altroStudio, b);
    expect(other.voci).toEqual([]);
    expect(other.archiviate).toEqual([]);
    expect(
      (await patch(ids.posologia!, { testo: 'Cambiata da fuori' }, cookies.altroStudio, b))
        .statusCode,
    ).toBe(404);
    expect((await archive(ids.posologia!, cookies.altroStudio, b)).statusCode).toBe(404);
    // Lo stesso testo in un altro studio non è un doppione.
    const same = await create(
      'posologia',
      { testo: '1 compressa una volta al giorno, la sera, per bocca' },
      cookies.altroStudio,
      b,
    );
    expect(same.statusCode, same.body).toBe(201);
    expect((await list('?tipo=posologia')).voci.map((v) => v.id)).toEqual([ids.posologia]);
  });

  it('il registro: chi, che cosa, su quale voce e quali campi; lo storico sa chi è stato', async () => {
    const rows = (await adminLog()).filter((r) => r.outcome === 'riuscito');
    expect(rows.every((r) => r.details.area === 'elenchi')).toBe(true);
    expect(rows.map((r) => `${r.details.tipo as string}:${r.details.azione as string}`)).toEqual([
      'suggeritore:creazione',
      'posologia:creazione',
      'contatto:creazione',
      'pacchetto:creazione',
      'pacchetto:modifica',
      'pacchetto:modifica',
      'suggeritore:modifica',
      'suggeritore:archiviazione',
      'suggeritore:creazione',
    ]);
    const edit = rows.find(
      (r) => r.details.tipo === 'suggeritore' && r.details.azione === 'modifica',
    )!;
    expect(edit.details).toMatchObject({
      voce: { id: ids.suggeritore, etichetta: 'Dott.ssa Anna Prova' },
      campi: ['telefono'],
      prima: { telefono: '000 0000010' },
      dopo: { telefono: '000 0000012' },
    });
    expect(rows.find((r) => r.details.tipo === 'contatto')!.userId).toBe(a.users.amministratore.id);
    expect(JSON.stringify(rows.map((r) => r.details))).not.toMatch(/password|segreto|hash/i);
    const history = await t.db
      .select()
      .from(changeHistory)
      .where(
        and(
          eq(changeHistory.tableName, 'studio_list_item'),
          eq(changeHistory.rowId, ids.suggeritore!),
        ),
      );
    expect(history.map((h) => [h.operation, h.userId])).toEqual([
      ['INSERT', a.users.titolare.id],
      ['UPDATE', a.users.titolare.id],
      ['UPDATE', a.users.titolare.id],
    ]);
    // Nessuna riga per lo studio B nel registro dello studio A, e viceversa.
    expect((await adminLog(b.studioId)).every((r) => r.userId === b.users.titolare.id)).toBe(true);
    expect(
      (
        await t.db.execute<{ n: number }>(
          sql`select count(*)::int as n from studio_list_item where studio_id = ${b.studioId}`,
        )
      ).rows[0]!.n,
    ).toBe(1);
  });
});
