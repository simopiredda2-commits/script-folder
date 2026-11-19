import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type AuthService } from '../auth/service';
import { HttpError } from './errors';

export const SESSION_COOKIE = 'sessione';

const loginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  postazione: z.string().min(1).max(100),
});
const codeBody = z.object({ passaggio: z.string().min(1), codice: z.string().min(1) });
const unlockBody = z.object({ codice: z.string().min(1) });
/** Le password non si accorciano né si toccano: le lunghezze le controlla il servizio. */
const passwordBody = z
  .object({
    passwordAttuale: z.string().min(1).max(1024),
    nuovaPassword: z.string().max(1024),
  })
  .strict();

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  opts: { cookieSecure: boolean },
) {
  const setSession = (reply: FastifyReply, token: string, expiresAt: Date) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: opts.cookieSecure,
      path: '/',
      expires: expiresAt,
    });

  app.post('/api/accesso', { config: { public: true } }, async (req, reply) => {
    const body = loginBody.parse(req.body);
    // L'indirizzo della richiesta va nel registro dei tentativi falliti: la postazione la scrive
    // chi accede, l'indirizzo no (tappa 14). Con l'indirizzo contano anche le attese (D188).
    const r = await auth.login({
      username: body.username,
      password: body.password,
      workstation: body.postazione,
      address: req.ip,
    });
    if (!r.ok && r.retryAfterSeconds !== undefined) {
      // La provenienza aspetta: 429, con l'attesa anche nell'intestazione Retry-After (RFC 9110).
      reply.header('retry-after', String(r.retryAfterSeconds));
      throw new HttpError(429, r.message, { attesaSecondi: r.retryAfterSeconds });
    }
    if (!r.ok) throw new HttpError(401, r.message);
    if (r.step === 'second_factor')
      return { passo: 'secondo-fattore', passaggio: r.challengeToken };
    return {
      passo: 'attiva-secondo-fattore',
      passaggio: r.challengeToken,
      otpauth: r.otpauthUri,
      segreto: r.secret,
    };
  });

  app.post('/api/accesso/codice', { config: { public: true } }, async (req, reply) => {
    const body = codeBody.parse(req.body);
    const r = await auth.verifySecondFactor({
      challengeToken: body.passaggio,
      code: body.codice,
      address: req.ip,
    });
    if (!r.ok) throw new HttpError(401, r.message);
    setSession(reply, r.sessionToken, r.expiresAt);
    return { stato: 'ok', scadenza: r.expiresAt.toISOString() };
  });

  app.post('/api/accesso/sblocca', { config: { public: true } }, async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    const body = unlockBody.parse(req.body);
    if (!token || !(await auth.unlock(token, body.codice, req.ip))) {
      throw new HttpError(401, 'Codice non valido');
    }
    return { stato: 'ok' };
  });

  app.post('/api/uscita', { config: { public: true } }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await auth.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { stato: 'ok' };
  });

  // Cambio della propria password (tappa 14): per tutti, anche con la password temporanea.
  app.get('/api/profilo/password', (req) => ({
    lunghezzaMinima: PASSWORD_MIN_LENGTH,
    lunghezzaMassima: PASSWORD_MAX_LENGTH,
    obbligato: req.actor!.mustChangePassword,
  }));

  app.post('/api/profilo/password', async (req) => {
    const body = passwordBody.parse(req.body);
    const r = await auth.changePassword(req.actor!, {
      current: body.passwordAttuale,
      next: body.nuovaPassword,
      address: req.ip,
    });
    // Mai 401: per l'interfaccia vorrebbe dire «sessione finita».
    if (!r.ok) throw new HttpError(r.status, r.message);
    return { stato: 'ok', altreSessioniChiuse: r.otherSessionsClosed };
  });
}
