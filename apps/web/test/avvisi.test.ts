// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', 'src');

const listTsx = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? listTsx(join(dir, e.name))
      : e.name.endsWith('.tsx')
        ? [join(dir, e.name)]
        : [],
  );

const tagOf = (node: ts.Node): string | null =>
  ts.isJsxElement(node)
    ? node.openingElement.tagName.getText()
    : ts.isJsxSelfClosingElement(node)
      ? node.tagName.getText()
      : null;

/**
 * I collegamenti scritti dentro un avviso (`Notice`) fuori da una frase (`<p>`), come «file:riga».
 *
 * Perché: nella prova nel browser il controllo dei bersagli da 44 px lascia passare solo i
 * collegamenti dentro una frase, come vuole l'eccezione di WCAG per i collegamenti nel testo.
 * Un collegamento scritto direttamente nell'avviso è un bersaglio a sé, alto quanto una riga
 * (22 px). La simulazione del deceduto l'ha trovato nell'avviso di Oggi; gli altri avvisi così
 * (conto bloccato, codice fiscale corretto, credenziali dei servizi…) la prova nel browser non
 * li apre tutti, e questa prova li guarda tutti nei sorgenti.
 */
function looseLinks(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node, inNotice: boolean, inSentence: boolean) => {
    const tag = tagOf(node);
    if (tag === 'Notice') {
      inNotice = true;
      inSentence = false;
    } else if (inNotice && tag === 'p') {
      inSentence = true;
    } else if (inNotice && !inSentence && (tag === 'Link' || tag === 'a')) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      out.push(`${name}:${line + 1}`);
    }
    ts.forEachChild(node, (child) => visit(child, inNotice, inSentence));
  };
  visit(source, false, false);
  return out;
}

describe('avvisi con un collegamento', () => {
  it('la prova riconosce un collegamento fuori da una frase', () => {
    const loose = `const A = () => (
      <Notice kind="avviso">
        Testo dell’avviso. <Link to="/x">Apri</Link>
      </Notice>
    );`;
    const sentence = `const A = () => (
      <Notice kind="avviso">
        <p>
          Testo dell’avviso. {ok && <a href="/y">Apri</a>}
        </p>
      </Notice>
    );`;
    // In una voce d'elenco il collegamento è un bersaglio a sé, come nella prova nel browser.
    const listItem = `const A = () => (
      <Notice kind="avviso">
        <ul>
          <li>
            <Link to="/x">Voce</Link>
          </li>
        </ul>
      </Notice>
    );`;
    expect(looseLinks('a.tsx', loose)).toEqual(['a.tsx:3']);
    expect(looseLinks('b.tsx', sentence)).toEqual([]);
    expect(looseLinks('d.tsx', listItem)).toEqual(['d.tsx:5']);
    // Fuori da un avviso il collegamento non riguarda questa prova.
    expect(looseLinks('c.tsx', 'const A = () => <div><Link to="/x">Apri</Link></div>;')).toEqual(
      [],
    );
  });

  it('in ogni avviso dell’interfaccia il collegamento sta in una frase', () => {
    const files = listTsx(SRC);
    expect(files.length).toBeGreaterThan(20);
    const found = files.flatMap((f) => looseLinks(relative(SRC, f), readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });
});
