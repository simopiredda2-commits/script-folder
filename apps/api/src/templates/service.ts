import {
  DEFAULT_PRINT_LAYOUT,
  fieldIssues,
  fillTemplate,
  italianDate,
  layoutIssues,
  missingData,
  PRINT_FONTS,
  templateIssues,
  type CertificateTemplate,
  type PrintFont,
  type PrintLayout,
  type TemplateContext,
} from '@mmg/domain';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import { appUser, doctorProfile, studioTemplate, templateCertificate } from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from '../http/errors';
import { guardPatient } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';
import { officialTemplates } from './catalog';
import { renderTemplatePdf } from './pdf';

const STUDIO_PREFIX = 'studio:';
const isDoctor = (a: Actor) =>
  a.roles.includes('owner_doctor') || a.roles.includes('substitute_doctor');
/** I modelli dello studio li scrivono i medici e l'amministratore (requisiti: «modelli»). */
const canManageTemplates = (a: Actor) => isDoctor(a) || a.roles.includes('administrator');

const layoutBody = z
  .object({
    carattere: z.enum(Object.keys(PRINT_FONTS) as [PrintFont, ...PrintFont[]]),
    dimensione: z.number().int(),
    intestazione: z.array(z.string().max(200)).max(20),
    allineamento: z.enum(['left', 'center']),
    margini: z.number().int(),
    luogo: z.string().trim().max(100),
    timbro: z.string().max(500),
  })
  .strict();

const studioTemplateBody = z
  .object({
    titolo: z.string().trim().min(1).max(200),
    testo: z.array(z.string().trim().min(1).max(4000)).min(1).max(30),
  })
  .strict();

const issueBody = z
  .object({
    modello: z.string().min(1).max(100),
    valori: z.record(z.string(), z.string().max(4000)).default({}),
    luogo: z.string().trim().min(1, 'Luogo del rilascio: da compilare').max(100),
  })
  .strict();

const annulBody = z.object({ motivo: z.string().trim().min(1).max(500) }).strict();

/** Il modello dello studio come modello: testo del medico, senza fonte; un campo per il testo libero. */
function fromStudio(row: typeof studioTemplate.$inferSelect): CertificateTemplate {
  const freeText = row.body.some((p) => p.includes('{{campo.testo}}'));
  return {
    key: `${STUDIO_PREFIX}${row.id}`,
    title: row.title,
    version: studioDate(row.updatedAt ?? row.createdAt),
    official: false,
    source: null,
    validityMonths: null,
    forDoctor: [],
    fields: freeText
      ? [{ key: 'testo', label: 'Testo', type: 'testo_lungo', required: true, max: 4000 }]
      : [],
    body: row.body,
    signature: 'Timbro e firma del medico',
  };
}

function layoutOf(p: typeof doctorProfile.$inferSelect | undefined): PrintLayout {
  if (!p) return { ...DEFAULT_PRINT_LAYOUT };
  return {
    font: (p.printFont in PRINT_FONTS ? p.printFont : 'sans') as PrintFont,
    fontSize: p.printFontSize,
    header: (p.headerText ?? '').split('\n').filter((l) => l.trim()),
    headerAlign: p.printHeaderAlign === 'center' ? 'center' : 'left',
    marginMm: p.printMarginMm,
    place: p.printPlace ?? '',
    stamp: p.stampText ?? '',
  };
}

const layoutView = (l: PrintLayout) => ({
  carattere: l.font,
  dimensione: l.fontSize,
  intestazione: l.header,
  allineamento: l.headerAlign,
  margini: l.marginMm,
  luogo: l.place,
  timbro: l.stamp,
});

const templateView = (t: CertificateTemplate) => ({
  chiave: t.key,
  titolo: t.title,
  ufficiale: t.official,
  versione: t.version,
  fonte: t.source,
  validitaMesi: t.validityMonths,
  perIlMedico: t.forDoctor,
  campi: t.fields,
  testo: t.body,
  firma: t.signature,
});

const certificateView = (r: typeof templateCertificate.$inferSelect) => ({
  id: r.id,
  modello: r.templateKey,
  titolo: r.templateTitle,
  versione: r.templateVersion,
  ufficiale: r.official,
  fonte: r.source,
  campi: r.fields,
  rilasciatoIl: r.issuedOn,
  validoFinoAl: r.validUntil,
  annullatoIl: r.annulledAt,
  motivoAnnullamento: r.annulReason,
});

/** Validità di N mesi dal rilascio: fino al giorno prima della stessa data, N mesi dopo (D144). */
export function validityEnd(issuedOn: string, months: number): string {
  const [y, m, d] = issuedOn.split('-').map(Number) as [number, number, number];
  const end = new Date(Date.UTC(y, m - 1 + months, d));
  // Se il giorno non c'è in quel mese (31 → 30), la data scivola: si torna all'ultimo del mese.
  if (end.getUTCDate() !== d) end.setUTCDate(0);
  else end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

export function createTemplateService(deps: { db: Database; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function profileOf(userId: string) {
    const [p] = await db.select().from(doctorProfile).where(eq(doctorProfile.userId, userId));
    return p;
  }

  async function studioTemplates(studioId: string) {
    return db
      .select()
      .from(studioTemplate)
      .where(and(eq(studioTemplate.studioId, studioId), isNull(studioTemplate.archivedAt)))
      .orderBy(asc(studioTemplate.title));
  }

  async function templateFor(actor: Actor, key: string): Promise<CertificateTemplate> {
    if (key.startsWith(STUDIO_PREFIX)) {
      const id = z.uuid().safeParse(key.slice(STUDIO_PREFIX.length));
      if (id.success) {
        const [row] = await db
          .select()
          .from(studioTemplate)
          .where(
            and(
              eq(studioTemplate.id, id.data),
              eq(studioTemplate.studioId, actor.studioId),
              isNull(studioTemplate.archivedAt),
            ),
          );
        if (row) return fromStudio(row);
      }
    } else {
      const t = officialTemplates().find((x) => x.key === key);
      if (t) return t;
    }
    throw new HttpError(404, 'Modello non trovato');
  }

  async function contextFor(
    actor: Actor,
    p: Awaited<ReturnType<typeof guardPatient>>['patient'],
    place: string,
    issuedOn: string,
  ): Promise<TemplateContext> {
    const [u] = await db.select().from(appUser).where(eq(appUser.id, actor.userId));
    const d = await profileOf(actor.userId);
    const residence = [
      [p.residenceStreet, p.residenceNumber].filter(Boolean).join(' '),
      [p.residencePostalCode, p.residenceTown].filter(Boolean).join(' '),
      p.residenceProvince ? `(${p.residenceProvince})` : '',
    ]
      .filter(Boolean)
      .join(', ')
      .replace(/, \(/, ' (');
    return {
      patient: {
        cognome: p.lastName,
        nome: p.firstName,
        sesso: p.sex,
        nato_a: p.birthPlaceName ?? '',
        nato_il: italianDate(p.birthDate),
        codice_fiscale: p.fiscalCode,
        residenza: residence,
      },
      doctor: {
        nome_cognome:
          d?.firstName && d.lastName ? `${d.firstName} ${d.lastName}` : (u?.displayName ?? ''),
        codice_fiscale: d?.fiscalCode ?? '',
        codice_regionale: d?.regionalCode ?? '',
      },
      issue: { luogo: place, data: italianDate(issuedOn) },
    };
  }

  /** Controlla e compone: il testo del certificato, o i problemi da correggere. */
  async function compose(
    actor: Actor,
    patientId: string,
    body: unknown,
    act: 'anteprima' | 'rilascio',
  ) {
    const { patient } = await guardPatient(
      db,
      actor,
      patientId,
      'certificate.sign_send',
      act === 'anteprima' ? 'anteprima_certificato_modello' : 'rilascio_certificato_modello',
    );
    const b = issueBody.parse(body);
    const template = await templateFor(actor, b.modello);
    const issuedOn = studioDate(now());
    const ctx = await contextFor(actor, patient, b.luogo, issuedOn);
    const problems = [...fieldIssues(template, b.valori), ...missingData(template, ctx)];
    if (problems.length) throw new HttpError(400, problems.join('. '), { problemi: problems });
    const filled = fillTemplate(template, ctx, b.valori);
    return { template, filled, values: b.valori, issuedOn };
  }

  return {
    /** Modelli ufficiali e modelli dello studio. */
    async catalog(actor: Actor) {
      return {
        ufficiali: officialTemplates().map(templateView),
        studio: (await studioTemplates(actor.studioId)).map((r) => ({
          ...templateView(fromStudio(r)),
          id: r.id,
        })),
        puoGestire: canManageTemplates(actor),
      };
    },

    async createStudioTemplate(actor: Actor, body: unknown) {
      if (!canManageTemplates(actor))
        throw new HttpError(403, 'I modelli dello studio li scrivono i medici e l’amministratore');
      const b = studioTemplateBody.parse(body);
      const draft = fromStudio({
        id: '00000000-0000-0000-0000-000000000000',
        studioId: actor.studioId,
        title: b.titolo,
        body: b.testo,
        createdBy: actor.userId,
        createdAt: now(),
        updatedBy: null,
        updatedAt: null,
        archivedAt: null,
      });
      const issues = templateIssues(draft);
      if (issues.length) throw new HttpError(400, issues.join('. '), { problemi: issues });
      const [row] = await withActor(db, actor.userId, (tx) =>
        tx
          .insert(studioTemplate)
          .values({
            studioId: actor.studioId,
            title: b.titolo,
            body: b.testo,
            createdBy: actor.userId,
          })
          .returning(),
      );
      return { ...templateView(fromStudio(row!)), id: row!.id };
    },

    async updateStudioTemplate(actor: Actor, id: string, body: unknown) {
      if (!canManageTemplates(actor))
        throw new HttpError(403, 'I modelli dello studio li scrivono i medici e l’amministratore');
      const b = studioTemplateBody.parse(body);
      const [old] = await db
        .select()
        .from(studioTemplate)
        .where(and(eq(studioTemplate.id, id), eq(studioTemplate.studioId, actor.studioId)));
      if (!old || old.archivedAt) throw new HttpError(404, 'Modello non trovato');
      const issues = templateIssues(fromStudio({ ...old, title: b.titolo, body: b.testo }));
      if (issues.length) throw new HttpError(400, issues.join('. '), { problemi: issues });
      const [row] = await withActor(db, actor.userId, (tx) =>
        tx
          .update(studioTemplate)
          .set({ title: b.titolo, body: b.testo, updatedBy: actor.userId, updatedAt: now() })
          .where(eq(studioTemplate.id, id))
          .returning(),
      );
      return { ...templateView(fromStudio(row!)), id: row!.id };
    },

    async archiveStudioTemplate(actor: Actor, id: string) {
      if (!canManageTemplates(actor))
        throw new HttpError(403, 'I modelli dello studio li scrivono i medici e l’amministratore');
      const rows = await withActor(db, actor.userId, (tx) =>
        tx
          .update(studioTemplate)
          .set({ archivedAt: now(), updatedBy: actor.userId, updatedAt: now() })
          .where(
            and(
              eq(studioTemplate.id, id),
              eq(studioTemplate.studioId, actor.studioId),
              isNull(studioTemplate.archivedAt),
            ),
          )
          .returning(),
      );
      if (!rows.length) throw new HttpError(404, 'Modello non trovato');
    },

    /** L'impaginazione del medico che guarda. */
    async layout(actor: Actor) {
      if (!isDoctor(actor)) throw new HttpError(403, 'L’impaginazione è del medico');
      return layoutView(layoutOf(await profileOf(actor.userId)));
    },

    async saveLayout(actor: Actor, body: unknown) {
      if (!isDoctor(actor)) throw new HttpError(403, 'L’impaginazione è del medico');
      const l = parseLayout(body);
      const values = {
        printFont: l.font,
        printFontSize: l.fontSize,
        headerText: l.header.join('\n') || null,
        printHeaderAlign: l.headerAlign,
        printMarginMm: l.marginMm,
        printPlace: l.place || null,
        stampText: l.stamp || null,
      };
      await withActor(db, actor.userId, (tx) =>
        tx
          .insert(doctorProfile)
          .values({ userId: actor.userId, ...values })
          .onConflictDoUpdate({ target: doctorProfile.userId, set: values }),
      );
      return layoutView(l);
    },

    /** Prova di stampa con un'impaginazione (anche non ancora salvata). */
    async layoutPreview(actor: Actor, body: unknown) {
      if (!isDoctor(actor)) throw new HttpError(403, 'L’impaginazione è del medico');
      return renderTemplatePdf({
        title: 'Prova di impaginazione',
        paragraphs: [
          'Questo testo serve solo a vedere come si stampano i certificati: intestazione, carattere, dimensione, margini e timbro.',
          'Il testo dei certificati viene dal modello; i dati del paziente, dalla cartella.',
          `Luogo, ${italianDate(studioDate(now()))}`,
        ],
        signature: 'Timbro e firma del medico',
        layout: parseLayout(body),
        createdAt: now(),
      });
    },

    /** Certificati rilasciati al paziente, i modelli e il luogo proposto. */
    async overview(actor: Actor, patientId: string) {
      await guardPatient(
        db,
        actor,
        patientId,
        'certificate.sign_send',
        'lettura_certificati_modelli',
      );
      const rows = await db
        .select()
        .from(templateCertificate)
        .where(eq(templateCertificate.patientId, patientId))
        .orderBy(desc(templateCertificate.issuedAt));
      return {
        certificati: rows.map(certificateView),
        luogo: layoutOf(await profileOf(actor.userId)).place,
      };
    },

    /** Il PDF come verrebbe, senza rilasciarlo. */
    async preview(actor: Actor, patientId: string, body: unknown) {
      const { template, filled } = await compose(actor, patientId, body, 'anteprima');
      return renderTemplatePdf({
        title: filled.title,
        paragraphs: filled.paragraphs,
        signature: template.signature,
        layout: layoutOf(await profileOf(actor.userId)),
        createdAt: now(),
      });
    },

    async issue(actor: Actor, patientId: string, body: unknown) {
      const { template, filled, values, issuedOn } = await compose(
        actor,
        patientId,
        body,
        'rilascio',
      );
      const layout = layoutOf(await profileOf(actor.userId));
      const [row] = await withActor(db, actor.userId, (tx) =>
        tx
          .insert(templateCertificate)
          .values({
            patientId,
            templateKey: template.key,
            templateTitle: template.title,
            templateVersion: template.version,
            official: template.official,
            source: template.source,
            fields: template.fields.map((f) => ({
              key: f.key,
              label: f.label,
              value: (values[f.key] ?? '').trim(),
            })),
            paragraphs: filled.paragraphs,
            signature: template.signature,
            layout,
            issuedOn,
            validUntil: template.validityMonths
              ? validityEnd(issuedOn, template.validityMonths)
              : null,
            issuedBy: actor.userId,
            issuedAt: now(),
          })
          .returning(),
      );
      return certificateView(row!);
    },

    async pdf(actor: Actor, patientId: string, certificateId: string) {
      await guardPatient(
        db,
        actor,
        patientId,
        'certificate.sign_send',
        'stampa_certificato_modello',
      );
      const r = await load(patientId, certificateId);
      return renderTemplatePdf({
        title: r.templateTitle,
        paragraphs: r.paragraphs,
        signature: r.signature,
        layout: r.layout,
        createdAt: r.issuedAt,
        annulled: r.annulledAt
          ? { on: italianDate(studioDate(r.annulledAt)), reason: r.annulReason ?? '' }
          : null,
      });
    },

    async annul(actor: Actor, patientId: string, certificateId: string, body: unknown) {
      await guardPatient(
        db,
        actor,
        patientId,
        'certificate.sign_send',
        'annullamento_certificato_modello',
      );
      const r = await load(patientId, certificateId);
      const b = annulBody.parse(body);
      if (r.annulledAt) throw new HttpError(409, 'Il certificato è già annullato');
      const [row] = await withActor(db, actor.userId, (tx) =>
        tx
          .update(templateCertificate)
          .set({ annulledAt: now(), annulledBy: actor.userId, annulReason: b.motivo })
          .where(eq(templateCertificate.id, r.id))
          .returning(),
      );
      return certificateView(row!);
    },
  };

  async function load(patientId: string, certificateId: string) {
    const id = z.uuid().safeParse(certificateId);
    if (!id.success) throw new HttpError(404, 'Certificato non trovato');
    const [r] = await db
      .select()
      .from(templateCertificate)
      .where(
        and(eq(templateCertificate.id, id.data), eq(templateCertificate.patientId, patientId)),
      );
    if (!r) throw new HttpError(404, 'Certificato non trovato');
    return r;
  }
}

/** L'impaginazione dal corpo della richiesta, controllata. */
function parseLayout(body: unknown): PrintLayout {
  const b = layoutBody.parse(body);
  const l: PrintLayout = {
    font: b.carattere,
    fontSize: b.dimensione,
    header: b.intestazione.map((r) => r.trim()).filter(Boolean),
    headerAlign: b.allineamento,
    marginMm: b.margini,
    place: b.luogo,
    stamp: b.timbro.trim(),
  };
  const issues = layoutIssues(l);
  if (issues.length) throw new HttpError(400, issues.join('. '), { problemi: issues });
  return l;
}
