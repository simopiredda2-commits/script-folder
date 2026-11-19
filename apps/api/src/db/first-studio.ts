import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { hashPassword } from '../security/password';
import type { Database } from './client';
import { appUser, studio } from './schema';

/**
 * Primo avvio di uno studio vero (tappa 14, D172): lo studio e il suo primo amministratore, con una
 * password temporanea da cambiare al primo accesso. Gli altri utenti li crea l'amministratore da
 * Strumenti › Utenti e ruoli. Il seed dimostrativo resta per le prove e le schermate.
 */
export const firstStudioInput = z
  .object({
    nome: z.string().trim().min(1).max(200),
    tipo: z.enum(['singolo', 'gruppo']),
    /** Regione per l'intestazione del promemoria SSN (D95): senza, nessuna ricetta SSN parte. */
    regione: z.string().trim().toUpperCase().min(2).max(60),
    amministratore: z
      .string()
      .trim()
      .min(3)
      .max(60)
      .regex(/^[a-z0-9._-]+$/, 'nome utente: lettere minuscole, cifre, punto, trattino'),
    nomeAmministratore: z.string().trim().min(1).max(200),
    email: z.email().optional(),
  })
  .strict();
export type FirstStudioInput = z.infer<typeof firstStudioInput>;

export interface FirstStudioResult {
  studioId: string;
  userId: string;
  /** Mostrata una sola volta: va consegnata di persona e cambiata al primo accesso. */
  temporaryPassword: string;
}

export async function createFirstStudio(
  db: Database,
  raw: FirstStudioInput,
): Promise<FirstStudioResult> {
  const input = firstStudioInput.parse(raw);
  const [taken] = await db
    .select({ id: appUser.id })
    .from(appUser)
    .where(eq(appUser.username, input.amministratore));
  if (taken) throw new Error(`Il nome utente «${input.amministratore}» esiste già`);
  const temporaryPassword = randomBytes(12).toString('base64url');
  const passwordHash = await hashPassword(temporaryPassword);
  return db.transaction(async (tx) => {
    const [st] = await tx
      .insert(studio)
      .values({
        name: input.nome,
        kind: input.tipo === 'gruppo' ? 'group' : 'single',
        regionName: input.regione,
      })
      .returning({ id: studio.id });
    const [user] = await tx
      .insert(appUser)
      .values({
        studioId: st!.id,
        username: input.amministratore,
        displayName: input.nomeAmministratore,
        email: input.email ?? null,
        passwordHash,
        roles: ['administrator'],
        mustChangePassword: true,
      })
      .returning({ id: appUser.id });
    return { studioId: st!.id, userId: user!.id, temporaryPassword };
  });
}
