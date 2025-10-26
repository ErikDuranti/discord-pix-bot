// src/index.js
import 'dotenv/config';
import express from 'express';
import rawBody from 'raw-body';
import QRCode from 'qrcode';
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits
} from 'discord.js';

import {
  createPayment,
  getPaymentByReference,
  markPaid
} from './db.js';

import {
  createPixCharge,
  validateWebhookSignature,
  parseWebhookEvent,
  parseWebhookPaymentData
} from './psp.js';

/**
 * ==========================================================
 * CONFIGURAÇÃO DE PREÇO
 * ==========================================================
 * ⬅️ MUDE AQUI O VALOR
 * Valor em centavos (AMOUNT_CENTS):
 *   500 = R$ 5,00 (produção)
 *     1 = R$ 0,01 (teste)
 */
const AMOUNT_CENTS = 1; // ⬅️ MUDE AQUI O VALOR
const PRICE_BR = (AMOUNT_CENTS / 100).toFixed(2);

const {
  DISCORD_TOKEN, GUILD_ID, ROLE_ID, PORT, WEBHOOK_SECRET
} = process.env;

// ---- Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // atribuir cargo
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

client.once('ready', () => {
  console.log(`Bot online como ${client.user.tag}`);
});

// ==========================
// Handler do /join
// ==========================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'join') return;

  const nickname = interaction.options.getString('nickname', true);
  const discord_user_id = interaction.user.id;

  // 1) ACK instantâneo para não estourar timeout de 3s
  await interaction.reply({
    content: `🔄 Recebi seu pedido! Vou gerar seu PIX (R$ ${PRICE_BR}) e te enviar por DM em instantes.`,
    ephemeral: true
  });

  // 2) Processa em background
  processJoin(interaction, { nickname, discord_user_id }).catch(async (err) => {
    console.error('processJoin error:', err);
    try {
      await interaction.followUp({
        content: '❌ Ocorreu um erro ao gerar sua cobrança. Tente novamente.',
        ephemeral: true
      });
    } catch {}
  });
});

async function processJoin(interaction, { nickname, discord_user_id }) {
  const reference_code = `EVT5-${Date.now().toString(36)}-${discord_user_id.slice(-4)}`;

  // 3) Cria a cobrança PIX (Mercado Pago) — pode levar alguns segundos
  const { txid, pixCopiaECola } = await createPixCharge({
    reference_code,
    amount_cents: AMOUNT_CENTS, // usa a constante configurável
    description: `Ingresso evento - ${nickname}`
  });

  // 4) Persiste pagamento como pending
  createPayment({
    reference_code,
    discord_user_id,
    nickname,
    amount_cents: AMOUNT_CENTS,
    created_at: new Date().toISOString()
  });

  // 5) Gera QR (não bloqueante — mas pode levar ~300–600ms)
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(pixCopiaECola);
  } catch (e) {
    console.warn('Falha ao gerar QR, vamos enviar só o copia-e-cola:', e);
  }

  // 6) Tenta DM
  let dmSent = false;
  try {
    const dm = await interaction.user.createDM();
    const header =
`Olá, **${nickname}**! Aqui está seu PIX (R$ ${PRICE_BR}).
**Referência:** \`${reference_code}\`
Pague e aguarde a confirmação automática.`;

    await dm.send({ content: header });
    if (qrDataUrl) {
      await dm.send({ files: [{ attachment: qrDataUrl, name: `pix_${reference_code}.png` }] });
    }
    await dm.send({ content: `**Copia e Cola PIX:**\n\`\`\`${pixCopiaECola}\`\`\`` });
    dmSent = true;
  } catch (e) {
    console.warn('DM bloqueada ou falhou:', e);
  }

  // 7) Feedback no canal (ephemeral)
  if (dmSent) {
    await interaction.followUp({
      content: '✅ Te enviei a cobrança por DM. Se não aparecer, verifica as DMs comigo.',
      ephemeral: true
    });
  } else {
    // fallback: envia tudo no canal (ephemeral)
    const parts = [
      `⚠️ Não consegui enviar por DM (provavelmente bloqueada). Segue aqui mesmo:`,
      `**Referência:** \`${reference_code}\``,
      `**Copia e Cola PIX (R$ ${PRICE_BR}):**\n\`\`\`${pixCopiaECola}\`\`\``
    ];
    await interaction.followUp({
      content: parts.join('\n\n'),
      ephemeral: true
    });
    if (qrDataUrl) {
      await interaction.followUp({
        content: 'QR Code:',
        files: [{ attachment: qrDataUrl, name: `pix_${reference_code}.png` }],
        ephemeral: true
      });
    }
  }
}

// ==========================
// Express + Webhook
// ==========================
const app = express();

// capturar corpo cru (alguns PSPs usam HMAC do raw body)
app.use(async (req, _res, next) => {
  try {
    req.rawBody = await rawBody(req);
  } catch {
    req.rawBody = Buffer.alloc(0);
  }
  next();
});
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/', (_req, res) => res.send('OK'));

// Webhook Mercado Pago
app.post('/webhook/psp', async (req, res) => {
  try {
    // Validação leve — no MP vamos conferir na API oficial depois
    const valid = validateWebhookSignature(req, WEBHOOK_SECRET);
    if (!valid) {
      console.warn('Webhook com assinatura inválida (ignorado)');
      // seguimos mesmo assim, pois vamos validar consultando o pagamento
    }

    // 1) Parse do webhook "cru" (pega o ID da notificação/pagamento)
    const event = parseWebhookEvent(req.body);

    // 2) Busca os dados do pagamento no MP e normaliza
    const { reference_code, status, amount_cents, provider_txid } =
      await parseWebhookPaymentData(event);

    if (!reference_code) {
      console.warn('Webhook sem reference_code — ignorando.');
      return res.status(200).send('ok');
    }

    // 3) Localiza pagamento
    const payment = getPaymentByReference(reference_code);
    if (!payment) {
      console.warn('Pagamento não encontrado p/ referência', reference_code);
      return res.status(200).send('ok');
    }

    // idempotência
    if (payment.status === 'paid') return res.status(200).send('ok');

    // 4) Validação de valor + status
    if (status === 'CONFIRMED' && Number(amount_cents) === Number(AMOUNT_CENTS)) {
      markPaid(reference_code, provider_txid);

      // 5) Atribuir cargo no Discord
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(payment.discord_user_id);

        const me = await guild.members.fetchMe();
        const canManage = me.permissions.has(PermissionFlagsBits.ManageRoles);
        if (canManage) {
          await member.roles.add(ROLE_ID);
        } else {
          console.error('Bot sem permissão Manage Roles.');
        }

        const user = await client.users.fetch(payment.discord_user_id);
        await user.send(`✅ Pagamento confirmado! Cargo atribuído no servidor **${guild.name}**. Bom evento!`);
      } catch (e) {
        console.error('Erro ao atribuir cargo/DM:', e);
      }

      return res.status(200).send('ok');
    }

    // valor divergente ou status não confirmado
    console.warn('Pagamento ignorado por status/valor:', { status, amount_cents });
    return res.status(200).send('ok');
  } catch (e) {
    console.error('Erro webhook:', e);
    return res.status(200).send('ok');
  }
});

app.listen(Number(PORT || 10000), () => {
  console.log(`HTTP ouvindo em :${PORT || 10000}`);
});

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN ausente no .env');
  process.exit(1);
}

(async () => {
  try {
    await client.login(DISCORD_TOKEN);
  } catch (e) {
    console.error('Falha ao logar no Discord:', e);
    process.exit(1);
  }
})();
