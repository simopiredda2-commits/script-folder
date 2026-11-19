import type { SimulatedDigitalIdentity } from '@mmg/integrations';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Pagina simulata dell'accesso con SPID o CIE al programma (D189). Esiste solo quando il gestore
 * dell'identità è il simulatore: chi la usa scrive il codice fiscale di chi «entra». Non imita le
 * pagine di SPID o di CIE; accetta solo indirizzi di ritorno interni al programma.
 */
const authorizeQuery = z.object({
  client_id: z.string().min(1).max(200),
  response_type: z.literal('code'),
  redirect_uri: z.string().startsWith('/').max(500),
  state: z.string().min(1).max(500),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
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
<title>Accesso con SPID o CIE simulato</title>
<style>
body { font-family: system-ui, sans-serif; margin: 0; background: #f5f6fa; color: #0e1435; }
main { max-width: 40rem; margin: 2rem auto; padding: 1.5rem; background: #fff; border: 1px solid #7a809c; border-radius: 8px; }
h1 { font-size: 1.5rem; margin-top: 0; }
label { display: block; font-weight: 600; margin-top: 1rem; }
input[type=text] { font: inherit; min-height: 44px; padding: 0 0.5rem; width: 100%; max-width: 20rem; box-sizing: border-box; border: 1px solid #7a809c; border-radius: 6px; }
.azioni { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 1.5rem; }
button { min-height: 44px; min-width: 44px; padding: 0.5rem 1rem; font: inherit; border-radius: 8px; border: 1px solid #1b237a; background: #fff; color: #1b237a; cursor: pointer; }
button.primario { background: #1b237a; color: #fff; }
button:focus-visible, input:focus-visible { outline: 3px solid #4d6bfe; outline-offset: 2px; }
</style>
</head>
<body>
<main>
<h1>Accesso con SPID o CIE simulato</h1>
<p>Questa pagina sostituisce, solo in prova, la pagina dove si entra con SPID o con la carta d’identità elettronica. Qui chiunque può dire di essere chiunque: per questo, in produzione, il programma non la usa. Nessun dato esce dal programma.</p>
<form method="get" action="/api/simulatore/identita-digitale/esito">
${hidden}
<label for="codice-fiscale">Codice fiscale di chi entra</label>
<input type="text" id="codice-fiscale" name="codice_fiscale" autocomplete="off" maxlength="16" pattern="[A-Za-z0-9]{16}">
<div class="azioni">
<button class="primario" type="submit" name="azione" value="spid">Entra con SPID (simulato)</button>
<button type="submit" name="azione" value="cie">Entra con CIE (simulata)</button>
<button type="submit" name="azione" value="annulla" formnovalidate>Annulla</button>
</div>
</form>
</main>
</body>
</html>`;
}

export function registerIdentitySimulatorRoutes(
  app: FastifyInstance,
  simulator: SimulatedDigitalIdentity,
) {
  const pub = { config: { public: true } };

  app.get('/api/simulatore/identita-digitale', pub, async (req, reply) => {
    const q = authorizeQuery.parse(req.query);
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('cache-control', 'no-store');
    return reply.send(page(q));
  });

  app.get('/api/simulatore/identita-digitale/esito', pub, async (req, reply) => {
    const q = authorizeQuery
      .omit({ response_type: true, code_challenge_method: true })
      .extend({
        azione: z.enum(['spid', 'cie', 'annulla']),
        codice_fiscale: z.string().max(16).optional(),
      })
      .parse(req.query);
    const back = new URLSearchParams({ state: q.state });
    if (q.azione === 'annulla' || !q.codice_fiscale?.trim()) {
      back.set('error', 'access_denied');
      back.set('error_description', 'Accesso annullato dall’utente');
    } else {
      back.set(
        'code',
        simulator.approve({
          clientId: q.client_id,
          redirectUri: q.redirect_uri,
          codeChallenge: q.code_challenge,
          fiscalCode: q.codice_fiscale,
          method: q.azione,
        }),
      );
    }
    return reply.redirect(`${q.redirect_uri}?${back.toString()}`);
  });
}
