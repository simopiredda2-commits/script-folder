import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendPanel } from '../src/components/SendPanel';
import {
  choiceBody,
  choiceChanged,
  choiceFromTherapy,
  choiceSummary,
  NO_CHOICE,
  TherapyChoiceFields,
  type ChoiceDraft,
} from '../src/components/TherapyChoiceFields';
import { SessionProvider } from '../src/lib/session';

/**
 * Il tipo di terapia sulla riga della ricetta (D282, D283): i campi della riga, che cosa va al
 * servizio, e la decisione del medico sulle proposte della segreteria. Dati inventati.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const chronic = choiceFromTherapy({
  kind: 'chronic',
  endOn: '2027-01-31',
  suggestedS: false,
  hospitalH: false,
  notReimbursable: false,
  suggestedByName: 'Dr. di prima',
});

describe('che cosa della scelta va al servizio (D283)', () => {
  it('dalla scheda della terapia; uguale alla scheda non va', () => {
    expect(chronic).toEqual({
      ...NO_CHOICE,
      kind: 'chronic',
      endOn: '2027-01-31',
      suggestedByName: 'Dr. di prima',
    });
    expect(choiceChanged(chronic, chronic)).toBe(false);
    expect(choiceBody(chronic, chronic)).toBeNull();
    // La fine conta solo per il ciclo, il suggeritore solo con la S.
    expect(choiceChanged({ ...chronic, endOn: '' }, chronic)).toBe(false);
    expect(choiceChanged({ ...chronic, suggestedByName: 'Altro' }, chronic)).toBe(false);
    expect(choiceChanged({ ...chronic, typology: 'H' }, chronic)).toBe(true);
  });

  it('un farmaco nuovo: la scelta va solo con il tipo', () => {
    expect(choiceBody(NO_CHOICE, undefined)).toBeNull();
    expect(
      choiceBody(
        {
          ...NO_CHOICE,
          kind: 'cycle',
          endOn: '2027-02-28',
          typology: 'S',
          suggestedByName: ' Dr. Specialista ',
        },
        undefined,
      ),
    ).toEqual({
      kind: 'cycle',
      endOn: '2027-02-28',
      typology: 'S',
      notReimbursable: false,
      suggestedByName: 'Dr. Specialista',
      suggestedByFacility: null,
      suggestedOn: null,
    });
  });

  it('la riga chiusa dice la scelta solo se cambia qualcosa', () => {
    expect(choiceSummary(chronic, chronic)).toBeNull();
    expect(choiceSummary({ ...chronic, kind: 'cycle', endOn: '2027-03-31' }, chronic)).toBe(
      'terapia ciclo fino al 31/03/2027',
    );
    expect(
      choiceSummary({ ...NO_CHOICE, kind: 'as_needed', notReimbursable: true }, undefined),
    ).toBe('terapia al bisogno · non rimborsabile SSN');
  });
});

/** I campi con lo stato tenuto dalla prova, come nell'editor. */
function Fields({
  base,
  white = false,
  proposal = false,
}: {
  base?: ChoiceDraft;
  white?: boolean;
  proposal?: boolean;
}) {
  const [value, setValue] = useState<ChoiceDraft>(base ?? NO_CHOICE);
  return (
    <TherapyChoiceFields
      id="r1"
      value={value}
      {...(base ? { base } : {})}
      white={white}
      proposal={proposal}
      onChange={(patch) => setValue((v) => ({ ...v, ...patch }))}
    />
  );
}

describe('i campi del tipo di terapia sulla riga (D283)', () => {
  it('un farmaco nuovo: occasionale finché non si sceglie il tipo; poi la terapia si crea', async () => {
    const user = userEvent.setup();
    render(<Fields />);
    expect(screen.getByText(/la terapia in cartella non si crea/)).toBeTruthy();
    expect(screen.queryByLabelText('Tipologia')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Tipo di terapia'), 'cycle');
    expect(screen.getByLabelText('Fine del ciclo')).toBeTruthy();
    expect(screen.getByText(/Alla firma si crea la terapia in cartella/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Tipologia'), 'S');
    expect(screen.getByLabelText('Medico suggeritore')).toBeTruthy();
    // In ricetta SSN la casella non si mette: «Non rimborsabile SSN» va in ricetta bianca.
    const box = screen.getByLabelText<HTMLInputElement>(/Non rimborsabile SSN/);
    expect(box.disabled).toBe(true);
  });

  it('in ricetta bianca «Non rimborsabile SSN» si segna', async () => {
    const user = userEvent.setup();
    render(<Fields white />);
    await user.selectOptions(screen.getByLabelText('Tipo di terapia'), 'chronic');
    const box = screen.getByLabelText<HTMLInputElement>(/Non rimborsabile SSN/);
    expect(box.disabled).toBe(false);
    await user.click(box);
    expect(box.checked).toBe(true);
  });

  it('una terapia collegata: niente «occasionale»; un cambio è un aggiornamento, o una proposta', async () => {
    const user = userEvent.setup();
    render(<Fields base={chronic} proposal />);
    const kind = screen.getByLabelText<HTMLSelectElement>('Tipo di terapia');
    expect([...kind.options].map((o) => o.value)).toEqual(['chronic', 'cycle', 'as_needed']);
    expect(screen.getByText('Come nella scheda della terapia.')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Tipologia'), 'H');
    expect(screen.getByText(/È una proposta per il medico/)).toBeTruthy();
  });
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('la proposta della segreteria nel pannello della firma (D283)', () => {
  it('il medico firma solo dopo aver deciso; la decisione parte con la firma', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const path = url.split('?')[0]!;
        if (path === '/api/io')
          return Promise.resolve(
            json(200, {
              id: 'u1',
              nome: 'Medico di prova',
              ruoli: [{ codice: 'owner_doctor', nome: 'Medico titolare' }],
              postazione: 'Studio',
              archivio: null,
            }),
          );
        if (path === '/api/ricette/r1/controlla')
          return Promise.resolve(
            json(200, {
              versioneRegole: 'prova-1',
              bloccanti: 1,
              problemi: [
                {
                  ruleId: 'PROPOSTA',
                  severity: 'warn',
                  needs: 'therapy_decision',
                  lineId: 'l1',
                  message:
                    'La segreteria propone per la terapia: Farmaco di prova: cronica, ricovero (H)',
                },
              ],
            }),
          );
        if (path === '/api/ricette/r1/firma-e-invia') {
          bodies.push(JSON.parse(init?.body as string));
          return Promise.resolve(
            json(200, { esito: 'accepted', nre: '0101A0000000001', messaggio: null }),
          );
        }
        return Promise.resolve(json(404, { errore: 'Non trovato' }));
      }),
    );
    const user = userEvent.setup();
    render(
      <SessionProvider>
        <MemoryRouter>
          <SendPanel prescriptionId="r1" status="to_sign" lineNames={{ l1: 'Farmaco di prova' }} />
        </MemoryRouter>
      </SessionProvider>,
    );
    await screen.findByText(/Proposta della segreteria · Chiede la decisione del medico/);
    // Nessun motivo da scrivere: si decide, non si motiva.
    expect(screen.queryByLabelText(/Motivo per procedere nonostante l’avviso PROPOSTA/)).toBeNull();
    const sign = screen.getByRole<HTMLButtonElement>('button', { name: 'Firma e invia' });
    expect(sign.disabled).toBe(true);
    expect(screen.getByText('Per firmare, decidi sulle proposte della segreteria.')).toBeTruthy();
    await user.click(screen.getByLabelText(/Conferma la proposta/));
    await waitFor(() => expect(sign.disabled).toBe(false));
    await user.click(sign);
    await screen.findByText(/Ricetta inviata/);
    expect(bodies).toEqual([{ confermeNote: [], motivi: {}, proposte: { l1: 'conferma' } }]);
  });
});
