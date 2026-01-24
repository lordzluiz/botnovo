import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import Pino from "pino";
import qrcode from "qrcode-terminal";

export async function iniciarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_baileys");

  const sock = makeWASocket({
    auth: state,
    logger: Pino({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📲 Escaneie o QR Code abaixo:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("🤖 Baileys conectado com sucesso!");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log("⚠️ Conexão fechada. Reconectar:", shouldReconnect);

      if (shouldReconnect) {
        iniciarWhatsApp();
      }
    }
  });

  return sock;
}

export function normalizarNumero(numero) {
  let n = numero.replace(/\D/g, "");

  if (!n.startsWith("55")) {
    n = "55" + n;
  }

  return `${n}@s.whatsapp.net`;
}

