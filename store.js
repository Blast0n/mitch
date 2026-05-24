import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULTS = {
  accounts: [],
  proxies: [],
  settings: {
    channel: '',
    word: '',
    accountsPerProxy: 5,
    spreadSeconds: 0,
    concurrency: 5
  }
};

export class Store {
  constructor(dir) { this.dir = dir; }

  async read(name) {
    const file = path.join(this.dir, `${name}.json`);
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return structuredClone(DEFAULTS[name]);
      if (err instanceof SyntaxError) {
        const e = new Error(`Corrupt JSON in ${name}.json: ${err.message}`);
        e.code = 'STORE_CORRUPT';
        throw e;
      }
      throw err;
    }
  }

  async write(name, data) {
    const file = path.join(this.dir, `${name}.json`);
    const tmp = file + '.tmp';
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
  }
}
