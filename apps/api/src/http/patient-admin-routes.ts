import type { FastifyInstance } from 'fastify';
import type { AdminDeps } from '../admin/deps';

/**
 * Pannello amministrativo del paziente (tappa 15): nuovo paziente, anagrafica completa con la
 * correzione dell'identità, dati SSN, stato, stranieri, lavoro, canale del promemoria, nucleo
 * familiare, esenzioni, scelta del medico.
 */
export function registerPatientAdminRoutes(_app: FastifyInstance, _deps: AdminDeps): void {}
