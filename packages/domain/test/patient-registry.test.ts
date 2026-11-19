import { describe, expect, it } from 'vitest';
import { buildFiscalCode, checkCharacter, checkFiscalCode } from '../src/codice-fiscale';
import {
  doctorChoiceIssues,
  doctorChoiceSchema,
  exemptionSchema,
  fiscalCodeCoherence,
  fiscalCodeProblem,
  lifeDatesIssues,
  patientAdminIssues,
  patientAdminSchema,
  patientIdentitySchema,
  periodsOverlap,
  REMINDER_CHANNELS,
  PATIENT_STATUSES,
} from '../src/patient-registry';

/** Identità inventata: luogo di nascita con la X, che nessun comune ha (D12). */
const IDENTITY = {
  cognome: 'Ginepri',
  nome: 'Albina',
  sesso: 'F' as const,
  nascita: '1961-03-07',
  luogoNascitaCodice: 'X101',
};
const CF = buildFiscalCode({
  surname: IDENTITY.cognome,
  name: IDENTITY.nome,
  birthDate: IDENTITY.nascita,
  sex: IDENTITY.sesso,
  placeCode: IDENTITY.luogoNascitaCodice,
});

/** Omocodia (DM 23/12/1976, art. 6): l'ultima cifra del luogo diventa la sua lettera (0 = L … 9 = V). */
function homocode(code: string): string {
  const letters = 'LMNPQRSTUV';
  const chars = [...code.slice(0, 15)];
  chars[14] = letters[Number(chars[14])]!;
  const first15 = chars.join('');
  return first15 + checkCharacter(first15);
}

describe('dati amministrativi del paziente: schemi comuni (tappa 15)', () => {
  it('il codice fiscale si scrive in maiuscolo e il problema formale si spiega', () => {
    expect(
      patientIdentitySchema.parse({ ...IDENTITY, codiceFiscale: CF.toLowerCase() }),
    ).toMatchObject({ codiceFiscale: CF });
    const wrong = CF.slice(0, 15) + (CF[15] === 'A' ? 'B' : 'A');
    expect(fiscalCodeProblem(wrong)).toBe('il carattere di controllo del codice fiscale non torna');
    expect(fiscalCodeProblem('ABC')).toBe('il codice fiscale ha 16 caratteri');
    expect(fiscalCodeProblem(CF)).toBeNull();
    const parsed = patientIdentitySchema.safeParse({ ...IDENTITY, codiceFiscale: wrong });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe(
      'il carattere di controllo del codice fiscale non torna',
    );
  });

  it('coerenza: nessun avviso quando i dati tornano, anche con l’omocodia', () => {
    expect(fiscalCodeCoherence({ ...IDENTITY, codiceFiscale: CF })).toEqual([]);
    const omo = homocode(CF);
    expect(omo).not.toBe(CF);
    expect(checkFiscalCode(omo).valid).toBe(true);
    expect(fiscalCodeCoherence({ ...IDENTITY, codiceFiscale: omo })).toEqual([]);
    // Senza dati non c'è niente da confrontare; un codice formalmente sbagliato non dà avvisi.
    expect(fiscalCodeCoherence({ codiceFiscale: CF })).toEqual([]);
    expect(fiscalCodeCoherence({ ...IDENTITY, codiceFiscale: 'ABC' })).toEqual([]);
  });

  it('coerenza: una frase per ogni parte che non torna', () => {
    const check = (overrides: Partial<typeof IDENTITY>) =>
      fiscalCodeCoherence({ ...IDENTITY, ...overrides, codiceFiscale: CF });
    expect(check({ cognome: 'Lauretani' })).toEqual([
      'Cognome: dal cognome si ottiene «LRT», nel codice fiscale c’è «GNP»',
    ]);
    expect(check({ nome: 'Orsola' })).toEqual([
      'Nome: dal nome si ottiene «RSL», nel codice fiscale c’è «LBN»',
    ]);
    expect(check({ nascita: '1962-03-07' })).toEqual([
      'Anno di nascita: nel codice fiscale c’è «61», dalla data si ottiene «62»',
    ]);
    expect(check({ nascita: '1961-04-07' })).toEqual([
      'Mese di nascita: nel codice fiscale c’è «C» (marzo), dalla data si ottiene «D» (aprile)',
    ]);
    expect(check({ nascita: '1961-03-08' })).toEqual([
      'Giorno di nascita: nel codice fiscale c’è «47», dalla data e dal sesso si ottiene «48»',
    ]);
    expect(check({ sesso: 'M' as never })).toEqual([
      'Sesso: il codice fiscale indica sesso femminile (giorno aumentato di 40)',
    ]);
    expect(check({ luogoNascitaCodice: 'X102' })).toEqual([
      'Luogo di nascita: nel codice fiscale c’è «X101», il codice del luogo indicato è «X102»',
    ]);
    const male = buildFiscalCode({
      surname: 'Ginepri',
      name: 'Aldo',
      birthDate: '1961-03-07',
      sex: 'M',
      placeCode: 'X101',
    });
    expect(
      fiscalCodeCoherence({ ...IDENTITY, nome: 'Aldo', sesso: 'F', codiceFiscale: male }),
    ).toEqual(['Sesso: il codice fiscale indica sesso maschile (giorno non aumentato di 40)']);
    // Senza il sesso, il giorno si confronta togliendo i 40.
    expect(fiscalCodeCoherence({ codiceFiscale: CF, nascita: '1961-03-07', sesso: null })).toEqual(
      [],
    );
  });

  it('dati amministrativi: CAP, provincia, email, nessun campo sconosciuto', () => {
    expect(patientAdminSchema.parse({ residenzaProvincia: 'to', residenzaCap: '10100' })).toEqual({
      residenzaProvincia: 'TO',
      residenzaCap: '10100',
    });
    expect(patientAdminSchema.safeParse({ residenzaCap: '1010' }).error?.issues[0]?.message).toBe(
      'il CAP ha 5 cifre',
    );
    expect(patientAdminSchema.safeParse({ email: 'non-una-email' }).success).toBe(false);
    expect(patientAdminSchema.safeParse({ telefono: '1', phone: '1' }).success).toBe(false);
  });

  it('dati amministrativi: decesso, causa, canale del promemoria', () => {
    const today = '2026-11-19';
    expect(patientAdminIssues({ stato: 'deceduto' }, today)).toEqual([
      'Per un paziente deceduto serve la data',
    ]);
    expect(patientAdminIssues({ stato: 'deceduto', decedutoIl: '2026-11-20' }, today)).toEqual([
      'La data del decesso è nel futuro',
    ]);
    expect(
      patientAdminIssues(
        { stato: 'attivo', decedutoIl: '2026-01-01', causaDecesso: '410.9' },
        today,
      ),
    ).toEqual([
      'La data del decesso vale solo per un paziente deceduto',
      'La causa del decesso vale solo per un paziente deceduto',
    ]);
    expect(
      patientAdminIssues(
        { stato: 'deceduto', decedutoIl: '2026-01-01', causaDecesso: 'INFARTO' },
        today,
      ),
    ).toEqual(['Causa del decesso: non è nel formato ICD-9-CM (es. 410.9, V17.3)']);
    expect(
      patientAdminIssues(
        { stato: 'deceduto', decedutoIl: '2026-01-01', causaDecesso: 'V17.3' },
        today,
      ),
    ).toEqual([]);
    expect(patientAdminIssues({ canalePromemoria: 'email' }, today)).toEqual([
      'Per il canale scelto serve il recapito (R15)',
      'Serve la data in cui il paziente ha scelto il canale (R15)',
    ]);
    expect(
      patientAdminIssues({ canalePromemoria: 'carta', canaleSceltoIl: '2026-11-20' }, today),
    ).toEqual(['La data della scelta del canale è nel futuro']);
    expect(patientAdminIssues({ canalePromemoria: 'carta', canaleSceltoIl: today }, today)).toEqual(
      [],
    );
  });

  it('date di nascita e di decesso', () => {
    expect(lifeDatesIssues('2026-11-20', null, '2026-11-19')).toEqual([
      'La data di nascita è nel futuro',
    ]);
    expect(lifeDatesIssues('1961-03-07', '1960-01-01', '2026-11-19')).toEqual([
      'La data del decesso viene prima della nascita',
    ]);
    expect(lifeDatesIssues('1961-03-07', '2026-01-01', '2026-11-19')).toEqual([]);
  });

  it('periodi che si sovrappongono, con o senza fine', () => {
    expect(periodsOverlap({ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-01-31' })).toBe(
      true,
    );
    expect(
      periodsOverlap({ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-02-01', to: null }),
    ).toBe(false);
    expect(periodsOverlap({ from: '2026-03-01' }, { from: '2020-01-01', to: '2026-03-01' })).toBe(
      true,
    );
  });

  it('esenzione e scelta del medico: date in ordine, cessazione con motivo', () => {
    expect(
      exemptionSchema.safeParse({ codice: 'p01', dal: '2026-02-01', al: '2026-01-01' }).success,
    ).toBe(false);
    expect(exemptionSchema.parse({ codice: ' p01 ', dal: '2026-01-01' })).toEqual({
      codice: 'P01',
      dal: '2026-01-01',
    });
    const medicoId = '00000000-0000-4000-8000-000000000001';
    const today = '2026-11-19';
    expect(
      doctorChoiceSchema.safeParse({ medicoId, dal: '2026-02-01', cessataIl: '2026-01-01' })
        .success,
    ).toBe(false);
    expect(
      doctorChoiceIssues({ medicoId, dal: '2026-01-01', cessataIl: '2026-02-01' }, today),
    ).toEqual(['Per la cessazione serve il motivo']);
    expect(
      doctorChoiceIssues({ medicoId, dal: '2026-01-01', motivoCessazione: 'Trasferimento' }, today),
    ).toEqual(['Il motivo della cessazione vale solo con la data della cessazione']);
    expect(
      doctorChoiceIssues(
        { medicoId, dal: '2026-01-01', cessataIl: '2026-12-01', motivoCessazione: 'Trasferimento' },
        today,
      ),
    ).toEqual(['La data della cessazione è nel futuro']);
    expect(
      doctorChoiceIssues({ medicoId, dal: '2026-02-01', scadenza: '2026-01-01' }, today),
    ).toEqual(['La scadenza viene dopo la scelta']);
  });

  it('stati e canali hanno chiavi e valori del database distinti', () => {
    for (const list of [PATIENT_STATUSES, REMINDER_CHANNELS]) {
      expect(new Set(list.map((x) => x.key)).size).toBe(list.length);
      expect(new Set(list.map((x) => x.db)).size).toBe(list.length);
    }
  });
});
