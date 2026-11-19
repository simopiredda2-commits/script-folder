import { describe, expect, it } from 'vitest';
import { toolsSectionsFor } from '../src/lib/tools-sections';

/** Sezioni di Strumenti per ruolo (tappa 14, D175): una sola fonte per la pagina e per il menu. */
describe('Strumenti: chi vede quale sezione', () => {
  const keys = (roles: string[]) => toolsSectionsFor(roles).map((s) => s.key);

  it('la segreteria vede soltanto gli elenchi dello studio', () => {
    expect(keys(['secretary'])).toEqual(['elenchi']);
  });

  it('il titolare ha AFT, importazione e registro; non utenti né stato del servizio', () => {
    const k = keys(['owner_doctor']);
    for (const x of ['aft', 'importazione', 'registro', 'impaginazione', 'elenchi'])
      expect(k).toContain(x);
    for (const x of ['utenti', 'servizio']) expect(k).not.toContain(x);
  });

  it('l’amministratore ha utenti e stato del servizio; non AFT, importazione né impaginazione', () => {
    const k = keys(['administrator']);
    for (const x of ['utenti', 'servizio', 'registro', 'studio']) expect(k).toContain(x);
    for (const x of ['aft', 'importazione', 'impaginazione']) expect(k).not.toContain(x);
  });

  it('il sostituto non ha AFT, importazione né registro', () => {
    const k = keys(['substitute_doctor']);
    for (const x of ['aft', 'importazione', 'registro', 'utenti']) expect(k).not.toContain(x);
  });

  it('senza ruoli nessuna sezione, quindi nessuna voce nel menu', () => {
    expect(keys([])).toEqual([]);
  });
});
