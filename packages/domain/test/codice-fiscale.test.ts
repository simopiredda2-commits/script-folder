import { describe, expect, it } from 'vitest';
import {
  birthCode,
  buildFiscalCode,
  checkCharacter,
  checkFiscalCode,
  nameCode,
  ODD_VALUES,
  surnameCode,
} from '../src/codice-fiscale';

/**
 * Art. 7, punto 2, copiato alla lettera dal testo su def.finanze.it (18/11/2026): è una seconda
 * trascrizione indipendente da quella del codice.
 */
const ART7_DISPARI = `A o zero =  1 B o 1    =  0 C o 2    =  5 D o 3    =  7 E o 4    =  9 F o 5
 = 13 G o 6    = 15 H o 7    = 17 I o 8    = 19 J o 9    = 21 K        =  2 L
 =  4 M        = 18 N        = 20 O        = 11 P        =  3 Q        =  6 R
 =  8 S        = 12 T        = 14 U        = 16 V        = 10 W        = 22 X
 =  25 Y         = 24 Z        = 23`;

describe('codice fiscale (DM 23/12/1976)', () => {
  it('la tabella dei caratteri dispari è quella del testo del decreto', () => {
    const fromDecree = Object.fromEntries(
      [...ART7_DISPARI.replace(/\s+/g, ' ').matchAll(/([A-Z])(?: o (?:zero|\d))? = (\d+)/g)].map(
        (m) => [m[1]!, Number(m[2])],
      ),
    );
    expect(Object.keys(fromDecree)).toHaveLength(26);
    expect(ODD_VALUES).toEqual(fromDecree);
  });

  it('i valori dei caratteri dispari sono una permutazione di 0–25', () => {
    expect(Object.values(ODD_VALUES).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 26 }, (_, i) => i),
    );
  });

  it('carattere di controllo: esempio pubblicato da fiscomania.com (resto 7 → H)', () => {
    // Dispari BBT2H212 = 46, pari BTT01X2 = 65, totale 111, resto di 111/26 = 7 → H.
    expect(checkCharacter('BBBTTT20H12X122')).toBe('H');
  });

  it('cognome, art. 3: consonanti, poi vocali, poi X', () => {
    expect(surnameCode('Rota')).toBe('RTO'); // due consonanti e la prima vocale
    expect(surnameCode('Sala')).toBe('SLA');
    expect(surnameCode('Leone')).toBe('LNE');
    expect(surnameCode('Re')).toBe('REX'); // una consonante e una vocale
    expect(surnameCode('Oa')).toBe('OAX'); // due sole vocali
    expect(surnameCode('De Santis')).toBe('DSN'); // cognome composto: senza spazi
  });

  it('nome, art. 4: con quattro o più consonanti la prima, la terza e la quarta', () => {
    expect(nameCode('Gianfranco')).toBe('GFR');
    expect(nameCode('Lina')).toBe('LNI');
    expect(nameCode('Ettore')).toBe('TTR'); // tre consonanti
    expect(nameCode('Ugo')).toBe('GUO'); // una consonante e due vocali
    expect(nameCode('Ida')).toBe('DIA');
  });

  it('data e sesso, art. 5: lettera del mese e giorno + 40 per le donne', () => {
    expect(birthCode('1980-01-05', 'M')).toBe('80A05');
    expect(birthCode('1980-12-31', 'F')).toBe('80T71');
    expect(birthCode('2001-06-09', 'F')).toBe('01H49');
  });

  it('un codice costruito passa il controllo formale', () => {
    const cf = buildFiscalCode({
      surname: 'Rota',
      name: 'Lina',
      birthDate: '1950-03-14',
      sex: 'F',
      placeCode: 'X101',
    });
    expect(cf).toMatch(/^RTOLNI50C54X101[A-Z]$/);
    expect(checkFiscalCode(cf)).toEqual({ valid: true });
  });

  it('il controllo formale rifiuta lunghezza, struttura, giorno e carattere di controllo', () => {
    const cf = buildFiscalCode({
      surname: 'Riva',
      name: 'Ettore',
      birthDate: '1975-10-02',
      sex: 'M',
      placeCode: 'X202',
    });
    expect(checkFiscalCode(cf.slice(0, 15)).problem).toBe('lunghezza');
    expect(checkFiscalCode(`1${cf.slice(1)}`).problem).toBe('struttura');
    const wrong = cf[15] === 'A' ? 'B' : 'A';
    expect(checkFiscalCode(cf.slice(0, 15) + wrong).problem).toBe('controllo');
    const day35 = cf.slice(0, 9) + '35' + cf.slice(11, 15);
    expect(checkFiscalCode(day35 + checkCharacter(day35)).problem).toBe('giorno');
  });

  it('riconosce l’omocodia (art. 6): cifre sostituite da lettere', () => {
    const base = buildFiscalCode({
      surname: 'Riva',
      name: 'Ettore',
      birthDate: '1975-10-02',
      sex: 'M',
      placeCode: 'X202',
    });
    // Ultima cifra del luogo (2) sostituita con N, poi carattere di controllo ricalcolato.
    const omo15 = base.slice(0, 14) + 'N';
    expect(checkFiscalCode(omo15 + checkCharacter(omo15))).toEqual({ valid: true });
  });
});
