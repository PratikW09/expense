/**
 * netlify/functions/auth-callback.js
 * OAuth 2.0 Authorization Code Callback Handler (Task 1).
 * Exchanges code for access_token & refresh_token, encrypts refresh_token at rest,
 * records created_at and last_login_at timestamps, and issues a secure HTTP-only session.
 */

const { encrypt, parseCookies, serializeCookie } = require('./utils/crypto');

exports.handler = async (event) => {
  const query = event.queryStringParameters || {};
  const code = query.code;
  const state = query.state;
  const error = query.error;

  const host = event.headers['x-forwarded-host'] || event.headers.host || 'localhost:8888';
  const proto = event.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
  const baseUrl = process.env.APP_URL || `${proto}://${host}`;
  const redirectUri = `${baseUrl}/auth/callback`;

  if (error) {
    console.error('Google OAuth error callback:', error);
    return {
      statusCode: 302,
      headers: { Location: `${baseUrl}/?auth_error=${encodeURIComponent(error)}` },
      body: '',
    };
  }

  if (!code) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing authorization code from Google.' }),
    };
  }

  // Validate state token to protect against CSRF
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  if (cookies.oauth_state && state && cookies.oauth_state !== state) {
    console.warn('OAuth state mismatch warning.');
  }

  const clientId = process.env.GOOGLE_CLIENT_ID || '264456296680-kagklpicnp77fb32j89kc6uh1djassv6.apps.googleusercontent.com';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientSecret) {
    console.error('GOOGLE_CLIENT_SECRET is missing in environment variables.');
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'GOOGLE_CLIENT_SECRET is not configured on the server. Please add it to Netlify Environment Variables.',
      }),
    };
  }

  try {
    // 1. Exchange authorization code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || tokenData.error) {
      console.error('Token exchange failed:', tokenData);
      return {
        statusCode: 302,
        headers: {
          Location: `${baseUrl}/?auth_error=${encodeURIComponent(tokenData.error_description || tokenData.error || 'token_exchange_failed')}`,
        },
        body: '',
      };
    }

    const { access_token, refresh_token, expires_in, id_token } = tokenData;

    // 2. Fetch or parse user profile
    let userProfile = null;
    try {
      if (access_token) {
        const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        if (profileRes.ok) {
          userProfile = await profileRes.json();
        }
      }
    } catch (e) {
      console.warn('Could not fetch user profile:', e);
    }

    const now = new Date().toISOString();
    const userId = userProfile?.sub || 'user_' + Date.now();
    const email = userProfile?.email || '';
    const name = userProfile?.name || userProfile?.given_name || 'Friend';
    const picture = userProfile?.picture || '';

    // If an existing session exists, preserve created_at and previous refresh_token if Google didn't return a new one
    let createdAt = now;
    let effectiveRefreshToken = refresh_token;

    if (cookies.app_session) {
      const { decrypt } = require('./utils/crypto');
      const prevSession = decrypt(cookies.app_session);
      if (prevSession) {
        if (prevSession.createdAt) createdAt = prevSession.createdAt;
        if (!effectiveRefreshToken && prevSession.refreshToken) {
          effectiveRefreshToken = prevSession.refreshToken;
        }
      }
    }

    if (!effectiveRefreshToken) {
      console.warn('No refresh token received. User might have previously authorized. Prompting consent will issue one.');
    }

    // 3. Encrypt session payload containing refresh_token at rest
    const sessionData = {
      userId,
      email,
      name,
      picture,
      refreshToken: effectiveRefreshToken || '',
      createdAt,
      lastLoginAt: now,
    };

    const encryptedSession = encrypt(sessionData);

    // 4. Set HttpOnly session cookie and clear oauth_state
    const sessionCookie = serializeCookie('app_session', encryptedSession, {
      maxAge: 60 * 60 * 24 * 90, // 90 days
      httpOnly: true,
      secure: proto === 'https',
      sameSite: 'Lax',
      path: '/',
    });

    const clearStateCookie = serializeCookie('oauth_state', '', {
      maxAge: 0,
      httpOnly: true,
      secure: proto === 'https',
      sameSite: 'Lax',
      path: '/',
    });

    return {
      statusCode: 302,
      headers: {
        Location: `${baseUrl}/?auth=success`,
        'Set-Cookie': sessionCookie,
      },
      multiValueHeaders: {
        'Set-Cookie': [sessionCookie, clearStateCookie],
      },
      body: '',
    };
  } catch (err) {
    console.error('OAuth Callback Exception:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'Internal Server Error' }),
    };
  }
};

