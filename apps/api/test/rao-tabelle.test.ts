import { parseCsv } from '@mmg/reference';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  raoCondition,
  raoConditionKey,
  raoSources,
  raoSourceSchema,
  raoTablesFor,
  type RaoSource,
} from '../src/rao/tables';

/**
 * Le tabelle RAO (D285): il manuale di AGENAS (77 tabelle) e le determine della Regione Piemonte
 * per la cardiologia (D.D. 973/2019) e la gastroenterologia (D.D. 259/2019). La prova controlla la
 * forma, alcuni valori letti sulle pagine e il legame con il catalogo; il controllo voce per voce
 * resta da fare (controllato_da vuoto).
 */
describe('tabelle RAO (D285)', () => {
  const sources = raoSources();
  const of = (fonte: string) => sources.find((s) => s.fonte === fonte)!;
  const table = (fonte: string, id: string) => of(fonte).tabelle.find((t) => t.id === id)!;
  const texts = (fonte: string, id: string, classe: string, pediatria = false) =>
    table(fonte, id)
      .righe.filter((r) => r.classe === classe && r.pediatria === pediatria)
      .flatMap((r) => r.indicazioni.map((v) => v.testo));
  const all = { region: 'PIEMONTE', includeUnchecked: true };

  it('il manuale di AGENAS: 77 tabelle, come dice l’introduzione', () => {
    const agenas = of('agenas-2020');
    expect(agenas.tabelle.map((t) => t.id)).toEqual(
      Array.from({ length: 77 }, (_, i) => String(i + 1).padStart(3, '0')),
    );
    const count = agenas.tabelle.reduce(
      (n, t) => n + t.righe.reduce((m, r) => m + r.indicazioni.length, 0),
      0,
    );
    expect(count).toBe(1379);
    // Pagine 75 e 76 del manuale, prima visita cardiologica.
    expect(texts('agenas-2020', '028', 'B')).toEqual([
      'Dispnea da sforzo e/o edemi di recente insorgenza di sospetta natura cardiologica',
      'Dispnea, palpitazione o affaticamento per sforzi lievi, verosimilmente di natura cardiaca con caratteristiche di recente insorgenza in soggetti senza precedente diagnosi di cardiopatia',
      'Scarica isolata di defibrillatore automatico impiantato',
      'Aritmie asintomatiche: ipocinetiche',
      'Altro (10%)**',
    ]);
    const p = table('agenas-2020', '028').righe.find((r) => r.classe === 'P' && r.pediatria)!;
    expect(p).toMatchObject({
      attesa: '120 gg',
      non_previste: 'INDICAZIONI CLINICHE NON PREVISTE*',
    });
    // La numerazione strana del documento resta com'è (pagine 45 e 98).
    const d007 = table('agenas-2020', '007').righe.find((r) => r.classe === 'D')!;
    expect(d007.indicazioni.map((v) => v.numero)).toEqual(['1', '2', '1']);
    expect(d007.indicazioni.at(-1)).toEqual({ numero: '1', testo: 'Altro (10%)**', altro: true });
    const d035 = table('agenas-2020', '035').righe.find((r) => r.classe === 'D')!;
    expect(d035.indicazioni[0]).toEqual({
      numero: '5',
      testo: 'Abilità alla guida (valutazione multidimensionale)',
    });
    // La nota sotto la tabella 053 (pagina 138).
    expect(table('agenas-2020', '053').note).toEqual([
      "*Nei quadri di degenerazione artrosica è indicato l'esame radiologico ed inappropriato l'esame RM.",
    ]);
  });

  it('i codici del manuale che oggi sono di un’altra prestazione: il legame va al codice giusto', () => {
    const codes = (id: string) => table('agenas-2020', id).legame.map((l) => l.codice);
    expect(codes('041')).toEqual(['89.7B.7']);
    expect(table('agenas-2020', '041').servizi[0]!.codici_stampati).toEqual(['89.7B.8']);
    expect(table('agenas-2020', '041').nota_legame).toMatch(/89\.7B\.8.*OTORINOLARINGOIATRIA/);
    expect(codes('033')).toEqual(['89.7B.2']);
    expect(codes('037')).toEqual(['89.7B.4']);
    expect(codes('040')).toEqual(['89.7B.6']);
    expect(codes('042')).toEqual(['89.7B.8']);
    expect(codes('043')).toEqual(['89.7B.9']);
    expect(codes('045')).toEqual(['89.7C.2']);
    expect(codes('056')).toContain('87.23.6');
    // La testata della 019 stampa per errore l'EGDS 45.16.2, che ha la sua tabella (020).
    expect(codes('019')).not.toContain('45.16.2');
    expect(table('agenas-2020', '019').nota_legame).toMatch(/45\.16\.2.*020/);
  });

  it('le determine del Piemonte: le righe delle note e la classe P a 180 giorni', () => {
    const visita = table('piemonte-dd973-2019', 'dd973-1');
    expect(visita.righe.slice(0, 3).map((r) => [r.classe, r.attesa, r.da_nota ?? false])).toEqual([
      ['emergenza', 'PS', true],
      ['U', '48 ore', true],
      ['U', '72 ore', false],
    ]);
    expect(texts('piemonte-dd973-2019', 'dd973-1', 'U')).toEqual([
      'Angina di recente insorgenza (<1mese)',
      'Dispnea con presenza di segni di congestione',
      'Scarica isolata di defibrillatore automatico impiantato',
    ]);
    expect(visita.righe.find((r) => r.classe === 'P' && !r.pediatria)!.attesa).toBe('180 gg');
    expect(visita.righe.find((r) => r.classe === 'P' && r.pediatria)!.attesa).toBe('120 gg');
    expect(texts('piemonte-dd973-2019', 'dd973-2', 'B')[0]).toBe(
      'Recente insorgenza, di: Scadimento funzionale; Dispnea; Sincope; Fibrillazione atriale; Aritmie maggiori (es: tachicardia ventricolare non sostenuta)',
    );
    expect(texts('piemonte-dd259-2019', 'dd259-2', 'B')[2]).toBe(
      'Sintomi d’allarme: vomito ricorrente (presenti da almeno 5-7 giorni) con esclusione di cause di natura infettiva, metabolica, neurologica e psicogena; disfagia/odinofagia (presenti da almeno 5-7 giorni); calo ponderale significativo con sintomi digestivi (> 10% in 3 mesi)',
    );
    expect(table('piemonte-dd259-2019', 'dd259-3').class_rao).toBeNull();
  });

  it('la tabella della regione vale al posto di quella nazionale, solo nella sua regione', () => {
    const ids = (entry: { nationalCode: string; description: string }, region: string | null) =>
      raoTablesFor(sources, entry, { region, includeUnchecked: true }).map(
        (m) => `${m.source.fonte}/${m.table.id}`,
      );
    const cardio = { nationalCode: '89.7A.3', description: 'PRIMA VISITA CARDIOLOGICA CON ECG' };
    expect(ids(cardio, 'PIEMONTE')).toEqual(['piemonte-dd973-2019/dd973-1']);
    expect(ids(cardio, 'LOMBARDIA')).toEqual(['agenas-2020/028']);
    expect(ids(cardio, null)).toEqual(['agenas-2020/028']);
    // Lo stesso codice per un'altra disciplina: nessuna tabella.
    const cardiochirurgica = {
      nationalCode: '89.7A.3',
      description: 'PRIMA VISITA CARDIOCHIRURGICA CON ECG',
    };
    expect(ids(cardiochirurgica, 'PIEMONTE')).toEqual([]);
    expect(ids({ nationalCode: '89.7', description: 'PRIMA VISITA GERIATRICA' }, null)).toEqual([
      'agenas-2020/035',
    ]);
    expect(ids({ nationalCode: '89.7', description: 'PRIMA VISITA EMATOLOGICA' }, null)).toEqual(
      [],
    );
    expect(ids({ nationalCode: '89.7B.7', description: 'PRIMA VISITA ORTOPEDICA' }, null)).toEqual([
      'agenas-2020/041',
    ]);
    // Due tabelle per lo stesso codice: le sceglie il medico.
    expect(
      ids(
        { nationalCode: '89.7A.1', description: 'PRIMA VISITA ANESTESIOLOGICA/ALGOLOGICA' },
        null,
      ),
    ).toEqual(['agenas-2020/026', 'agenas-2020/027']);
    // Fuori dalla prova, le trascrizioni non controllate non si usano.
    expect(raoTablesFor(sources, cardio, { region: 'PIEMONTE', includeUnchecked: false })).toEqual(
      [],
    );
  });

  it('ogni codice del legame è nel catalogo regionale, ogni prefisso trova almeno una voce', () => {
    const dir = join(
      import.meta.dirname,
      '../../../packages/reference/data/trascrizioni/piemonte_catalogo',
    );
    const read = (f: string) => {
      const [head, ...rows] = parseCsv(readFileSync(join(dir, f), 'utf8'), ';');
      const at = (name: string) => head!.indexOf(name);
      return rows
        .filter((r) => at('operazione') < 0 || r[at('operazione')] === 'aggiunge')
        .map((r) => ({
          national: r[at('codice_nomenclatore')]!,
          description: r[at('descrizione')]!,
        }));
    };
    const entries = ['dd590-2026-allegato-a.csv', 'dd710-2026-dal-2026-10-30.csv'].flatMap(read);
    expect(entries.length).toBeGreaterThan(5000);
    const missing: string[] = [];
    for (const s of sources)
      for (const t of s.tabelle)
        for (const l of t.legame) {
          const hits = entries.filter((e) => e.national === l.codice);
          const ok = l.prefissi
            ? hits.some((e) => l.prefissi!.some((p) => e.description.toUpperCase().startsWith(p)))
            : hits.length > 0;
          if (!ok) missing.push(`${s.fonte}/${t.id} ${l.codice}`);
        }
    expect(missing).toEqual([]);
  });

  it('la condizione si legge dalla chiave; le righe d’emergenza non danno una classe', () => {
    const key = raoConditionKey('agenas-2020', '028', 5, 2);
    const c = raoCondition(sources, key, { region: null, includeUnchecked: true })!;
    expect(c.priority).toBe('B');
    expect(c.indication.testo).toMatch(/^Dispnea, palpitazione/);
    expect(raoCondition(sources, raoConditionKey('agenas-2020', '028', 1, 1), all)).toBeNull();
    expect(raoCondition(sources, 'agenas-2020:028:99:1', all)).toBeNull();
    expect(raoCondition(sources, 'niente', all)).toBeNull();
    expect(raoCondition(sources, key, { region: null, includeUnchecked: false })).toBeNull();
  });

  it('una fonte regionale senza regione, o due tabelle con lo stesso nome: il file non vale', () => {
    const dd973 = of('piemonte-dd973-2019');
    expect(() => raoSourceSchema.parse({ ...dd973, regione: null })).toThrow(/regione/);
    const twice: RaoSource = { ...dd973, tabelle: [dd973.tabelle[0]!, dd973.tabelle[0]!] };
    expect(() => raoSourceSchema.parse(twice)).toThrow(/Tabelle ripetute/);
    const empty = {
      ...dd973,
      tabelle: [
        {
          ...dd973.tabelle[0]!,
          righe: [{ ...dd973.tabelle[0]!.righe[2]!, non_previste: undefined }],
        },
      ],
    };
    expect(() => raoSourceSchema.parse(empty)).toThrow(/non sono previste/);
  });

  it('le fonti sono quelle registrate, con la stessa impronta, e sono da controllare', () => {
    const provenances = readFileSync(
      join(import.meta.dirname, '../../../docs/provenienze.md'),
      'utf8',
    );
    for (const s of sources) {
      expect(provenances, s.fonte).toContain(s.sha256_origine);
      expect(s.controllato_da).toBeNull();
    }
  });
});
