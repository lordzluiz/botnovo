import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import Pino from "pino";
import qrcode from "qrcode-terminal";

let reconectando = false;

function logErro(codigo, mensagem, err) {
  const payload = {
    level: "error",
    code: codigo,
    message: mensagem
  };

  if (err) {
    payload.error = err?.message || String(err);
  }

  console.error(JSON.stringify(payload));
}

export async function iniciarWhatsApp(options = {}) {
  const { onReconnect, onConnectionUpdate } = options;
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

      if (shouldReconnect && !reconectando) {
        reconectando = true;
        (async () => {
          try {
            const novoSock = await iniciarWhatsApp(options);
            onReconnect?.(novoSock);
          } catch (err) {
            logErro("PMB-010", "Falha ao reconectar com Baileys.", err);
          } finally {
            reconectando = false;
          }
        })();
      }
    }

    onConnectionUpdate?.(update, sock);
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
