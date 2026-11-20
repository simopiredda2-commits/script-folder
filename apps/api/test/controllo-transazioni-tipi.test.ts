import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Lettura dei tipi del servizio (D228). Dentro il callback di una transazione (`withActor`,
 * `db.transaction`) il servizio lavora con `tx`. Qui si legge con il compilatore tutto `src/` e si
 * cerca dentro quei callback:
 *
 * - un valore di tipo `Database` (o `Database | Tx`): per esempio `createPatient(db, …)`;
 * - una chiamata a un servizio fatto come classe che tiene un `Database`, come `ReferenceData`;
 * - una chiamata a una funzione del servizio che usa un `Database` preso da fuori, per esempio
 *   dall'ambiente delle rotte, anche attraverso altre funzioni.
 *
 * Guarda anche i percorsi che le prove non percorrono, e completa il controllo che gira nelle prove
 * (transaction-guard.ts). Non segue i servizi fatti di funzioni che tengono `db` dentro di sé
 * (`createAuraService({ db })`): quelli li vede il controllo nelle prove, dove passano.
 */

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src') + sep;

/** Uscite volute, `file:riga` → motivo. Oggi nessuna. */
const ALLOWED: Record<string, string> = {};

export interface Finding {
  where: string;
  kind: string;
  text: string;
  opened: string;
}

const MAX_DEPTH = 4;

export function findDatabaseInsideTransactions(): Finding[] {
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const program = ts.createProgram(
    parsed.fileNames.filter((f) => f.startsWith(SRC)),
    parsed.options,
  );
  const checker = program.getTypeChecker();
  const at = (node: ts.Node) => {
    const sf = node.getSourceFile();
    return `${relative(ROOT, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  };

  /** `db` per il tipo `Database`, `union` per `Database | Tx`, altrimenti niente. */
  const databaseKind = (t: ts.Type): 'db' | 'union' | null => {
    if (t.isUnion()) return t.types.some((x) => databaseKind(x) === 'db') ? 'union' : null;
    return /^(Database|NodePgDatabase<.*>)$/.test(checker.typeToString(t)) ? 'db' : null;
  };

  /** Il tipo è un'istanza di classe con un campo `Database` (per esempio `ReferenceData`). */
  const holdsDatabase = (t: ts.Type): boolean =>
    checker
      .getNonNullableType(t)
      .getProperties()
      .some((p) => {
        const d = p.valueDeclaration;
        if (!d) return false;
        const classMember =
          ts.isPropertyDeclaration(d) ||
          (ts.isParameter(d) && ts.isConstructorDeclaration(d.parent));
        return classMember && databaseKind(checker.getTypeOfSymbolAtLocation(p, d)) === 'db';
      });

  /** La dichiarazione della funzione chiamata, se è nel servizio. */
  const calledFunction = (call: ts.CallExpression) => calledFunctionOf(call.expression);

  /** La funzione usa un `Database` preso da fuori (ambiente o modulo), anche attraverso altre. */
  const usesOuterDatabase = (
    fn: ts.FunctionLikeDeclaration,
    depth: number,
    seen: Set<ts.Node>,
  ): boolean => {
    if (!fn.body || seen.has(fn) || depth > MAX_DEPTH) return false;
    seen.add(fn);
    let found = false;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(n) && !isDeclarationName(n)) {
        const symbol = checker.getSymbolAtLocation(n);
        const decl = symbol?.valueDeclaration;
        const outside = decl && (decl.getSourceFile() !== fn.getSourceFile() || !within(decl, fn));
        if (outside && databaseKind(checker.getTypeAtLocation(n))) {
          found = true;
          return;
        }
      }
      if (ts.isCallExpression(n)) {
        const inner = calledFunction(n);
        if (inner && usesOuterDatabase(inner, depth + 1, seen)) {
          found = true;
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
    return found;
  };

  const findings: Finding[] = [];
  const inspect = (body: ts.Node, opened: string) => {
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n) && !isDeclarationName(n)) {
        const parent = n.parent;
        const whole = ts.isPropertyAccessExpression(parent) && parent.name === n ? parent : n;
        const kind = databaseKind(checker.getTypeAtLocation(whole));
        if (kind)
          findings.push({
            where: at(n),
            kind: kind === 'db' ? 'Database' : 'Database o Tx',
            text: whole.getText(),
            opened,
          });
      }
      if (ts.isCallExpression(n)) {
        if (
          ts.isPropertyAccessExpression(n.expression) &&
          holdsDatabase(checker.getTypeAtLocation(n.expression.expression))
        )
          findings.push({
            where: at(n),
            kind: 'servizio che tiene un Database',
            text: n.expression.getText(),
            opened,
          });
        const fn = calledFunction(n);
        if (fn && usesOuterDatabase(fn, 1, new Set()))
          findings.push({
            where: at(n),
            kind: 'funzione che usa un Database da fuori',
            text: n.expression.getText(),
            opened,
          });
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
  };

  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(SRC)) continue;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callback = transactionCallback(n);
        if (callback?.body) inspect(callback.body, at(n));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...new Map(findings.map((f) => [`${f.where} ${f.text}`, f])).values()];

  /**
   * Il callback di `withActor(db, utente, (tx) => …)` o di `db.transaction((tx) => …)`, scritto lì
   * o passato per nome.
   */
  function transactionCallback(call: ts.CallExpression): ts.FunctionLikeDeclaration | null {
    const callee = call.expression;
    const cb =
      ts.isIdentifier(callee) && callee.text === 'withActor'
        ? call.arguments[2]
        : ts.isPropertyAccessExpression(callee) &&
            callee.name.text === 'transaction' &&
            databaseKind(checker.getTypeAtLocation(callee.expression)) === 'db'
          ? call.arguments[0]
          : undefined;
    if (!cb) return null;
    if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) return cb;
    if (ts.isIdentifier(cb) || ts.isPropertyAccessExpression(cb)) return calledFunctionOf(cb);
    return null;
  }

  /** La dichiarazione della funzione con questo nome, se è nel servizio. */
  function calledFunctionOf(name: ts.Expression): ts.FunctionLikeDeclaration | null {
    let symbol = checker.getSymbolAtLocation(name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    for (const d of symbol?.declarations ?? []) {
      if (!d.getSourceFile().fileName.startsWith(SRC)) continue;
      if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) return d.body ? d : null;
      if (
        ts.isVariableDeclaration(d) &&
        d.initializer &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
      )
        return d.initializer;
    }
    return null;
  }
}

/** Il nome di una dichiarazione o una chiave: non è un valore usato. */
function isDeclarationName(n: ts.Identifier): boolean {
  const p = n.parent;
  return (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isBindingElement(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isPropertyDeclaration(p)) &&
    p.name === n
  );
}

function within(node: ts.Node, container: ts.Node): boolean {
  return node.pos >= container.pos && node.end <= container.end;
}

describe('lettura dei tipi del servizio (D228)', () => {
  it('dentro una transazione aperta il servizio non usa il database né un servizio o una funzione che lo usa', () => {
    const found = findDatabaseInsideTransactions().filter((f) => !ALLOWED[f.where]);
    expect(
      found.map((f) => `${f.where} [${f.kind}] «${f.text}», transazione aperta in ${f.opened}`),
    ).toEqual([]);
  }, 180_000);
});
