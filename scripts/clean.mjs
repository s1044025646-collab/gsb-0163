// Removes only this project's local data/temp directory (.data).
import { rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = process.cwd();
const target = process.env.DOUBLE_SAMPLING_DATA
  ? resolve(process.env.DOUBLE_SAMPLING_DATA)
  : join(root, '.data');

if (!target.startsWith(root)) {
  console.error(`refusing to clean outside project: ${target}`);
  process.exit(1);
}
if (existsSync(target)) {
  rmSync(target, { recursive: true, force: true });
  console.log(`removed ${target}`);
} else {
  console.log('nothing to clean');
}
