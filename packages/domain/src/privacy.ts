/**
 * Privacy della cartella (tappa 9): consensi, deleghe, oscuramento di singoli dati.
 *
 * I consensi del Fascicolo vengono dal DM 7 settembre 2023 («Fascicolo sanitario elettronico
 * 2.0», GU n. 249 del 24/10/2023), letto sulla Gazzetta Ufficiale: la consultazione da parte di
 * terzi si consente separatamente per cura, prevenzione e profilassi internazionale; per la
 * prevenzione, separatamente anche verso chi ha in cura il paziente e verso Regione e Ministero
 * (art. 8, c. 1, e art. 16, c. 1 e 2). I consensi si possono revocare e poi esprimere di nuovo
 * (art. 8, c. 6 e 9). La registrazione nell'Anagrafe consensi e revoche (art. 8, c. 10) passa
 * da INI: qui è un'interfaccia futura (tappa 11), non una chiamata.
 */

export interface ConsentKind {
  key: string;
  label: string;
  /** Dove sta scritto; null per i consensi fuori elenco. */
  source: string | null;
}

const DM_FSE = 'DM 7 settembre 2023';
const DL_179 = 'DL 179/2012, art. 12, c. 2';

export const CONSENT_KINDS = [
  {
    key: 'fse_cura',
    label: 'Fascicolo: consultazione per finalità di cura',
    source: `${DM_FSE}, art. 8, c. 1; ${DL_179}, lett. a)`,
  },
  {
    key: 'fse_prevenzione_curanti',
    label: 'Fascicolo: consultazione per prevenzione, da chi ha in cura il paziente',
    source: `${DM_FSE}, art. 8, c. 1, e art. 16, c. 1; ${DL_179}, lett. a-bis)`,
  },
  {
    key: 'fse_prevenzione_enti',
    label: 'Fascicolo: consultazione per prevenzione, da Regione e Ministero della salute',
    source: `${DM_FSE}, art. 8, c. 1, e art. 16, c. 2; ${DL_179}, lett. a-bis)`,
  },
  {
    key: 'fse_profilassi',
    label: 'Fascicolo: consultazione per profilassi internazionale (Ministero della salute)',
    source: `${DM_FSE}, art. 8, c. 1 e c. 6, lett. c); ${DL_179}, lett. a-ter)`,
  },
  {
    // Tappa 12 (D161): consenso specifico e separato, come per il dossier sanitario.
    key: 'aft_condivisione',
    label: 'Condivisione del riepilogo con i medici dell’AFT',
    source:
      'Garante privacy, Linee guida in materia di Dossier sanitario, 4/6/2015, par. 3 (consenso autonomo e specifico)',
  },
  {
    key: 'aft_condivisione_pregressi',
    label: 'Condivisione con i medici dell’AFT anche dei dati precedenti al consenso',
    source:
      'Garante privacy, Linee guida in materia di Dossier sanitario, 4/6/2015, par. 3 (consenso per il pregresso)',
  },
  { key: 'altro', label: 'Altro consenso', source: null },
] as const satisfies readonly ConsentKind[];
export type ConsentKey = (typeof CONSENT_KINDS)[number]['key'];
export const CONSENT_KEYS = CONSENT_KINDS.map((k) => k.key) as [ConsentKey, ...ConsentKey[]];

export function consentKind(key: string): ConsentKind | undefined {
  return CONSENT_KINDS.find((k) => k.key === key);
}

/** Stato di un consenso: nel database given, refused, revoked. */
export const CONSENT_STATUS = { dato: 'given', negato: 'refused', revocato: 'revoked' } as const;
export type ConsentStatusKey = keyof typeof CONSENT_STATUS;
export const CONSENT_STATUS_LABELS: Record<ConsentStatusKey, string> = {
  dato: 'Dato',
  negato: 'Negato',
  revocato: 'Revocato',
};

/** Il consenso in vigore di ogni tipo: l'ultima espressione registrata. */
export function currentConsents<
  T extends { kind: string; givenOn: string | null; recordedAt: Date | null },
>(rows: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  const order = (r: T) => `${r.givenOn ?? ''}|${r.recordedAt?.toISOString() ?? ''}`;
  for (const r of rows) {
    if (r.kind === 'altro') continue;
    const prev = out.get(r.kind);
    if (!prev || order(r) > order(prev)) out.set(r.kind, r);
  }
  return out;
}

/** Delega valida alla data: registrata, non revocata, nel periodo (R16). */
export function delegationValidOn(
  d: { validFrom: string; validTo: string | null; revokedOn: string | null },
  date: string,
): boolean {
  return (
    (d.revokedOn === null || date < d.revokedOn) &&
    d.validFrom <= date &&
    (d.validTo === null || date <= d.validTo)
  );
}
