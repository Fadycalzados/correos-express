// Manually update shipment status (for when CE tracking lags behind reality)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { exp, status } = req.body || {};
  const allowed = ['entregado', 'ausente', 'rechazado', 'camino', 'created'];
  if (!exp || !allowed.includes(status)) {
    return res.status(400).json({ error: 'exp and valid status required' });
  }

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'KV not configured' });

  const headers = { Authorization: `Bearer ${kvToken}` };
  const key = `shipment:${exp}`;

  const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, { headers });
  const j = await r.json();
  if (!j?.result) return res.status(404).json({ error: 'Shipment not found' });

  let ship;
  try { ship = JSON.parse(j.result); } catch { return res.status(500).json({ error: 'parse error' }); }

  ship.status    = status;
  ship.lastEvent = status === 'entregado' ? 'Entregado (manual)' : ship.lastEvent;

  await fetch(`${kvUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(ship))}`, {
    method: 'POST', headers,
  });

  return res.status(200).json({ ok: true, expedicion: exp, status });
};
