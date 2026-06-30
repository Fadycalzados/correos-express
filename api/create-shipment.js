// Creates a Correos Express shipment and stores it in KV
const CE_URL = 'https://www.cexpr.es/wspsc/apiRestGrabacionEnviok8s/json/grabacionEnvio';

function pad(v, n) { return String(v || '').slice(0, n); }

function today() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  return `${dd}${mm}${yy}`;
}

async function createShipment({ name, address, city, zip, phone, price, ref }) {
  const user   = process.env.CORREOS_USER;
  const pass   = process.env.CORREOS_PASS;
  const client = process.env.CORREOS_CLIENT || 'B11360001';
  console.log('[correos] user:', user, 'client:', client, 'pass_len:', pass?.length);

  const product = process.env.CORREOS_PRODUCT || '54'; // Paq 24

  const reembolso = price ? parseFloat(price).toFixed(2) : '0.00';

  const body = {
    solicitante:      pad(client, 100),
    canalEntrada:     '5',
    numEnvio:         String(Date.now()).padStart(16, '0'),
    ref:              pad(ref || `FAD${Date.now()}`, 20),
    refCliente:       '',
    fecha:            today(),
    codRte:           pad(client, 10),
    nomRte:           'FADY CALZADO',
    nifRte:           '',
    dirRte:           'EXTREMADURA KALEA 4',
    pobRte:           'GASTEIZ',
    codPosNacRte:     '01003',
    paisISORte:       'ES',
    codPosIntRte:     '',
    contacRte:        'FADY CALZADO',
    telefRte:         '681889165',
    emailRte:         'asiffaisal976@gmail.com',
    codDest:          '',
    nomDest:          pad(name, 40),
    nifDest:          '',
    dirDest:          pad(address, 50),
    pobDest:          pad(city, 50),
    codPosNacDest:    pad(zip, 5),
    paisISODest:      'ES',
    codPosIntDest:    '',
    contacDest:       pad(name, 50),
    telefDest:        pad(phone, 15),
    emailDest:        '',
    contacOtrs:       '',
    telefOtrs:        '',
    emailOtrs:        '',
    observac:         '',
    numBultos:        '1',
    kilos:            '1,0',
    volumen:          '',
    alto:             '',
    largo:            '',
    ancho:            '',
    producto:         product,
    portes:           'P',
    reembolso:        reembolso,
    entrSabado:       '',
    seguro:           '',
    numEnvioVuelta:   String(Date.now() + 1).padStart(16, '0'),
    listaBultos:      [],
    codDirecDestino:  '',
    password:         pass,
    listaInformacionAdicional: [{ tipoEtiqueta: '1', etiquetaPDF: 'N' }],
  };

  const jsonBody = JSON.stringify(body);
  console.log('[correos] sending solicitante:', body.solicitante, 'body_len:', jsonBody.length);
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const r = await fetch(CE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Basic ${auth}` },
    body: jsonBody,
  });

  const text = await r.text();
  console.log('[correos] raw response:', text.slice(0, 300));

  // Response is wrapped: extract the JSON object
  const match = text.match(/\{.*\}/s);
  if (!match) throw new Error('Invalid response: ' + text.slice(0, 100));
  const data = JSON.parse(match[0]);

  // 0 = success, 404 = shipment created but label not available
  if (data.codigoRetorno !== 0 && data.codigoRetorno !== 404) {
    throw new Error(`Correos error ${data.codigoRetorno}: ${data.mensajeRetorno || JSON.stringify(data)}`);
  }
  if (!data.datosResultado) {
    throw new Error(`Correos error ${data.codigoRetorno}: ${data.mensajeRetorno}`);
  }

  return { expedicion: data.datosResultado, label: data.etiqueta?.[0]?.etiqueta1 || null };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { name, address, city, zip, phone, price, ref } = req.body || {};
  if (!name || !address || !city || !zip || !phone) {
    return res.status(400).json({ error: 'name, address, city, zip, phone required' });
  }

  try {
    const { expedicion, label } = await createShipment({ name, address, city, zip, phone, price, ref });

    // Store in KV so we can track status later
    const kvUrl   = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    if (kvUrl && kvToken) {
      const ts  = Date.now();
      const val = JSON.stringify({ expedicion, name, address, city, zip, phone, price, ts, status: 'created' });
      await fetch(`${kvUrl}/set/shipment:${encodeURIComponent(expedicion)}/${encodeURIComponent(val)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${kvToken}` },
      }).catch(() => {});
    }

    console.log('[correos] shipment created:', expedicion, 'for', name, zip);
    return res.status(200).json({ ok: true, expedicion, label });
  } catch (e) {
    console.error('[correos] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
