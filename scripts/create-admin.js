#!/usr/bin/env node
/**
 * Cria o primeiro usuário do painel admin (email + senha).
 *
 * Uso:
 *   node scripts/create-admin.js admin@exemplo.com "senha-forte" [nome]
 *
 * A senha NUNCA entra no argumento por padrão do shell? Entra sim — fica no
 * histórico do terminal. Para evitar isso, chame sem os dois argumentos e o
 * script pergunta interativamente.
 */
'use strict';

const crypto = require('crypto');
const readline = require('readline');
const path = require('path');

// dotenv e os modulos do server vivem em server/node_modules (nao ha
// node_modules na raiz do repo): a resolucao de modulo do Node sobe a arvore
// a partir de scripts/ e nao encontra server/node_modules. Exigimos pelo
// caminho absoluto para este script funcionar de qualquer cwd.
require(path.resolve(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({
  override: true, path: path.resolve(__dirname, '..', 'server', '.env'),
});
const adminUsers = require(path.resolve(__dirname, '..', 'server', 'admin-users'));

function ask(question, { mute = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (mute) {
      // Esconde a digitação da senha.
      const onData = (char) => {
        char = String(char);
        if (char === '\n' || char === '\r\n' || char === '\u0004') {
          rl.input.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
        } else {
          process.stdout.write('*');
          rl.line += char;
        }
      };
      rl.input.on('data', onData);
      rl.question(question, (answer) => resolve(answer.trim()));
    } else {
      rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
    }
  });
}

async function main() {
  const [, , emailArg, passwordArg, nameArg] = process.argv;

  if (adminUsers.countUsers() > 0 && process.argv.includes('--force') === false) {
    console.error('Ja existe usuario admin. Use --force para criar mais um.');
    process.exit(1);
  }

  const email = emailArg || await ask('Email: ');
  const password = passwordArg || await ask('Senha (min. 8 caracteres): ', { mute: true });

  if (!email) { console.error('Email obrigatorio.'); process.exit(1); }
  if (!adminUsers.isValidEmail(email)) { console.error('Email invalido.'); process.exit(1); }
  if (password.length < 8) { console.error('A senha precisa de pelo menos 8 caracteres.'); process.exit(1); }

  const existing = adminUsers.getUserByEmail(email);
  if (existing) {
    console.error(`Email ja cadastrado: ${existing.email}`);
    process.exit(1);
  }

  const user = adminUsers.createUser(email, password, nameArg || 'Admin');
  console.log('');
  console.log('Usuario admin criado:');
  console.log(`  id:    ${user.id}`);
  console.log(`  email: ${user.email}`);
  console.log(`  nome:  ${user.name}`);
  console.log('');
  console.log('Acesse /admin no frontend e entre com essas credenciais.');
}

main().catch((err) => {
  console.error('Falhou:', err.message);
  process.exit(1);
});
