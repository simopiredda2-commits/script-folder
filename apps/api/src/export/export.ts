import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { appUser, archive, doctorProfile, studio } from '../db/schema';

/**
 * Esportazione completa dei dati di un archivio in formato aperto (JSON, RFC 8259).
 * Il formato è descritto in docs/esportazione.md. Le righe sono quelle del database, con i nomi
 * delle colonne: nulla si perde in una traduzione.
 */
export const EXPORT_FORMAT = 'mmg-esportazione';
export const EXPORT_VERSION = 1;

/** Tabelle esportate e come si collegano ai pazienti dell'archivio. */
export const PATIENT_TABLES = [
  'patient_choice',
  'exemption',
  'consent',
  'delegation',
  'clinical_entry',
  'therapeutic_plan',
  'therapy',
  'appointment',
  'patient_request',
  'prescription',
  'sick_leave_certificate',
  'service_execution',
  'supply_prescription',
  'pss_document',
  'template_certificate',
  'aft_activity',
  'historical_prescription',
] as const;

export const ENTRY_TABLES = [
  'problem_detail',
  'diary_detail',
  'measurement_detail',
  'anamnesis_detail',
  'allergy_detail',
  'risk_factor_detail',
  'examination_detail',
  'vaccination_detail',
  'lab_result_detail',
  'report_detail',
  'attachment',
  'functional_status_detail',
] as const;

/** Tabelle collegate per ricetta: righe e invii esterni (richiesta, risposta, esito). */
export const PRESCRIPTION_TABLES = [
  'prescription_line',
  'external_submission',
  'prescription_check',
  'prescription_document',
  'reminder_delivery',
] as const;

/** Tabelle collegate per certificato: invii all'INPS e consegne di copia e attestato. */
export const CERTIFICATE_TABLES = ['certificate_submission', 'certificate_delivery'] as const;

/** Tabelle collegate per Profilo Sanitario Sintetico: le chiamate al Gateway (tappa 11). */
export const PSS_TABLES = ['fse_transmission'] as const;

/**
 * Tabelle con una colonna `patient_id` o `entry_id` che non stanno nelle liste sopra, con il
 * motivo. Una prova controlla che ogni tabella del database sia in una delle tre liste.
 */
export const HANDLED_SEPARATELY: Record<string, string> = {
  patient: 'esportata per prima, filtrata per archivio',
  access_log: 'esportato nella sezione registro_accessi',
  attachment_content:
    'i file degli allegati: sezione allegati del JSON, cartella allegati/ nello ZIP',
  pss_file:
    'i PDF del Profilo Sanitario Sintetico: sezione documenti_profilo del JSON, cartella profilo-sanitario/ nello ZIP',
};

type Row = Record<string, unknown>;

/** Un solo parametro con un letterale di array Postgres: Drizzle espanderebbe un array JS in una tupla. */
const pgArray = (values: string[]) =>
  `{${values.map((v) => `"${v.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function rows(db: Database, query: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute<Row>(query)).rows;
}

export async function buildExport(db: Database, archiveId: string, generatedAt: Date) {
  const [a] = await db
    .select({ archive, studio, owner: appUser, profile: doctorProfile })
    .from(archive)
    .innerJoin(studio, eq(studio.id, archive.studioId))
    .innerJoin(appUser, eq(appUser.id, archive.ownerUserId))
    .leftJoin(doctorProfile, eq(doctorProfile.userId, archive.ownerUserId))
    .where(eq(archive.id, archiveId));
  if (!a) throw new Error('Archivio non trovato');

  const tables: Record<string, Row[]> = {};
  tables.patient = await rows(
    db,
    sql`select * from patient where archive_id = ${archiveId} order by last_name, first_name, id`,
  );
  const patientIds = tables.patient.map((p) => p.id as string);
  const familyIds = [...new Set(tables.patient.map((p) => p.family_id).filter(Boolean))];
  tables.family = familyIds.length
    ? await rows(
        db,
        sql`select * from family where id = any(${pgArray(familyIds as string[])}::uuid[]) order by id`,
      )
    : [];

  for (const t of PATIENT_TABLES) {
    tables[t] = await rows(
      db,
      sql`select * from ${sql.identifier(t)} where patient_id = any(${pgArray(patientIds)}::uuid[]) order by id`,
    );
  }
  const entryIds = tables.clinical_entry!.map((e) => e.id as string);
  for (const t of ENTRY_TABLES) {
    const order = t === 'attachment' ? sql`id` : sql`entry_id`;
    tables[t] = await rows(
      db,
      sql`select * from ${sql.identifier(t)} where entry_id = any(${pgArray(entryIds)}::uuid[]) order by ${order}`,
    );
  }

  const prescriptionIds = tables.prescription!.map((p) => p.id as string);
  for (const t of PRESCRIPTION_TABLES) {
    tables[t] = await rows(
      db,
      sql`select * from ${sql.identifier(t)} where prescription_id = any(${pgArray(prescriptionIds)}::uuid[]) order by id`,
    );
  }

  const certificateIds = tables.sick_leave_certificate!.map((c) => c.id as string);
  for (const t of CERTIFICATE_TABLES) {
    tables[t] = await rows(
      db,
      sql`select * from ${sql.identifier(t)} where certificate_id = any(${pgArray(certificateIds)}::uuid[]) order by id`,
    );
  }

  const pssIds = tables.pss_document!.map((d) => d.id as string);
  for (const t of PSS_TABLES) {
    tables[t] = await rows(
      db,
      sql`select * from ${sql.identifier(t)} where document_id = any(${pgArray(pssIds)}::uuid[]) order by id`,
    );
  }
  // Modelli scritti nello studio (tappa 13): anche questi sono dati del medico (regola 4).
  tables.studio_template = await rows(
    db,
    sql`select * from studio_template where studio_id = ${a.studio.id} order by id`,
  );
  // PDF del Profilo, con il CDA dentro e firmati: come gli allegati, nel JSON in base64.
  const pssFiles = pssIds.length
    ? (
        await db.execute<{
          id: string;
          document_id: string;
          kind: string;
          sha256: string;
          content: Buffer;
        }>(
          sql`select id, document_id, kind, sha256, content from pss_file
              where document_id = any(${pgArray(pssIds)}::uuid[]) order by document_id, created_at`,
        )
      ).rows.map((f) => ({
        id: f.id,
        documento: f.document_id,
        tipo: f.kind,
        sha256: f.sha256,
        contenuto_base64: Buffer.from(f.content).toString('base64'),
      }))
    : [];

  // File degli allegati (referti): nel JSON in base64, nello ZIP come file (D121).
  const attachmentIds = tables.attachment!.map((r) => r.id as string);
  const files = attachmentIds.length
    ? (
        await db.execute<{ id: string; content: Buffer }>(
          sql`select attachment_id as id, content from attachment_content
              where attachment_id = any(${pgArray(attachmentIds)}::uuid[]) order by attachment_id`,
        )
      ).rows.map((f) => {
        const meta = tables.attachment!.find((a) => a.id === f.id)!;
        return {
          id: f.id,
          nome: meta.filename as string,
          tipo: meta.media_type as string,
          sha256: meta.sha256 as string,
          contenuto_base64: Buffer.from(f.content).toString('base64'),
        };
      })
    : [];

  const exportedIds = Object.values(tables).flatMap((list) =>
    list.map((r) => String(r.id ?? r.entry_id)),
  );
  const history = await rows(
    db,
    sql`select * from change_history where row_id = any(${pgArray(exportedIds)}::text[]) order by id`,
  );
  const accessLog = await rows(
    db,
    sql`select * from access_log where patient_id = any(${pgArray(patientIds)}::uuid[])
        or (studio_id = ${a.studio.id} and patient_id is null and user_id = ${a.owner.id})
        order by seq`,
  );

  // Colonne di ogni sezione nell'ordine del database: servono al CSV anche per le tabelle vuote.
  const columnRows = await rows(
    db,
    sql`select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and table_name = any(${pgArray([...Object.keys(tables), 'change_history', 'access_log'])}::text[])
        order by table_name, ordinal_position`,
  );
  const columnsOf = (t: string) =>
    columnRows.filter((r) => r.table_name === t).map((r) => r.column_name as string);
  const colonne: Record<string, string[]> = Object.fromEntries(
    Object.keys(tables).map((t) => [t, columnsOf(t)]),
  );
  colonne.storico_modifiche = columnsOf('change_history');
  colonne.registro_accessi = columnsOf('access_log');

  const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  return {
    formato: EXPORT_FORMAT,
    versione: EXPORT_VERSION,
    generato_il: generatedAt.toISOString(),
    studio: {
      id: a.studio.id,
      nome: a.studio.name,
      indirizzo: a.studio.address,
      tipo: a.studio.kind,
    },
    archivio: { id: a.archive.id, nome: a.archive.name },
    medico: {
      id: a.owner.id,
      nome: a.owner.displayName,
      codice_regionale: a.profile?.regionalCode ?? null,
      asl: a.profile?.asl ?? null,
    },
    tabelle: tables,
    colonne,
    storico_modifiche: history,
    registro_accessi: accessLog,
    allegati: files,
    documenti_profilo: pssFiles,
    conteggi: {
      ...counts,
      storico_modifiche: history.length,
      registro_accessi: accessLog.length,
      allegati: files.length,
      documenti_profilo: pssFiles.length,
    },
    impronte: Object.fromEntries(
      (
        [
          ...Object.entries(tables),
          ['storico_modifiche', history],
          ['registro_accessi', accessLog],
          ['allegati', files],
          ['documenti_profilo', pssFiles],
        ] as [string, unknown[]][]
      ).map(([k, v]) => [k, digest(v)]),
    ),
  };
}

export type ExportDocument = Awaited<ReturnType<typeof buildExport>>;
