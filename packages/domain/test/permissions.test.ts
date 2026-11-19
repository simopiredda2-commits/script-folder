import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  can,
  opensPatientData,
  PATIENT_DATA_ROLES,
  type AccessContext,
  type Action,
  type Actor,
  type ArchiveGrant,
} from '../src/permissions';

const STUDIO = 'studio-1';
const archiveRocca = { id: 'arch-titolare', studioId: STUDIO, ownerUserId: 'u-titolare' };
const archiveCollega = { id: 'arch-collega', studioId: STUDIO, ownerUserId: 'u-collega' };

const titolare: Actor = { userId: 'u-titolare', studioId: STUDIO, roles: ['owner_doctor'] };
const collega: Actor = { userId: 'u-collega', studioId: STUDIO, roles: ['owner_doctor'] };
const segreteria: Actor = { userId: 'u-segr', studioId: STUDIO, roles: ['secretary'] };
const sostituto: Actor = { userId: 'u-sost', studioId: STUDIO, roles: ['substitute_doctor'] };
const amministratore: Actor = { userId: 'u-adm', studioId: STUDIO, roles: ['administrator'] };
const titolareAmministratore: Actor = {
  userId: 'u-titolare',
  studioId: STUDIO,
  roles: ['owner_doctor', 'administrator'],
};

const now = new Date('2026-11-18T10:00:00+01:00');
const sostituzione: ArchiveGrant = {
  archiveId: archiveRocca.id,
  granteeUserId: sostituto.userId,
  kind: 'substitution',
  validFrom: new Date('2026-11-16T00:00:00+01:00'),
  validTo: new Date('2026-11-20T23:59:59+01:00'),
};
const gruppo: ArchiveGrant = {
  archiveId: archiveRocca.id,
  granteeUserId: collega.userId,
  kind: 'group_colleague',
  validFrom: new Date('2026-11-01T00:00:00+01:00'),
  validTo: new Date('2026-12-31T23:59:59+01:00'),
};

const ctx = (extra: Partial<AccessContext> = {}): AccessContext => ({
  archive: archiveRocca,
  grants: [sostituzione, gruppo],
  settings: { secretaryCanReadDiary: false },
  // La segreteria confermata dalla titolare per il suo archivio (D181).
  secretaries: [segreteria.userId],
  now,
  ...extra,
});

const ok = (a: Actor, action: Action, c: AccessContext = ctx()) => can(a, action, c).allowed;
/** Azioni sullo studio, non su un archivio (tappa 14). */
const onStudio = (a: Action) => a.startsWith('admin.') || a.startsWith('studio.');

describe('medico titolare: «tutto sui propri assistiti; firma e invia ricette e certificati»', () => {
  it.each(ACTIONS.filter((a) => !onStudio(a)))('può %s sul proprio archivio', (a) => {
    expect(ok(titolare, a)).toBe(true);
  });
  it('vede anche le terapie riservate', () => {
    expect(ok(titolare, 'therapy.read', ctx({ resource: { reserved: true } }))).toBe(true);
  });
  it('non lavora sull’archivio di un collega senza autorizzazione', () => {
    expect(ok(titolare, 'clinical.summary.read', ctx({ archive: archiveCollega }))).toBe(false);
  });
  it('non amministra lo studio se non ha anche il ruolo di amministratore', () => {
    expect(ok(titolare, 'admin.users', {})).toBe(false);
    expect(ok(titolareAmministratore, 'admin.users', {})).toBe(true);
  });
});

describe('segreteria: «anagrafiche, agenda, richieste, bozze di ricette ripetute, promemoria»', () => {
  const consentite: Action[] = [
    'registry.read',
    'registry.write',
    'agenda.manage',
    'patient_request.manage',
    'therapy.read',
    'reminder.print',
  ];
  it.each(consentite)('può %s', (a) => expect(ok(segreteria, a)).toBe(true));

  it('prepara bozze di ripetizione solo di terapie croniche', () => {
    const cronica = ctx({ resource: { therapyKind: 'chronic' } });
    const alBisogno = ctx({ resource: { therapyKind: 'as_needed' } });
    expect(ok(segreteria, 'prescription.draft_repeat', cronica)).toBe(true);
    expect(ok(segreteria, 'prescription.draft_repeat', alBisogno)).toBe(false);
  });

  it('«non può firmare né inviare al SAR»', () => {
    expect(ok(segreteria, 'prescription.sign_send')).toBe(false);
    expect(ok(segreteria, 'certificate.sign_send')).toBe(false);
  });

  it('non prepara ricette nuove: solo ripetizioni', () => {
    expect(ok(segreteria, 'prescription.draft')).toBe(false);
  });

  it('«non può leggere il diario clinico (configurabile)»', () => {
    expect(ok(segreteria, 'clinical.diary.read')).toBe(false);
    const consentito = ctx({ settings: { secretaryCanReadDiary: true } });
    expect(ok(segreteria, 'clinical.diary.read', consentito)).toBe(true);
  });

  it('vede solo le terapie non riservate e non ripete quelle riservate', () => {
    const riservata = ctx({ resource: { reserved: true, therapyKind: 'chronic' } });
    expect(ok(segreteria, 'therapy.read', riservata)).toBe(false);
    expect(ok(segreteria, 'prescription.draft_repeat', riservata)).toBe(false);
  });

  it('non esporta i dati e non legge il registro degli accessi', () => {
    expect(ok(segreteria, 'data.export')).toBe(false);
    expect(ok(segreteria, 'access_log.read')).toBe(false);
  });

  it('lavora su tutti gli archivi dello studio (segreteria condivisa)', () => {
    expect(ok(segreteria, 'registry.read', ctx({ archive: archiveCollega }))).toBe(true);
  });
});

describe('scelte della prima fermata: il titolare decide che cosa vede la segreteria', () => {
  it('per difetto la segreteria non vede il riepilogo clinico', () => {
    expect(ok(segreteria, 'clinical.summary.read')).toBe(false);
  });
  it('se il titolare lo consente, vede il riepilogo ma non i dati riservati', () => {
    const consentito = ctx({
      settings: { secretaryCanReadDiary: false, secretaryCanReadSummary: true },
    });
    expect(ok(segreteria, 'clinical.summary.read', consentito)).toBe(true);
    const riservato = ctx({
      settings: { secretaryCanReadDiary: false, secretaryCanReadSummary: true },
      resource: { reserved: true },
    });
    expect(ok(segreteria, 'clinical.summary.read', riservato)).toBe(false);
  });
  it('solo il titolare cambia le impostazioni del proprio archivio', () => {
    expect(ok(titolare, 'archive.settings')).toBe(true);
    expect(ok(sostituto, 'archive.settings')).toBe(false);
    expect(ok(collega, 'archive.settings')).toBe(false);
    expect(ok(segreteria, 'archive.settings')).toBe(false);
    expect(ok(amministratore, 'archive.settings')).toBe(false);
  });
});

describe('medico sostituto: «lavora sull’archivio del titolare per un periodo»', () => {
  it('nel periodo lavora sull’archivio, firma e invia (a nome suo)', () => {
    expect(ok(sostituto, 'clinical.diary.read')).toBe(true);
    expect(ok(sostituto, 'prescription.sign_send')).toBe(true);
  });
  it('fuori dal periodo non accede', () => {
    expect(
      ok(sostituto, 'clinical.summary.read', ctx({ now: new Date('2026-11-21T09:00:00+01:00') })),
    ).toBe(false);
    expect(
      ok(sostituto, 'clinical.summary.read', ctx({ now: new Date('2026-11-15T09:00:00+01:00') })),
    ).toBe(false);
  });
  it('con l’autorizzazione revocata non accede', () => {
    const revocata = { ...sostituzione, revokedAt: new Date('2026-11-17T00:00:00+01:00') };
    expect(ok(sostituto, 'clinical.summary.read', ctx({ grants: [revocata] }))).toBe(false);
  });
  it('non esporta i dati del titolare e non legge il registro degli accessi', () => {
    expect(ok(sostituto, 'data.export')).toBe(false);
    expect(ok(sostituto, 'access_log.read')).toBe(false);
  });
  it('non accede ad altri archivi', () => {
    expect(ok(sostituto, 'clinical.summary.read', ctx({ archive: archiveCollega }))).toBe(false);
  });
});

describe('medicina di gruppo: «archivi separati; vedere i pazienti di un collega solo alle condizioni previste»', () => {
  it('con un’autorizzazione di gruppo attiva il collega accede', () => {
    expect(ok(collega, 'clinical.summary.read')).toBe(true);
  });
  it('senza autorizzazione no', () => {
    expect(ok(collega, 'clinical.summary.read', ctx({ grants: [] }))).toBe(false);
  });
  it('il titolare non vede l’archivio del collega senza un’autorizzazione nel verso opposto', () => {
    expect(ok(titolare, 'registry.read', ctx({ archive: archiveCollega }))).toBe(false);
  });
});

describe('amministratore: «utenti, stampanti, intestazioni, modelli; nessun accesso clinico»', () => {
  it.each(['admin.users', 'admin.printers', 'admin.headers', 'admin.templates'] as Action[])(
    'può %s',
    (a) => expect(ok(amministratore, a, {})).toBe(true),
  );
  it.each(ACTIONS.filter((a) => !onStudio(a)))('non può %s', (a) => {
    expect(ok(amministratore, a)).toBe(false);
  });
});

describe('azioni sullo studio di più ruoli (tappa 14)', () => {
  it('gli elenchi dello studio li curano i titolari e l’amministratore, non la segreteria', () => {
    for (const a of [titolare, collega, amministratore])
      expect(ok(a, 'studio.lists', {})).toBe(true);
    expect(ok(segreteria, 'studio.lists', {})).toBe(false);
    expect(ok(segreteria, 'studio.lists', { grants: [sostituzione], now })).toBe(false);
  });
  it('il sostituto li scrive solo con un’autorizzazione attiva su un archivio dello studio (D181)', () => {
    expect(ok(sostituto, 'studio.lists', {})).toBe(false);
    expect(can(sostituto, 'studio.lists', {}).reason).toBe(
      'Serve un’autorizzazione attiva su un archivio dello studio',
    );
    expect(ok(sostituto, 'studio.lists', { grants: [sostituzione], now })).toBe(true);
    // Scaduta, non ancora cominciata, revocata, o di un altro medico: no.
    expect(
      ok(sostituto, 'studio.lists', {
        grants: [sostituzione],
        now: new Date('2026-11-21T10:00:00+01:00'),
      }),
    ).toBe(false);
    expect(
      ok(sostituto, 'studio.lists', {
        grants: [sostituzione],
        now: new Date('2026-11-15T10:00:00+01:00'),
      }),
    ).toBe(false);
    expect(
      ok(sostituto, 'studio.lists', { grants: [{ ...sostituzione, revokedAt: now }], now }),
    ).toBe(false);
    expect(ok(sostituto, 'studio.lists', { grants: [gruppo], now })).toBe(false);
    // Con un altro ruolo che basta da solo, l'autorizzazione non serve.
    const sostitutoAmministratore: Actor = {
      ...sostituto,
      roles: ['substitute_doctor', 'administrator'],
    };
    expect(ok(sostitutoAmministratore, 'studio.lists', {})).toBe(true);
  });
  it('il registro di amministrazione lo leggono l’amministratore e i titolari', () => {
    for (const a of [titolare, collega, amministratore])
      expect(ok(a, 'studio.admin_log', {})).toBe(true);
    for (const a of [sostituto, segreteria]) expect(ok(a, 'studio.admin_log', {})).toBe(false);
  });
  it('gli utenti creati o cambiati dall’amministratore li conferma solo un titolare', () => {
    for (const a of [titolare, collega, titolareAmministratore])
      expect(ok(a, 'studio.confirm_users', {})).toBe(true);
    for (const a of [amministratore, segreteria, sostituto])
      expect(ok(a, 'studio.confirm_users', {})).toBe(false);
    expect(ok(titolare, 'studio.confirm_users', ctx())).toBe(false);
  });
  it('i ruoli che aprono dati dei pazienti: titolare, sostituto, segreteria; non l’amministratore', () => {
    expect(PATIENT_DATA_ROLES).toEqual(['owner_doctor', 'secretary', 'substitute_doctor']);
    for (const a of [titolare, segreteria, sostituto, titolareAmministratore])
      expect(opensPatientData(a.roles)).toBe(true);
    expect(opensPatientData(amministratore.roles)).toBe(false);
    expect(opensPatientData([])).toBe(false);
    // Coerente con le decisioni: chi apre dati dei pazienti legge l'anagrafica di un archivio,
    // con un'autorizzazione se non è suo; l'amministratore no.
    for (const a of [titolare, segreteria, sostituto])
      expect(ok(a, 'registry.read'), a.userId).toBe(true);
  });
  it('non riguardano un archivio', () => {
    expect(ok(titolare, 'studio.lists', ctx())).toBe(false);
  });
  it('le autorizzazioni sull’archivio le dà solo il titolare, sul proprio', () => {
    expect(ok(titolare, 'archive.grants')).toBe(true);
    expect(ok(sostituto, 'archive.grants')).toBe(false);
    expect(ok(collega, 'archive.grants')).toBe(false);
    expect(ok(amministratore, 'archive.grants')).toBe(false);
  });
  it('lo spostamento nell’archivio del medico scelto in AURA lo decide solo il titolare (D200)', () => {
    expect(ok(titolare, 'archive.transfer')).toBe(true);
    // Né il sostituto né il collega di gruppo, anche con l'autorizzazione attiva.
    const grants = ctx({
      grants: [
        sostituzione,
        { ...sostituzione, granteeUserId: collega.userId, kind: 'group_colleague' },
      ],
    });
    expect(ok(sostituto, 'archive.transfer', grants)).toBe(false);
    expect(ok(collega, 'archive.transfer', grants)).toBe(false);
    expect(ok(segreteria, 'archive.transfer', ctx({ secretaries: [segreteria.userId] }))).toBe(
      false,
    );
    expect(ok(amministratore, 'archive.transfer')).toBe(false);
  });
});

describe('autorizzazioni date per errore a chi non è medico', () => {
  it('un’autorizzazione su un archivio non dà accesso clinico all’amministratore', () => {
    const errata: ArchiveGrant = { ...sostituzione, granteeUserId: amministratore.userId };
    const c = ctx({ grants: [errata] });
    expect(ok(amministratore, 'clinical.summary.read', c)).toBe(false);
    expect(ok(amministratore, 'prescription.sign_send', c)).toBe(false);
  });
  it('né alla segreteria oltre ai suoi permessi', () => {
    const errata: ArchiveGrant = { ...sostituzione, granteeUserId: segreteria.userId };
    expect(ok(segreteria, 'prescription.sign_send', ctx({ grants: [errata] }))).toBe(false);
  });
});

describe('regole generali', () => {
  it('nessuno accede a un archivio di un altro studio', () => {
    const altro = { id: 'x', studioId: 'studio-2', ownerUserId: 'u-titolare' };
    expect(ok(titolare, 'registry.read', ctx({ archive: altro }))).toBe(false);
    expect(ok(segreteria, 'registry.read', ctx({ archive: altro }))).toBe(false);
  });
  it('un utente senza ruoli non può nulla', () => {
    const nessuno: Actor = { userId: 'u-0', studioId: STUDIO, roles: [] };
    for (const a of ACTIONS) expect(ok(nessuno, a, onStudio(a) ? {} : ctx())).toBe(false);
  });
  it('ogni decisione ha un motivo in chiaro', () => {
    expect(can(segreteria, 'prescription.sign_send', ctx()).reason).toMatch(/medico/);
  });
});

describe('Profilo Sanitario Sintetico: lo firma il medico di famiglia del paziente (tappa 11)', () => {
  it('il titolare e il sostituto nel periodo sì; il collega di gruppo, la segreteria e l’amministratore no', () => {
    expect(ok(titolare, 'fse.publish')).toBe(true);
    expect(ok(sostituto, 'fse.publish')).toBe(true);
    expect(can(collega, 'fse.publish', ctx())).toEqual({
      allowed: false,
      reason: 'Il Profilo lo firma il medico di famiglia del paziente o il suo sostituto',
    });
    // Il collega di gruppo autorizzato lavora comunque sulla cartella.
    expect(ok(collega, 'clinical.write')).toBe(true);
    expect(ok(segreteria, 'fse.publish')).toBe(false);
    expect(ok(amministratore, 'fse.publish')).toBe(false);
    // Il sostituto fuori dal periodo no.
    expect(ok(sostituto, 'fse.publish', ctx({ now: new Date('2026-11-25T10:00:00+01:00') }))).toBe(
      false,
    );
  });
});

describe('segreteria confermata per archivio (D181)', () => {
  it('senza la conferma del titolare di quell’archivio non fa nulla, nemmeno l’anagrafica', () => {
    for (const a of ['registry.read', 'agenda.manage', 'prescription.draft_repeat'] as const) {
      expect(ok(segreteria, a, ctx({ secretaries: [] })), a).toBe(false);
      expect(ok(segreteria, a, ctx({ secretaries: undefined })), a).toBe(false);
    }
    expect(can(segreteria, 'registry.read', ctx({ secretaries: [] })).reason).toBe(
      'La segreteria lavora su questo archivio dopo la conferma del suo titolare',
    );
    // Confermata per l'archivio della titolare, non per quello del collega.
    expect(ok(segreteria, 'registry.read')).toBe(true);
    expect(ok(segreteria, 'registry.read', ctx({ archive: archiveCollega, secretaries: [] }))).toBe(
      false,
    );
    // Un'altra segreteria confermata non conta per lei.
    expect(ok(segreteria, 'registry.read', ctx({ secretaries: ['u-altra'] }))).toBe(false);
  });
  it('per i medici la conferma della segreteria non cambia nulla', () => {
    expect(ok(titolare, 'clinical.write', ctx({ secretaries: [] }))).toBe(true);
    expect(ok(sostituto, 'registry.read', ctx({ secretaries: [] }))).toBe(true);
  });
});
