import { describe, expect, it } from 'vitest';
import { pssSchematron, Schematron } from '../src/fse/schematron';

/** Schematron minimo, per provare il motore regola per regola. */
const SCH = `<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <ns prefix="hl7" uri="urn:hl7-org:v3"/>
  <pattern id="all">
    <rule context="hl7:doc">
      <let name="n" value="count(hl7:item)"/>
      <assert test="$n >= 1">E-1| L'elemento <name/> DEVE avere almeno un item</assert>
      <report test="$n > 2">W-1| Più di due item: <value-of select="$n"/></report>
    </rule>
    <rule context="//hl7:item[@special]">
      <assert test="@special='si'">E-2| item speciale con valore '<value-of select="@special"/>'</assert>
    </rule>
    <rule context="//hl7:item">
      <assert test="matches(@cf,'[A-Z0-9]{16}')">E-3| codice non valido</assert>
    </rule>
    <rule context="//hl7:period[hl7:low/@value]">
      <let name="low" value="string(hl7:low/@value)"/>
      <let name="high" value="string(hl7:high/@value)"/>
      <assert test="count(hl7:high/@value)=0 or ($high >= $low)">E-4| fine prima dell'inizio</assert>
    </rule>
  </pattern>
</schema>`;

const doc = (body: string) => `<doc xmlns="urn:hl7-org:v3">${body}</doc>`;
const codes = (xml: string) => {
  const r = new Schematron(SCH).validate(xml);
  return { errors: r.errors.map((e) => e.code), warnings: r.warnings.map((w) => w.code) };
};

describe('motore dello schematron', () => {
  it('asserzione falsa: errore con il nome dell’elemento nel messaggio', () => {
    const r = new Schematron(SCH).validate(doc(''));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ code: 'E-1', kind: 'error', context: 'hl7:doc' });
    expect(r.errors[0]!.message).toBe("E-1| L'elemento doc DEVE avere almeno un item");
  });

  it('segnalazione vera: avviso, con il valore calcolato nel messaggio', () => {
    const items = '<item cf="ABCDEF12G34H567I"/>'.repeat(3);
    const r = new Schematron(SCH).validate(doc(items));
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toEqual(['W-1| Più di due item: 3']);
  });

  it('in un pattern ogni nodo lo controlla solo la prima regola che lo riguarda', () => {
    // L'item speciale è della seconda regola: la terza (codice fiscale) non lo guarda.
    expect(codes(doc('<item special="si"/>'))).toEqual({ errors: [], warnings: [] });
    expect(codes(doc('<item special="no"/>')).errors).toEqual(['E-2']);
    expect(codes(doc('<item cf="corto"/>')).errors).toEqual(['E-3']);
  });

  it('matches come in XPath 2', () => {
    expect(codes(doc('<item cf="ABCDEF12G34H567I"/>')).errors).toEqual([]);
    expect(codes(doc('<item cf="abcdef12g34h567i"/>')).errors).toEqual(['E-3']);
  });

  it('due testi si confrontano come testi, come in XPath 2 (date con il fuso)', () => {
    const period = (low: string, high: string) =>
      doc(
        `<item cf="ABCDEF12G34H567I"/><period><low value="${low}"/><high value="${high}"/></period>`,
      );
    expect(codes(period('20200410000000+0100', '20220410000000+0100')).errors).toEqual([]);
    expect(codes(period('20220410000000+0100', '20200410000000+0100')).errors).toEqual(['E-4']);
  });

  it('un documento non ben formato è un errore, non un’eccezione', () => {
    const r = new Schematron(SCH).validate('<doc xmlns="urn:hl7-org:v3"><item>');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(/non è XML ben formato/);
  });

  it('lo schematron ufficiale del PSS: 372 asserzioni e 3 segnalazioni', () => {
    expect(pssSchematron().size).toBe(375);
  });
});
