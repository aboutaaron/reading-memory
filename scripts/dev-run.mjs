#!/usr/bin/env node
import { runCli } from './lib/dev-manager.mjs';
try { await runCli(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
