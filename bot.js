// bot.js — WhatsApp + PayMobi - aCell 2025 (versão Baileys)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import util from "util";
import { exec } from "child_process";
import { iniciarWhatsApp, normalizarNumero } from "./whatsapp.js";

const execAsync = util.promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------ CONFIGURAÇÕES ------------------
const EMPRESA_NOME = "aCell";
const NUMERO_ATENDIMENTO = "5534999051466";
const PASTA_BOLETOS = __dirname;

const HISTORICO_FILE = path.resolve(__dirname, "desbloqueios.json");
const ROBOT_UNLOCK = path.resolve(__dirname, "paymobi-unlock.js");
const ROBOT_BOLETO = path.resolve(__dirname, "paymobi-robot-autocpf.js");
const ROBOT_CREATE_BILLING = path.resolve(__dirname, "paymobi-create-billing.js");

const VERIFICACAO_INTERVALO_HORAS = 24;
const HORA_NOTIFICACAO = 8;

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
      logErro("PMB-011", "Erro em job da fila de processamento.", err);
    }
  }
  processando = false;
}

// ------------------ FUNÇÕES AUXILIARES ------------------
function formatarNumeroWhats(numero) {
  const limpo = String(numero || "").replace(/\D/g, "");
  if (!limpo) return "";
  return normalizarNumero(limpo);
}
function statusEmAberto(status) {
  return /(pendente|pending|a receber|em aberto|vencido|unpaid)/i.test(status || "");
}
function toBRDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR");
}
function getMessageText(message) {
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

async function sendText(sock, jid, text, quoted) {
  const options = quoted ? { quoted } : undefined;
  await sock.sendMessage(jid, { text }, options);
}

async function tratarNenhumaCobrancaAtiva(cpf, sock, msg) {
  console.log(`ℹ️ Nenhuma cobrança ativa para CPF ${cpf}.`);
  await sendText(
    sock,
    msg.key.remoteJid,
    `✅ *Nenhuma cobrança ativa encontrada para este CPF.*\n` +
      `💬 O aparelho *não está bloqueado* e todas as faturas estão quitadas.\n` +
      `📱 Caso ainda apareça bloqueado, reinicie o aparelho e aguarde alguns minutos.`,
    msg
  );
}

// ------------------ TRATAMENTO MENSAGENS ------------------
const estado = {};

async function iniciarBot() {
  let automacoesIniciadas = false;
  const configurarSocket = (sock) => {
    sock.ev.on("connection.update", (update) => {
      const { connection } = update;

      if (connection === "open" && !automacoesIniciadas) {
        automacoesIniciadas = true;
        console.log("🤖 Bot conectado e pronto!");
        setTimeout(() => {
          try {
            iniciarNotificacoesDiarias(sock);
            iniciarRechecagem24h();
          } catch (err) {
            logErro("PMB-013", "Erro ao iniciar automações após conexão.", err);
          }
        }, 15000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      try {
        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const from = msg.key.remoteJid;
          if (!from) continue;

          if (from.endsWith("@g.us")) continue;

          const rawText = getMessageText(msg.message).trim();
          const text = rawText.toLowerCase();

          // ------------------ MENU PRINCIPAL ------------------
          if (/^(oi|olá|ola|menu)$/i.test(text)) {
            estado[from] = "menu_principal";
            await sendText(
              sock,
              from,
              `👋 Olá *${msg.pushName || "cliente"}*, bem-vindo à *${EMPRESA_NOME}*!  \n\n` +
                `Escolha uma opção:\n` +
                `1️⃣ - 👥 Atendimento  \n` +
                `2️⃣ - 💸 Segunda via de boleto  \n` +
                `3️⃣ - 🔓 Desbloqueio de Confiança  \n` +
                `0️⃣ - 🚪 Sair`,
              msg
            );
            continue;
          }

          // ------------------ OPÇÃO 1 - ATENDIMENTO ------------------
          if (/^1$/.test(text)) {
            await sendText(
              sock,
              from,
              `📞 Clique para falar com o atendimento: wa.me/${NUMERO_ATENDIMENTO}`,
              msg
            );
            estado[from] = null;
            continue;
          }

          if (/^2$/.test(text)) {
            estado[from] = "cpf_boleto";
            await sendText(sock, from, "💳 Digite o *CPF do titular* (somente números).", msg);
            continue;
          }

          if (/^3$/.test(text)) {
            estado[from] = "cpf_desbloqueio";
            await sendText(sock, from, "🔓 Digite o *CPF do titular* (somente números).", msg);
            continue;
          }

          if (/^0$/.test(text)) {
            await sendText(sock, from, "👋 Até mais! Digite *menu* para começar novamente.", msg);
            estado[from] = null;
            continue;
          }

          // ========== OPÇÃO 2: BOLETOS ==========
          if (estado[from] === "cpf_boleto") {
            if (!/^\d{11}$/.test(rawText)) {
              await sendText(sock, from, "⚠️ CPF inválido. Digite apenas 11 números.", msg);
              continue;
            }

            const cpf = rawText;
            estado[from] = "aguardando";
            await sendText(
              sock,
              from,
              `🔎 CPF *${cpf}* recebido. Estou buscando seus boletos...`,
              msg
            );

            adicionarFila(async () => {
              try {
                await execAsync(`node "${ROBOT_BOLETO}" ${cpf}`, { timeout: 90000 });

                const jsonPath = path.resolve(PASTA_BOLETOS, "boletos.json");
                if (!fs.existsSync(jsonPath)) {
                  await sendText(sock, from, "⚠️ Nenhum boleto encontrado para este CPF.", msg);
                  estado[from] = "menu_principal";
                  return;
                }

                const boletos = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
                const boletosFiltrados = boletos.filter((b) => (b.cpf || "").replace(/\D/g, "") === cpf);

                const hoje = new Date();
                const mesAtual = hoje.getMonth();
                const anoAtual = hoje.getFullYear();

                const atrasados = [];
                const mesAtualBoletos = [];
                const proximoMes = [];

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
                    resposta += `📅 ${b.venc} | ${b.modelo} | R$${b.valor}\n${
                      b.link ? "🔗 " + b.link : "⚠️ Link indisponível"
                    }\n\n`;
                  });
                }
                if (mesAtualBoletos.length) {
                  resposta += "📆 *Boleto deste mês:*\n";
                  mesAtualBoletos.forEach((b) => {
                    resposta += `🗓️ Venc: ${b.venc} | ${b.modelo} | R$${b.valor}\n${
                      b.link ? "🔗 " + b.link : "⚠️ Link indisponível"
                    }\n\n`;
                  });
                }
                if (proximoMes.length) {
                  resposta += "🔔 *Boleto do próximo mês já disponível:*\n";
                  proximoMes.forEach((b) => {
                    resposta += `📆 ${b.venc} | ${b.modelo} | R$${b.valor}\n${
                      b.link ? "🔗 " + b.link : "⚠️ Link indisponível"
                    }\n\n`;
                  });
                }

                await sendText(
                  sock,
                  from,
                  resposta.trim() || "✅ Nenhum boleto em aberto no momento.",
                  msg
                );
              } catch (err) {
                logErro("PMB-014", "Erro ao buscar boletos.", err);
                await sendText(sock, from, "⚠️ Ocorreu um erro ao buscar boletos.", msg);
              } finally {
                estado[from] = "menu_principal";
              }
            });
            continue;
          }

          // ========== OPÇÃO 3: DESBLOQUEIO ==========
          if (estado[from] === "cpf_desbloqueio") {
            if (!/^\d{11}$/.test(rawText)) {
              await sendText(sock, from, "⚠️ CPF inválido. Digite apenas 11 números.", msg);
              continue;
            }

            const cpf = rawText;

            if (!podeDesbloquear(cpf)) {
              await sendText(
                sock,
                from,
                "⚠️ Limite de *Desbloqueio de Confiança* já utilizado para esta fatura.\n💬 Efetue o pagamento do boleto pendente para manter o serviço ativo.",
                msg
              );
              estado[from] = "menu_principal";
              continue;
            }

            estado[from] = "aguardando";
            await sendText(
              sock,
              from,
              `🔓 CPF *${cpf}* recebido. Seu pedido de desbloqueio entrou na fila...`,
              msg
            );

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
                  await sendText(
                    sock,
                    from,
                    `✅ *Desbloqueio confirmado!*\n` +
                      `🔓 O aparelho foi liberado — válido por *24 horas*.\n` +
                      `🔁 Caso ainda apareça bloqueado, reinicie o aparelho e aguarde alguns minutos.`,
                    msg
                  );
                } else if (
                  resultado.includes("sucesso") ||
                  resultado.includes("efetuado") ||
                  resultado.includes("realizado")
                ) {
                  registrarDesbloqueio(cpf);
                  await sendText(
                    sock,
                    from,
                    `✅ *Desbloqueio efetuado com sucesso!*\n🕐 A liberação será aplicada em até *10 minutos*.\n🔓 Válido por *24 horas*.`,
                    msg
                  );
                } else if (
                  resultado.includes("nenhuma cobrança ativa") ||
                  resultado.includes("nenhuma cobrança ativa para")
                ) {
                  registrarDesbloqueio(cpf);
                  await tratarNenhumaCobrancaAtiva(cpf, sock, msg);
                } else if (
                  resultado.includes("erro") ||
                  resultado.includes("falha") ||
                  resultado.includes("não encontrado")
                ) {
                  await sendText(
                    sock,
                    from,
                    "⚠️ Não foi possível concluir o desbloqueio no momento.\nTente novamente mais tarde ou entre em contato com o atendimento.",
                    msg
                  );
                } else {
                  await sendText(
                    sock,
                    from,
                    "⚠️ O sistema não confirmou o desbloqueio.\nVerifique se há cobrança pendente e tente novamente.",
                    msg
                  );
                }
              } catch (err) {
                logErro("PMB-015", "Erro ao processar desbloqueio.", err);
                await sendText(
                  sock,
                  from,
                  "❌ Ocorreu um erro interno ao tentar desbloquear. Tente novamente em instantes.",
                  msg
                );
              } finally {
                estado[from] = "menu_principal";
              }
            });
            continue;
          }

          await sendText(
            sock,
            from,
            "🤖 Não entendi. Digite *menu* para ver as opções novamente.",
            msg
          );
        }
      } catch (err) {
        logErro("PMB-012", "Erro no processamento de mensagens.", err);
      }
    });
  };

  const sock = await iniciarWhatsApp({
    onReconnect: (novoSock) => {
      console.log("🔄 Reconectado com Baileys. Reinicializando listeners...");
      configurarSocket(novoSock);
    }
  });

  configurarSocket(sock);
}

// ======================================================================
// SISTEMA COMPLETO DE NOTIFICAÇÕES AUTOMÁTICAS
// ======================================================================

const SENT_LOG_FILE = path.resolve(__dirname, "sent-log.json");
let sentLog = {};

try {
  if (fs.existsSync(SENT_LOG_FILE)) {
    sentLog = JSON.parse(fs.readFileSync(SENT_LOG_FILE, "utf8"));
  }
} catch {
  sentLog = {};
}

function salvarSentLog() {
  fs.writeFileSync(SENT_LOG_FILE, JSON.stringify(sentLog, null, 2));
}

function foiEnviado(boleto, tipo) {
  const id = `${boleto.installmentId}_${tipo}`;
  return sentLog[id] === true;
}

function marcarEnviado(boleto, tipo) {
  const id = `${boleto.installmentId}_${tipo}`;
  sentLog[id] = true;
}

function diffDiasVencimento(dataVenc) {
  const venc = new Date(dataVenc);
  const hoje = new Date();
  venc.setHours(0, 0, 0, 0);
  hoje.setHours(0, 0, 0, 0);
  return (venc - hoje) / (1000 * 60 * 60 * 24);
}

function mesAtual(data) {
  const d = new Date(data);
  const agora = new Date();
  return d.getMonth() === agora.getMonth() && d.getFullYear() === agora.getFullYear();
}

function aposDataCorte(dataVenc) {
  try {
    const venc = new Date(dataVenc);
    const dataCorte = new Date(2025, 9, 1); // Outubro = 9
    return venc >= dataCorte;
  } catch {
    return false;
  }
}

let notificando = false;

async function iniciarNotificacoesDiarias(sock) {
  console.log(`⏰ Sistema de notificações iniciado — horário configurado: ${HORA_NOTIFICACAO}h`);
  console.log("🕒 Fuso horário do servidor:", new Date().toString());

  async function verificar() {
    if (notificando) return;
    notificando = true;

    try {
      const agora = new Date();
      const horaAtual = agora.getHours();

      if (horaAtual !== HORA_NOTIFICACAO) {
        notificando = false;
        return;
      }

      console.log(`🔔 Executando verificação automática às ${horaAtual}h — ${agora}`);

      await execAsync(`node "${ROBOT_BOLETO}" base`, { timeout: 180000 }).catch(() => {});

      const jsonPath = path.resolve(PASTA_BOLETOS, "boletos.json");
      if (!fs.existsSync(jsonPath)) {
        console.warn("⚠️ Arquivo boletos.json não encontrado.");
        notificando = false;
        return;
      }

      const todos = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      console.log(`📄 Total de boletos carregados: ${todos.length}`);

      const elegiveis = todos.filter(
        (b) => statusEmAberto(b.status) && b.dueDate && aposDataCorte(b.dueDate)
      );

      console.log(`✅ Boletos elegíveis: ${elegiveis.length}`);
      if (!elegiveis.length) {
        notificando = false;
        return;
      }

      const porCliente = new Map();
      for (const b of elegiveis) {
        const chave = (b.phone && String(b.phone).trim()) || (b.cpf && String(b.cpf).trim());
        if (!chave) continue;
        if (!porCliente.has(chave)) porCliente.set(chave, []);
        porCliente.get(chave).push(b);
      }

      console.log(`📦 Clientes elegíveis: ${porCliente.size}`);

      for (const [chave, lista] of porCliente.entries()) {
        const numeroWhats = formatarNumeroWhats(
          lista.find((b) => b.phone)?.phone || lista[0].phone || ""
        );
        if (!numeroWhats) continue;

        const boletosMes = lista.filter((b) => mesAtual(b.dueDate));
        if (!boletosMes.length) continue;

        let escolhido = null;
        let tipo = null;

        for (const b of boletosMes) {
          const d = diffDiasVencimento(b.dueDate);

          if (d >= 2.5 && d < 3.5 && !foiEnviado(b, "antes3")) {
            escolhido = b;
            tipo = "antes3";
            break;
          }
          if (d >= -0.5 && d < 0.5 && !foiEnviado(b, "hoje")) {
            escolhido = b;
            tipo = "hoje";
            break;
          }
          if (d >= -2.5 && d < -1.5 && !foiEnviado(b, "apos2")) {
            escolhido = b;
            tipo = "apos2";
            break;
          }
          if (d >= -5.5 && d < -4.5 && !foiEnviado(b, "apos5")) {
            escolhido = b;
            tipo = "apos5";
            break;
          }
        }

        if (!escolhido) continue;

        const nome = escolhido.customerName || "cliente";
        const modelo = escolhido.model || escolhido.imeiModel || "seu aparelho";
        const vencBR = toBRDate(escolhido.dueDate);
        const valor = escolhido.value || escolhido.valor || "-";
        const link = escolhido.boletoLink || escolhido.boletoUrl || "Link indisponível";

        let mensagem = "";

        if (tipo === "antes3") {
          mensagem =
            `👋 Olá *${nome}*, tudo bem? Aqui é da *${EMPRESA_NOME}* 😊\n\n` +
            `Lembrete: o boleto do seu *${modelo}* vence em *3 dias* (*${vencBR}*).\n` +
            `💰 Valor: *R$${valor}*\n\n🔗 ${link}`;
        } else if (tipo === "hoje") {
          mensagem =
            `📅 Olá *${nome}*! Hoje (*${vencBR}*) é o vencimento do boleto do seu *${modelo}*.\n` +
            `💰 Valor: *R$${valor}*\n\n🔗 ${link}`;
        } else if (tipo === "apos2") {
          mensagem =
            `⚠️ Olá *${nome}*! O boleto do seu *${modelo}* venceu há *2 dias*.\n` +
            `Vencimento: *${vencBR}*\n💰 Valor: *R$${valor}*\n\n🔗 ${link}`;
        } else if (tipo === "apos5") {
          mensagem =
            `🚨 Olá *${nome}*! O boleto do seu *${modelo}* venceu há *5 dias*.\n` +
            `Vencimento: *${vencBR}*\n💰 Valor: *R$${valor}*\n\n🔗 ${link}\n` +
            `Evite bloqueio automático.`;
        }

        try {
          await sock.sendMessage(numeroWhats, { text: mensagem.trim() });
          marcarEnviado(escolhido, tipo);
          salvarSentLog();
          console.log(`✅ Enviado (${tipo}) p/ ${nome} (${numeroWhats})`);
        } catch (err) {
          logErro("PMB-016", "Erro ao enviar mensagem de notificação automática.", err);
        }
      }
    } catch (err) {
      logErro("PMB-017", "Erro nas notificações automáticas.", err);
    } finally {
      notificando = false;
    }
  }

  const agora = new Date();
  const minutos = agora.getMinutes();
  const segundos = agora.getSeconds();
  const ms = agora.getMilliseconds();
  const msAteProximaHora = ((59 - minutos) * 60 + (60 - segundos)) * 1000 - ms;

  setTimeout(() => {
    verificar();
    setInterval(verificar, 60 * 60 * 1000);
  }, msAteProximaHora);
}

// ------------------ RECHECAGEM 24H ------------------
let rechecando = false;
const ultimoRechecado = {};

async function iniciarRechecagem24h() {
  console.log("🔁 Rechecagem 24h aprimorada ativa.");

  async function verificar() {
    if (rechecando) return;
    rechecando = true;
    let alterou = false;

    try {
      const agora = new Date();

      for (const cpf in desbloqueios) {
        try {
          const dataDesbloqueio = new Date(desbloqueios[cpf]);
          const diffHoras = (agora - dataDesbloqueio) / (1000 * 60 * 60);
          const diffDias = diffHoras / 24;

          if (diffDias >= 30) {
            console.log(`🧹 Removendo CPF ${cpf} do histórico (30 dias).`);
            delete desbloqueios[cpf];
            alterou = true;
            continue;
          }

          if (ultimoRechecado[cpf] && agora - ultimoRechecado[cpf] < 24 * 60 * 60 * 1000) {
            continue;
          }
          ultimoRechecado[cpf] = agora;

          if (diffHoras < 24) continue;

          console.log(`⏱️ Rechecando CPF ${cpf} — ${diffHoras.toFixed(1)}h desde desbloqueio...`);

          await execAsync(`node "${ROBOT_BOLETO}" ${cpf}`, { timeout: 90000 }).catch(() => {});
          const arquivo = path.resolve(PASTA_BOLETOS, "boletos.json");
          if (!fs.existsSync(arquivo)) {
            console.warn(`⚠️ Nenhum boleto.json encontrado para CPF ${cpf}.`);
            continue;
          }

          const boletos = JSON.parse(fs.readFileSync(arquivo, "utf8"));
          const boletosCliente = boletos.filter((b) => (b.cpf || "").replace(/\D/g, "") === cpf);

          if (!boletosCliente.length) {
            console.log(`⚠️ Nenhum boleto encontrado para CPF ${cpf}.`);
            continue;
          }

          const abertos = boletosCliente.filter((b) => statusEmAberto(b.status));

          if (!abertos.length) {
            console.log(`✅ Cliente ${cpf} com todos os boletos pagos.`);
            continue;
          }

          const hoje = new Date();
          const vencidos = abertos.filter((b) => {
            if (!b.dueDate) return false;
            const venc = new Date(b.dueDate);
            venc.setHours(0, 0, 0, 0);
            return venc < hoje;
          });

          if (vencidos.length === 0) {
            console.log(`📆 Cliente ${cpf} ainda dentro do prazo (sem vencidos).`);
            continue;
          }

          const boleto = vencidos[0];
          const vencBR = boleto.dueDate
            ? new Date(boleto.dueDate).toLocaleDateString("pt-BR")
            : "-";
          console.log(`🚨 Boleto vencido em ${vencBR} — reativando bloqueio CPF ${cpf}...`);

          await execAsync(`node "${ROBOT_CREATE_BILLING}" ${boleto.imei} ${boleto.installmentId}`,
            { timeout: 60000 }
          )
            .then(() => {
              console.log(`💣 Bloqueio reativado com sucesso para CPF ${cpf}`);
            })
            .catch((err) => {
              logErro("PMB-018", `Falha ao reativar bloqueio CPF ${cpf}.`, err);
            });
        } catch (erroCpf) {
          logErro("PMB-019", `Erro ao processar CPF ${cpf} na rechecagem 24h.`, erroCpf);
        }
      }

      if (alterou) salvarHistorico();
    } catch (err) {
      logErro("PMB-020", "Erro na rechecagem 24h.", err);
    } finally {
      rechecando = false;
    }
  }

  setInterval(verificar, VERIFICACAO_INTERVALO_HORAS * 60 * 60 * 1000);
}

await iniciarBot();
