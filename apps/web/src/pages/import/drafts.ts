import type {
  CatalogDestination,
  ColumnRef,
  FieldDraft,
  MappingPayload,
  PartDraft,
  TableInfo,
} from './types';

/** Bozze della mappatura nell'interfaccia e il corpo che il servizio vuole (tappa 15). */

let counter = 0;
export const newPartKey = () => `parte-${++counter}`;

export const tableKey = (tabella: string, intestazione: number) => `${tabella}|${intestazione}`;

export function emptyField(): FieldDraft {
  return {
    modo: 'nessuno',
    colonna: '',
    costante: '',
    formatoData: 'testo',
    corrispondenze: {},
    suggerito: false,
  };
}

/** Una destinazione di un foglio, con le colonne suggerite dal programma (solo suggerimenti). */
export function draftFor(
  table: TableInfo,
  destination: CatalogDestination | undefined,
  suggestions: Record<string, ColumnRef> | null | undefined,
): PartDraft {
  const campi: Record<string, FieldDraft> = {};
  for (const f of destination?.fields ?? []) {
    const s = suggestions?.[f.key];
    campi[f.key] = s
      ? { ...emptyField(), modo: 'colonna', colonna: s.lettera, suggerito: true }
      : emptyField();
  }
  return {
    key: newPartKey(),
    tabella: table.nome,
    intestazione: table.intestazione,
    destinazione: destination?.key ?? '',
    filtroColonna: '',
    filtroValori: '',
    campi,
  };
}

/** Valori del filtro: uno per riga. */
export const filterValues = (s: string) =>
  s
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);

function ref(table: TableInfo | undefined, letter: string, withName: boolean): ColumnRef {
  const name = table?.colonne.find((c) => c.lettera === letter)?.nome;
  return withName && name ? { lettera: letter, nome: name } : { lettera: letter };
}

/** Il corpo della mappatura per anteprima, prova, importazione e profili. */
export function toMapping(
  parts: PartDraft[],
  tables: Record<string, TableInfo>,
  catalog: CatalogDestination[],
  programma: string,
): MappingPayload {
  return {
    parti: parts.map((p) => {
      const table = tables[tableKey(p.tabella, p.intestazione)];
      const dest = catalog.find((d) => d.key === p.destinazione);
      const named = p.intestazione > 0;
      const campi: MappingPayload['parti'][number]['campi'] = {};
      for (const [k, f] of Object.entries(p.campi)) {
        const field = dest?.fields.find((x) => x.key === k);
        if (!field || f.modo === 'nessuno') continue;
        if (f.modo === 'colonna' && !f.colonna) continue;
        if (f.modo === 'costante' && !f.costante.trim()) continue;
        const corr = Object.fromEntries(
          Object.entries(f.corrispondenze).filter(([from, to]) => from.trim() && to !== undefined),
        );
        campi[k] = {
          ...(f.modo === 'colonna'
            ? { colonna: ref(table, f.colonna, named) }
            : { costante: f.costante }),
          ...(field.kind === 'date' ? { formatoData: f.formatoData } : {}),
          ...(f.modo === 'colonna' && Object.keys(corr).length ? { corrispondenze: corr } : {}),
        };
      }
      const values = filterValues(p.filtroValori);
      return {
        tabella: p.tabella,
        intestazione: p.intestazione,
        destinazione: p.destinazione,
        filtro:
          p.filtroColonna && values.length
            ? { colonna: ref(table, p.filtroColonna, named), valori: values }
            : null,
        campi,
      };
    }),
    programma: programma.trim() || null,
  };
}

/** Le bozze da una mappatura salvata (profilo): le colonne si ritrovano per nome, se c'è. */
export function fromMapping(
  m: MappingPayload,
  tables: TableInfo[],
  catalog: CatalogDestination[],
): PartDraft[] {
  return m.parti
    .filter((p) => tables.some((t) => t.nome === p.tabella))
    .map((p) => {
      const table = tables.find((t) => t.nome === p.tabella)!;
      const letterOf = (r: ColumnRef) =>
        (r.nome ? table.colonne.find((c) => c.nome === r.nome)?.lettera : undefined) ?? r.lettera;
      const dest = catalog.find((d) => d.key === p.destinazione);
      const campi: Record<string, FieldDraft> = {};
      for (const f of dest?.fields ?? []) {
        const m2 = p.campi[f.key];
        campi[f.key] = !m2
          ? emptyField()
          : m2.colonna
            ? {
                ...emptyField(),
                modo: 'colonna',
                colonna: letterOf(m2.colonna),
                formatoData: m2.formatoData ?? 'testo',
                corrispondenze: m2.corrispondenze ?? {},
              }
            : {
                ...emptyField(),
                modo: 'costante',
                costante: m2.costante ?? '',
                formatoData: m2.formatoData ?? 'testo',
              };
      }
      return {
        key: newPartKey(),
        tabella: p.tabella,
        intestazione: table.intestazione,
        destinazione: p.destinazione,
        filtroColonna: p.filtro ? letterOf(p.filtro.colonna) : '',
        filtroValori: p.filtro ? p.filtro.valori.join('\n') : '',
        campi,
      };
    });
}

/** Che cosa manca prima dell'anteprima: destinazioni e campi obbligatori. */
export function missingRequired(
  parts: PartDraft[],
  catalog: CatalogDestination[],
): { part: PartDraft; label: string }[] {
  const out: { part: PartDraft; label: string }[] = [];
  for (const p of parts) {
    const dest = catalog.find((d) => d.key === p.destinazione);
    if (!dest) {
      out.push({ part: p, label: 'la destinazione' });
      continue;
    }
    for (const f of dest.fields) {
      const d = p.campi[f.key];
      const set =
        d && ((d.modo === 'colonna' && d.colonna) || (d.modo === 'costante' && d.costante.trim()));
      if (f.required && !set) out.push({ part: p, label: f.label });
    }
  }
  return out;
}
