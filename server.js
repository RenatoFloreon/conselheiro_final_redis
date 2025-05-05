const express = require("express");
const app = express();
const axios = require("axios");
const { Redis } = require("@upstash/redis"); // Import Upstash Redis client
require("dotenv").config(); // Load environment variables from .env file

// --- Redis Client Initialization ---
// Get Redis credentials from environment variables (required for Vercel KV)
const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!redisUrl || !redisToken) {
  console.error("Erro Crítico: Variáveis de ambiente UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN são obrigatórias!");
  process.exit(1); // Exit if Redis credentials are missing
}

const redis = new Redis({
  url: redisUrl,
  token: redisToken,
});

console.log("Cliente Redis inicializado.");

// Axios instance configuration
const axiosInstance = axios.create({
  timeout: 30000, // 30 seconds
  maxContentLength: 20000000,
  maxBodyLength: 20000000,
  headers: {
    "Content-Type": "application/json",
    "OpenAI-Beta": "assistants=v2",
  },
});

// Health check endpoint
app.get("/health", (req, res) => res.status(200).send("OK"));

app.use(express.json());

// --- Constants ---
const MAX_ATTEMPTS = 15; // Max polling attempts for OpenAI run status
const POLLING_INTERVAL = 3000; // Milliseconds between polling attempts
const INITIAL_WAIT = 2000; // Milliseconds to wait before first poll
const THREAD_EXPIRATION_SECONDS = 12 * 60 * 60; // 12 hours in seconds

// --- WhatsApp Webhook Verification (GET) --- 
app.get("/webhook", (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (!verify_token) {
    console.error("VERIFY_TOKEN não definido nas variáveis de ambiente.");
    return res.sendStatus(500);
  }

  if (mode && token) {
    if (mode === "subscribe" && token === verify_token) {
      console.log("Webhook verificado com sucesso!");
      res.status(200).send(challenge);
    } else {
      console.warn("Falha na verificação do webhook: Token ou modo inválido.");
      res.sendStatus(403);
    }
  } else {
    console.warn("Falha na verificação do webhook: Modo ou token ausente.");
    res.sendStatus(400);
  }
});

// --- Helper Function to Send WhatsApp Messages --- 
async function sendWhatsAppMessage(token, phoneId, to, text) {
  console.log(`Tentando enviar mensagem para ${to}: \"${text.substring(0, 50)}...\"");
  try {
    await axiosInstance.post(
      `https://graph.facebook.com/v18.0/${phoneId}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 15000, // Add timeout for WhatsApp API call
      }
    );
    console.log(`Mensagem enviada com sucesso para ${to}.`);
  } catch (error) {
    console.error(
      `Erro ao enviar mensagem do WhatsApp para ${to}:`,
      error.response?.data || error.message
    );
    // Decide whether to throw or just log. Logging might be sufficient here.
    // throw error;
  }
}

// --- WhatsApp Message Handler (POST /webhook) --- 
app.post("/webhook", async (req, res) => {
  console.log("Recebido POST /webhook. Body:", JSON.stringify(req.body, null, 2)); // Log formatted body

  // Respond quickly to Meta's webhook test pings
  if (req.body.object === "whatsapp_business_account" && !req.body.entry) {
    console.log("Recebido ping de teste do webhook.");
    return res.sendStatus(200);
  }

  try {
    const body = req.body;
    // Validate payload structure
    if (
      body.object === "whatsapp_business_account" &&
      body.entry &&
      Array.isArray(body.entry) &&
      body.entry.length > 0 &&
      body.entry[0].changes &&
      Array.isArray(body.entry[0].changes) &&
      body.entry[0].changes.length > 0 &&
      body.entry[0].changes[0].value &&
      body.entry[0].changes[0].value.messages &&
      Array.isArray(body.entry[0].changes[0].value.messages) &&
      body.entry[0].changes[0].value.messages.length > 0
    ) {
      const message = body.entry[0].changes[0].value.messages[0];
      const from = message.from; // User's WhatsApp ID
      const text = message.text?.body?.trim() || ""; // Get message text, trim whitespace

      // Ignore messages without text content
      if (!text) {
        console.log(`Mensagem de ${from} sem conteúdo de texto recebida, ignorando.`);
        return res.sendStatus(200); // Acknowledge receipt
      }

      console.log(`Mensagem recebida de ${from}: \"${text}\"");

      // --- Get Environment Variables --- 
      const token = process.env.WHATSAPP_TOKEN;
      const phoneId = process.env.WHATSAPP_PHONE_ID;
      const openaiKey = process.env.OPENAI_API_KEY;
      const assistantId = process.env.OPENAI_ASSISTANT_ID; // Required
      const openaiOrganization = process.env.OPENAI_ORGANIZATION; // Optional
      const openaiProject = process.env.OPENAI_PROJECT; // Optional

      // Validate essential environment variables
      if (!token || !phoneId || !openaiKey || !assistantId) {
        console.error(
          "Erro Crítico: Variáveis de ambiente essenciais (WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, OPENAI_API_KEY, OPENAI_ASSISTANT_ID) não definidas!"
        );
        // Avoid sending specific error details back via webhook response if possible
        return res.sendStatus(500); // Internal Server Error
      }

      // --- Prepare OpenAI API Headers --- 
      const openaiHeaders = {
        Authorization: `Bearer ${openaiKey}`,
        "OpenAI-Beta": "assistants=v2",
        "Content-Type": "application/json", // Ensure content type is set
      };
      if (openaiOrganization) openaiHeaders["OpenAI-Organization"] = openaiOrganization;
      if (openaiProject) openaiHeaders["OpenAI-Project"] = openaiProject;

      let threadId;
      let isNewConversation = false;

      try {
        // --- Find Existing Thread using Redis --- 
        console.log(`Buscando thread para ${from} no Redis...`);
        const existingThreadId = await redis.get(from);

        if (!existingThreadId) {
          isNewConversation = true;
          console.log(`Nenhum thread ativo encontrado para ${from}. Iniciando nova conversa.`);

          // 1. Send initial automatic messages (ONLY for the very first message of a session)
          await sendWhatsAppMessage(
            token,
            phoneId,
            from,
            "Olá... Você conversará com uma IA experimental e podem haver erros."
          );
          // Add a small delay between messages if needed
          await new Promise((resolve) => setTimeout(resolve, 500));
          await sendWhatsAppMessage(
            token,
            phoneId,
            from,
            "Fique tranquilo(a) que seus dados estão protegidos, pois só consigo manter a memória da nossa conversa por 12 horas, depois o chat é reiniciado e os dados, apagados. Estamos processando a sua resposta…"
          );

          // 2. Create new OpenAI thread
          console.log("Criando novo thread OpenAI...");
          const threadRes = await axiosInstance.post(
            "https://api.openai.com/v1/threads",
            {},
            { headers: openaiHeaders, timeout: 15000 } // Add timeout
          );
          threadId = threadRes.data.id;
          console.log("Novo thread OpenAI criado:", threadId);

          // 3. Save thread to Redis with 12-hour expiration
          await redis.setex(from, THREAD_EXPIRATION_SECONDS, threadId);
          console.log(`Novo thread ${threadId} salvo no Redis para ${from} com expiração de 12h.`);

        } else {
          threadId = existingThreadId;
          console.log(`Continuando conversa existente para ${from} no thread ${threadId}`);
          // Optional: Update TTL if activity should reset the timer
          // await redis.expire(from, THREAD_EXPIRATION_SECONDS);
        }

        // --- Process User Message with OpenAI Assistant --- 
        console.log(`Adicionando mensagem ao thread ${threadId}: \"${text.substring(0, 100)}...\"");
        // 4. Add user message to the thread
        await axiosInstance.post(
          `https://api.openai.com/v1/threads/${threadId}/messages`,
          { role: "user", content: text },
          { headers: openaiHeaders, timeout: 15000 } // Add timeout
        );
        console.log(`Mensagem adicionada ao thread ${threadId}.`);

        // 5. Create a run for the assistant to process the message
        console.log(`Criando run para thread ${threadId} com assistente ${assistantId}`);
        const runRes = await axiosInstance.post(
          `https://api.openai.com/v1/threads/${threadId}/runs`,
          { assistant_id: assistantId },
          { headers: openaiHeaders, timeout: 15000 } // Add timeout
        );
        const runId = runRes.data.id;
        console.log(`Run ${runId} criado com sucesso. Status inicial: ${runRes.data.status}`);

        // 6. Poll for run completion status
        let runStatus = runRes.data.status;
        let runResultData = runRes.data; // Store initial run data
        let attempts = 0;

        // Wait briefly before starting to poll
        await new Promise((resolve) => setTimeout(resolve, INITIAL_WAIT));

        while (
          ["queued", "in_progress", "cancelling"].includes(runStatus) &&
          attempts < MAX_ATTEMPTS
        ) {
          attempts++;
          console.log(
            `[${attempts}/${MAX_ATTEMPTS}] Verificando status do run ${runId}... Status atual: ${runStatus}`
          );
          await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL));

          try {
            const runCheckRes = await axiosInstance.get(
              `https://api.openai.com/v1/threads/${threadId}/runs/${runId}`,
              {
                headers: openaiHeaders,
                timeout: 10000, // Timeout for polling request
              }
            );
            runResultData = runCheckRes.data; // Update with latest data
            runStatus = runResultData.status;
            console.log(`Status atualizado do run ${runId}: ${runStatus}.`);

            // Check for terminal states within the loop
            if (
              ["completed", "requires_action", "expired", "failed", "cancelled"].includes(
                runStatus
              )
            ) {
              console.log(`Run ${runId} atingiu o estado terminal: ${runStatus}.`);
              break; // Exit polling loop
            }
          } catch (e) {
            console.error(`Erro durante polling do run ${runId} (tentativa ${attempts}):`, {
              message: e.message,
              status: e.response?.status,
              data: e.response?.data,
            });
            // Specific handling for rate limits
            if (e.response?.status === 429) {
              console.log(
                "Rate limit (429) atingido durante polling, esperando 5 segundos extras..."
              );
              await new Promise((resolve) => setTimeout(resolve, 5000));
            }
            // Optional: break loop on persistent errors other than 429?
            // if (attempts > 5 && e.response?.status !== 429) { break; }
          }
        } // End polling loop

        console.log(
          `Polling finalizado para run ${runId}. Status final: ${runStatus}. Tentativas: ${attempts}`
        );

        // 7. Retrieve Assistant's Response and Send to WhatsApp
        let gptResponse =
          "Desculpe, ocorreu um problema e não consegui processar sua solicitação no momento. Por favor, tente novamente."; // Default error message

        if (runStatus === "completed") {
          try {
            console.log(`Run ${runId} completo. Buscando mensagens do thread ${threadId}...`);
            const messagesRes = await axiosInstance.get(
              // Fetch messages added *after* the user's last message (more reliable than just limit=1)
              `https://api.openai.com/v1/threads/${threadId}/messages?order=desc`,
              { headers: openaiHeaders, timeout: 15000 } // Add timeout
            );

            const messages = messagesRes.data.data;
            console.log(`Encontradas ${messages.length} mensagens no thread ${threadId}.`);

            // Find the latest assistant message associated with this run
            const lastAssistantMessage = messages.find(
              (m) => m.run_id === runId && m.role === "assistant"
            );

            if (
              lastAssistantMessage &&
              Array.isArray(lastAssistantMessage.content) &&
              lastAssistantMessage.content[0]?.type === "text"
            ) {
              gptResponse = lastAssistantMessage.content[0].text.value;
              console.log(
                `Resposta do assistente (run ${runId}) encontrada: \"${gptResponse.substring(
                  0,
                  100
                )}...\"`
              );
            } else {
              console.warn(
                `Nenhuma mensagem de texto do assistente encontrada para o run ${runId} no thread ${threadId}. Verificando mensagens:`,
                JSON.stringify(messages, null, 2)
              );
              // Keep the default error message
            }
          } catch (e) {
            console.error(
              `Erro ao buscar mensagens do thread ${threadId} após run completo:`,
              e.response?.data || e.message
            );
            // Keep the default error message
          }
        } else {
          // Handle non-completed run statuses
          console.error(
            `Run ${runId} não completou com sucesso. Status final: ${runStatus}. Detalhes:`,
            JSON.stringify(runResultData || {}, null, 2)
          );
          const lastError = runResultData?.last_error;
          if (runStatus === "failed" && lastError) {
            gptResponse = `Desculpe, a solicitação falhou (${lastError.code || "Erro"}). Tente reformular sua pergunta.`; // Provide slightly more info if available
          } else if (runStatus === "expired") {
            gptResponse =
              "Desculpe, a solicitação demorou muito e expirou. Por favor, tente novamente.";
          } else if (runStatus === "cancelled") {
            gptResponse = "A solicitação foi cancelada.";
          } else if (runStatus === "requires_action") {
            gptResponse =
              "Desculpe, a solicitação requer uma ação adicional que não posso realizar no momento.";
          } else {
            // e.g., timed out polling
            gptResponse = `Desculpe, não foi possível obter a resposta a tempo (Status: ${runStatus}). Por favor, tente novamente.`;
          }
        }

        // 8. Send the final response (GPT's or error message) to WhatsApp
        await sendWhatsAppMessage(token, phoneId, from, gptResponse);

      } catch (error) {
        // Catch errors during Redis, OpenAI interaction or thread management logic
        console.error(
          `Erro principal no processamento da mensagem de ${from}:`,
          error.response?.data || error.message,
          error.stack
        );
        // Send a generic error message back to the user if possible
        try {
          await sendWhatsAppMessage(
            token,
            phoneId,
            from,
            "Ocorreu um erro inesperado ao processar sua mensagem. A equipe técnica foi notificada. Por favor, tente novamente mais tarde."
          );
        } catch (sendError) {
          console.error(`Falha ao enviar mensagem de erro para ${from}:`, sendError.message);
        }
      }
    } else {
      // Log if the payload structure is not what we expect
      console.warn(
        "Payload recebido não é uma mensagem válida do WhatsApp ou possui formato inesperado. Ignorando."
      );
      console.warn("Payload detalhado:", JSON.stringify(req.body, null, 2));
    }

    // Always respond with 200 OK to acknowledge receipt of the webhook to Meta
    res.sendStatus(200);

  } catch (e) {
    // Catch unexpected errors in the main webhook processing logic (e.g., JSON parsing issues)
    console.error("Erro crítico não tratado no processamento do webhook:", e.message, e.stack);
    // Avoid sending response if headers already sent
    if (!res.headersSent) {
      res.sendStatus(500); // Internal Server Error
    }
  }
});

// --- Start Server --- 
// The Vercel environment will manage the port, but this is good for local testing
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== "production") { // Only run listen locally, Vercel handles it in production
  app.listen(PORT, () => {
    console.log(`Servidor rodando localmente na porta ${PORT}`);
  });
}

// Export the app for Vercel
module.exports = app;

