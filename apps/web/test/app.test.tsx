import { COMPANY_BRAND, PRODUCT_NAME } from '@mmg/brand';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';

describe('interfaccia', () => {
  it('mostra il nome del prodotto preso da PRODUCT_NAME e «by SCRIPT»', () => {
    render(<App />);
    expect(screen.getAllByText(PRODUCT_NAME).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`by ${COMPANY_BRAND}`).length).toBeGreaterThan(0);
  });
});
