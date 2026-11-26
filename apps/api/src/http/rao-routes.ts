import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client';
import { studio } from '../db/schema';
import { studioDate } from '../prescriptions/rules-check';
import { raoConditionKey, raoTablesFor, type RaoMatch, type RaoSource } from '../rao/tables';
import type { ReferenceData } from '../reference/lookup';

const query = z.object({
  /** I codici del catalogo delle prestazioni della ricetta, separati da virgole. */
  prestazioni: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .transform((s) => [...new Set(s.split(',').map((x) => x.trim()))].filter(Boolean))
    .pipe(z.array(z.string().max(20)).min(1).max(10)),
  data: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export interface RaoRouteDeps {
  db: Database;
  reference: ReferenceData;
  now: () => Date;
  rao: { sources: () => readonly RaoSource[]; includeUnchecked: boolean };
}

/** Una tabella com'è nella risposta: ogni indicazione con la chiave che la ricetta conserva. */
function view({ source, table }: RaoMatch, prestazioni: string[]) {
  return {
    fonte: source.fonte,
    titoloFonte: source.titolo_breve,
    ambito: source.ambito,
    url: source.url,
    controllatoDa: source.controllato_da,
    noteDelDocumento: source.note_del_documento ?? null,
    id: table.id,
    testata: table.testata,
    pagine: table.pagine,
    note: table.note,
    prestazioni,
    righe: table.righe.map((r, i) => ({
      classe: r.classe,
      pediatria: r.pediatria,
      attesa: r.attesa,
      gruppo: r.gruppo ?? null,
      daNota: r.da_nota ?? false,
      nonPreviste: r.non_previste ?? null,
      indicazioni: r.indicazioni.map((v, j) => ({
        chiave: raoConditionKey(source.fonte, table.id, i + 1, j + 1),
        numero: v.numero,
        testo: v.testo,
        altro: v.altro ?? false,
      })),
    })),
  };
}

/**
 * Tabelle RAO delle prestazioni di una ricetta (D285): quelle della regione dello studio al posto
 * delle nazionali; quelle che nessuno ha ancora controllato, solo nell'ambiente di prova. Sono dati
 * pubblici: servono una sessione, non la guardia sulla cartella.
 */
export function registerRaoRoutes(app: FastifyInstance, deps: RaoRouteDeps) {
  app.get('/api/rao/tabelle', async (req) => {
    const q = query.parse(req.query);
    const date = q.data ?? studioDate(deps.now());
    const [st] = await deps.db
      .select({ region: studio.regionName })
      .from(studio)
      .where(eq(studio.id, req.actor!.studioId));
    const scope = { region: st?.region ?? null, includeUnchecked: deps.rao.includeUnchecked };
    const catalog = await deps.reference.serviceLookup(date);
    const sources = deps.rao.sources();
    const found = new Map<string, { match: RaoMatch; prestazioni: string[] }>();
    for (const code of q.prestazioni) {
      const entry = catalog?.(code);
      if (!entry) continue;
      for (const match of raoTablesFor(
        sources,
        { nationalCode: entry.nationalCode, description: entry.description ?? '' },
        scope,
      )) {
        const key = `${match.source.fonte}:${match.table.id}`;
        const f = found.get(key) ?? { match, prestazioni: [] };
        f.prestazioni.push(code);
        found.set(key, f);
      }
    }
    return {
      data: date,
      tabelle: [...found.values()].map((f) => view(f.match, f.prestazioni)),
    };
  });
}
