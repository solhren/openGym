// Local readiness only; no user identity, passkey, invitation or token is read.
try {
  const request = path => fetch('http://127.0.0.1:3000' + path, {signal: AbortSignal.timeout(3000)});
  const health = await request('/api/health');
  if (health.status !== 200 || (await health.json()).writable !== true) throw Error('storage');
  const config = await request('/api/config');
  const body = await config.json();
  if (config.status !== 200 || body.allow_guest !== false || body.invite_only !== true) throw Error('account-policy');
  // A public OFF relay answers 200 here: require the authenticated local mode.
  const catalog = await request('/api/nutrition/catalog/capabilities');
  if (catalog.status !== 401) throw Error('catalog-authentication');
} catch {
  process.exitCode = 1;
}
