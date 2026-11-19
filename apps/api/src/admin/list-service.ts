import {
  can,
  CONTACT_KINDS,
  normalizeServiceCode,
  packageServicesOf,
  parseStudioListData,
  STUDIO_LIST_KIND_KEYS,
  STUDIO_LIST_KINDS,
  STUDIO_LIST_LIMITS,
  STUDIO_LIST_SCHEMAS,
  studioListDuplicate,
  studioListKey,
  studioListLabel,
  type PackageService,
  type StudioListData,
  type StudioListKind,
} from '@mmg/domain';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { logAccess } from '../audit/access-log';
import type { Actor } from '../auth/service';
import { appUser, refService, studioListItem } from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import { studioGrantsOf } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';
import { ReferenceData } from '../reference/lookup';
import type { AdminDeps } from './deps';

/**
 * Elenchi dello studio (tappa 14): medici suggeritori, posologie, pacchetti di prestazioni,
 * contatti utili. Li legge ogni utente dello studio, segreteria compresa, perché li usa; li
 * scrivono i titolari, l'amministratore e il sostituto mentre ha un'autorizzazione attiva su un
 * archivio dello studio (`studio.lists`, D181). I campi di ogni tipo li controlla il
 * dominio (`@mmg/domain`, studio-lists). Una voce non si cancella: si archivia. Ogni scrittura va
 * nel registro come «amministrazione», con i campi cambiati; anche i tentativi negati.
 */

const kindEnum = z.enum(STUDIO_LIST_KIND_KEYS, {
  error: 'Tipo di elenco: suggeritore, posologia, pacchetto o contatto',
});

export const listQuery = z.object({
  tipo: kindEnum.optional(),
  /** Data a cui cercare nel catalogo le prestazioni dei pacchetti (A5); per difetto oggi. */
  data: z.iso.date({ error: 'Data: nel formato AAAA-MM-GG' }).optional(),
});
export const createBody = z.strictObject({ tipo: kindEnum, dati: z.unknown() });
export const updateBody = z.strictObject({
  dati: z.record(z.string(), z.unknown(), {
    error: 'Dati: i campi da cambiare, ognuno con il suo valore',
  }),
});

/** Una prestazione del catalogo, come la dà la ricerca delle prestazioni (D153). */
export interface CatalogService {
  regionalCode: string;
  nationalCode: string | null;
  description: string;
  branch: string | null;
  fee: string | null;
  notes: string | null;
}

type ItemRow = typeof studioListItem.$inferSelect;

const NO_CATALOG =
  'Nessun catalogo delle prestazioni in uso: un pacchetto si compone dal catalogo. Il catalogo si importa con le banche dati (Strumenti › Banche dati)';
const DENIED = 'Gli elenchi dello studio li modificano i medici e l’amministratore dello studio';
/** Il sostituto senza un'autorizzazione attiva su un archivio dello studio (D181). */
const DENIED_WITHOUT_GRANT =
  'Il sostituto modifica gli elenchi dello studio solo mentre ha un’autorizzazione attiva su un archivio dello studio';

/** Controlla un corpo: i problemi tutti insieme, ognuno detto in chiaro. */
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  const problems = [...new Set(r.error.issues.map((i) => i.message))];
  throw new HttpError(400, problems.join('. '), { problemi: problems });
}

/** I dati di una voce, controllati dal dominio per il suo tipo. */
function parseData<K extends StudioListKind>(kind: K, raw: unknown): StudioListData[K] {
  const r = parseStudioListData(kind, raw);
  if (r.ok) return r.data;
  throw new HttpError(400, r.problems.join('. '), { problemi: r.problems });
}

/** I campi cambiati, con i valori di prima e di dopo (dati dello studio, nessun segreto). */
function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const campi = Object.keys(after).filter(
    (k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null),
  );
  return {
    campi,
    prima: Object.fromEntries(campi.map((k) => [k, before[k] ?? null])),
    dopo: Object.fromEntries(campi.map((k) => [k, after[k] ?? null])),
  };
}

const itDate = (iso: string) => iso.split('-').reverse().join('/');

/** Il tipo scritto nel corpo, se è uno dei tipi: serve solo al registro dei tentativi negati. */
const kindOf = (body: unknown): StudioListKind | undefined => {
  const t = (body as { tipo?: unknown } | null | undefined)?.tipo;
  return STUDIO_LIST_KIND_KEYS.find((k) => k === t);
};

const KIND_ORDER = new Map(STUDIO_LIST_KIND_KEYS.map((k, i) => [k, i]));

/** Per tipo, poi per nome (alla maniera italiana), poi dalla più vecchia. */
function byKindAndLabel(a: ItemRow, b: ItemRow) {
  return (
    KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! ||
    a.label.localeCompare(b.label, 'it', { sensitivity: 'base' }) ||
    a.createdAt.getTime() - b.createdAt.getTime()
  );
}

function itemView(
  row: ItemRow,
  author: string | null,
  catalog?: Map<string, CatalogService> | null,
) {
  const view = {
    id: row.id,
    tipo: row.kind,
    etichetta: row.label,
    dati: row.data,
    creataIl: row.createdAt.toISOString(),
    creataDa: author,
    archiviataIl: row.archivedAt?.toISOString() ?? null,
  };
  if (row.kind !== 'pacchetto' || catalog === undefined) return view;
  return {
    ...view,
    // Ogni prestazione cercata nel catalogo in vigore alla data; null se nessun catalogo è in uso.
    catalogo:
      catalog === null
        ? null
        : {
            prestazioni: packageServicesOf(row.data).map((s) => ({
              ...s,
              voce: catalog.get(s.codice) ?? null,
            })),
          },
  };
}

export function createStudioListService({ db, now }: AdminDeps) {
  // Solo per sapere quale catalogo è in vigore a una data: le stesse versioni della ricerca.
  const reference = new ReferenceData(db);

  /**
   * Chi scrive gli elenchi: i titolari, l'amministratore e il sostituto mentre ha
   * un'autorizzazione attiva su un archivio dello studio (D181).
   */
  async function decideLists(actor: Actor) {
    return can(actor, 'studio.lists', { grants: await studioGrantsOf(db, actor), now: now() });
  }

  /** Il permesso, oppure 403: il tentativo negato resta nel registro, con che cosa si tentava. */
  async function requireLists(actor: Actor, attempted: string, extra: Record<string, unknown>) {
    const d = await decideLists(actor);
    if (d.allowed) return;
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      patientId: null,
      action: 'amministrazione',
      outcome: 'negato',
      workstation: actor.workstation,
      details: {
        area: 'elenchi',
        azione: attempted,
        ...extra,
        permesso: 'studio.lists',
        motivo: d.reason,
      },
    });
    throw new HttpError(
      403,
      actor.roles.includes('substitute_doctor') ? DENIED_WITHOUT_GRANT : DENIED,
    );
  }

  async function logChange(tx: Tx, actor: Actor, details: Record<string, unknown>) {
    await logAccess(tx, {
      studioId: actor.studioId,
      userId: actor.userId,
      patientId: null,
      action: 'amministrazione',
      outcome: 'riuscito',
      workstation: actor.workstation,
      details: { area: 'elenchi', ...details },
    });
  }

  /**
   * Le voci del catalogo delle prestazioni in vigore alla data, per codice (senza spazi, in
   * maiuscolo, come le regole: D154); null se a quella data nessun catalogo è importato.
   */
  async function catalogEntries(
    codes: readonly string[],
    date: string,
  ): Promise<Map<string, CatalogService> | null> {
    const ids = (await reference.inEffect('prestazioni', date)).map((d) => d.id);
    if (!ids.length) return null;
    const wanted = [...new Set(codes.map(normalizeServiceCode))];
    const found = new Map<string, CatalogService>();
    if (!wanted.length) return found;
    const rows = await db
      .select({
        datasetId: refService.datasetId,
        regionalCode: refService.regionalCode,
        nationalCode: refService.nationalCode,
        description: refService.description,
        branch: refService.branch,
        fee: refService.fee,
        notes: refService.notes,
      })
      .from(refService)
      .where(
        and(
          inArray(refService.datasetId, ids),
          inArray(sql`upper(trim(${refService.regionalCode}))`, wanted),
        ),
      );
    // Se due serie in vigore hanno lo stesso codice vale la prima, sempre la stessa.
    rows.sort((a, b) => ids.indexOf(a.datasetId) - ids.indexOf(b.datasetId));
    for (const r of rows) {
      const key = normalizeServiceCode(r.regionalCode);
      if (!found.has(key))
        found.set(key, {
          regionalCode: r.regionalCode.trim(),
          nationalCode: r.nationalCode,
          description: r.description,
          branch: r.branch,
          fee: r.fee,
          notes: r.notes,
        });
    }
    return found;
  }

  /**
   * Un pacchetto si compone dal catalogo: ogni prestazione nuova deve essere nel catalogo in vigore
   * oggi, e la descrizione si prende dal catalogo, non da chi scrive. Le prestazioni che il
   * pacchetto aveva già restano come erano, anche se nel frattempo il catalogo è cambiato: l'elenco
   * le segnala e la ricetta non le aggiunge.
   */
  async function fromCatalog(
    services: PackageService[],
    previous: PackageService[],
    date: string,
  ): Promise<PackageService[]> {
    const kept = new Map(previous.map((s) => [s.codice, s]));
    const fresh = services.filter((s) => !kept.has(s.codice));
    if (!fresh.length) return services.map((s) => kept.get(s.codice)!);
    const entries = await catalogEntries(
      fresh.map((s) => s.codice),
      date,
    );
    if (!entries) throw new HttpError(409, NO_CATALOG);
    const missing = fresh.filter((s) => !entries.has(s.codice)).map((s) => s.codice);
    if (missing.length) {
      const message = `${missing.length === 1 ? 'Non è' : 'Non sono'} nel catalogo delle prestazioni in vigore il ${itDate(date)}: ${missing.join(', ')}. Un pacchetto si compone dal catalogo: cerca la prestazione e aggiungila dai risultati della ricerca`;
      throw new HttpError(400, message, { problemi: [message], codici: missing });
    }
    return services.map(
      (s) =>
        kept.get(s.codice) ?? { codice: s.codice, descrizione: entries.get(s.codice)!.description },
    );
  }

  /** Due salvataggi insieme non creano due voci uguali: per studio e tipo, uno aspetta l'altro. */
  const lockKind = (tx: Tx, studioId: string, kind: StudioListKind) =>
    tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`elenchi:${studioId}:${kind}`}))`);

  async function ensureUnique(
    tx: Tx,
    studioId: string,
    kind: StudioListKind,
    data: Record<string, unknown>,
    label: string,
    exceptId: string | null,
  ) {
    const key = studioListKey(kind, data);
    const rows = await tx
      .select({ id: studioListItem.id, data: studioListItem.data })
      .from(studioListItem)
      .where(
        and(
          eq(studioListItem.studioId, studioId),
          eq(studioListItem.kind, kind),
          isNull(studioListItem.archivedAt),
        ),
      );
    if (rows.some((r) => r.id !== exceptId && studioListKey(kind, r.data) === key))
      throw new HttpError(409, studioListDuplicate(kind, label));
  }

  /** La voce dello studio di chi chiede; di un altro studio è come se non ci fosse. */
  async function load(studioId: string, id: string) {
    if (!z.uuid().safeParse(id).success) throw new HttpError(404, 'Voce non trovata');
    const [r] = await db
      .select({ item: studioListItem, author: appUser.displayName })
      .from(studioListItem)
      .leftJoin(appUser, eq(appUser.id, studioListItem.createdBy))
      .where(and(eq(studioListItem.id, id), eq(studioListItem.studioId, studioId)));
    if (!r) throw new HttpError(404, 'Voce non trovata');
    return r;
  }

  return {
    /**
     * Gli elenchi dello studio, uno o tutti: le voci attive e, a parte, le archiviate. Ai pacchetti
     * attivi si aggiungono le loro prestazioni cercate nel catalogo in vigore alla data.
     */
    async list(actor: Actor, query: unknown) {
      const q = parse(listQuery, query);
      const date = q.data ?? studioDate(now());
      const rows = await db
        .select({ item: studioListItem, author: appUser.displayName })
        .from(studioListItem)
        .leftJoin(appUser, eq(appUser.id, studioListItem.createdBy))
        .where(
          and(
            eq(studioListItem.studioId, actor.studioId),
            q.tipo ? eq(studioListItem.kind, q.tipo) : undefined,
          ),
        );
      const active = rows
        .filter((r) => !r.item.archivedAt)
        .sort((a, b) => byKindAndLabel(a.item, b.item));
      const archived = rows
        .filter((r) => r.item.archivedAt)
        .sort((a, b) => b.item.archivedAt!.getTime() - a.item.archivedAt!.getTime());
      const withPackages = !q.tipo || q.tipo === 'pacchetto';
      const codes = active
        .filter((r) => r.item.kind === 'pacchetto')
        .flatMap((r) => packageServicesOf(r.item.data).map((s) => s.codice));
      const catalog = withPackages ? await catalogEntries(codes, date) : undefined;
      return {
        tipo: q.tipo ?? null,
        data: date,
        voci: active.map((r) => itemView(r.item, r.author, catalog)),
        archiviate: archived.map((r) => itemView(r.item, r.author)),
        tipi: STUDIO_LIST_KINDS.map((k) => ({ codice: k.key, nome: k.label, voce: k.item })),
        tipiContatto: CONTACT_KINDS.map((k) => ({ codice: k.key, nome: k.label })),
        // Lunghezze massime e prestazioni per pacchetto: controlli di buon senso, come nel dominio.
        limiti: STUDIO_LIST_LIMITS,
        // Se c'è un catalogo delle prestazioni in uso alla data: senza, i pacchetti non si compongono.
        catalogo: catalog === undefined ? null : catalog !== null,
        puoModificare: (await decideLists(actor)).allowed,
      };
    },

    async create(actor: Actor, body: unknown) {
      const peek = kindOf(body);
      await requireLists(actor, 'creazione', peek ? { tipo: peek } : {});
      const b = parse(createBody, body);
      let data: Record<string, unknown> = parseData(b.tipo, b.dati);
      if (b.tipo === 'pacchetto') {
        const p = data as StudioListData['pacchetto'];
        data = { ...p, prestazioni: await fromCatalog(p.prestazioni, [], studioDate(now())) };
      }
      const label = studioListLabel(b.tipo, data);
      const row = await withActor(db, actor.userId, async (tx) => {
        await lockKind(tx, actor.studioId, b.tipo);
        await ensureUnique(tx, actor.studioId, b.tipo, data, label, null);
        const [r] = await tx
          .insert(studioListItem)
          .values({
            studioId: actor.studioId,
            kind: b.tipo,
            label,
            data,
            createdBy: actor.userId,
            createdAt: now(),
          })
          .returning();
        await logChange(tx, actor, {
          tipo: b.tipo,
          azione: 'creazione',
          voce: { id: r!.id, etichetta: label },
          campi: Object.keys(data).filter((k) => data[k] !== null),
          dopo: data,
        });
        return r!;
      });
      return itemView(row, actor.displayName);
    },

    /**
     * Modifica dei campi indicati; gli altri restano. Il tipo non cambia. Se non cambia nulla, non
     * si scrive nulla (né nello storico né nel registro).
     */
    async update(actor: Actor, id: string, body: unknown) {
      await requireLists(actor, 'modifica', { voce: { id } });
      const { item, author } = await load(actor.studioId, id);
      if (item.archivedAt) throw new HttpError(409, 'La voce è archiviata: non si modifica più');
      const b = parse(updateBody, body);
      // Dei dati salvati contano solo i campi di oggi: uno rimasto da una versione vecchia non
      // impedisce di correggere la voce.
      const fields = Object.keys(STUDIO_LIST_SCHEMAS[item.kind].shape);
      const before = Object.fromEntries(
        Object.entries(item.data).filter(([k]) => fields.includes(k)),
      );
      let data: Record<string, unknown> = parseData(item.kind, { ...before, ...b.dati });
      if (item.kind === 'pacchetto') {
        const p = data as StudioListData['pacchetto'];
        data = {
          ...p,
          prestazioni: await fromCatalog(
            p.prestazioni,
            packageServicesOf(item.data),
            studioDate(now()),
          ),
        };
      }
      const changes = diff(before, data);
      if (!changes.campi.length) return itemView(item, author);
      const label = studioListLabel(item.kind, data);
      const saved = await withActor(db, actor.userId, async (tx) => {
        await lockKind(tx, actor.studioId, item.kind);
        await ensureUnique(tx, actor.studioId, item.kind, data, label, item.id);
        const [r] = await tx
          .update(studioListItem)
          .set({ label, data })
          .where(and(eq(studioListItem.id, item.id), isNull(studioListItem.archivedAt)))
          .returning();
        if (!r) throw new HttpError(409, 'La voce è stata archiviata nel frattempo: ricarica');
        await logChange(tx, actor, {
          tipo: item.kind,
          azione: 'modifica',
          voce: { id: item.id, etichetta: label },
          ...changes,
        });
        return r;
      });
      return itemView(saved, author);
    },

    /** Una voce non si cancella: si archivia, e non si propone più nelle schede e nelle ricette. */
    async archive(actor: Actor, id: string) {
      await requireLists(actor, 'archiviazione', { voce: { id } });
      const { item, author } = await load(actor.studioId, id);
      if (item.archivedAt) throw new HttpError(409, 'La voce è già archiviata');
      const saved = await withActor(db, actor.userId, async (tx) => {
        const [r] = await tx
          .update(studioListItem)
          .set({ archivedAt: now() })
          .where(and(eq(studioListItem.id, item.id), isNull(studioListItem.archivedAt)))
          .returning();
        if (!r) throw new HttpError(409, 'La voce è già archiviata');
        await logChange(tx, actor, {
          tipo: item.kind,
          azione: 'archiviazione',
          voce: { id: item.id, etichetta: item.label },
        });
        return r;
      });
      return itemView(saved, author);
    },
  };
}

export type StudioListService = ReturnType<typeof createStudioListService>;
