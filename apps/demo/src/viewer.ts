/**
 * Visore dei documenti della dimostrazione (D221). Nell'artifact non si aprono schede nuove e non
 * si scaricano file: i collegamenti a /api/… (PDF, CSV, rapporti) e i PDF che l'interfaccia apre
 * con window.open si mostrano qui, in un riquadro della pagina. I PDF li disegna pdf.js.
 */
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

let lastFocus: Element | null = null;

const NOTE =
  'Nella dimostrazione il documento si apre qui: nel programma vero si apre in una scheda nuova, da stampare o salvare.';

export function closeViewer() {
  document.getElementById('dimo-visore')?.remove();
  if (lastFocus instanceof HTMLElement) lastFocus.focus();
}

function frame(title: string, note = NOTE): HTMLElement {
  closeViewer();
  lastFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.id = 'dimo-visore';
  overlay.className = 'dimo-visore';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'dimo-visore-titolo');
  overlay.innerHTML = `
    <div class="dimo-visore-riquadro">
      <div class="dimo-visore-testata">
        <h2 id="dimo-visore-titolo"></h2>
        <button type="button" class="dimo-visore-chiudi">Chiudi</button>
      </div>
      <p class="dimo-visore-nota"></p>
      <div class="dimo-visore-corpo" tabindex="0"></div>
    </div>`;
  overlay.querySelector('h2')!.textContent = title;
  overlay.querySelector('.dimo-visore-nota')!.textContent = note;
  overlay.querySelector('button')!.addEventListener('click', closeViewer);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeViewer();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeViewer();
  });
  document.body.append(overlay);
  overlay.querySelector<HTMLButtonElement>('.dimo-visore-chiudi')!.focus();
  return overlay.querySelector<HTMLElement>('.dimo-visore-corpo')!;
}

const kb = (n: number) => (n < 1024 ? `${n} byte` : `${Math.round(n / 1024)} KB`);

/**
 * Filigrana su ogni pagina: i documenti della dimostrazione hanno numeri inventati (NRE,
 * protocolli) e non valgono nulla, ma somigliano a quelli veri. Si vede a colpo d'occhio.
 */
function watermark(context: CanvasRenderingContext2D, width: number, height: number) {
  const size = Math.round(width / 22);
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate(-Math.atan2(height, width));
  context.font = `700 ${size}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = 'rgba(190, 30, 45, 0.28)';
  const step = size * 4;
  for (let y = -height; y <= height; y += step)
    context.fillText('DIMOSTRAZIONE – DOCUMENTO NON VALIDO', 0, y);
  context.restore();
}

async function renderPdf(body: HTMLElement, bytes: Uint8Array) {
  const doc = await getDocument({ data: bytes }).promise;
  const width = Math.min(body.clientWidth || 800, 900) - 24;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = width / base.width;
    const ratio = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Pagina ${i} di ${doc.numPages}`);
    body.append(canvas);
    const context = canvas.getContext('2d')!;
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    watermark(context, canvas.width, canvas.height);
  }
}

async function show(blob: Blob, title: string) {
  const body = frame(title);
  const type = blob.type.split(';')[0]!.trim();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const pdf = type === 'application/pdf' || (bytes[0] === 0x25 && bytes[1] === 0x50);
  try {
    if (pdf) await renderPdf(body, bytes);
    else if (/^text\/|json|csv|xml/.test(type)) {
      const text = new TextDecoder().decode(bytes);
      const pre = document.createElement('pre');
      pre.textContent =
        type === 'text/html'
          ? (new DOMParser().parseFromString(text, 'text/html').body.textContent ?? '').trim()
          : text;
      body.append(pre);
    } else {
      const p = document.createElement('p');
      p.textContent = `File di tipo ${type || 'sconosciuto'} (${kb(bytes.length)}): nella dimostrazione non si apre.`;
      body.append(p);
    }
  } catch (err) {
    const p = document.createElement('p');
    p.className = 'dimo-visore-errore';
    p.textContent = `Il documento non si è aperto: ${err instanceof Error ? err.message : String(err)}`;
    body.append(p);
  }
}

async function openFromService(path: string, title: string) {
  const res = await fetch(path);
  if (!res.ok) {
    let message = `Errore ${res.status}`;
    try {
      message = ((await res.json()) as { errore?: string }).errore ?? message;
    } catch {
      /* il corpo non è JSON */
    }
    const body = frame(title);
    const p = document.createElement('p');
    p.className = 'dimo-visore-errore';
    p.textContent = message;
    body.append(p);
    return;
  }
  await show(await res.blob(), title);
}

const serviceUrl = (href: string) => {
  const url = new URL(href, document.baseURI);
  return url.origin === location.origin && url.pathname.startsWith('/api/') ? url : null;
};

export function installDocumentViewer() {
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      const url = serviceUrl(a.getAttribute('href') ?? '');
      if (!url) return;
      e.preventDefault();
      void openFromService(`${url.pathname}${url.search}`, a.textContent?.trim() || 'Documento');
    },
    true,
  );
  const original = window.open.bind(window);
  window.open = (url?: string | URL, target?: string, features?: string) => {
    if (url) {
      const href = String(url);
      if (href.startsWith('blob:')) {
        void fetch(href)
          .then((r) => r.blob())
          .then((b) => show(b, 'Documento'));
        return null;
      }
      const api = serviceUrl(href);
      if (api) {
        void openFromService(`${api.pathname}${api.search}`, 'Documento');
        return null;
      }
    }
    return original(url, target, features);
  };
}

/**
 * Una pagina HTML dei simulatori (SPID, CIE, Fascicolo) nel visore: nel programma vero è un'altra
 * pagina del browser. I moduli e i collegamenti tornano a `navigate`, che li gira al servizio.
 */
export function showPage(html: string, base: URL, navigate: (url: URL) => void) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = frame(
    doc.title || 'Pagina simulata',
    'Nella dimostrazione questa pagina simulata si apre qui: nel programma vero è la pagina del servizio regionale, nel browser.',
  );
  doc.querySelectorAll('script').forEach((el) => el.remove());
  const page = document.createElement('div');
  page.className = 'dimo-visore-pagina';
  page.append(...Array.from(doc.body.childNodes).map((n) => document.importNode(n, true)));
  body.append(page);
  page.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement;
    e.preventDefault();
    const action = new URL(form.getAttribute('action') ?? base.href, base);
    const data = new FormData(form);
    const submitter = e.submitter;
    if (submitter instanceof HTMLButtonElement && submitter.name)
      data.append(submitter.name, submitter.value);
    for (const [k, v] of data) if (typeof v === 'string') action.searchParams.append(k, v);
    navigate(action);
  });
  page.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    navigate(new URL(a.getAttribute('href')!, base));
  });
}
