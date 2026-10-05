// Gracefully end the isolated fixture after all browser test files finish.
export default async function teardown() {
  const port = process.env.E2E_MODEL_PORT || '4329';
  await fetch(`http://127.0.0.1:${port}/__e2e/shutdown`, { method: 'POST' });
}
