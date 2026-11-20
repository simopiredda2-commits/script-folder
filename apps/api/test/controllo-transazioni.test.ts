import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestSecretaryDecisions } from '../src/admin/secretary-archives';
import { withActor } from '../src/db/tx';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { takeOutsideCalls } from './helpers/transaction-guard';

/**
 * Il controllo delle transazioni (D225), che gira in ogni prova del servizio: si annota il database
 * usato mentre una transazione è aperta, con il punto del codice e la transazione; con `tx`, o
 * fuori da una transazione, nulla.
 */
describe('controllo delle transazioni (D225)', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });

  afterAll(async () => {
    await t.drop();
  });

  const brief = () =>
    takeOutsideCalls().map((c) => ({
      what: c.what,
      where: c.where.replace(/:\d+$/, ''),
      opened: c.opened.replace(/:\d+$/, ''),
    }));

  it('il servizio che usa db dentro una transazione aperta: annotato, con il punto e la transazione', async () => {
    await withActor(t.db, null, async () => {
      await latestSecretaryDecisions(t.db, { archiveIds: [randomUUID()] });
    });
    expect(brief()).toEqual([
      {
        what: 'db.selectDistinctOn',
        where: 'src/admin/secretary-archives.ts',
        opened: 'test/controllo-transazioni.test.ts',
      },
    ]);
  });

  it('con tx dentro la transazione, e con db dopo che è finita: niente', async () => {
    await withActor(t.db, null, async (tx) => {
      await latestSecretaryDecisions(tx, { archiveIds: [randomUUID()] });
    });
    await latestSecretaryDecisions(t.db, { archiveIds: [randomUUID()] });
    expect(brief()).toEqual([]);
  });

  it('una seconda transazione del database e una query relazionale, dentro una aperta: annotate', async () => {
    await withActor(t.db, null, async () => {
      await withActor(t.db, null, () => Promise.resolve());
      await t.db.query.studio.findFirst();
    });
    expect(brief().map((c) => c.what)).toEqual(['db.transaction', 'db.query.findFirst']);
  });

  it('un lavoro partito dentro la transazione che chiede db quando è finita: niente', async () => {
    let later: Promise<unknown> = Promise.resolve();
    await withActor(t.db, null, () => {
      later = new Promise((ok) => setTimeout(ok, 30)).then(() =>
        latestSecretaryDecisions(t.db, { archiveIds: [randomUUID()] }),
      );
      return Promise.resolve();
    });
    await later;
    expect(brief()).toEqual([]);
  });

  it('dentro una transazione dentro tx (un punto di salvataggio): niente', async () => {
    await withActor(t.db, null, async (tx) => {
      await tx.transaction(async (inner) => {
        await latestSecretaryDecisions(inner, { archiveIds: [randomUUID()] });
      });
    });
    expect(brief()).toEqual([]);
  });
});
