# Discord PIX Bot (Render)

Fluxo: `/join <nickname>` → gera cobrança PIX → envia DM com QR + copia/cola → webhook confirma → atribui cargo.

## 1) Pré-requisitos
- Node 18+
- Um servidor Discord onde você tem permissão para adicionar o bot e gerenciar cargos
- No cargo do bot, ele precisa estar **acima** do cargo que será atribuído
- (opcional) PSP real com webhook; para testes use `PSP_PROVIDER=mock`

## 2) Configuração local
1. `cp .env.example .env` e preencha:
   - `DISCORD_TOKEN`, `DISCORD_APP_ID`, `GUILD_ID`, `ROLE_ID`
   - `PSP_PROVIDER=mock` (teste)
   - `PORT=10000`
2. Instale deps: `npm i`
3. Publique o slash command uma vez: `npm run deploy:commands`
4. Suba local: `npm start`

## 3) Teste local (mock)
- No Discord, use `/join nickname: TESTE`
- O bot te envia DM com QR (falso) e copia/cola
- Confirme pagamento mock:
```bash
curl -X POST http://localhost:10000/admin/mock/confirm \
  -H "Content-Type: application/json" \
  -d '{"ref":"<REFERENCE_CODE_DO_USUARIO>"}'
