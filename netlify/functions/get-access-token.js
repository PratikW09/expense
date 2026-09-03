/**
 * netlify/functions/get-access-token.js
 * Token Refresh Endpoint (Task 2).
 * Reads the encrypted session cookie, calls Google's token endpoint to mint a fresh access_token,
 * and returns the access_token with expiry and user info.
 * Never exposes the refresh token to the browser.
 * Distinctly reports TOKEN_REVOKED on invalid_grant.
 */

const { decrypt, parseCookies } = require('./utils/crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || '');
  const sessionToken = cookies.app_session;

  if (!sessionToken) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'UNAUTHORIZED', message: 'No active session. Please log in.' }),
    };
  }

  const session = decrypt(sessionToken);

  if (!session || !session.refreshToken) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'TOKEN_REQUIRED',
        message: 'No refresh token found in session. Please re-authenticate.',
      }),
    };
  }

  const clientId = process.env.GOOGLE_CLIENT_ID || '264456296680-kagklpicnp77fb32j89kc6uh1djassv6.apps.googleusercontent.com';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientSecret) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'SERVER_CONFIG_ERROR',
        message: 'GOOGLE_CLIENT_SECRET is missing in environment variables.',
      }),
    };
  }

  try {
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: session.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    const refreshData = await refreshRes.json();

    // Check for revoked or invalid refresh token
    if (!refreshRes.ok || refreshData.error) {
      console.warn('Google refresh token rejection:', refreshData);
      
      const isRevoked = refreshData.error === 'invalid_grant' || String(refreshData.error_description || '').toLowerCase().includes('revoked');

      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: isRevoked ? 'TOKEN_REVOKED' : 'REFRESH_FAILED',
          message: isRevoked
            ? 'Google access has been revoked or expired. Please sign in again.'
            : (refreshData.error_description || refreshData.error || 'Failed to refresh token'),
        }),
      };
    }

    const { access_token, expires_in } = refreshData;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      },
      body: JSON.stringify({
        accessToken: access_token,
        expiresIn: expires_in || 3600,
        userProfile: {
          userId: session.userId,
          email: session.email,
          name: session.name,
          picture: session.picture,
        },
      }),
    };
  } catch (err) {
    console.error('get-access-token exception:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'INTERNAL_ERROR', message: err.message }),
    };
  }
};

