import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/service';
import { HttpError } from './errors';

export const SESSION_COOKIE = 'sessione';

const loginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  postazione: z.string().min(1).max(100),
});
const codeBody = z.object({ passaggio: z.string().min(1), codice: z.string().min(1) });
const unlockBody = z.object({ password: z.string().min(1) });

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

  app.post('/api/accesso', { config: { public: true } }, async (req) => {
    const body = loginBody.parse(req.body);
    const r = await auth.login({
      username: body.username,
      password: body.password,
      workstation: body.postazione,
    });
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
    const r = await auth.verifySecondFactor({ challengeToken: body.passaggio, code: body.codice });
    if (!r.ok) throw new HttpError(401, r.message);
    setSession(reply, r.sessionToken, r.expiresAt);
    return { stato: 'ok', scadenza: r.expiresAt.toISOString() };
  });

  app.post('/api/accesso/sblocca', { config: { public: true } }, async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    const body = unlockBody.parse(req.body);
    if (!token || !(await auth.unlock(token, body.password))) {
      throw new HttpError(401, 'Password non valida');
    }
    return { stato: 'ok' };
  });

  app.post('/api/uscita', { config: { public: true } }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await auth.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { stato: 'ok' };
  });
}
