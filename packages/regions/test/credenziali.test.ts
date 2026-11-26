import { CREDENTIAL_SERVICE_KEY, CREDENTIAL_SERVICE_SLUG, NATIONAL_CREDENTIALS } from '@mmg/domain';
import { SimulatedFseGateway } from '@mmg/integrations';
import { describe, expect, it } from 'vitest';
import { REGIONAL_PACKAGES } from '../src';

/**
 * Le credenziali dei pacchetti regionali (D301): ogni pacchetto che le dà ha chiave e nome corto
 * nella forma di tutti i servizi, diversi da quelli del Sistema TS e degli altri pacchetti; ogni sua
 * integrazione si chiama con le credenziali del pacchetto o con quelle del Sistema TS; l'accesso con
 * SPID o CIE dice come si presenta il programma, perché il `client_id` viene da lì.
 */
describe('credenziali dei pacchetti regionali (D301)', () => {
  const withCredentials = REGIONAL_PACKAGES.filter((p) => p.integrations?.credentials);

  it('chiavi e nomi corti nella forma giusta, uno per pacchetto, diversi dal Sistema TS', () => {
    const keys = withCredentials.map((p) => p.integrations!.credentials!.key);
    const slugs = withCredentials.map((p) => p.integrations!.credentials!.slug);
    for (const k of keys) expect(k).toMatch(CREDENTIAL_SERVICE_KEY);
    for (const s of slugs) expect(s).toMatch(CREDENTIAL_SERVICE_SLUG);
    expect(new Set([...keys, NATIONAL_CREDENTIALS.key]).size).toBe(keys.length + 1);
    expect(new Set([...slugs, NATIONAL_CREDENTIALS.slug]).size).toBe(slugs.length + 1);
  });

  it('ogni integrazione si chiama con le credenziali del suo pacchetto o del Sistema TS', () => {
    for (const p of REGIONAL_PACKAGES) {
      const allowed = [NATIONAL_CREDENTIALS.slug, p.integrations?.credentials?.slug].filter(
        Boolean,
      );
      const used: string[] = [];
      const prescription = p.integrations?.prescription?.({});
      if (prescription?.route === 'gateway') used.push(prescription.credentialService);
      for (const call of p.integrations?.contextCalls?.({}) ?? [])
        used.push(call.credentialService);
      const publication = p.integrations?.fsePublication?.({
        gateway: new SimulatedFseGateway(),
        application: { id: 'PROVA', vendor: 'Prova', version: '0' },
      });
      if (publication) used.push(publication.credentialService);
      for (const slug of used) expect(allowed, `${p.key}: ${slug}`).toContain(slug);
    }
  });

  it('con l’accesso con SPID o CIE il pacchetto dice come si presenta il programma', () => {
    for (const p of withCredentials) {
      const c = p.integrations!.credentials!;
      if (c.strongAccess) expect(c.software, p.key).toBeTruthy();
    }
  });
});
