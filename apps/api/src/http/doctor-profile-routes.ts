import { doctorIssues } from '@mmg/domain';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client';
import { appUser, doctorProfile } from '../db/schema';
import { HttpError } from './errors';

const contactsBody = z
  .object({
    /** Nome e cognome come nel codice fiscale, separati (il Profilo li vuole così). */
    nome: z.string().trim().min(1).max(100),
    cognome: z.string().trim().min(1).max(100),
    telefono: z
      .string()
      .trim()
      .max(30)
      .regex(/^[0-9 +./-]*$/, 'Telefono: solo cifre, spazi, «+», «.», «/» e «-»'),
    email: z.union([z.literal(''), z.email().max(200)]),
    pec: z.union([z.literal(''), z.email().max(200)]),
  })
  .strict();

/**
 * Nome, cognome e recapiti di studio del medico collegato (tappa 11): vanno nel Profilo
 * Sanitario Sintetico, che vuole nome e cognome separati e almeno un recapito (schematron,
 * ERRORE-38, ERRORE-40). Li cambia solo il medico stesso.
 */
export function registerDoctorProfileRoutes(app: FastifyInstance, db: Database) {
  const doctorOnly = (roles: readonly string[]) => {
    if (!roles.includes('owner_doctor') && !roles.includes('substitute_doctor'))
      throw new HttpError(403, 'I recapiti di studio sono del medico');
  };

  async function read(userId: string) {
    const [p] = await db
      .select({
        cf: doctorProfile.fiscalCode,
        phone: doctorProfile.phone,
        email: doctorProfile.email,
        pec: doctorProfile.pec,
        firstName: doctorProfile.firstName,
        lastName: doctorProfile.lastName,
      })
      .from(appUser)
      .leftJoin(doctorProfile, eq(doctorProfile.userId, appUser.id))
      .where(eq(appUser.id, userId));
    return {
      nome: p?.firstName ?? '',
      cognome: p?.lastName ?? '',
      telefono: p?.phone ?? '',
      email: p?.email ?? '',
      pec: p?.pec ?? '',
      /** Che cosa manca per firmare il Profilo. */
      mancaPerIlProfilo: doctorIssues({
        fiscalCode: p?.cf,
        firstName: p?.firstName,
        lastName: p?.lastName,
        phone: p?.phone,
        email: p?.email,
        pec: p?.pec,
      }),
    };
  }

  app.get('/api/profilo/recapiti', async (req) => {
    doctorOnly(req.actor!.roles);
    return read(req.actor!.userId);
  });

  app.put('/api/profilo/recapiti', async (req) => {
    const actor = req.actor!;
    doctorOnly(actor.roles);
    const b = contactsBody.parse(req.body);
    const values = {
      firstName: b.nome,
      lastName: b.cognome,
      phone: b.telefono || null,
      email: b.email || null,
      pec: b.pec || null,
    };
    await db
      .insert(doctorProfile)
      .values({ userId: actor.userId, ...values })
      .onConflictDoUpdate({ target: doctorProfile.userId, set: values });
    return read(actor.userId);
  });
}
