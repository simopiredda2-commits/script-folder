import type { RegionalPackage } from '../src/types';
import { SimulatedRegionalFseAccess } from './integrations/fse-access';
import { simulatedFsePublication } from './integrations/fse-publication-simulator';
import { simulatedSarPrescription } from './integrations/sar-simulator';

export * from './integrations/fse-access';
export * from './integrations/fse-publication';
export * from './integrations/fse-publication-simulator';
export * from './integrations/sar';
export * from './integrations/sar-simulator';

/**
 * Il pacchetto della Regione Piemonte (D288, D292): il primo. Il manifesto dice che cosa dà la
 * Regione e dove sta nel programma; i dati sono in `data/` (D295). Le parti passano nelle cartelle
 * del pacchetto una alla volta
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
      what: 'SAR del CSI Piemonte (SIRPED): ricetta dematerializzata, lotti di NRE, ricetta rossa in DPCM e codice regionale nel promemoria nel pacchetto, in `integrations/` (D300); nel nucleo restano il codice del gestionale assegnato dalla Regione, l’accesso con SPID o CIE e le credenziali RUPAR (D264–D270)',
    },
    {
      part: 'registry',
      where: 'core',
      what: 'AURA, anagrafe regionale degli assistiti: esenzioni, scelte, nuovi assistiti e cambi di medico (D197–D200), oggi con un simulatore',
    },
    {
      part: 'health_record',
      where: 'package',
      what: 'Fascicolo regionale: pubblicazione del Profilo con i servizi della V09 e le politiche di invio (D280) e accesso dalla cartella con il modulo LCCE (D220, D265), in `integrations/` (D297)',
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
      where: 'package',
      what: 'Tabelle RAO della cardiologia e della gastroenterologia (D.D. 973/2019 e 259/2019, D285), in `data/rao`',
    },
    {
      part: 'distribution',
      where: 'core',
      what: 'Elenco dei farmaci in distribuzione per conto (PHT e DPC) della Regione, da `sync/`',
    },
    {
      part: 'deadlines',
      where: 'package',
      what: 'Validità della ricetta specialistica: 60 giorni per il primo accesso, 180 per gli altri (D.D. 710/2026, punto 4; D260), nelle aggiunte alle regole in `data/regole` (D296)',
    },
    {
      part: 'rules',
      where: 'package',
      what: 'Aggiunte alle regole di prescrizione nazionali (D296), in `data/regole`: i termini della specialistica in R1, le fonti della Regione per R5, R9 e R17, il SAR in R18',
    },
  ],
  asl: [],
  integrations: {
    contextCalls: (options) => [new SimulatedRegionalFseAccess(options)],
    fsePublication: (options) => simulatedFsePublication(options),
    prescription: (options) => simulatedSarPrescription(options),
  },
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
