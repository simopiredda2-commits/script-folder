import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  can,
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
  now,
  ...extra,
});

const ok = (a: Actor, action: Action, c: AccessContext = ctx()) => can(a, action, c).allowed;

describe('medico titolare: «tutto sui propri assistiti; firma e invia ricette e certificati»', () => {
  it.each(ACTIONS.filter((a) => !a.startsWith('admin.')))('può %s sul proprio archivio', (a) => {
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
  it.each(ACTIONS.filter((a) => !a.startsWith('admin.')))('non può %s', (a) => {
    expect(ok(amministratore, a)).toBe(false);
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
    for (const a of ACTIONS)
      expect(ok(nessuno, a, a.startsWith('admin.') ? {} : ctx())).toBe(false);
  });
  it('ogni decisione ha un motivo in chiaro', () => {
    expect(can(segreteria, 'prescription.sign_send', ctx()).reason).toMatch(/medico/);
  });
});
