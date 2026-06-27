// Returns all shipments stored in KV with their current status
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'KV not configured' });

  const headers = { Authorization: `Bearer ${kvToken}` };
  const allKeys = [];
  let cursor = '0', iters = 0;
  do {
    const r = await fetch(`${kvUrl}/scan/${cursor}/match/shipment%3A*/count/200`, { headers });
    const d = await r.json();
    const [next, keys] = d.result;
    cursor = String(next);
    for (const k of (keys || [])) allKeys.push(k);
    if (++iters > 50) break;
  } while (cursor !== '0');

  const shipments = [];
  for (const key of allKeys) {
    const vR = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, { headers });
    const vJ = await vR.json();
    if (!vJ?.result) continue;
    try { shipments.push(JSON.parse(vJ.result)); } catch {}
  }

  shipments.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return res.status(200).json({ ok: true, total: shipments.length, shipments });
};
