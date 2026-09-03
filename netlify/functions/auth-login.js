/**
 * netlify/functions/auth-login.js
 * Initiates Google OAuth 2.0 Authorization Code Flow.
 * Redirects user to Google with access_type=offline and prompt=consent to ensure refresh token issuance.
 */

const crypto = require('crypto');
const { serializeCookie } = require('./utils/crypto');

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
].join(' ');

exports.handler = async (event) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '264456296680-7j2iu4c26sf4req03ms0hliecu78fn4g.apps.googleusercontent.com';
  
  if (!clientId) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'GOOGLE_CLIENT_ID is not configured.' }),
    };
  }

  // Determine redirect URI
  const host = event.headers['x-forwarded-host'] || event.headers.host || 'localhost:8888';
  const proto = event.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
  const baseUrl = process.env.APP_URL || `${proto}://${host}`;
  const redirectUri = `${baseUrl}/auth/callback`;

  // Generate cryptographically secure state token to prevent CSRF
  const state = crypto.randomBytes(24).toString('base64url');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent'); // Required to issue a refresh token
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('include_granted_scopes', 'true');

  const stateCookie = serializeCookie('oauth_state', state, {
    maxAge: 60 * 10, // 10 minutes
    httpOnly: true,
    secure: proto === 'https',
    sameSite: 'Lax',
    path: '/',
  });

  return {
    statusCode: 302,
    headers: {
      Location: authUrl.toString(),
      'Set-Cookie': stateCookie,
    },
    body: '',
  };
};

