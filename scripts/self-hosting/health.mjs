// Local readiness only; no user identity, passkey, invitation or token is read.
try {
  const request = path => fetch('http://127.0.0.1:3000' + path, {signal: AbortSignal.timeout(3000)});
  const health = await request('/api/health');
  if (health.status !== 200 || (await health.json()).writable !== true) throw Error('storage');
  const config = await request('/api/config');
  const body = await config.json();
  if (config.status !== 200 || body.allow_guest !== false) throw Error('account-policy');
  const mode = process.env.OPENGYM_INSTANCE_MODE;
  if (mode) {
    const signup = process.env.OPENGYM_SIGNUP_POLICY;
    if (!['127.0.0.1', '0.0.0.0'].includes(process.env.OPENGYM_LISTEN_HOST) ||
        (process.env.OPENGYM_SELF_HOSTED_CATALOG === '1' && process.env.OPENGYM_CATALOG_LISTEN_HOST !== process.env.OPENGYM_LISTEN_HOST)) throw Error('listen-policy');
    if (body.instance_mode !== mode || body.signup_policy !== signup ||
        body.max_users !== Number(process.env.OPENGYM_MAX_USERS) || typeof body.registration_open !== 'boolean' ||
        typeof body.invite_only !== 'boolean' ||
        ((mode === 'personal' || signup === 'invite') && body.invite_only !== true)) throw Error('account-policy');
  } else if (body.invite_only !== true) throw Error('account-policy');
  // A public OFF relay answers 200 here: require the authenticated local mode.
  if (!mode || process.env.NUTRITION_LOCAL_CATALOG === '1') {
    const catalog = await request('/api/nutrition/catalog/capabilities');
    if (catalog.status !== 401) throw Error('catalog-authentication');
  }
} catch {
  process.exitCode = 1;
}
