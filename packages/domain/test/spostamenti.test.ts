import { describe, expect, it } from 'vitest';
import { archivesOnDay, type ArchiveMove } from '../src/archive-moves';

/**
 * In quale archivio stava il paziente in un giorno (D240): la prestazione aggiuntiva va nella
 * distinta di chi l'aveva quel giorno. Archivi inventati: A, poi B dal 10/11, poi C dal 20/11.
 */
describe('archivi di un giorno', () => {
  const moves: ArchiveMove[] = [
    { day: '2026-11-10', from: 'A', to: 'B' },
    { day: '2026-11-20', from: 'B', to: 'C' },
  ];

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

  it('due spostamenti lo stesso giorno: tutti e tre, senza ripetizioni', () => {
    const quick: ArchiveMove[] = [
      { day: '2026-11-10', from: 'A', to: 'B' },
      { day: '2026-11-10', from: 'B', to: 'A' },
    ];
    expect(archivesOnDay(quick, 'A', '2026-11-10')).toEqual(['A', 'B']);
    expect(archivesOnDay(quick, 'A', '2026-11-09')).toEqual(['A']);
    expect(archivesOnDay(quick, 'A', '2026-11-11')).toEqual(['A']);
  });
});
