import { describe, expect, it } from 'vitest';
import { serviceGroup, SERVICE_GROUP_LABELS } from '../src';

/**
 * Visite ed esami prescritti (D152). Le descrizioni sono copiate parola per parola da due fonti
 * lette il 18/11/2026, con il codice e il punto in cui si trovano:
 * - catalogo regionale allegato alla D.D. 990/A1400B/2024 (BUR Piemonte n. 1 del 2/1/2025): pagina
 *   del PDF della Regione;
 * - nomenclatore nazionale, allegato 4 del DPCM LEA (PDF del Ministero della salute, in 5 parti):
 *   parte e pagina.
 */
const VISITS: [string, string, string][] = [
  ['897.08', 'D.D. 990/2024, p. 123', 'PRIMA VISITA NEFROLOGICA'],
  ['8901.80', 'D.D. 990/2024, p. 6', 'VISITA CARDIOLOGICA DI CONTROLLO CON ECG'],
  ['89.01.A', 'D.D. 990/2024, p. 14', 'VISITA DI MEDICINA NUCLEARE DI CONTROLLO'],
  [
    '89.7B.3',
    'D.D. 990/2024, p. 14',
    'PRIMA VISITA DI MEDICINA NUCLEARE INCLUSO: VALUTAZIONE PRETRATTAMENTO E STESURA DEL PIANO DI TRATTAMENTO',
  ],
  // Le sole due visite dei cataloghi regionali che non cominciano con «VISITA».
  [
    '8901.85',
    'D.D. 990/2024, p. 125',
    'RIVALUTAZIONE DEL PROGRAMMA TERAPEUTICO PRESSO CENTRO DEMENZE E DISTURBI COGNITIVI (CDCC/UVA) - VISITA NEUROLOGICA',
  ],
  [
    '9412.85',
    'D.D. 990/2024, p. 145',
    'RIVALUTAZIONE DEL PROGRAMMA TERAPEUTICO PRESSO CENTRO DEMENZE E DISTURBI COGNITIVI (CDCC/UVA) - VISITA PSCHIATRICA',
  ],
  [
    '89.01',
    'nomenclatore, parte 2, p. 20',
    'VISITA DI CONTROLLO (di routine o di follow up). Escluso: le visite di controllo specificamente codificate',
  ],
  ['89.7A.3', 'nomenclatore, parte 2, p. 24', 'PRIMA VISITA CARDIOLOGICA. Incluso: ECG (89.52)'],
];

const OTHERS: [string, string, string][] = [
  ['88.73.5', 'D.D. 990/2024, p. 6', 'ECO(COLOR) DOPPLER DEI TRONCHI SOVRAORTICI'],
  [
    '90.26.5',
    'D.D. 990/2024, p. 45',
    'GLUCOSIO DOSAGGIO SERIALE DOPO CARICO (DA 2 A 4 DETERMINAZIONI), E DETERMINAZIONE DEL GLUCOSIO BASALE',
  ],
  // Interventi che comprendono visite: la parola sta nella nota «incluso».
  [
    '11.99.2',
    'D.D. 990/2024, p. 128',
    'CORREZIONE DEI VIZI DI REFRAZIONE CON LASER A ECCIMERI (PRK) O LASEK/LASIK. INCLUSO: DUE VISITE DI CONTROLLO 89.01.D',
  ],
  [
    '04.43',
    'nomenclatore, parte 1, p. 3',
    'LIBERAZIONE DEL TUNNEL CARPALE. Incluso: Visita anestesiologica ed anestesia, esami pre intervento, intervento, medicazioni, rimozione punti, visita di controllo',
  ],
  // La visita nominata in una nota «non associabile a»: è un esame.
  [
    '89.52',
    'nomenclatore, parte 2, p. 24',
    'ELETTROCARDIOGRAMMA. Non associabile a Prima visita cardiologica (89.7A.3), Visita cardiologica di controllo (89.01.3)',
  ],
  [
    '93.01.3',
    'nomenclatore, parte 4, p. 1',
    "VALUTAZIONE MONOFUNZIONALE DELLE FUNZIONI MENTALI GLOBALI Con l'utilizzo di strumenti di misura validati e/o condivisi a livello scientifico e relativa refertazione. Valutazione delle funzioni corporee secondo ICF (b110-b139). Non associabile a: PRIMA VISITA (89.7C.4). VALUTAZIONE FUNZIONALE GLOBALE (93.01.1), SOMMINISTRAZIONE DI TEST DI DETERIORAMENTO O SVILUPPO INTELLETTIVO M.D.B., MODA, WAIS, STANFORD BINET (94.01.2). Non ripetibile entro un mese",
  ],
  // La visita nominata in una spiegazione.
  [
    'G9.01',
    'nomenclatore, parte 4, p. 17',
    "CONSULENZA GENETICA ASSOCIATA AL TEST. Consulenza Genetica in paziente con ipotesi diagnostica specifica già formulata e con prescrizione di test genetico. Consulenza pre-test: spiegazione dei vantaggi e dei limiti del test genetico e somministrazione dei consensi informati (se non effettuati nell'ambito della visita). Consulenza post-test: spiegazione del risultato del test genetico",
  ],
  // Consulti, colloqui e valutazioni: le fonti non li chiamano visite.
  [
    '8907.3',
    'D.D. 990/2024, p. 37',
    'CONSULTO INTERDISCIPLINARE DEFINITO COMPLESSIVO - PDTA DIABETE',
  ],
  ['94.09', 'D.D. 990/2024, p. 145', 'COLLOQUIO PSICOLOGICO CLINICO'],
];

describe('visite ed esami prescritti (D152)', () => {
  it.each(VISITS)('%s (%s) è una visita', (_code, _where, description) => {
    expect(serviceGroup(description)).toBe('visita');
  });

  it.each(OTHERS)('%s (%s) è tra esami e altre prestazioni', (_code, _where, description) => {
    expect(serviceGroup(description)).toBe('altro');
  });

  it('la parola intera all’inizio, in qualunque maiuscola, anche come televisita', () => {
    expect(serviceGroup('Visita di prova')).toBe('visita');
    expect(serviceGroup('  prima visita di prova')).toBe('visita');
    expect(serviceGroup('TELEVISITA DI CONTROLLO')).toBe('visita');
    expect(serviceGroup('VISITATORE')).toBe('altro');
    expect(serviceGroup('RIVISITAZIONE DEL PIANO')).toBe('altro');
    expect(serviceGroup('ESAME. Incluso: visita')).toBe('altro');
    expect(serviceGroup('ESAME DI PROVA-VISITA')).toBe('altro');
  });

  it('senza descrizione la prestazione non è una visita', () => {
    expect(serviceGroup(null)).toBe('altro');
    expect(serviceGroup('')).toBe('altro');
  });

  it('i nomi dei gruppi', () => {
    expect(SERVICE_GROUP_LABELS).toEqual({ visita: 'Visite', altro: 'Esami e altre prestazioni' });
  });
});
