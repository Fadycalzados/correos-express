// Serves the PDF label for a shipment by expedition number
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const exp = (req.query.exp || '').trim();
  if (!exp) return res.status(400).json({ error: 'exp required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'KV not configured' });

  const r = await fetch(`${kvUrl}/get/label:${encodeURIComponent(exp)}`, {
    headers: { Authorization: `Bearer ${kvToken}` },
  });
  const j = await r.json();
  const b64 = j?.result;
  if (!b64) return res.status(404).json({ error: 'Label not found for ' + exp });

  // Correos Express uses double base64 encoding
  const step1 = Buffer.from(b64, 'base64').toString('utf8');
  const pdfBuf = Buffer.from(step1, 'base64');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="label-${exp}.pdf"`);
  return res.end(pdfBuf);
};
