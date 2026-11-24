import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { encode } from 'uqr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionProvider } from '../src/lib/session';
import { LoginPage } from '../src/pages/LoginPage';

/**
 * Primo accesso (suggerimento S2 dell'audit, D259): oltre alla chiave da scrivere a mano, il codice
 * QR dell'indirizzo otpauth da inquadrare con l'app. Disegnato nel browser, senza servizi esterni.
 * Servizio finto, segreto inventato.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const OTPAUTH = `otpauth://totp/Prova:medico?secret=${SECRET}&issuer=Prova`;

describe('primo accesso: codice QR e chiave (suggerimento S2)', () => {
  it('il codice QR disegna l’indirizzo otpauth; la chiave resta, a gruppi di quattro', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url === '/api/accesso'
            ? new Response(
                JSON.stringify({
                  passo: 'attiva-secondo-fattore',
                  passaggio: 't1',
                  segreto: SECRET,
                  otpauth: OTPAUTH,
                }),
                { status: 200 },
              )
            : new Response(JSON.stringify({ errore: 'Accesso richiesto' }), { status: 401 }),
        ),
      ),
    );
    render(
      <SessionProvider>
        <LoginPage />
      </SessionProvider>,
    );
    await userEvent.type(await screen.findByLabelText('Nome utente'), 'medico');
    await userEvent.type(screen.getByLabelText('Password'), 'giusta');
    await userEvent.click(screen.getByRole('button', { name: 'Continua' }));
    const qr = await screen.findByRole('img', {
      name: 'Codice QR da inquadrare con l’app di autenticazione',
    });
    // Lo stesso disegno che dà l'indirizzo otpauth, modulo per modulo.
    const { size, data } = encode(OTPAUTH, { ecc: 'M', border: 4 });
    expect(qr.getAttribute('viewBox')).toBe(`0 0 ${size} ${size}`);
    const dark = data.flat().filter(Boolean).length;
    expect(qr.querySelector('path')!.getAttribute('d')!.match(/M/g)).toHaveLength(dark);
    expect(screen.getByLabelText("Codice da inserire nell'app").textContent).toBe(
      'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP',
    );
  });
});
