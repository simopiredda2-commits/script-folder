import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { IssueList, type RuleIssue } from '../src/components/common';

const SUSPENDED: RuleIssue = {
  ruleId: 'R22',
  severity: 'info',
  lineId: 'l1',
  message: 'RANITIDINA DOC GENERICI: confezione sospesa secondo l’anagrafica AIFA delle confezioni',
  source:
    'AIFA, anagrafica delle confezioni (file «confezioni_fornitura.csv», colonna «STATO_AMMINISTRATIVO») dalla pagina «Liste dei farmaci»',
};

describe('regole che informano nella ricetta (R21, R22)', () => {
  afterEach(cleanup);

  it('la confezione sospesa (D210): simbolo, parola e fonte; nessun rimedio, nessun motivo da dare', () => {
    const { container } = render(<IssueList issues={[SUSPENDED]} />);
    const item = container.querySelector('li.problema-info');
    expect(item).toBeTruthy();
    expect(item!.querySelector('svg[data-icona="info"]')).toBeTruthy();
    expect(item!.querySelector('p')!.textContent).toBe(
      'R22 · Informazione: RANITIDINA DOC GENERICI: confezione sospesa secondo l’anagrafica AIFA delle confezioni',
    );
    expect(item!.querySelector('.problema-fonte')!.textContent).toBe(`Fonte: ${SUSPENDED.source}`);
    expect(item!.querySelector('.problema-rimedio')).toBeNull();
    expect(container.textContent).not.toMatch(/motivo/i);
  });
});
