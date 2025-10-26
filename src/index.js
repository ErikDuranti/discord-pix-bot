import 'dotenv/config';
import express from 'express';
import rawBody from 'raw-body';
import QRCode from 'qrcode';
import { Client, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import { createPayment, getPaymentByReference, markPaid } from './db.js';
import { createPixCharge, validateWebhookSignature, parseWebhookEvent } from './psp.js';

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

// ---- Slash command handler
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'join') return;

  const nickname = interaction.options.getString('nickname', true);
  const discord_user_id = interaction.user.id;

  // 👉 Responde imediatamente para não estourar o timeout do Discord
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (e) {
    console.error('Falha ao deferReply:', e);
    return; // sem defer nem reply, não há o que fazer
  }

  const reference_code = `EVT5-${Date.now().toString(36)}-${discord_user_id.slice(-4)}`;

  try {
    // 1) Criar cobrança PIX no PSP (pode demorar alguns segundos)
    const { txid, pixCopiaECola } = await createPixCharge({
      reference_code,
      amount_cents: 500,
      description: `Ingresso evento - ${nickname}`
    });

    // 2) Persistir pagamento
    createPayment({
      reference_code,
      discord_user_id,
      nickname,
      amount_cents: 500,
      created_at: new Date().toISOString()
    });

    // 3) Gerar QR
    const qrDataUrl = await QRCode.toDataURL(pixCopiaECola);

    // 4) Tentar DM
    try {
      const dm = await interaction.user.createDM();
      await dm.send({
        content:
`Olá, **${nickname}**! Aqui está seu PIX (R$ 5,00).
**Referência:** \`${reference_code}\`
Pague e aguarde a confirmação automática (você será notificado aqui).`,
        files: [{ attachment: qrDataUrl, name: `pix_${reference_code}.png` }]
      });
      await dm.send({ content: `**Copia e Cola PIX:**\n\`\`\`${pixCopiaECola}\`\`\`` });

      await interaction.editReply('✅ Enviei o PIX por DM. Se não recebeu, habilite DMs e use o comando novamente.');
    } catch {
      await interaction.editReply('⚠️ Não consegui enviar DM (provavelmente bloqueada). Habilite DMs comigo e use o comando novamente.');
    }

  } catch (err) {
    console.error('Erro no /join:', err);
    try {
      await interaction.editReply('❌ Falha ao gerar cobrança. Tente novamente.');
    } catch {}
  }
});
// ---- Express + Webhook
const app = express();

// Capturar corpo cru para HMAC
app.use(async (req, res, next) => {
  try {
    req.rawBody = await rawBody(req);
  } catch {
    req.rawBody = Buffer.alloc(0);
  }
  next();
});
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

app.get('/', (_req, res) => res.send('OK'));

// Webhook do PSP
app.post('/webhook/psp', async (req, res) => {
  try {
    // Se quiser relaxar no mock, pode pular esta validação.
    const valid = validateWebhookSignature(req, WEBHOOK_SECRET);
    if (!valid && process.env.PSP_PROVIDER !== 'mock') {
      console.warn('Webhook assinatura inválida');
      return res.status(400).send('invalid signature');
    }

    const event = parseWebhookEvent(req.body); 
    const { reference_code, status, amount_cents, provider_txid } = await parseWebhookPaymentData(event);

    const payment = getPaymentByReference(reference_code);
    if (!payment) return res.status(200).send('ok');

    if (payment.status === 'paid') return res.status(200).send('ok');

    if (status === 'CONFIRMED' && Number(amount_cents) === 500) {
      markPaid(reference_code, provider_txid);

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

    return res.status(200).send('ignored');
  } catch (e) {
    console.error('Erro webhook:', e);
    return res.status(200).send('ok');
  }
});

// Endpoint MOCK para confirmar pagamento manualmente (apenas DEV)
app.post('/admin/mock/confirm', (req, res) => {
  if (process.env.PSP_PROVIDER !== 'mock') return res.status(403).send('forbidden');
  const { ref, txid = 'MOCK-TX', amount_cents = 500 } = req.body || {};
  // Simula o POST do PSP
  // Você pode bater com: curl -X POST .../admin/mock/confirm -H "Content-Type: application/json" -d '{"ref":"EVT5-..."}'
  req.body = { ref, txid, amount_cents, status: 'CONFIRMED' };
  // Reencaminha para o webhook oficial
  return app._router.handle({ ...req, url: '/webhook/psp' }, res, () => {});
});

app.listen(Number(PORT || 10000), () => {
  console.log(`HTTP ouvindo em :${PORT}`);
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
