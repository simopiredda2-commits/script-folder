/**
 * Simboli dell'interfaccia (D67): stanno sempre accanto al nome, mai al suo posto, e sono
 * decorativi per chi usa un lettore di schermo. Stile del logo: tratto continuo, spessore
 * costante, estremi arrotondati, un solo colore (quello del testo).
 */
const PATHS = {
  oggi: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v5', 'M16 3v5', 'M11 15h2'],
  pazienti: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5'],
  ricette: ['M6 3h9l3 3v15H6z', 'M9 9h6', 'M9 13h6', 'M9 17h4'],
  farmaci: ['M10.5 4.5a4.95 4.95 0 0 1 7 7l-7 7a4.95 4.95 0 0 1-7-7z', 'M7 8l9 9'],
  cerca: ['M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z', 'M15.5 15.5L20 20'],
  esci: ['M14 4h5v16h-5', 'M10 8l-4 4 4 4', 'M6 12h10'],
  firma: ['M4 20h6', 'M14.5 5.5l4 4L9 19H5v-4z'],
  ripeti: ['M4 12a8 8 0 0 1 14-5.3', 'M18 3v4h-4', 'M20 12a8 8 0 0 1-14 5.3', 'M6 21v-4h4'],
  specialistica: [
    'M9 4H6v6a4 4 0 0 0 8 0V4h-3',
    'M10 14v2a4 4 0 0 0 8 0v-3',
    'M18 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  ],
  esami: ['M9 3h6', 'M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3', 'M7.5 15h9'],
  terapia: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
  aggiungi: ['M12 5v14', 'M5 12h14'],
  stampa: ['M7 9V4h10v5', 'M7 17H4v-7h16v7h-3', 'M7 14h10v6H7z'],
  avviso: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17h.01'],
  blocco: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8 12h8'],
  fatto: ['M5 12.5l4.5 4.5L19 7.5'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8h.01'],
  storico: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  lucchetto: ['M6 11h12v9H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  indietro: ['M15 5l-7 7 7 7'],
  apri: ['M9 5l7 7-7 7'],
  annulla: ['M6 6l12 12', 'M18 6L6 18'],
  archivio: ['M4 4h16v5H4z', 'M5 9v11h14V9', 'M10 13h4'],
  strumenti: ['M4 7h9', 'M17 7h3', 'M15 5v4', 'M4 17h3', 'M11 17h9', 'M9 15v4'],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icona"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      data-icona={name}
    >
      {PATHS[name].map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
