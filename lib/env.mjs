// Reads .env (if there is one) into process.env. Values already set in the environment win.
import { existsSync } from 'node:fs';

export function loadEnv(file = new URL('../.env', import.meta.url)) {
  if (existsSync(file)) process.loadEnvFile(file);
}

export function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Put it in .env (see .env.example) or the environment.`);
  return v;
}
