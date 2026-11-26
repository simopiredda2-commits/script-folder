import type { RegionalPackage } from '../src/types';

/**
 * Il pacchetto della Regione Piemonte (D288, D292): il primo. Oggi è il manifesto: che cosa dà la
 * Regione e dove sta nel programma. Le parti passano nelle cartelle del pacchetto una alla volta
 * (`packages/regions/piemonte/`, `apps/api/src/regions/piemonte/`, `apps/web/src/regions/piemonte/`,
 * `apps/demo/src/regions/piemonte/` e le loro prove), con le prove sempre verdi.
 */
export const piemonte: RegionalPackage = {
  key: 'piemonte',
  // Codice della regione nell'elenco delle aziende sanitarie del Ministero (D267).
  regionCode: '010',
  name: 'Piemonte',
  parts: [
    {
      part: 'prescription',
      where: 'core',
      what: 'SAR del CSI Piemonte (SIRPED): ricetta dematerializzata, ricetta rossa in DPCM, lotti di NRE e codice del gestionale assegnato dalla Regione (D264–D270)',
    },
    {
      part: 'registry',
      where: 'core',
      what: 'AURA, anagrafe regionale degli assistiti: esenzioni, scelte, nuovi assistiti e cambi di medico (D197–D200), oggi con un simulatore',
    },
    {
      part: 'health_record',
      where: 'core',
      what: 'Fascicolo regionale: pubblicazione con i servizi della V09 (D280) e accesso dalla cartella con il modulo LCCE (D220, D265)',
    },
    {
      part: 'additional_services',
      where: 'core',
      what: 'Accordo integrativo regionale 2024, art. 35, comma 4 (AIR35.4, `docs/ppip.md`), con la corrispondenza per il SIAP (D291)',
    },
    {
      part: 'catalog',
      where: 'core',
      what: 'Catalogo regionale delle prestazioni (D.D. 590/2026 e 710/2026, D159, D260)',
    },
    {
      part: 'waiting_groups',
      where: 'core',
      what: 'Tabelle RAO della cardiologia e della gastroenterologia (D.D. 973/2019 e 259/2019, D285)',
    },
    {
      part: 'distribution',
      where: 'core',
      what: 'Elenco dei farmaci in distribuzione per conto (PHT e DPC) della Regione, da `sync/`',
    },
    {
      part: 'rules',
      where: 'core',
      what: 'Valori regionali delle regole di prescrizione, nello stesso insieme di quelli nazionali (D288)',
    },
  ],
  asl: [],
  terms: [
    /piemont/i,
    /\bCSI\b/,
    /SIRPED/i,
    // Il SAR e il suo nome nel codice: sarGateway, SimulatedSar, sar-simulator.ts, /sar.
    /\bSAR\b|\bsar(?=[-_A-Z]|\.ts\b|\/)|\bSar(?=[A-Z])|[a-z]Sar(?![a-z])|\/sar\b/,
    // AURA e il suo nome nel codice: aura_link, auraLink, AuraSection, createAuraService, /aura.
    /\bAURA\b|\baura(?=[-_A-Z]|\.ts\b|\/)|\bAura(?=[A-Z])|[a-z]Aura(?![a-z])|\/aura\b|\baura\b/,
    /RUPAR/i,
    /\bLCCE\b/,
    // Atti della Regione: determinazioni dirigenziali e delibere della Giunta.
    /\bD\.\s?D\.\s?n?\.?\s?\d+\/(?:19|20)\d\d\b|\bDGR\b/,
    // La voce dell'accordo integrativo regionale fra le prestazioni aggiuntive.
    /AIR35\.4/,
  ],
};
