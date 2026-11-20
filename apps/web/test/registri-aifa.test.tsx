import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RegistryDetails, RegistryNote, type DrugRegistry } from '../src/components/Registries';

const PEDIATRIC: DrugRegistry = {
  name: 'ENTRESTO PEDIATRICO',
  activeIngredient: 'Sacubitril valsartan',
  atc: 'C09DX04',
  type: 'Piano Terapeutico',
  state: 'Attivo',
  condition: 'INSUFFICIENZA CARDIACA CRONICA SINTOMATICA',
  indication: 'Entresto è indicato in bambini ed adolescenti da un anno di età in poi.',
  since: '2025-09-04',
  sheetUrl: 'https://www.aifa.gov.it/documents/20142/3041382/PT_Entresto_pediatrico_04.09.2025.zip',
};
const ADULT: DrugRegistry = {
  ...PEDIATRIC,
  name: 'ENTRESTO',
  indication: 'prima riga\n- seconda riga',
  since: '2017-03-12',
  // Un indirizzo che il servizio non ha ritenuto sicuro: nessun collegamento.
  sheetUrl: null,
};

describe('registri e piani terapeutici AIFA nell’interfaccia (D206)', () => {
  afterEach(cleanup);

  it('nei risultati: una riga con simbolo, parola e i registri per nome e tipo', () => {
    const { container } = render(<RegistryNote registries={[PEDIATRIC, ADULT]} />);
    expect(container.textContent).toBe(
      'Registri e piani AIFA per lo stesso ATC: ENTRESTO PEDIATRICO (Piano Terapeutico), ENTRESTO (Piano Terapeutico).',
    );
    expect(container.querySelector('.registro-aifa svg')).toBeTruthy();
    cleanup();
    expect(render(<RegistryNote registries={[]} />).container.textContent).toBe('');
  });

  it('nei dati del farmaco: tipo, stato, data, patologia e indicazione; la scheda AIFA in una scheda nuova', () => {
    render(<RegistryDetails registries={[PEDIATRIC, ADULT]} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'ENTRESTO PEDIATRICO: Piano Terapeutico, attivo dal 04/09/2025. INSUFFICIENZA CARDIACA CRONICA SINTOMATICA. Indicazione rimborsata: Entresto è indicato in bambini ed adolescenti da un anno di età in poi. scheda di ENTRESTO PEDIATRICO sul sito di AIFA',
      'ENTRESTO: Piano Terapeutico, attivo dal 12/03/2017. INSUFFICIENZA CARDIACA CRONICA SINTOMATICA. Indicazione rimborsata: prima riga\n- seconda riga',
    ]);
    const link = within(items[0]!).getByRole('link', {
      name: 'scheda di ENTRESTO PEDIATRICO sul sito di AIFA',
    });
    expect(link.getAttribute('href')).toBe(PEDIATRIC.sheetUrl);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    // Senza un indirizzo sicuro, nessun collegamento.
    expect(within(items[1]!).queryByRole('link')).toBeNull();
    // L'indicazione va a capo come nell'elenco.
    expect(items[1]!.querySelector('.registro-aifa-indicazione')).toBeTruthy();
  });
});
