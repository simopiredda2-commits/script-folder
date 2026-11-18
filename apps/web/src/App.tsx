import { PRODUCT_NAME } from '@mmg/brand';
import { Logo } from './components/Logo';
import { Signature } from './components/Signature';

export function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <Logo />
        <Signature />
      </header>
      <main className="app-main" id="contenuto">
        <h1>Cartella clinica</h1>
        <p>
          Ambiente di sviluppo di {PRODUCT_NAME}: solo pazienti inventati. Le schermate arrivano con
          le prossime tappe.
        </p>
      </main>
      <footer className="app-footer">
        <span>
          {PRODUCT_NAME} <Signature />
        </span>
      </footer>
    </div>
  );
}
