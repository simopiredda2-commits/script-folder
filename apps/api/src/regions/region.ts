import { healthUnitsOfRegion } from '@mmg/domain';
import { regionalPackageKey } from '@mmg/regions';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { archive, studio } from '../db/schema';

/**
 * La regione di uno studio, con la chiave del suo pacchetto regionale (D288): con questa le regole
 * di prescrizione portano le aggiunte della regione (D296) e il servizio sceglie le integrazioni
 * della regione (D297). Null se la regione dello studio non ha un pacchetto o non si riconosce.
 */
export async function studioRegion(
  db: Pick<Database, 'select'>,
  studioId: string,
): Promise<string | null> {
  const [place] = await db
    .select({ regionName: studio.regionName })
    .from(studio)
    .where(eq(studio.id, studioId));
  return regionalPackageKey(place?.regionName);
}

/**
 * Il codice della regione di uno studio nell'elenco nazionale delle aziende sanitarie («010»): per
 * i certificati del Gateway del Fascicolo, che sono della regione e non del pacchetto (D298). Null
 * se la regione dello studio non si riconosce.
 */
export async function studioRegionCode(
  db: Pick<Database, 'select'>,
  studioId: string,
): Promise<string | null> {
  const [place] = await db
    .select({ regionName: studio.regionName })
    .from(studio)
    .where(eq(studio.id, studioId));
  return healthUnitsOfRegion(place?.regionName)?.[0]?.regionCode ?? null;
}

/** La regione dello studio di un archivio, come `studioRegion`. */
export async function archiveRegion(db: Database, archiveId: string): Promise<string | null> {
  const [place] = await db
    .select({ regionName: studio.regionName })
    .from(archive)
    .innerJoin(studio, eq(studio.id, archive.studioId))
    .where(eq(archive.id, archiveId));
  return regionalPackageKey(place?.regionName);
}
