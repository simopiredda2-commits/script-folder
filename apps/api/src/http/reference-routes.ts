import type { DatasetKind } from '@mmg/reference';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { studioDate } from '../prescriptions/rules-check';
import type { ReferenceData } from '../reference/lookup';

const dateQuery = z.object({
  /** Data a cui consultare le banche dati (A5); per difetto oggi nello studio. */
  data: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
const searchQuery = dateQuery.extend({ q: z.string().trim().min(1).max(100) });

/** Le banche dati che i dati di un farmaco usano: tutte nelle versioni in uso (A6), anche le liste di D202. */
const DRUG_KINDS: DatasetKind[] = [
  'farmaci',
  'farmaci_classe',
  'farmaci_dpc',
  'farmaci_trasparenza',
  'farmaci_carenti',
  'registri_aifa',
];

/**
 * Banche dati pubbliche: non sono dati dei pazienti, servono una sessione ma non la guardia sulla
 * cartella. Ogni risposta riporta le versioni usate, con la loro data (A6).
 */
export function registerReferenceRoutes(
  app: FastifyInstance,
  reference: ReferenceData,
  now: () => Date,
) {
  const dateOf = (q: { data?: string | undefined }) => q.data ?? studioDate(now());

  app.get('/api/banche-dati', async (req) => {
    const date = dateOf(dateQuery.parse(req.query));
    return { data: date, versioni: await reference.versions(date) };
  });

  app.get('/api/farmaci', async (req) => {
    const q = searchQuery.parse(req.query);
    const date = dateOf(q);
    return {
      data: date,
      farmaci: await reference.searchDrugs(q.q, date),
      versioni: await reference.versions(date, DRUG_KINDS),
    };
  });

  app.get('/api/farmaci/:aic', async (req) => {
    const { aic } = z.object({ aic: z.string().regex(/^\d{9}$/) }).parse(req.params);
    const date = dateOf(dateQuery.parse(req.query));
    const drug = (await reference.drugs([aic], date)).get(aic) ?? null;
    return {
      data: date,
      farmaco: drug,
      equivalenti: drug ? await reference.equivalents(aic, date) : [],
      versioni: await reference.versions(date, DRUG_KINDS),
    };
  });

  app.get('/api/prestazioni', async (req) => {
    const q = searchQuery.parse(req.query);
    const date = dateOf(q);
    return {
      data: date,
      prestazioni: await reference.searchServices(q.q, date),
      versioni: await reference.versions(date, ['prestazioni']),
    };
  });

  app.get('/api/esenzioni', async (req) => {
    const q = searchQuery.parse(req.query);
    const date = dateOf(q);
    return {
      data: date,
      esenzioni: await reference.searchExemptions(q.q, date),
      versioni: await reference.versions(date, ['esenzioni']),
    };
  });

  // Diagnosi ICD-9-CM (D186): ricerca per descrizione o codice, e la voce di un codice scritto a mano.
  app.get('/api/diagnosi', async (req) => {
    const q = searchQuery.parse(req.query);
    const date = dateOf(q);
    const found = await reference.searchDiagnoses(q.q, date);
    return {
      data: date,
      diagnosi: found.hits,
      totale: found.total,
      versioni: await reference.versions(date, ['diagnosi']),
    };
  });

  app.get('/api/diagnosi/:codice', async (req) => {
    const { codice } = z.object({ codice: z.string().trim().min(1).max(10) }).parse(req.params);
    const date = dateOf(dateQuery.parse(req.query));
    const found = await reference.diagnosis(codice, date);
    return {
      data: date,
      // null: catalogo in uso ma codice assente; disponibile false: nessun catalogo in uso.
      diagnosi: found ?? null,
      disponibile: found !== undefined,
      versioni: await reference.versions(date, ['diagnosi']),
    };
  });

  app.get('/api/comuni/:codice', async (req) => {
    const { codice } = z.object({ codice: z.string().regex(/^[A-Za-z]\d{3}$/) }).parse(req.params);
    const date = dateOf(dateQuery.parse(req.query));
    return {
      data: date,
      // null: banca dati presente ma codice sconosciuto; undefined (assente): banca dati mancante.
      comune: (await reference.municipality(codice, date)) ?? null,
      disponibile: (await reference.versions(date, ['comuni'])).length > 0,
      versioni: await reference.versions(date, ['comuni']),
    };
  });
}
