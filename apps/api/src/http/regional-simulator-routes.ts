import type { SimulatedRegionalAuthorization } from '@mmg/integrations';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from './errors';

/**
 * Pagina regionale simulata dell'accesso con SPID o CIE (D109). Esiste solo quando l'accesso
 * regionale è il simulatore: al suo posto, nel servizio vero, c'è la pagina della Regione. Non
 * imita il sito della Regione. Come la pagina vera, rimanda solo agli indirizzi di ritorno
 * registrati, quelli del programma: mai a un indirizzo scritto nella richiesta (D193).
 */
const authorizeQuery = z.object({
  client_id: z.string().min(1).max(200),
  response_type: z.literal('code'),
  redirect_uri: z.string().startsWith('/').max(500),
  scope: z.string().min(1).max(200),
  state: z.string().min(1).max(500),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  login_hint: z.string().max(16).optional(),
});

const html = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function page(q: z.infer<typeof authorizeQuery>): string {
  const hidden = Object.entries(q)
    .filter(([k]) => k !== 'response_type' && k !== 'code_challenge_method')
    .map(([k, v]) => `<input type="hidden" name="${html(k)}" value="${html(String(v))}">`)
    .join('');
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accesso regionale simulato</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; background: #f5f6fa; color: #0e1435; }
main { max-width: 40rem; margin: 2rem auto; padding: 1.5rem; background: #fff; border: 1px solid #7a809c; border-radius: 8px; }
h1 { font-size: 1.5rem; margin-top: 0; }
.azioni { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.5rem; }
button { min-height: 44px; min-width: 44px; padding: 0.5rem 1rem; font: inherit; border-radius: 8px; border: 1px solid #1b237a; background: #fff; color: #1b237a; cursor: pointer; }
button.primario { background: #1b237a; color: #fff; }
button:focus-visible { outline: 3px solid #4d6bfe; outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>Accesso regionale simulato</h1>
<p>Questa pagina sostituisce, solo in prova, la pagina della Regione dove il medico entra con SPID o CIE e autorizza il programma a mandare le ricette. Nessun dato esce dal programma.</p>
<p>Chi entra: <strong>${html(q.login_hint ?? 'non indicato')}</strong></p>
<p>Permessi chiesti: <strong>${html(q.scope)}</strong></p>
<form method="get" action="/api/simulatore/accesso-regionale/esito">
${hidden}
<div class="azioni">
<button class="primario" type="submit" name="azione" value="spid">Entra con SPID (simulato)</button>
<button type="submit" name="azione" value="cie">Entra con CIE (simulato)</button>
<button type="submit" name="azione" value="annulla">Annulla</button>
</div>
</form>
</main>
</body>
</html>`;
}

/** Un indirizzo di ritorno non registrato non si usa: niente rimando fuori dal programma. */
function registered(returns: readonly string[], redirectUri: string) {
  if (!returns.includes(redirectUri))
    throw new HttpError(400, 'Indirizzo di ritorno non registrato');
}

export function registerRegionalSimulatorRoutes(
  app: FastifyInstance,
  simulator: SimulatedRegionalAuthorization,
  /** Gli indirizzi di ritorno registrati: solo quelli del programma. */
  returns: readonly string[],
) {
  const pub = { config: { public: true } };

  app.get('/api/simulatore/accesso-regionale', pub, async (req, reply) => {
    const q = authorizeQuery.parse(req.query);
    registered(returns, q.redirect_uri);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return reply.send(page(q));
  });

  app.get('/api/simulatore/accesso-regionale/esito', pub, async (req, reply) => {
    const q = authorizeQuery
      .omit({ response_type: true, code_challenge_method: true })
      .extend({ azione: z.enum(['spid', 'cie', 'annulla']) })
      .parse(req.query);
    registered(returns, q.redirect_uri);
    const back = new URLSearchParams({ state: q.state });
    if (q.azione === 'annulla') {
      back.set('error', 'access_denied');
      back.set('error_description', 'Accesso annullato dall’utente');
    } else {
      back.set(
        'code',
        simulator.approve({
          clientId: q.client_id,
          redirectUri: q.redirect_uri,
          scope: q.scope.split(' '),
          codeChallenge: q.code_challenge,
          fiscalCode: q.login_hint ?? '',
        }),
      );
    }
    return reply.redirect(`${q.redirect_uri}?${back.toString()}`);
  });
}
