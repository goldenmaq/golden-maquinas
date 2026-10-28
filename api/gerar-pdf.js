// Vercel Serverless Function — gera o PDF da proposta/contrato a partir do
// HTML já montado no front-end (o mesmo .doc-preview exibido na revisão,
// com todo o CSS do app). Renderizamos num Chromium headless no servidor e
// exportamos com page.pdf(), em vez de depender do usuário usar
// "Imprimir" manualmente no navegador — isso elimina o cabeçalho/rodapé que
// o Chrome injeta (data, título, URL, nº de página), garante margem zero
// (o espaçamento visual já vem do padding do .docpage) e paginação
// consistente (um .docpage = uma página do PDF), deixando o arquivo fiel
// ao padrão A4 exibido na tela e pronto para enviar ao cliente.
const chromium = require('@sparticuz/chromium');
const { getSessionFromReq, readJsonBody } = require('../lib/gmauth');

// puppeteer-core (a partir da v25) é publicado só como ES Module — require()
// direto gera ERR_REQUIRE_ESM neste arquivo CommonJS, então carregamos com
// import() dinâmico (funciona de dentro de CJS) e reaproveitamos a promise.
let puppeteerPromise = null;
function getPuppeteer() {
  if (!puppeteerPromise) puppeteerPromise = import('puppeteer-core').then((m) => m.default || m);
  return puppeteerPromise;
}

const MAX_HTML_LEN = 8 * 1024 * 1024; // 8MB de HTML/CSS (margem folgada acima do limite de corpo da função)

function requireSession(req, res) {
  const session = getSessionFromReq(req);
  if (!session) { res.status(401).json({ error: 'Sessão inválida' }); return null; }
  return session;
}

function sanitizeFilename(name) {
  const base = String(name || 'documento').trim().replace(/[^a-zA-Z0-9_\-.]+/g, '_');
  return base.slice(0, 120) || 'documento';
}

function wrapHtml({ css, bodyHtml, title }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: A4; margin: 0; }
  html,body{ margin:0; padding:0; background:#fff; font-family:Arial,sans-serif; }
  ${css}
  /* reforço: garante um .docpage por página do PDF mesmo se o CSS do app mudar */
  .doc-preview{ display:flex; flex-direction:column; gap:0 !important; }
  .docpage{ box-shadow:none !important; margin:0 auto !important; max-width:none !important; page-break-after:always; break-after:page; }
  .docpage:last-child{ page-break-after:auto; break-after:auto; }
</style>
</head><body>${bodyHtml}</body></html>`;
}

// Reaproveita o browser entre invocações "quentes" da função serverless.
let browserPromise = null;
async function launchBrowser() {
  const puppeteer = await getPuppeteer();
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 794, height: 1123 },
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

module.exports = async (req, res) => {
  let page = null;
  try {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Método não permitido' }); return; }
    const session = requireSession(req, res);
    if (!session) return;

    const body = await readJsonBody(req);
    const html = body && body.html;
    const css = (body && body.css) || '';
    const filename = sanitizeFilename(body && body.filename);
    if (!html || typeof html !== 'string') { res.status(400).json({ error: 'HTML do documento não informado' }); return; }
    if (html.length + css.length > MAX_HTML_LEN) { res.status(413).json({ error: 'Documento muito grande para gerar o PDF' }); return; }

    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setContent(wrapHtml({ css, bodyHtml: html, title: filename }), { waitUntil: 'networkidle0', timeout: 25000 });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    res.status(200).send(Buffer.from(pdf));
  } catch (e) {
    console.error('gerar-pdf:', e);
    res.status(e.status || 500).json({ error: (e && e.message) || 'Erro ao gerar PDF' });
  } finally {
    if (page) { try { await page.close(); } catch (e) { /* noop */ } }
  }
};
