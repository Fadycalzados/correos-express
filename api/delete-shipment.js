module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'DELETE' && req.method !== 'POST') return res.status(405).json({ error: 'DELETE only' });

  const exp = (req.query.exp || '').trim();
  if (!exp) return res.status(400).json({ error: 'exp required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'KV not configured' });

  const headers = { Authorization: `Bearer ${kvToken}` };

  await Promise.all([
    fetch(`${kvUrl}/del/shipment:${encodeURIComponent(exp)}`, { method: 'POST', headers }),
    fetch(`${kvUrl}/del/label:${encodeURIComponent(exp)}`, { method: 'POST', headers }),
  ]);

  console.log('[delete] removed shipment:', exp);
  return res.status(200).json({ ok: true });
};
