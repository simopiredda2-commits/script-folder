import { DEFAULT_PRINT_LAYOUT } from '@mmg/domain';
import { describe, expect, it } from 'vitest';
import { renderTemplatePdf } from '../src/templates/pdf';
import { pdfText } from './helpers/pdf-text';

/**
 * Stampa dei certificati dai modelli (D158): la struttura comune e le regole delle pagine. Testi
 * inventati per la prova.
 */
describe('stampa dei certificati dai modelli (D158)', () => {
  const print = (paragraphs: string[], notes: string[] = []) =>
    renderTemplatePdf({
      title: 'Certificato di prova',
      paragraphs,
      signature: 'In fede, il medico',
      layout: { ...DEFAULT_PRINT_LAYOUT },
      createdAt: new Date(0),
      parts: {
        reference: 'Riferimento di prova',
        notes,
        placeDate: 'Luogo e data: Comune di prova, 18/11/2026',
        otherSignatures: ['In fede, il dichiarante'],
      },
    });

  it('la dichiarazione finale resta sempre sulla pagina di luogo, data e firme', async () => {
    // Testi sempre più lunghi: prima o poi la fine del testo cade proprio in fondo alla pagina.
    for (let k = 15; k <= 45; k++) {
      const paragraphs = [
        ...Array.from({ length: k }, (_, i) => `Riga di riempimento numero ${i + 1}.`),
        'Dichiarazione finale del dichiarante.',
      ];
      const pages = (await pdfText(await print(paragraphs))).split('\n');
      const signed = pages.find((p) => p.includes('In fede, il medico'))!;
      expect(signed, `${k} righe`).toContain('Dichiarazione finale del dichiarante.');
      expect(signed, `${k} righe`).toContain('Luogo e data: Comune di prova, 18/11/2026');
      expect(signed, `${k} righe`).toContain('In fede, il dichiarante');
    }
  });

  it('ordine delle parti: riferimento sotto il titolo, testo, luogo e data, firme, note in fondo', async () => {
    const text = (
      await pdfText(await print(['Testo del certificato.'], ['(1) Nota di prova.']))
    ).replace(/\s+/g, ' ');
    const order = [
      'Certificato di prova',
      'Riferimento di prova',
      'Testo del certificato.',
      'Luogo e data: Comune di prova',
      'In fede, il dichiarante',
      'In fede, il medico',
      '(1) Nota di prova.',
    ].map((x) => text.indexOf(x));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
