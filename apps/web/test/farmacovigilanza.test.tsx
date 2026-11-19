import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LINKS } from '../src/lib/links';
import { PharmacovigilanceLinks } from '../src/pages/HistoryPages';

const SAVED = { ...LINKS };

describe('segnalazione di farmacovigilanza (D82, D202)', () => {
  afterEach(() => {
    cleanup();
    Object.assign(LINKS, SAVED);
  });

  it('gli indirizzi sono quelli verificati alla fonte, sul sito di AIFA, in https', () => {
    expect(LINKS).toEqual({
      pharmacovigilanceReport: 'https://www.aifa.gov.it/content/segnalazioni-reazioni-avverse',
      pharmacovigilanceOnline: 'https://servizionline.aifa.gov.it/schedasegnalazioni/#/',
    });
    for (const url of Object.values(LINKS)) {
      const u = new URL(url!);
      expect(u.protocol).toBe('https:');
      expect(u.hostname === 'aifa.gov.it' || u.hostname.endsWith('.aifa.gov.it')).toBe(true);
    }
  });

  it('due collegamenti in una frase, in una scheda nuova e senza l’indirizzo della cartella', () => {
    render(<PharmacovigilanceLinks />);
    const howTo = screen.getByRole('link', {
      name: 'come segnalare una sospetta reazione avversa (AIFA)',
    });
    const online = screen.getByRole('link', { name: 'segnala online (AIFA)' });
    expect(howTo.getAttribute('href')).toBe(LINKS.pharmacovigilanceReport);
    expect(online.getAttribute('href')).toBe(LINKS.pharmacovigilanceOnline);
    for (const a of [howTo, online]) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noreferrer');
      // Dentro un paragrafo: l'eccezione dei bersagli per i collegamenti in una frase.
      expect(a.closest('p')).toBeTruthy();
    }
    expect(howTo.closest('p')!.textContent).toBe(
      'Segnalazione di farmacovigilanza: come segnalare una sospetta reazione avversa (AIFA) oppure segnala online (AIFA). Le pagine si aprono in una scheda nuova.',
    );
  });

  it('senza un indirizzo verificato non inventa: dice «da completare»', () => {
    LINKS.pharmacovigilanceReport = null;
    LINKS.pharmacovigilanceOnline = null;
    render(<PharmacovigilanceLinks />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/farmacovigilanza: da completare/)).toBeTruthy();
  });
});
