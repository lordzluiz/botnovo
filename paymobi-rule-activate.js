// paymobi-create-billing.js — cria uma cobrança individual (régua específica) para um aparelho (IMEI)
// Uso: node paymobi-create-billing.js <imei> <billingRuleId>

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const API_BASE = "https://paymobi-fin-api.azurewebsites.net";
const TOKEN_FILE = path.resolve(__dirname, "token.txt");
const TIMEOUT = 15000;

const IMEI = process.argv[2];
const RULE_ID = process.argv[3];
if (!IMEI || !RULE_ID) {
  console.log("Uso: node paymobi-create-billing.js <imei> <billingRuleId>");
  process.exit(1);
}

const EMAIL_PADRAO = "acell@gmail.com";
const PHONE_PADRAO = "5534999364378";
const MSG_PADRAO = "Cobrança automática gerada via API (aCell).";
const AUTH_URL = `${API_BASE}/users/auth`;
const CREATE_BILLING_URL = `${API_BASE}/billings`;

// ------------------------------- Funções -----------------------------------
function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}
function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, token, "utf8");
}
async function getAuthToken() {
  const existing = loadToken();
  if (existing) {
    console.log("🔒 Usando token existente (token.txt).");
    return existing;
  }
  console.log("🔐 Solicitando novo token JWT via Basic Auth...");
  const res = await axios.get(AUTH_URL, {
    auth: { username: "", password: "" }, // credenciais se necessário
    timeout: TIMEOUT,
  });
  const token = res.data?.result || res.data?.data || res.data?.token || res.data;
  if (!token) throw new Error("Token não encontrado na resposta");
  const tokenStr = typeof token === "string" ? token : JSON.stringify(token);
  saveToken(tokenStr);
  console.log("✅ Token salvo em token.txt");
  return tokenStr;
}

// ------------------------------- Execução -----------------------------------
(async () => {
  try {
    const token = await getAuthToken();

    console.log(`🚀 Criando nova cobrança para IMEI ${IMEI} com régua ${RULE_ID}...`);

    const payload = {
      imei: IMEI,
      billingRuleId: RULE_ID,
      message: MSG_PADRAO,
      phone: PHONE_PADRAO,
      email: EMAIL_PADRAO,
    };

    const res = await axios.post(CREATE_BILLING_URL, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      timeout: TIMEOUT,
    });

    if (res.status === 201) {
      console.log("✅ Cobrança criada com sucesso!");
    } else {
      console.log("⚠️ Retorno inesperado:", res.status);
    }

    console.log("📡 Resposta da API:", res.data || "(sem conteúdo)");

  } catch (err) {
    console.error("❌ Erro:", err.response?.data || err.message);
  }
})();
