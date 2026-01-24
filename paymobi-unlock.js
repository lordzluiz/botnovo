// paymobi-unlock.js — versão API pura (sem Puppeteer) + renovação automática do token se tiver mais de 3h
// Uso: node paymobi-unlock.js <cpf>

import axios from "axios";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CPF = process.argv[2] || "";
if (!/^\d{11}$/.test(CPF)) {
  console.error(chalk.red("❌ Uso: node paymobi-unlock.js <cpf (11 dígitos)>"));
  process.exit(1);
}

// ==================== CONFIGURAÇÕES ====================
const BASE = "https://paymobi-fin-api.azurewebsites.net";
const TOKEN_FILE = path.resolve(__dirname, "token.txt");
const TOKEN_META_FILE = path.resolve(__dirname, "token_meta.json");
const RESULT_FILE = path.resolve(__dirname, "unlock_result.txt");

// ⚠️ Credenciais fornecidas
const EMAIL = "acellserra@gmail.com";
const SENHA = "38330031(fOs)";
const TIMEOUT = 20000;
const TOKEN_VALID_MS = 3 * 60 * 60 * 1000; // 3 horas

// ==================== FUNÇÕES AUXILIARES ====================
function logResult(text) {
  try {
    fs.writeFileSync(RESULT_FILE, text);
  } catch {}
}

function tokenIsStillValid() {
  try {
    if (!fs.existsSync(TOKEN_FILE) || !fs.existsSync(TOKEN_META_FILE)) return false;
    const meta = JSON.parse(fs.readFileSync(TOKEN_META_FILE, "utf8"));
    const age = Date.now() - meta.createdAt;
    if (age < TOKEN_VALID_MS) {
      const remaining = Math.round((TOKEN_VALID_MS - age) / 1000 / 60);
      console.log(chalk.yellow(`🔒 Token atual ainda válido por ~${remaining} minutos.`));
      return true;
    } else {
      console.log(chalk.gray("⚠️ Token expirado (mais de 3h). Será renovado."));
      return false;
    }
  } catch {
    return false;
  }
}

// ==================== AUTENTICAÇÃO ====================
async function authAndSaveToken() {
  console.log(chalk.cyan("🔐 Solicitando autenticação via Basic Auth..."));

  try {
    const resp = await axios.get(`${BASE}/users/auth`, {
      auth: { username: EMAIL, password: SENHA },
      timeout: TIMEOUT,
      headers: { Accept: "application/json" },
    });

    const data = resp.data;
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
        if (Array.isArray(obj))
          for (const it of obj) {
            const f = findJwt(it);
            if (f) return f;
          }
        if (typeof obj === "object")
          for (const k of Object.keys(obj)) {
            const f = findJwt(obj[k]);
            if (f) return f;
          }
        return null;
      };
      token = findJwt(data);
    }

    if (!token) throw new Error("Token JWT não encontrado na resposta da API.");

    fs.writeFileSync(TOKEN_FILE, token, "utf8");
    fs.writeFileSync(
      TOKEN_META_FILE,
      JSON.stringify({ createdAt: Date.now() }, null, 2)
    );

    console.log(chalk.green("✅ Novo token obtido e salvo."));
    return token;
  } catch (err) {
    const msg = err.response
      ? JSON.stringify(err.response.data || err.response.statusText)
      : err.message;
    console.error(chalk.red("❌ Erro na autenticação:"), msg);
    logResult(`❌ Erro na autenticação: ${msg}`);
    process.exit(1);
  }
}

async function getJwtToken() {
  if (tokenIsStillValid()) {
    try {
      const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
      if (token) {
        console.log(chalk.green("✅ Usando token salvo (válido)."));
        return token;
      }
    } catch {}
  }
  return await authAndSaveToken();
}

// ==================== BUSCA COBRANÇAS ====================
async function listBillings(token, cpf) {
  const url = `${BASE}/billings/list`;
  const body = {
    contractOrCPFOrImei: String(cpf),
    draw: 1,
    search: "",
    page: 1,
    pageSize: 100,
    orderBy: "",
    orderDir: "asc",
    mustSendByEmail: false,
  };

  try {
    const resp = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://www.paymobi.com.br",
      },
      timeout: TIMEOUT,
    });

    if (resp.data?.result?.data) return resp.data.result.data;
    if (resp.data?.result) return resp.data.result;
    if (resp.data?.data) return resp.data.data;
    return resp.data;
  } catch (err) {
    const status = err.response ? err.response.status : null;
    const detail = err.response
      ? err.response.data || err.response.statusText
      : err.message;
    throw new Error(
      `Request /billings/list failed (${status}): ${JSON.stringify(detail)}`
    );
  }
}

// ==================== PARAR COBRANÇAS ATIVAS ====================
async function stopActiveBillings(token, billings) {
  const activeBillings = billings.filter(
    (b) => b.active === 1 && !b.stopReason && b.finished === 0
  );

  if (activeBillings.length === 0) {
    console.log(chalk.blue("ℹ️ Nenhuma cobrança ativa encontrada — nada a parar."));
    logResult("ℹ️ Nenhuma cobrança ativa para esse CPF.");
    return;
  }

  console.log(
    chalk.greenBright(`🟢 Encontradas ${activeBillings.length} cobranças realmente ativas.`)
  );

  let totalParadas = 0;

  for (const b of activeBillings) {
    const identifiers = [b.sellId, b.installmentId, b.contrato, b.id, b.cpf].filter(Boolean);

    for (const id of identifiers) {
      const url = `${BASE}/billings/stop`;
      const body = { identifier: String(id) };

      console.log(chalk.yellow(`🚦 Tentando parar cobrança com identifier=${id}...`));

      try {
        const resp = await axios.post(url, body, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          validateStatus: () => true,
          timeout: TIMEOUT,
        });

        if (resp.status >= 200 && resp.status < 300) {
          console.log(chalk.green(`✅ Cobrança ${b.id} parada com sucesso!`));
          totalParadas++;
          break;
        } else {
          console.log(
            chalk.gray(`⚠️ Falha (${resp.status}): ${JSON.stringify(resp.data)}`)
          );
        }
      } catch (err) {
        console.log(chalk.red(`❌ Erro com identifier=${id}: ${err.message}`));
      }
    }
  }

  console.log(chalk.greenBright(`\n✅ Total de cobranças paradas: ${totalParadas}`));
  if (totalParadas > 0)
    logResult(`✅ ${totalParadas} cobranças encerradas para CPF ${CPF}`);
  else
    logResult(`⚠️ Nenhuma cobrança pôde ser encerrada para CPF ${CPF}`);
}

// ==================== EXECUÇÃO PRINCIPAL ====================
(async () => {
  console.log(chalk.cyan(`🚀 Iniciando desbloqueio via API para CPF ${CPF}...`));

  const token = await getJwtToken();

  console.log(chalk.cyan(`📋 Buscando cobranças para CPF ${CPF}...`));
  let billings = [];

  try {
    billings = await listBillings(token, CPF);
    console.log(
      chalk.blueBright(
        `📡 Total de cobranças encontradas: ${Array.isArray(billings) ? billings.length : "??"}`
      )
    );
  } catch (e) {
    console.error(chalk.red("❌ Erro ao listar cobranças:"), e.message);
    logResult(`❌ Erro ao listar cobranças: ${e.message}`);
    process.exit(1);
  }

  if (!Array.isArray(billings) || billings.length === 0) {
    console.log(chalk.blue("ℹ️ Nenhuma cobrança encontrada para esse CPF."));
    logResult(`ℹ️ Nenhuma cobrança encontrada para CPF ${CPF}.`);
    process.exit(0);
  }

  console.log(
    chalk.gray(
      "🔎 Exemplo da primeira cobrança:\n" + JSON.stringify(billings[0], null, 2)
    )
  );

  await stopActiveBillings(token, billings);

  console.log(chalk.green("🏁 Execução finalizada."));
})();
