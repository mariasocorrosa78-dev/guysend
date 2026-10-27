# Bot Discord com MongoDB

Bot Discord que gerencia usernames de usuários no MongoDB.

## 🚀 Instalação

1. **Instale as dependências:**
```bash
npm install
```

2. **Configure as variáveis de ambiente no arquivo `.env`:**
```
DISCORD_TOKEN=seu_token_discord_aqui
MONGODB_URI=sua_uri_mongodb_aqui
```

### Como obter o Token do Discord:
1. Acesse [Discord Developer Portal](https://discord.com/developers/applications)
2. Crie uma nova aplicação
3. Vá em "Bot" e clique em "Add Bot"
4. Copie o token em "TOKEN"
5. Ative as "Gateway Intents" necessárias

### Como obter a URI do MongoDB:
1. Acesse [MongoDB Atlas](https://cloud.mongodb.com)
2. Vá em "Databases" → "Connect"
3. Escolha "Drivers" e copie a connection string
4. Substitua `<password>` pela sua senha

## 📝 Comandos

### `/setusername id`
Busca um usuário pelo ID no MongoDB e altera seu username.

**Opções:**
- `user_id` (obrigatório): ID do usuário no MongoDB
- `novo_username` (obrigatório): Novo username

**Exemplo:**
```
/setusername id user_id:123456 novo_username:NovoNome
```

### `/setusername username`
Busca um usuário pelo username atual e altera para um novo.

**Opções:**
- `username_atual` (obrigatório): Username atual do usuário
- `novo_username` (obrigatório): Novo username

**Exemplo:**
```
/setusername username username_atual:NomeAntigo novo_username:NovoNome
```

## 🗄️ Estrutura do MongoDB

O bot espera uma coleção `Users` com documentos no seguinte formato:

```json
{
  "id": "123456",
  "username": "NomeDoUsuário",
  ...outros campos
}
```

## ▶️ Executar o Bot

```bash
npm start
```

O bot se conectará ao MongoDB e ao Discord, registrando os slash commands automaticamente.

## 📋 Requisitos

- Node.js 16+
- Conta Discord
- Cluster MongoDB Atlas
- Token do Bot Discord
- URI de conexão MongoDB

## ⚠️ Notas Importantes

- O bot precisa de permissão para usar slash commands no servidor
- Os dados são buscados e atualizados em tempo real no MongoDB
- As respostas são ephemeral (visíveis apenas para quem executou o comando)
