import type { NextFunction, Request, Response } from 'express';
import * as bcrypt from 'bcryptjs';

/**
 * TEMPORARY single-admin HTTP Basic Auth for /admin/*.
 *
 * Credentials come from env: ADMIN_USER + ADMIN_PASSWORD_HASH (a bcrypt hash).
 * The submitted password is compared with bcrypt.compare — the plaintext is
 * never stored or logged.
 *
 * ⚠️ THIS IS A STOPGAP for a single operator (one hotel today). When a SECOND
 * client is onboarded, replace this with a real `admins` table (per-tenant,
 * hashed passwords in the DB — NOT a shared env credential). See [[project]].
 */
export function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const expectedUser = process.env.ADMIN_USER;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;

  const deny = () => {
    res
      .set('WWW-Authenticate', 'Basic realm="admin", charset="UTF-8"')
      .status(401)
      .send('Unauthorized');
  };

  if (!expectedUser || !passwordHash) {
    // Misconfigured server: fail closed.
    deny();
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) {
    deny();
    return;
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  const user = sep === -1 ? decoded : decoded.slice(0, sep);
  const password = sep === -1 ? '' : decoded.slice(sep + 1);

  if (user !== expectedUser) {
    deny();
    return;
  }

  bcrypt
    .compare(password, passwordHash)
    .then((ok) => (ok ? next() : deny()))
    .catch(() => deny());
}
