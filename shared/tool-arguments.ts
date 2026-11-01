/** Empty argument payloads mean no arguments; non-empty JSON retains its types
 * so each caller can reject values that cannot be used as a parameter object.
 */
export function parseToolArguments(value: unknown): unknown {
  if (value === undefined || value === null || typeof value === 'string' && !value.trim()) return {};
  return typeof value === 'string' ? JSON.parse(value) ?? {} : value;
}
