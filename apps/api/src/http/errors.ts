/** Errore con codice HTTP e messaggio in chiaro per l'interfaccia. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
