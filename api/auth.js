// Vercel Serverless Function — login / logout / sessão / troca de senha.
// Usuários e senhas (com hash) ficam em data/users.json no repositório
// GitHub, lidos/gravados via GitHub Contents API (ver lib/gmauth.js).
// A sessão é um cookie HttpOnly assinado — a senha nunca volta ao navegador.
const {
    readUsersFile, writeUsersFile,
    verifyPassword, hashPassword,
    signSession,
    setSessionCookie, clearSessionCookie, getSessionFromReq,
    publicUser, readJsonBody,
    RESET_TOKEN_TTL_SECONDS,
    generateResetToken, hashResetToken, buildResetUrl, sendResetEmail,
} = require('../lib/gmauth');

module.exports = async (req, res) => {
    const action = (req.query && req.query.action) || '';
    try {
          if (action === 'login' && req.method === 'POST') return await login(req, res);
          if (action === 'logout' && req.method === 'POST') return await logout(req, res);
          if (action === 'me' && req.method === 'GET') return await me(req, res);
          if (action === 'change-password' && req.method === 'POST') return await changePassword(req, res);
          if (action === 'forgot-password' && req.method === 'POST') return await forgotPassword(req, res);
          if (action === 'reset-password' && req.method === 'POST') return await resetPassword(req, res);
          res.status(404).json({ error: 'ação inválida' });
    } catch (e) {
          res.status(e.status || 500).json({ error: (e && e.message) || 'Erro interno', detail: e && e.detail });
    }
};

async function login(req, res) {
    const body = await readJsonBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const senha = String(body.password || '');
    if (!email || !senha) { res.status(400).json({ error: 'Informe e-mail e senha' }); return; }

  const { users } = await readUsersFile();
    const user = users.find((u) => String(u.email || '').toLowerCase() === email);
    if (!user || user.active === false || !verifyPassword(senha, user.passwordHash)) {
          res.status(401).json({ error: 'E-mail ou senha inválidos' });
          return;
    }
    const token = signSession({ uid: user.id, email: user.email, isMaster: !!user.isMaster, sections: user.sections || [] });
    setSessionCookie(res, token);
    res.status(200).json({ ok: true, user: publicUser(user) });
}

async function logout(req, res) {
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
}

async function me(req, res) {
    const session = getSessionFromReq(req);
    if (!session) { res.status(401).json({ error: 'Sessão inválida' }); return; }
    // confere o usuário ainda existe/ativo (pode ter sido removido/desativado pelo admin)
  const { users } = await readUsersFile();
    const user = users.find((u) => u.id === session.uid);
    if (!user || user.active === false) { res.status(401).json({ error: 'Sessão inválida' }); return; }
    res.status(200).json({ user: publicUser(user) });
}

async function changePassword(req, res) {
    const session = getSessionFromReq(req);
    if (!session) { res.status(401).json({ error: 'Sessão inválida' }); return; }
    const body = await readJsonBody(req);
    const atual = String(body.currentPassword || '');
    const nova = String(body.newPassword || '');
    if (!nova || nova.length < 6) { res.status(400).json({ error: 'A nova senha precisa ter ao menos 6 caracteres' }); return; }

  const { users, sha } = await readUsersFile();
    const idx = users.findIndex((u) => u.id === session.uid);
    if (idx === -1) { res.status(401).json({ error: 'Sessão inválida' }); return; }
    if (!verifyPassword(atual, users[idx].passwordHash)) { res.status(401).json({ error: 'Senha atual incorreta' }); return; }

  users[idx] = { ...users[idx], passwordHash: hashPassword(nova), atualizadoEm: new Date().toISOString() };
    await writeUsersFile(users, sha, `Troca de senha: ${users[idx].email}`);
    res.status(200).json({ ok: true });
}

async function forgotPassword(req, res) {
    const body = await readJsonBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    // sempre responde "ok" — não revela se o e-mail existe ou não
  if (!email) { res.status(200).json({ ok: true }); return; }

  const { users, sha } = await readUsersFile();
    const idx = users.findIndex((u) => String(u.email || '').toLowerCase() === email && u.active !== false);
    if (idx === -1) { res.status(200).json({ ok: true }); return; }

  const token = generateResetToken();
    users[idx] = {
          ...users[idx],
          resetTokenHash: hashResetToken(token),
          resetTokenExpiresAt: Date.now() + RESET_TOKEN_TTL_SECONDS * 1000,
    };
    await writeUsersFile(users, sha, `Solicita redefinição de senha: ${users[idx].email}`);

  const url = buildResetUrl(users[idx].email, token);
    try {
          await sendResetEmail(users[idx].email, url);
    } catch (e) {
          // não vaza detalhes do provedor de e-mail pro cliente; fica registrado nos logs da Vercel
      console.error('Falha ao enviar e-mail de redefinição:', e && (e.detail || e.message));
    }
    res.status(200).json({ ok: true });
}

async function resetPassword(req, res) {
    const body = await readJsonBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const token = String(body.token || '');
    const nova = String(body.newPassword || '');
    if (!email || !token || !nova || nova.length < 6) {
          res.status(400).json({ error: 'Link inválido ou senha muito curta (mín. 6 caracteres)' });
          return;
    }

  const { users, sha } = await readUsersFile();
    const idx = users.findIndex((u) => String(u.email || '').toLowerCase() === email);
    if (idx === -1 || !users[idx].resetTokenHash) {
          res.status(400).json({ error: 'Link inválido ou expirado' });
          return;
    }
    const user = users[idx];
    const tokenOk = user.resetTokenHash === hashResetToken(token);
    const naoExpirou = user.resetTokenExpiresAt && user.resetTokenExpiresAt > Date.now();
    if (!tokenOk || !naoExpirou) {
          res.status(400).json({ error: 'Link inválido ou expirado' });
          return;
    }

  const atualizado = { ...user, passwordHash: hashPassword(nova), atualizadoEm: new Date().toISOString() };
    delete atualizado.resetTokenHash;
    delete atualizado.resetTokenExpiresAt;
    users[idx] = atualizado;
    await writeUsersFile(users, sha, `Redefinição de senha via e-mail: ${user.email}`);
    res.status(200).json({ ok: true });
}
