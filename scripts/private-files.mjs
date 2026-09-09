import { existsSync } from 'node:fs';

// npm prepare provides compiled application code for installed packages, where
// Node forbids native TypeScript loading. An unbuilt checkout runs the same
// policy directly using Node >=22.19's built-in type stripping, without tsx.
const compiled = new URL('../dist/src/filesystem/private-files.js', import.meta.url);
const policy = await import(existsSync(compiled) ? compiled.href : new URL('../src/filesystem/private-files.ts', import.meta.url).href);

export const { assertAbsent, privateDatabasePath, privateDirectory, privateFile } = policy;
