import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Participar do evento (gera PIX de R$5,00)')
    .addStringOption(opt =>
      opt.setName('nickname')
        .setDescription('Seu nickname/ID para a liberação')
        .setRequired(true)
    )
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_APP_ID, process.env.GUILD_ID),
      { body: commands }
    );
    console.log('Slash command /join publicado.');
  } catch (e) {
    console.error('Erro ao publicar comandos:', e);
    process.exit(1);
  }
})();
