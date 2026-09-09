// tsx uses module.register(), which emits DEP0205 starting in Node 26.
// Recognize only Node's complete default warning, never arbitrary warnings or
// lines that merely contain the code. Leave runtime warning emission enabled.
// https://nodejs.org/api/deprecations.html#dep0205-moduleregister
export function isLoaderDeprecationWarning(output: string): boolean {
  return /^\(node:\d+\) \[DEP0205\] DeprecationWarning: `module\.register\(\)` is deprecated\. Use `module\.registerHooks\(\)` instead\.(?:\n\(Use `node --trace-deprecation \.\.\.` to show where the warning was created\))?\n?$/.test(output);
}
