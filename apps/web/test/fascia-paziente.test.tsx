import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PatientFacts } from '../src/components/PatientFacts';
import type { Patient, Summary } from '../src/pages/RecordPage';

const patient: Patient = {
  id: 'p1',
  firstName: 'Paziente',
  lastName: 'Inventato',
  sex: 'F',
  birthDate: '1960-05-01',
  birthPlaceName: null,
  fiscalCode: 'NVNPZN60E41X000X',
  phone: null,
  email: null,
  asl: null,
  status: 'active',
};

const summary = (extra: Partial<Summary> = {}): Summary => ({
  allergie: [],
  problemiAttivi: [],
  pianiTerapeutici: [],
  esenzioni: [
    { codice: '013', dal: '2026-01-01', al: null },
    { codice: '031', dal: '2020-01-01', al: '2021-01-01' },
  ],
  parametri: [],
  ...extra,
});

afterEach(cleanup);

/**
 * La fascia della cartella (D244): il nome piccolo come i dati, e le esenzioni in corso con la
 * descrizione e la scadenza; quelle che il servizio non dice in corso non ci sono.
 */
describe('fascia del paziente (D244)', () => {
  it('le esenzioni in corso con la descrizione e la scadenza, e il nome nella riga dei dati', () => {
    render(
      <PatientFacts
        patient={patient}
        summary={summary({
          esenzioniInCorso: [
            { codice: '013', descrizione: 'Descrizione di prova', al: null },
            { codice: '048', descrizione: null, al: '2027-03-31' },
          ],
        })}
        withName
      />,
    );
    const pills = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(pills).toEqual([
      'Esenzione 013: Descrizione di prova',
      'Esenzione 048 fino al 31/03/2027',
    ]);
    const name = screen.getByText('Paziente Inventato');
    expect(name.closest('.testata-dati')).not.toBeNull();
  });

  it('senza il campo nuovo, le esenzioni di prima con la scadenza; senza nome fuori dalla fascia', () => {
    render(<PatientFacts patient={patient} summary={summary()} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Esenzione 013',
      'Esenzione 031 fino al 01/01/2021',
    ]);
    expect(screen.queryByText('Paziente Inventato')).toBeNull();
  });
});
