import {
  SimulatedGateway,
  SimulatedSickLeaveGateway,
  type SickLeaveGateway,
} from '@mmg/integrations';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  appUser,
  changeHistory,
  patient,
  prescription,
  sickLeaveCertificate,
  studio,
  workstation,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { studioDate } from '../src/prescriptions/rules-check';
import { pdfText } from './helpers/pdf-text';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { studioDayFrom } from './helpers/dates';

const noRules = () => Promise.resolve({ rulesVersion: null, issues: [] });

/** Il simulatore dell'INPS con un'attesa prima di ogni risposta, per il tempo massimo. */
class SlowInps implements SickLeaveGateway {
  readonly environment = 'simulator' as const;
  delayMs = 0;
  constructor(private readonly inner: SimulatedSickLeaveGateway) {}
  private async wait() {
    if (this.delayMs) await new Promise((ok) => setTimeout(ok, this.delayMs));
  }
  async send(...a: Parameters<SickLeaveGateway['send']>) {
    await this.wait();
    return this.inner.send(...a);
  }
  async rectify(...a: Parameters<SickLeaveGateway['rectify']>) {
    await this.wait();
    return this.inner.rectify(...a);
  }
  async cancel(...a: Parameters<SickLeaveGateway['cancel']>) {
    await this.wait();
    return this.inner.cancel(...a);
  }
}

/** Gli elementi di testo di un PDF con la loro posizione: x, larghezza e pagina. */
async function textItems(bytes: Uint8Array) {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const doc = await task.promise;
  const out: { str: string; x: number; width: number; page: number; pageWidth: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const [, , pageWidth] = page.view as [number, number, number, number];
    for (const it of (await page.getTextContent()).items)
      if ('str' in it && it.str.trim())
        out.push({
          str: it.str,
          x: it.transform[4] as number,
          width: it.width,
          page: i,
          pageWidth,
        });
  }
  await task.destroy();
  return out;
}

interface StudioView {
  dati: Record<string, string | null>;
  indirizzoCompleto: string | null;
  intestazione: string[];
  sicurezza: {
    minutiInattivita: number;
    tentativiFalliti: number;
    codiciSbagliati: number;
    minutiBlocco: number;
  };
  invii: { secondiAttesa: number; avviso: string | null };
  avvisi: {
    cartelleAlGiorno: number | null;
    fasciaDalle: number | null;
    fasciaAlle: number | null;
    consultazioniAftAlGiorno: number | null;
    daCompletare: string[];
    fonte: string;
  };
  daCompletare: string[];
  puoModificare: boolean;
  puoModificareIntestazione: boolean;
}

/**
 * Dati e impostazioni dello studio (tappa 14): lettura per tutti, modifica dell'amministratore,
 * controlli, registro; il tempo di attesa degli invii, l'indirizzo sulla copia INPS e
 * l'intestazione dei certificati dai modelli letti dallo studio; postazioni; stato del servizio.
 * Studio, medici e pazienti inventati.
 */
describe('dati e impostazioni dello studio (tappa 14)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const c: Record<string, string> = {};
  // Il SAR risponde dopo 1,5 secondi: con un'attesa di 1 secondo l'esito è incerto, con 3 arriva.
  const sar = new SimulatedGateway('sar', { delayMs: 1500 });
  let inps: SlowInps;

  beforeAll(async () => {
    t = await createTestDatabase();
    inps = new SlowInps(new SimulatedSickLeaveGateway({ now: () => s.clock.now() }));
    s = await createScenario(
      t.db,
      { name: 'Studio di prova', kind: 'group' },
      {
        gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') },
        sickLeaveGateway: inps,
        preSendChecks: noRules,
      },
    );
    for (const who of ['titolare', 'segreteria', 'sostituto', 'amministratore'] as const)
      c[who] = await login(s, who);
    // Lavoratore adulto con una residenza inventata, per il certificato INPS (il paziente dello
    // scenario cambia a ogni giro e può essere minorenne).
    await withActor(t.db, s.users.titolare.id, (tx) =>
      tx
        .update(patient)
        .set({
          birthDate: '1980-05-05',
          residenceStreet: 'Via dei Prova',
          residenceNumber: '3',
          residencePostalCode: '10121',
          residenceTown: 'Torino',
          residenceProvince: 'TO',
        })
        .where(eq(patient.id, s.richPatient)),
    );
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  type Who = 'titolare' | 'segreteria' | 'sostituto' | 'amministratore';
  const req = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie: c[who]! }, ...(payload ? { payload } : {}) });
  const read = async (who: Who = 'amministratore') => {
    const res = await req(who, 'GET', '/api/studio');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<StudioView>();
  };
  const dati = (over: Record<string, unknown> = {}) => ({
    nome: 'Studio di prova',
    tipo: 'group',
    regione: 'PIEMONTE',
    indirizzo: 'Via di Prova 1',
    cap: '10100',
    comune: 'Comune di prova',
    provincia: 'TO',
    telefono: '+39 000 0000000',
    email: 'studio@esempio.invalid',
    pec: 'studio@pec.esempio.invalid',
    ...over,
  });
  const put = (body: object, who: Who = 'amministratore') => req(who, 'PUT', '/api/studio', body);
  const problems = (res: { json: <T>() => T }) =>
    res.json<{ dettagli: { problemi: string[] } }>().dettagli.problemi;
  const adminLog = () =>
    t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.studioId, s.studioId), eq(accessLog.action, 'amministrazione')))
      .orderBy(asc(accessLog.seq));

  it('lettura per ogni utente dello studio; modifica solo dell’amministratore, e il tentativo negato resta nel registro', async () => {
    for (const who of ['titolare', 'segreteria', 'sostituto'] as const) {
      const v = await read(who);
      expect(v.dati.nome).toBe('Studio di prova');
      expect(v.dati.regione).toBe('PIEMONTE');
      expect(v.sicurezza).toEqual({
        minutiInattivita: 5,
        tentativiFalliti: 50,
        codiciSbagliati: 5,
        minutiBlocco: 15,
      });
      expect(v.invii).toEqual({ secondiAttesa: 8, avviso: null });
      expect([v.puoModificare, v.puoModificareIntestazione]).toEqual([false, false]);
    }
    const admin = await read();
    expect([admin.puoModificare, admin.puoModificareIntestazione]).toEqual([true, true]);
    for (const who of ['titolare', 'segreteria', 'sostituto'] as const) {
      const res = await put({ dati: dati({ nome: 'Cambiato da chi non può' }) }, who);
      expect(res.statusCode, who).toBe(403);
      expect(res.json<{ errore: string }>().errore).toMatch(/amministratore/);
      // Chi non può cambiare non sa nemmeno se i valori andavano bene.
      expect((await put({ dati: dati({ cap: 'no' }) }, who)).statusCode).toBe(403);
    }
    expect((await read()).dati.nome).toBe('Studio di prova');
    const denied = (await adminLog()).filter((r) => r.outcome === 'negato');
    expect(denied.length).toBeGreaterThanOrEqual(6);
    expect(denied[0]).toMatchObject({
      userId: s.users.titolare.id,
      patientId: null,
      details: { area: 'studio', azione: 'modifica', permesso: 'admin.studio' },
    });
    const saved = await put({ dati: dati() });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<StudioView>().dati).toMatchObject({ cap: '10100', provincia: 'TO' });
    expect(saved.json<StudioView>().indirizzoCompleto).toBe(
      'Via di Prova 1, 10100 Comune di prova (TO)',
    );
  });

  it('controlli di formato: CAP, provincia, telefono, email e PEC, tutti i problemi insieme', async () => {
    const res = await put({
      dati: dati({
        cap: '1012',
        provincia: 'Tor',
        telefono: 'chiamare',
        email: 'non-una-email',
        pec: 'pec@',
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(problems(res)).toEqual([
      'CAP: 5 cifre',
      'Provincia: la sigla di 2 lettere',
      'Telefono: cifre, spazi e i segni + . / - ( ), con almeno 5 cifre',
      'Email: indirizzo non valido',
      'PEC: indirizzo non valido',
    ]);
    expect(problems(await put({ dati: dati({ provincia: '1A', cap: '101234' }) }))).toEqual([
      'CAP: 5 cifre',
      'Provincia: la sigla di 2 lettere',
    ]);
    expect(problems(await put({ dati: dati({ telefono: '12' }) }))).toEqual([
      'Telefono: cifre, spazi e i segni + . / - ( ), con almeno 5 cifre',
    ]);
    // Campi sconosciuti e gruppi a metà non passano: ogni gruppo si manda intero.
    expect((await put({ dati: { ...dati(), sitoWeb: 'x' } })).statusCode).toBe(400);
    const half = await put({ dati: { nome: 'Solo il nome', tipo: 'group', regione: 'PIEMONTE' } });
    expect(problems(half)).toEqual([
      'Indirizzo (via e numero civico): manca',
      'CAP: manca',
      'Comune: manca',
      'Provincia: manca',
      'Telefono: manca',
      'Email: manca',
      'PEC: manca',
    ]);
    expect(problems(await put({}))).toEqual(['Niente da salvare']);
    // I vuoti si salvano come vuoti; la provincia in maiuscolo.
    const ok = await put({
      dati: dati({ provincia: 'to', telefono: '', email: '', pec: null, indirizzo: '  ' }),
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<StudioView>().dati).toMatchObject({
      provincia: 'TO',
      telefono: null,
      email: null,
      pec: null,
      indirizzo: null,
    });
    expect(ok.json<StudioView>().daCompletare).toEqual([
      'Indirizzo completo (via e numero civico, CAP, comune, provincia): va sulla copia del certificato INPS per la visita in studio',
    ]);
    expect((await put({ dati: dati() })).statusCode).toBe(200);
  });

  it('nome dello studio e testi di una riga senza caratteri di controllo o invisibili (D179)', async () => {
    const res = await put({ dati: dati({ nome: 'Studio\u001b[1A di prova' }) });
    expect(res.statusCode, res.body).toBe(400);
    expect(problems(res).join(' ')).toContain('Nome dello studio: caratteri non ammessi');
    const city = await put({ dati: dati({ comune: 'Comune\ndi prova' }) });
    expect(city.statusCode, city.body).toBe(400);
    expect(problems(city).join(' ')).toContain('Comune: caratteri non ammessi');
    expect((await read()).dati.nome).toBe('Studio di prova');
  });

  it('regione obbligatoria, con il perché; in maiuscolo e senza la parola «REGIONE»', async () => {
    for (const regione of [null, '', '   ']) {
      const res = await put({ dati: dati({ regione }) });
      expect(res.statusCode).toBe(400);
      expect(problems(res)).toEqual([
        'Regione: obbligatoria, perché va nell’intestazione del promemoria della ricetta SSN (DM 2/11/2011, allegato 2, campo 1): senza, nessuna ricetta SSN si può inviare',
      ]);
    }
    expect(problems(await put({ dati: dati({ regione: 'Regione Piemonte' }) }))).toEqual([
      'Regione: scrivi solo il nome, per esempio PIEMONTE: «REGIONE» lo aggiunge il promemoria',
    ]);
    expect(problems(await put({ dati: dati({ regione: 'P1emonte' }) }))).toEqual([
      'Regione: solo lettere, spazi, apostrofo, punto e trattino',
    ]);
    const ok = await put({ dati: dati({ regione: 'Valle d’Aosta' }) });
    expect(ok.json<StudioView>().dati.regione).toBe('VALLE D’AOSTA');
    // Senza regione nel database (studio vecchio), l'avviso dice che le ricette SSN non partono.
    await t.db.update(studio).set({ regionName: null }).where(eq(studio.id, s.studioId));
    expect((await read('segreteria')).daCompletare[0]).toMatch(
      /^Regione: .*nessuna ricetta SSN si può inviare$/,
    );
    expect((await put({ dati: dati() })).statusCode).toBe(200);
    expect((await read()).daCompletare).toEqual([]);
  });

  it('limiti di buon senso per sicurezza, attesa e soglie degli avvisi', async () => {
    const res = await put({
      sicurezza: { minutiInattivita: 0, tentativiFalliti: 19, codiciSbagliati: 2, minutiBlocco: 4 },
      invii: { secondiAttesa: 61 },
      avvisi: {
        cartelleAlGiorno: 0,
        fasciaDalle: 24,
        fasciaAlle: -1,
        consultazioniAftAlGiorno: 1001,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(problems(res)).toEqual([
      'Minuti di inattività prima del blocco: un numero intero da 1 a 30',
      'Password sbagliate prima del blocco del conto: un numero intero da 20 a 100',
      'Codici sbagliati prima del blocco del conto: un numero intero da 3 a 10',
      'Durata del blocco: un numero intero da 5 a 60 minuti',
      'Tempo massimo di attesa degli invii: un numero intero da 1 a 60 secondi',
      'Cartelle diverse aperte da un utente in un giorno: un numero intero da 1 a 10000',
      'Fascia oraria, dalle ore: un numero intero da 0 a 23',
      'Fascia oraria, alle ore: un numero intero da 0 a 23',
      'Consultazioni dell’AFT di un collega in un giorno: un numero intero da 1 a 1000',
    ]);
    // Il blocco è un requisito: dal modulo non si spegne.
    expect(
      problems(
        await put({
          sicurezza: {
            minutiInattivita: null,
            tentativiFalliti: 50,
            codiciSbagliati: 5,
            minutiBlocco: 15,
          },
        }),
      ),
    ).toEqual(['Minuti di inattività prima del blocco: un numero intero da 1 a 30']);
    // Oltre cento password non è più un blocco.
    expect(
      problems(
        await put({
          sicurezza: {
            minutiInattivita: 5,
            tentativiFalliti: 101,
            codiciSbagliati: 11,
            minutiBlocco: 15,
          },
        }),
      ),
    ).toEqual([
      'Password sbagliate prima del blocco del conto: un numero intero da 20 a 100',
      'Codici sbagliati prima del blocco del conto: un numero intero da 3 a 10',
    ]);
    expect(problems(await put({ invii: { secondiAttesa: 7.5 } }))).toEqual([
      'Tempo massimo di attesa degli invii: un numero intero da 1 a 60 secondi',
    ]);
    // Ai limiti si salva; fuori dai 6–8 secondi della Regione resta un avviso.
    const edge = await put({
      sicurezza: {
        minutiInattivita: 30,
        tentativiFalliti: 100,
        codiciSbagliati: 10,
        minutiBlocco: 60,
      },
      invii: { secondiAttesa: 60 },
    });
    expect(edge.statusCode, edge.body).toBe(200);
    expect(edge.json<StudioView>().invii.avviso).toMatch(/da 6 a 8 secondi/);
    const back = await put({
      sicurezza: {
        minutiInattivita: 5,
        tentativiFalliti: 50,
        codiciSbagliati: 5,
        minutiBlocco: 15,
      },
      invii: { secondiAttesa: 8 },
    });
    expect(back.json<StudioView>().invii.avviso).toBeNull();
    // Il blocco per password sbagliate usa i valori nuovi: con 20, alla ventesima l'utente è
    // fermo. Ognuna da un indirizzo diverso, perché le attese per provenienza non la fermino prima.
    await put({
      sicurezza: {
        minutiInattivita: 5,
        tentativiFalliti: 20,
        codiciSbagliati: 5,
        minutiBlocco: 15,
      },
    });
    for (let i = 0; i < 20; i++)
      await s.app.inject({
        method: 'POST',
        url: '/api/accesso',
        payload: { username: s.users.collega.username, password: 'sbagliata', postazione: 'p' },
        remoteAddress: `10.20.${i}.1`,
      });
    const [collega] = await t.db
      .select({ lockedUntil: appUser.lockedUntil })
      .from(appUser)
      .where(eq(appUser.id, s.users.collega.id));
    expect(collega!.lockedUntil).not.toBeNull();
    await put({
      sicurezza: {
        minutiInattivita: 5,
        tentativiFalliti: 50,
        codiciSbagliati: 5,
        minutiBlocco: 15,
      },
    });
  });

  it('soglie degli avvisi: vuote vuol dire spente e da completare, con la fonte; la fascia vuole tutte e due le ore', async () => {
    const v = await read('titolare');
    expect(v.avvisi).toMatchObject({
      cartelleAlGiorno: null,
      fasciaDalle: null,
      fasciaAlle: null,
      consultazioniAftAlGiorno: null,
      daCompletare: [
        'Cartelle diverse aperte da un utente in un giorno',
        'Fascia oraria degli accessi',
        'Consultazioni dell’AFT di un collega in un giorno',
      ],
    });
    expect(v.avvisi.fonte).toMatch(/Linee guida sul dossier sanitario.*par\. 7, lett\. c$/);
    const empty = { cartelleAlGiorno: null, consultazioniAftAlGiorno: null };
    expect(
      problems(await put({ avvisi: { ...empty, fasciaDalle: 22, fasciaAlle: null } })),
    ).toEqual([
      'Fascia oraria: indica l’ora d’inizio e quella di fine, oppure lascia vuote tutte e due',
    ]);
    expect(problems(await put({ avvisi: { ...empty, fasciaDalle: 3, fasciaAlle: 3 } }))).toEqual([
      'Fascia oraria: l’ora d’inizio e quella di fine devono essere diverse',
    ]);
    // Valori di prova, non soglie da usare: le soglie vere sono da completare.
    const ok = await put({
      avvisi: { cartelleAlGiorno: 40, fasciaDalle: 23, fasciaAlle: 5, consultazioniAftAlGiorno: 3 },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<StudioView>().avvisi.daCompletare).toEqual([]);
    const off = await put({
      avvisi: { ...empty, fasciaDalle: null, fasciaAlle: null },
    });
    expect(off.json<StudioView>().avvisi.daCompletare).toHaveLength(3);
  });

  it('tipo di studio coerente con i medici titolari attivi', async () => {
    const res = await put({ dati: dati({ tipo: 'single' }) });
    expect(res.statusCode).toBe(400);
    expect(problems(res)).toEqual([
      'Tipo di studio: nello studio ci sono 2 medici titolari attivi, quindi è una medicina di gruppo',
    ]);
    // Con un solo titolare attivo, «medico singolo» si può.
    await t.db
      .update(appUser)
      .set({ status: 'suspended' })
      .where(eq(appUser.id, s.users.collega.id));
    expect((await put({ dati: dati({ tipo: 'single' }) })).statusCode).toBe(200);
    await t.db.update(appUser).set({ status: 'active' }).where(eq(appUser.id, s.users.collega.id));
    expect((await put({ dati: dati({ tipo: 'group' }) })).statusCode).toBe(200);
  });

  it('registro: campi cambiati, prima e dopo, senza segreti; storico con chi è stato; niente se non cambia nulla', async () => {
    const before = (await adminLog()).length;
    const res = await put({
      dati: dati({ telefono: '+39 000 1111111' }),
      invii: { secondiAttesa: 7 },
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await adminLog();
    expect(rows).toHaveLength(before + 1);
    const last = rows.at(-1)!;
    expect(last).toMatchObject({
      userId: s.users.amministratore.id,
      patientId: null,
      outcome: 'riuscito',
      workstation: 'postazione-amministratore',
      details: {
        area: 'studio',
        azione: 'modifica',
        campi: ['telefono', 'secondiAttesa'],
        prima: { telefono: '+39 000 0000000', secondiAttesa: 8 },
        dopo: { telefono: '+39 000 1111111', secondiAttesa: 7 },
      },
    });
    // Nel registro nessun segreto: né impronte delle password né segreti del secondo fattore.
    const [admin] = await t.db
      .select()
      .from(appUser)
      .where(eq(appUser.id, s.users.amministratore.id));
    const logged = JSON.stringify(rows.map((r) => r.details));
    expect(logged).not.toContain(admin!.passwordHash);
    expect(logged).not.toMatch(/password|segreto|totp|scrypt/i);
    // Lo storico delle modifiche dello studio sa chi è stato.
    const [history] = await t.db
      .select()
      .from(changeHistory)
      .where(and(eq(changeHistory.tableName, 'studio'), eq(changeHistory.rowId, s.studioId)))
      .orderBy(sql`${changeHistory.id} desc`)
      .limit(1);
    expect(history!.userId).toBe(s.users.amministratore.id);
    // Gli stessi valori un'altra volta: si salva senza errori e non c'è niente da registrare.
    const same = await put({
      dati: dati({ telefono: '+39 000 1111111' }),
      invii: { secondiAttesa: 7 },
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json<StudioView>().invii.secondiAttesa).toBe(7);
    expect(await adminLog()).toHaveLength(before + 1);
    await put({ dati: dati(), invii: { secondiAttesa: 8 } });
  });

  it('intestazione dello studio: righe pulite, al massimo 6 di 100 caratteri, con il permesso delle intestazioni', async () => {
    expect((await put({ intestazione: ['Riga'] }, 'titolare')).statusCode).toBe(403);
    expect(problems(await put({ intestazione: ['1', '2', '3', '4', '5', '6', '7'] }))).toEqual([
      'Intestazione: al massimo 6 righe',
    ]);
    expect(problems(await put({ intestazione: ['x'.repeat(101)] }))).toEqual([
      'Intestazione: al massimo 100 caratteri per riga',
    ]);
    const ok = await put({
      intestazione: ['  Studio medico di prova  ', '', 'Via di Prova 1 – Comune di prova'],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<StudioView>().intestazione).toEqual([
      'Studio medico di prova',
      'Via di Prova 1 – Comune di prova',
    ]);
    const last = (await adminLog()).at(-1)!;
    expect(last.details).toMatchObject({ area: 'studio', campi: ['intestazione'] });
  });

  /** Una bozza di ricetta SSN del titolare, da firmare e inviare. */
  const draft = async () => {
    const d = await req('titolare', 'POST', `/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      lines: [{ drugName: 'Farmaco di prova', quantity: 1 }],
    });
    expect(d.statusCode, d.body).toBe(201);
    return d.json<{ id: string }>().id;
  };

  it('tempo di attesa delle ricette: quello dello studio, letto a ogni invio', async () => {
    await put({ invii: { secondiAttesa: 1 } });
    const late = await draft();
    const res = await req('titolare', 'POST', `/api/ricette/${late}/firma-e-invia`, {});
    expect(res.json(), res.body).toMatchObject({ esito: 'timeout' });
    const [p] = await t.db.select().from(prescription).where(eq(prescription.id, late));
    expect(p).toMatchObject({ status: 'error', lastErrorKind: 'timeout' });
    expect(p!.lastErrorMessage).toMatch(/^Nessuna risposta entro 1 secondo:/);
    // L'amministratore allunga l'attesa: l'invio dopo la aspetta.
    await put({ invii: { secondiAttesa: 3 } });
    const inTime = await draft();
    const ok = await req('titolare', 'POST', `/api/ricette/${inTime}/firma-e-invia`, {});
    expect(ok.json(), ok.body).toMatchObject({ esito: 'accepted' });
    await put({ invii: { secondiAttesa: 8 } });
  });

  /** Un certificato di malattia del titolare, con visita in studio. */
  const certificate = async () => {
    const res = await req('titolare', 'POST', `/api/pazienti/${s.richPatient}/certificati`, {
      tipo: 'I',
      visita: 'A',
      dataInizio: studioDate(s.clock.now()),
      dataFine: studioDayFrom(s.clock.now(), 2),
      codiceDiagnosi: '487.1',
      noteDiagnosi: 'Sindrome influenzale di prova',
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };

  it('tempo di attesa dei certificati INPS: quello dello studio', async () => {
    inps.delayMs = 1500;
    try {
      await put({ invii: { secondiAttesa: 1 } });
      const id = await certificate();
      const res = await req('titolare', 'POST', `/api/certificati/${id}/invia`, {});
      expect(res.json(), res.body).toMatchObject({ esito: 'timeout' });
      const [row] = await t.db
        .select()
        .from(sickLeaveCertificate)
        .where(eq(sickLeaveCertificate.id, id));
      expect(row!.lastErrorMessage).toMatch(/^Nessuna risposta entro 1 secondo:/);
      await put({ invii: { secondiAttesa: 3 } });
      const again = await req('titolare', 'POST', `/api/certificati/${id}/invia`, {});
      expect(again.json(), again.body).toMatchObject({ esito: 'accepted' });
    } finally {
      inps.delayMs = 0;
      await put({ invii: { secondiAttesa: 8 } });
    }
  });

  it('copia INPS: l’indirizzo completo dello studio per la visita in studio, dentro il foglio', async () => {
    const saved = await put({
      dati: dati({
        indirizzo: 'Corso Vittorio di Prova 123',
        cap: '10125',
        comune: 'Comune di prova',
        provincia: 'TO',
      }),
    });
    const place = 'Corso Vittorio di Prova 123, 10125 Comune di prova (TO)';
    expect(saved.json<StudioView>().indirizzoCompleto).toBe(place);
    const id = await certificate();
    const sent = await req('titolare', 'POST', `/api/certificati/${id}/invia`, {});
    expect(sent.json(), sent.body).toMatchObject({ esito: 'accepted' });
    const pdf = await req('titolare', 'GET', `/api/certificati/${id}/copia`);
    expect(pdf.statusCode).toBe(200);
    const bytes = new Uint8Array(pdf.rawPayload);
    expect((await pdfText(bytes)).replace(/\s+/g, ' ')).toContain(`Luogo ${place}`);
    // Un indirizzo lungo va sulla riga sotto: nessun testo esce dal margine destro.
    const items = await textItems(bytes);
    const item = items.find((i) => i.str.includes('Corso Vittorio di Prova'))!;
    expect(item).toBeDefined();
    for (const i of items) expect(i.x + i.width, i.str).toBeLessThanOrEqual(i.pageWidth - 40 + 1);
    // Il luogo resta quello dell'invio anche se poi cambia l'indirizzo dello studio.
    await put({ dati: dati() });
    const again = await req('titolare', 'GET', `/api/certificati/${id}/copia`);
    expect(await pdfText(new Uint8Array(again.rawPayload))).toContain('Corso Vittorio di Prova');
    // Con un indirizzo corto il luogo resta accanto a protocollo e data.
    const short = await certificate();
    await req('titolare', 'POST', `/api/certificati/${short}/invia`, {});
    const copy = await req('titolare', 'GET', `/api/certificati/${short}/copia`);
    const text = (await pdfText(new Uint8Array(copy.rawPayload))).replace(/\s+/g, ' ');
    expect(text).toMatch(/Data rilascio \S+ Luogo Via di Prova 1, 10100 Comune di prova \(TO\)/);
  });

  it('certificati dai modelli: l’intestazione dello studio quando il medico non ha la sua', async () => {
    await put({ intestazione: ['Studio medico di prova', 'Via di Prova 1 – Comune di prova'] });
    const created = await req('titolare', 'POST', '/api/modelli/studio', {
      titolo: 'Certificato di prova',
      testo: ['{{paziente.cognome}} {{paziente.nome}}: {{campo.testo}}'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const key = created.json<{ chiave: string }>().chiave;
    const base = `/api/pazienti/${s.richPatient}/certificati-modelli`;
    const body = { modello: key, valori: { testo: 'testo di prova.' }, luogo: 'Comune di prova' };
    // Il titolare non ha un'intestazione sua: vale quella dello studio, anche in anteprima.
    const preview = await req('titolare', 'POST', `${base}/anteprima`, body);
    expect(await pdfText(new Uint8Array(preview.rawPayload))).toContain('Studio medico di prova');
    const issued = await req('titolare', 'POST', base, body);
    expect(issued.statusCode, issued.body).toBe(201);
    const certId = issued.json<{ id: string }>().id;
    const pdf = async () =>
      pdfText(new Uint8Array((await req('titolare', 'GET', `${base}/${certId}/pdf`)).rawPayload));
    expect(await pdf()).toContain('Studio medico di prova');
    // Nella prova di stampa dell'impaginazione senza intestazione si vede quella dello studio.
    const layout = {
      carattere: 'sans',
      dimensione: 11,
      intestazione: [],
      allineamento: 'left',
      margini: 20,
      luogo: '',
      timbro: '',
    };
    const trial = await req('titolare', 'POST', '/api/profilo/impaginazione/anteprima', layout);
    expect(await pdfText(new Uint8Array(trial.rawPayload))).toContain('Studio medico di prova');
    // Il certificato rilasciato non cambia se poi cambia l'intestazione dello studio.
    await put({ intestazione: ['Intestazione nuova dello studio'] });
    expect(await pdf()).toContain('Studio medico di prova');
    // Con la sua intestazione, il medico stampa la sua e non quella dello studio.
    const own = await req('titolare', 'PUT', '/api/profilo/impaginazione', {
      ...layout,
      intestazione: ['Dott.ssa Medica di prova'],
    });
    expect(own.statusCode, own.body).toBe(200);
    const mine = await pdfText(
      new Uint8Array((await req('titolare', 'POST', `${base}/anteprima`, body)).rawPayload),
    );
    expect(mine).toContain('Dott.ssa Medica di prova');
    expect(mine).not.toContain('Intestazione nuova dello studio');
    // L'impaginazione del medico resta sua: l'intestazione dello studio non ci entra.
    await req('titolare', 'PUT', '/api/profilo/impaginazione', layout);
    expect(
      (await req('titolare', 'GET', '/api/profilo/impaginazione')).json<{
        intestazione: string[];
      }>().intestazione,
    ).toEqual([]);
  });

  it('postazioni: le vedono tutti, le gestisce l’amministratore; nome unico tra le attive; si archiviano, non si cancellano', async () => {
    const list = async (who: Who = 'amministratore') => {
      const res = await req(who, 'GET', '/api/studio/postazioni');
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{
        postazioni: { id: string; nome: string; condivisa: boolean; note: string | null }[];
        archiviate: { id: string; nome: string; archiviataIl: string }[];
        puoModificare: boolean;
      }>();
    };
    expect(await list('segreteria')).toEqual({
      postazioni: [],
      archiviate: [],
      puoModificare: false,
    });
    const post = (body: object, who: Who = 'amministratore') =>
      req(who, 'POST', '/api/studio/postazioni', body);
    expect((await post({ nome: 'Segreteria', condivisa: true }, 'titolare')).statusCode).toBe(403);
    expect((await post({ nome: '', condivisa: true })).statusCode).toBe(400);
    expect(problems(await post({ nome: 'Senza tipo' }))).toEqual([
      'Postazione condivisa o personale: da scegliere',
    ]);
    const a = await post({ nome: 'Ambulatorio 1', condivisa: true, note: 'Stampante laser' });
    expect(a.statusCode, a.body).toBe(201);
    const first = a.json<{ id: string }>();
    const b = await post({ nome: 'Studio della dottoressa', condivisa: false });
    expect(b.statusCode).toBe(201);
    const second = b.json<{ id: string }>();
    const dup = await post({ nome: '  ambulatorio 1 ', condivisa: false });
    expect(dup.statusCode).toBe(409);
    expect(dup.json<{ errore: string }>().errore).toBe(
      'C’è già una postazione attiva che si chiama «ambulatorio 1»: scegli un altro nome o archivia l’altra',
    );
    // Rinominare con il nome di un'altra attiva: no; cambiare solo le maiuscole della propria: sì.
    const patch = (id: string, body: object, who: Who = 'amministratore') =>
      req(who, 'PATCH', `/api/studio/postazioni/${id}`, body);
    expect((await patch(second.id, { nome: 'AMBULATORIO 1' })).statusCode).toBe(409);
    // Lo stesso nome con uno spazio in più non è un cambio: niente nel registro.
    expect((await patch(first.id, { nome: 'Ambulatorio 1 ' })).statusCode).toBe(200);
    expect((await patch(first.id, { note: null }, 'segreteria')).statusCode).toBe(403);
    const changed = await patch(first.id, { nome: 'AMBULATORIO 1', note: '' });
    expect(changed.json()).toMatchObject({ nome: 'AMBULATORIO 1', note: null, condivisa: true });
    expect((await patch(first.id, {})).statusCode).toBe(400);
    expect((await patch('non-un-id', { note: 'x' })).statusCode).toBe(404);
    expect((await patch('00000000-0000-0000-0000-000000000000', { note: 'x' })).statusCode).toBe(
      404,
    );
    // Archiviata: non si modifica più, e il nome torna libero.
    const archive = (id: string, who: Who = 'amministratore') =>
      req(who, 'POST', `/api/studio/postazioni/${id}/archivia`);
    expect((await archive(first.id, 'sostituto')).statusCode).toBe(403);
    expect((await archive(first.id)).statusCode).toBe(200);
    const twice = await archive(first.id);
    expect([twice.statusCode, twice.json<{ errore: string }>().errore]).toEqual([
      409,
      'La postazione è già archiviata',
    ]);
    const late = await patch(first.id, { note: 'x' });
    expect([late.statusCode, late.json<{ errore: string }>().errore]).toEqual([
      409,
      'La postazione è archiviata: non si modifica più',
    ]);
    expect((await post({ nome: 'Ambulatorio 1', condivisa: true })).statusCode).toBe(201);
    const now = await list('titolare');
    expect(now.postazioni.map((w) => w.nome)).toEqual(['Ambulatorio 1', 'Studio della dottoressa']);
    expect(now.archiviate.map((w) => w.nome)).toEqual(['AMBULATORIO 1']);
    // Una postazione non si cancella, nemmeno dal database.
    await expect(t.db.delete(workstation).where(eq(workstation.id, first.id))).rejects.toThrow();
    // Ogni azione nel registro, con area «postazioni»; anche i tentativi negati.
    type Details = { area?: string; azione?: string; permesso?: string };
    const rows = (await adminLog()).filter((r) => (r.details as Details).area === 'postazioni');
    const done = rows.filter((r) => r.outcome === 'riuscito');
    expect(done.map((r) => (r.details as Details).azione)).toEqual([
      'creazione',
      'creazione',
      'modifica',
      'archiviazione',
      'creazione',
    ]);
    expect(
      rows
        .filter((r) => r.outcome === 'negato')
        .map((r) => [r.userId, (r.details as Details).azione, (r.details as Details).permesso]),
    ).toEqual([
      [s.users.titolare.id, 'creazione', 'admin.studio'],
      [s.users.segreteria.id, 'modifica', 'admin.studio'],
      [s.users.sostituto.id, 'archiviazione', 'admin.studio'],
    ]);
    const rename = done.find((r) => (r.details as Details).azione === 'modifica')!;
    expect(rename.details).toMatchObject({
      postazione: { id: first.id, nome: 'AMBULATORIO 1' },
      campi: ['nome', 'note'],
      prima: { nome: 'Ambulatorio 1', note: 'Stampante laser' },
      dopo: { nome: 'AMBULATORIO 1', note: null },
    });
  });

  it('stato del servizio: solo l’amministratore; collegamenti simulati, sessione, banche dati, salvataggi', async () => {
    for (const who of ['titolare', 'segreteria'] as const)
      expect((await req(who, 'GET', '/api/studio/servizio')).statusCode).toBe(403);
    const res = await req('amministratore', 'GET', '/api/studio/servizio');
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json<{
      collegamenti: {
        codice: string;
        ambiente: string;
        ultimoUso: { ambiente: string; esito: string; operazione: string } | null;
      }[];
      sessione: { durataMassimaOre: number; minutiInattivita: number };
      bancheDati: { configurato: boolean; ora: string | null; prossimoGiro: string | null };
      salvataggi: { nelProgramma: boolean };
    }>();
    expect(v.collegamenti.map((x) => x.codice)).toEqual([
      'sar',
      'sistema_ts',
      'inps',
      'fse',
      'accesso_regionale',
      'secondo_fattore',
      'email_sms',
    ]);
    expect(new Set(v.collegamenti.map((x) => x.ambiente))).toEqual(new Set(['simulatore']));
    // Le prove sopra hanno inviato ricette e certificati: l'ultimo invio è andato al simulatore.
    const byCode = Object.fromEntries(v.collegamenti.map((x) => [x.codice, x.ultimoUso]));
    expect(byCode.sar).toMatchObject({ ambiente: 'simulatore', operazione: 'invio' });
    expect(byCode.inps).toMatchObject({
      ambiente: 'simulatore',
      operazione: 'invio',
      esito: 'accettato',
    });
    expect(byCode.sistema_ts).toBeNull();
    expect(v.sessione).toEqual({ durataMassimaOre: 12, minutiInattivita: 5 });
    expect(v.bancheDati).toEqual({ configurato: false, ora: null, prossimoGiro: null });
    expect(v.salvataggi).toEqual({ nelProgramma: false });
  });

  it('gli invii di un altro studio non si vedono nello stato del servizio', async () => {
    const other = await createScenario(t.db, { name: 'Altro studio di prova' });
    try {
      const cookie = await login(other, 'amministratore');
      const res = await other.app.inject({
        method: 'GET',
        url: '/api/studio/servizio',
        headers: { cookie },
      });
      const v = res.json<{ collegamenti: { ultimoUso: unknown }[] }>();
      expect(v.collegamenti.every((x) => x.ultimoUso === null)).toBe(true);
      const studioView = await other.app.inject({
        method: 'GET',
        url: '/api/studio',
        headers: { cookie },
      });
      expect(studioView.json<StudioView>().dati.nome).toBe('Altro studio di prova');
      const list = await other.app.inject({
        method: 'GET',
        url: '/api/studio/postazioni',
        headers: { cookie },
      });
      expect(list.json<{ postazioni: unknown[] }>().postazioni).toEqual([]);
      // Una postazione dell'altro studio non si tocca da qui.
      const [mine] = await t.db
        .select()
        .from(workstation)
        .where(and(eq(workstation.studioId, s.studioId), gt(workstation.createdAt, new Date(0))))
        .limit(1);
      const foreign = await other.app.inject({
        method: 'POST',
        url: `/api/studio/postazioni/${mine!.id}/archivia`,
        headers: { cookie },
      });
      expect(foreign.statusCode).toBe(404);
    } finally {
      await other.app.close();
    }
  });

  it('le note delle postazioni sono un’area di testo: l’a capo resta ammesso (D179)', async () => {
    const ws = await req('amministratore', 'POST', '/api/studio/postazioni', {
      nome: 'Postazione con le note su due righe',
      condivisa: true,
      note: 'Prima riga\nseconda riga',
    });
    expect(ws.statusCode, ws.body).toBe(201);
  });
});

describe('tempo di attesa dato al servizio: vale sopra quello dello studio', () => {
  let t: TestDatabase;
  let s: Scenario;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      // Lo studio aspetterebbe 30 secondi; il servizio è avviato con 50 millisecondi.
      { sendTimeoutSeconds: 30 },
      {
        gateways: {
          sar: new SimulatedGateway('sar', { delayMs: 300 }),
          sistema_ts: new SimulatedGateway('sistema_ts'),
        },
        preSendChecks: noRules,
        sendTimeoutMs: 50,
      },
    );
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('con sendTimeoutMs l’attesa è quella, non quella dello studio', async () => {
    const cookie = await login(s, 'titolare');
    const d = await s.app.inject({
      method: 'POST',
      url: `/api/pazienti/${s.richPatient}/ricette`,
      headers: { cookie },
      payload: { kind: 'pharma_ssn', lines: [{ drugName: 'Farmaco di prova', quantity: 1 }] },
    });
    const id = d.json<{ id: string }>().id;
    const res = await s.app.inject({
      method: 'POST',
      url: `/api/ricette/${id}/firma-e-invia`,
      headers: { cookie },
      payload: {},
    });
    expect(res.json()).toMatchObject({ esito: 'timeout' });
    const [p] = await t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(p!.lastErrorMessage).toMatch(/0\.05 secondi/);
  });
});
