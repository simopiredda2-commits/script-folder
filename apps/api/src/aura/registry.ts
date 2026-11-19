import type { AuraRegistry } from '@mmg/integrations';

/**
 * Anagrafica da AURA (D198): residenza, domicilio, ASL, distretto e decesso non entrano da soli
 * nella cartella. Il programma li confronta con i dati del paziente e mostra le differenze, che
 * medico o segreteria confermano (con i controlli del pannello amministrativo) o scelgono di non
 * usare. Un valore non usato torna a vedersi solo se AURA ne manda un altro.
 */

/** Campi confrontati: nome nel pannello amministrativo, etichetta, campo di AURA, colonna. */
export const REGISTRY_FIELDS = [
  {
    campo: 'residenzaVia',
    etichetta: 'Residenza: via o piazza',
    aura: 'residenceStreet',
    column: 'residenceStreet',
  },
  {
    campo: 'residenzaCivico',
    etichetta: 'Residenza: numero civico',
    aura: 'residenceNumber',
    column: 'residenceNumber',
  },
  {
    campo: 'residenzaCap',
    etichetta: 'Residenza: CAP',
    aura: 'residencePostalCode',
    column: 'residencePostalCode',
  },
  {
    campo: 'residenzaComune',
    etichetta: 'Residenza: comune',
    aura: 'residenceTown',
    column: 'residenceTown',
  },
  {
    campo: 'residenzaProvincia',
    etichetta: 'Residenza: provincia',
    aura: 'residenceProvince',
    column: 'residenceProvince',
  },
  { campo: 'domicilio', etichetta: 'Domicilio', aura: 'domicile', column: 'domicile' },
  { campo: 'asl', etichetta: 'ASL di assistenza', aura: 'asl', column: 'asl' },
  { campo: 'distretto', etichetta: 'Distretto', aura: 'district', column: 'district' },
] as const;

export type RegistryField = (typeof REGISTRY_FIELDS)[number]['campo'] | 'decesso';

export const REGISTRY_FIELD_KEYS: [RegistryField, ...RegistryField[]] = [
  'decesso',
  ...REGISTRY_FIELDS.map((f) => f.campo),
];

/** I dati del paziente che si confrontano con AURA. */
export interface RegistryPatient {
  residenceStreet: string | null;
  residenceNumber: string | null;
  residencePostalCode: string | null;
  residenceTown: string | null;
  residenceProvince: string | null;
  domicile: string | null;
  asl: string | null;
  district: string | null;
  status: 'active' | 'revoked' | 'deceased' | 'temporary';
  deceasedOn: string | null;
}

export interface RegistryDifference {
  campo: RegistryField;
  etichetta: string;
  /** Il dato nella cartella; per il decesso, la data se il paziente risulta deceduto. */
  nellaCartella: string | null;
  inAura: string;
}

/** Maiuscole, minuscole e spazi non fanno una differenza: «Via Roma» e «VIA  ROMA» sono uguali. */
const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').trim().replace(/\s+/g, ' ').toUpperCase() ===
  (b ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

/**
 * Differenze fra l'anagrafica di AURA e la cartella. Un campo vuoto in AURA non propone di
 * svuotare quello della cartella; un valore che medico o segreteria hanno scelto di non usare non
 * si ripropone.
 */
export function registryDifferences(
  registry: AuraRegistry | null | undefined,
  p: RegistryPatient,
  dismissed: Record<string, string>,
): RegistryDifference[] {
  if (!registry) return [];
  const out: RegistryDifference[] = [];
  for (const f of REGISTRY_FIELDS) {
    const inAura = registry[f.aura]?.trim();
    if (!inAura) continue;
    const mine = p[f.column];
    if (same(inAura, mine) || dismissed[f.campo] === inAura) continue;
    out.push({ campo: f.campo, etichetta: f.etichetta, nellaCartella: mine, inAura });
  }
  const died = registry.deceasedOn;
  if (died && !(p.status === 'deceased' && p.deceasedOn === died) && dismissed['decesso'] !== died)
    out.push({
      campo: 'decesso',
      etichetta: 'Decesso',
      nellaCartella: p.status === 'deceased' ? p.deceasedOn : null,
      inAura: died,
    });
  return out;
}

/** La stessa anagrafica, campo per campo: l'ordine delle chiavi nel database non conta. */
export function sameRegistry(
  a: AuraRegistry | null | undefined,
  b: AuraRegistry | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    REGISTRY_FIELDS.every((f) => (a[f.aura] ?? null) === (b[f.aura] ?? null)) &&
    (a.deceasedOn ?? null) === (b.deceasedOn ?? null)
  );
}

/** Il corpo per il pannello amministrativo che usa i dati di AURA scelti. */
export function adminBodyFor(diffs: readonly RegistryDifference[]): Record<string, string> {
  const body: Record<string, string> = {};
  for (const d of diffs) {
    if (d.campo === 'decesso') {
      body['stato'] = 'deceduto';
      body['decedutoIl'] = d.inAura;
    } else body[d.campo] = d.inAura;
  }
  return body;
}

const itDate = (iso: string) => iso.split('-').reverse().join('/');

/** Le differenze arrivate, in parole, per le variazioni da AURA. */
export function registryText(diffs: readonly RegistryDifference[]): string {
  return `Anagrafica diversa in AURA, da confermare: ${diffs
    .map((d) =>
      d.campo === 'decesso' ? `decesso il ${itDate(d.inAura)}` : `${d.etichetta} «${d.inAura}»`,
    )
    .join('; ')}`;
}
