/**
 * Ruoli e permessi, dalla tabella «Utenti e ruoli» di docs/requisiti.md.
 *
 * Il principio: la segreteria prepara, il medico firma e invia. Ogni archivio è di un medico
 * titolare; altri medici ci lavorano solo con un'autorizzazione attiva (sostituzione o
 * medicina di gruppo). L'amministratore gestisce lo studio ma non ha accesso clinico, se non è
 * anche medico.
 */

/** Ruoli di un utente. Un utente può averne più d'uno (es. titolare e amministratore). */
export const ROLES = ['owner_doctor', 'secretary', 'substitute_doctor', 'administrator'] as const;
export type Role = (typeof ROLES)[number];

/** Nome dei ruoli nell'interfaccia. */
export const ROLE_LABELS: Record<Role, string> = {
  owner_doctor: 'Medico titolare',
  secretary: 'Segreteria',
  substitute_doctor: 'Medico sostituto',
  administrator: 'Amministratore dello studio',
};

/** Azioni controllate. */
export const ACTIONS = [
  /** Anagrafica, dati SSN, recapiti, scelte, esenzioni, consensi e deleghe. */
  'registry.read',
  'registry.write',
  'agenda.manage',
  'patient_request.manage',
  /** Riepilogo clinico: allergie, problemi, scadenze, ultimi eventi. */
  'clinical.summary.read',
  /** Diario clinico e voci cliniche complete. */
  'clinical.diary.read',
  'clinical.write',
  /** Terapie non riservate. */
  'therapy.read',
  /** Terapie e voci riservate (opzione «Riservata» della scheda della terapia). */
  'reserved.read',
  'therapy.write',
  /** Bozza di qualsiasi ricetta. */
  'prescription.draft',
  /** Bozza di ripetizione di una terapia cronica non riservata. */
  'prescription.draft_repeat',
  'prescription.sign_send',
  'certificate.sign_send',
  /** Profilo Sanitario Sintetico: validarlo, firmarlo e pubblicarlo nel Fascicolo (tappa 11). */
  'fse.publish',
  'reminder.print',
  /** Registro degli accessi dell'archivio. */
  'access_log.read',
  /** Esportazione completa dei dati dell'archivio. */
  'data.export',
  /** Impostazioni dell'archivio: che cosa vede la segreteria. */
  'archive.settings',
  /** Autorizzazioni sull'archivio: sostituto e colleghi di medicina di gruppo (tappa 14). */
  'archive.grants',
  /** Dati e impostazioni dello studio: dati, postazioni, sicurezza, invii, avvisi (tappa 14). */
  'admin.studio',
  'admin.users',
  'admin.printers',
  'admin.headers',
  'admin.templates',
  /** Avviare subito l'aggiornamento delle banche dati, senza aspettare la notte (D156). */
  'admin.reference_data',
  /**
   * Elenchi dello studio: medici suggeritori, posologie, pacchetti di prestazioni, contatti utili
   * (tappa 14). Azione sullo studio, non su un archivio.
   */
  'studio.lists',
  /** Registro delle azioni di amministrazione (utenti, ruoli, impostazioni), in sola lettura. */
  'studio.admin_log',
] as const;
export type Action = (typeof ACTIONS)[number];

/** Nome delle azioni nell'interfaccia e nella documentazione. */
export const ACTION_LABELS: Record<Action, string> = {
  'registry.read': 'Leggere anagrafica, dati SSN, esenzioni, consensi e deleghe',
  'registry.write': 'Modificare anagrafica, recapiti, esenzioni, consensi e deleghe',
  'agenda.manage': 'Gestire l’agenda',
  'patient_request.manage': 'Gestire le richieste dei pazienti',
  'clinical.summary.read': 'Leggere il riepilogo clinico (allergie, problemi, scadenze)',
  'clinical.diary.read': 'Leggere il diario clinico',
  'clinical.write': 'Scrivere voci cliniche',
  'therapy.read': 'Leggere le terapie non riservate',
  'reserved.read': 'Leggere terapie e voci riservate',
  'therapy.write': 'Modificare le terapie',
  'prescription.draft': 'Preparare una ricetta nuova',
  'prescription.draft_repeat': 'Preparare la bozza di una ricetta ripetuta',
  'prescription.sign_send': 'Firmare e inviare le ricette',
  'certificate.sign_send': 'Firmare e inviare i certificati',
  'fse.publish': 'Firmare e pubblicare il Profilo Sanitario Sintetico nel Fascicolo',
  'reminder.print': 'Stampare i promemoria',
  'access_log.read': 'Leggere il registro degli accessi',
  'data.export': 'Esportare tutti i dati dell’archivio',
  'archive.settings': 'Decidere che cosa vede la segreteria dell’archivio',
  'archive.grants': 'Autorizzare un sostituto o un collega di gruppo sull’archivio',
  'admin.studio': 'Modificare i dati e le impostazioni dello studio',
  'admin.users': 'Gestire gli utenti dello studio',
  'admin.printers': 'Gestire le stampanti',
  'admin.headers': 'Gestire le intestazioni',
  'admin.templates': 'Gestire i modelli',
  'admin.reference_data': 'Avviare subito l’aggiornamento delle banche dati',
  'studio.lists':
    'Modificare gli elenchi dello studio (suggeritori, posologie, pacchetti, contatti)',
  'studio.admin_log': 'Leggere il registro delle azioni di amministrazione',
};

const DOCTOR_ON_OWN_ARCHIVE: Action[] = [
  'registry.read',
  'registry.write',
  'agenda.manage',
  'patient_request.manage',
  'clinical.summary.read',
  'clinical.diary.read',
  'clinical.write',
  'therapy.read',
  'reserved.read',
  'therapy.write',
  'prescription.draft',
  'prescription.draft_repeat',
  'prescription.sign_send',
  'certificate.sign_send',
  'fse.publish',
  'reminder.print',
  'access_log.read',
  'data.export',
  'archive.settings',
  'archive.grants',
];

/**
 * Medico che lavora su un archivio non suo con un'autorizzazione attiva. Le ricette e i
 * certificati restano a nome suo. Non esporta i dati e non legge il registro degli accessi:
 * i dati sono del titolare (decisione D21).
 */
const DOCTOR_ON_GRANTED_ARCHIVE: Action[] = DOCTOR_ON_OWN_ARCHIVE.filter(
  (a) =>
    a !== 'data.export' &&
    a !== 'access_log.read' &&
    a !== 'archive.settings' &&
    a !== 'archive.grants',
);

/** Segreteria condivisa dello studio: lavora su tutti gli archivi dello studio. */
const SECRETARY: Action[] = [
  'registry.read',
  'registry.write',
  'agenda.manage',
  'patient_request.manage',
  'therapy.read',
  'prescription.draft_repeat',
  'reminder.print',
];

const ADMINISTRATOR: Action[] = [
  'admin.studio',
  'admin.users',
  'admin.printers',
  'admin.headers',
  'admin.templates',
  'admin.reference_data',
];

export const ADMIN_ACTIONS: readonly Action[] = ADMINISTRATOR;

/**
 * Azioni sullo studio, non su un archivio, che non sono solo dell'amministratore: chi le fa dipende
 * dal ruolo (tappa 14). Gli elenchi dello studio li curano i medici e l'amministratore, e la
 * segreteria li usa; il registro delle azioni di amministrazione lo leggono l'amministratore e i
 * titolari, perché un ruolo dato da un amministratore apre le cartelle (D163).
 */
export const STUDIO_ACTION_ROLES: Partial<Record<Action, readonly Role[]>> = {
  'studio.lists': ['owner_doctor', 'substitute_doctor', 'administrator'],
  'studio.admin_log': ['owner_doctor', 'administrator'],
};

export type GrantKind = 'substitution' | 'group_colleague';

/** Autorizzazione di un medico su un archivio non suo. */
export interface ArchiveGrant {
  archiveId: string;
  granteeUserId: string;
  kind: GrantKind;
  validFrom: Date;
  validTo: Date;
  revokedAt?: Date | null;
}

export interface Actor {
  userId: string;
  studioId: string;
  roles: readonly Role[];
}

export interface AccessContext {
  /** Archivio su cui si agisce; assente per le azioni di amministrazione dello studio. */
  archive?: { id: string; studioId: string; ownerUserId: string };
  grants?: readonly ArchiveGrant[];
  /** Impostazioni dell'archivio decise dal titolare (D30). Assenti = spente. */
  settings?: { secretaryCanReadDiary: boolean; secretaryCanReadSummary?: boolean };
  /** Risorsa toccata, quando conta. */
  resource?: { reserved?: boolean; therapyKind?: 'chronic' | 'as_needed' | 'cycle' };
  now?: Date;
}

export interface Decision {
  allowed: boolean;
  /** Motivo in chiaro, per l'interfaccia e per il registro degli accessi. */
  reason: string;
}

const allow = (reason: string): Decision => ({ allowed: true, reason });
const deny = (reason: string): Decision => ({ allowed: false, reason });

const isDoctor = (roles: readonly Role[]) =>
  roles.includes('owner_doctor') || roles.includes('substitute_doctor');

function activeGrant(actor: Actor, ctx: AccessContext): ArchiveGrant | undefined {
  const now = ctx.now ?? new Date();
  return ctx.grants?.find(
    (g) =>
      g.archiveId === ctx.archive?.id &&
      g.granteeUserId === actor.userId &&
      !g.revokedAt &&
      g.validFrom <= now &&
      now <= g.validTo,
  );
}

/** Decide se `actor` può fare `action` nel contesto dato. Per difetto: no. */
export function can(actor: Actor, action: Action, ctx: AccessContext = {}): Decision {
  const studioRoles = STUDIO_ACTION_ROLES[action];
  if (studioRoles) {
    if (ctx.archive) return deny('Azione sullo studio, non su un archivio');
    return actor.roles.some((r) => studioRoles.includes(r))
      ? allow('Ruolo previsto per questa azione dello studio')
      : deny('Azione non prevista per il tuo ruolo');
  }
  if (ADMINISTRATOR.includes(action)) {
    if (ctx.archive) return deny('Le azioni di amministrazione non riguardano un archivio');
    return actor.roles.includes('administrator')
      ? allow('Amministratore dello studio')
      : deny('Serve il ruolo di amministratore dello studio');
  }

  const archive = ctx.archive;
  if (!archive) return deny('Azione su un archivio senza archivio indicato');
  if (archive.studioId !== actor.studioId) return deny('Archivio di un altro studio');

  const reserved = ctx.resource?.reserved === true;
  const candidates: Decision[] = [];

  if (isDoctor(actor.roles)) {
    if (archive.ownerUserId === actor.userId && actor.roles.includes('owner_doctor')) {
      candidates.push(
        DOCTOR_ON_OWN_ARCHIVE.includes(action)
          ? allow('Medico titolare del proprio archivio')
          : deny('Azione non prevista per il medico titolare'),
      );
    } else {
      const grant = activeGrant(actor, ctx);
      if (grant) {
        const label = grant.kind === 'substitution' ? 'Sostituzione' : 'Medicina di gruppo';
        // Il Profilo Sanitario Sintetico lo scrive il medico di famiglia del paziente (DM 7/9/2023,
        // art. 4): il titolare, o il sostituto durante la sostituzione; non il collega di gruppo.
        if (action === 'fse.publish' && grant.kind !== 'substitution')
          candidates.push(
            deny('Il Profilo lo firma il medico di famiglia del paziente o il suo sostituto'),
          );
        else
          candidates.push(
            DOCTOR_ON_GRANTED_ARCHIVE.includes(action)
              ? allow(`${label} attiva su questo archivio`)
              : deny(`${label}: azione riservata al titolare`),
          );
      } else {
        candidates.push(deny('Nessuna autorizzazione attiva su questo archivio'));
      }
    }
  }

  if (actor.roles.includes('secretary')) {
    if (action === 'clinical.diary.read') {
      candidates.push(
        ctx.settings?.secretaryCanReadDiary
          ? allow('Il titolare consente alla segreteria di leggere il diario')
          : deny('La segreteria non legge il diario clinico (impostazione del titolare)'),
      );
    } else if (reserved) {
      candidates.push(deny('Dato riservato: visibile solo al medico'));
    } else if (action === 'clinical.summary.read') {
      candidates.push(
        ctx.settings?.secretaryCanReadSummary
          ? allow('Il titolare consente alla segreteria il riepilogo clinico')
          : deny('La segreteria non legge il riepilogo clinico (impostazione del titolare)'),
      );
    } else if (action === 'prescription.draft_repeat' && ctx.resource?.therapyKind !== 'chronic') {
      candidates.push(deny('La segreteria prepara solo ripetizioni di terapie croniche'));
    } else {
      candidates.push(
        SECRETARY.includes(action)
          ? allow('Segreteria dello studio')
          : deny('Azione riservata al medico'),
      );
    }
  }

  if (candidates.length === 0) {
    return deny(
      actor.roles.includes('administrator')
        ? 'Nessun accesso clinico: l’amministratore non è anche medico'
        : 'Nessun ruolo con accesso a questo archivio',
    );
  }
  return candidates.find((d) => d.allowed) ?? candidates[0]!;
}
