// paymobi-create-billing.js — cria uma cobrança individual (régua específica) para um aparelho (IMEI)
// Uso: node paymobi-create-billing.js <imei> <billingRuleId>

const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ==================== CONFIGURAÇÕES ====================
const API_BASE = "https://paymobi-fin-api.azurewebsites.net";
const TOKEN_FILE = path.resolve(__dirname, "token.txt");
const TOKEN_META_FILE = path.resolve(__dirname, "token_meta.json");
const TIMEOUT = 15000;
const TOKEN_VALID_MS = 3 * 60 * 60 * 1000; // 3 horas

// ⚠️ Credenciais
const EMAIL = "acellserra@gmail.com";
const SENHA = "38330031(fOs)";

const EMAIL_PADRAO = "acell@gmail.com";
const PHONE_PADRAO = "5534999364378";
const MSG_PADRAO = "Cobrança automática gerada via API (aCell).";

const AUTH_URL = `${API_BASE}/users/auth`;
const CREATE_BILLING_URL = `${API_BASE}/billings`;

// ==================== PARÂMETROS DE EXECUÇÃO ====================
const IMEI = process.argv[2];
const RULE_ID = process.argv[3];
if (!IMEI || !RULE_ID) {
  console.log("❌ Uso: node paymobi-create-billing.js <imei> <billingRuleId>");
  process.exit(1);
}

// ==================== FUNÇÕES AUXILIARES ====================
function tokenIsStillValid() {
  try {
    if (!fs.existsSync(TOKEN_FILE) || !fs.existsSync(TOKEN_META_FILE)) return false;
    const meta = JSON.parse(fs.readFileSync(TOKEN_META_FILE, "utf8"));
    const age = Date.now() - meta.createdAt;
    if (age < TOKEN_VALID_MS) {
      const remaining = Math.round((TOKEN_VALID_MS - age) / 60000);
      console.log(`🔒 Token atual ainda válido (~${remaining} min restantes).`);
      return true;
    } else {
      console.log("⚠️ Token expirado (mais de 3h). Será renovado agora...");
      return false;
    }
  } catch {
    return false;
  }
}

function loadToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

function saveToken(token) {
  fs.writeFileSync(TOKEN_FILE, token, "utf8");
  fs.writeFileSync(TOKEN_META_FILE, JSON.stringify({ createdAt: Date.now() }, null, 2));
}

async function getAuthToken() {
  // Se existir token válido, usa ele
  if (tokenIsStillValid()) {
    const existing = loadToken();
    if (existing) return existing;
  }

  console.log("🔐 Solicitando novo token JWT via Basic Auth...");
  const res = await axios.get(AUTH_URL, {
    auth: { username: EMAIL, password: SENHA },
    timeout: TIMEOUT,
    headers: { Accept: "application/json" },
  });

  // Extrai o token de várias formas possíveis
  const data = res.data;
  let token =
    data?.result?.token ||
    data?.result?.jwt ||
    data?.token ||
    data?.jwt ||
    null;

  if (!token) {
    const findJwt = (obj) => {
      if (!obj) return null;
      if (typeof obj === "string" && obj.includes(".") && obj.length > 30) return obj;
      if (Array.isArray(obj)) {
        for (const it of obj) {
          const f = findJwt(it);
          if (f) return f;
        }
      }
      if (typeof obj === "object") {
        for (const k of Object.keys(obj)) {
          const f = findJwt(obj[k]);
          if (f) return f;
        }
      }
      return null;
    };
    token = findJwt(data);
  }

  if (!token) throw new Error("❌ Token JWT não encontrado na resposta da API.");

  saveToken(token);
  console.log("✅ Novo token salvo em token.txt");
  return token;
}

// ==================== EXECUÇÃO PRINCIPAL ====================
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
      validateStatus: () => true,
    });

    if (res.status >= 200 && res.status < 300) {
      console.log("✅ Cobrança criada com sucesso!");
    } else if (res.status === 401) {
      console.log("🔁 Token expirado durante a requisição — renovando e tentando novamente...");
      const newToken = await getAuthToken();
      const retry = await axios.post(CREATE_BILLING_URL, payload, {
        headers: {
          Authorization: `Bearer ${newToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        timeout: TIMEOUT,
      });
      if (retry.status >= 200 && retry.status < 300) {
        console.log("✅ Cobrança criada com sucesso após renovar token!");
      } else {
        console.log("⚠️ Falha mesmo após renovar token:", retry.status, retry.data);
      }
    } else {
      console.log("⚠️ Resposta inesperada:", res.status, res.data);
    }

  } catch (err) {
    console.error("❌ Erro:", err.response?.data || err.message);
  }
})();
