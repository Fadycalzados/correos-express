// Polls Correos Express for shipment status changes and sends WhatsApp notifications
const CE_TRACK_URL = 'https://www.cexpr.es/wspsc/apiRestSeguimiento/json/seguimiento';

const WATI_BASE = `https://${process.env.WATI_DOMAIN || 'live-mt-server.wati.io/10164356'}/api/v1`;

const STATUS_MESSAGES = {
  ausente:   '📦 Hola! Hemos intentado entregarte tu pedido de Fady Calzados pero no estabas en casa. ¿A qué hora puedes recibir mañana? Escríbenos y lo gestionamos 🙏',
  rechazado: '😔 Vemos que has rechazado tu pedido de Fady Calzados. ¿Ha habido algún problema? Escríbenos y lo solucionamos 🙏',
  camino:    '🚚 Tu pedido de Fady Calzados está en camino y llegará hoy. ¡Prepárate para recibirlo!',
  entregado: '✅ Tu pedido de Fady Calzados ha sido entregado. ¡Esperamos que te encanten! 👠',
};

function classifyStatus(estado) {
  const s = (estado || '').toLowerCase();
  if (s.includes('ausente') || s.includes('no estaba') || s.includes('intento fallido')) return 'ausente';
  if (s.includes('rechazado') || s.includes('rehusado') || s.includes('devolucion')) return 'rechazado';
  if (s.includes('en reparto') || s.includes('reparto') || s.includes('en camino')) return 'camino';
  if (s.includes('entregado') || s.includes('entrega efectuada')) return 'entregado';
  return null;
}

async function trackShipment(expedicion) {
  const user = process.env.CORREOS_USER;
  const pass = process.env.CORREOS_PASS;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const r = await fetch(CE_TRACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ expedicion }),
  });
  const text = await r.text();
  const match = text.match(/\{.*\}/s);
  if (!match) return null;
  return JSON.parse(match[0]);
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

  const results = [];

  for (const key of allKeys) {
    const vR = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, { headers });
    const vJ = await vR.json();
    if (!vJ?.result) continue;
    let ship;
    try { ship = JSON.parse(vJ.result); } catch { continue; }

    // Skip already delivered or rejected
    if (ship.status === 'entregado' || ship.status === 'rechazado') continue;

    try {
      const tracking = await trackShipment(ship.expedicion);
      if (!tracking) continue;

      const lastEvent = tracking.eventos?.[0]?.descripcion || tracking.estadoEnvio || '';
      const newStatus = classifyStatus(lastEvent);

      if (newStatus && newStatus !== ship.status) {
        // Status changed — notify customer
        const msg = STATUS_MESSAGES[newStatus];
        if (msg && ship.phone) await sendWhatsApp(ship.phone, msg);

        // Notify admin for rechazado/ausente
        if (newStatus === 'rechazado') {
          await notifyAdmin(`⚠️ RECHAZADO: ${ship.name} (${ship.phone}) — expedición ${ship.expedicion}`);
        }
        if (newStatus === 'ausente') {
          await notifyAdmin(`📦 AUSENTE: ${ship.name} (${ship.phone}) — expedición ${ship.expedicion}`);
        }

        // Update status in KV
        ship.status = newStatus;
        ship.lastEvent = lastEvent;
        await fetch(`${kvUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(ship))}`, {
          method: 'POST', headers,
        }).catch(() => {});

        results.push({ expedicion: ship.expedicion, name: ship.name, status: newStatus, event: lastEvent });
        console.log('[track] status change:', ship.expedicion, newStatus);
      }
    } catch (e) {
      console.error('[track] error for', ship.expedicion, e.message);
    }
  }

  return res.status(200).json({ ok: true, checked: allKeys.length, changed: results });
};
