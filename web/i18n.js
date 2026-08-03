/**
 * Two languages, no build step.
 *
 * Static markup carries `data-i18n` (and `-placeholder`, `-aria`, `-title`)
 * and gets filled in on boot; strings built in JS go through `t()`. A missing
 * key falls back to English rather than rendering a key name at someone, and
 * English itself is the source text, so an untranslated string is still a
 * sentence.
 */

const STORAGE_KEY = 'crc.lang';

export const LANGUAGES = [
  { id: 'auto', label: 'Automatic' },
  { id: 'en', label: 'English' },
  { id: 'pt', label: 'Português' },
];

const DICTIONARY = {
  pt: {
    // --- guided setup ---
    'welcome.title': 'Sua máquina, no bolso',
    'welcome.sub': 'Um minuto pra conferir o Mac e parear este aparelho. Depois é só conversar.',
    'welcome.start': 'Começar',
    'welcome.have': 'Já tenho um código',
    'setup.step1': 'Passo 1 de 3',
    'setup.title1': 'Conferindo o seu Mac',
    'setup.toPair': 'Parear este aparelho',
    'setup.waiting': 'Falando com o daemon…',
    'setup.noDaemon': 'Este endereço não responde.',
    'setup.mac': 'Seu Mac',
    'setup.network': 'Rede',
    'setup.daemon': 'Daemon crc',
    'setup.listening': 'porta {port} · v{version}',
    'setup.agentReady': 'conectado',
    'setup.agentNone': 'não conectado — resolva nos Ajustes depois de parear',
    'setup.netLocal': 'neste Mac',
    'setup.netTailnet': 'pelo Tailscale',
    'setup.netLan': 'rede local',
    'setup.netLanTs': 'rede local — Tailscale também no ar',
    'setup.step3': 'Passo 3 de 3',
    'setup.title3': 'Escolha um projeto',
    'setup.sub3': 'É daqui que as sessões novas começam. Dá pra mudar depois, ou escolher outra pasta na hora.',
    'setup.browse': 'Outra pasta…',
    'setup.continue': 'Continuar',
    'setup.later': 'Decido depois',

    // --- pairing ---
    'gate.step': 'Passo 2 de 3',
    'gate.title': 'O código na sua tela',
    'gate.noCode': 'Sem código na tela?',
    'gate.tokenLabel': 'Ou cole o token principal',
    'gate.sub': 'Clique no >_ na barra de menu do seu Mac e leia os seis dígitos.',
    'gate.scan': 'Escanear o QR code',
    'gate.photo': 'Tirar foto do código',
    'gate.scanNote': 'Abre a câmera. Aponte para o código no seu Mac.',
    'gate.or': 'ou',
    'gate.codeLabel': 'Código de pareamento ou token',
    'gate.nameLabel': 'Nome do aparelho',
    'gate.pair': 'Parear aparelho',
    'gate.hint':
      'Abra o app no seu Mac e clique em >_ ▸ Show pairing code. Ele dura dez minutos. Sem o app na barra de menu, rode crc pair num terminal.',
    'scan.title': 'Aponte para o código',
    'scan.hold': 'Segure o código de frente, preenchendo o quadro.',
    'scan.got': 'Peguei.',

    // --- shell ---
    'app.noSession': 'Nenhuma sessão',
    'app.newSession': 'Nova sessão',
    'app.live': 'Ao vivo',
    'app.onThisMachine': 'Nesta máquina',
    'app.mirrorNote': 'Sessões do Claude Desktop e do CLI. Acompanhe e assuma quando quiser.',
    'app.noLive': 'Nenhuma sessão rodando. Comece uma acima.',
    'app.search': 'Buscar conversas',
    'picker.newProject': 'Projeto novo…',
    'picker.projectName': 'Nome da pasta',
    'app.tidyNames': 'Arrumar os nomes com IA',
    'app.tidying': 'Pensando nos nomes…',
    'app.showAll': 'Ver todas as {n}',
    'app.showFewer': 'Ver menos',
    'app.fromDesktop': 'Claude Desktop',
    'app.desktopShort': 'Desktop',
    'app.cliShort': 'Terminal',
    'app.fromCli': 'Terminal',
    'app.noMatches': 'Nada bate com isso.',
    'app.queuedCount': '· {n} na fila',
    'toast.renamed': '{n} renomeadas',
    'toast.renamedNone': 'Os nomes já estavam bons.',
    'app.settings': 'Ajustes e aparelhos',
    'app.machines': 'Computadores',
    'app.addMachine': 'Adicionar outro Mac',
    'toast.addMachine': 'Escaneie o QR code que aparece no outro Mac.',
    'app.empty.title': 'Sua máquina, no bolso',
    'app.empty.sub': 'Comece uma sessão para rodar comandos, editar arquivos e ver o que o Claude faz.',
    'app.composer.placeholder': 'Falar com {agent}…',
    'app.composer.start': 'Comece uma sessão para escrever',
    'app.composer.continue': 'Continue daqui…',
    'app.mirrored': 'espelhada',
    'app.stop': 'Parar',
    'app.working': '{agent} está trabalhando…',
    'toast.tookOver': 'Agora é sua — reabra no Mac e isto vai estar lá.',
    'app.jumpToLatest': 'Ir para o final ↓',

    // --- openers ---
    'openers.tour': 'O que é este projeto?',
    'openers.recent': 'O que mudou?',
    'openers.broken': 'Está quebrado?',
    'openers.next': 'O que faço agora?',

    // --- session sheet ---
    'session.title': 'Sessão',
    'session.mirrored': 'Conversa espelhada',
    'session.folder': 'Pasta',
    'session.agent': 'Agente',
    'session.model': 'Modelo',
    'session.id': 'Id da sessão',
    'session.cost': 'Custo até agora',
    'session.controls': 'Controles',
    'session.permissions': 'Permissões',
    'session.takeover': 'Assumir daqui',
    'session.openDesktop': 'Abrir no Claude Desktop',
    'agent.desktopNote': 'Começa aqui e abre no Claude Desktop do seu Mac assim que responder.',
    'toast.openedDesktop': 'Aberta no seu Mac, no Claude Desktop.',
    'session.end': 'Encerrar sessão',
    'session.stopMirroring': 'Parar de espelhar',
    'session.mirrorExplain':
      'Cópia ao vivo de uma conversa aberta no seu Mac. Assumir continua a mesma conversa daqui — reabra no Mac depois e o que você escreveu no celular está lá. Um de cada vez.',

    // --- permissions ---
    'perm.needed': 'Precisa de permissão',
    'perm.allow': 'Permitir uma vez',
    'perm.always': 'Permitir sempre',
    'perm.deny': 'Negar',
    'perm.ask': 'Perguntar',
    'perm.acceptEdits': 'Aceitar edições',
    'perm.plan': 'Só planejar',
    'perm.bypass': 'Ignorar tudo',

    // --- settings ---
    'settings.title': 'Ajustes',
    'settings.permissions': 'Permissões',
    'settings.neverAsk': 'Nunca pedir permissão',
    'settings.neverAskOn': 'Nada chega nesta tela',
    'settings.neverAskOff': 'Toda ferramenta espera você',
    'settings.voice': 'Voz',
    'settings.readAloud': 'Ler respostas em voz alta',
    'settings.readAloudNote': 'Pula código, caminhos e links',
    'settings.dictation': 'Ditado',
    'settings.dictationOk': 'segure o microfone e fale',
    'settings.dictationOff': 'indisponível aqui',
    'settings.language': 'Idioma',
    'settings.thisMac': 'Este Mac',
    'settings.sleep': 'Suspensão',
    'settings.keepAwake': 'Manter este Mac acordado',
    'settings.lidClosed': 'Rodar com a tampa fechada',
    'settings.projectFolder': 'Pasta de projetos',
    'settings.chooseFolder': 'Escolher uma pasta',
    'settings.anywhere': 'Qualquer lugar deste Mac',
    'settings.browse': 'Procurar',
    'settings.reachableAt': 'Acessível em',
    'settings.reach': 'Como chegar aqui',
    'settings.reachOff': 'HTTP puro na sua rede. Microfone e notificações precisam de HTTPS.',
    'settings.reachTailnet': 'HTTPS na sua tailnet — o celular ainda precisa do Tailscale.',
    'settings.reachOpen': 'Qualquer um com o endereço alcança este Mac. O pareamento continua barrando.',
    'settings.reachTailnetName': 'HTTPS na minha tailnet',
    'settings.reachTailnetWhy': 'Liga o microfone e as notificações',
    'settings.reachOpenName': 'De qualquer lugar, sem Tailscale',
    'settings.reachOpenWhy': 'Publica este Mac na internet — só o pareamento fica no caminho',
    'settings.reachOffName': 'Voltar pra só minha rede',
    'settings.reachOn': 'ligado',
    'settings.reachWorking': 'Falando com o Tailscale…',
    'settings.reachEnable': 'Ligar no tailscale.com',
    'settings.devices': 'Aparelhos pareados ({count})',
    'settings.agents': 'Contas dos agentes',
    'settings.pairAnother': 'Parear outro aparelho',
    'settings.notifications': 'Ativar alertas de permissão',
    'settings.unpair': 'Desparear este aparelho',
    'settings.testedOn': 'Testado em',
    'settings.testedNote': 'Simuladores, não aparelhos',
    'settings.testedNoteSub': 'WebKit real, aparelho virtual',
    'toast.notConnected': 'Sem conexão — aguarde, reconectando.',
    'conn.connecting': 'Reconectando…',
    'conn.offline': 'Sem conexão. Toque para tentar de novo.',
    'app.mirrorNotice': 'Essa aí roda no Claude do seu Mac. Escreva que ela continua daqui.',

    // --- shared verbs ---
    'action.copy': 'Copiar',
    'action.copied': 'Copiado',
    'action.failed': 'Falhou',
    'action.revoke': 'Revogar',
    'action.install': 'Instalar',
    'action.openTerminal': 'Abrir Terminal',
    'action.grant': 'Conceder',
    'action.turnOn': 'Ligar',
    'action.turnOff': 'Desligar',
    'action.useFolder': 'Usar esta pasta',
    'action.tryAgain': 'Tentar este endereço de novo',
    'action.notNow': 'Agora não',
    'action.install2': 'Instalar',
    'action.close': 'Fechar',
    'action.retry': 'Tentar de novo',

    // --- offline / install ---
    'offline.title': 'Não consigo achar seu Mac',
    'offline.detail':
      'Este endereço não responde. Normalmente é o Mac dormindo, ou este celular numa rede diferente da de antes.',
    'offline.tryAnother': 'Tentar outro endereço',
    'offline.needsTailscale': 'O endereço 100.x e o nome da máquina precisam do Tailscale ligado aqui.',
    'install.title': 'Deixe a um toque',
    'install.sub':
      'Instalado, ele abre em tela cheia direto da sua tela de início — sem endereço para lembrar, sem barra de navegador.',

    // --- toasts ---
    'toast.folderSet': 'Sessões novas começam em {path}',
    'toast.deviceRevoked': 'Aparelho revogado',
    'toast.nothingAsks': 'Nada vai perguntar{scope}',
    'toast.asksAgain': 'Perguntando de novo{scope}',
    'toast.noCodeInPhoto':
      'Nenhum código nessa foto. Chegue mais perto, preencha o quadro e mantenha o celular de frente.',
    'toast.notOurCode': 'Isso não é um código de pareamento deste app.',
    'toast.allCode': 'Não há o que ler aqui — é tudo código.',
  },
};

let current = 'en';

/** Which language to actually use, resolving `auto` against the browser. */
export function resolveLanguage(choice) {
  const wanted = choice || localStorage.getItem(STORAGE_KEY) || 'auto';
  if (wanted === 'en') return 'en';
  if (wanted !== 'auto') return DICTIONARY[wanted] ? wanted : 'en';
  const browser = (navigator.language || 'en').toLowerCase();
  return browser.startsWith('pt') ? 'pt' : 'en';
}

export const language = () => current;
export const languageChoice = () => localStorage.getItem(STORAGE_KEY) || 'auto';

export function setLanguage(choice) {
  localStorage.setItem(STORAGE_KEY, choice);
  current = resolveLanguage(choice);
  document.documentElement.lang = current === 'pt' ? 'pt-BR' : 'en';
  applyStaticText();
  return current;
}

/**
 * Translate. `fallback` is the English source text, so a key with no entry
 * still renders a sentence instead of `settings.neverAsk`.
 */
export function t(key, fallback, vars) {
  const table = DICTIONARY[current];
  let text = (table && table[key]) || fallback || key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
}

/** Fill in everything marked up in the HTML. Safe to run repeatedly. */
export function applyStaticText(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    // The English already in the markup is the fallback, so nothing is lost
    // when a key is missing from a dictionary.
    node.dataset.i18nSource ||= node.textContent.trim();
    node.textContent = t(node.dataset.i18n, node.dataset.i18nSource);
  }
  for (const [attribute, dataKey] of [
    ['placeholder', 'i18nPlaceholder'],
    ['aria-label', 'i18nAria'],
    ['title', 'i18nTitle'],
  ]) {
    for (const node of root.querySelectorAll(`[data-${dataKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}]`)) {
      const key = node.dataset[dataKey];
      const sourceKey = `${dataKey}Source`;
      node.dataset[sourceKey] ||= node.getAttribute(attribute) || '';
      node.setAttribute(attribute, t(key, node.dataset[sourceKey]));
    }
  }
}

current = resolveLanguage();
