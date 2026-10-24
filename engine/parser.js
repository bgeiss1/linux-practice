// Turns a command line into pipelines. Supports quotes, backslashes, $VARS,
// ~, globs, |, ;, &&, ||, &, >, >>, 2>, 2>> and 2>&1.

import { ShellError } from './vfs.js';

const OPS = ['2>>', '2>&1', '&&', '||', '>>', '2>', '|', ';', '&', '>'];

export function tokenize(line, env = {}) {
  const tokens = [];
  let i = 0;
  let word = null; // { text, glob, quoted }

  const flush = () => {
    if (word) tokens.push({ type: 'word', ...word });
    word = null;
  };
  const add = (ch, glob = false) => {
    if (!word) word = { text: '', glob: false, quoted: false };
    word.text += ch;
    if (glob) word.glob = true;
  };
  const expandVar = () => {
    // i points at '$'
    let name = '';
    if (line[i + 1] === '{') {
      const end = line.indexOf('}', i + 2);
      if (end < 0) throw new ShellError('SYNTAX', 'bad substitution');
      name = line.slice(i + 2, end);
      i = end + 1;
    } else {
      let j = i + 1;
      while (j < line.length && /[A-Za-z0-9_?]/.test(line[j])) j++;
      name = line.slice(i + 1, j);
      if (!name) { add('$'); i++; return; }
      i = j;
    }
    const value = env[name] ?? '';
    if (!word) word = { text: '', glob: false, quoted: false };
    word.text += value;
  };

  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') { flush(); i++; continue; }
    if (ch === '#' && !word) break; // comment
    const op = OPS.find((o) => line.startsWith(o, i));
    // "2>" only counts as an operator at the start of a word.
    if (op && !(op.startsWith('2') && word)) {
      flush();
      tokens.push({ type: 'op', op });
      i += op.length;
      continue;
    }
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new ShellError('SYNTAX', 'unexpected EOF while looking for matching `\'\'');
      if (!word) word = { text: '', glob: false, quoted: true };
      word.text += line.slice(i + 1, end);
      word.quoted = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      if (!word) word = { text: '', glob: false, quoted: true };
      word.quoted = true;
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length && '"\\$'.includes(line[i + 1])) {
          word.text += line[i + 1];
          i += 2;
        } else if (line[i] === '$') {
          expandVar();
        } else {
          word.text += line[i++];
        }
      }
      if (i >= line.length) throw new ShellError('SYNTAX', 'unexpected EOF while looking for matching `"\'');
      i++;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < line.length) add(line[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '$') { expandVar(); continue; }
    if (ch === '~' && !word && (i + 1 === line.length || line[i + 1] === '/' || line[i + 1] === ' ')) {
      add(env.HOME ?? '~');
      i++;
      continue;
    }
    add(ch, ch === '*' || ch === '?');
    i++;
  }
  flush();
  return tokens;
}

// Returns [{ commands: [{ argv, redirects }], connector, background }]
export function parse(line, env = {}) {
  const tokens = tokenize(line, env);
  const lists = [];
  let pipeline = { commands: [], connector: null, background: false };
  let cmd = { argv: [], redirects: [] };

  const endCommand = (opName) => {
    if (cmd.argv.length === 0) {
      if (cmd.redirects.length || opName) throw new ShellError('SYNTAX', `syntax error near unexpected token \`${opName ?? 'newline'}'`);
      return false;
    }
    pipeline.commands.push(cmd);
    cmd = { argv: [], redirects: [] };
    return true;
  };

  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.type === 'word') { cmd.argv.push(tok); continue; }
    const { op } = tok;
    if (op === '>' || op === '>>' || op === '2>' || op === '2>>') {
      const target = tokens[t + 1];
      if (!target || target.type !== 'word') throw new ShellError('SYNTAX', "syntax error near unexpected token `newline'");
      cmd.redirects.push({ fd: op.startsWith('2') ? 2 : 1, append: op.endsWith('>>'), target: target.text });
      t++;
      continue;
    }
    if (op === '2>&1') { cmd.redirects.push({ fd: 2, toStdout: true }); continue; }
    if (op === '|') { endCommand('|'); continue; }
    // ; && || &
    endCommand(op);
    if (op === '&') pipeline.background = true;
    pipeline.connector = op === '&' ? ';' : op;
    if (pipeline.commands.length) lists.push(pipeline);
    pipeline = { commands: [], connector: null, background: false };
  }
  endCommand(null);
  if (pipeline.commands.length) lists.push(pipeline);
  return lists;
}

// Glob pattern to RegExp for one path segment.
export function globToRegExp(pattern) {
  let re = '^';
  for (const ch of pattern) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}
