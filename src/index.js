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
 * ⬅️ MUDE AQUI O VALOR (centavos)
 *   500 = R$ 5,00 (produção)
 *     1 = R$ 0,01 (teste)
 */
const AMOUNT_CENTS = 500; // ⬅️ MUDE AQUI O VALOR
const PRICE_BR = (AMOUNT_CENTS / 100).toFixed(2);

const {
  DISCORD_TOKEN, GUILD_ID, ROLE_ID, PORT, WEBHOOK_SECRET
} = process.env;

// ---------------------------
// Discord Client + Diagnóstico
// ---------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // necessário para atribuir cargo
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

// DEBUG detalhado do gateway (útil para ver conexão/ready)
client.on('debug', (m) => console.log('[discord.js debug]', m));
client.on('error', (e) => console.error('Discord client error:', e));
client.on('shardError', (e) => console.error('WebSocket shard error:', e));
client.on('ready', () => {
  console.log(`Bot online como ${client.user.tag}`);
});

// ---------------------------
// Slash commands
// ---------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Comando simples para testar conectividade
  if (interaction.commandName === 'ping') {
    try {
      await interaction.reply({ content: 'pong 🏓', ephemeral: true });
    } catch (e) {
      console.error('Erro no /ping:', e);
    }
    return;
  }

  // Fluxo principal: /join
  if (interaction.commandName !== 'join') return;

  const nickname = interaction.options.getString('nickname', true);
  const discord_user_id = interaction.user.id;

  // 1) ACK imediato (evita "O aplicativo não respondeu")
  await interaction.reply({
    content: `🔄 Recebi seu pedido! Vou gerar seu PIX (R$ ${PRICE_BR}) e te enviar por DM em instantes.`,
    ephemeral: true
  });

  // 2) Processa tudo em background
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

  // Cria a cobrança PIX (pode demorar alguns segundos)
  const { txid, pixCopiaECola } = await createPixCharge({
    reference_code,
    amount_cents: AMOUNT_CENTS,
    description: `Ingresso evento - ${nickname}`
  });

  // Persiste pagamento como pending
  createPayment({
    reference_code,
    discord_user_id,
    nickname,
    amount_cents: AMOUNT_CENTS,
    created_at: new Date().toISOString()
  });

  // Gera QR (se falhar, segue só com copia-e-cola)
  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(pixCopiaECola);
  } catch (e) {
    console.warn('Falha ao gerar QR; enviaremos só o copia-e-cola:', e);
  }

  // Envio por DM
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

  // Feedback no canal (ephemeral)
  if (dmSent) {
    await interaction.followUp({
      content: '✅ Te enviei a cobrança por DM. Se não aparecer, verifica as DMs comigo.',
      ephemeral: true
    });
  } else {
    await interaction.followUp({
      content:
`⚠️ Não consegui enviar por DM (provavelmente bloqueada). Segue aqui mesmo:

**Referência:** \`${reference_code}\`

**Copia e Cola PIX (R$ ${PRICE_BR}):**
\`\`\`${pixCopiaECola}\`\`\``,
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

// ---------------------------
// Express + Webhook (Mercado Pago)
// ---------------------------
const app = express();

// Capturar body cru (para PSPs que usam HMAC do raw body)
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

app.post('/webhook/psp', async (req, res) => {
  try {
    // Validação leve; no MP validamos consultando a API depois
    const valid = validateWebhookSignature(req, WEBHOOK_SECRET);
    if (!valid) {
      console.warn('Webhook com assinatura inválida (seguiremos validando na API do PSP)');
    }

    // 1) Parse "cru" do webhook -> pega o ID do pagamento/notificação
    const event = parseWebhookEvent(req.body);

    // 2) Busca dados completos no MP e normaliza
    const { reference_code, status, amount_cents, provider_txid } =
      await parseWebhookPaymentData(event);

    if (!reference_code) {
      console.warn('Webhook sem reference_code — ignorando.');
      return res.status(200).send('ok');
    }

    // 3) Busca pagamento local
    const payment = getPaymentByReference(reference_code);
    if (!payment) {
      console.warn('Pagamento não encontrado p/ ref', reference_code);
      return res.status(200).send('ok');
    }

    // Idempotência
    if (payment.status === 'paid') return res.status(200).send('ok');

    // 4) Validação de status + valor
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

// ---------------------------
// Login com diagnóstico (NÃO REMOVA)
// ---------------------------
const TOKEN = (process.env.DISCORD_TOKEN || '').trim();

if (!TOKEN) {
  console.error('DISCORD_TOKEN ausente ou vazio');
  process.exit(1);
} else {
  console.log(`Iniciando login… tokenLength=${TOKEN.length}`);
}

client.login(TOKEN).catch((e) => {
  console.error('Falha ao logar no Discord:', e);
  process.exit(1);
});

// Watchdog: alerta se não ficar READY em 30s
setTimeout(() => {
  if (!client.isReady?.()) {
    console.warn('⚠️ Ainda não ficou READY após 30s — veja logs [discord.js debug] acima.');
  }
}, 30000);
