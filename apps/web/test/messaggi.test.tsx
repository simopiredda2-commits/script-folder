import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorMessage } from '../src/components/common';
import { ApiError } from '../src/lib/api';
import { sentence } from '../src/lib/format';

/**
 * Messaggi del servizio seguiti da un collegamento (audit D259): la frase si chiude col punto
 * prima del collegamento, anche quando finisce con le virgolette.
 */

afterEach(cleanup);

describe('messaggi seguiti da un collegamento (audit D259)', () => {
  it('la frase si chiude col punto, una volta sola, dopo le virgolette', () => {
    expect(sentence('Codice di sessione non attivo: attivalo in «Credenziali dei servizi»')).toBe(
      'Codice di sessione non attivo: attivalo in «Credenziali dei servizi».',
    );
    expect(sentence('Già chiusa.')).toBe('Già chiusa.');
    expect(sentence('Davvero?')).toBe('Davvero?');
    expect(sentence('Spazi in fondo  ')).toBe('Spazi in fondo.');
  });

  it('errore di credenziali: il punto, poi «Apri «Credenziali dei servizi»»', () => {
    const error = new ApiError(
      409,
      'Codice di sessione RUPAR Piemonte non attivo: attivalo in «Credenziali dei servizi»',
      { codice: 'SESSIONE_MANCANTE' },
    );
    render(
      <MemoryRouter>
        <ErrorMessage error={error} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'Codice di sessione RUPAR Piemonte non attivo: attivalo in «Credenziali dei servizi». Apri «Credenziali dei servizi»',
    );
  });

  it('gli altri errori restano come li scrive il servizio', () => {
    render(
      <MemoryRouter>
        <ErrorMessage error={new ApiError(403, 'Azione riservata al medico')} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert').textContent).toBe('Azione riservata al medico');
  });
});
