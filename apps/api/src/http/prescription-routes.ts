import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client';
import { prescriptionHistory } from '../prescriptions/history';
import { prescribedDrugs, prescribedServices } from '../prescriptions/prescribed';
import type { PrescriptionService } from '../prescriptions/service';
import { registerHistoricalPrescriptionRoutes } from './historical-prescription-routes';

const idParams = z.object({ id: z.uuid() });

/** Rotte delle ricette. Quelle con :id passano dalla guardia sul paziente e scrivono il registro. */
export function registerPrescriptionRoutes(
  app: FastifyInstance,
  service: PrescriptionService,
  db: Database,
  now: () => Date,
) {
  const scoped = { config: { patientScoped: true } };
  // Ricette fatte con un altro programma (tappa 15): fuori dalla macchina degli stati delle ricette.
  registerHistoricalPrescriptionRoutes(app, db, now);

  // Storico delle prescrizioni di un farmaco o di una prestazione (D65, D66).
  app.get('/api/pazienti/:id/storico-prescrizioni', scoped, async (req) => {
    const { id } = idParams.parse(req.params);
    // La richiesta si valida dopo la guardia, come le altre: anche una richiesta sbagliata è registrata.
    return prescriptionHistory(db, now, req.actor!, id, req.query);
  });

  // Tutti i farmaci e tutte le prestazioni prescritti, ognuno con il suo storico (D152).
  app.get('/api/pazienti/:id/farmaci-prescritti', scoped, async (req) => {
    const { id } = idParams.parse(req.params);
    return prescribedDrugs(db, now, req.actor!, id);
  });

  app.get('/api/pazienti/:id/prestazioni-prescritte', scoped, async (req) => {
    const { id } = idParams.parse(req.params);
    return prescribedServices(db, now, req.actor!, id);
  });

  app.get('/api/pazienti/:id/ricette', scoped, async (req) => {
    const { id } = idParams.parse(req.params);
    return { ricette: await service.listForPatient(req.actor!, id) };
  });

  app.post('/api/pazienti/:id/ricette', scoped, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    // Il corpo si valida nel servizio, dopo la guardia: anche una richiesta sbagliata è registrata.
    const created = await service.createDraft(req.actor!, id, req.body);
    return reply.status(201).send({ id: created });
  });

  app.post('/api/pazienti/:id/ricette/ripeti', scoped, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    // Anche qui il corpo si valida nel servizio, dopo la guardia.
    return reply
      .status(201)
      .send({ ricette: await service.prepareRepeat(req.actor!, id, req.body) });
  });

  app.post('/api/ricette/:id/da-firmare', scoped, async (req) => {
    await service.submitForSigning(req.actor!, idParams.parse(req.params).id);
    return { stato: 'to_sign' };
  });

  app.post('/api/ricette/:id/bozza', scoped, async (req) => {
    await service.backToDraft(req.actor!, idParams.parse(req.params).id);
    return { stato: 'draft' };
  });

  app.post('/api/ricette/:id/controlla', scoped, async (req) => {
    return service.checkOnly(req.actor!, idParams.parse(req.params).id, req.body);
  });

  app.post('/api/ricette/:id/firma-e-invia', scoped, async (req) => {
    const r = await service.signAndSend(req.actor!, idParams.parse(req.params).id, req.body);
    // `avviso`: il lotto successivo di NRE non è arrivato, ma restano numeri (D269).
    return { esito: r.outcome, nre: r.nre, messaggio: r.messaggio, avviso: r.avviso };
  });

  // Esito di un invio rimasto senza risposta, chiesto all'ente dal medico (D233).
  app.post('/api/ricette/:id/esito-invio', scoped, async (req) => {
    return service.settleInterrupted(req.actor!, idParams.parse(req.params).id, req.body);
  });

  // Stato di erogazione presso l'ente e possibilità di annullare (D70).
  app.get('/api/ricette/:id/stato-erogazione', scoped, async (req) => {
    return service.dispensingStatus(req.actor!, idParams.parse(req.params).id);
  });

  app.post('/api/ricette/:id/annulla', scoped, async (req) => {
    const { id } = idParams.parse(req.params);
    return { esito: (await service.cancel(req.actor!, id, req.body)).outcome };
  });

  // Ricetta rossa: per la SSN al SAR con il numero del modulo del Poligrafico e l'invio in DPCM
  // (D270); per le altre il ripiego di prima.
  app.post('/api/ricette/:id/ricetta-rossa', scoped, async (req) => {
    return service.printPaper(req.actor!, idParams.parse(req.params).id, req.body);
  });

  app.get('/api/ricette/:id/ricetta-rossa.pdf', scoped, async (req, reply) => {
    const pdf = await service.redFormPdf(req.actor!, idParams.parse(req.params).id);
    return reply
      .type('application/pdf')
      .header('content-disposition', 'inline; filename="ricetta-rossa.pdf"')
      .send(Buffer.from(pdf));
  });

  // Ricette rosse del medico: invio in DPCM, esito, annullamento della dematerializzata (D270).
  app.get('/api/ricette-rosse', async (req) => ({ ricette: await service.redList(req.actor!) }));

  // «Invia adesso»: un giro della coda sulle ricette rosse del medico, senza aspettare.
  app.post('/api/ricette-rosse/invia', async (req) => ({
    ricette: await service.redRunNow(req.actor!),
  }));

  app.get('/api/ricette/da-firmare', async (req) => ({
    pazienti: await service.toSignQueue(req.actor!),
  }));

  // Le bozze di chi guarda, non ancora mandate (audit, D259).
  app.get('/api/ricette/in-bozza', async (req) => ({
    pazienti: await service.draftQueue(req.actor!),
  }));

  app.get('/api/ricette/non-inviate', async (req) => ({
    pazienti: await service.failedQueue(req.actor!),
  }));

  // Invii rimasti senza risposta: l'esito lo segna il medico (D233).
  app.get('/api/ricette/senza-risposta', async (req) => ({
    pazienti: await service.interruptedQueue(req.actor!),
  }));

  // Confermate, cioè inviate o stampate, e la loro archiviazione dall'elenco (D254).
  app.get('/api/ricette/confermate', async (req) => ({
    pazienti: await service.confirmedQueue(req.actor!),
  }));

  app.post('/api/ricette/archivia-confermate', async (req) => service.archiveConfirmed(req.actor!));
}
