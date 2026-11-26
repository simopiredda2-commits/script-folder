import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { REGIONAL_PACKAGES } from '../src/registry';
import type { RegionalPackage } from '../src/types';

/**
 * Prova dei nomi regionali (D292): le parole che nominano una regione, i suoi enti, servizi e atti
 * stanno nelle cartelle del suo pacchetto (`regions/<chiave>/`, in ogni livello del programma).
 * Fuori, ci sono solo dove l'inventario lo dice, con lo stesso numero di righe: l'inventario si
 * accorcia a ogni spostamento e non cresce (D288).
 */

/** Radice del repository. */
export const repoRoot = join(import.meta.dirname, '..', '..', '..');

/** Le cartelle di codice che si guardano, come per il nome del prodotto. */
export const guardedRoots = ['apps', 'packages', 'sync', 'fixtures', 'scripts'];

const skippedDirs = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vite',
  '__pycache__',
  'test-results',
  'playwright-report',
]);

/**
 * Dove una parola regionale ha un altro senso o è storia: percorso (file, o cartella con la «/»
 * finale) e motivo. Si aggiunge solo con un motivo scritto.
 */
export const EXCEPTIONS: Record<string, string> = {
  'apps/api/migrations/':
    'le migrazioni sono la storia del database: si aggiungono, non si cambiano',
  'packages/domain/src/asl-elenco.ts':
    'l’elenco nazionale delle aziende sanitarie, generato dai dati del Ministero, nomina tutte le regioni',
  'packages/reference/data/trascrizioni/icd9cm/':
    'nell’elenco delle diagnosi ICD-9-CM il nome dell’anagrafe regionale è anche un sintomo dell’emicrania',
  'packages/regions/inventario.json':
    'l’inventario elenca i file che nominano ancora una regione fuori dal pacchetto, con i loro percorsi',
  'packages/regions/src/registry.ts':
    'l’elenco dei pacchetti nomina le regioni che ne hanno uno, come brand.ts il nome del prodotto',
};

/** Inventario: per pacchetto, i file fuori dalle sue cartelle con il numero di righe che lo nominano. */
export type Inventory = Record<string, Record<string, number>>;

const posix = (p: string) => p.split(sep).join('/');

/** Il pacchetto delle cartelle in cui sta il file: `regions/<chiave>/` in un punto del percorso. */
export function zoneOf(rel: string, keys: readonly string[]): string | null {
  for (const m of posix(rel).matchAll(/(?:^|\/)regions\/([^/]+)\//g))
    if (keys.includes(m[1]!)) return m[1]!;
  return null;
}

export function isException(rel: string): boolean {
  const p = posix(rel);
  return Object.keys(EXCEPTIONS).some((e) => (e.endsWith('/') ? p.startsWith(e) : p === e));
}

/** Le righe del testo (e il percorso, come riga 0) con almeno una parola del pacchetto. */
export function matchingLines(pkg: RegionalPackage, rel: string, text: string): number[] {
  const lines = [posix(rel), ...text.split('\n')];
  const out: number[] = [];
  lines.forEach((l, i) => {
    if (pkg.terms.some((t) => t.test(l))) out.push(i);
  });
  return out;
}

/**
 * Conta, file per file, le righe che nominano ogni pacchetto fuori dalle sue cartelle, saltando le
 * eccezioni, le cartelle generate e i file binari.
 */
export function countRegionalLines(
  root: string = repoRoot,
  roots: readonly string[] = guardedRoots,
  packages: readonly RegionalPackage[] = REGIONAL_PACKAGES,
): Inventory {
  const keys = packages.map((p) => p.key);
  const out: Inventory = Object.fromEntries(packages.map((p) => [p.key, {}]));
  const visit = (abs: string) => {
    const rel = posix(relative(root, abs));
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (skippedDirs.has(abs.split(sep).pop()!)) return;
      if (isException(`${rel}/`)) return;
      for (const entry of readdirSync(abs).sort()) visit(join(abs, entry));
      return;
    }
    if (isException(rel)) return;
    const buf = readFileSync(abs);
    if (buf.includes(0)) return; // file binario
    const text = buf.toString('utf8');
    const zone = zoneOf(rel, keys);
    for (const pkg of packages) {
      if (zone === pkg.key) continue;
      const n = matchingLines(pkg, rel, text).length;
      if (n) out[pkg.key]![rel] = n;
    }
  };
  for (const r of roots) {
    const abs = join(root, r);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    visit(abs);
  }
  return out;
}

/** Dove l'inventario e i file non tornano: righe in più (vietato) e righe in meno (da aggiornare). */
export function compareInventory(found: Inventory, inventory: Inventory) {
  const grown: string[] = [];
  const shrunk: string[] = [];
  for (const key of new Set([...Object.keys(found), ...Object.keys(inventory)])) {
    const now = found[key] ?? {};
    const was = inventory[key] ?? {};
    for (const file of new Set([...Object.keys(now), ...Object.keys(was)])) {
      const a = now[file] ?? 0;
      const b = was[file] ?? 0;
      if (a > b) grown.push(`${key}: ${file}: ${a} righe, nell'inventario ${b}`);
      if (a < b) shrunk.push(`${key}: ${file}: ${a} righe, nell'inventario ${b}`);
    }
  }
  return { grown: grown.sort(), shrunk: shrunk.sort() };
}

export const INVENTORY_FILE = join(import.meta.dirname, '..', 'inventario.json');

export function readInventory(file: string = INVENTORY_FILE): Inventory {
  return (JSON.parse(readFileSync(file, 'utf8')) as { pacchetti: Inventory }).pacchetti;
}
