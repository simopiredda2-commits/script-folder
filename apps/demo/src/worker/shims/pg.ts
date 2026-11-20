/**
 * Il driver `pg` di Node non serve nel browser (D221): il programma lo importa per i tipi e per
 * createPool, ma nella dimostrazione drizzle usa PGlite. Chi prova a usarlo riceve un errore.
 */
export class Pool {
  constructor() {
    throw new Error('Il driver pg non è disponibile nella dimostrazione: si usa PGlite');
  }
}
export class Client extends Pool {}
export const types = {
  builtins: { DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184, INTERVAL: 1186 },
  getTypeParser: () => (value: unknown) => value,
  setTypeParser: () => undefined,
};
export default { Pool, Client, types };
