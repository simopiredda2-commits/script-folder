import { parseArgs } from 'node:util';
import { generatePatients } from './generator';

const { values } = parseArgs({
  // pnpm passa anche il separatore «--»: si scarta.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    seed: { type: 'string', default: '1' },
    count: { type: 'string', default: '20' },
  },
});

const patients = generatePatients({ seed: values.seed, count: Number(values.count) });
process.stdout.write(`${JSON.stringify(patients, null, 2)}\n`);
