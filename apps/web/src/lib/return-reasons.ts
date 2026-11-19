/**
 * Testi dei ritorni da SPID o CIE e dalla pagina regionale (D193). Nell'indirizzo del ritorno c'è
 * solo un codice: il testo lo scrive il programma, perché un testo nell'indirizzo lo potrebbe
 * scrivere chiunque, in un collegamento al dominio vero. Un codice sconosciuto dà un testo generico.
 */
const IDENTITY: Readonly<Record<string, string>> = {
  'non-collegato':
    'Il ripristino con SPID o CIE non è ancora collegato al servizio vero: rivolgiti a chi gestisce il servizio',
  'non-possibile':
    'Con questa identità il ripristino non è possibile: controlla il nome utente, oppure rivolgiti a chi gestisce il servizio',
  'non-riconosciuta': 'Richiesta non riconosciuta o scaduta: ricomincia',
  annullato: 'Accesso con SPID o CIE annullato o negato',
  'errore-gestore': 'Il gestore dell’identità ha risposto con un errore: ricomincia',
  'senza-codice': 'Ritorno senza codice: ricomincia',
  'non-raggiungibile': 'Gestore dell’identità non raggiungibile: riprova tra poco',
  'non-riconosciuto': 'Il gestore dell’identità non ha riconosciuto l’accesso: ricomincia',
  sessione: 'Accesso al programma scaduto o bloccato: entra di nuovo e ricomincia',
};

const REGIONAL: Readonly<Record<string, string>> = {
  'non-riconosciuta': 'richiesta di accesso non riconosciuta o scaduta, riprova',
  annullato: 'accesso regionale annullato o negato',
  'errore-regione': 'la Regione ha risposto con un errore, riprova',
  'senza-codice': 'ritorno senza codice di autorizzazione, riprova',
  'non-raggiungibile': 'servizio regionale non raggiungibile, riprova tra poco',
  'token-negato': 'la Regione non ha rilasciato il token, riprova',
  'identita-diversa':
    'l’accesso regionale è stato fatto con un’identità diversa da quella del medico collegato',
  'senza-profilo':
    'la Regione non ha concesso il profilo di prescrizione, va abilitato nel configuratore regionale',
  sessione: 'accesso al programma scaduto o bloccato, entra di nuovo e ripeti l’accesso regionale',
};

const pick = (texts: Readonly<Record<string, string>>, code: string | null, fallback: string) =>
  code !== null && Object.hasOwn(texts, code) ? texts[code]! : fallback;

/** Il testo di un ritorno non riuscito da SPID o CIE (ripristino e collegamento). */
export const identityReturnText = (code: string | null, fallback = 'Non riuscito: ricomincia') =>
  pick(IDENTITY, code, fallback);

/** Il motivo di un accesso regionale non riuscito, da mettere dopo «non riuscito:». */
export const regionalReturnText = (code: string | null) =>
  pick(REGIONAL, code, 'motivo non indicato');
