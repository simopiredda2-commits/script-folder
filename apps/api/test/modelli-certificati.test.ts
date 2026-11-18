import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { patient, templateCertificate } from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { loadOfficialTemplates, officialTemplates } from '../src/templates/catalog';
import { validityEnd } from '../src/templates/service';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { pdfText } from './helpers/pdf-text';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** Un modello di prova nel formato dei file ufficiali: testo inventato, non quello di un atto. */
const sampleOfficial = (over: Record<string, unknown> = {}) => ({
  key: 'prova-ufficiale',
  title: 'Certificato di prova',
  version: '2026-11-18',
  official: true,
  source: {
    act: 'Atto di prova, allegato A',
    url: 'https://www.esempio.invalid/atto',
    checkedOn: '2026-11-18',
  },
  validityMonths: 12,
  forDoctor: [],
  fields: [{ key: 'esito', label: 'Esito', type: 'testo', required: true }],
  body: ['{{paziente.cognome}} {{paziente.nome}}: {{campo.esito}}.'],
  signature: 'Timbro e firma del medico',
  ...over,
});

/** I caratteri usati in un PDF (nomi dei caratteri standard). */
async function fontsOf(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out = new Set<string>();
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    for (const [, ref] of fonts?.entries() ?? []) {
      const dict = doc.context.lookup(ref, PDFDict);
      out.add(String(dict.get(PDFName.of('BaseFont'))).replace('/', ''));
    }
  }
  return [...out].sort();
}

describe('modelli dei certificati (tappa 13)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let secretary: string;
  let studioKey: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    secretary = await login(s, 'segreteria');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, cookie = doctor) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const base = () => `/api/pazienti/${s.richPatient}/certificati-modelli`;
  const layout = {
    carattere: 'serif',
    dimensione: 12,
    intestazione: ['Dott.ssa Medica Inventata', 'Medicina generale – Via di prova 1'],
    allineamento: 'center',
    margini: 25,
    luogo: 'Comune di prova',
    timbro: 'Timbro di prova',
  };

  it('i modelli ufficiali: ogni file controllato, con la fonte; un file sbagliato ferma la lettura', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmg-modelli-'));
    try {
      writeFileSync(join(dir, 'prova-ufficiale.json'), JSON.stringify(sampleOfficial()));
      expect(loadOfficialTemplates(dir).map((x) => [x.key, x.source?.act])).toEqual([
        ['prova-ufficiale', 'Atto di prova, allegato A'],
      ]);
      writeFileSync(
        join(dir, 'prova-ufficiale.json'),
        JSON.stringify(sampleOfficial({ body: ['{{paziente.segreto}} {{campo.esito}}'] })),
      );
      expect(() => loadOfficialTemplates(dir)).toThrow(
        /prova-ufficiale\.json: Segnaposto sconosciuto: \{\{paziente\.segreto\}\}/,
      );
      writeFileSync(
        join(dir, 'prova-ufficiale.json'),
        JSON.stringify(sampleOfficial({ source: undefined })),
      );
      expect(() => loadOfficialTemplates(dir)).toThrow(/prova-ufficiale\.json/);
      rmSync(join(dir, 'prova-ufficiale.json'));
      writeFileSync(join(dir, 'altro-nome.json'), JSON.stringify(sampleOfficial()));
      expect(() => loadOfficialTemplates(dir)).toThrow(/deve chiamarsi prova-ufficiale\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // I modelli del programma si leggono tutti, e ognuno ha la sua fonte.
    for (const m of officialTemplates()) expect(m.source?.url, m.key).toMatch(/^https:\/\//);
  });

  it('modelli dello studio: li scrivono i medici e l’amministratore, non la segreteria; segnaposto controllati', async () => {
    const body = {
      titolo: 'Certificato di prova dello studio',
      testo: [
        'Si certifica che {{paziente.cognome}} {{paziente.nome}}, nato/a il {{paziente.nato_il}}, codice fiscale {{paziente.codice_fiscale}}: {{campo.testo}}',
        '{{rilascio.luogo}}, {{rilascio.data}}',
      ],
    };
    expect((await req('POST', '/api/modelli/studio', body, secretary)).statusCode).toBe(403);
    const wrong = await req('POST', '/api/modelli/studio', {
      ...body,
      testo: ['{{paziente.indirizzo_segreto}}'],
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ dettagli: { problemi: string[] } }>().dettagli.problemi).toEqual([
      'Segnaposto sconosciuto: {{paziente.indirizzo_segreto}}',
    ]);
    const created = await req('POST', '/api/modelli/studio', body);
    expect(created.statusCode, created.body).toBe(201);
    studioKey = created.json<{ chiave: string }>().chiave;
    expect(studioKey).toMatch(/^studio:/);
    const admin = await login(s, 'amministratore');
    const renamed = await req(
      'PUT',
      `/api/modelli/studio/${studioKey.slice('studio:'.length)}`,
      { ...body, titolo: 'Certificato di prova dello studio, rivisto' },
      admin,
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    const catalog = (await req('GET', '/api/modelli')).json<{
      studio: { chiave: string; titolo: string; campi: { key: string }[] }[];
      puoGestire: boolean;
    }>();
    expect(catalog.puoGestire).toBe(true);
    expect(catalog.studio).toMatchObject([
      {
        chiave: studioKey,
        titolo: 'Certificato di prova dello studio, rivisto',
        campi: [{ key: 'testo' }],
      },
    ]);
    // Un modello archiviato non si usa più, ma resta (con lo storico).
    const spare = await req('POST', '/api/modelli/studio', { ...body, titolo: 'Da archiviare' });
    const spareId = spare.json<{ id: string }>().id;
    expect((await req('POST', `/api/modelli/studio/${spareId}/archivia`)).statusCode).toBe(204);
    expect(
      (await req('GET', '/api/modelli'))
        .json<{ studio: { id: string }[] }>()
        .studio.map((x) => x.id),
    ).not.toContain(spareId);
    const issued = await req('POST', base(), {
      modello: `studio:${spareId}`,
      valori: { testo: 'x' },
      luogo: 'Comune di prova',
    });
    expect(issued.statusCode).toBe(404);
  });

  it('impaginazione del medico: carattere, dimensione, intestazione, margini; prova di stampa', async () => {
    expect((await req('GET', '/api/profilo/impaginazione', undefined, secretary)).statusCode).toBe(
      403,
    );
    const wrong = await req('PUT', '/api/profilo/impaginazione', { ...layout, dimensione: 30 });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ dettagli: { problemi: string[] } }>().dettagli.problemi).toEqual([
      'Dimensione del testo: da 9 a 14 punti',
    ]);
    const saved = await req('PUT', '/api/profilo/impaginazione', layout);
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await req('GET', '/api/profilo/impaginazione')).json()).toEqual(layout);
    const preview = await req('POST', '/api/profilo/impaginazione/anteprima', {
      ...layout,
      carattere: 'mono',
    });
    expect(preview.headers['content-type']).toBe('application/pdf');
    const bytes = new Uint8Array(preview.rawPayload);
    expect(await fontsOf(bytes)).toEqual(['Courier', 'Courier-Bold']);
    expect(await pdfText(bytes)).toContain('Dott.ssa Medica Inventata');
  });

  it('rilascio: dati del paziente dalla cartella, campi del modello, PDF con l’impaginazione del medico', async () => {
    const [p] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
    const values = {
      modello: studioKey,
      valori: { testo: 'testo scritto dal medico.' },
      luogo: 'Comune di prova',
    };
    const preview = await req('POST', `${base()}/anteprima`, values);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(await pdfText(new Uint8Array(preview.rawPayload))).toContain(p!.fiscalCode);
    // L'anteprima non rilascia niente.
    expect((await req('GET', base())).json<{ certificati: unknown[] }>().certificati).toEqual([]);
    const issued = await req('POST', base(), values);
    expect(issued.statusCode, issued.body).toBe(201);
    const c = issued.json<{ id: string; titolo: string; campi: { value: string }[] }>();
    expect(c.titolo).toBe('Certificato di prova dello studio, rivisto');
    expect(c.campi).toEqual([{ key: 'testo', label: 'Testo', value: 'testo scritto dal medico.' }]);
    const pdf = await req('GET', `${base()}/${c.id}/pdf`);
    const bytes = new Uint8Array(pdf.rawPayload);
    const text = await pdfText(bytes);
    const birth = `${p!.birthDate.slice(8, 10)}/${p!.birthDate.slice(5, 7)}/${p!.birthDate.slice(0, 4)}`;
    expect(text).toContain(`${p!.lastName} ${p!.firstName}`);
    expect(text).toContain(birth);
    expect(text).toContain('testo scritto dal medico.');
    expect(text).toContain('Timbro di prova');
    expect(await fontsOf(bytes)).toEqual(['Times-Bold', 'Times-Roman']);
    // Lo stesso certificato dà lo stesso file.
    expect(Buffer.from((await req('GET', `${base()}/${c.id}/pdf`)).rawPayload)).toEqual(
      Buffer.from(bytes),
    );
    // L'impaginazione nuova non cambia il certificato già rilasciato.
    await req('PUT', '/api/profilo/impaginazione', { ...layout, carattere: 'sans' });
    expect(
      await fontsOf(new Uint8Array((await req('GET', `${base()}/${c.id}/pdf`)).rawPayload)),
    ).toEqual(['Times-Bold', 'Times-Roman']);
  });

  it('il certificato rilasciato non cambia nel database; si annulla una volta con un motivo', async () => {
    const [c] = await t.db
      .select()
      .from(templateCertificate)
      .where(eq(templateCertificate.patientId, s.richPatient));
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
            .update(templateCertificate)
            .set({ paragraphs: ['cambiato'] })
            .where(eq(templateCertificate.id, c!.id)),
        ),
      ),
    ).toMatch(/non si modifica: si annulla con un motivo/);
    expect(
      await dbError(
        withActor(t.db, s.users.titolare.id, (tx) =>
          tx.delete(templateCertificate).where(eq(templateCertificate.id, c!.id)),
        ),
      ),
    ).toMatch(/Non si cancella/);
    expect((await req('POST', `${base()}/${c!.id}/annulla`, {})).statusCode).toBe(400);
    const annulled = await req('POST', `${base()}/${c!.id}/annulla`, {
      motivo: 'Rilasciato per prova',
    });
    expect(annulled.statusCode, annulled.body).toBe(200);
    expect(
      (await req('POST', `${base()}/${c!.id}/annulla`, { motivo: 'Di nuovo' })).statusCode,
    ).toBe(409);
    const text = await pdfText(
      new Uint8Array((await req('GET', `${base()}/${c!.id}/pdf`)).rawPayload),
    );
    expect(text).toMatch(/ANNULLATO il \d{2}\/\d{2}\/\d{4}: Rilasciato per prova/);
  });

  it('dati mancanti e campi sbagliati si dicono prima del rilascio; la segreteria non rilascia', async () => {
    const values = { modello: studioKey, valori: { testo: 'x' }, luogo: 'Comune di prova' };
    expect((await req('POST', base(), values, secretary)).statusCode).toBe(403);
    const empty = await req('POST', base(), { ...values, valori: {} });
    expect(empty.statusCode).toBe(400);
    expect(empty.json<{ dettagli: { problemi: string[] } }>().dettagli.problemi).toEqual([
      'Testo: da compilare',
    ]);
    const unknown = await req('POST', base(), { ...values, modello: 'modello-che-non-esiste' });
    expect(unknown.statusCode).toBe(404);
    const noPlace = await req('POST', base(), { ...values, luogo: '' });
    expect(noPlace.statusCode).toBe(400);
  });

  it('validità: fino al giorno prima della stessa data, N mesi dopo', () => {
    expect(validityEnd('2026-11-18', 12)).toBe('2027-11-17');
    expect(validityEnd('2026-01-31', 1)).toBe('2026-02-28');
    expect(validityEnd('2028-02-29', 12)).toBe('2029-02-28');
  });
});
