import {
  can,
  DEFAULT_PRINT_COPIES,
  DEFAULT_REMINDER_VARIANT,
  EMPTY_PRINT_SETTING,
  isPaperSize,
  isPrintDocumentKey,
  isReminderVariant,
  PAPER_SIZE_LABELS,
  PAPER_SIZES,
  PRINT_DOCUMENT_KINDS,
  PRINT_SETTING_LIMITS,
  printHint,
  printSettingIssues,
  REMINDER_VARIANT_LABELS,
  REMINDER_VARIANTS,
  resolvePrintSettings,
  type EffectivePrintSettings,
  type PrintDocumentKey,
  type PrintSettingValues,
} from '@mmg/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { logAccess } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import { printSetting, studio, workstation } from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import type { AdminDeps } from './deps';

/**
 * Preferenze di stampa per tipo di documento (tappa 14), dello studio e delle postazioni.
 *
 * Il programma prepara i PDF con misure esatte e ricorda, per ogni documento, la stampante
 * consigliata, le copie, la carta dove il formato non è fissato e la variante del promemoria; la
 * stampante vera si sceglie nella finestra di stampa del browser, che nessun programma web può
 * saltare né riempire. Valgono, campo per campo, la postazione della sessione, poi lo studio, poi
 * le predefinite. Le legge ogni utente (per i suggerimenti accanto ai pulsanti di stampa); le
 * cambia l'amministratore (`admin.printers`), e ogni cambio va nel registro come «amministrazione».
 */

type SettingRow = typeof printSetting.$inferSelect;
type WorkstationRow = typeof workstation.$inferSelect;

/**
 * La colonna delle copie non accetta il vuoto (migrazione 0022, `copies` con 1 per difetto): lo 0
 * vuol dire «non impostato», come il vuoto delle altre colonne, e la postazione prende le copie
 * dello studio. Lo 0 non esce mai dal servizio.
 */
const COPIES_NOT_SET = 0;

/** I valori di una riga, con il vuoto dove non c'è niente di impostato. */
function valuesOf(r: SettingRow | undefined): PrintSettingValues {
  if (!r) return EMPTY_PRINT_SETTING;
  return {
    printer: r.printerName,
    paper: isPaperSize(r.paper) ? r.paper : null,
    copies: r.copies === COPIES_NOT_SET ? null : r.copies,
    reminderVariant: isReminderVariant(r.reminderVariant) ? r.reminderVariant : null,
  };
}

/** I valori come si vedono, si mandano e si registrano, con i nomi dell'interfaccia. */
interface ValuesView {
  stampante: string | null;
  carta: string | null;
  copie: number | null;
  variante: string | null;
}

const viewOf = (v: PrintSettingValues): ValuesView => ({
  stampante: v.printer,
  carta: v.paper,
  copie: v.copies,
  variante: v.reminderVariant,
});

function effectiveView(e: EffectivePrintSettings) {
  const kind = PRINT_DOCUMENT_KINDS.find((k) => k.key === e.kind)!;
  return {
    tipo: e.kind,
    nome: kind.label,
    uscita: kind.output,
    stampante: e.printer,
    copie: e.copies,
    carta: e.paper,
    cartaScelta: kind.paperChoices.length > 0,
    variante: e.reminderVariant,
    da: {
      stampante: e.from.printer,
      copie: e.from.copies,
      carta: e.from.paper,
      variante: e.from.reminderVariant,
    },
    /** Il testo accanto ai pulsanti di stampa; null se nessuno ha impostato nulla. */
    suggerimento: printHint(e),
  };
}

const kindsView = () =>
  PRINT_DOCUMENT_KINDS.map((k) => ({
    codice: k.key,
    nome: k.label,
    descrizione: k.description,
    uscita: k.output,
    carte: [...k.paperChoices],
    cartaPredefinita: k.defaultPaper,
    fonteCarta: k.paperBasis,
    variante: k.reminderVariant,
  }));

// Corpo della richiesta ---------------------------------------------------------------------

/** Messaggio di un valore del tipo sbagliato o mancante: la preferenza si manda intera. */
const typeError =
  (label: string, what: string) =>
  (issue: { input?: unknown }): string =>
    issue.input === undefined ? `${label}: manca` : `${label}: ${what}`;

/**
 * Una preferenza di un documento, per lo studio (postazione vuota) o per una postazione: i quattro
 * valori insieme, ognuno vuoto per «come il livello sotto». I valori ammessi li controlla il
 * dominio (`printSettingIssues`), con gli stessi messaggi in ogni punto.
 */
const updateBody = z
  .object({
    postazione: z.uuid({ error: typeError('Postazione', 'non valida, oppure vuota') }).nullable(),
    tipo: z.string({ error: typeError('Tipo di documento', 'un testo') }),
    stampante: z
      .string({ error: typeError('Stampante', 'un testo, oppure vuoto') })
      .trim()
      .nullable(),
    carta: z.string({ error: typeError('Carta', 'A4, A5 oppure vuoto') }).nullable(),
    copie: z.number({ error: typeError('Copie', 'un numero, oppure vuoto') }).nullable(),
    variante: z
      .string({ error: typeError('Variante del promemoria', 'un testo, oppure vuoto') })
      .nullable(),
  })
  .strict();

/** Controlla un corpo: i problemi tutti insieme, ognuno detto in chiaro. */
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const problems = [...new Set(r.error.issues.map((i) => i.message))];
  throw new HttpError(400, problems.join('. '), { problemi: problems });
}

/** I campi cambiati, con i valori di prima e di dopo. */
function diff(before: ValuesView, after: ValuesView) {
  const campi = (Object.keys(after) as (keyof ValuesView)[]).filter((k) => before[k] !== after[k]);
  return {
    campi,
    prima: Object.fromEntries(campi.map((k) => [k, before[k]])),
    dopo: Object.fromEntries(campi.map((k) => [k, after[k]])),
  };
}

// Letture comuni ----------------------------------------------------------------------------

/**
 * La postazione della sessione: il nome scritto all'accesso, confrontato senza spazi ai lati e
 * senza maiuscole con le postazioni attive dello studio. Null se non è tra quelle.
 */
export async function sessionWorkstation(
  db: Database,
  actor: Pick<Actor, 'studioId' | 'workstation'>,
): Promise<WorkstationRow | null> {
  const name = actor.workstation.trim();
  if (!name) return null;
  const [w] = await db
    .select()
    .from(workstation)
    .where(
      and(
        eq(workstation.studioId, actor.studioId),
        isNull(workstation.archivedAt),
        sql`lower(${workstation.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  return w ?? null;
}

async function settingRows(db: Database | Tx, studioId: string, workstationId: string | null) {
  return db
    .select()
    .from(printSetting)
    .where(
      and(
        eq(printSetting.studioId, studioId),
        workstationId === null
          ? isNull(printSetting.workstationId)
          : eq(printSetting.workstationId, workstationId),
      ),
    );
}

const byKind = (rows: SettingRow[]) => {
  const out = new Map<PrintDocumentKey, SettingRow>();
  for (const r of rows) if (isPrintDocumentKey(r.documentKind)) out.set(r.documentKind, r);
  return out;
};

/** Le preferenze che valgono per la sessione: postazione, poi studio, poi predefinite. */
async function effectiveFor(db: Database, actor: Pick<Actor, 'studioId' | 'workstation'>) {
  const ws = await sessionWorkstation(db, actor);
  const studioRows = byKind(await settingRows(db, actor.studioId, null));
  const wsRows = ws
    ? byKind(await settingRows(db, actor.studioId, ws.id))
    : new Map<PrintDocumentKey, SettingRow>();
  return {
    workstation: ws,
    settings: PRINT_DOCUMENT_KINDS.map((k) =>
      resolvePrintSettings(k.key, {
        workstation: valuesOf(wsRows.get(k.key)),
        studio: valuesOf(studioRows.get(k.key)),
      }),
    ),
  };
}

/**
 * Le preferenze di un documento per la postazione della sessione: le usano i documenti che il
 * servizio impagina secondo la carta scelta (i certificati dai modelli in A5).
 */
export async function printSettingsFor(
  db: Database,
  actor: Pick<Actor, 'studioId' | 'workstation'>,
  key: PrintDocumentKey,
): Promise<EffectivePrintSettings> {
  const { settings } = await effectiveFor(db, actor);
  return settings.find((s) => s.kind === key)!;
}

export function createPrintService(deps: AdminDeps) {
  const { db, now } = deps;

  /** Il permesso, oppure 403: il tentativo negato resta nel registro, con che cosa si tentava. */
  async function requirePrinters(actor: Actor, azione: 'lettura' | 'modifica') {
    const d = can(actor, 'admin.printers');
    if (d.allowed) return;
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      patientId: null,
      action: 'amministrazione',
      outcome: 'negato',
      workstation: actor.workstation,
      details: { area: 'stampa', azione, permesso: 'admin.printers', motivo: d.reason },
    });
    throw new HttpError(
      403,
      azione === 'lettura'
        ? 'Le preferenze di stampa di tutte le postazioni le vede l’amministratore dello studio'
        : 'Le preferenze di stampa le cambia l’amministratore dello studio',
    );
  }

  /** Tutte le preferenze: dello studio e di ogni postazione attiva, con i tipi di documento. */
  async function settingsView(actor: Actor) {
    const stations = await db
      .select()
      .from(workstation)
      .where(and(eq(workstation.studioId, actor.studioId), isNull(workstation.archivedAt)))
      .orderBy(asc(sql`lower(${workstation.name})`), asc(workstation.createdAt));
    const rows = await db
      .select()
      .from(printSetting)
      .where(eq(printSetting.studioId, actor.studioId));
    const levelOf = (workstationId: string | null) => {
      const mine = byKind(rows.filter((r) => (r.workstationId ?? null) === workstationId));
      return Object.fromEntries(
        PRINT_DOCUMENT_KINDS.map((k) => {
          const r = mine.get(k.key);
          return [
            k.key,
            {
              ...viewOf(valuesOf(r)),
              aggiornatoIl: r?.updatedAt.toISOString() ?? null,
            },
          ];
        }),
      );
    };
    return {
      tipi: kindsView(),
      carte: PAPER_SIZES.map((p) => ({ codice: p, nome: PAPER_SIZE_LABELS[p] })),
      varianti: REMINDER_VARIANTS.map((v) => ({ codice: v, nome: REMINDER_VARIANT_LABELS[v] })),
      limiti: PRINT_SETTING_LIMITS,
      predefinite: { copie: DEFAULT_PRINT_COPIES, variante: DEFAULT_REMINDER_VARIANT },
      studio: levelOf(null),
      postazioni: stations.map((w) => ({
        id: w.id,
        nome: w.name,
        condivisa: w.shared,
        preferenze: levelOf(w.id),
      })),
      puoModificare: true,
    };
  }

  return {
    /**
     * Le preferenze che valgono per la postazione di chi chiede: le legge ogni utente, per i
     * suggerimenti accanto ai pulsanti di stampa.
     */
    async effective(actor: Actor) {
      const { workstation: ws, settings } = await effectiveFor(db, actor);
      return {
        postazione: {
          scritta: actor.workstation,
          riconosciuta: ws ? { id: ws.id, nome: ws.name } : null,
        },
        preferenze: settings.map(effectiveView),
      };
    },

    /** Tutte le preferenze dello studio e delle postazioni: le vede l'amministratore. */
    async settings(actor: Actor) {
      await requirePrinters(actor, 'lettura');
      return settingsView(actor);
    },

    /**
     * Salva la preferenza di un documento per lo studio o per una postazione. Il permesso si
     * controlla prima dei valori: chi non può cambiare non sa nemmeno se andavano bene.
     */
    async update(actor: Actor, body: unknown) {
      await requirePrinters(actor, 'modifica');
      const b = parse(updateBody, body);
      if (!isPrintDocumentKey(b.tipo))
        throw new HttpError(400, 'Tipo di documento: non previsto', {
          problemi: ['Tipo di documento: non previsto'],
        });
      const kind = b.tipo;
      const next: ValuesView = {
        stampante: b.stampante || null,
        carta: b.carta || null,
        copie: b.copie,
        variante: b.variante || null,
      };
      const problems = printSettingIssues(kind, {
        printer: next.stampante,
        paper: next.carta,
        copies: next.copie,
        reminderVariant: next.variante,
      });
      if (problems.length) throw new HttpError(400, problems.join('. '), { problemi: problems });

      await withActor(db, actor.userId, async (tx) => {
        // Si blocca il livello che si cambia (la postazione, o lo studio): due salvataggi insieme
        // vanno uno dopo l'altro, e una postazione archiviata nel frattempo non riceve nulla.
        let station: WorkstationRow | null = null;
        if (b.postazione) {
          const [w] = await tx
            .select()
            .from(workstation)
            .where(and(eq(workstation.id, b.postazione), eq(workstation.studioId, actor.studioId)))
            .for('update');
          if (!w) throw new HttpError(404, 'Postazione non trovata');
          if (w.archivedAt)
            throw new HttpError(
              409,
              'La postazione è archiviata: le sue preferenze non si cambiano',
            );
          station = w;
        } else {
          await tx
            .select({ id: studio.id })
            .from(studio)
            .where(eq(studio.id, actor.studioId))
            .for('update');
        }
        const [current] = (await settingRows(tx, actor.studioId, station?.id ?? null)).filter(
          (r) => r.documentKind === kind,
        );
        const changes = diff(viewOf(valuesOf(current)), next);
        if (!changes.campi.length) return;
        const values = {
          printerName: next.stampante,
          paper: next.carta,
          copies: next.copie ?? COPIES_NOT_SET,
          reminderVariant: next.variante,
          updatedAt: now(),
          updatedBy: actor.userId,
        };
        if (current)
          await tx.update(printSetting).set(values).where(eq(printSetting.id, current.id));
        else
          await tx.insert(printSetting).values({
            studioId: actor.studioId,
            workstationId: station?.id ?? null,
            documentKind: kind,
            ...values,
          });
        await logAccess(tx, {
          studioId: actor.studioId,
          userId: actor.userId,
          patientId: null,
          action: 'amministrazione',
          outcome: 'riuscito',
          workstation: actor.workstation,
          details: {
            area: 'stampa',
            azione: 'modifica',
            documento: kind,
            postazione: station ? { id: station.id, nome: station.name } : null,
            ...changes,
          },
        });
      });
      return settingsView(actor);
    },
  };
}

export type PrintService = ReturnType<typeof createPrintService>;
