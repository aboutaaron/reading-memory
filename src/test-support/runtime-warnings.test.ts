import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoaderDeprecationWarning } from './runtime-warnings.js';

test('runtime warning exception accepts only the complete known loader diagnostic', () => {
  const warning = '(node:123) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.';
  const hint = '\n(Use `node --trace-deprecation ...` to show where the warning was created)';
  for (const output of [warning, warning + '\n', warning + hint, warning + hint + '\n']) {
    assert.equal(isLoaderDeprecationWarning(output), true);
  }
  for (const output of ['', 'fixture-secret', '[DEP0205] private source',
    warning.replace('DEP0205', 'DEP9999'), warning + '\nBearer fixture-secret',
    'private source\n' + warning, warning + hint + '\nprivate query']) {
    assert.equal(isLoaderDeprecationWarning(output), false, output);
  }
});
