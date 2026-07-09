// Polls Correos Express for shipment status changes and sends WhatsApp notifications
const CE_TRACK_URL = 'https://www.cexpr.es/wspsc/apiRestSeguimientoEnviosk8s/json/seguimientoEnvio';
const zlib = require('zlib');

function extractBarcodeFromPdf(base64Label) {
  try {
    const step1 = Buffer.from(base64Label, 'base64').toString('utf8');
    const pdfBuf = Buffer.from(step1, 'base64');
    const text = pdfBuf.toString('binary');
    let offset = 0;
    while (true) {
      const start = text.indexOf('stream\n', offset);
      if (start === -1) break;
      const end = text.indexOf('endstream', start);
      if (end === -1) break;
      const streamData = pdfBuf.slice(start + 7, end);
      try {
        const decompressed = zlib.inflateSync(streamData);
        const txt = decompressed.toString('latin1');
        const tjMatches = txt.match(/\(([^)]+)\)\s*Tj/g) || [];
        const texts = tjMatches.map(m => m.match(/\(([^)]+)\)/)?.[1]).filter(Boolean);
        const idx = texts.findIndex(t => t.includes('COD. BULTO'));
        if (idx !== -1 && texts[idx + 1]) return texts[idx + 1].trim();
        const barcode = texts.find(t => /^\d{15,}$/.test(t.trim()));
        if (barcode) return barcode.trim();
      } catch (e) {}
      offset = end + 9;
    }
  } catch (e) {}
  return null;
}

const WATI_BASE = `https://${process.env.WATI_DOMAIN || 'live-mt-server.wati.io/10164356'}/api/v1`;

const STATUS_MESSAGES = {
  ausente:   '📦 Hola! Hemos intentado entregarte tu calzado pero no estabas en casa. ¿A qué hora puedes recibir mañana? Escríbenos y lo gestionamos 🙏',
  rechazado: '😔 Vemos que has rechazado tu calzado. ¿Ha habido algún problema? Escríbenos y lo solucionamos 🙏',
};

function classifyStatusCode(code) {
  const n = parseInt(code, 10);
  if ([1, 2, 3].includes(n)) return 'created';
  if ([4, 5, 6].includes(n)) return 'camino';
  if (n === 7)               return 'entregado';
  if ([12, 14].includes(n)) return 'ausente';
  if ([9, 10, 11].includes(n)) return 'rechazado';
  return null;
}

function classifyStatusText(s) {
  s = (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (s.includes('ausente') || s.includes('incidencia') || s.includes('fallido')) return 'ausente';
  if (s.includes('rechazado') || s.includes('rehusado') || s.includes('devolucion') || s.includes('devuelto')) return 'rechazado';
  if (s.includes('reparto') || s.includes('transito') || s.includes('camino') || s.includes('clasificado') || s.includes('admitido')) return 'camino';
  if (s.includes('entregado') || s.includes('entrega efectuada') || s.includes('entrega realizada') || s.includes('entrega ok') || (s.includes('entrega') && !s.includes('intento') && !s.includes('fallido') && !s.includes('ausente'))) return 'entregado';
  return null;
}

function classifyEvent(event) {
  const code = event?.codEstado ?? event?.codigoEstado ?? event?.estado ?? event?.codSituacion ?? event?.situacion ?? event?.code ?? event?.status;
  if (code !== undefined && code !== null && code !== '') {
    const byCode = classifyStatusCode(code);
    if (byCode) return byCode;
  }
  const text = event?.descripcion ?? event?.description ?? event?.descEstado ?? event?.descSituacion ?? event?.nombre ?? event?.texto ?? String(code || '');
  return classifyStatusText(text);
}

function getLatestEvent(data) {
  const arrayFields = ['estadoEnvios', 'bultoSeguimiento', 'estados', 'historico', 'eventos', 'historial', 'listaEventos', 'listaSituaciones', 'situaciones', 'bultos', 'events'];
  for (const field of arrayFields) {
    const arr = data?.[field];
    if (Array.isArray(arr) && arr.length > 0) {
      const sorted = [...arr].sort((a, b) => {
        const da = new Date(a.fecha || a.date || a.fechaHora || a.timestamp || 0);
        const db = new Date(b.fecha || b.date || b.fechaHora || b.timestamp || 0);
        return db - da;
      });
      return sorted[0];
    }
  }
  return data;
}

async function trackShipment(barcode) {
  const user   = process.env.CORREOS_USER;
  const pass   = process.env.CORREOS_PASS;
  const client = process.env.CORREOS_CLIENT || 'B11360001';
  const auth   = Buffer.from(`${user}:${pass}`).toString('base64');
  const hdrs   = { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Basic ${auth}` };

  const body = JSON.stringify({ codigoCliente: client, dato: barcode, idioma: 'ES', GestionCompleta: 'S' });

  try {
    const r    = await fetch(CE_TRACK_URL, { method: 'POST', headers: hdrs, body });
    const text = await r.text();
    console.log(`[track] ${barcode} → HTTP ${r.status} | ${text.replace(/\s+/g, ' ').slice(0, 500)}`);

    if (!r.ok) return null;

    const match = text.match(/[\[{].*[\]}]/s);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);

    if (parsed?.error !== undefined && parsed.error !== 0) {
      console.log(`[track] CE error ${parsed.error}: ${parsed.mensajeError}`);
      return null;
    }
    return parsed;
  } catch (e) {
    console.error('[track] fetch error:', e.message);
    return null;
  }
}

async function sendWhatsApp(phone, message) {
  const token = process.env.WATI_TOKEN;
  if (!token) return;
  const clean = phone.replace(/\D/g, '');
  const fmt = clean.startsWith('34') ? clean : clean.length === 9 ? '34' + clean : clean;
  await fetch(`${WATI_BASE}/sendSessionMessage/${fmt}?messageText=${encodeURIComponent(message)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  }).catch(e => console.error('[track] whatsapp error:', e.message));
}

async function notifyAdmin(message) {
  const adminPhones = (process.env.REPORT_PHONE || '').split(',').map(p => p.trim()).filter(Boolean);
  for (const p of adminPhones) await sendWhatsApp(p, message);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const cronHeader = req.headers['x-vercel-cron'];
  const token      = req.query.token || req.headers['x-track-token'];
  const validToken = process.env.TRACK_TOKEN;
  if (!cronHeader && validToken && token !== validToken) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'KV not configured' });

  const headers = { Authorization: `Bearer ${kvToken}` };

  // Scan all shipment keys
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

  // Batch-fetch all shipment values in one MGET call
  const BATCH = 100;
  const allValues = [];
  for (let i = 0; i < allKeys.length; i += BATCH) {
    const batch = allKeys.slice(i, i + BATCH);
    const r = await fetch(`${kvUrl}/mget/${batch.map(k => encodeURIComponent(k)).join('/')}`, { headers });
    const d = await r.json();
    allValues.push(...(d.result || []));
  }

  // Build list of shipments that need tracking
  const FOURTEEN_DAYS = 14 * 86400 * 1000;
  const toTrack = [];
  for (let i = 0; i < allKeys.length; i++) {
    const raw = allValues[i];
    if (!raw) continue;
    let ship;
    try { ship = JSON.parse(raw); } catch { continue; }
    ship._key = allKeys[i];
    if (ship.status === 'entregado') continue;
    if (ship.ts && Date.now() - ship.ts > FOURTEEN_DAYS) continue; // skip old shipments
    toTrack.push(ship);
  }

  const results = [];
  const debug   = [];

  // Resolve barcodes for any shipments that don't have one yet (sequential — rare after initial backfill)
  for (const ship of toTrack) {
    if (!ship.barcode) {
      const lR = await fetch(`${kvUrl}/get/label:${encodeURIComponent(ship.expedicion)}`, { headers });
      const lJ = await lR.json();
      if (lJ?.result) {
        const barcode = extractBarcodeFromPdf(lJ.result);
        if (barcode) {
          ship.barcode = barcode;
          await fetch(`${kvUrl}/set/${encodeURIComponent(ship._key)}/${encodeURIComponent(JSON.stringify(ship))}`, {
            method: 'POST', headers,
          }).catch(() => {});
        }
      }
    }
  }

  // Track all shipments in PARALLEL — avoids sequential timeout
  await Promise.all(toTrack.map(async ship => {
    const barcode = ship.barcode;
    if (!barcode) {
      debug.push({ exp: ship.expedicion, error: 'no barcode found' });
      return;
    }

    try {
      const tracking = await trackShipment(barcode);
      if (!tracking) {
        debug.push({ exp: ship.expedicion, barcode, error: 'no tracking response' });
        return;
      }

      // CE puts codEstado + descEstado at the root level
      let newStatus = classifyStatusCode(tracking.codEstado) || classifyStatusText(tracking.descEstado || tracking.resultado || '');
      const latestEvent = getLatestEvent(tracking);
      if (!newStatus) newStatus = classifyEvent(latestEvent);
      const rawLabel = tracking.descEstado || (latestEvent?.descripcion ?? latestEvent?.description ?? latestEvent?.descEstado ?? latestEvent?.nombre ?? '');
      const eventLabel = rawLabel || tracking.resultado || '';

      debug.push({ exp: ship.expedicion, barcode, name: ship.name, codEstado: tracking.codEstado, classified: newStatus, current: ship.status });

      const changed = newStatus && newStatus !== ship.status && newStatus !== 'created';
      if (changed) {
        if (newStatus === 'rechazado' && ship.phone) await sendWhatsApp(ship.phone, STATUS_MESSAGES.rechazado).catch(() => {});
        if (newStatus === 'rechazado') await notifyAdmin(`⚠️ RECHAZADO: ${ship.name} (${ship.phone}) — ${ship.expedicion}`).catch(() => {});
        ship.status    = newStatus;
        ship.lastEvent = eventLabel;
        results.push({ expedicion: ship.expedicion, name: ship.name, status: newStatus, event: eventLabel });
        console.log('[track] status change:', ship.expedicion, newStatus);
      }

      await fetch(`${kvUrl}/set/${encodeURIComponent(ship._key)}/${encodeURIComponent(JSON.stringify(ship))}`, {
        method: 'POST', headers,
      }).catch(() => {});
    } catch (e) {
      console.error('[track] error for', ship.expedicion, e.message);
      debug.push({ exp: ship.expedicion, error: e.message });
    }
  }));

  return res.status(200).json({ ok: true, total: allKeys.length, checked: toTrack.length, changed: results, debug });
};
