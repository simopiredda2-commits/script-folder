import { useState } from 'react';
import { age, date, maskedFiscalCode } from '../lib/format';
import type { Patient, Summary } from '../pages/RecordPage';

/** Lo stato del paziente in parole, come nella fascia della cartella e nell'elenco dei pazienti. */
export const PATIENT_STATUS: Record<string, string> = {
  active: 'in carico',
  revoked: 'revocato',
  deceased: 'deceduto',
  temporary: 'temporaneo',
};

/**
 * I dati del paziente sempre in vista: età, sesso, nascita, codice fiscale (mascherato), stato; poi
 * allergie ed esenzioni. Le esenzioni sono quelle in corso, con la descrizione del catalogo e la
 * scadenza (D244); se il servizio non le distingue, tutte, come prima.
 */
export function PatientFacts({
  patient,
  summary,
  withName = false,
}: {
  patient: Patient;
  summary?: Summary | null;
  /** Nella fascia della cartella (D244) il nome apre la riga, piccolo come i dati. */
  withName?: boolean;
}) {
  const [showCf, setShowCf] = useState(false);
  const exemptions =
    summary?.esenzioniInCorso ??
    summary?.esenzioni.map((e) => ({ codice: e.codice, descrizione: null, al: e.al })) ??
    [];
  return (
    <div className="testata-paziente">
      <p className="testata-dati">
        {withName && (
          <strong className="testata-nome">
            {patient.firstName} {patient.lastName}
          </strong>
        )}
        <span>{age(patient.birthDate)} anni</span>
        <span>{patient.sex === 'F' ? 'donna' : 'uomo'}</span>
        <span>
          {patient.sex === 'F' ? 'Nata' : 'Nato'} il {date(patient.birthDate)}
        </span>
        <span className="codice">
          {showCf ? patient.fiscalCode : maskedFiscalCode(patient.fiscalCode)}
        </span>
        <button
          type="button"
          className="pulsante pulsante-piatto"
          onClick={() => setShowCf((v) => !v)}
          aria-pressed={showCf}
        >
          {showCf ? 'Nascondi il codice fiscale' : 'Mostra il codice fiscale'}
        </button>
        {patient.status !== 'active' && (
          <span className="etichetta">
            {PATIENT_STATUS[patient.status] ?? patient.status}
            {patient.status === 'deceased' && patient.deceasedOn
              ? ` il ${date(patient.deceasedOn)}`
              : ''}
          </span>
        )}
      </p>
      {summary && (
        <ul className="testata-avvisi" aria-label="In evidenza">
          {summary.allergie.map((a) => (
            <li key={a.sostanza} className="pillola pillola-pericolo">
              Allergia: {a.sostanza}
            </li>
          ))}
          {exemptions.map((e) => (
            <li key={e.codice} className="pillola pillola-esenzione">
              Esenzione {e.codice}
              {e.descrizione && <span className="pillola-testo">: {e.descrizione}</span>}
              {e.al ? ` fino al ${date(e.al)}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
