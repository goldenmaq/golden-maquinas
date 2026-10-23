// Vercel Serverless Function — proxy seguro para a API da Anthropic.
// A chave fica só aqui no servidor (variável de ambiente ANTHROPIC_API_KEY),
// nunca é enviada ao navegador. O app (index.html) chama este endpoint em
// vez de usar a chave diretamente, o que seria inseguro em um site público.
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'ANTHROPIC_API_KEY não configurada no projeto Vercel. Configure em Settings → Environment Variables e faça um novo deploy.',
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const prompt = body && typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) {
    res.status(400).json({ error: 'prompt ausente' });
    return;
  }
  // limite de segurança para não deixar um request gigante consumir créditos à toa
  const promptSeguro = prompt.length > 16000 ? prompt.slice(0, 16000) : prompt;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: promptSeguro }],
      }),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(502).json({ error: 'Falha ao chamar a IA', detail: errText.slice(0, 500) });
      return;
    }

    const data = await upstream.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    const match = text.match(/\{[\s\S]*\}/);
    let parsed;
    try {
      parsed = JSON.parse(match ? match[0] : text);
    } catch (e) {
      res.status(502).json({ error: 'Resposta da IA não veio em JSON válido' });
      return;
    }
    res.status(200).json({ data: parsed });
  } catch (e) {
    res.status(500).json({ error: 'Erro interno ao chamar a IA', detail: String((e && e.message) || e) });
  }
};
