// Vercel Serverless Function — proxy seguro para a IA (Gemini como principal,
// com fallback para Anthropic se preferir). A chave fica só aqui no servidor
// (variável de ambiente), nunca é enviada ao navegador. O app (index.html)
// chama este endpoint em vez de usar a chave diretamente, o que seria
// inseguro em um site público.
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const ANTHROPIC_MODEL = 'claude-haiku-5-5';

async function chamarGemini(apiKey, prompt) {
  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: 'application/json', temperature: 0.2 },
      }),
    }
  );
  if (!upstream.ok) {
    const errText = await upstream.text();
    const err = new Error('Falha ao chamar a IA (Gemini)');
    err.detail = errText.slice(0, 500);
    err.status = 502;
    throw err;
  }
  const data = await upstream.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || '').join('');
}

async function chamarAnthropic(apiKey, prompt) {
  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!upstream.ok) {
    const errText = await upstream.text();
    const err = new Error('Falha ao chamar a IA (Anthropic)');
    err.detail = errText.slice(0, 500);
    err.status = 502;
    throw err;
  }
  const data = await upstream.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !anthropicKey) {
    res.status(500).json({
      error:
        'Nenhuma chave de IA configurada. Defina GEMINI_API_KEY (ou ANTHROPIC_API_KEY) nas variáveis de ambiente do projeto na Vercel e faça um novo deploy.',
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
    const text = geminiKey
      ? await chamarGemini(geminiKey, promptSeguro)
      : await chamarAnthropic(anthropicKey, promptSeguro);

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
    res.status(e.status || 500).json({
      error: (e && e.message) || 'Erro interno ao chamar a IA',
      detail: e && e.detail,
    });
  }
};
