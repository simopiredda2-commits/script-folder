import { randomUUID } from 'node:crypto';
import { DEFAULT_PRINT_LAYOUT } from '@mmg/domain';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog, changeHistory, printSetting, studio, workstation } from '../src/db/schema';
import { base32Decode } from '../src/security/base32';
import { totp } from '../src/security/totp';
import { renderTemplatePdf } from '../src/templates/pdf';
import { pdfText } from './helpers/pdf-text';
import { createScenario, PASSWORD, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

type Who = keyof Scenario['users'];

/** Accesso completo da una postazione con il nome dato, come lo scrive chi accede. */
async function loginAt(s: Scenario, who: Who, postazione: string): Promise<string> {
  const user = s.users[who];
  const res = await s.app.inject({
    method: 'POST',
    url: '/api/accesso',
    payload: { username: user.username, password: PASSWORD, postazione },
  });
  if (res.statusCode !== 200) throw new Error(`Accesso di ${who} fallito: ${res.body}`);
  const body = res.json<{ passaggio: string; segreto?: string }>();
  if (body.segreto) s.secrets.set(user.id, base32Decode(body.segreto));
  s.clock.advance(30_000);
  const done = await s.app.inject({
    method: 'POST',
    url: '/api/accesso/codice',
    payload: {
      passaggio: body.passaggio,
      codice: totp(s.secrets.get(user.id)!, s.clock.now().getTime()),
    },
  });
  const cookie = done.cookies.find((c) => c.name === 'sessione');
  if (done.statusCode !== 200 || !cookie)
    throw new Error(`Secondo fattore di ${who}: ${done.body}`);
  return `sessione=${cookie.value}`;
}

/** Larghezza e altezza delle pagine di un PDF, in punti. */
async function pageSizes(bytes: Uint8Array): Promise<[number, number][]> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const doc = await task.promise;
  const out: [number, number][] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const [, , w, h] = (await doc.getPage(i)).view as [number, number, number, number];
    out.push([Math.round(w * 100) / 100, Math.round(h * 100) / 100]);
  }
  await task.destroy();
  return out;
}
const A4 = [595.28, 841.89];
const A5 = [419.53, 595.28];

interface Effective {
  tipo: string;
  stampante: string | null;
  copie: number;
  carta: string | null;
  cartaScelta: boolean;
  variante: string | null;
  da: Record<'stampante' | 'copie' | 'carta' | 'variante', string>;
  suggerimento: string | null;
}
interface Preferences {
  postazione: { scritta: string; riconosciuta: { id: string; nome: string } | null };
  preferenze: Effective[];
}
interface Values {
  stampante: string | null;
  carta: string | null;
  copie: number | null;
  variante: string | null;
}
interface Settings {
  tipi: { codice: string; carte: string[]; variante: boolean }[];
  studio: Record<string, Values>;
  postazioni: { id: string; nome: string; preferenze: Record<string, Values> }[];
  puoModificare: boolean;
}

/**
 * Preferenze di stampa (tappa 14): chi le legge e chi le cambia, carta solo dove è ammessa,
 * variante solo per il promemoria, copie entro i limiti, ordine postazione > studio > predefinito,
 * postazione riconosciuta per nome senza maiuscole, registro e storico; i certificati dai modelli
 * in A5 quando è la carta della postazione. Studio, persone e stampanti inventati.
 */
describe('preferenze di stampa (tappa 14)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const ws: Record<'ambulatorio' | 'segreteria' | 'archiviata' | 'altroStudio', string> = {
    ambulatorio: '',
    segreteria: '',
    archiviata: '',
    altroStudio: '',
  };
  const c: Partial<Record<Who, string>> = {};

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    const rows = await t.db
      .insert(workstation)
      .values([
        { studioId: s.studioId, name: 'Ambulatorio 1', shared: true },
        { studioId: s.studioId, name: 'Segreteria', shared: true },
        { studioId: s.studioId, name: 'Vecchia', shared: true, archivedAt: new Date() },
      ])
      .returning();
    ws.ambulatorio = rows[0]!.id;
    ws.segreteria = rows[1]!.id;
    ws.archiviata = rows[2]!.id;
    const [other] = await t.db
      .insert(studio)
      .values({ name: 'Altro studio di prova', kind: 'single', regionName: 'PIEMONTE' })
      .returning();
    const [foreign] = await t.db
      .insert(workstation)
      // Lo stesso nome della postazione «fuori elenco» delle prove: non deve valere qui.
      .values({ studioId: other!.id, name: 'Portatile di casa', shared: true })
      .returning();
    ws.altroStudio = foreign!.id;
    for (const who of ['titolare', 'segreteria', 'sostituto', 'amministratore'] as const)
      c[who] = await loginAt(s, who, 'Ambulatorio 1');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (cookie: string, method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const preferences = async (cookie: string) => {
    const res = await req(cookie, 'GET', '/api/stampa/preferenze');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Preferences>();
  };
  const of = (p: Preferences, tipo: string) => p.preferenze.find((x) => x.tipo === tipo)!;
  const setting = (over: Record<string, unknown> = {}) => ({
    postazione: null,
    tipo: 'certificato_modello',
    stampante: null,
    carta: null,
    copie: null,
    variante: null,
    ...over,
  });
  const put = (body: object, cookie = c.amministratore!) =>
    req(cookie, 'PUT', '/api/stampa/impostazioni', body);
  const problems = (res: { json: <T>() => T }) =>
    res.json<{ dettagli: { problemi: string[] } }>().dettagli.problemi;
  const adminLog = () =>
    t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.studioId, s.studioId), eq(accessLog.action, 'amministrazione')))
      .orderBy(asc(accessLog.seq));

  it('ogni utente legge le preferenze della sua postazione: senza preferenze, le predefinite', async () => {
    for (const who of ['titolare', 'segreteria', 'sostituto', 'amministratore'] as const) {
      const p = await preferences(c[who]!);
      expect(p.postazione.riconosciuta?.nome, who).toBe('Ambulatorio 1');
      expect(p.preferenze.map((x) => x.tipo)).toEqual([
        'promemoria',
        'promemoria_bianca',
        'certificato_inps',
        'certificato_modello',
        'schema_orario',
        'profilo_sanitario',
      ]);
      for (const x of p.preferenze) {
        expect(Object.values(x.da), `${who} ${x.tipo}`).toEqual([
          'predefinito',
          'predefinito',
          'predefinito',
          'predefinito',
        ]);
        expect(x.suggerimento).toBeNull();
        expect(x.copie).toBe(1);
      }
      expect(of(p, 'promemoria')).toMatchObject({ carta: 'A5', variante: 'completo' });
      expect(of(p, 'certificato_modello')).toMatchObject({ carta: 'A4', cartaScelta: true });
      expect(of(p, 'promemoria_bianca')).toMatchObject({ carta: null, cartaScelta: false });
    }
    // Senza sessione niente.
    expect((await s.app.inject({ method: 'GET', url: '/api/stampa/preferenze' })).statusCode).toBe(
      401,
    );
  });

  it('tutte le preferenze le vede e le cambia solo l’amministratore; ogni rifiuto resta nel registro', async () => {
    for (const who of ['titolare', 'segreteria', 'sostituto'] as const) {
      const read = await req(c[who]!, 'GET', '/api/stampa/impostazioni');
      expect(read.statusCode, who).toBe(403);
      expect(read.json<{ errore: string }>().errore).toMatch(/amministratore/);
      const res = await put(setting({ stampante: 'Stampante di chi non può' }), c[who]);
      expect(res.statusCode, who).toBe(403);
      // Il permesso viene prima dei valori: chi non può cambiare non sa se andavano bene.
      expect((await put(setting({ copie: 99 }), c[who])).statusCode, who).toBe(403);
      expect((await put({ altro: 1 }, c[who])).statusCode, who).toBe(403);
    }
    const denied = (await adminLog()).filter((r) => r.outcome === 'negato');
    expect(denied.map((r) => (r.details as { azione: string }).azione)).toEqual(
      Array.from({ length: 3 }, () => ['lettura', 'modifica', 'modifica', 'modifica']).flat(),
    );
    expect(denied[0]).toMatchObject({
      userId: s.users.titolare.id,
      patientId: null,
      workstation: 'Ambulatorio 1',
      details: { area: 'stampa', permesso: 'admin.printers' },
    });
    expect(await t.db.select().from(printSetting)).toEqual([]);
    const admin = await req(c.amministratore!, 'GET', '/api/stampa/impostazioni');
    expect(admin.statusCode, admin.body).toBe(200);
    const v = admin.json<Settings>();
    expect(v.puoModificare).toBe(true);
    // Le postazioni attive dello studio: non l'archiviata, non quelle di un altro studio.
    expect(v.postazioni.map((p) => p.nome)).toEqual(['Ambulatorio 1', 'Segreteria']);
    expect(v.studio.promemoria).toMatchObject({
      stampante: null,
      carta: null,
      copie: null,
      variante: null,
    });
  });

  it('la carta si sceglie solo dove è ammessa, e solo A4 o A5', async () => {
    // Il promemoria: A5 per difetto, A4 a metà per le stampanti senza A5 (D222).
    expect((await put(setting({ tipo: 'promemoria', carta: 'A4' }))).statusCode).toBe(200);
    const notReminder = await put(setting({ tipo: 'promemoria', carta: 'A3' }));
    expect(problems(notReminder)).toEqual(['Carta: per «Promemoria della ricetta SSN» A5 o A4']);
    const fixed = await put(setting({ tipo: 'certificato_inps', carta: 'A5' }));
    expect(fixed.statusCode).toBe(400);
    expect(problems(fixed)).toEqual([
      'Carta: per «Certificato di malattia INPS» il formato è fissato (A4), non si sceglie',
    ]);
    for (const tipo of ['certificato_inps', 'profilo_sanitario', 'promemoria_bianca'])
      expect((await put(setting({ tipo, carta: 'A4' }))).statusCode, tipo).toBe(400);
    const wrong = await put(setting({ carta: 'A3' }));
    expect(wrong.statusCode).toBe(400);
    expect(problems(wrong)).toEqual(['Carta: per «Certificati dai modelli» A4 o A5']);
    expect((await put(setting({ tipo: 'schema_orario', carta: 'A5' }))).statusCode).toBe(200);
    expect((await put(setting({ tipo: 'schema_orario', carta: null }))).statusCode).toBe(200);
  });

  it('la variante solo per il promemoria della ricetta SSN, completo o solo NRE', async () => {
    for (const tipo of ['certificato_inps', 'promemoria_bianca', 'certificato_modello']) {
      const res = await put(setting({ tipo, variante: 'solo_nre' }));
      expect(res.statusCode, tipo).toBe(400);
      expect(problems(res)).toEqual([
        'Variante: solo per il promemoria della ricetta SSN (completo o solo NRE)',
      ]);
    }
    const unknown = await put(setting({ tipo: 'promemoria', variante: 'mezzo' }));
    expect(problems(unknown)).toEqual(['Variante del promemoria: completo oppure solo NRE']);
    const ok = await put(setting({ tipo: 'promemoria', variante: 'solo_nre' }));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<Settings>().studio.promemoria!.variante).toBe('solo_nre');
  });

  it('copie da 1 a 5; tipo, postazione e corpo controllati', async () => {
    for (const copie of [0, 6, 2.5, -1]) {
      const res = await put(setting({ copie }));
      expect(res.statusCode, String(copie)).toBe(400);
      expect(problems(res)).toEqual(['Copie: un numero intero da 1 a 5']);
    }
    expect((await put(setting({ copie: '2' }))).statusCode).toBe(400);
    expect(problems(await put(setting({ tipo: 'ricetta_rossa' })))).toEqual([
      'Tipo di documento: non previsto',
    ]);
    // La preferenza si manda intera: un valore che manca è un errore, non un «lascia com'è».
    const partial = Object.fromEntries(Object.entries(setting()).filter(([k]) => k !== 'copie'));
    expect(problems(await put(partial))).toEqual(['Copie: manca']);
    expect((await put({ ...setting(), altro: 1 })).statusCode).toBe(400);
    expect((await put(setting({ postazione: randomUUID() }))).statusCode).toBe(404);
    expect((await put(setting({ postazione: ws.altroStudio }))).statusCode).toBe(404);
    const archived = await put(setting({ postazione: ws.archiviata, copie: 2 }));
    expect(archived.statusCode).toBe(409);
    expect(archived.json<{ errore: string }>().errore).toMatch(/archiviata/);
    expect((await put(setting({ copie: 5 }))).statusCode).toBe(200);
  });

  it('ordine postazione > studio > predefinito, campo per campo', async () => {
    // Studio: stampante e due copie per i certificati dai modelli.
    expect(
      (await put(setting({ stampante: 'Stampante della segreteria', copie: 2, carta: null })))
        .statusCode,
    ).toBe(200);
    // La postazione dell'ambulatorio: la sua stampante e la carta A5, le copie come lo studio.
    const own = await put(
      setting({
        postazione: ws.ambulatorio,
        stampante: '  Stampante dell’ambulatorio ',
        carta: 'A5',
      }),
    );
    expect(own.statusCode, own.body).toBe(200);
    const saved = own.json<Settings>().postazioni.find((p) => p.id === ws.ambulatorio)!;
    expect(saved.preferenze.certificato_modello).toMatchObject({
      stampante: 'Stampante dell’ambulatorio',
      carta: 'A5',
      copie: null,
    });

    const atDesk = of(await preferences(c.titolare!), 'certificato_modello');
    expect(atDesk).toMatchObject({
      stampante: 'Stampante dell’ambulatorio',
      carta: 'A5',
      copie: 2,
      da: {
        stampante: 'postazione',
        carta: 'postazione',
        copie: 'studio',
        variante: 'predefinito',
      },
      suggerimento: 'Stampante consigliata: Stampante dell’ambulatorio, 2 copie, carta A5',
    });
    // Dalla segreteria (senza preferenze proprie) valgono quelle dello studio.
    const front = await loginAt(s, 'sostituto', 'Segreteria');
    expect(of(await preferences(front), 'certificato_modello')).toMatchObject({
      stampante: 'Stampante della segreteria',
      carta: 'A4',
      copie: 2,
      da: { stampante: 'studio', carta: 'predefinito', copie: 'studio' },
    });
    // Una postazione che non è nell'elenco: lo studio, poi le predefinite.
    const home = await loginAt(s, 'sostituto', 'Portatile di casa');
    const p = await preferences(home);
    expect(p.postazione).toEqual({ scritta: 'Portatile di casa', riconosciuta: null });
    expect(of(p, 'certificato_modello').stampante).toBe('Stampante della segreteria');
    expect(of(p, 'certificato_inps').da.copie).toBe('predefinito');
    // Il promemoria: la variante dello studio (solo NRE) vale anche alla postazione.
    expect(of(p, 'promemoria')).toMatchObject({ variante: 'solo_nre', da: { variante: 'studio' } });
  });

  it('la postazione si riconosce per nome, senza maiuscole e senza spazi ai lati; mai un’archiviata', async () => {
    const shouting = await loginAt(s, 'titolare', '  AMBULATORIO 1 ');
    const p = await preferences(shouting);
    expect(p.postazione.riconosciuta).toEqual({ id: ws.ambulatorio, nome: 'Ambulatorio 1' });
    expect(of(p, 'certificato_modello').da.carta).toBe('postazione');
    const old = await loginAt(s, 'titolare', 'vecchia');
    expect((await preferences(old)).postazione.riconosciuta).toBeNull();
  });

  it('ogni cambio nel registro con i campi, prima e dopo; niente se non cambia nulla; lo storico sa chi', async () => {
    const before = (await adminLog()).length;
    const res = await put(
      setting({
        postazione: ws.segreteria,
        tipo: 'promemoria',
        stampante: 'Stampante della segreteria',
        copie: 1,
        variante: 'completo',
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const log = await adminLog();
    expect(log).toHaveLength(before + 1);
    expect(log.at(-1)).toMatchObject({
      userId: s.users.amministratore.id,
      outcome: 'riuscito',
      patientId: null,
      details: {
        area: 'stampa',
        azione: 'modifica',
        documento: 'promemoria',
        postazione: { id: ws.segreteria, nome: 'Segreteria' },
        campi: ['stampante', 'copie', 'variante'],
        prima: { stampante: null, copie: null, variante: null },
        dopo: { stampante: 'Stampante della segreteria', copie: 1, variante: 'completo' },
      },
    });
    // Lo stesso salvataggio una seconda volta non scrive niente.
    const again = await put(
      setting({
        postazione: ws.segreteria,
        tipo: 'promemoria',
        stampante: 'Stampante della segreteria',
        copie: 1,
        variante: 'completo',
      }),
    );
    expect(again.statusCode).toBe(200);
    expect(await adminLog()).toHaveLength(before + 1);
    const [row] = await t.db
      .select()
      .from(printSetting)
      .where(
        and(
          eq(printSetting.workstationId, ws.segreteria),
          eq(printSetting.documentKind, 'promemoria'),
        ),
      );
    const history = await t.db
      .select()
      .from(changeHistory)
      .where(and(eq(changeHistory.tableName, 'print_setting'), eq(changeHistory.rowId, row!.id)));
    expect(history.map((h) => [h.operation, h.userId])).toEqual([
      ['INSERT', s.users.amministratore.id],
    ]);
    expect(row!.updatedBy).toBe(s.users.amministratore.id);
  });

  it('una postazione torna come lo studio togliendo i suoi valori: la riga resta, con lo storico', async () => {
    const res = await put(setting({ postazione: ws.segreteria, tipo: 'promemoria' }));
    expect(res.statusCode, res.body).toBe(200);
    const front = await loginAt(s, 'segreteria', 'Segreteria');
    expect(of(await preferences(front), 'promemoria')).toMatchObject({
      stampante: null,
      variante: 'solo_nre',
      da: { stampante: 'predefinito', copie: 'predefinito', variante: 'studio' },
    });
    const rows = await t.db
      .select()
      .from(printSetting)
      .where(
        and(
          eq(printSetting.workstationId, ws.segreteria),
          eq(printSetting.documentKind, 'promemoria'),
        ),
      );
    expect(rows).toHaveLength(1);
    const history = await t.db
      .select()
      .from(changeHistory)
      .where(
        and(eq(changeHistory.tableName, 'print_setting'), eq(changeHistory.rowId, rows[0]!.id)),
      );
    expect(history.map((h) => h.operation)).toEqual(['INSERT', 'UPDATE']);
  });

  it('certificati dai modelli: in A5 dalla postazione con la carta A5, in A4 dalle altre, stesso testo', async () => {
    const body = {
      titolo: 'Certificato di prova per la stampa',
      testo: ['Si certifica che {{paziente.cognome}} {{paziente.nome}}: {{campo.testo}}'],
    };
    const created = await req(c.titolare!, 'POST', '/api/modelli/studio', body);
    expect(created.statusCode, created.body).toBe(201);
    const base = `/api/pazienti/${s.richPatient}/certificati-modelli`;
    const values = {
      modello: created.json<{ chiave: string }>().chiave,
      valori: { testo: 'testo di prova per la carta.' },
      luogo: 'Comune di prova',
    };
    // All'ambulatorio la carta è A5 (preferenza della postazione).
    const preview = await req(c.titolare!, 'POST', `${base}/anteprima`, values);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(await pageSizes(new Uint8Array(preview.rawPayload))).toEqual([A5]);
    const issued = await req(c.titolare!, 'POST', base, values);
    expect(issued.statusCode, issued.body).toBe(201);
    const id = issued.json<{ id: string }>().id;
    const small = new Uint8Array((await req(c.titolare!, 'GET', `${base}/${id}/pdf`)).rawPayload);
    expect((await pageSizes(small)).every(([w, h]) => w === A5[0] && h === A5[1])).toBe(true);
    // Dalla segreteria, dove vale lo studio (nessuna carta), lo stesso certificato esce in A4.
    const front = await loginAt(s, 'sostituto', 'Segreteria');
    const big = new Uint8Array((await req(front, 'GET', `${base}/${id}/pdf`)).rawPayload);
    expect(await pageSizes(big)).toEqual([A4]);
    const words = (b: Uint8Array) => pdfText(b).then((x) => x.replace(/\s+/g, ' '));
    for (const text of [await words(small), await words(big)])
      expect(text).toContain('testo di prova per la carta.');
    // Anche la prova di impaginazione del medico.
    const layoutPreview = await req(c.titolare!, 'POST', '/api/profilo/impaginazione/anteprima', {
      carattere: 'sans',
      dimensione: 11,
      intestazione: [],
      allineamento: 'left',
      margini: 20,
      luogo: 'Comune di prova',
      timbro: '',
    });
    expect(await pageSizes(new Uint8Array(layoutPreview.rawPayload))).toEqual([A5]);
  });

  it('in A5 la dichiarazione finale resta sulla pagina di luogo, data e firme', async () => {
    for (let k = 4; k <= 30; k++) {
      const bytes = await renderTemplatePdf({
        title: 'Certificato di prova',
        paragraphs: [
          ...Array.from({ length: k }, (_, i) => `Riga di riempimento numero ${i + 1}.`),
          'Dichiarazione finale del dichiarante.',
        ],
        signature: 'In fede, il medico',
        layout: { ...DEFAULT_PRINT_LAYOUT },
        createdAt: new Date(0),
        parts: {
          reference: 'Riferimento di prova',
          notes: [],
          placeDate: 'Luogo e data: Comune di prova, 18/11/2026',
          otherSignatures: ['In fede, il dichiarante'],
        },
        paper: 'A5',
      });
      expect((await pageSizes(bytes)).every(([w, h]) => w === A5[0] && h === A5[1])).toBe(true);
      const signed = (await pdfText(bytes))
        .split('\n')
        .find((p) => p.includes('In fede, il medico'))!;
      expect(signed, `${k} righe`).toContain('Dichiarazione finale del dichiarante.');
      expect(signed, `${k} righe`).toContain('Luogo e data: Comune di prova, 18/11/2026');
    }
  });

  it('in A5 un paragrafo più lungo di una pagina A5 comincia subito, senza lasciare la pagina vuota', async () => {
    // 35 righe: più di una pagina A5 (circa 30 righe a 11 punti), meno di una pagina A4.
    const long = Array.from({ length: 35 }, (_, i) => `Riga lunga ${i + 1}.`).join('\n');
    const bytes = await renderTemplatePdf({
      title: 'Certificato di prova',
      paragraphs: ['Primo paragrafo breve.', long, 'Dichiarazione finale del dichiarante.'],
      signature: 'In fede, il medico',
      layout: { ...DEFAULT_PRINT_LAYOUT },
      createdAt: new Date(0),
      paper: 'A5',
    });
    const pages = (await pdfText(bytes)).split('\n');
    expect(pages[0]).toContain('Primo paragrafo breve.');
    expect(pages[0]).toContain('Riga lunga 1.');
    expect(pages.join(' ')).toContain('Riga lunga 35.');
  });

  it('salvare le preferenze dello studio non va in stallo con il registro di un accesso sbagliato (terza revisione)', async () => {
    const saved0 = await put(setting({ tipo: 'schema_orario', stampante: 'Stampante di prima' }));
    expect(saved0.statusCode, saved0.body).toBe(200);
    const [row] = await t.db
      .select({ id: printSetting.id })
      .from(printSetting)
      .where(
        and(
          eq(printSetting.studioId, s.studioId),
          isNull(printSetting.workstationId),
          eq(printSetting.documentKind, 'schema_orario'),
        ),
      );
    const waiters = async () =>
      (
        await t.pool.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        )
      ).rows[0]!.n;
    const pause = () => new Promise((r) => setTimeout(r, 25));
    const holder = await t.pool.connect();
    let saved: Awaited<ReturnType<typeof put>>;
    let failed: Awaited<ReturnType<typeof put>>;
    try {
      await holder.query('begin');
      await holder.query('select id from print_setting where id = $1 for update', [row!.id]);
      // Il salvataggio blocca lo studio e aspetta la riga della preferenza, tenuta dalla prova.
      const saving = put(setting({ tipo: 'schema_orario', stampante: 'Stampante di dopo' }));
      for (let i = 0; i < 400 && (await waiters()) < 1; i++) await pause();
      // Un accesso sbagliato di un utente dello studio scrive la sua riga del registro, che punta
      // allo studio: con lo studio bloccato FOR UPDATE resterebbe fermo, con la catena in mano.
      const failing = s.app.inject({
        method: 'POST',
        url: '/api/accesso',
        payload: {
          username: s.users.segreteria.username,
          password: 'una password sbagliata di prova',
          postazione: 'postazione di prova',
        },
      });
      let done = false;
      void failing.then(() => (done = true));
      for (let i = 0; i < 40 && !done && (await waiters()) < 2; i++) await pause();
      await holder.query('commit');
      [saved, failed] = await Promise.all([saving, failing]);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect(saved.statusCode, saved.body).toBe(200);
    expect(failed.statusCode, failed.body).toBe(401);
  });
});
