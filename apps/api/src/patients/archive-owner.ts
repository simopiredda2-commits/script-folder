import { eq } from 'drizzle-orm';
import { appUser, archive } from '../db/schema';
import type { Tx } from '../db/tx';

/** Il titolare dell'archivio è sospeso: nel suo archivio non entrano pazienti nuovi. */
export const OWNER_SUSPENDED_NO_NEW_PATIENTS =
  'Il medico titolare dell’archivio è sospeso: nel suo archivio non entrano pazienti nuovi';
/** L'utente dell'archivio non ha più il ruolo di titolare: lo stesso. */
export const OWNER_GONE_NO_NEW_PATIENTS =
  'L’utente dell’archivio non è più medico titolare: nel suo archivio non entrano pazienti nuovi';
/**
 * Il titolare aspetta la conferma di un altro titolare o del server (D179): nel suo archivio non
 * entrano pazienti finché non è confermato. Altrimenti un titolare creato dall'amministratore, e mai
 * confermato, raccoglierebbe pazienti che il titolare vero non vede.
 */
export const OWNER_AWAITING_NO_NEW_PATIENTS =
  'Il medico titolare dell’archivio non è ancora confermato: nel suo archivio non entrano pazienti nuovi';

/**
 * Prima di far entrare pazienti nuovi in un archivio (pannello del paziente, importazione). La riga
 * dell'archivio si blocca FOR KEY SHARE, che aspetta la sospensione del titolare in corso: la
 * sospensione, e il cambio di ruolo, bloccano gli archivi del titolare FOR UPDATE prima di contarne
 * i pazienti (admin/user-service.ts, lockOwnerArchives). Poi, con una lettura nuova, il titolare:
 * se è sospeso, o non è più titolare, il paziente non entra. È la gara inversa della sospensione
 * (revisione dei poteri dell'amministratore): senza, un paziente entrato subito dopo la sospensione
 * lascerebbe un titolare sospeso con pazienti nel suo archivio.
 *
 * FOR KEY SHARE e non FOR SHARE: va in conflitto solo con FOR UPDATE, cioè con la sospensione, e
 * non con chi cambia le impostazioni dell'archivio (un UPDATE della riga, FOR NO KEY UPDATE), che
 * altrimenti aspetterebbe la fine di un'importazione intera.
 *
 * Anche un titolare in attesa di conferma non riceve pazienti nuovi (D179): la conferma, il rifiuto
 * e il cambio dei ruoli bloccano gli archivi come la sospensione.
 *
 * Restituisce il motivo del rifiuto, oppure null; null anche se l'archivio non c'è (lo dice chi
 * chiama).
 */
export async function archiveClosedToNewPatients(
  tx: Tx,
  archiveId: string,
): Promise<string | null> {
  const [a] = await tx
    .select({ ownerUserId: archive.ownerUserId })
    .from(archive)
    .where(eq(archive.id, archiveId))
    .for('key share');
  if (!a) return null;
  // Una lettura nuova, dopo il blocco: vede la sospensione appena confermata.
  const [owner] = await tx
    .select({
      status: appUser.status,
      roles: appUser.roles,
      awaiting: appUser.awaitingConfirmation,
    })
    .from(appUser)
    .where(eq(appUser.id, a.ownerUserId));
  if (!owner || owner.status !== 'active') return OWNER_SUSPENDED_NO_NEW_PATIENTS;
  if (!owner.roles.includes('owner_doctor')) return OWNER_GONE_NO_NEW_PATIENTS;
  if (owner.awaiting) return OWNER_AWAITING_NO_NEW_PATIENTS;
  return null;
}
