import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import {
  AifaChangeNote,
  isSuspended,
  SuspendedNote,
  type AifaChange,
} from '../src/components/Shortage';

const CLASS_CHANGE: AifaChange = {
  kind: 'classe',
  since: '2026-11-01',
  text: 'non è più nell’elenco AIFA dei farmaci di classe A (versione del 01/11/2026); nella terapia è segnato in classe A',
};
const SUSPENDED: AifaChange = {
  kind: 'sospesa',
  since: '2026-11-20',
  text: 'confezione sospesa secondo l’anagrafica AIFA delle confezioni (versione del 20/11/2026)',
};

describe('variazioni AIFA nell’interfaccia (A7, D205)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  it('la variazione ha simbolo, parola e testo; nella scheda anche come si chiude', () => {
    const { container, rerender } = render(<AifaChangeNote change={CLASS_CHANGE} />);
    expect(container.textContent).toBe(`Variazione AIFA: ${CLASS_CHANGE.text}.`);
    expect(container.querySelector('.carenza svg')).toBeTruthy();
    rerender(<AifaChangeNote change={CLASS_CHANGE} details />);
    expect(container.textContent).toBe(
      `Variazione AIFA: ${CLASS_CHANGE.text}. Si chiude aggiornando la scheda dalla banca dati in vigore («Aggiorna dalla banca dati»).`,
    );
    rerender(<AifaChangeNote change={{ ...CLASS_CHANGE, kind: 'piano' }} details />);
    expect(container.textContent).toMatch(
      /Si chiude collegando il piano terapeutico alla terapia\.$/,
    );
  });

  it('la confezione sospesa nei risultati della ricerca, solo se l’anagrafica lo dice', () => {
    const { container } = render(<SuspendedNote />);
    expect(container.textContent).toBe(
      'Confezione sospesa secondo l’anagrafica AIFA delle confezioni.',
    );
    expect(container.querySelector('.carenza svg')).toBeTruthy();
    expect(isSuspended('Sospesa')).toBe(true);
    expect(isSuspended(' sospesa ')).toBe(true);
    expect(isSuspended('Autorizzata')).toBe(false);
    expect(isSuspended(null)).toBe(false);
  });

  it('Oggi: una voce per farmaco e variazione, con i pazienti che si aprono con un clic', async () => {
    let list: unknown = [
      {
        aic: '034471021',
        farmaco: 'RANITIDINA DOC GENERICI',
        tipo: 'sospesa',
        testo: SUSPENDED.text,
        pazienti: [
          { id: 'p1', nome: 'Lina', cognome: 'Rota' },
          { id: 'p2', nome: 'Ugo', cognome: 'Sala' },
        ],
      },
      {
        aic: '034471021',
        farmaco: 'RANITIDINA DOC GENERICI',
        tipo: 'classe',
        testo: CLASS_CHANGE.text,
        pazienti: [{ id: 'p2', nome: 'Ugo', cognome: 'Sala' }],
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = url.split('?')[0]!;
        const body =
          path === '/api/io'
            ? {
                id: 'u1',
                nome: 'Medico inventato',
                ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
                postazione: null,
              }
            : path === '/api/oggi'
              ? {
                  data: '2026-11-20',
                  appuntamenti: [],
                  code: {
                    daFirmare: 0,
                    nonInviate: 0,
                    richiesteAperte: 0,
                    pianiInScadenza: [],
                    giorniAvvisoPiani: 30,
                    farmaciCarenti: [],
                    variazioniAifa: list,
                  },
                }
              : { stato: 'ok' };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      }),
    );
    const { unmount } = render(<App />);
    expect(
      await screen.findByRole('heading', { name: 'Variazioni AIFA sui farmaci in terapia' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'SPAN' &&
          el.textContent === `RANITIDINA DOC GENERICI: ${SUSPENDED.text}.`,
      ),
    ).toBeTruthy();
    const suspended = screen.getByRole('list', {
      name: 'Pazienti con RANITIDINA DOC GENERICI in terapia: confezione sospesa',
    });
    expect(
      within(suspended)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Lina Rota', '/pazienti/p1'],
      ['Ugo Sala', '/pazienti/p2'],
    ]);
    // Lo stesso farmaco con un'altra variazione: un elenco a sé, con il suo nome.
    expect(
      screen.getByRole('list', {
        name: 'Pazienti con RANITIDINA DOC GENERICI in terapia: classe cambiata',
      }),
    ).toBeTruthy();
    unmount();
    list = [];
    render(<App />);
    await screen.findByRole('heading', { level: 2, name: 'Da fare' });
    expect(
      screen.queryByRole('heading', { name: 'Variazioni AIFA sui farmaci in terapia' }),
    ).toBeNull();
  });
});

describe('scheda della terapia: aggiornare dalla banca dati (D208)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
  });

  const THERAPY = {
    id: 't1',
    drugName: 'FARMACO RICLASSIFICATO',
    drugAic: '090000047',
    activeIngredient: 'PRINCIPIO INVENTATO',
    kind: 'chronic',
    status: 'active',
    dose: '1',
    doseUnit: 'compressa',
    frequency: 'una volta al giorno',
    timeOfDay: null,
    aifaNote: null,
    reserved: false,
    important: false,
    shortage: null,
    atc: 'X03AA01',
    drugClass: 'A',
    equivalenceGroup: null,
    dpc: false,
    route: null,
    unitsPerDay: '1',
    startOn: '2026-01-01',
    endOn: null,
    packsPerPrescription: 1,
    indicationEntryId: null,
    habitualExemptionCode: null,
    suggestedByName: null,
    suggestedByFacility: null,
    suggestedOn: null,
    patientInstructions: null,
    notReimbursable: false,
    byActiveIngredient: false,
    notSubstitutable: false,
    notSubstitutableReason: null,
    notSubstitutableCode: null,
    multiPrescription: false,
    suggestedS: false,
    hospitalH: false,
    suspendedReason: null,
  };

  /** Il servizio finto: un medico, una cartella, la terapia con la variazione di classe. */
  function stub(role: string) {
    let refreshed = false;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const path = url.split('?')[0]!;
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        let body: unknown = {};
        if (path === '/api/io')
          body = {
            id: 'u1',
            nome: 'Utente inventato',
            ruoli: [{ codice: role, nome: role }],
            postazione: null,
          };
        else if (path === '/api/pazienti/p1')
          body = {
            paziente: {
              id: 'p1',
              firstName: 'Lina',
              lastName: 'Rota',
              sex: 'F',
              birthDate: '1950-01-01',
              birthPlaceName: null,
              fiscalCode: 'RTOLNI50A41X000A',
              phone: null,
              email: null,
              asl: null,
              status: 'active',
              deceasedOn: null,
            },
            riepilogo: null,
          };
        else if (path === '/api/pazienti/p1/terapie')
          body = {
            terapie: [
              refreshed
                ? { ...THERAPY, drugClass: 'H', aifaChanges: [] }
                : { ...THERAPY, aifaChanges: [CLASS_CHANGE] },
            ],
          };
        else if (path === '/api/oggi')
          body = { data: '2026-11-20', appuntamenti: [], code: { daFirmare: 0 } };
        else if (path === '/api/pazienti/p1/storico-prescrizioni')
          body = { ultimi12Mesi: 0, annullateUltimi12Mesi: 0, voci: [] };
        else if (path === '/api/pazienti/p1/terapie/t1/aggiorna-dati-farmaco') {
          refreshed = true;
          body = { id: 't1', drugClass: 'H', aifaNote: null, dpc: false, equivalenceGroup: null };
        }
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    return calls;
  }

  it('il medico aggiorna classe e nota con un clic; la variazione sparisce', async () => {
    const calls = stub('owner_doctor');
    window.history.pushState({}, '', '/pazienti/p1/terapie/t1');
    render(<App />);
    const button = await screen.findByRole('button', { name: 'Aggiorna dalla banca dati' });
    expect(screen.getByText(/^Variazione AIFA:/)).toBeTruthy();
    button.click();
    expect(
      await screen.findByText(
        'Classe, nota e DPC della scheda aggiornati dalle banche dati in vigore oggi.',
      ),
    ).toBeTruthy();
    expect(calls).toContain('POST /api/pazienti/p1/terapie/t1/aggiorna-dati-farmaco');
    await waitFor(() => expect(screen.queryByText(/^Variazione AIFA:/)).toBeNull());
    expect(screen.queryByRole('button', { name: 'Aggiorna dalla banca dati' })).toBeNull();
  });

  it('la segreteria vede la variazione, ma il pulsante è del medico', async () => {
    stub('secretary');
    window.history.pushState({}, '', '/pazienti/p1/terapie/t1');
    render(<App />);
    expect(await screen.findByText(/^Variazione AIFA:/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Aggiorna dalla banca dati' })).toBeNull();
  });
});
