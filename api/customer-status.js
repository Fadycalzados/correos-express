// Customer shipment lookup by phone number
// GET ?phone=34612345678
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const raw   = (req.query.phone || '').replace(/\D/g, '');
  const phone = raw.startsWith('34') ? raw : (raw.length === 9 ? '34' + raw : raw);
  if (!phone || phone.length < 9) return res.status(400).json({ error: 'phone required' });

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

  // batch fetch all values
  const BATCH = 100;
  const allValues = [];
  for (let i = 0; i < allKeys.length; i += BATCH) {
    const batch = allKeys.slice(i, i + BATCH);
    const path  = batch.map(k => encodeURIComponent(k)).join('/');
    const r     = await fetch(`${kvUrl}/mget/${path}`, { headers });
    const d     = await r.json();
    allValues.push(...(d.result || []));
  }

  const shipments = [];
  for (let i = 0; i < allKeys.length; i++) {
    const raw = allValues[i];
    if (!raw) continue;
    try {
      const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const sPhone = (s.phone || '').replace(/\D/g, '');
      const norm   = sPhone.startsWith('34') ? sPhone : (sPhone.length === 9 ? '34' + sPhone : sPhone);
      if (norm === phone) shipments.push(s);
    } catch {}
  }

  shipments.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return res.status(200).json({ ok: true, shipments });
};
