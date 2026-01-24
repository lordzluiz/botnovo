import { iniciarWhatsApp, normalizarNumero } from "./whatsapp.js";

const sock = await iniciarWhatsApp();

// ⚠️ USE UM NÚMERO DIFERENTE DO WHATSAPP LOGADO
const NUMERO_DESTINO = "5534999833831"; // TROQUE AQUI

let enviado = false;

sock.ev.on("connection.update", async (update) => {
  const { connection } = update;

  if (connection === "open" && !enviado) {
    enviado = true;

    console.log("🚀 Conectado. Enviando mensagem de teste...");

    const jid = normalizarNumero(NUMERO_DESTINO);

    await sock.sendMessage(jid, {
      text: "✅ Teste FINAL Baileys — mensagem entregue!"
    });

    console.log("📤 Mensagem enviada com sucesso");
  }
});

// mantém o processo vivo
setTimeout(() => {}, 60000);


