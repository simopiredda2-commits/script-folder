import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStored, writeStored } from '../src/lib/storage';
import {
  renewIntoCurrentPrescription,
  type PastPrescription,
} from '../src/pages/PrescriptionEditor';

/** «Rinnova» una ricetta già fatta (D278, richiesta della Dr.ssa Rocca). Paziente inventato. */
const pastLine = {
  therapyId: null,
  drugAic: null,
  drugName: null,
  activeIngredient: null,
  serviceCode: null,
  serviceNationalCode: null,
  serviceDescription: null,
  quantity: 1,
  aifaNote: null,
  byActiveIngredient: false,
  notSubstitutable: false,
  notSubstitutableReason: null,
  notSubstitutableCode: null,
  posologyText: null,
  repeatCount: null,
  validityMonths: null,
};
const pharma: PastPrescription = {
  id: 'r1',
  kind: 'pharma_ssn',
  status: 'sent',
  exemptionCode: 'T01',
  accessType: null,
  priority: null,
  diagnosticQuestion: null,
  righe: [
    {
      ...pastLine,
      therapyId: 't1',
      drugAic: '000000011',
      drugName: 'Farmaco di prova 5 mg',
      quantity: 2,
      posologyText: '1 compressa al giorno',
      notSubstitutable: true,
      notSubstitutableCode: '2',
    },
    {
      ...pastLine,
      therapyId: 't-finita',
      drugAic: '000000022',
      drugName: 'Altro farmaco di prova',
    },
  ],
};
const specialist: PastPrescription = {
  id: 'r2',
  kind: 'specialist_ssn',
  status: 'sent',
  exemptionCode: null,
  accessType: 'subsequent',
  priority: 'P',
  diagnosticQuestion: 'Controllo di prova',
  righe: [
    {
      ...pastLine,
      serviceCode: 'COND.1',
      serviceNationalCode: 'COND.1',
      serviceDescription: 'Prestazione di prova',
      serviceNote: '99',
      serviceNoteLetter: 'B',
    },
    { ...pastLine, serviceCode: 'CICLO.1', serviceDescription: 'Ciclo di prova', sessions: 8 },
  ],
};
// La ricerca del catalogo in uso: COND.1 ha ancora la nota 99, CICLO.1 è a ciclo.
const CATALOG: Record<string, object> = {
  'COND.1': {
    regionalCode: 'COND.1',
    nationalCode: 'COND.1',
    description: 'Prestazione di prova',
    branch: 'Laboratorio di prova',
    fee: '30.00',
    notes: null,
    cycle: null,
    sessions: null,
    note: { note: '99', kind: 'condizione', text: 'A) Prima; B) Seconda' },
  },
  'CICLO.1': {
    regionalCode: 'CICLO.1',
    nationalCode: 'CICLO.1',
    description: 'Ciclo di prova',
    branch: 'Riabilitazione di prova',
    fee: '22.50',
    notes: null,
    cycle: true,
    sessions: 10,
    note: null,
  },
};

describe('«Rinnova» una ricetta già fatta (D278)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const q = new URL(url, 'http://localhost').searchParams.get('q') ?? '';
        return Promise.resolve(
          new Response(JSON.stringify({ prestazioni: CATALOG[q] ? [CATALOG[q]] : [] }), {
            status: 200,
          }),
        );
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('farmaci: le righe nella ricetta in corso, con tipo ed esenzione; la terapia finita non resta collegata', async () => {
    const done = await renewIntoCurrentPrescription('p1', pharma, new Set(['t1']));
    expect(done).toEqual({ mode: 'farmaci', added: 2 });
    const lines = readStored<Record<string, unknown>[]>('ricetta:p1:farmaci:righe', []);
    expect(lines.map(({ key: _k, ...l }) => l)).toEqual([
      {
        therapyId: 't1',
        drugAic: '000000011',
        drugName: 'Farmaco di prova 5 mg',
        activeIngredient: null,
        quantity: 2,
        aifaNote: null,
        posologyText: '1 compressa al giorno',
        notSubstitutable: true,
        notSubstitutableCode: '2',
        notSubstitutableReason: '',
      },
      {
        drugAic: '000000022',
        drugName: 'Altro farmaco di prova',
        activeIngredient: null,
        quantity: 1,
        aifaNote: null,
      },
    ]);
    expect(readStored('ricetta:p1:farmaci:tipo', null)).toBe('pharma_ssn');
    expect(readStored('ricetta:p1:farmaci:esenzione', null)).toBe('T01');
    // Una seconda volta non ripete le righe.
    expect(await renewIntoCurrentPrescription('p1', pharma, new Set(['t1']))).toEqual({
      mode: 'farmaci',
      added: 0,
    });
    expect(readStored<unknown[]>('ricetta:p1:farmaci:righe', [])).toHaveLength(2);
  });

  it('specialistica: nota dall’elenco in uso con la lettera, sedute, accesso e quesito', async () => {
    const done = await renewIntoCurrentPrescription('p1', specialist, new Set());
    expect(done).toEqual({ mode: 'specialistica', added: 2 });
    const [cond, cycle] = readStored<Record<string, unknown>[]>(
      'ricetta:p1:specialistica:righe',
      [],
    );
    expect(cond).toMatchObject({
      serviceCode: 'COND.1',
      serviceNote: '99',
      serviceNoteLetter: 'B',
    });
    expect(cond!.catalog).toMatchObject({ fee: '30.00', note: { note: '99' } });
    expect(cycle).toMatchObject({ serviceCode: 'CICLO.1', sessions: '8' });
    expect(cycle!.catalog).toMatchObject({ cycle: true, maxSessions: 10, note: null });
    expect(readStored('ricetta:p1:specialistica:accesso', null)).toBe('subsequent');
    expect(readStored('ricetta:p1:specialistica:quesito', null)).toBe('Controllo di prova');
  });

  it('la condizione RAO torna solo con il primo accesso; la tabella la ricontrolla l’editor (D285)', async () => {
    await renewIntoCurrentPrescription(
      'p1',
      { ...specialist, raoConditionKey: 'prova:t1:3:1' },
      new Set(),
    );
    expect(readStored('ricetta:p1:specialistica:rao', null)).toBeNull();
    sessionStorage.clear();
    await renewIntoCurrentPrescription(
      'p1',
      { ...specialist, accessType: 'first', priority: 'B', raoConditionKey: 'prova:t1:3:1' },
      new Set(),
    );
    expect(readStored('ricetta:p1:specialistica:rao', null)).toBe('prova:t1:3:1');
    expect(readStored('ricetta:p1:specialistica:priorita', null)).toBe('B');
  });

  it('la nota cambiata nell’elenco in uso: la nota nuova, senza la lettera di quella vecchia', async () => {
    const changed = {
      ...specialist,
      righe: [{ ...specialist.righe[0]!, serviceNote: '98', serviceNoteLetter: 'A' }],
    };
    await renewIntoCurrentPrescription('p1', changed, new Set());
    const [cond] = readStored<Record<string, unknown>[]>('ricetta:p1:specialistica:righe', []);
    expect(cond).toMatchObject({ serviceNote: '99' });
    expect(cond).not.toHaveProperty('serviceNoteLetter');
  });

  it('con la ricetta in corso già preparata non aggiunge niente; con righe sue non cambia tipo e quesito', async () => {
    writeStored('ricetta:p1:farmaci:bozza', { id: 'b1' });
    expect(await renewIntoCurrentPrescription('p1', pharma, new Set())).toBeNull();
    sessionStorage.clear();
    writeStored('ricetta:p1:specialistica:righe', [
      { key: 'k1', serviceCode: 'ALTRO.1', quantity: 1 },
    ]);
    writeStored('ricetta:p1:specialistica:quesito', 'Quesito già scritto');
    await renewIntoCurrentPrescription('p1', specialist, new Set());
    expect(readStored<unknown[]>('ricetta:p1:specialistica:righe', [])).toHaveLength(3);
    expect(readStored('ricetta:p1:specialistica:quesito', null)).toBe('Quesito già scritto');
  });

  it('dopo una ricetta già inviata si ricomincia da capo, come con «Nuova ricetta da capo»', async () => {
    writeStored('ricetta:p1:specialistica:bozza', { id: 'vecchia', status: 'sent', lineIds: {} });
    writeStored('ricetta:p1:specialistica:righe', [
      { key: 'k1', serviceCode: 'VECCHIA.1', quantity: 1 },
    ]);
    writeStored('ricetta:p1:specialistica:quesito', 'Quesito della ricetta inviata');
    expect(await renewIntoCurrentPrescription('p1', specialist, new Set())).toEqual({
      mode: 'specialistica',
      added: 2,
    });
    expect(readStored('ricetta:p1:specialistica:bozza', null)).toBeNull();
    const lines = readStored<{ serviceCode: string }[]>('ricetta:p1:specialistica:righe', []);
    expect(lines.map((l) => l.serviceCode)).toEqual(['COND.1', 'CICLO.1']);
    expect(readStored('ricetta:p1:specialistica:quesito', null)).toBe('Controllo di prova');
    // In invio o in errore la ricetta non è finita: non si tocca.
    writeStored('ricetta:p1:farmaci:bozza', { id: 'b2', status: 'error', lineIds: {} });
    expect(await renewIntoCurrentPrescription('p1', pharma, new Set())).toBeNull();
  });
});
