// bot.js — WhatsApp + PayMobi - aCell 2025 (versão otimizada e estável)

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const util = require("util");
const { exec } = require("child_process");
const execAsync = util.promisify(exec);

// ------------------ CONFIGURAÇÕES ------------------
const EMPRESA_NOME = "aCell";
const NUMERO_ATENDIMENTO = "5534999051466";
const PASTA_BOLETOS = __dirname;

const HISTORICO_FILE = path.resolve(__dirname, "desbloqueios.json");
const ROBOT_UNLOCK = path.resolve(__dirname, "paymobi-unlock.js");
const ROBOT_BOLETO = path.resolve(__dirname, "paymobi-robot-autocpf.js");
const ROBOT_CREATE_BILLING = path.resolve(__dirname, "paymobi-create-billing.js");

const VERIFICACAO_INTERVALO_HORAS = 3;
const HORA_NOTIFICACAO = 14;

// ------------------ HISTÓRICO ------------------
let desbloqueios = {};
try {
  if (fs.existsSync(HISTORICO_FILE)) {
    desbloqueios = JSON.parse(fs.readFileSync(HISTORICO_FILE, "utf8"));
  }
} catch {
  desbloqueios = {};
}

function salvarHistorico() {
  fs.writeFileSync(HISTORICO_FILE, JSON.stringify(desbloqueios, null, 2));
}
function podeDesbloquear(cpf) {
  const agora = new Date();
  const ultimo = desbloqueios[cpf];
  if (!ultimo) return true;
  const dias = (agora - new Date(ultimo)) / (1000 * 60 * 60 * 24);
  return dias >= 30;
}
function registrarDesbloqueio(cpf) {
  desbloqueios[cpf] = new Date().toISOString();
  salvarHistorico();
}

// ------------------ FILA DE PROCESSAMENTO ------------------
const fila = [];
let processando = false;

async function adicionarFila(fn) {
  fila.push(fn);
  if (!processando) processarFila();
}
async function processarFila() {
  if (processando) return;
  processando = true;
  while (fila.length > 0) {
    const job = fila.shift();
    try {
      await job();
    } catch (err) {
      console.error("❌ Erro em job:", err);
    }
  }
  processando = false;
}

// ------------------ CLIENTE WHATSAPP ------------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote"
    ]
  }
});

client.on("qr", (qr) => qrcode.generate(qr, { small: true }));

client.on("ready", () => {
  console.log("🤖 Bot conectado e pronto!");
  // aguarda estabilizar antes das automações
  setTimeout(() => {
    iniciarNotificacoesDiarias();
    iniciarRechecagem24h();
  }, 15000);
});

client.on("auth_failure", (msg) => console.error("⚠️ Falha de autenticação:", msg));
client.on("disconnected", (r) => console.log("🔌 Desconectado:", r));

// ------------------ FUNÇÕES AUXILIARES ------------------
function formatarNumeroWhats(numero) {
  const limpo = String(numero || "").replace(/\D/g, "");
  return limpo.endsWith("@c.us") ? limpo : `${limpo}@c.us`;
}
function statusEmAberto(status) {
  return /(pendente|pending|a receber|em aberto|vencido|unpaid)/i.test(status || "");
}
function toBRDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR");
}

// ------------------ TRATAMENTO MENSAGENS ------------------
const estado = {};

client.on("message", async (msg) => {
  const from = msg.from;
  const text = (msg.body || "").trim().toLowerCase();

  // Ignora mensagens de grupos
  if (msg.from.endsWith("@g.us")) return;

  // ------------------ MENU PRINCIPAL ------------------
  if (/^(oi|olá|ola|menu)$/i.test(text)) {
    estado[from] = "menu_principal";
    await msg.reply(
      `👋 Olá *${msg._data.notifyName || "cliente"}*, bem-vindo à *${EMPRESA_NOME}*!  

Escolha uma opção:
1️⃣ - 👥 Atendimento  
2️⃣ - 💸 Segunda via de boleto  
3️⃣ - 🔓 Desbloqueio de Confiança  
0️⃣ - 🚪 Sair`
    );
    return;
  }

  // ------------------ OPÇÃO 1 - ATENDIMENTO ------------------
  if (/^1$/.test(text)) {
    await msg.reply(`📞 Clique para falar com o atendimento: wa.me/${NUMERO_ATENDIMENTO}`);
    estado[from] = null;
    return;
  }

  if (/^2$/.test(text)) {
    estado[from] = "cpf_boleto";
    await msg.reply("💳 Digite o *CPF do titular* (somente números).");
    return;
  }

  if (/^3$/.test(text)) {
    estado[from] = "cpf_desbloqueio";
    await msg.reply("🔓 Digite o *CPF do titular* (somente números).");
    return;
  }

  if (/^0$/.test(text)) {
    await msg.reply("👋 Até mais! Digite *menu* para começar novamente.");
    estado[from] = null;
    return;
  }

  // ========== OPÇÃO 2: BOLETOS ==========
  if (estado[from] === "cpf_boleto") {
    if (!/^\d{11}$/.test(text)) {
      await msg.reply("⚠️ CPF inválido. Digite apenas 11 números.");
      return;
    }

    const cpf = text;
    estado[from] = "aguardando";
    await msg.reply(`🔎 CPF *${cpf}* recebido. Estou buscando seus boletos...`);

    adicionarFila(async () => {
      try {
        await execAsync(`node "${ROBOT_BOLETO}" ${cpf}`, { timeout: 90000 });

        const jsonPath = path.resolve(PASTA_BOLETOS, "boletos.json");
        if (!fs.existsSync(jsonPath)) {
          await msg.reply("⚠️ Nenhum boleto encontrado para este CPF.");
          estado[from] = "menu_principal";
          return;
        }

        const boletos = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        const boletosFiltrados = boletos.filter((b) => (b.cpf || "").replace(/\D/g, "") === cpf);

        const hoje = new Date();
        const mesAtual = hoje.getMonth();
        const anoAtual = hoje.getFullYear();

        const atrasados = [], mesAtualBoletos = [], proximoMes = [];

        for (const b of boletosFiltrados) {
          const d = new Date(b.dueDate);
          const link = b.boletoLink || b.boletoUrl || null;
          const modelo = b.model || b.imeiModel || "Aparelho";
          const valor = b.value || b.valor || "-";
          const venc = toBRDate(b.dueDate);

          if (statusEmAberto(b.status)) {
            if (d < hoje) atrasados.push({ venc, modelo, valor, link });
            else if (d.getMonth() === mesAtual && d.getFullYear() === anoAtual)
              mesAtualBoletos.push({ venc, modelo, valor, link });
            else if (d.getMonth() === mesAtual + 1 && d.getFullYear() === anoAtual)
              proximoMes.push({ venc, modelo, valor, link });
          }
        }

        let resposta = "";
        if (atrasados.length) {
          resposta += "🚨 *Boletos em atraso:*\n";
          atrasados.forEach((b) => {
            resposta += `📅 ${b.venc} | ${b.modelo} | R$${b.valor}\n${b.link ? "🔗 " + b.link : "⚠️ Link indisponível"}\n\n`;
          });
        }
        if (mesAtualBoletos.length) {
          resposta += "📆 *Boleto deste mês:*\n";
          mesAtualBoletos.forEach((b) => {
            resposta += `🗓️ Venc: ${b.venc} | ${b.modelo} | R$${b.valor}\n${b.link ? "🔗 " + b.link : "⚠️ Link indisponível"}\n\n`;
          });
        }
        if (proximoMes.length) {
          resposta += "🔔 *Boleto do próximo mês já disponível:*\n";
          proximoMes.forEach((b) => {
            resposta += `📆 ${b.venc} | ${b.modelo} | R$${b.valor}\n${b.link ? "🔗 " + b.link : "⚠️ Link indisponível"}\n\n`;
          });
        }

        await msg.reply(resposta.trim() || "✅ Nenhum boleto em aberto no momento.");
      } catch (err) {
        console.error("❌ Erro boleto:", err);
        await msg.reply("⚠️ Ocorreu um erro ao buscar boletos.");
      } finally {
        estado[from] = "menu_principal";
      }
    });
    return;
 // ------------------ TRATAMENTO DE CPF SEM COBRANÇAS ATIVAS ------------------
async function tratarNenhumaCobrancaAtiva(cpf, msg) {
  console.log(`ℹ️ Nenhuma cobrança ativa para CPF ${cpf}.`);
  await msg.reply(
    `✅ *Nenhuma cobrança ativa encontrada para este CPF.*\n` +
    `💬 O aparelho *não está bloqueado* e todas as faturas estão quitadas.\n` +
    `📱 Caso ainda apareça bloqueado, reinicie o aparelho e aguarde alguns minutos.`
  );
}

// ========== OPÇÃO 3: DESBLOQUEIO ==========
if (estado[from] === "cpf_desbloqueio") {
  if (!/^\d{11}$/.test(text)) {
    await msg.reply("⚠️ CPF inválido. Digite apenas 11 números.");
    return;
  }

  const cpf = text;

  // 🔒 Verifica limite de desbloqueio
  if (!podeDesbloquear(cpf)) {
    await msg.reply(
      "⚠️ Limite de *Desbloqueio de Confiança* já utilizado para esta fatura.\n💬 Efetue o pagamento do boleto pendente para manter o serviço ativo."
    );
    estado[from] = "menu_principal";
    return;
  }

  estado[from] = "aguardando";
  await msg.reply(`🔓 CPF *${cpf}* recebido. Seu pedido de desbloqueio entrou na fila...`);

  adicionarFila(async () => {
    try {
      console.log(`🔧 [FILA] Iniciando desbloqueio para CPF ${cpf}`);

      const { stdout } = await execAsync(`node "${ROBOT_UNLOCK}" ${cpf}`, { timeout: 60000 });
      let resultado = stdout ? stdout.toLowerCase() : "";

      const resultadoPath = path.resolve(__dirname, "unlock_result.txt");
      if (fs.existsSync(resultadoPath)) {
        resultado += "\n" + fs.readFileSync(resultadoPath, "utf8").toLowerCase();
      }

      // --- Análise do retorno do script ---
      if (resultado.includes("nenhuma cobrança ativa")) {
        await tratarNenhumaCobrancaAtiva(cpf, msg);
      }
      else if (
        resultado.includes("cobranças encerradas") ||
        resultado.includes("cobrança encerrada")
      ) {
        registrarDesbloqueio(cpf);
        await msg.reply(
          `✅ *Desbloqueio confirmado!*\n` +
          `🔓 O aparelho foi liberado — válido por *24 horas*.\n` +
          `🔁 Caso ainda apareça bloqueado, reinicie o aparelho e aguarde alguns minutos.`
        );
      }
      else if (
        resultado.includes("sucesso") ||
        resultado.includes("efetuado") ||
        resultado.includes("realizado")
      ) {
        registrarDesbloqueio(cpf);
        await msg.reply(
          `✅ *Desbloqueio efetuado com sucesso!*\n🕐 A liberação será aplicada em até *10 minutos*.\n🔓 Válido por *24 horas*.\n`
        );
      }
      else if (
        resultado.includes("erro") ||
        resultado.includes("falha") ||
        resultado.includes("não encontrado")
      ) {
        await msg.reply(
          "⚠️ Não foi possível concluir o desbloqueio no momento.\nTente novamente mais tarde ou entre em contato com o atendimento."
        );
      }
      else {
        await msg.reply(
          "⚠️ O sistema não confirmou o desbloqueio.\nVerifique se há cobrança pendente e tente novamente."
        );
      }
    } catch (err) {
      console.error("❌ Erro desbloqueio:", err.message);
      await msg.reply("❌ Ocorreu um erro interno ao tentar desbloquear. Tente novamente em instantes.");
    } finally {
      estado[from] = "menu_principal";
    }
  });

  return;
}
 }

  // ========== OPÇÃO 3: DESBLOQUEIO ==========
  if (estado[from] === "cpf_desbloqueio") {
    if (!/^\d{11}$/.test(text)) {
      await msg.reply("⚠️ CPF inválido. Digite apenas 11 números.");
      return;
    }

    const cpf = text;

    // 🔒 Verifica limite de desbloqueio
    if (!podeDesbloquear(cpf)) {
      await msg.reply(
        "⚠️ Limite de *Desbloqueio de Confiança* já utilizado para esta fatura.\n💬 Efetue o pagamento do boleto pendente para manter o serviço ativo."
      );
      estado[from] = "menu_principal";
      return;
    }

    estado[from] = "aguardando";
    await msg.reply(`🔓 CPF *${cpf}* recebido. Seu pedido de desbloqueio entrou na fila...`);

    adicionarFila(async () => {
      try {
        console.log(`🔧 [FILA] Iniciando desbloqueio para CPF ${cpf}`);

        const { stdout } = await execAsync(`node "${ROBOT_UNLOCK}" ${cpf}`, { timeout: 60000 });
        let resultado = stdout ? stdout.toLowerCase() : "";

        const resultadoPath = path.resolve(__dirname, "unlock_result.txt");
        if (fs.existsSync(resultadoPath)) {
          resultado += "\n" + fs.readFileSync(resultadoPath, "utf8").toLowerCase();
        }

        if (
           
          resultado.includes("cobranças encerradas") ||
          resultado.includes("cobrança encerrada")
        ) {
          registrarDesbloqueio(cpf);
          await msg.reply(
            `✅ *Desbloqueio confirmado!*\n` +
              `🔓 O aparelho foi liberado — válido por *24 horas*.\n` +
              `🔁 Caso ainda apareça bloqueado, reinicie o aparelho e aguarde alguns minutos.`
          );
        } else if (
          resultado.includes("nenhuma cobrança ativa") ||
          resultado.includes("nenhuma cobrança ativa para esse cpf") ||
          resultado.includes("nenhuma cobrança ativa para")
        ) {
  registrarDesbloqueio(cpf);
  await msg.reply(
    `✅ *Nenhuma cobrança ativa encontrada para este CPF.*\n` +
    `💬 Seu aparelho já está liberado — *não é necessário realizar o desbloqueio.*\n` +
    `☎️ Se estiver enfrentando algum problema, entre em contato com o *atendimento da aCell* para que possamos te ajudar.`
  );
}
 else if (
          resultado.includes("erro") ||
          resultado.includes("falha") ||
          resultado.includes("não encontrado")
        ) {
          await msg.reply(
            "⚠️ Não foi possível concluir o desbloqueio no momento.\nTente novamente mais tarde ou entre em contato com o atendimento."
          );
        } else {
          await msg.reply(
            "⚠️ O sistema não confirmou o desbloqueio.\nVerifique se há cobrança pendente e tente novamente."
          );
        }
      } catch (err) {
        console.error("❌ Erro desbloqueio:", err.message);
        await msg.reply("❌ Ocorreu um erro interno ao tentar desbloquear. Tente novamente em instantes.");
      } finally {
        estado[from] = "menu_principal";
      }
    });

    return;
  }
  await msg.reply("🤖 Não entendi. Digite *menu* para ver as opções novamente.");
});

// ------------------ NOTIFICAÇÕES AUTOMÁTICAS ------------------
let notificando = false;
async function iniciarNotificacoesDiarias() {
  console.log("⏰ Notificações automáticas ativas (14h).");

  async function verificar() {
    if (notificando) return;
    notificando = true;
    try {
      const horaAtual = new Date().getHours();
      if (horaAtual !== HORA_NOTIFICACAO) return;

      await execAsync(`node "${ROBOT_BOLETO}" base`, { timeout: 180000 }).catch(() => {});
      const jsonPath = path.resolve(PASTA_BOLETOS, "boletos.json");
      if (!fs.existsSync(jsonPath)) return;

      const boletos = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const hoje = new Date();
      const mesAtual = hoje.getMonth();
      const anoAtual = hoje.getFullYear();

      const boletosFiltrados = boletos.filter((b) => {
        const d = new Date(b.dueDate);
        return d.getFullYear() === anoAtual && d.getMonth() <= mesAtual;
      });

      for (const b of boletosFiltrados.filter((b) => statusEmAberto(b.status))) {
        const numeroWhats = formatarNumeroWhats(b.phone);
        const nome = b.customerName || "Cliente";
        const modelo = b.model || "Aparelho";
        const venc = toBRDate(b.dueDate);
        const valor = b.value || "-";
        const link = b.boletoLink || "Link indisponível";
        await client.sendMessage(
          numeroWhats,
          `📅 Olá *${nome}*! Seu boleto do *${modelo}* venceu ou vence em breve (${venc}). Valor: *R$${valor}*\n💳 ${link}`
        );
      }
    } catch (err) {
      console.error("⚠️ Erro nas notificações automáticas:", err.message);
    } finally {
      notificando = false;
    }
  }

  setInterval(verificar, 60 * 60 * 1000);
}

// ------------------ RECHECAGEM 24H ------------------
let rechecando = false;
async function iniciarRechecagem24h() {
  console.log("🔁 Rechecagem 24h ativa.");

  async function verificar() {
    if (rechecando) return;
    rechecando = true;
    try {
      const agora = new Date();
      for (const cpf in desbloqueios) {
        const data = new Date(desbloqueios[cpf]);
        const diffHoras = (agora - data) / (1000 * 60 * 60);
        const diffDias = diffHoras / 24;

        if (diffDias >= 30) {
          delete desbloqueios[cpf];
          salvarHistorico();
          continue;
        }

        if (diffHoras >= 24) {
          console.log(`⏱️ Rechecando CPF ${cpf}...`);
          await execAsync(`node "${ROBOT_BOLETO}" ${cpf}`, { timeout: 90000 }).catch(() => {});
          const arquivo = path.resolve(PASTA_BOLETOS, "boletos.json");
          if (!fs.existsSync(arquivo)) continue;

          const boletos = JSON.parse(fs.readFileSync(arquivo, "utf8"));
          const boletosFiltrados = boletos.filter((b) => (b.cpf || "").replace(/\D/g, "") === cpf);
          const abertos = boletosFiltrados.filter((b) => statusEmAberto(b.status));

          if (abertos.length > 0) {
            console.log(`💣 Reativando bloqueio CPF ${cpf}...`);
            const b = abertos[0];
            await execAsync(`node "${ROBOT_CREATE_BILLING}" ${b.imei} ${b.installmentId}`, { timeout: 60000 }).catch(() => {});
          }
        }
      }
      salvarHistorico();
    } catch (err) {
      console.error("⚠️ Erro na rechecagem 24h:", err.message);
    } finally {
      rechecando = false;
    }
  }

  setInterval(verificar, VERIFICACAO_INTERVALO_HORAS * 60 * 60 * 1000);
}

// ------------------ INICIALIZAÇÃO ------------------
client.initialize();
