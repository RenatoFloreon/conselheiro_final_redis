require('dotenv').config();               // Carrega as variáveis do .env

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());                  // Middleware para interpretar JSON do webhook

// Configurações sensíveis via env:
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;                 // Token de verificação do webhook (definido no portal da Meta)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;             // Token de acesso (Bearer) da API WhatsApp
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;                // ID do número de telefone do WhatsApp
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;             // Chave da API OpenAI
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4';      // Modelo da OpenAI (padrão GPT-4)

// Armazenamento de contexto de conversa em memória (chave: número do usuário, valor: array de mensagens)
const userContexts = {};

// Endpoint de verificação do webhook (GET)
// Usado pela Meta para validar a URL do webhook usando o VERIFY_TOKEN
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log("Webhook verificado com sucesso.");
        return res.status(200).send(challenge);  // Retorna o desafio de volta para confirmar
    } else {
        return res.sendStatus(403);
    }
});

// Endpoint de recebimento de mensagens do webhook (POST)
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        // Confirma que é um evento de mensagens do WhatsApp
        if (body.object === 'whatsapp_business_account') {
            const entry = body.entry?.[0];                // Pega a primeira entrada
            const changes = entry?.changes?.[0];          // Pega a primeira alteração
            const value = changes?.value;
            const messages = value?.messages;
            if (messages && messages.length > 0) {
                // Dados da mensagem recebida
                const msg = messages[0];
                const from = msg.from;                   // número do usuário que enviou (Whatsapp ID)
                const msgBody = msg.text?.body || '';    // corpo da mensagem de texto

                console.log(`Mensagem recebida de ${from}: ${msgBody}`);

                // 1. Responde imediatamente ao usuário no WhatsApp indicando processamento
                const thinkingReply = "Estou pensando na sua resposta…";
                sendWhatsAppMessage(from, thinkingReply).catch(err => console.error("Erro ao enviar pensando:", err));
                console.log("Resposta imediata de 'pensando...' enviada ao usuário.");

                // 2. Atualiza contexto do usuário com a mensagem recebida
                if (!userContexts[from]) {
                    userContexts[from] = [];  // inicia contexto se não existir
                }
                userContexts[from].push({ role: 'user', content: msgBody });

                // 3. Gera resposta via OpenAI GPT-4
                const aiResponse = await getAIResponse(from);
                
                // 4. Envia a resposta da IA de volta pelo WhatsApp
                if (aiResponse) {
                    await sendWhatsAppMessage(from, aiResponse);
                    console.log("Resposta da IA enviada ao usuário:", aiResponse);
                    // Armazena resposta no contexto para futuras interações
                    userContexts[from].push({ role: 'assistant', content: aiResponse });
                }
            }
        }
        // Importante: responda o webhook imediatamente para evitar reenvio
        res.sendStatus(200);
    } catch (err) {
        console.error("Erro no processamento do webhook:", err);
        res.sendStatus(500);
    }
});

// Função auxiliar: enviar mensagem de texto via WhatsApp Cloud API
async function sendWhatsAppMessage(toNumber, message) {
    const url = `https://graph.facebook.com/v17.0/${PHONE_ID}/messages`;  // endpoint da API (v17.0 ou superior)
    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toNumber,
        text: { body: message }
    };
    const config = {
        headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
        }
    };
    // Chama a API do WhatsApp para enviar a mensagem
    const response = await axios.post(url, payload, config);
    return response.data;
}

// Função auxiliar: gerar resposta da IA via OpenAI API (GPT-4)
async function getAIResponse(userNumber) {
    if (!OPENAI_API_KEY) {
        console.error("Chave da API OpenAI não configurada.");
        return null;
    }
    // Monta a lista de mensagens de contexto para enviar à OpenAI (inclui histórico)
    const messages = [];
    // (Opcional) Mensagem de sistema definindo o comportamento do assistente
    messages.push({ role: 'system', content: 'Você é um assistente útil e conciso que responde em português.' });
    // Insere histórico do usuário (se existir) seguido da nova mensagem do usuário
    const userHistory = userContexts[userNumber] || [];
    messages.push(...userHistory);

    // Configura payload da requisição de chat
    const payload = {
        model: OPENAI_MODEL,
        messages: messages,
        temperature: 0.7 // ajusta a criatividade conforme necessidade
    };
    const config = {
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        }
    };
    // Chama a API de chat da OpenAI (GPT-4)
    try {
        const apiRes = await axios.post('https://api.openai.com/v1/chat/completions', payload, config);
        const aiMessage = apiRes.data.choices[0].message.content;
        return aiMessage;
    } catch (error) {
        console.error("Erro da API OpenAI:", error.response?.data || error.message);
        return "Desculpe, tive um problema para gerar a resposta.";
    }
}

// Inicia o servidor 
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
