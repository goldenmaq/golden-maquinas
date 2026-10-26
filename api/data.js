// Vercel Serverless Function — dados compartilhados do app (catálogo, tabela
// de preços, clientes, propostas, contratos, tarefas/lembretes, anotações,
// mensagens, etc.). Qualquer usuário com sessão válida pode ler e gravar;
// quais seções aparecem para cada um é controlado no front-end pelas
// permissões definidas em /api/admin-users. Os dados ficam num banco
// Postgres (Neon) compartilhado entre todos os usuários/dispositivos —
// antes ficavam só no IndexedDB de cada navegador, por isso contas novas
// (ou o modo anônimo) viam tudo vazio.
const { neon } = require('@neondatabase/serverless');
const { getSessionFromReq, readJsonBody } = require('../lib/gmauth');

let sqlClient = null;
function sql() {
    if (!sqlClient) {
        const url = process.env.DATABASE_URL;
        if (!url) { const e = new Error('DATABASE_URL não configurada no servidor'); e.status = 500; throw e; }
        sqlClient = neon(url);
    }
    return sqlClient;
}

let tableReady = null;
function ready() {
    if (!tableReady) {
        const db = sql();
        tableReady = (async () => {
            await db`
                CREATE TABLE IF NOT EXISTS docs (
                    path text PRIMARY KEY,
                    collection text NOT NULL,
                    doc_id text NOT NULL,
                    data jsonb NOT NULL,
                    updated_at timestamptz NOT NULL DEFAULT now()
                )
            `;
            await db`CREATE INDEX IF NOT EXISTS docs_collection_idx ON docs (collection)`;
        })();
    }
    return tableReady;
}

function requireSession(req, res) {
    const session = getSessionFromReq(req);
    if (!session) { res.status(401).json({ error: 'Sessão inválida' }); return null; }
    return session;
}

module.exports = async (req, res) => {
    try {
        const session = requireSession(req, res);
        if (!session) return;
        await ready();
        if (req.method === 'GET') return await get(req, res);
        if (req.method === 'PUT' || req.method === 'POST') return await put(req, res);
        if (req.method === 'DELETE') return await remove(req, res);
        res.status(405).json({ error: 'Método não permitido' });
    } catch (e) {
        res.status(e.status || 500).json({ error: (e && e.message) || 'Erro interno', detail: e && e.detail });
    }
};

async function get(req, res) {
    const db = sql();
    const collection = String((req.query && req.query.collection) || '');
    const id = req.query && req.query.id;
    if (!collection) { res.status(400).json({ error: 'collection ausente' }); return; }
    if (id) {
        const rows = await db`SELECT doc_id, data FROM docs WHERE path = ${collection + '/' + id}`;
        if (!rows.length) { res.status(200).json({ doc: null }); return; }
        res.status(200).json({ doc: { id: rows[0].doc_id, data: rows[0].data } });
        return;
    }
    // No catálogo, 'anexos' (fotos/PDFs em base64) pode ficar muito grande —
    // em listagens (sem id) ele é omitido para não estourar o limite de
    // resposta do banco; continua disponível ao buscar um item específico
    // (com id), usado pelas telas de detalhe/edição do produto.
    const rows = collection === 'catalogo'
        ? await db`SELECT doc_id, (data - 'anexos') AS data FROM docs WHERE collection = ${collection} ORDER BY path ASC`
        : await db`SELECT doc_id, data FROM docs WHERE collection = ${collection} ORDER BY path ASC`;
    res.status(200).json({ docs: rows.map((r) => ({ id: r.doc_id, data: r.data })) });
}

async function put(req, res) {
    const db = sql();
    const body = await readJsonBody(req);
    const collection = String(body.collection || '');
    const id = String(body.id || '');
    if (!collection || !id) { res.status(400).json({ error: 'collection/id ausente' }); return; }
    const path = collection + '/' + id;
    const data = body.data == null ? {} : body.data;
    await db`
        INSERT INTO docs (path, collection, doc_id, data, updated_at)
        VALUES (${path}, ${collection}, ${id}, ${JSON.stringify(data)}::jsonb, now())
        ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
    `;
    res.status(200).json({ ok: true });
}

async function remove(req, res) {
    const db = sql();
    const collection = String((req.query && req.query.collection) || '');
    const id = String((req.query && req.query.id) || '');
    if (!collection || !id) { res.status(400).json({ error: 'collection/id ausente' }); return; }
    await db`DELETE FROM docs WHERE path = ${collection + '/' + id}`;
    res.status(200).json({ ok: true });
}
