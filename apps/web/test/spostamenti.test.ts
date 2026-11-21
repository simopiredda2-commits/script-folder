import { describe, expect, it } from 'vitest';
import { archiveNames, archivesOnDay, type ArchiveMove } from '../src/lib/archive-moves';

/**
 * La copia per la pagina di `archivesOnDay` di @mmg/domain (D240): gli stessi casi della prova del
 * dominio. Archivi inventati: A, poi B dal 10/11, poi C dal 20/11.
 */
describe('archivi di un giorno, nella pagina', () => {
  const move = (giorno: string, da: string, a: string): ArchiveMove => ({
    giorno,
    da,
    daNome: `Archivio ${da}`,
    a,
    aNome: `Archivio ${a}`,
  });
  const moves = [move('2026-11-10', 'A', 'B'), move('2026-11-20', 'B', 'C')];

  it('senza spostamenti: l’archivio di adesso', () => {
    expect(archivesOnDay([], 'A', '2026-11-03')).toEqual(['A']);
  });

  it('prima, fra e dopo gli spostamenti: chi lo aveva quel giorno', () => {
    expect(archivesOnDay(moves, 'C', '2026-11-03')).toEqual(['A']);
    expect(archivesOnDay(moves, 'C', '2026-11-09')).toEqual(['A']);
    expect(archivesOnDay(moves, 'C', '2026-11-11')).toEqual(['B']);
    expect(archivesOnDay(moves, 'C', '2026-11-19')).toEqual(['B']);
    expect(archivesOnDay(moves, 'C', '2026-11-21')).toEqual(['C']);
  });

  it('il giorno di uno spostamento: quello di prima e quello di dopo, si sceglie', () => {
    expect(archivesOnDay(moves, 'C', '2026-11-10')).toEqual(['A', 'B']);
    expect(archivesOnDay(moves, 'C', '2026-11-20')).toEqual(['B', 'C']);
  });

  it('due spostamenti lo stesso giorno: tutti e tre, senza ripetizioni; i nomi di ogni archivio', () => {
    const quick = [move('2026-11-10', 'A', 'B'), move('2026-11-10', 'B', 'A')];
    expect(archivesOnDay(quick, 'A', '2026-11-10')).toEqual(['A', 'B']);
    expect(archivesOnDay(quick, 'A', '2026-11-09')).toEqual(['A']);
    expect(archivesOnDay(quick, 'A', '2026-11-11')).toEqual(['A']);
    expect([...archiveNames(moves)]).toEqual([
      ['A', 'Archivio A'],
      ['B', 'Archivio B'],
      ['C', 'Archivio C'],
    ]);
  });
});
