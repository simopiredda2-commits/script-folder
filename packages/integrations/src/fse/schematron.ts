/**
 * Motore dello schematron (ISO Schematron) per i controlli del Gateway del Fascicolo (D132).
 *
 * Applica le regole così come le pubblica il Ministero: per ogni regola, i nodi del contesto; per
 * ogni nodo, le variabili (`let`) e poi le asserzioni (`assert`, errore se falsa) e le
 * segnalazioni (`report`, avviso se vera). In un `pattern` ogni nodo è controllato solo dalla
 * prima regola che lo riguarda, come vuole lo standard. Le espressioni sono XPath 1.0, con le due
 * cose di XPath 2 che lo schematron del PSS usa: la funzione `matches` e il confronto d'ordine tra
 * due testi (in XPath 2 si confrontano come testi, in XPath 1 diventerebbero numeri).
 */

import { readFileSync } from 'node:fs';
import { DOMParser, type Element, type Node as XmlNode } from '@xmldom/xmldom';
import * as xpathLib from 'xpath';

/** Valore di un'espressione XPath (insieme di nodi, testo, numero o vero/falso). */
interface XPathValue {
  booleanValue(): boolean;
  stringValue(): string;
  numberValue(): number;
}
interface XPathOptions {
  node: unknown;
  namespaces?: Record<string, string>;
  functions?: Record<string, (ctx: unknown, ...args: XPathValue[]) => unknown>;
  variables?: Record<string, XPathValue>;
}
/** `xpath.parse` c'è nella libreria ma non nelle sue dichiarazioni di tipo (versione 0.0.34). */
interface XPathExpression {
  evaluate(options: XPathOptions): XPathValue;
  select(options: XPathOptions): unknown[];
}
const xpath = xpathLib as unknown as { parse(expression: string): XPathExpression };

export interface SchematronFinding {
  /** Codice all'inizio del messaggio («ERRORE-11», «W001»), se c'è. */
  code: string | null;
  message: string;
  /** Contesto della regola, per capire dove guardare. */
  context: string;
  kind: 'error' | 'warning';
}

export interface SchematronResult {
  errors: SchematronFinding[];
  warnings: SchematronFinding[];
}

interface Check {
  kind: 'error' | 'warning';
  test: XPathExpression;
  message: Element;
}
interface Rule {
  context: string;
  expression: XPathExpression;
  lets: { name: string; value: XPathExpression }[];
  checks: Check[];
}
interface Pattern {
  rules: Rule[];
}

const SCH_NS = 'http://purl.oclc.org/dsdl/schematron';

/**
 * Confronto d'ordine tra due variabili (`$a >= $b`): in XPath 2 due testi si confrontano come
 * testi, in XPath 1 come numeri. Lo schematron del PSS lo usa sulle date (ERROR-57), che con il
 * fuso orario («+0100») non sono numeri: si passa per una funzione che fa come XPath 2.
 */
const ORDER_OPERATORS: Record<string, string> = { '>=': 'ge', '<=': 'le', '>': 'gt', '<': 'lt' };
const VARIABLE_COMPARISON = /\$([\w.-]+)\s*(>=|<=|>|<)\s*\$([\w.-]+)/g;
function asXPath2(expression: string): string {
  return expression.replace(
    VARIABLE_COMPARISON,
    (_m, a: string, op: string, b: string) => `xp2-compare($${a}, $${b}, '${ORDER_OPERATORS[op]}')`,
  );
}

/** Le espressioni del contesto sono pattern XSLT: valgono in qualunque punto del documento. */
function contextExpression(context: string): string {
  const c = context.trim();
  return c.startsWith('/') ? c : `//${c}`;
}

function childElements(el: Element, name: string): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling)
    if (
      n.nodeType === 1 &&
      (n as Element).localName === name &&
      (n as Element).namespaceURI === SCH_NS
    )
      out.push(n as Element);
  return out;
}

type Evaluated = XPathValue;

/** Un valore numerico di XPath (per esempio il risultato di `count`). */
const isNumber = (v: XPathValue) => v.constructor.name === 'XNumber';

export class Schematron {
  private readonly namespaces: Record<string, string> = {};
  private readonly patterns: Pattern[] = [];
  private readonly functions: NonNullable<XPathOptions['functions']> = {
    /** `matches` di XPath 2: vero se l'espressione regolare trova una corrispondenza. */
    matches: (_ctx, input, pattern) =>
      new RegExp(pattern.stringValue()).test(input.stringValue()),
    /** Confronto d'ordine come in XPath 2: numeri se uno dei due è un numero, se no testi. */
    'xp2-compare': (_ctx, a, b, op) => {
      const numeric = isNumber(a) || isNumber(b);
      const x = numeric ? a.numberValue() : a.stringValue();
      const y = numeric ? b.numberValue() : b.stringValue();
      switch (op.stringValue()) {
        case 'ge':
          return x >= y;
        case 'le':
          return x <= y;
        case 'gt':
          return x > y;
        default:
          return x < y;
      }
    },
  };

  constructor(source: string) {
    const doc = new DOMParser().parseFromString(source, 'text/xml');
    const schema = doc.documentElement;
    if (!schema || schema.namespaceURI !== SCH_NS) throw new Error('Non è uno schematron ISO');
    for (const ns of childElements(schema, 'ns'))
      this.namespaces[ns.getAttribute('prefix')!] = ns.getAttribute('uri')!;
    for (const p of childElements(schema, 'pattern')) {
      const rules: Rule[] = childElements(p, 'rule').map((r) => {
        const context = r.getAttribute('context')!;
        const lets = childElements(r, 'let').map((l) => ({
          name: l.getAttribute('name')!,
          value: xpath.parse(asXPath2(l.getAttribute('value')!)),
        }));
        const checks: Check[] = [];
        for (let n = r.firstChild; n; n = n.nextSibling) {
          if (n.nodeType !== 1) continue;
          const el = n as Element;
          if (el.localName === 'assert' || el.localName === 'report')
            checks.push({
              kind: el.localName === 'assert' ? 'error' : 'warning',
              test: xpath.parse(asXPath2(el.getAttribute('test')!)),
              message: el,
            });
        }
        return { context, expression: xpath.parse(contextExpression(context)), lets, checks };
      });
      this.patterns.push({ rules });
    }
  }

  static fromFile(path: string | URL): Schematron {
    return new Schematron(readFileSync(path, 'utf8'));
  }

  /** Numero di asserzioni e segnalazioni: serve alle prove per sapere che c'è tutto. */
  get size(): number {
    return this.patterns.reduce((n, p) => n + p.rules.reduce((m, r) => m + r.checks.length, 0), 0);
  }

  validate(xml: string): SchematronResult {
    const parseErrors: string[] = [];
    let doc: ReturnType<DOMParser['parseFromString']> | undefined;
    try {
      doc = new DOMParser({
        onError: (level, msg) => {
          if (level !== 'warning') parseErrors.push(msg);
        },
      }).parseFromString(xml, 'text/xml');
    } catch (e) {
      // xmldom interrompe la lettura agli errori gravi: è un documento non ben formato.
      parseErrors.push(e instanceof Error ? e.message : String(e));
    }
    if (parseErrors.length || !doc?.documentElement)
      return {
        errors: [
          {
            code: null,
            message: `Il documento non è XML ben formato: ${parseErrors[0] ?? 'vuoto'}`,
            context: '/',
            kind: 'error',
          },
        ],
        warnings: [],
      };
    const errors: SchematronFinding[] = [];
    const warnings: SchematronFinding[] = [];
    for (const pattern of this.patterns) {
      const seen = new Set<XmlNode>();
      for (const rule of pattern.rules) {
        const nodes = rule.expression.select({
          node: doc,
          namespaces: this.namespaces,
          functions: this.functions,
        }) as XmlNode[];
        for (const node of nodes) {
          if (seen.has(node)) continue;
          seen.add(node);
          const variables: Record<string, Evaluated> = {};
          const options = (): XPathOptions => ({
            node,
            namespaces: this.namespaces,
            functions: this.functions,
            variables,
          });
          for (const l of rule.lets) variables[l.name] = l.value.evaluate(options());
          for (const check of rule.checks) {
            const value = check.test.evaluate(options()).booleanValue();
            const fails = check.kind === 'error' ? !value : value;
            if (!fails) continue;
            const message = this.message(check.message, node, options);
            const finding: SchematronFinding = {
              code: /^\s*([A-Za-z]+-?[A-Za-z0-9]*)\s*\|/.exec(message)?.[1] ?? null,
              message,
              context: rule.context,
              kind: check.kind,
            };
            (check.kind === 'error' ? errors : warnings).push(finding);
          }
        }
      }
    }
    return { errors, warnings };
  }

  /** Testo del messaggio con `<name/>` e `<value-of select="…"/>` risolti sul nodo. */
  private message(el: Element, node: XmlNode, options: () => XPathOptions): string {
    let out = '';
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 || n.nodeType === 4) out += n.nodeValue ?? '';
      else if (n.nodeType === 1) {
        const child = n as Element;
        if (child.localName === 'name') out += (node as Element).nodeName ?? '';
        else if (child.localName === 'value-of')
          out += xpath.parse(child.getAttribute('select')!).evaluate(options()).stringValue();
      }
    }
    return out.replace(/\s+/g, ' ').trim();
  }
}

let pss: Schematron | undefined;

/** Lo schematron ufficiale del Profilo Sanitario Sintetico (versione 4.0, D131). */
export function pssSchematron(): Schematron {
  pss ??= Schematron.fromFile(
    new URL('../../fse-ufficiale/schematron/schematron_PSS_v4.0.sch', import.meta.url),
  );
  return pss;
}
