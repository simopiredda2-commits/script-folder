import type { Deadline } from './table';
import { FileRejected } from './table';

/**
 * Lettore XML minimo e lineare per le parti di un XLSX non fidato: un solo passaggio sul testo,
 * nessuna espressione regolare che possa tornare indietro su un file costruito apposta. Niente
 * DOCTYPE (quindi nessuna entità definita dal file), niente istruzioni diverse dall'intestazione.
 * I nomi degli elementi e degli attributi perdono il prefisso dello spazio dei nomi («x:row» →
 * «row», «r:id» → «id»).
 */

export interface XmlHandler {
  start?(name: string, attrs: Record<string, string>, selfClosing: boolean): void;
  end?(name: string): void;
  text?(text: string): void;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const BAD_XML = 'Il foglio di calcolo contiene un XML non valido';

/** Testo con le entità predefinite dell'XML e i riferimenti numerici. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&', i);
    if (amp < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, amp);
    const semi = s.indexOf(';', amp);
    if (semi < 0 || semi - amp > 12) throw new FileRejected(BAD_XML);
    const name = s.slice(amp + 1, semi);
    if (name.startsWith('#')) {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (
        !Number.isInteger(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        throw new FileRejected(BAD_XML);
      out += String.fromCodePoint(code);
    } else {
      const v = ENTITIES[name];
      if (v === undefined) throw new FileRejected(BAD_XML);
      out += v;
    }
    i = semi + 1;
  }
  return out;
}

const localName = (n: string) => {
  const c = n.indexOf(':');
  return c < 0 ? n : n.slice(c + 1);
};

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/** Byte di una parte XML in testo: UTF-8, oppure il file è rifiutato. */
export function xmlText(bytes: Uint8Array): string {
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
  } catch {
    throw new FileRejected(`${BAD_XML}: una parte non è in UTF-8`);
  }
}

/** Scorre l'XML una volta e chiama il gestore per ogni elemento e ogni testo. */
export function scanXml(xml: string, h: XmlHandler, deadline: Deadline): void {
  const n = xml.length;
  let i = 0;
  while (i < n) {
    deadline.check();
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      if (h.text && i < n) h.text(decodeEntities(xml.slice(i)));
      return;
    }
    if (lt > i && h.text) h.text(decodeEntities(xml.slice(i, lt)));
    const next = xml.charCodeAt(lt + 1);
    if (next === 0x3f /* ? */) {
      const close = xml.indexOf('?>', lt + 2);
      if (close < 0) throw new FileRejected(BAD_XML);
      i = close + 2;
      continue;
    }
    if (next === 0x21 /* ! */) {
      if (xml.startsWith('<!--', lt)) {
        const close = xml.indexOf('-->', lt + 4);
        if (close < 0) throw new FileRejected(BAD_XML);
        i = close + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const close = xml.indexOf(']]>', lt + 9);
        if (close < 0) throw new FileRejected(BAD_XML);
        if (h.text) h.text(xml.slice(lt + 9, close));
        i = close + 3;
        continue;
      }
      // DOCTYPE e dichiarazioni: un foglio di calcolo non ne ha bisogno, e le entità definite dal
      // file sono il primo strumento per far esplodere un lettore XML.
      throw new FileRejected(
        'Il foglio di calcolo contiene una dichiarazione DOCTYPE: non si importa',
      );
    }
    if (next === 0x2f /* / */) {
      const close = xml.indexOf('>', lt + 2);
      if (close < 0) throw new FileRejected(BAD_XML);
      if (h.end) h.end(localName(xml.slice(lt + 2, close).trim()));
      i = close + 1;
      continue;
    }
    // Elemento: nome, attributi tra virgolette (che possono contenere «>»), fine «>» o «/>».
    let j = lt + 1;
    while (j < n && !isSpace(xml.charCodeAt(j)) && xml[j] !== '>' && xml[j] !== '/') j++;
    const name = localName(xml.slice(lt + 1, j));
    if (!name) throw new FileRejected(BAD_XML);
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      if (j >= n) throw new FileRejected(BAD_XML);
      if (xml[j] === '>') {
        j++;
        break;
      }
      if (xml[j] === '/' && xml[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      const a = j;
      while (j < n && xml[j] !== '=' && !isSpace(xml.charCodeAt(j)) && xml[j] !== '>') j++;
      const attr = localName(xml.slice(a, j));
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      if (xml[j] !== '=') throw new FileRejected(BAD_XML);
      j++;
      while (j < n && isSpace(xml.charCodeAt(j))) j++;
      const q = xml[j];
      if (q !== '"' && q !== "'") throw new FileRejected(BAD_XML);
      const end = xml.indexOf(q, j + 1);
      if (end < 0) throw new FileRejected(BAD_XML);
      attrs[attr] = decodeEntities(xml.slice(j + 1, end));
      j = end + 1;
    }
    if (h.start) h.start(name, attrs, selfClosing);
    if (selfClosing && h.end) h.end(name);
    i = j;
  }
}
