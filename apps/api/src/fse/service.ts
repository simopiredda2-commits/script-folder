import { COMPANY_BRAND, PRODUCT_NAME } from '@mmg/brand';
import { can, doctorIssues, patientIssues, PSS_STATUS_LABELS } from '@mmg/domain';
import {
  buildPssCda,
  pssSchematron,
  withEmbeddedCda,
  type DocumentSigner,
  type FseCaller,
  type FseGatewayClient,
  type FseProblem,
  type FseResult,
  type PssCdaInput,
} from '@mmg/integrations';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  doctorProfile,
  fseRegionalSend,
  fseSetting,
  fseTransmission,
  pssDocument,
  pssFile,
} from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from '../http/errors';
import { guardPatient } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';
import type { ReferenceData } from '../reference/lookup';
import {
  absenceProblems,
  composePss,
  keepChoices,
  PSS_SECTION_KEYS,
  type PssContent,
  type PssItem,
} from './compose';
import { renderPssPdf } from './pdf';
import { regionalAuthorIssues, regionalRegimeOf, type RegionalQueue } from './regional-queue';

/**
 * Profilo Sanitario Sintetico nel Fascicolo (tappa 11). Il medico compone dalla cartella, sceglie,
 * conferma di aver controllato; il programma scrive il documento CDA2, lo controlla con lo
 * schematron ufficiale, lo fa validare dal Gateway, lo firma PAdES e lo manda al Fascicolo della
 * Regione, che lo pubblica sul Gateway (V09, D280): con la coda degli invii e le politiche della
 * Regione (`regional-queue.ts`). Una versione nuova sostituisce la precedente, che resta
 * consultabile; il medico che l'ha scritto può oscurarlo o cancellarlo dal Fascicolo. Ogni chiamata
 * resta nel registro degli invii; ogni accesso passa dalla guardia della cartella.
 */

export interface PssDeps {
  db: Database;
  gateway: FseGatewayClient;
  /** Indirizzo di base del servizio, destinatario dei token (aud). */
  gatewayAudience: string;
  signer: DocumentSigner;
  /** La coda verso i servizi del Fascicolo regionale (D280). */
  regional: RegionalQueue;
  reference?: Pick<ReferenceData, 'municipality'>;
  now?: () => Date;
  applicationVersion?: string;
}

type Row = typeof pssDocument.$inferSelect;
type Settings = typeof fseSetting.$inferSelect;

const choiceBody = z
  .object({
    scelte: z.partialRecord(z.enum(PSS_SECTION_KEYS), z.record(z.string(), z.boolean())).optional(),
    assenze: z
      .object({
        allergie: z.enum(['no-known-allergies', 'no-allergy-info']).optional(),
        terapie: z.enum(['no-known-medications', 'no-medication-info']).optional(),
        problemi: z.enum(['no-known-problems', 'no-problem-info']).optional(),
        anamnesiFamiliare: z.enum(['no-known-problems', 'no-problem-info']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const validateBody = z.object({ confermo: z.literal(true) }).strict();
/** L'oscuramento del documento lo chiede l'assistito (DM 7/9/2023, art. 9): il medico lo conferma. */
const obscureBody = z
  .object({ oscurato: z.boolean(), richiestaAssistito: z.literal(true) })
  .strict();
const deleteBody = z.object({ confermo: z.literal(true) }).strict();
const inProgress = () =>
  new HttpError(409, 'C’è già un messaggio al Fascicolo in corso per questo Profilo');

const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** Che cosa manca nelle impostazioni del Fascicolo dello studio («da completare», D133). */
export function settingsIssues(s: Settings | undefined): string[] {
  if (!s) return ['Impostazioni del Fascicolo da completare: ancora nessuna'];
  // Repository, invii e attività clinica li mette il Fascicolo regionale quando pubblica sul
  // Gateway (V09: TipoAttivitaClinica «ERP» per il PSS): qui non servono più (D280).
  const missing: string[] = [];
  if (!s.documentIdRoot) missing.push('radice OID dei documenti');
  if (!s.custodianIdRoot || !s.custodianIdExtension || !s.custodianName) missing.push('custode');
  if (!s.custodianStreet || !s.custodianCity || !s.custodianIstatCode)
    missing.push('indirizzo del custode');
  if (!s.locality) missing.push('struttura nel formato XON');
  if (!regionalRegimeOf(s.administrativeRequest))
    missing.push('regime fra quelli della Regione (SSN, SSR, ricovero, privato, donatori)');
  return missing.length ? [`Impostazioni del Fascicolo da completare: ${missing.join(', ')}`] : [];
}

type SendRow = typeof fseRegionalSend.$inferSelect;

/** Il messaggio al Fascicolo regionale per l'interfaccia: com'è andato e che cosa succede ora. */
function sendView(s: SendRow | undefined) {
  if (!s) return null;
  return {
    id: s.id,
    operazione: s.operation,
    stato: s.status,
    tentativi: s.attempts,
    fase: s.phase,
    inCodaDal: s.queuedSince,
    prossimoTentativo: s.status === 'queued' || s.status === 'waiting' ? s.nextAttemptAt : null,
    ultimoTentativo: s.lastAttemptAt,
    ultimoErrore: s.lastError,
    errori: s.errors,
    identificativoTemporaneo: s.temporaryId,
    creatoIl: s.createdAt,
    fattoIl: s.doneAt,
  };
}

/** La parte della riga che va all'interfaccia. */
function view(r: Row, send?: SendRow) {
  return {
    id: r.id,
    stato: r.status,
    statoNome: PSS_STATUS_LABELS[r.status],
    versione: r.version,
    documento: `${r.docRoot}^${r.docExtension}`,
    contenuto: r.content as PssContent,
    sostituisce: r.replacesId,
    ultimoProblema: r.lastProblem as FseProblem | null,
    creatoIl: r.createdAt,
    validatoIl: r.validatedAt,
    firmatoIl: r.signedAt,
    inviatoIl: r.submittedAt,
    pubblicatoIl: r.publishedAt,
    sostituitoIl: r.replacedAt,
    scartatoDalFascicoloIl: r.rejectedAt,
    cancellatoIl: r.deletedAt,
    /** OID del documento nel Fascicolo regionale. */
    identificativoFascicolo: r.regionalOid,
    oscurato: r.confidentiality === 'V',
    fascicolo: sendView(send),
  };
}

export function createPssService(deps: PssDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function settingsOf(studioId: string) {
    const [s] = await db.select().from(fseSetting).where(eq(fseSetting.studioId, studioId));
    return s;
  }
  async function doctorOf(userId: string) {
    const [d] = await db.select().from(doctorProfile).where(eq(doctorProfile.userId, userId));
    return d;
  }
  /** L'ultimo messaggio al Fascicolo regionale di ogni documento. */
  async function sendsOf(docIds: string[]) {
    if (!docIds.length) return new Map<string, SendRow>();
    const rows = await db
      .select()
      .from(fseRegionalSend)
      .where(inArray(fseRegionalSend.documentId, docIds))
      .orderBy(asc(fseRegionalSend.createdAt));
    return new Map(rows.map((s) => [s.documentId, s]));
  }
  async function lastSend(docId: string) {
    return (await sendsOf([docId])).get(docId);
  }
  async function viewOf(patientId: string, docId: string) {
    return view(await load(patientId, docId), await lastSend(docId));
  }
  async function documentsOf(patientId: string) {
    return db
      .select()
      .from(pssDocument)
      .where(eq(pssDocument.patientId, patientId))
      .orderBy(desc(pssDocument.createdAt));
  }
  async function load(patientId: string, docId: string) {
    if (!z.uuid().safeParse(docId).success) throw new HttpError(404, 'Profilo non trovato');
    const [r] = await db
      .select()
      .from(pssDocument)
      .where(and(eq(pssDocument.id, docId), eq(pssDocument.patientId, patientId)));
    if (!r) throw new HttpError(404, 'Profilo non trovato');
    return r;
  }

  /** Paziente per il documento, con il comune di nascita dalla banca dati dei comuni. */
  async function patientPart(p: {
    fiscalCode: string;
    firstName: string;
    lastName: string;
    sex: string;
    birthDate: string;
    birthPlaceCode: string | null;
  }): Promise<PssContent['paziente']> {
    const m =
      p.birthPlaceCode && deps.reference
        ? await deps.reference.municipality(p.birthPlaceCode, studioDate(now()))
        : undefined;
    return {
      cf: p.fiscalCode,
      nome: p.firstName,
      cognome: p.lastName,
      sesso: p.sex === 'M' || p.sex === 'F' ? p.sex : null,
      nascita: p.birthDate,
      luogoNascita: m
        ? { istatCode: m.istatCode, city: m.name, province: m.provinceAbbr ?? null }
        : null,
    };
  }

  function caller(s: Settings, cf: string): FseCaller {
    return {
      audience: deps.gatewayAudience,
      fiscalCode: cf,
      role: 'APR',
      organizationId: s.organizationId,
      organizationName: s.organizationName,
      locality: s.locality!,
      application: {
        id: PRODUCT_NAME.toUpperCase(),
        vendor: COMPANY_BRAND,
        version: deps.applicationVersion ?? '0.0.0',
      },
    };
  }

  async function logCall(
    docId: string,
    actor: Actor,
    operation: 'validation' | 'publication' | 'replacement' | 'status',
    r: FseResult | { outcome: 'ok'; status?: number },
  ) {
    await db.insert(fseTransmission).values({
      documentId: docId,
      operation,
      outcome: r.outcome,
      httpStatus: 'status' in r && typeof r.status === 'number' ? r.status : null,
      problemType: r.outcome === 'problem' ? r.problem.type : null,
      problemTitle: r.outcome === 'problem' ? r.problem.title : null,
      problemDetail:
        r.outcome === 'problem'
          ? r.problem.detail
          : r.outcome === 'unreachable' || r.outcome === 'timeout'
            ? r.message
            : null,
      traceId: 'traceId' in r ? (r.traceId ?? null) : null,
      workflowInstanceId: 'workflowInstanceId' in r ? (r.workflowInstanceId ?? null) : null,
      actorUserId: actor.userId,
      at: now(),
    });
  }

  /** Il documento CDA2 dalle voci incluse, con le assenze per le sezioni obbligatorie vuote. */
  function cdaInput(
    r: Row,
    s: Settings,
    d: NonNullable<Awaited<ReturnType<typeof doctorOf>>>,
    replaces: Row | undefined,
    at: Date,
  ): PssCdaInput {
    const c = r.content as PssContent;
    const inc = <T>(items: PssItem<T>[]) => items.filter((i) => i.incluso).map((i) => i.dati);
    const allergies = inc(c.sezioni.allergie);
    const therapies = inc(c.sezioni.terapie);
    const problems = inc(c.sezioni.problemi);
    const family = inc(c.sezioni.anamnesiFamiliare);
    const motor = inc(c.sezioni.capacitaMotoria)[0];
    return {
      document: {
        id: { root: r.docRoot, extension: r.docExtension },
        setId: { root: r.setRoot, extension: r.setExtension },
        version: r.version,
        replaces: replaces ? { root: replaces.docRoot, extension: replaces.docExtension } : null,
        createdAt: at,
        confidentiality: 'N',
      },
      patient: {
        fiscalCode: c.paziente.cf,
        firstName: c.paziente.nome,
        lastName: c.paziente.cognome,
        sex: c.paziente.sesso!,
        birthDate: c.paziente.nascita,
        birthPlace: c.paziente.luogoNascita,
      },
      author: {
        fiscalCode: d.fiscalCode!,
        firstName: d.firstName!,
        lastName: d.lastName!,
        telecoms: { phone: d.phone, email: d.email, pec: d.pec },
        time: at,
      },
      custodian: {
        id: { root: s.custodianIdRoot!, extension: s.custodianIdExtension! },
        name: s.custodianName!,
        address: {
          istatCode: s.custodianIstatCode!,
          city: s.custodianCity!,
          province: s.custodianProvince,
          street: s.custodianStreet,
        },
      },
      legalAuthenticatorTime: at,
      serviceTime: at,
      allergies: allergies.length ? allergies : { absent: c.assenze.allergie },
      therapies: therapies.length ? therapies : { absent: c.assenze.terapie },
      problems: problems.length ? problems : { absent: c.assenze.problemi },
      familyHistory: family.length ? family : { absent: c.assenze.anamnesiFamiliare },
      vitals: inc(c.sezioni.parametri),
      lifestyle: inc(c.sezioni.stiliDiVita),
      motorCapacity: motor
        ? { code: motor.code, display: motor.display, since: motor.since }
        : null,
    };
  }

  /** Che cosa manca per poter firmare: impostazioni, medico, paziente. */
  async function blockers(actor: Actor, p: Parameters<typeof patientIssues>[0]) {
    const d = await doctorOf(actor.userId);
    const doctor = doctorIssues({
      fiscalCode: d?.fiscalCode,
      firstName: d?.firstName,
      lastName: d?.lastName,
      phone: d?.phone,
      email: d?.email,
      pec: d?.pec,
    });
    return [
      ...settingsIssues(await settingsOf(actor.studioId)),
      ...doctor,
      // Il Fascicolo regionale vuole il codice dell'ASL del medico (IstituzioneAutore, V09).
      ...regionalAuthorIssues({ ...d, aslCode: d?.aslCode }).filter(
        (m) => !doctor.length || m.includes('ASL'),
      ),
      ...patientIssues(p),
    ];
  }

  return {
    async overview(actor: Actor, patientId: string) {
      const { patient, context } = await guardPatient(
        db,
        actor,
        patientId,
        'clinical.diary.read',
        'lettura_profilo_sanitario',
      );
      const docs = await documentsOf(patientId);
      const sends = await sendsOf(docs.map((r) => r.id));
      const open = docs.find((r) =>
        ['draft', 'validated', 'signed', 'submitted'].includes(r.status),
      );
      const mancano = await blockers(actor, patient);
      const s = await settingsOf(actor.studioId);
      return {
        versioni: docs
          .filter((r) => ['published', 'replaced', 'rejected', 'deleted'].includes(r.status))
          .map((r) => {
            const v = view(r, sends.get(r.id));
            // Oscurare e cancellare li chiede il medico che l'ha scritto (V09, 5.1 e 5.3).
            return { ...v, contenuto: undefined, mio: r.authorUserId === actor.userId };
          }),
        inLavorazione: open ? view(open, sends.get(open.id)) : null,
        mancano,
        /** Chi guarda può preparare, firmare e pubblicare (titolare o sostituto). */
        puoFirmare: can(actor, 'fse.publish', { ...context, now: now() }).allowed,
        /** Invii al Fascicolo regionale sospesi dall'amministratore (FSE-INT-SRS-01-V02, 3.4). */
        inviiSospesi: s?.regionalSendingSuspended
          ? { dal: s.regionalSuspendedAt, motivo: s.regionalSuspendedReason }
          : null,
      };
    },

    /** Bozza nuova dalla cartella, o la bozza aggiornata con le scelte già fatte. */
    async compose(actor: Actor, patientId: string) {
      const { patient } = await guardPatient(
        db,
        actor,
        patientId,
        'fse.publish',
        'bozza_profilo_sanitario',
      );
      const s = await settingsOf(actor.studioId);
      if (!s?.documentIdRoot) throw new HttpError(422, settingsIssues(s)[0]!);
      const docs = await documentsOf(patientId);
      const open = docs.find((r) => ['validated', 'signed', 'submitted'].includes(r.status));
      if (open)
        throw new HttpError(
          409,
          `C'è già un Profilo in lavorazione (${PSS_STATUS_LABELS[open.status].toLowerCase()}): finiscilo o scartalo`,
        );
      const draft = docs.find((r) => r.status === 'draft');
      if (draft && draft.authorUserId !== actor.userId)
        throw new HttpError(409, 'C’è già una bozza del Profilo preparata da un altro medico');
      const fresh: PssContent = {
        composto: now().toISOString(),
        paziente: await patientPart(patient),
        ...(await composePss(db, patientId, studioDate(now()))),
      };
      if (draft) {
        const content = keepChoices(fresh, draft.content as PssContent);
        await withActor(db, actor.userId, (tx) =>
          tx
            .update(pssDocument)
            .set({ content, lastProblem: null })
            .where(eq(pssDocument.id, draft.id)),
        );
        return view(await load(patientId, draft.id));
      }
      // Stessa serie di versioni (setId) del medico, se ne ha già pubblicata una.
      const previous = docs.find(
        (r) => r.status === 'published' && r.authorUserId === actor.userId,
      );
      const setExtension = previous?.setExtension ?? `PSS.${randomUUID()}`;
      const version = previous ? previous.version + 1 : 1;
      const [row] = await withActor(db, actor.userId, (tx) =>
        tx
          .insert(pssDocument)
          .values({
            patientId,
            authorUserId: actor.userId,
            setRoot: previous?.setRoot ?? s.documentIdRoot!,
            setExtension,
            version,
            docRoot: previous?.setRoot ?? s.documentIdRoot!,
            docExtension: version === 1 ? setExtension : `${setExtension}.${version}`,
            replacesId: previous?.id ?? null,
            content: fresh,
          })
          .returning(),
      );
      return view(row!);
    },

    /** Le scelte del medico: che cosa entra, e come si dice un'assenza. Solo sulla bozza. */
    async choose(actor: Actor, patientId: string, docId: string, body: unknown) {
      await guardPatient(db, actor, patientId, 'fse.publish', 'bozza_profilo_sanitario');
      const b = choiceBody.parse(body);
      const r = await load(patientId, docId);
      if (r.status !== 'draft') throw new HttpError(409, 'Si sceglie solo sulla bozza');
      const content = structuredClone(r.content as PssContent);
      for (const [section, choices] of Object.entries(b.scelte ?? {})) {
        const items = content.sezioni[section as keyof PssContent['sezioni']] as PssItem<unknown>[];
        for (const [id, included] of Object.entries(choices)) {
          const item = items.find((i) => i.id === id);
          if (!item) throw new HttpError(400, `Voce ${id} non presente nella sezione ${section}`);
          if (included && item.manca.length)
            throw new HttpError(400, `${item.etichetta}: ${item.manca.join('; ')}`);
          item.incluso = included;
        }
      }
      content.assenze = { ...content.assenze, ...b.assenze };
      // «Nessuna … nota» solo se in cartella non c'è niente: il Profilo non dice il falso (D259).
      const untrue = absenceProblems(content);
      if (untrue.length) throw new HttpError(400, untrue.join('. '));
      await withActor(db, actor.userId, (tx) =>
        tx.update(pssDocument).set({ content }).where(eq(pssDocument.id, docId)),
      );
      return view(await load(patientId, docId));
    },

    /** Validazione: documento, controllo locale con lo schematron, poi il Gateway. */
    async validate(actor: Actor, patientId: string, docId: string, body: unknown) {
      const { patient } = await guardPatient(
        db,
        actor,
        patientId,
        'fse.publish',
        'validazione_profilo_sanitario',
      );
      validateBody.parse(body);
      const r = await load(patientId, docId);
      if (r.status !== 'draft') throw new HttpError(409, 'Si valida solo la bozza');
      if (r.authorUserId !== actor.userId)
        throw new HttpError(403, 'Il Profilo lo valida e lo firma il medico che lo ha preparato');
      const issues = [
        ...(await blockers(actor, patient)),
        ...absenceProblems(r.content as PssContent),
      ];
      if (issues.length) throw new HttpError(422, issues.join('. '), { problemi: issues });
      const s = (await settingsOf(actor.studioId))!;
      const d = (await doctorOf(actor.userId))!;
      const replaces = r.replacesId ? await load(patientId, r.replacesId) : undefined;
      const at = now();
      const xml = buildPssCda(cdaInput(r, s, d, replaces, at));
      // Prima del Gateway, gli stessi controlli dello schematron ufficiale, qui.
      const local = pssSchematron().validate(xml);
      if (local.errors.length)
        throw new HttpError(422, 'Il documento non rispetta lo schematron ufficiale', {
          problemi: local.errors.map((e) => e.message),
        });
      const pdf = await withEmbeddedCda(
        await renderPssPdf({
          content: r.content as PssContent,
          version: r.version,
          documentId: `${r.docRoot}^${r.docExtension}`,
          createdAt: at,
          doctor: {
            name: `${d.firstName} ${d.lastName}`,
            fiscalCode: d.fiscalCode!,
            phone: d.phone,
            email: d.email,
            pec: d.pec,
          },
        }),
        xml,
        at,
      );
      const res = await deps.gateway.validate(caller(s, d.fiscalCode!), patient.fiscalCode, pdf);
      await logCall(r.id, actor, 'validation', res);
      if (res.outcome !== 'ok') {
        if (res.outcome === 'problem')
          await withActor(db, actor.userId, (tx) =>
            tx
              .update(pssDocument)
              .set({ lastProblem: res.problem })
              .where(eq(pssDocument.id, r.id)),
          );
        throw gatewayError(res);
      }
      await withActor(db, actor.userId, async (tx) => {
        await tx.insert(pssFile).values({
          documentId: r.id,
          kind: 'pdf',
          content: Buffer.from(pdf),
          sha256: sha256(pdf),
        });
        await tx
          .update(pssDocument)
          .set({
            status: 'validated',
            cdaXml: xml,
            cdaSha256: sha256(xml),
            workflowInstanceId: res.workflowInstanceId ?? null,
            traceId: res.traceId,
            lastProblem: null,
            validatedAt: at,
          })
          .where(eq(pssDocument.id, r.id));
      });
      return { ...view(await load(patientId, r.id)), avviso: res.warning ?? null };
    },

    /**
     * Firma PAdES del medico, poi il Profilo va al Fascicolo regionale: in coda, e subito se si può
     * (V09, scenari 1 e 3). Con la versione precedente pubblicata nel Fascicolo regionale è una
     * sostituzione (REPLACE), altrimenti un documento nuovo (CREATE).
     */
    async signAndPublish(actor: Actor, patientId: string, docId: string) {
      await guardPatient(db, actor, patientId, 'fse.publish', 'pubblicazione_profilo_sanitario');
      let r = await load(patientId, docId);
      if (r.authorUserId !== actor.userId)
        throw new HttpError(403, 'Il Profilo lo firma il medico che lo ha preparato');
      if (r.status !== 'validated' && r.status !== 'signed')
        throw new HttpError(409, 'Si firma e si pubblica il Profilo validato dal Gateway');
      const d = (await doctorOf(actor.userId))!;
      const files = await db.select().from(pssFile).where(eq(pssFile.documentId, r.id));
      if (!files.some((f) => f.kind === 'signed_pdf')) {
        const pdf = files.find((f) => f.kind === 'pdf')!.content;
        const res = await deps.signer.signPdf(
          new Uint8Array(pdf),
          { userId: actor.userId, name: `${d.firstName} ${d.lastName}`, fiscalCode: d.fiscalCode! },
          'Profilo Sanitario Sintetico',
        );
        if (res.outcome !== 'signed')
          throw new HttpError(res.outcome === 'rejected' ? 422 : 503, res.message);
        const signed = Buffer.from(res.pdf);
        await withActor(db, actor.userId, async (tx) => {
          // Due «Firma e pubblica» insieme: il PDF firmato si salva una volta sola.
          const [d] = await tx
            .select({ status: pssDocument.status })
            .from(pssDocument)
            .where(eq(pssDocument.id, r.id))
            .for('update');
          const [already] = await tx
            .select({ id: pssFile.id })
            .from(pssFile)
            .where(and(eq(pssFile.documentId, r.id), eq(pssFile.kind, 'signed_pdf')));
          if (already || d!.status !== 'validated') return;
          await tx.insert(pssFile).values({
            documentId: r.id,
            kind: 'signed_pdf',
            content: signed,
            sha256: sha256(signed),
          });
          await tx
            .update(pssDocument)
            .set({ status: 'signed', signedAt: res.signedAt })
            .where(eq(pssDocument.id, r.id));
        });
        r = await load(patientId, docId);
      }
      // Un messaggio solo per documento: «Firma e pubblica» di nuovo lavora quello che c'è.
      const replaces = r.replacesId ? await load(patientId, r.replacesId) : undefined;
      await withActor(db, actor.userId, (tx) =>
        deps.regional.enqueue(
          tx,
          {
            documentId: r.id,
            doctorUserId: actor.userId,
            operation:
              replaces?.regionalOid && replaces.status === 'published' ? 'replace' : 'create',
          },
          (sends) => sends.every((s) => s.status === 'cancelled'),
        ),
      );
      await deps.regional.process(r.id);
      return viewOf(patientId, r.id);
    },

    /**
     * «Riprova» del medico (FSE-INT-SRS-01-V02, 3.3): il messaggio da correggere o non arrivato
     * riparte da capo; quello in coda o in attesa dell'esito parte subito.
     */
    async refreshStatus(actor: Actor, patientId: string, docId: string) {
      await guardPatient(db, actor, patientId, 'fse.publish', 'stato_profilo_sanitario');
      const r = await load(patientId, docId);
      if (r.authorUserId !== actor.userId)
        throw new HttpError(
          403,
          'I messaggi al Fascicolo li manda il medico che ha scritto il Profilo',
        );
      // Lo scarto della Regione («KO») è definitivo: il Profilo firmato non cambia più.
      if (r.status === 'rejected')
        throw new HttpError(
          409,
          'Il Fascicolo regionale ha scartato questo Profilo: preparane una versione nuova',
        );
      const s = await lastSend(r.id);
      if (!s || s.status === 'done' || s.status === 'cancelled')
        throw new HttpError(409, 'Non c’è un messaggio al Fascicolo regionale da mandare');
      await withActor(db, actor.userId, async (tx) => {
        if (s.status === 'to_fix' || s.status === 'failed') await deps.regional.retry(tx, s);
        else
          await tx
            .update(fseRegionalSend)
            .set({ nextAttemptAt: now() })
            .where(eq(fseRegionalSend.id, s.id));
      });
      await deps.regional.process(r.id);
      return viewOf(patientId, r.id);
    },

    /**
     * Oscurare il Profilo pubblicato nel Fascicolo, o togliere l'oscuramento, su richiesta
     * dell'assistito: solo i metadati (UPDATE, V09 scenario 2), «V» con P99 oppure «N».
     */
    async obscure(actor: Actor, patientId: string, docId: string, body: unknown) {
      await guardPatient(db, actor, patientId, 'fse.publish', 'oscuramento_profilo_sanitario');
      const b = obscureBody.parse(body);
      const r = await load(patientId, docId);
      if (r.authorUserId !== actor.userId)
        throw new HttpError(
          403,
          'L’oscuramento nel Fascicolo lo chiede il medico che ha scritto il Profilo',
        );
      if (r.status !== 'published' || !r.regionalOid)
        throw new HttpError(409, 'Si oscura il Profilo pubblicato nel Fascicolo regionale');
      if ((r.confidentiality === 'V') === b.oscurato)
        throw new HttpError(
          409,
          b.oscurato ? 'Il Profilo è già oscurato' : 'Il Profilo non è oscurato',
        );
      const queued = await withActor(db, actor.userId, (tx) =>
        deps.regional.enqueue(tx, {
          documentId: r.id,
          doctorUserId: actor.userId,
          operation: 'update',
          confidentiality: b.oscurato ? 'V' : 'N',
        }),
      );
      if (!queued) throw inProgress();
      await deps.regional.process(r.id);
      return viewOf(patientId, r.id);
    },

    /** Cancellare dal Fascicolo il Profilo pubblicato: solo chi l'ha scritto (V09, scenario 4). */
    async removeFromFse(actor: Actor, patientId: string, docId: string, body: unknown) {
      await guardPatient(db, actor, patientId, 'fse.publish', 'cancellazione_profilo_sanitario');
      deleteBody.parse(body);
      const r = await load(patientId, docId);
      if (r.authorUserId !== actor.userId)
        throw new HttpError(
          403,
          'Il Profilo lo cancella dal Fascicolo il medico che lo ha scritto',
        );
      if (r.status !== 'published' || !r.regionalOid)
        throw new HttpError(409, 'Si cancella il Profilo pubblicato nel Fascicolo regionale');
      const queued = await withActor(db, actor.userId, (tx) =>
        deps.regional.enqueue(tx, {
          documentId: r.id,
          doctorUserId: actor.userId,
          operation: 'delete',
        }),
      );
      if (!queued) throw inProgress();
      await deps.regional.process(r.id);
      return viewOf(patientId, r.id);
    },

    /**
     * Scartare la bozza, il Profilo validato e non firmato, o quello firmato che il Fascicolo
     * regionale non ha preso in carico (in coda, da correggere o non arrivato).
     */
    async discard(actor: Actor, patientId: string, docId: string) {
      await guardPatient(db, actor, patientId, 'fse.publish', 'scarto_profilo_sanitario');
      const r = await load(patientId, docId);
      await withActor(db, actor.userId, async (tx) => {
        // I messaggi del documento si bloccano: la coda non li prende mentre si scarta, e un
        // messaggio che sta partendo si aspetta (D280).
        const sends = await tx
          .select()
          .from(fseRegionalSend)
          .where(eq(fseRegionalSend.documentId, r.id))
          .for('update');
        if (sends.some((s) => s.leaseUntil && s.leaseUntil.getTime() > now().getTime()))
          throw new HttpError(
            409,
            'Il messaggio al Fascicolo regionale sta partendo in questo momento: riprova fra qualche secondo',
          );
        const [d] = await tx
          .select({ status: pssDocument.status })
          .from(pssDocument)
          .where(eq(pssDocument.id, r.id))
          .for('update');
        const accepted = sends.some(
          (s) => s.status === 'waiting' || s.status === 'done' || s.temporaryId,
        );
        if (!(
          d!.status === 'draft' ||
          d!.status === 'validated' ||
          (d!.status === 'signed' && !accepted)
        ))
          throw new HttpError(
            409,
            'Si scarta solo un Profilo non ancora preso in carico dal Fascicolo regionale',
          );
        await tx
          .update(fseRegionalSend)
          .set({ status: 'cancelled', doneAt: now() })
          .where(
            and(
              eq(fseRegionalSend.documentId, r.id),
              inArray(fseRegionalSend.status, ['queued', 'to_fix', 'failed']),
            ),
          );
        await tx
          .update(pssDocument)
          .set({ status: 'discarded', discardedAt: now() })
          .where(eq(pssDocument.id, r.id));
      });
      return viewOf(patientId, r.id);
    },

    /** Il PDF del Profilo: quello firmato, se c'è. */
    async pdf(actor: Actor, patientId: string, docId: string) {
      await guardPatient(db, actor, patientId, 'clinical.diary.read', 'pdf_profilo_sanitario');
      await load(patientId, docId);
      const files = await db
        .select()
        .from(pssFile)
        .where(and(eq(pssFile.documentId, docId), inArray(pssFile.kind, ['pdf', 'signed_pdf'])))
        .orderBy(asc(pssFile.createdAt));
      const f = files.find((x) => x.kind === 'signed_pdf') ?? files.find((x) => x.kind === 'pdf');
      if (!f) throw new HttpError(404, 'Il PDF c’è dopo la validazione');
      return { bytes: f.content, signed: f.kind === 'signed_pdf' };
    },

    /** Gli invii al Gateway del Profilo, dal più recente. */
    async transmissions(actor: Actor, patientId: string, docId: string) {
      await guardPatient(db, actor, patientId, 'clinical.diary.read', 'lettura_profilo_sanitario');
      await load(patientId, docId);
      return db
        .select()
        .from(fseTransmission)
        .where(eq(fseTransmission.documentId, docId))
        .orderBy(desc(fseTransmission.at));
    },
  };
}

/** L'esito del Gateway per l'interfaccia: il problema così com'è, o la rete. */
function gatewayError(res: Exclude<FseResult, { outcome: 'ok' }>): HttpError {
  if (res.outcome === 'problem')
    return new HttpError(502, `Gateway: ${res.problem.title} ${res.problem.detail}`.trim(), {
      problema: res.problem,
    });
  return new HttpError(503, res.message);
}
