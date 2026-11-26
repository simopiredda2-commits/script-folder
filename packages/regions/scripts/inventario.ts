import { existsSync, writeFileSync } from 'node:fs';
import {
  compareInventory,
  countRegionalLines,
  INVENTORY_FILE,
  readInventory,
  type Inventory,
} from '../test/nomi-regionali';

/**
 * Aggiorna l'inventario dei nomi regionali fuori dai pacchetti (D292) dopo uno spostamento: le
 * righe calano, i file spostati escono. Non lo fa crescere: con righe in più si ferma e le elenca,
 * perché il codice nuovo regionale va nelle cartelle del pacchetto. Solo per decisione presa (e
 * scritta in docs/decisioni.md) si fa crescere con `--anche-in-piu`.
 */
const found = countRegionalLines();
const before: Inventory = existsSync(INVENTORY_FILE) ? readInventory() : {};
const { grown, shrunk } = compareInventory(found, before);
if (grown.length && existsSync(INVENTORY_FILE) && !process.argv.includes('--anche-in-piu')) {
  console.error(
    `Righe regionali nuove fuori dai pacchetti: vanno nelle cartelle del pacchetto.\n${grown.join('\n')}`,
  );
  process.exit(1);
}
const sorted: Inventory = Object.fromEntries(
  Object.entries(found).map(([k, files]) => [
    k,
    Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  ]),
);
writeFileSync(
  INVENTORY_FILE,
  `${JSON.stringify(
    {
      nota: 'File fuori dalle cartelle dei pacchetti regionali che nominano ancora una regione, con il numero di righe (D288, D292). Si accorcia a ogni spostamento: si aggiorna con «pnpm --filter @mmg/regions inventario», che non lo fa crescere.',
      pacchetti: sorted,
    },
    null,
    2,
  )}\n`,
);
const total = Object.values(sorted).reduce((n, files) => n + Object.keys(files).length, 0);
console.log(`Inventario aggiornato: ${total} file; ${shrunk.length} con meno righe di prima.`);
