import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { DataVersions, type DatasetVersion } from '../src/components/common';
import { lineSummary } from '../src/pages/PrescriptionEditor';

/**
 * La ricetta in una schermata (D242): la riga chiusa dice che cosa c'è senza aprirla, e le banche
 * dati in uso, chiuse in una riga, dicono anche da chiuse se una è più vecchia del previsto.
 */

afterEach(cleanup);

describe('sintesi della riga chiusa (D242)', () => {
  it('farmaci: confezioni e posologia, e le scelte che vincolano il farmacista', () => {
    expect(lineSummary({ quantity: 1 }, 'farmaci')).toBe('1 confezione · posologia non indicata');
    expect(lineSummary({ quantity: 2, posologyText: ' 1 compressa al giorno ' }, 'farmaci')).toBe(
      '2 confezioni · 1 compressa al giorno',
    );
    expect(
      lineSummary(
        { quantity: 1, posologyText: '1 al dì', byActiveIngredient: true, notSubstitutable: true },
        'farmaci',
      ),
    ).toBe('1 confezione · 1 al dì · per principio attivo · non sostituibile');
  });

  it('ricetta bianca: ripetibilità e validità solo se scelte, e solo per la bianca', () => {
    const line = { quantity: 1, repeatCount: '2', validityMonths: '6' };
    expect(lineSummary(line, 'farmaci', true)).toBe(
      '1 confezione · posologia non indicata · ripetibile 2 volte · validità 6 mesi',
    );
    expect(lineSummary(line, 'farmaci', false)).toBe('1 confezione · posologia non indicata');
  });

  it('prestazioni: quantità e i due codici', () => {
    expect(
      lineSummary(
        { quantity: 1, serviceCode: '89.7', serviceNationalCode: '89.7' },
        'specialistica',
      ),
    ).toBe('quantità 1 · catalogo 89.7 · nomenclatore (DM) 89.7');
    expect(lineSummary({ quantity: 3, serviceCode: null }, 'specialistica')).toBe('quantità 3');
  });
});

const version = (stale: boolean): DatasetVersion => ({
  kind: 'farmaci',
  kindLabel: 'Farmaci',
  series: 'aifa-anagrafica',
  title: 'AIFA: anagrafica delle confezioni',
  validFrom: '2026-11-01',
  validFromBasis: 'scarico',
  downloadedAt: '2026-11-01T10:00:00Z',
  act: null,
  stale,
});

describe('banche dati in uso, chiuse in una riga (D242)', () => {
  const show = (stale: boolean) =>
    render(
      <MemoryRouter>
        <DataVersions versions={[version(stale)]} label="Banche dati dei farmaci" compact />
      </MemoryRouter>,
    );

  it('chiuse, si leggono aprendole', () => {
    show(false);
    const summary = screen.getByText('Banche dati dei farmaci in uso');
    const details = summary.closest('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('AIFA: anagrafica delle confezioni');
    expect(summary.textContent).not.toContain('più vecchia del previsto');
  });

  it('una banca dati più vecchia del previsto si dice anche da chiuse', () => {
    show(true);
    const summary = screen.getByText(/Banche dati dei farmaci in uso/).closest('summary')!;
    expect(summary.textContent).toContain('più vecchia del previsto');
  });
});
