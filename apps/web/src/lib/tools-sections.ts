/**
 * Sezioni di Strumenti e chi le vede (tappa 14). Un posto solo, per la pagina e per il menu: chi
 * non ha nessuna sezione non vede nemmeno la voce del menu. Chi può modificare lo decide il
 * servizio, non la sezione.
 */
export type ToolsRole = 'owner_doctor' | 'substitute_doctor' | 'secretary' | 'administrator';

const DOCTORS: ToolsRole[] = ['owner_doctor', 'substitute_doctor'];
const ALL: ToolsRole[] = ['owner_doctor', 'substitute_doctor', 'administrator'];

export const TOOLS_SECTIONS: readonly { key: string; label: string; roles: ToolsRole[] }[] = [
  { key: 'studio', label: 'Dati dello studio', roles: ALL },
  { key: 'utenti', label: 'Utenti e ruoli', roles: ['administrator'] },
  { key: 'stampa', label: 'Postazioni e stampa', roles: ALL },
  // La segreteria legge gli elenchi (contatti, pacchetti, posologie) per preparare (D175).
  { key: 'elenchi', label: 'Elenchi dello studio', roles: [...ALL, 'secretary'] },
  { key: 'modelli', label: 'Modelli dei certificati', roles: ALL },
  { key: 'impaginazione', label: 'Impaginazione', roles: DOCTORS },
  { key: 'fascicolo', label: 'Fascicolo sanitario', roles: ALL },
  { key: 'banche-dati', label: 'Banche dati', roles: ALL },
  { key: 'aft', label: 'AFT', roles: ['owner_doctor'] },
  { key: 'importazione', label: 'Importazione', roles: ['owner_doctor'] },
  {
    key: 'registro',
    label: 'Registro di amministrazione',
    roles: ['owner_doctor', 'administrator'],
  },
  { key: 'servizio', label: 'Stato del servizio', roles: ['administrator'] },
];

/** Le sezioni che vede chi ha questi ruoli, nell'ordine della pagina. */
export function toolsSectionsFor(roles: readonly string[]) {
  return TOOLS_SECTIONS.filter((x) => x.roles.some((r) => roles.includes(r)));
}
