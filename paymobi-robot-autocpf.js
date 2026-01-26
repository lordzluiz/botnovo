// paymobi-robot-autocpf.js v3.1-mod — mantém criação do JSON igual ao original, agora sobrescreve um único arquivo "boletos.json"
// Agora compatível com qualquer CPF e salvando todas as parcelas (gera apenas 1 JSON: boletos.json)

import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const AUTH_URL = "https://paymobi-fin-api.azurewebsites.net/users/auth";
const SEARCH_URL = "https://paymobi-fin-api.azurewebsites.net/installments/search";

// 🔐 Credenciais da PayMobi
const EMAIL = "acellserra@gmail.com";
const SENHA = "38330031(fOs)";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ERROR_CODES = {
  CPF_MISSING: "PMB-001",
  AUTH_REQUEST_FAILED: "PMB-002",
  TOKEN_MISSING: "PMB-003",
  SEARCH_REQUEST_FAILED: "PMB-004",
  OUTPUT_WRITE_FAILED: "PMB-005",
  UNEXPECTED: "PMB-999",
};

const logError = (code, message, details) => {
  const suffix = details ? ` | detalhes: ${details}` : "";
  console.error(`❌ [${code}] ${message}${suffix}`);
};

// 📄 CPF vindo por argumento
const CPF = (process.argv[2] || "").replace(/\D/g, "");
if (!CPF) {
  logError(ERROR_CODES.CPF_MISSING, "CPF não informado. Use: node paymobi-robot-autocpf.js <cpf>");
  process.exit(1);
}

// 🗂️ Arquivos de saída
const LINK_FILE = path.resolve(__dirname, "link_boleto.txt");
// <<< Alteração solicitada: único arquivo JSON constante que será sobrescrito a cada execução
const JSON_FILE = path.resolve(__dirname, `boletos.json`);

// 🕒 Função utilitária de data
const formatDate = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
};

// Detecta status de boleto aberto ou pendente
const isAberto = (status) => /(pendente|pending|a receber|em aberto|vencido|unpaid)/i.test(status || "");

(async () => {
  console.log(`🚀 Iniciando busca de boletos via API PayMobi para CPF ${CPF}...\n`);

  try {
    // 1️⃣ Login e obtenção do token
    console.log("🔐 Solicitando token JWT via Basic Auth...");
    const basicAuth = Buffer.from(`${EMAIL}:${SENHA}`).toString("base64");
    let authResponse;
    try {
      authResponse = await axios.get(AUTH_URL, {
        headers: { Authorization: `Basic ${basicAuth}`, Accept: "application/json" },
      });
    } catch (err) {
      logError(
        ERROR_CODES.AUTH_REQUEST_FAILED,
        "Falha ao autenticar na API PayMobi.",
        err?.response?.status ? `status ${err.response.status}` : err.message
      );
      fs.writeFileSync(LINK_FILE, "");
      fs.writeFileSync(JSON_FILE, JSON.stringify([], null, 2));
      return;
    }

    const token = authResponse.data?.result?.token;
    if (!token) {
      logError(ERROR_CODES.TOKEN_MISSING, "Token JWT não encontrado na resposta da API.");
      fs.writeFileSync(LINK_FILE, "");
      fs.writeFileSync(JSON_FILE, JSON.stringify([], null, 2));
      return;
    }
    console.log("✅ Token JWT obtido com sucesso.\n");

    // 2️⃣ Buscar boletos do cliente
    console.log("📡 Consultando boletos principais...");
    let response;
    try {
      response = await axios.post(
        SEARCH_URL,
        { document: CPF, includeCompleted: true, page: 1, pageSize: 100 },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (err) {
      logError(
        ERROR_CODES.SEARCH_REQUEST_FAILED,
        "Falha ao consultar boletos na API PayMobi.",
        err?.response?.status ? `status ${err.response.status}` : err.message
      );
      fs.writeFileSync(LINK_FILE, "");
      fs.writeFileSync(JSON_FILE, JSON.stringify([], null, 2));
      return;
    }

    const boletos = response.data?.result?.installments || [];
    if (!boletos.length) {
      console.log("⚠️ Nenhum boleto encontrado para este CPF.");
      try {
        fs.writeFileSync(LINK_FILE, "");
        // sobrescreve o JSON com array vazio (mantém apenas 1 arquivo)
        fs.writeFileSync(JSON_FILE, JSON.stringify([], null, 2));
      } catch (err) {
        logError(
          ERROR_CODES.OUTPUT_WRITE_FAILED,
          "Falha ao gravar arquivos de saída.",
          err.message
        );
      }
      return;
    }

    // 3️⃣ Ordenar boletos por data de vencimento
    boletos.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    console.log(`🔎 ${boletos.length} boletos encontrados para ${CPF}.\n`);

    // 4️⃣ Exibir todos no console
    boletos.forEach((b, i) => {
      const venc = formatDate(b.dueDate);
      const valor = b.value || b.valor || b.amount || "-";
      const status = b.status || "-";
      const cliente = b.customerName || "Cliente não informado";
      const modelo = b.model || b.imeiModel || "Modelo desconhecido";
      console.log(`#${i + 1}: ${cliente} | ${modelo} | ${venc} | R$${valor} | ${status}`);
    });

    // 5️⃣ Manter formato original da criação do JSON (reescreve, não concatena)
    // Agora sempre escreve em 'boletos.json' (sobrescrevendo o arquivo anterior)
    try {
      fs.writeFileSync(JSON_FILE, JSON.stringify(boletos, null, 2));
    } catch (err) {
      logError(
        ERROR_CODES.OUTPUT_WRITE_FAILED,
        "Falha ao gravar o arquivo de boletos.",
        err.message
      );
    }
    console.log(`\n💾 Boletos exportados (arquivo único): ${path.basename(JSON_FILE)}\n`);

    // 6️⃣ Identificar o próximo boleto em aberto
    const abertos = boletos.filter((b) => isAberto(b.status));
    if (!abertos.length) {
      console.log("✅ Nenhum boleto em aberto encontrado.");
      try {
        fs.writeFileSync(LINK_FILE, "");
      } catch (err) {
        logError(
          ERROR_CODES.OUTPUT_WRITE_FAILED,
          "Falha ao gravar arquivo de link.",
          err.message
        );
      }
      return;
    }

    abertos.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    const proximo = abertos[0];
    const link = proximo.boletoLink || proximo.boletoUrl || "";
    const valor = proximo.value || proximo.valor || "-";
    const cliente = proximo.customerName || "Cliente não informado";
    const modelo = proximo.model || proximo.imeiModel || "Modelo desconhecido";
    const vencFormat = formatDate(proximo.dueDate);

    // 7️⃣ Salvar o link do próximo boleto
    if (link && link.startsWith("https")) {
      console.log(`💰 Próximo boleto em aberto: ${vencFormat} | ${cliente} | ${modelo} | R$${valor}`);
      console.log(`🌎 Link direto: ${link}`);
      try {
        fs.writeFileSync(LINK_FILE, link);
      } catch (err) {
        logError(
          ERROR_CODES.OUTPUT_WRITE_FAILED,
          "Falha ao gravar arquivo de link.",
          err.message
        );
      }
    } else {
      console.log("⚠️ Nenhum link válido encontrado para o boleto aberto.");
      try {
        fs.writeFileSync(LINK_FILE, "");
      } catch (err) {
        logError(
          ERROR_CODES.OUTPUT_WRITE_FAILED,
          "Falha ao gravar arquivo de link.",
          err.message
        );
      }
    }

    console.log("\n🏁 Processo concluído com sucesso.");
  } catch (err) {
    logError(
      ERROR_CODES.UNEXPECTED,
      "Erro inesperado durante a execução.",
      err?.response?.status ? `status ${err.response.status}` : err.message
    );
    try {
      fs.writeFileSync(LINK_FILE, "");
      // mantém o comportamento de sobrescrever o JSON para evitar acúmulo de arquivos
      fs.writeFileSync(JSON_FILE, JSON.stringify([], null, 2));
    } catch (e) {
      logError(ERROR_CODES.OUTPUT_WRITE_FAILED, "Falha ao gravar arquivos de saída.", e.message);
    }
  }
})();
