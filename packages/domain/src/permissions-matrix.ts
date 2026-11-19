import {
  ACTION_LABELS,
  ACTIONS,
  can,
  type AccessContext,
  type Action,
  type Actor,
  type ArchiveGrant,
} from './permissions';

/**
 * Matrice dei permessi per la documentazione (docs/ruoli-permessi.md), calcolata chiamando
 * `can()`: il documento dice esattamente ciò che fa il codice.
 */
const STUDIO = 'studio';
const own = { id: 'archivio-titolare', studioId: STUDIO, ownerUserId: 'titolare' };
const at = new Date('2026-06-15T10:00:00Z');
const grant = (granteeUserId: string, kind: ArchiveGrant['kind']): ArchiveGrant => ({
  archiveId: own.id,
  granteeUserId,
  kind,
  validFrom: new Date('2026-06-01T00:00:00Z'),
  validTo: new Date('2026-06-30T23:59:59Z'),
});

interface Column {
  title: string;
  actor: Actor;
  grants: ArchiveGrant[];
}

const columns: Column[] = [
  {
    title: 'Titolare (proprio archivio)',
    actor: { userId: 'titolare', studioId: STUDIO, roles: ['owner_doctor'] },
    grants: [],
  },
  {
    title: 'Segreteria',
    actor: { userId: 'segreteria', studioId: STUDIO, roles: ['secretary'] },
    grants: [],
  },
  {
    title: 'Sostituto (nel periodo)',
    actor: { userId: 'sostituto', studioId: STUDIO, roles: ['substitute_doctor'] },
    grants: [grant('sostituto', 'substitution')],
  },
  {
    title: 'Collega di gruppo (autorizzato)',
    actor: { userId: 'collega', studioId: STUDIO, roles: ['owner_doctor'] },
    grants: [grant('collega', 'group_colleague')],
  },
  {
    title: 'Collega di gruppo (senza autorizzazione)',
    actor: { userId: 'collega', studioId: STUDIO, roles: ['owner_doctor'] },
    grants: [],
  },
  {
    title: 'Amministratore',
    actor: { userId: 'amministratore', studioId: STUDIO, roles: ['administrator'] },
    grants: [],
  },
];

function cell(col: Column, action: Action): string {
  // Azioni sullo studio, senza archivio: dell'amministratore, o di più ruoli (STUDIO_ACTION_ROLES).
  const isAdmin = action.startsWith('admin.') || action.startsWith('studio.');
  const base: AccessContext = isAdmin
    ? { now: at }
    : {
        archive: own,
        grants: col.grants,
        settings: { secretaryCanReadDiary: false, secretaryCanReadSummary: false },
        now: at,
      };
  if (!can(col.actor, action, base).allowed) {
    if (action === 'clinical.summary.read') {
      const configurable = can(col.actor, action, {
        ...base,
        settings: { secretaryCanReadDiary: false, secretaryCanReadSummary: true },
      });
      if (configurable.allowed) return 'Se il titolare lo consente';
    }
    if (action === 'clinical.diary.read') {
      const configurable = can(col.actor, action, {
        ...base,
        settings: { secretaryCanReadDiary: true, secretaryCanReadSummary: false },
      });
      if (configurable.allowed) return 'Se il titolare lo consente';
    }
    if (action === 'prescription.draft_repeat') {
      const chronic = can(col.actor, action, { ...base, resource: { therapyKind: 'chronic' } });
      if (chronic.allowed) return 'Solo terapie croniche non riservate';
    }
    return 'No';
  }
  if (action === 'prescription.draft_repeat') {
    const chronic = can(col.actor, action, {
      ...base,
      resource: { therapyKind: 'chronic', reserved: true },
    });
    if (!chronic.allowed) return 'Solo terapie croniche non riservate';
  }
  if (action === 'therapy.read') {
    const reserved = can(col.actor, action, { ...base, resource: { reserved: true } });
    if (!reserved.allowed) return 'Solo non riservate';
  }
  return 'Sì';
}

export function renderPermissionsMatrix(): string {
  const header = `| Azione | ${columns.map((c) => c.title).join(' | ')} |`;
  const sep = `| --- | ${columns.map(() => '---').join(' | ')} |`;
  const rows = ACTIONS.map(
    (a) => `| ${ACTION_LABELS[a]} | ${columns.map((c) => cell(c, a)).join(' | ')} |`,
  );
  return [header, sep, ...rows].join('\n');
}
