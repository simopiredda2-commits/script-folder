import { createTestCertificate, type RegionalAuthor, type ServiceAuth } from '@mmg/integrations';
import { describe, expect, it } from 'vitest';
import {
  FSE_PUBLICATION_POLICY,
  FSE_PUBLICATION_TEXTS,
  REGIONAL_REGIMES,
  RegionalFseClient,
  V09,
  V09FsePublication,
  type RegionalFseService,
  type RegionalSoapResponse,
} from '..';

/**
 * La pubblicazione del Piemonte come la vuole il contratto nazionale (D297): le risposte che la V09
 * non prevede diventano errori da ripetere, «1103» nella cancellazione dice che non c'è niente da
 * cancellare, e il pacchetto dà regimi, attività clinica, politiche e parole del CSI. Persone
 * inventate.
 */

const author: RegionalAuthor = {
  fiscalCode: 'MDCPRV65B12X001Y',
  firstName: 'Medica',
  lastName: 'Inventata',
  aslCode: '203',
};
const AUTH: ServiceAuth = { username: 'utente', password: 'password', pin: '12345' };
const certificate = createTestCertificate({ commonName: 'Servizio di prova' }).der;

/** Il servizio risponde sempre con il corpo dato. */
function publication(body: string) {
  const asked: RegionalFseService[] = [];
  const transport = {
    environment: 'simulator' as const,
    send: (req: { service: RegionalFseService }): Promise<RegionalSoapResponse> => {
      asked.push(req.service);
      return Promise.resolve({ status: 200, body });
    },
  };
  const client = new RegionalFseClient(transport, {
    encryptionCertificate: certificate,
    application: { id: 'PROVA', vendor: 'PROVA', version: '0' },
  });
  return { p: new V09FsePublication(client), asked };
}

const document = {
  author,
  metadata: {
    patientFiscalCode: 'PRVPZN70A41X001X',
    confidentiality: 'N' as const,
    writtenAt: new Date('2026-11-18T09:30:00Z'),
    regime: 'SSN',
    signed: true,
  },
  document: new Uint8Array([1, 2, 3]),
  workflowInstanceId: 'workflow-di-prova',
  locality: 'STUDIO DI PROVA^^^^^&2.999.3&ISO^^^^000001',
};

describe('pubblicazione del Piemonte per il contratto nazionale (D297)', () => {
  it('regimi, attività clinica, politiche e parole sono quelli della V09 e del CSI', () => {
    const { p } = publication('<r/>');
    expect(p.environment).toBe('simulator');
    expect(p.regimes).toBe(REGIONAL_REGIMES);
    expect(p.clinicalActivity).toBe(V09.clinicalActivity);
    expect(p.policy).toBe(FSE_PUBLICATION_POLICY);
    expect(p.texts).toBe(FSE_PUBLICATION_TEXTS);
    expect(p.texts.reportTo).toMatch(/^al supporto del Fascicolo del CSI Piemonte \(.+@csi\.it\)$/);
    expect(p.texts.credentialsMissing).toMatch(/utente, password e PIN RUPAR/);
  });

  it('il codice ASL del medico: tre cifre', () => {
    const { p } = publication('<r/>');
    expect(p.authorIssues({ aslCode: '203' })).toEqual([]);
    for (const aslCode of ['', '20', '2031', 'ABC'])
      expect(p.authorIssues({ aslCode })[0], aslCode).toMatch(/manca il codice ASL/);
  });

  it('presa in carico senza identificativo temporaneo: un errore da ripetere', async () => {
    const { p, asked } = publication('<r><Esito>0000</Esito></r>');
    const r = await p.create(document, AUTH);
    expect(asked).toEqual(['ComunicazioneMetadati']);
    expect(r).toMatchObject({
      outcome: 'rejected',
      esito: '0000',
      retryable: true,
      errors: [{ code: 'FSE_ER_000', message: 'Presa in carico senza identificativo temporaneo' }],
    });
  });

  it('presa in carico con l’identificativo: accettata, con l’identificativo', async () => {
    const { p } = publication(
      '<r><Esito>0000</Esito><IdentificativoDocumento>TEMP_010_1</IdentificativoDocumento></r>',
    );
    expect(await p.create(document, AUTH)).toMatchObject({
      outcome: 'accepted',
      temporaryId: 'TEMP_010_1',
    });
  });

  it('esito «OK» senza OID: un errore da ripetere; «ELAB» e «KO» come la V09', async () => {
    const input = { author, temporaryId: 'TEMP_010_1', from: new Date(0), to: new Date() };
    const ok = publication('<r><Esito>0000</Esito><StatoElaborazione>OK</StatoElaborazione></r>');
    expect(await ok.p.outcome(input, AUTH)).toMatchObject({
      outcome: 'rejected',
      retryable: true,
      errors: [{ code: 'FSE_ER_000', message: 'Esito «OK» senza OID' }],
    });
    const done = publication(
      '<r><Esito>0000</Esito><StatoElaborazione>OK</StatoElaborazione><IdentificativoDocumento>2.999^1</IdentificativoDocumento></r>',
    );
    expect(await done.p.outcome(input, AUTH)).toMatchObject({
      outcome: 'checked',
      state: 'OK',
      oid: '2.999^1',
    });
    const elab = publication(
      '<r><Esito>0000</Esito><StatoElaborazione>ELAB</StatoElaborazione></r>',
    );
    expect(await elab.p.outcome(input, AUTH)).toMatchObject({ outcome: 'checked', state: 'ELAB' });
    const ko = publication(
      '<r><Esito>0000</Esito><StatoElaborazione>KO</StatoElaborazione><MotivazioneScarto>Firma non valida</MotivazioneScarto></r>',
    );
    expect(await ko.p.outcome(input, AUTH)).toMatchObject({
      outcome: 'checked',
      state: 'KO',
      reason: 'Firma non valida',
    });
  });

  it('cancellazione con «1103»: niente da cancellare; un altro errore no', async () => {
    const input = { author, patientFiscalCode: 'PRVPZN70A41X001X', documentId: '2.999^1' };
    const error = (code: string) =>
      `<r><Esito>9999</Esito><Errore><codEsito>${code}</codEsito><esito>Errore di prova</esito><tipoErrore>Bloccante</tipoErrore><fonte>FSE</fonte></Errore></r>`;
    expect(await publication(error('1103')).p.remove(input, AUTH)).toMatchObject({
      outcome: 'rejected',
      nothingToDelete: true,
    });
    const other = await publication(error('1059')).p.remove(input, AUTH);
    expect(other.outcome).toBe('rejected');
    expect(other).not.toHaveProperty('nothingToDelete');
    const accepted = await publication('<r><Esito>0000</Esito></r>').p.remove(input, AUTH);
    expect(accepted).toMatchObject({ outcome: 'accepted', esito: '0000' });
    expect(accepted).not.toHaveProperty('temporaryId');
  });
});
