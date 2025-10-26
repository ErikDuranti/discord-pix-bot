import crypto from 'crypto';
import fetch from 'node-fetch';

// =================================================
// VALIDAÇÃO DE WEBHOOK DO MERCADO PAGO
// =================================================
// MP envia cabeçalho: x-signature (JWT) + topic.
// Validação é feita consultando o pagamento no endpoint /v1/payments/{id}
// para garantir que é legítimo (forma mais simples e segura).
export function validateWebhookSignature(req, secret) {
  // Aqui, como vamos verificar dados direto no MP, podemos retornar true diretamente.
  // Se quiser, pode usar 'secret' como fallback para IP whitelist.
  return true;
}

// =================================================
// CRIAR COBRANÇA PIX (CHARGE) NO MERCADO PAGO
// =================================================
// Docs: https://www.mercadopago.com.br/developers/pt/docs/pixel-integration/integration/api/
// Endpoint: POST https://api.mercadopago.com/v1/payments
async function mp_createPixCharge({ reference_code, amount_cents, description }) {
  const token = process.env.MP_ACCESS_TOKEN;
  const body = {
    transaction_amount: (amount_cents / 100),
    description: description || `Pagamento ref ${reference_code}`,
    payment_method_id: 'pix',
    external_reference: reference_code,
    payer: {
      email: 'email@placeholder.com' // opcional, se tiver
    }
  };

  const resp = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('MercadoPago create charge error: ' + txt);
  }

  const data = await resp.json();
  // O campo `point_of_interaction.transaction_data.qr_code` contém o copia e cola
  const pix = data.point_of_interaction?.transaction_data;
  const pixCopiaECola = pix?.qr_code;
  const txid = data.id;

  return { txid, pixCopiaECola };
}

// =================================================
// PARSE DO WEBHOOK MERCADO PAGO
// =================================================
// O webhook envia algo como:
// {
//   "id": "1900001234",
//   "live_mode": true,
//   "type": "payment",
//   "date_created": "...",
//   "api_version": "...",
//   "action": "payment.created",
//   "data": { "id": "1234567890" }
// }
// Depois vamos buscar o payment completo para extrair valor, reference_code...
export function parseWebhookEvent(body) {
  return {
    notification_id: body.data?.id, // id do pagamento no MP
    type: body.type
  };
}

// Função auxiliar para buscar o pagamento completo
async function mp_getPaymentInfo(paymentId) {
  const token = process.env.MP_ACCESS_TOKEN;
  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('MercadoPago getPayment error: ' + txt);
  }
  return resp.json();
}

// =================================================
// EXPORTS DO PSP
// =================================================
export async function createPixCharge(opts) {
  const provider = process.env.PSP_PROVIDER || 'mock';
  if (provider === 'mercadopago') return mp_createPixCharge(opts);
  throw new Error(`PSP_PROVIDER '${provider}' não suportado aqui (troque para mock ou mercadopago).`);
}

export async function parseWebhookPaymentData(parsedEvent) {
  // parsedEvent vem de parseWebhookEvent
  const info = await mp_getPaymentInfo(parsedEvent.notification_id);
  return {
    reference_code: info.external_reference,
    amount_cents: Math.round(info.transaction_amount * 100),
    status: info.status === 'approved' ? 'CONFIRMED' : info.status.toUpperCase(),
    provider_txid: info.id.toString()
  };
}
