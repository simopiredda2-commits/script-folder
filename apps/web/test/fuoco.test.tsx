import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorMessage } from '../src/components/common';
import { ApiError } from '../src/lib/api';
import { SessionProvider } from '../src/lib/session';
import { Problems } from '../src/pages/CertificatesPage';
import { LoginPage } from '../src/pages/LoginPage';

/**
 * Il fuoco dopo un'azione che spegne o toglie il pulsante premuto (WCAG 2.4.3, audit D259): va al
 * campo da riscrivere o all'errore, non alla pagina. Servizio finto, dati inventati.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function service(answers: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
      return Promise.resolve(answers[key]?.() ?? json(401, { errore: 'Accesso richiesto' }));
    }),
  );
}

function login() {
  render(
    <SessionProvider>
      <LoginPage />
    </SessionProvider>,
  );
}

describe('accesso: dopo un errore il fuoco torna al campo (audit D259)', () => {
  it('password sbagliata: il fuoco sulla password, già selezionata', async () => {
    service({
      'POST /api/accesso': () => json(401, { errore: 'Nome utente o password non validi' }),
    });
    login();
    await userEvent.type(await screen.findByLabelText('Nome utente'), 'medico');
    await userEvent.type(screen.getByLabelText('Password'), 'sbagliata');
    await userEvent.click(screen.getByRole('button', { name: 'Continua' }));
    await screen.findByText('Nome utente o password non validi');
    const password = screen.getByLabelText<HTMLInputElement>('Password');
    await waitFor(() => expect(document.activeElement).toBe(password));
    expect([password.selectionStart, password.selectionEnd]).toEqual([0, 'sbagliata'.length]);
  });

  it('codice non valido: il fuoco sul codice, già selezionato', async () => {
    service({
      'POST /api/accesso': () => json(200, { passo: 'codice', passaggio: 't1' }),
      'POST /api/accesso/codice': () => json(401, { errore: 'Codice non valido' }),
    });
    login();
    await userEvent.type(await screen.findByLabelText('Nome utente'), 'medico');
    await userEvent.type(screen.getByLabelText('Password'), 'giusta');
    await userEvent.click(screen.getByRole('button', { name: 'Continua' }));
    await userEvent.type(await screen.findByLabelText('Codice a 6 cifre'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Entra' }));
    await screen.findByText('Codice non valido');
    const code = screen.getByLabelText<HTMLInputElement>('Codice a 6 cifre');
    await waitFor(() => expect(document.activeElement).toBe(code));
    expect([code.selectionStart, code.selectionEnd]).toEqual([0, 6]);
  });
});

describe('errori che prendono il fuoco (audit D259)', () => {
  it('con «focus» l’errore prende il fuoco; senza, no', () => {
    const error = new ApiError(409, 'Il servizio ha rifiutato la richiesta');
    const first = render(
      <MemoryRouter>
        <ErrorMessage error={error} focus />
      </MemoryRouter>,
    );
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    first.unmount();
    render(
      <MemoryRouter>
        <ErrorMessage error={error} />
      </MemoryRouter>,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it('certificato: l’elenco di ciò che va corretto prende il fuoco', () => {
    const error = new ApiError(422, 'Il certificato non va', {
      problemi: [{ code: 'E01', message: 'Manca la data di inizio' }],
    });
    render(<Problems error={error} />);
    const alert = screen.getByRole('alert');
    // Il codice in fondo, non davanti al messaggio (suggerimento S8).
    expect(alert.textContent).toBe(
      'Da correggere prima dell’invio:Manca la data di inizio (codice E01)',
    );
    expect(document.activeElement).toBe(alert);
  });
});
