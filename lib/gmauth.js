// Biblioteca compartilhada de autenticação — usada pelas funções em /api.
// Não fica dentro de /api de propósito: a Vercel só transforma em endpoint
// os arquivos dentro de /api, então este arquivo é só código importado.
//
// Armazenamento de usuários: um arquivo JSON (data/users.json) dentro do
// próprio repositório GitHub, lido/gravado via GitHub Contents API usando
// um token de acesso restrito a este repositório (GITHUB_TOKEN). Não é um
// banco "de verdade", mas evita depender de outro serviço externo (Neon,
// Supabase etc.) só para guardar login/senha e permissões.
const crypto = require('crypto');

const GITHUB_REPO = process.env.GITHUB_REPO || 'goldenmaq/golden-maquinas';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const USERS_PATH = 'data/users.json';
const SESSION_COOKIE = 'gm_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 dias
const RESET_TOKEN_TTL_SECONDS = 60 * 60; // 1 hora
const SITE_URL = process.env.SITE_URL || 'https://golden-maquinas.vercel.app';
const RESEND_FROM = process.env.RESEND_FROM || 'Goldenmaq Sales <onboarding@resend.dev>';

function githubToken() {
    const t = process.env.GITHUB_TOKEN;
    if (!t) { const e = new Error('GITHUB_TOKEN não configurado no servidor'); e.status = 500; throw e; }
    return t;
}

async function ghFetch(path, opts) {
    const res = await fetch(`https://api.github.com${path}`, {
          ...opts,
          headers: {
                  Authorization: `Bearer ${githubToken()}`,
                  Accept: 'application/vnd.github+json',
                  'X-GitHub-Api-Version': '2022-11-28',
                  'User-Agent': 'goldenmaq-sales-auth',
                  ...(opts && opts.headers),
          },
    });
    return res;
}

// ---------- leitura/gravação do arquivo de usuários ----------
async function readUsersFile() {
    const res = await ghFetch(`/repos/${GITHUB_REPO}/contents/${USERS_PATH}?ref=${GITHUB_BRANCH}`, { method: 'GET' });
    if (res.status === 404) return { users: [], sha: null };
    if (!res.ok) { const e = new Error('Falha ao ler usuários no GitHub'); e.status = 502; e.detail = await res.text(); throw e; }
    const json = await res.json();
    const content = Buffer.from(json.content, 'base64').toString('utf8');
    let parsed;
    try { parsed = JSON.parse(content); } catch (e) { parsed = { users: [] }; }
    return { users: parsed.users || [], sha: json.sha };
}

async function writeUsersFile(users, sha, message) {
    const content = Buffer.from(JSON.stringify({ users }, null, 2), 'utf8').toString('base64');
    const body = { message: message || 'Atualiza usuários (Goldenmaq Sales)', content, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    const res = await ghFetch(`/repos/${GITHUB_REPO}/contents/${USERS_PATH}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
    });
    if (!res.ok) {
          const detail = await res.text();
          const e = new Error(res.status === 409 ? 'Conflito ao salvar — tente novamente' : 'Falha ao salvar usuários no GitHub');
          e.status = res.status === 409 ? 409 : 502;
          e.detail = detail;
          throw e;
    }
    return res.json();
}

// ---------- senha ----------
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
    if (!stored || typeof stored !== 'string' || stored.indexOf(':') === -1) return false;
    const [salt, hashHex] = stored.split(':');
    const hash = crypto.scryptSync(String(password), salt, 64);
    const stored2 = Buffer.from(hashHex, 'hex');
    if (hash.length !== stored2.length) return false;
    return crypto.timingSafeEqual(hash, stored2);
}

// ---------- redefinição de senha (link enviado por e-mail) ----------
function generateResetToken() {
    return crypto.randomBytes(32).toString('hex');
}
function hashResetToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function buildResetUrl(email, token) {
    return `${SITE_URL}/?reset=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
}
async function sendResetEmail(to, resetUrl) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) { const e = new Error('Envio de e-mail não configurado no servidor'); e.status = 500; throw e; }
    const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
                  from: RESEND_FROM,
                  to: [to],
                  subject: 'Redefinição de senha — Goldenmaq Sales',
                  html: `
                          <p>Você solicitou a redefinição da sua senha no Goldenmaq Sales.</p>
                                  <p><a href="${resetUrl}">Clique aqui para definir uma nova senha</a></p>
                                          <p>O link expira em 1 hora. Se você não solicitou isso, pode ignorar este e-mail.</p>
                                                `,
          }),
    });
    if (!res.ok) {
          const detail = await res.text();
          const e = new Error('Falha ao enviar e-mail de redefinição');
          e.status = 502;
          e.detail = detail;
          throw e;
    }
    return res.json();
}

// ---------- sessão (token assinado, sem dependências externas) ----------
function sessionSecret() {
    const s = process.env.SESSION_SECRET;
    if (!s) { const e = new Error('SESSION_SECRET não configurado no servidor'); e.status = 500; throw e; }
    return s;
}
function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(str) { return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

function signSession(payload) {
    const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS };
    const payloadB64 = b64url(Buffer.from(JSON.stringify(body), 'utf8'));
    const sig = b64url(crypto.createHmac('sha256', sessionSecret()).update(payloadB64).digest());
    return `${payloadB64}.${sig}`;
}
function verifySession(token) {
    if (!token || token.indexOf('.') === -1) return null;
    const [payloadB64, sig] = token.split('.');
    const expected = b64url(crypto.createHmac('sha256', sessionSecret()).update(payloadB64).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let payload;
    try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); } catch (e) { return null; }
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
}

// ---------- cookies ----------
function parseCookies(req) {
    const header = (req.headers && req.headers.cookie) || '';
    const out = {};
    header.split(';').forEach((part) => {
          const idx = part.indexOf('=');
          if (idx === -1) return;
          const k = part.slice(0, idx).trim();
          const v = part.slice(idx + 1).trim();
          if (k) out[k] = decodeURIComponent(v);
    });
    return out;
}
function setSessionCookie(res, token) {
    const attrs = [
          `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
          'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', `Max-Age=${SESSION_TTL_SECONDS}`,
        ];
    res.setHeader('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
function getSessionFromReq(req) {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (!token) return null;
    return verifySession(token);
}

function publicUser(u) {
    if (!u) return null;
    return { id: u.id, email: u.email, name: u.name, isMaster: !!u.isMaster, sections: u.sections || [], active: u.active !== false };
}

async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
    return {};
}

module.exports = {
    GITHUB_REPO, GITHUB_BRANCH, USERS_PATH, RESET_TOKEN_TTL_SECONDS,
    readUsersFile, writeUsersFile,
    hashPassword, verifyPassword,
    signSession, verifySession,
    parseCookies, setSessionCookie, clearSessionCookie, getSessionFromReq,
    publicUser, readJsonBody,
    generateResetToken, hashResetToken, buildResetUrl, sendResetEmail,
};
