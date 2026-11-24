import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrescribedDrug } from '../src/components/Prescribed';
import { OpenRecordsProvider } from '../src/lib/openRecords';
import { SessionProvider } from '../src/lib/session';
import { PrescriptionEditor, repeatable, resultsText } from '../src/pages/PrescriptionEditor';
import type { TherapyRow } from '../src/pages/RecordPage';

/**
 * La segreteria nella «Nuova ricetta» (audit con Cowork, D259). Per i requisiti prepara solo le
 * ripetizioni delle terapie croniche: «Aggiungi» c'è solo su quelle, la ricerca serve a consultare,
 * la ricetta specialistica resta del medico. Prima «Prepara la ricetta» c'era con qualsiasi farmaco
 * e il servizio rispondeva «Azione riservata al medico». Dati inventati, servizio finto.
 */

const PATIENT_ID = '00000000-0000-4000-8000-000000000005';

const user = (codice: string, nome: string) => ({
  id: 'u1',
  nome: 'Utente inventato',
  ruoli: [{ codice, nome }],
  postazione: 'Studio',
  archivio: null,
});
const SECRETARY = user('secretary', 'Segreteria');
const DOCTOR = user('owner_doctor', 'Medico titolare');

const RECORD = {
  paziente: {
    id: PATIENT_ID,
    firstName: 'Paziente',
    lastName: 'Inventato',
    sex: 'F',
    birthDate: '1950-01-01',
    birthPlaceName: null,
    fiscalCode: 'NVNPZN50A41X000X',
    phone: null,
    email: null,
    asl: null,
    status: 'active',
    deceasedOn: null,
  },
  riepilogo: null,
};

const therapyRow = (id: string, kind: TherapyRow['kind'], drugName: string): TherapyRow => ({
  id,
  drugName,
  drugAic: null,
  activeIngredient: 'Provalina',
  kind,
  status: 'active',
  dose: '1',
  doseUnit: 'compressa',
  frequency: 'una volta al giorno',
  timeOfDay: null,
  aifaNote: null,
  reserved: false,
  important: false,
});
const CHRONIC = therapyRow('t1', 'chronic', 'Farmaco cronico di prova 5 mg');
const AS_NEEDED = therapyRow('t2', 'as_needed', 'Farmaco al bisogno di prova 10 mg');

const prescribed = (t: TherapyRow): PrescribedDrug => ({
  ricette: 1,
  prescritte: 1,
  inPreparazione: 0,
  annullate: 0,
  ultimaIl: '2026-11-10',
  ultimoStato: 'sent',
  ultimi12Mesi: 1,
  ultimaPrescrizione: { il: '2026-11-10', quantita: 1, altroProgramma: false },
  chiave: `terapia:${t.id}`,
  storico: { terapia: t.id },
  farmaco: t.drugName,
  principioAttivo: 'Provalina',
  aic: null,
  notaAifa: null,
  terapia: {
    id: t.id,
    tipo: t.kind,
    stato: 'active',
    tipologia: null,
    riservata: false,
    fine: null,
    motivoSospensione: null,
  },
});

const DRUG = {
  aic: '900000017',
  name: 'FARMACO DELLA RICERCA',
  pack: '28 compresse',
  activeIngredient: 'Provalina',
  atc: null,
  drugClass: 'A',
  price: null,
  aifaNote: null,
  dpc: false,
  planRequired: null,
  holder: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function editor(who: object, mode: 'farmaci' | 'specialistica' = 'farmaci', search: object = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const path = url.split('?')[0]!;
      const body =
        path === '/api/io'
          ? who
          : path === `/api/pazienti/${PATIENT_ID}`
            ? RECORD
            : path === `/api/pazienti/${PATIENT_ID}/terapie`
              ? { terapie: [CHRONIC, AS_NEEDED] }
              : path === `/api/pazienti/${PATIENT_ID}/farmaci-prescritti`
                ? { farmaci: [prescribed(CHRONIC), prescribed(AS_NEEDED)] }
                : path === '/api/farmaci'
                  ? { farmaci: [DRUG], versioni: [], ...search }
                  : {};
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
  const path = mode === 'farmaci' ? 'ricetta' : 'specialistica';
  render(
    <SessionProvider>
      <OpenRecordsProvider>
        <MemoryRouter initialEntries={[`/pazienti/${PATIENT_ID}/${path}`]}>
          <Routes>
            <Route path={`/pazienti/:id/${path}`} element={<PrescriptionEditor mode={mode} />} />
          </Routes>
        </MemoryRouter>
      </OpenRecordsProvider>
    </SessionProvider>,
  );
}

/** Scrive nella ricerca dei farmaci e aspetta il risultato. */
async function searchResult() {
  fireEvent.change(await screen.findByLabelText('Farmaco, principio attivo, codice AIC o ATC'), {
    target: { value: 'provalina' },
  });
  return (await screen.findByText('FARMACO DELLA RICERCA', {}, { timeout: 3000 })).closest('li')!;
}

const addButtons = (list: HTMLElement) =>
  within(list)
    .queryAllByRole('button', { name: /^Aggiungi/ })
    .map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());

describe('la segreteria nella «Nuova ricetta» (D259)', () => {
  it('«Aggiungi» solo sulle terapie croniche; la ricerca senza «Aggiungi», e lo dice', async () => {
    editor(SECRETARY);
    await screen.findByText(/La segreteria prepara solo le ripetizioni delle terapie croniche/);
    const list = await screen.findByRole('list', { name: 'Farmaci prescritti' });
    expect(addButtons(list)).toEqual(['Aggiungi Farmaco cronico di prova 5 mg']);
    // Il farmaco della ricerca si vede, ma non si aggiunge.
    const result = await searchResult();
    expect(within(result).queryByRole('button', { name: /Aggiungi/ })).toBeNull();
    expect(screen.getByText('Aggiungi una terapia cronica in corso dai farmaci prescritti.'));
  });

  it('la ricetta specialistica la prepara il medico', async () => {
    editor(SECRETARY, 'specialistica');
    await screen.findByText(/La ricetta specialistica la prepara il medico/);
    expect(screen.queryByRole('button', { name: /Prepara la ricetta/ })).toBeNull();
  });

  it('il medico aggiunge dalla ricerca e da ogni farmaco prescritto, come prima', async () => {
    editor(DOCTOR);
    const list = await screen.findByRole('list', { name: 'Farmaci prescritti' });
    expect(addButtons(list)).toHaveLength(2);
    const result = await searchResult();
    expect(within(result).getByRole('button', { name: /Aggiungi/ })).toBeTruthy();
    expect(screen.queryByText(/La segreteria prepara solo/)).toBeNull();
  });

  it('repeatable: cronica, in corso, non riservata', () => {
    expect(repeatable({ therapyId: 't1' }, [CHRONIC])).toBe(true);
    expect(repeatable({ therapyId: 't2' }, [AS_NEEDED])).toBe(false);
    expect(repeatable({ therapyId: 't1' }, [{ ...CHRONIC, status: 'suspended' }])).toBe(false);
    expect(repeatable({ therapyId: 't1' }, [{ ...CHRONIC, reserved: true }])).toBe(false);
    expect(repeatable({}, [CHRONIC])).toBe(false);
  });
});

describe('la ricerca dei farmaci (audit 5, 14, 15, 31, D259)', () => {
  it('dice quanti risultati, e quando sono solo i primi: l’elenco non è più letto tutto', async () => {
    editor(DOCTOR, 'farmaci', { altri: true });
    const result = await searchResult();
    await screen.findByText('Primi 1 risultati: precisa la ricerca (dosaggio, forma o marchio).');
    expect(result.closest('ul')!.getAttribute('aria-live')).toBeNull();
  });

  it('«Aggiungi» porta il nome del farmaco, e dopo il clic il fuoco va su «+»', async () => {
    editor(DOCTOR);
    const result = await searchResult();
    const add = within(result).getByRole('button', {
      name: /Aggiungi\s*FARMACO DELLA RICERCA 28 compresse/,
    });
    fireEvent.click(add);
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        'Una confezione in più di FARMACO DELLA RICERCA 28 compresse',
      ),
    );
  });

  it('resultsText', () => {
    expect(resultsText('x', { farmaci: [] })).toBe('Nessun risultato per «x».');
    expect(resultsText('x', { farmaci: [1] })).toBe('1 risultato.');
    expect(resultsText('x', { farmaci: [1, 2] })).toBe('2 risultati.');
    expect(resultsText('x', { farmaci: [1, 2], altri: true })).toMatch(/^Primi 2 risultati/);
  });
});
