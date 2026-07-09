const { PDFDocument } = require('pdf-lib');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const expsRaw = req.query.exps || '';
  const exps = expsRaw.split(',').map(e => e.trim()).filter(Boolean);
  if (!exps.length) return res.status(400).json({ error: 'exps required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'KV not configured' });

  const headers = { Authorization: `Bearer ${kvToken}` };
  const merged  = await PDFDocument.create();

  for (const exp of exps) {
    try {
      const r  = await fetch(`${kvUrl}/get/label:${encodeURIComponent(exp)}`, { headers });
      const j  = await r.json();
      const b64 = j?.result;
      if (!b64) continue;
      // Correos Express uses double base64 encoding
      const step1  = Buffer.from(b64, 'base64').toString('utf8');
      const pdfBuf = Buffer.from(step1, 'base64');
      const doc    = await PDFDocument.load(pdfBuf);
      const pages  = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    } catch (e) {
      console.error('[labels-bulk] failed for exp=' + exp, e.message);
    }
  }

  const pdfBytes = await merged.save();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="etiquetas.pdf"');
  return res.end(Buffer.from(pdfBytes));
};
