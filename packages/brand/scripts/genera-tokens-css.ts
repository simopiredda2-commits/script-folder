import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderTokensCss } from '../tokens';

const target = join(import.meta.dirname, '..', 'tokens.css');
writeFileSync(target, renderTokensCss());
console.log(`Scritto ${target}`);
