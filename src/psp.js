import crypto from 'crypto';

// ========= UTIL =========
export function validateWebhookSignature(req, secret) {
  // Exemplo genérico usando HMAC do corpo cru (depende do PSP)
  const sig = req.headers['x-signature'];
  if (!sig || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ========= MOCK PROVIDER =========
const mockCharges = new Map();

async function mock_createPixCharge({ reference_code, amount_cents }) {
  const txid = 'MOCK-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const pixCopiaECola = `00020126MOCKREF:${reference_code}54045.005802BR5920EVENTO DISCORD6009SAO PAULO`;
  mockCharges.set(reference_code, { txid, amount_cents, status: 'PENDING', pixCopiaECola });
  return { txid, pixCopiaECola };
}

function mock_parseWebhookEvent(body) {
  // Nosso mock espera: { ref: "...", txid: "...", amount_cents: 500, status: "CONFIRMED" }
  return {
    reference_code: body.ref,
    status: body.status,
    amount_cents: body.amount_cents,
    provider_txid: body.txid
  };
}

// ========= MERCADO PAGO (EXEMPLO) =========
// Preencha com sua integração real, ou troque pelo seu PSP.
// Docs MP: crie pagamento PIX e obtenha QR / copia e cola. Webhook: topic 'payment' etc.
async function mercadopago_createPixCharge({ reference_code, amount_cents }) {
  // Exemplo ilustrativo (não funcional sem credenciais e endpoints reais)
  // 1) Criar pagamento com PIX e setar "external_reference" = reference_code
  // 2) Retornar { txid, pixCopiaECola }
  // Você precisa:
  // - Access Token (PSP_ACCESS_TOKEN)
  // - Chamar REST do MP (fetch/axios)
  throw new Error('mercadopago_createPixCharge não implementado. Use MOCK ou implemente seu PSP aqui.');
}

function mercadopago_parseWebhookEvent(body) {
  // Normalizar body do webhook do MP para {reference_code, status, amount_cents, provider_txid}
  throw new Error('mercadopago_parseWebhookEvent não implementado. Use MOCK ou implemente seu PSP aqui.');
}

// ========= ROUTER =========
export async function createPixCharge({ reference_code, amount_cents, description }) {
  const provider = process.env.PSP_PROVIDER || 'mock';
  if (provider === 'mock') return mock_createPixCharge({ reference_code, amount_cents, description });
  if (provider === 'mercadopago') return mercadopago_createPixCharge({ reference_code, amount_cents, description });
  // Adicione aqui: efipagamentos, pagarme, seu banco, etc.
  throw new Error(`PSP_PROVIDER '${provider}' não suportado ainda.`);
}

export function parseWebhookEvent(body) {
  const provider = process.env.PSP_PROVIDER || 'mock';
  if (provider === 'mock') return mock_parseWebhookEvent(body);
  if (provider === 'mercadopago') return mercadopago_parseWebhookEvent(body);
  throw new Error(`PSP_PROVIDER '${provider}' não suportado ainda.`);
}
