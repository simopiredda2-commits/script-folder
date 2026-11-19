import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { therapy } from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { studioDayFrom } from './helpers/dates';

interface PrivacyView {
  consensi: {
    id: string;
    tipo: string;
    nome: string;
    fonte: string | null;
    stato: string;
    revocatoIl: string | null;
    inVigore: boolean;
    registratoDa: string | null;
    espressoDa: string | null;
  }[];
  deleghe: { id: string; nome: string; validaOggi: boolean; revocataIl: string | null }[];
  puoScrivere: boolean;
}

interface PlanList {
  piani: {
    id: string;
    farmaco: string;
    stato: string;
    validita: string;
    giorniAllaScadenza: number;
    riservato: boolean;
    motivoAnnullamento: string | null;
  }[];
  puoScrivere: boolean;
}

describe('privacy: consensi del Fascicolo e deleghe (tappa 9)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let secretary: string;
  let admin: string;
  let colleague: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    secretary = await login(s, 'segreteria');
    admin = await login(s, 'amministratore');
    colleague = await login(s, 'collega');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const day = (offset: number) => studioDayFrom(s.clock.now(), offset);
  const req = (method: 'GET' | 'POST', url: string, cookie: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const base = () => `/api/pazienti/${s.richPatient}`;
  const privacy = async (cookie = doctor) => {
    const res = await req('GET', `${base()}/privacy`, cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<PrivacyView>();
  };

  it('la segreteria registra i consensi del Fascicolo, con la fonte e chi li ha registrati', async () => {
    const res = await req('POST', `${base()}/consensi`, secretary, {
      tipo: 'fse_cura',
      stato: 'dato',
      data: day(-10),
    });
    expect(res.statusCode, res.body).toBe(201);
    const negato = await req('POST', `${base()}/consensi`, secretary, {
      tipo: 'fse_prevenzione_enti',
      stato: 'negato',
      data: day(-10),
      espressoDa: 'Genitore di prova',
    });
    expect(negato.statusCode, negato.body).toBe(201);
    const view = await privacy(secretary);
    expect(view.puoScrivere).toBe(true);
    const cura = view.consensi.find((c) => c.id === res.json().id)!;
    expect(cura).toMatchObject({
      tipo: 'fse_cura',
      nome: 'Fascicolo: consultazione per finalità di cura',
      stato: 'dato',
      inVigore: true,
      registratoDa: 'Lucia Bassi',
    });
    expect(cura.fonte).toMatch(/DM 7 settembre 2023, art\. 8/);
    expect(view.consensi.find((c) => c.id === negato.json().id)).toMatchObject({
      stato: 'negato',
      espressoDa: 'Genitore di prova',
    });
  });

  it('non registrano consensi l’amministratore né il collega senza autorizzazione', async () => {
    const body = { tipo: 'fse_cura', stato: 'dato', data: day(0) };
    for (const cookie of [admin, colleague])
      expect((await req('POST', `${base()}/consensi`, cookie, body)).statusCode).toBe(403);
    expect((await req('GET', `${base()}/privacy`, admin)).statusCode).toBe(403);
  });

  it('controlli: data nel futuro, «altro» senza descrizione, tipo fuori elenco', async () => {
    const bad = async (body: object, pattern: RegExp) => {
      const res = await req('POST', `${base()}/consensi`, doctor, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(res.json())).toMatch(pattern);
    };
    await bad({ tipo: 'fse_cura', stato: 'dato', data: day(1) }, /nel futuro/);
    await bad({ tipo: 'altro', stato: 'dato', data: day(0) }, /scrivi che cosa si consente/);
    await bad({ tipo: 'fse_tutto', stato: 'dato', data: day(0) }, /tipo/);
    await bad({ tipo: 'fse_cura', stato: 'revocato', data: day(0) }, /stato/);
    const ok = await req('POST', `${base()}/consensi`, doctor, {
      tipo: 'altro',
      descrizione: 'Comunicazioni per email',
      stato: 'dato',
      data: day(0),
    });
    expect(ok.statusCode).toBe(201);
    const altro = (await privacy()).consensi.find((c) => c.id === ok.json().id)!;
    expect(altro).toMatchObject({ nome: 'Comunicazioni per email', fonte: null, inVigore: true });
  });

  it('revoca e nuovo consenso: in vigore resta l’ultima espressione', async () => {
    const first = (
      await req('POST', `${base()}/consensi`, doctor, {
        tipo: 'fse_profilassi',
        stato: 'dato',
        data: day(-20),
      })
    ).json().id as string;
    const revoke = (id: string, data: string, cookie = doctor) =>
      req('POST', `${base()}/consensi/${id}/revoca`, cookie, { data });
    expect((await revoke(first, day(-30))).statusCode).toBe(400);
    expect((await revoke(first, day(1))).statusCode).toBe(400);
    expect((await revoke(first, day(-5), secretary)).statusCode).toBe(200);
    expect((await revoke(first, day(-4))).statusCode).toBe(409);
    let view = await privacy();
    expect(view.consensi.find((c) => c.id === first)).toMatchObject({
      stato: 'revocato',
      revocatoIl: day(-5),
      inVigore: true,
    });
    // Il paziente lo esprime di nuovo (art. 8, c. 9): vale il nuovo, il vecchio resta nella storia.
    const second = (
      await req('POST', `${base()}/consensi`, doctor, {
        tipo: 'fse_profilassi',
        stato: 'dato',
        data: day(-1),
      })
    ).json().id as string;
    view = await privacy();
    expect(view.consensi.find((c) => c.id === second)!.inVigore).toBe(true);
    expect(view.consensi.find((c) => c.id === first)!.inVigore).toBe(false);
    // Un consenso negato non si revoca.
    const no = view.consensi.find((c) => c.stato === 'negato')!;
    expect((await revoke(no.id, day(0))).statusCode).toBe(409);
  });

  it('deleghe: codice fiscale e date controllati, revoca da quel giorno (R16)', async () => {
    const add = (body: object, cookie = secretary) =>
      req('POST', `${base()}/deleghe`, cookie, body);
    const body = {
      nome: 'Delegato di prova',
      telefono: '+39 000 0000000',
      email: 'delegato@example.invalid',
      ambito: 'Ritiro di ricette e promemoria',
      dal: day(-1),
    };
    expect((await add({ ...body, codiceFiscale: 'ABCDEF12G34H567I' })).statusCode).toBe(400);
    expect((await add({ ...body, al: day(-3) })).statusCode).toBe(400);
    expect((await add({ ...body, email: 'non-una-email' })).statusCode).toBe(400);
    expect((await add(body, admin)).statusCode).toBe(403);
    const res = await add(body);
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    const mine = async () => (await privacy()).deleghe.find((d) => d.id === id)!;
    expect(await mine()).toMatchObject({ nome: 'Delegato di prova', validaOggi: true });
    const revoke = (data: string) =>
      req('POST', `${base()}/deleghe/${id}/revoca`, secretary, { data });
    expect((await revoke(day(1))).statusCode).toBe(400);
    expect((await revoke(day(0))).statusCode).toBe(200);
    expect(await mine()).toMatchObject({ validaOggi: false, revocataIl: day(0) });
    expect((await revoke(day(0))).statusCode).toBe(409);
  });

  it('consensi e deleghe non si cancellano', async () => {
    await expect(s.db.execute(sql`delete from consent`)).rejects.toThrow();
    await expect(s.db.execute(sql`delete from delegation`)).rejects.toThrow();
  });
});

describe('piani terapeutici dalla cartella (tappa 9)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let secretary: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    secretary = await login(s, 'segreteria');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const day = (offset: number) => studioDayFrom(s.clock.now(), offset);
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, cookie: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const url = () => `/api/pazienti/${s.richPatient}/piani`;
  const plans = async (cookie = doctor) => {
    const res = await req('GET', url(), cookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<PlanList>();
  };
  const plan = (extra: object = {}) => ({
    farmaco: 'Farmaco con piano di prova',
    principioAttivo: 'principio con piano',
    rilasciatoIl: day(-30),
    scadeIl: day(150),
    centro: 'Centro di prova',
    specialista: 'Specialista di prova',
    confezioniAutorizzate: 6,
    posologia: '1 compressa al giorno',
    ...extra,
  });

  it('il medico registra un piano; la segreteria lo vede e non lo scrive', async () => {
    const res = await req('POST', url(), doctor, plan());
    expect(res.statusCode, res.body).toBe(201);
    expect((await req('POST', url(), secretary, plan())).statusCode).toBe(403);
    const seen = await plans(secretary);
    expect(seen.puoScrivere).toBe(false);
    expect(seen.piani.find((p) => p.id === res.json().id)).toMatchObject({
      farmaco: 'Farmaco con piano di prova',
      stato: 'attivo',
      validita: 'valido',
      giorniAllaScadenza: 150,
    });
  });

  it('controlli: date del piano e codice AIC', async () => {
    expect((await req('POST', url(), doctor, plan({ rilasciatoIl: day(1) }))).statusCode).toBe(400);
    const res = await req('POST', url(), doctor, plan({ scadeIl: day(-31) }));
    expect(res.statusCode).toBe(400);
    expect(res.json().errore).toMatch(/prima del rilascio/);
    expect((await req('POST', url(), doctor, plan({ aic: '12345' }))).statusCode).toBe(400);
  });

  it('un piano riservato non lo vedono la segreteria, il riepilogo per lei e la pagina Oggi', async () => {
    const settings = `/api/archivi/${s.archives.titolare}/impostazioni`;
    expect(
      (
        await s.app.inject({
          method: 'PATCH',
          url: settings,
          headers: { cookie: doctor },
          payload: { segreteriaLeggeRiepilogo: true },
        })
      ).statusCode,
    ).toBe(200);
    const res = await req(
      'POST',
      url(),
      doctor,
      plan({ farmaco: 'Piano riservato di prova', riservato: true, scadeIl: day(5) }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    expect((await plans()).piani.map((p) => p.id)).toContain(id);
    expect((await plans(secretary)).piani.map((p) => p.id)).not.toContain(id);
    const summary = async (cookie: string) =>
      (await req('GET', `/api/pazienti/${s.richPatient}`, cookie))
        .json()
        .riepilogo.pianiTerapeutici.map((p: { farmaco: string }) => p.farmaco);
    expect(await summary(doctor)).toContain('Piano riservato di prova');
    expect(await summary(secretary)).not.toContain('Piano riservato di prova');
    const today = async (cookie: string) =>
      (await req('GET', '/api/oggi', cookie))
        .json()
        .code.pianiInScadenza.map((p: { farmaco: string }) => p.farmaco);
    expect(await today(doctor)).toContain('Piano riservato di prova');
    expect(await today(secretary)).not.toContain('Piano riservato di prova');
    // Annullato, esce dalla pagina Oggi anche per il medico.
    expect(
      (await req('POST', `${url()}/${id}/annulla`, doctor, { motivo: 'Inserito per prova' }))
        .statusCode,
    ).toBe(200);
    expect(await today(doctor)).not.toContain('Piano riservato di prova');
  });

  it('modifica e annullamento: il piano annullato non vale più per R5', async () => {
    // Principio attivo solo di questo piano: gli altri piani delle prove non valgono per lui.
    const own = { farmaco: 'Piano per R5', principioAttivo: 'principio per R5' };
    const res = await req('POST', url(), doctor, plan(own));
    const planId = res.json().id as string;
    // Una terapia collegata al piano: R5 chiede un piano valido alla data.
    const [ther] = await withActor(s.db, s.users.titolare.id, (tx) =>
      tx
        .insert(therapy)
        .values({
          patientId: s.richPatient,
          drugName: 'Farmaco per R5',
          activeIngredient: 'principio per R5',
          kind: 'chronic',
          startOn: day(-30),
          therapeuticPlanId: planId,
          createdBy: s.users.titolare.id,
        })
        .returning({ id: therapy.id }),
    );
    const draft = await req('POST', `/api/pazienti/${s.richPatient}/ricette`, doctor, {
      kind: 'pharma_ssn',
      lines: [
        {
          therapyId: ther!.id,
          drugName: 'Farmaco per R5',
          activeIngredient: 'principio per R5',
          quantity: 1,
        },
      ],
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const check = async () =>
      (await req('POST', `/api/ricette/${draft.json().id}/controlla`, doctor)).json<{
        problemi: { ruleId: string; message: string; severity: string }[];
      }>().problemi;
    expect((await check()).filter((p) => p.ruleId === 'R5' && p.severity === 'block')).toEqual([]);

    // Modifica: la scheda intera; lo storico tiene la versione di prima.
    const put = await req(
      'PUT',
      `${url()}/${planId}`,
      doctor,
      plan({ ...own, confezioniAutorizzate: 4 }),
    );
    expect(put.statusCode, put.body).toBe(200);
    expect((await req('PUT', `${url()}/${planId}`, secretary, plan())).statusCode).toBe(403);

    const annul = `${url()}/${planId}/annulla`;
    expect((await req('POST', annul, doctor, {})).statusCode).toBe(400);
    expect((await req('POST', annul, doctor, { motivo: 'Piano sostituito' })).statusCode).toBe(200);
    expect((await req('POST', annul, doctor, { motivo: 'Ancora' })).statusCode).toBe(409);
    expect((await req('PUT', `${url()}/${planId}`, doctor, plan(own))).statusCode).toBe(409);
    expect((await plans()).piani.find((p) => p.id === planId)).toMatchObject({
      stato: 'annullato',
      motivoAnnullamento: 'Piano sostituito',
    });
    const r5 = (await check()).filter((p) => p.ruleId === 'R5');
    expect(r5.map((p) => p.message).join(' ')).toMatch(/serve un piano terapeutico valido/);
    // Fuori dal riepilogo e dalla pagina Oggi.
    const summary = (await req('GET', `/api/pazienti/${s.richPatient}`, doctor)).json().riepilogo;
    expect(summary.pianiTerapeutici.map((p: { farmaco: string }) => p.farmaco)).not.toContain(
      'Piano per R5',
    );
    await expect(s.db.execute(sql`delete from therapeutic_plan`)).rejects.toThrow();
  });
});
