// One-time helper: obtain a Google OAuth refresh token for the rental calendar.
// Usage: node worker/google-oauth-token.mjs <CLIENT_ID> <CLIENT_SECRET>
// 1) Google Cloud → APIs & Services → Credentials → Create credentials → OAuth client ID → "Desktop app".
//    (OAuth consent screen: User type "Internal" if Workspace — then the refresh token never expires.)
// 2) Run this script, open the printed URL, sign in with the SHOP Google account, paste the code back.
// 3) Put the printed values into the worker: npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID / _SECRET / _REFRESH_TOKEN
import http from 'node:http';
import { URL } from 'node:url';
const [id, secret] = process.argv.slice(2);
if (!id || !secret) { console.error('usage: node google-oauth-token.mjs CLIENT_ID CLIENT_SECRET'); process.exit(1); }
const redirect = 'http://127.0.0.1:53682/';
const scope = 'https://www.googleapis.com/auth/calendar.events';
const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
auth.search = new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code', scope, access_type: 'offline', prompt: 'consent' }).toString();
console.log('\nOpen this URL in the browser (shop Google account):\n\n' + auth + '\n');
http.createServer(async (req, res) => {
  const code = new URL(req.url, redirect).searchParams.get('code');
  if (!code) { res.end('no code'); return; }
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
  const j = await r.json();
  res.end('Done — you can close this tab.');
  console.log('\nGOOGLE_OAUTH_CLIENT_ID=' + id + '\nGOOGLE_OAUTH_CLIENT_SECRET=' + secret + '\nGOOGLE_OAUTH_REFRESH_TOKEN=' + (j.refresh_token || '(none — re-run with a fresh consent)') + '\n');
  process.exit(0);
}).listen(53682);
