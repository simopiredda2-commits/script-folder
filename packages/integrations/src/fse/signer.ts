/**
 * Firma PAdES dei documenti del medico (tappa 11, D137). Nel programma vero la firma è quella
 * qualificata del medico, di solito una firma remota con un codice usa e getta: il fornitore è da
 * scegliere. Qui l'interfaccia e il simulatore, che firma con un certificato di prova per medico:
 * la firma ha la forma di una firma vera ma non vale fuori dal programma.
 */

import { createPrivateKey } from 'node:crypto';
import { signPades } from './pdf';
import { createTestCertificate, type TestCertificate } from './x509';

export interface DocumentSignerPerson {
  userId: string;
  name: string;
  fiscalCode: string;
}

export type DocumentSignResult =
  | { outcome: 'signed'; pdf: Uint8Array; signedAt: Date; certificateSubject: string }
  | { outcome: 'rejected'; message: string }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

export interface DocumentSigner {
  readonly environment: 'simulator' | 'test' | 'production';
  signPdf(
    pdf: Uint8Array,
    signer: DocumentSignerPerson,
    reason: string,
  ): Promise<DocumentSignResult>;
}

export type SimulatedSignOutcome = 'signed' | 'rejected' | 'unreachable' | 'timeout';

export class SimulatedDocumentSigner implements DocumentSigner {
  readonly environment = 'simulator' as const;
  private readonly certificates = new Map<string, TestCertificate>();

  constructor(
    private readonly options: { now?: () => Date; decide?: () => SimulatedSignOutcome } = {},
  ) {}

  /** Il certificato di prova del medico (uno per medico, per tutta la vita del simulatore). */
  certificateOf(signer: DocumentSignerPerson): TestCertificate {
    let c = this.certificates.get(signer.userId);
    if (!c) {
      c = createTestCertificate({
        commonName: `${signer.name} (firma simulata)`,
        organization: 'Simulatore di firma',
        serialNumber: signer.fiscalCode,
        from: new Date((this.options.now?.() ?? new Date()).getTime() - 86_400_000),
        days: 3 * 365,
      });
      this.certificates.set(signer.userId, c);
    }
    return c;
  }

  async signPdf(
    pdf: Uint8Array,
    signer: DocumentSignerPerson,
    reason: string,
  ): Promise<DocumentSignResult> {
    const outcome = this.options.decide?.() ?? 'signed';
    if (outcome === 'unreachable')
      return { outcome, message: 'Servizio di firma non raggiungibile (simulato)' };
    if (outcome === 'timeout')
      return { outcome, message: 'Servizio di firma: nessuna risposta in tempo (simulato)' };
    if (outcome === 'rejected')
      return { outcome, message: 'Firma rifiutata dal servizio (simulato): codice non valido' };
    const at = this.options.now?.() ?? new Date();
    const c = this.certificateOf(signer);
    const signed = await signPades(pdf, {
      certificateDer: c.der,
      issuerAndSerialDer: c.issuerAndSerialDer,
      key: createPrivateKey(c.privateKeyPem),
      name: signer.name,
      reason,
      at,
    });
    return { outcome: 'signed', pdf: signed, signedAt: at, certificateSubject: c.subject };
  }
}
