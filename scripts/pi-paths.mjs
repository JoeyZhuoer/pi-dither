import { accessSync, constants, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';

export function findPi() {
  const candidates = [];
  if (process.env.PI_WORKSTATION_PI_ROOT) {
    candidates.push(resolve(process.env.PI_WORKSTATION_PI_ROOT, 'package.json'));
  } else {
    try {
      candidates.push(createRequire(import.meta.url).resolve('@earendil-works/pi-coding-agent'));
    } catch { /* Pi can provide its own extension dependencies without a local install. */ }
    for (const directory of [dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter)]) {
      if (directory) candidates.push(join(directory, 'pi'));
    }
  }

  for (const candidate of candidates) {
    let current;
    try { current = dirname(realpathSync(candidate)); } catch { continue; }
    while (true) {
      try {
        const metadata = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8'));
        if (metadata.name === '@earendil-works/pi-coding-agent') {
          const cli = resolve(current, metadata.bin.pi);
          accessSync(cli, constants.R_OK);
          return { root: current, cli, version: metadata.version };
        }
      } catch { /* Continue up to the package root. */ }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error('Core Pi was not found. Put pi on PATH or set PI_WORKSTATION_PI_ROOT to its package directory.');
}
