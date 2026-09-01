/**
 * netlify/functions/logout.js
 * Logout Endpoint (Task 3).
 * Clears the application session cookie.
 */

const { serializeCookie } = require('./utils/crypto');

exports.handler = async (event) => {
  const host = event.headers['x-forwarded-host'] || event.headers.host || 'localhost:8888';
  const proto = event.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');

  const clearCookie = serializeCookie('app_session', '', {
    maxAge: 0,
    httpOnly: true,
    secure: proto === 'https',
    sameSite: 'Lax',
    path: '/',
  });

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearCookie,
    },
    body: JSON.stringify({ success: true, message: 'Logged out successfully.' }),
  };
};
