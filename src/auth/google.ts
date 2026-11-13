import { createRemoteJWKSet, jwtVerify } from 'jose';

import { ApiError } from '../errors.js';

export type GoogleIdentity = { sub: string; email: string | null; emailVerified: boolean };
export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

const invalid = () => new ApiError(400, 'SOCIAL_TOKEN_INVALID', 'Google token rejected');

/** Verifies signature (Google JWKS), issuer, audience (our web client IDs) and expiry. */
export function googleVerifier(clientIds: string[]): GoogleVerifier {
  const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
  return async (idToken) => {
    if (clientIds.length === 0) throw invalid();
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, jwks, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: clientIds,
        algorithms: ['RS256'],
      }));
    } catch {
      throw invalid();
    }
    if (typeof payload.sub !== 'string' || !payload.sub) throw invalid();
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    const emailVerified = payload.email_verified === true;
    if (!email || !emailVerified)
      throw new ApiError(400, 'SOCIAL_EMAIL_UNVERIFIED', 'Google email not verified');
    return { sub: payload.sub, email, emailVerified };
  };
}
