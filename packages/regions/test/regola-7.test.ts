import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REGIONAL_PACKAGES } from '../src';

/**
 * Regola 7 nei pacchetti regionali (D297, D300): le integrazioni con i servizi della regione sono
 * interfacce con simulatori. Nel loro codice non ci sono richieste di rete; gli indirizzi sono solo
 * spazi dei nomi XML dei messaggi, che il pacchetto elenca in `integrations/xml-namespaces.ts`.
 * La stessa prova per il nucleo è in `packages/integrations/test/simulatore.test.ts`.
 */

const root = join(import.meta.dirname, '..');

function filesOf(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath, e.name));
}

describe('nessuna chiamata a servizi reali nei pacchetti regionali (regola 7)', () => {
  for (const pkg of REGIONAL_PACKAGES) {
    const dir = join(root, pkg.key, 'integrations');
    const has = (() => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })();
    if (!has) continue;
    it(`${pkg.key}: niente richieste di rete, e indirizzi solo come spazi dei nomi XML`, async () => {
      const { XML_NAMESPACES } = (await import(join(dir, 'xml-namespaces.ts'))) as {
        XML_NAMESPACES: readonly string[];
      };
      const files = filesOf(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        let text = readFileSync(f, 'utf8');
        expect(text, f).not.toMatch(/\bfetch\(|node:https?|from 'undici'|axios|XMLHttpRequest/);
        for (const ns of XML_NAMESPACES) text = text.replaceAll(ns, '');
        expect(text, f).not.toMatch(/https?:\/\//);
      }
    });
  }
});
