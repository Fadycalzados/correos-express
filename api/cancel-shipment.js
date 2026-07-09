// Cancels shipment: tries Correos Express API, always removes from KV
// POST { exp: "EXPEDITION_NUMBER" }
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const exp = (req.body?.exp || req.query.exp || '').trim();
  if (!exp) return res.status(400).json({ error: 'exp required' });

  const user   = process.env.CORREOS_USER;
  const pass   = process.env.CORREOS_PASS;
  const client = process.env.CORREOS_CLIENT || 'B11360001';
  const auth   = Buffer.from(`${user}:${pass}`).toString('base64');

  const BASE = 'https://www.cexpr.es/wspsc/apiRestGrabacionEnviok8s/json';
  const body = JSON.stringify({ solicitante: client, expedicion: exp, numEnvio: exp, password: pass });

  // Best-effort CE API cancellation (not critical if it fails)
  let ceCancelled = false;
  for (const endpoint of ['anulacionEnvio', 'anulacion', 'cancelacionEnvio']) {
    try {
      const r    = await fetch(`${BASE}/${endpoint}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Basic ${auth}` },
        body,
      });
      const text = await r.text();
      console.log(`[cancel] ${endpoint} status=${r.status} body=${text.slice(0, 200)}`);
      if (r.status === 404 || r.status === 405) continue;
      const match = text.match(/\{[\s\S]*\}/);
      let data = {};
      try { if (match) data = JSON.parse(match[0]); } catch {}
      if (data.codigoRetorno === 0) { ceCancelled = true; break; }
    } catch (e) {
      console.error(`[cancel] ${endpoint} error:`, e.message);
    }
  }

  // Always remove from KV regardless of CE API result
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    const h = { Authorization: `Bearer ${kvToken}` };
    await Promise.all([
      fetch(`${kvUrl}/del/shipment:${encodeURIComponent(exp)}`, { method: 'POST', headers: h }),
      fetch(`${kvUrl}/del/label:${encodeURIComponent(exp)}`,    { method: 'POST', headers: h }),
    ]).catch(() => {});
  }

  return res.status(200).json({ ok: true, cancelled: exp, ceCancelled });
};
