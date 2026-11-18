import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRINT_LAYOUT,
  fieldIssues,
  fillTemplate,
  layoutIssues,
  missingData,
  templateIssues,
  type CertificateTemplate,
  type TemplateContext,
} from '../src/certificate-templates';

/** Un modello di prova: testo inventato, non quello di un atto. */
const sample = (): CertificateTemplate => ({
  key: 'modello-di-prova',
  title: 'Certificato di prova',
  version: '2026-11-18',
  official: true,
  source: {
    act: 'Atto di prova, allegato A',
    url: 'https://www.esempio.invalid/atto',
    checkedOn: '2026-11-18',
  },
  validityMonths: 12,
  forDoctor: ['Nota per il medico, non stampata.'],
  fields: [
    { key: 'data_esame', label: 'Data dell’esame', type: 'data', required: true },
    {
      key: 'esito',
      label: 'Esito',
      type: 'scelta',
      required: true,
      options: ['primo esito', 'secondo esito'],
    },
    { key: 'note', label: 'Note', type: 'testo_lungo', required: false, max: 20 },
  ],
  body: [
    'Si certifica che {{paziente.cognome}} {{paziente.nome}}, nato/a a {{paziente.nato_a}} il {{paziente.nato_il}}, ha eseguito l’esame il {{campo.data_esame}}: {{campo.esito}}.',
    '{{campo.note}}',
    '{{rilascio.luogo}}, {{rilascio.data}} – {{medico.nome_cognome}}',
  ],
  signature: 'Timbro e firma del medico',
});

const context = (): TemplateContext => ({
  patient: {
    cognome: 'Rossi',
    nome: 'Prova',
    sesso: 'F',
    nato_a: 'Comune di prova',
    nato_il: '01/02/1980',
    codice_fiscale: 'RSSPRV80B41X001X',
    residenza: 'Via di prova 1, Comune di prova',
  },
  doctor: { nome_cognome: 'Medica Inventata', codice_fiscale: 'X', codice_regionale: '' },
  issue: { luogo: 'Comune di prova', data: '18/11/2026' },
});

describe('modelli dei certificati (tappa 13)', () => {
  it('un modello ben fatto non ha problemi', () => {
    expect(templateIssues(sample())).toEqual([]);
  });

  it('segnaposto sconosciuti, campi non usati, ufficiale senza fonte, scelta senza opzioni', () => {
    const t = sample();
    t.body.push('{{paziente.indirizzo_segreto}} {{campo.non_dichiarato}}');
    t.fields.push({ key: 'avanzo', label: 'Avanzo', type: 'testo', required: false });
    t.fields.push({ key: 'senza', label: 'Senza opzioni', type: 'scelta', required: false });
    t.body.push('{{campo.senza}}');
    expect(templateIssues(t)).toEqual([
      'Campo «Senza opzioni»: una scelta ha bisogno delle opzioni',
      'Segnaposto sconosciuto: {{paziente.indirizzo_segreto}}',
      "Segnaposto di un campo che non c'è: {{campo.non_dichiarato}}",
      'Campo «avanzo» dichiarato ma non usato nel testo',
    ]);
    expect(templateIssues({ ...sample(), source: null })).toEqual([
      'Un modello ufficiale ha sempre la sua fonte',
    ]);
    // Un modello dello studio non ha una fonte.
    expect(templateIssues({ ...sample(), official: false, source: null })).toEqual([]);
  });

  it('i valori dei campi: obbligatori, date, scelte, lunghezza, campi sconosciuti', () => {
    expect(fieldIssues(sample(), { data_esame: '2026-11-10', esito: 'primo esito' })).toEqual([]);
    expect(
      fieldIssues(sample(), {
        data_esame: '10/11/2026',
        esito: 'un altro',
        note: 'x'.repeat(21),
        intruso: 'sì',
      }),
    ).toEqual([
      'Data dell’esame: non è una data',
      'Esito: scegli uno dei valori proposti',
      'Note: al massimo 20 caratteri',
      'Campo sconosciuto: «intruso»',
    ]);
    expect(fieldIssues(sample(), {})).toEqual([
      'Data dell’esame: da compilare',
      'Esito: da compilare',
    ]);
  });

  it('il testo: dati del paziente dalla cartella, date dei campi in italiano', () => {
    const filled = fillTemplate(sample(), context(), {
      data_esame: '2026-11-10',
      esito: 'primo esito',
    });
    expect(filled.title).toBe('Certificato di prova');
    expect(filled.paragraphs[0]).toBe(
      'Si certifica che Rossi Prova, nato/a a Comune di prova il 01/02/1980, ha eseguito l’esame il 10/11/2026: primo esito.',
    );
    expect(filled.paragraphs[2]).toBe('Comune di prova, 18/11/2026 – Medica Inventata');
  });

  it('i dati che mancano nella cartella o nel profilo si dicono prima', () => {
    const ctx = context();
    ctx.patient.nato_a = '';
    ctx.issue.luogo = ' ';
    expect(missingData(sample(), ctx)).toEqual([
      'Paziente: manca comune di nascita',
      'Rilascio: manca luogo del rilascio',
    ]);
  });

  it('impaginazione: carattere, dimensione, margini, righe dell’intestazione', () => {
    expect(layoutIssues(DEFAULT_PRINT_LAYOUT)).toEqual([]);
    expect(
      layoutIssues({
        ...DEFAULT_PRINT_LAYOUT,
        fontSize: 20,
        marginMm: 5,
        header: Array.from({ length: 7 }, () => 'riga'),
      }),
    ).toEqual([
      'Dimensione del testo: da 9 a 14 punti',
      'Margini: da 10 a 40 mm',
      'Intestazione: al massimo 6 righe',
    ]);
  });
});
