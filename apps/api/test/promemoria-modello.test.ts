import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { code39Bars } from '../src/reminders/code39';
import {
  BARCODE_HEIGHT_MM_2024,
  BARCODE_MODULE_MM_2024,
  DEFAULT_REMINDER_PAPER,
  HALF_A4_MM,
  nreParts,
  renderPromemoria,
  renderSoloNre,
} from '../src/reminders/pdf';
import {
  ACCESS_TEXT_2024,
  DPC_MESSAGE_CODE,
  NO_NOTE,
  NOT_EXEMPT,
  NOT_SUBSTITUTABLE_TEXT,
  OBSCURED_TEXT_2024,
  PRIORITY_TEXT,
  RELEASE_TEXT,
  RELEASE_TEXT_2024,
  SPECIALIST_VALIDITY_DAYS,
  SSN_RECIPE_TYPE,
  TYPOLOGY_TEXT,
  regionHeading,
  type PromemoriaDataV1,
  type PromemoriaDataV2,
} from '../src/reminders/promemoria';

/** Un promemoria della versione 1, con dati inventati, fissato prima del 20/11/2026. */
const v1: PromemoriaDataV1 = {
  versione: 1,
  tipo: 'pharma_ssn',
  intestazione: 'SERVIZIO SANITARIO NAZIONALE – REGIONE PIEMONTE',
  nre: 'SIMR000000000007',
  codiceAutenticazione: 'SIMAUT000000000000000000000007',
  assistito: {
    codiceFiscale: 'RSSMRA80A01X000Y',
    cognomeNome: 'ROSSI MARIA',
    indirizzo: 'Via di prova 1, 10100 Torino (TO)',
    oscurato: false,
    siglaProvincia: 'TO',
    codiceAsl: '301',
  },
  esenzione: 'NON ESENTE',
  disposizioniRegionali: null,
  tipoRicetta: null,
  tipoAccesso: null,
  righe: [
    {
      descrizione: 'Farmaco di prova',
      quantita: 2,
      notaAifa: '13',
      tipologia: 'S',
      priorita: null,
    },
  ],
  numeroConfezioniPrestazioni: 2,
  diagnosi: { codice: null, descrizione: 'Quesito' },
  esteri: { tessera: '123', istituzione: 'ENTE' },
  data: '2026-11-19',
  medico: {
    codiceFiscale: 'MRCLNE70A41X000Z',
    codiceRegionale: 'MMG-1',
    nominativo: 'Dott.ssa Prova',
  },
  dicitura: RELEASE_TEXT,
};

/** Un promemoria della versione 2 con una sola prescrizione. */
const v2: PromemoriaDataV2 = {
  versione: 2,
  tipo: 'pharma_ssn',
  regione: 'REGIONE PIEMONTE',
  nre: '010A01234567890',
  codiceAutenticazione: 'SIMAUT000000000000000000000008',
  assistito: {
    codiceFiscale: 'RSSMRA80A41X000Y',
    cognomeNome: 'ROSSI MARIA',
    indirizzo: 'VIA DI PROVA 12',
    cap: '10100',
    citta: 'TORINO',
    provincia: 'TO',
    oscurato: false,
    siglaProvincia: 'TO',
    codiceAsl: '301',
  },
  esenzione: 'NON ESENTE',
  disposizioniRegionali: null,
  tipologia: null,
  altro: null,
  priorita: null,
  validitaGiorni: null,
  righe: [
    {
      prescrizione: ['012345678 - FARMACO DI PROVA 10 MG'],
      dettagli: null,
      quantita: 1,
      nota: NO_NOTE,
    },
  ],
  fraseDpc: null,
  quesitoDiagnostico: 'Quesito di prova',
  numeroConfezioniPrestazioni: 1,
  tipoRicetta: SSN_RECIPE_TYPE,
  esteri: null,
  data: '2026-11-20',
  medico: {
    codiceFiscale: 'MRCLNE70A41X000Z',
    codiceRegionale: 'MMG-1',
    nominativo: 'Dott.ssa Prova',
  },
  dicitura: RELEASE_TEXT_2024,
  fraseRegionale: null,
};

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Le scritte della prima pagina, ciascuna con la distanza dall'alto in millimetri. */
async function placed(bytes: Uint8Array) {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const height = page.view[3]!;
  const items = (await page.getTextContent()).items.flatMap((it) =>
    'str' in it && it.str.trim()
      ? [{ text: it.str, top: ((height - it.transform[5]!) * 25.4) / 72 }]
      : [],
  );
  await task.destroy();
  return items;
}

/** Le scritte con la posizione in millimetri (sinistra, destra, dall'alto) e la misura in punti. */
async function measured(bytes: Uint8Array) {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  const height = page.view[3]!;
  const mm = (pt: number) => (pt * 25.4) / 72;
  const items = (await page.getTextContent()).items.flatMap((it) =>
    'str' in it && it.str.trim()
      ? [
          {
            text: it.str,
            left: mm(it.transform[4]),
            right: mm(it.transform[4]! + it.width),
            top: mm(height - it.transform[5]!),
            size: Math.abs(it.transform[0]),
          },
        ]
      : [],
  );
  await task.destroy();
  return items;
}

/** Larghezza e altezza della prima pagina, in millimetri. */
async function pageMm(bytes: Uint8Array) {
  const { width, height } = (await PDFDocument.load(bytes)).getPage(0).getSize();
  return { width: (width * 25.4) / 72, height: (height * 25.4) / 72 };
}

describe('promemoria: versioni del modello (D217)', () => {
  it('versione 1: un promemoria fissato prima si ristampa uguale, byte per byte', async () => {
    // Impronte dei PDF prodotti dal programma prima delle specifiche del 2024.
    expect(sha256(await renderPromemoria(v1))).toBe(
      'a0361085a8717d3894bdeb175bedc77c892ec19e94d9e9a9a20689359e173ee8',
    );
    expect(sha256(await renderSoloNre(v1))).toBe(
      '02bb9a95f7b2dfc30f65513df1659a2556cde2ea0d6ab3d6550d5cd7fe982fac',
    );
  });

  it('versione 2: l’NRE in due codici, Regione e lotto poi il resto, tra asterischi', async () => {
    expect(nreParts('010A01234567890')).toEqual(['010A0', '1234567890']);
    const texts = (await placed(await renderPromemoria(v2))).map((x) => x.text);
    expect(texts).toEqual(
      expect.arrayContaining(['*010A0*', '*1234567890*', '*RSSMRA80A41X000Y*']),
    );
  });

  it('versione 2: barre alte 8 mm, modulo sopra il minimo del decreto', () => {
    expect(BARCODE_HEIGHT_MM_2024).toBe(8);
    expect(BARCODE_MODULE_MM_2024).toBeGreaterThanOrEqual(0.24);
    // Il codice fiscale sta nello spazio del modello a destra del nome, con i margini di quiete.
    const { width } = code39Bars('RSSMRA80A41X000Y', BARCODE_MODULE_MM_2024);
    expect(width + 2 * 10 * BARCODE_MODULE_MM_2024).toBeLessThan(75);
  });

  it('versione 2: tutto nella metà alta della pagina, e i campi dal 21 non si spostano', async () => {
    const one = await placed(await renderPromemoria(v2));
    const eight = await placed(
      await renderPromemoria({
        ...v2,
        righe: Array.from({ length: 6 }, (_, i) => ({
          prescrizione: [`GRUPPO ${i} - PRINCIPIO DI PROVA`, `01234567${i} - FARMACO DI PROVA`],
          dettagli: 'NON SOSTITUIBILE - motivazione di prova',
          quantita: 1,
          nota: NO_NOTE,
        })),
        numeroConfezioniPrestazioni: 6,
      }),
    );
    for (const items of [one, eight]) {
      expect(Math.max(...items.map((x) => x.top))).toBeLessThanOrEqual(HALF_A4_MM);
    }
    for (const label of [
      'QUESITO DIAGNOSTICO:',
      'N.CONFEZIONI/PRESTAZIONI:',
      'CODICE AUTENTICAZIONE:',
      RELEASE_TEXT_2024,
    ]) {
      const a = one.find((x) => x.text === label);
      const b = eight.find((x) => x.text === label);
      expect(a, label).toBeDefined();
      expect(b!.top, label).toBeCloseTo(a!.top, 3);
    }
  });

  it('campo 22: il numero intero, a 8 punti, fino a tre cifre, prima del tipo ricetta (D232)', async () => {
    for (const n of [3, 12, 990]) {
      const items = await measured(
        await renderPromemoria({ ...v2, numeroConfezioniPrestazioni: n }),
      );
      const label = items.find((x) => x.text === 'N.CONFEZIONI/PRESTAZIONI:')!;
      const value = items.find((x) => x.text === String(n) && Math.abs(x.top - label.top) < 0.5);
      expect(value, String(n)).toBeDefined();
      expect(value!.size).toBeCloseTo(8, 1);
      const next = items.find((x) => x.text === 'TIPO RICETTA:')!;
      expect(value!.right).toBeLessThan(next.left);
      expect(items.some((x) => x.text.includes('…') && Math.abs(x.top - label.top) < 0.5)).toBe(
        false,
      );
    }
  });

  it('area delle prescrizioni piena: nessuna prescrizione sparisce, i testi lunghi finiscono con «…» (D232)', async () => {
    const long = (i: number) =>
      `ANALISI GENETICA DI PROVA NUMERO ${i} ` +
      'PER LA RICERCA DI VARIANTI NEI GENI DI UN PANNELLO INVENTATO PER LA PROVA, CON SEQUENZIAMENTO E CONFERMA, ' +
      'COMPRESA LA CONSULENZA E LA RELAZIONE CONCLUSIVA DEL LABORATORIO DI PROVA, SU CAMPIONE DI SANGUE';
    const items = await measured(
      await renderPromemoria({
        ...v2,
        tipo: 'specialist_ssn',
        validitaGiorni: SPECIALIST_VALIDITY_DAYS,
        righe: Array.from({ length: 10 }, (_, i) => ({
          prescrizione: [`9${i}.12.3 (9${i}.12.3_${i}) – ${long(i)}`],
          dettagli: ACCESS_TEXT_2024.subsequent,
          quantita: 1,
          nota: NO_NOTE,
        })),
        numeroConfezioniPrestazioni: 10,
      }),
    );
    const head = items.find((x) => x.text.startsWith('PRESCRIZIONE VALIDA'))!;
    const diagnosis = items.find((x) => x.text === 'QUESITO DIAGNOSTICO:')!;
    const area = items.filter((x) => x.top > head.top && x.top < diagnosis.top);
    for (let i = 0; i < 10; i++)
      expect(
        area.some((x) => x.text.startsWith(`9${i}.12.3 (9${i}.12.3_${i})`)),
        `riga ${i + 1}`,
      ).toBe(true);
    expect(area.filter((x) => x.text === ACCESS_TEXT_2024.subsequent)).toHaveLength(10);
    // Quantità e nota di ogni riga dentro l'area, sopra il quesito.
    expect(area.filter((x) => x.text === NO_NOTE)).toHaveLength(10);
    expect(area.some((x) => x.text.endsWith('…'))).toBe(true);
    expect(Math.max(...area.map((x) => x.top))).toBeLessThan(diagnosis.top - 2);
  });

  it('carta: A5 orizzontale per difetto, con tutto il modello dentro la pagina (D222)', async () => {
    expect(DEFAULT_REMINDER_PAPER).toBe('A5');
    for (const render of [renderPromemoria, renderSoloNre]) {
      const bytes = await render(v2);
      const { width, height } = await pageMm(bytes);
      expect(width).toBeCloseTo(210, 1);
      expect(height).toBeCloseTo(148, 1);
      // Nessuna scritta oltre il fondo della pagina A5.
      const tops = (await placed(bytes)).map((x) => x.top);
      expect(Math.min(...tops)).toBeGreaterThan(0);
      expect(Math.max(...tops)).toBeLessThanOrEqual(148);
    }
  });

  it('carta: su A4 lo stesso promemoria nella metà alta, alle stesse distanze dall’alto', async () => {
    for (const render of [renderPromemoria, renderSoloNre]) {
      const a4 = await render(v2, 'A4');
      const { width, height } = await pageMm(a4);
      expect(width).toBeCloseTo(210, 1);
      expect(height).toBeCloseTo(297, 1);
      const onA4 = await placed(a4);
      const onA5 = await placed(await render(v2, 'A5'));
      expect(onA4.map((x) => x.text)).toEqual(onA5.map((x) => x.text));
      onA4.forEach((x, i) => expect(x.top, x.text).toBeCloseTo(onA5[i]!.top, 3));
      expect(Math.max(...onA4.map((x) => x.top))).toBeLessThanOrEqual(HALF_A4_MM);
    }
  });

  it('carta: un promemoria della versione 1 si ristampa su A4 com’era, qualunque sia la scelta', async () => {
    expect(sha256(await renderPromemoria(v1, 'A5'))).toBe(sha256(await renderPromemoria(v1, 'A4')));
    expect((await pageMm(await renderSoloNre(v1, 'A5'))).height).toBeCloseTo(297, 1);
  });

  it('diciture e valori come nel testo delle specifiche del 28/02/2024', () => {
    // Copiati dalle specifiche (capitolo 2 e 2.1): una modifica qui va confrontata con il PDF.
    expect(OBSCURED_TEXT_2024).toBe(
      'DATI DELL’ASSISTITO OSCURATI AI SENSI DELL’ARTICOLO 87 DEL DL 30 giugno 2003, n. 196',
    );
    expect(RELEASE_TEXT_2024).toBe(
      'Rilasciato ai sensi dell’art.11, comma 16 del DL 31 mag 2010,n.78 e dell’art.1, comma 4 del DM 2 nov 2011',
    );
    expect(NOT_EXEMPT).toBe('NON ESENTE');
    expect(TYPOLOGY_TEXT).toEqual({ S: 'SUGG', H: 'RICOV' });
    expect(PRIORITY_TEXT).toEqual({
      U: 'Nel più breve tempo possibile; se differibile entro 72 ore',
      B: 'Entro 10 giorni',
      D: 'Entro 30 (visite), entro 60 gg (visite strumentali)',
      P: 'Programmabile',
    });
    expect(ACCESS_TEXT_2024).toEqual({
      first: 'PRIMO ACCESSO',
      subsequent: 'ALTRA TIPOLOGIA DI ACCESSO',
    });
    expect(SPECIALIST_VALIDITY_DAYS).toBe(180);
    expect(NOT_SUBSTITUTABLE_TEXT).toBe('NON SOSTITUIBILE');
    expect(NO_NOTE).toBe('---');
    expect(SSN_RECIPE_TYPE).toBe('Assist. SSN');
    expect(DPC_MESSAGE_CODE).toBe('0196');
  });

  it('campo 1: «REGIONE» davanti al nome, una Provincia autonoma resta com’è', () => {
    expect(regionHeading('PIEMONTE')).toBe('REGIONE PIEMONTE');
    expect(regionHeading('Regione Piemonte')).toBe('REGIONE PIEMONTE');
    expect(regionHeading('Provincia autonoma di Trento')).toBe('PROVINCIA AUTONOMA DI TRENTO');
  });
});
