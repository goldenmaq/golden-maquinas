// Vercel Serverless Function — painel de usuários (só para a conta mestre).
// GET: lista usuários. POST: cria. PUT: edita (permissões/nome/ativo/senha).
// DELETE: remove. Tudo gravado em data/users.json no GitHub (lib/gmauth.js).
const {
    readUsersFile, writeUsersFile,
    hashPassword,
    getSessionFromReq, publicUser, readJsonBody,
} = require('../lib/gmauth');

function uid() {
    return 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

async function requireMaster(req, res) {
    const session = getSessionFromReq(req);
    if (!session) { res.status(401).json({ error: 'Sessão inválida' }); return null; }
    if (!session.isMaster) { res.status(403).json({ error: 'Só a conta mestre pode gerenciar usuários' }); return null; }
    return session;
}

module.exports = async (req, res) => {
    try {
          const session = await requireMaster(req, res);
          if (!session) return;
          if (req.method === 'GET') return await list(res);
          if (req.method === 'POST') return await create(req, res);
          if (req.method === 'PUT') return await update(req, res, session);
          if (req.method === 'DELETE') return await remove(req, res, session);
          res.status(405).json({ error: 'Método não permitido' });
    } catch (e) {
          res.status(e.status || 500).json({ error: (e && e.message) || 'Erro interno', detail: e && e.detail });
    }
};

async function list(res) {
    const { users } = await readUsersFile();
    res.status(200).json({ users: users.map(publicUser) });
}

async function create(req, res) {
    const body = await readJsonBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const name = String(body.name || '').trim();
    const senha = String(body.password || '');
    const sections = Array.isArray(body.sections) ? body.sections : [];
    const isMaster = !!body.isMaster;
    if (!email || !name || senha.length < 6) { res.status(400).json({ error: 'Informe nome, e-mail e senha (mín. 6 caracteres)' }); return; }

  const { users, sha } = await readUsersFile();
    if (users.some((u) => String(u.email || '').toLowerCase() === email)) {
          res.status(409).json({ error: 'Já existe um usuário com esse e-mail' });
          return;
    }
    const novo = {
          id: uid(), email, name, passwordHash: hashPassword(senha),
          isMaster, sections: isMaster ? ['*'] : sections, active: true,
          criadoEm: new Date().toISOString(),
    };
    users.push(novo);
    await writeUsersFile(users, sha, `Cria usuário: ${email}`);
    res.status(201).json({ user: publicUser(novo) });
}

async function update(req, res, session) {
    const body = await readJsonBody(req);
    const id = String(body.id || '');
    if (!id) { res.status(400).json({ error: 'id ausente' }); return; }

  const { users, sha } = await readUsersFile();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) { res.status(404).json({ error: 'Usuário não encontrado' }); return; }

  const atual = users[idx];
    const isMaster = typeof body.isMaster === 'boolean' ? body.isMaster : atual.isMaster;
    // evita remover o último mestre ativo
  if (atual.isMaster && !isMaster) {
        const outrosMestres = users.filter((u) => u.id !== id && u.isMaster && u.active !== false);
        if (!outrosMestres.length) { res.status(400).json({ error: 'Precisa haver ao menos uma conta mestre ativa' }); return; }
  }
    const atualizado = {
          ...atual,
          name: body.name != null ? String(body.name) : atual.name,
          sections: isMaster ? ['*'] : (Array.isArray(body.sections) ? body.sections : atual.sections),
          isMaster,
          active: typeof body.active === 'boolean' ? body.active : atual.active,
          atualizadoEm: new Date().toISOString(),
    };
    if (body.password) {
          if (String(body.password).length < 6) { res.status(400).json({ error: 'A senha precisa ter ao menos 6 caracteres' }); return; }
          atualizado.passwordHash = hashPassword(String(body.password));
    }
    users[idx] = atualizado;
    await writeUsersFile(users, sha, `Atualiza usuário: ${atualizado.email}`);
    res.status(200).json({ user: publicUser(atualizado) });
}

async function remove(req, res, session) {
    const id = String((req.query && req.query.id) || '');
    if (!id) { res.status(400).json({ error: 'id ausente' }); return; }
    if (id === session.uid) { res.status(400).json({ error: 'Você não pode remover a própria conta' }); return; }

  const { users, sha } = await readUsersFile();
    const alvo = users.find((u) => u.id === id);
    if (!alvo) { res.status(404).json({ error: 'Usuário não encontrado' }); return; }
    if (alvo.isMaster) {
          const outrosMestres = users.filter((u) => u.id !== id && u.isMaster && u.active !== false);
          if (!outrosMestres.length) { res.status(400).json({ error: 'Precisa haver ao menos uma conta mestre ativa' }); return; }
    }
    const restantes = users.filter((u) => u.id !== id);
    await writeUsersFile(restantes, sha, `Remove usuário: ${alvo.email}`);
    res.status(200).json({ ok: true });
}
