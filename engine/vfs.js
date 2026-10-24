// In-memory file system. Nothing here touches the real disk.

export class ShellError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const DIR_MODE = 0o755;
const FILE_MODE = 0o644;

function makeDir(mtime) {
  return { type: 'dir', children: {}, mode: DIR_MODE, mtime };
}

function makeFile(content, mtime, mode = FILE_MODE) {
  return { type: 'file', content, mode, mtime, size: null };
}

export function splitPath(path) {
  return path.split('/').filter(Boolean);
}

export function joinPath(...parts) {
  const joined = parts.join('/').replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

export function dirname(path) {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function basename(path) {
  return path.slice(path.lastIndexOf('/') + 1);
}

export class VFS {
  constructor(now = Date.now()) {
    this.now = now;
    this.root = makeDir(now);
  }

  // Turn any path the student types into a clean absolute path.
  resolve(path, cwd = '/', home = '/') {
    if (path === '~' || path === '') path = home;
    else if (path.startsWith('~/')) path = home + path.slice(1);
    const start = path.startsWith('/') ? [] : splitPath(cwd);
    for (const part of splitPath(path)) {
      if (part === '.') continue;
      if (part === '..') start.pop();
      else start.push(part);
    }
    return '/' + start.join('/');
  }

  get(path) {
    let node = this.root;
    for (const part of splitPath(path)) {
      if (node.type !== 'dir' || !(part in node.children)) return null;
      node = node.children[part];
    }
    return node;
  }

  // Parent directory node of a path, or an error a real shell would print.
  // With forWrite, the parent must also be a folder the user may change.
  parentDir(path, forWrite = false) {
    const parent = this.get(dirname(path));
    if (!parent) throw new ShellError('ENOENT', 'No such file or directory');
    if (parent.type !== 'dir') throw new ShellError('ENOTDIR', 'Not a directory');
    if (forWrite) this.checkWrite(dirname(path));
    return parent;
  }

  // The Shell sets canWrite(dir) once the machine is built, so students can't
  // change /opt, other people's homes, or the top-level folders.
  checkWrite(dir) {
    if (this.canWrite && !this.canWrite(dir)) throw new ShellError('EACCES', 'Permission denied');
  }

  mkdir(path, { parents = false, mtime = this.now } = {}) {
    if (parents) {
      let node = this.root;
      let at = '';
      for (const part of splitPath(path)) {
        if (!(part in node.children)) {
          this.checkWrite(at || '/');
          node.children[part] = makeDir(mtime);
        }
        node = node.children[part];
        at += '/' + part;
        if (node.type !== 'dir') throw new ShellError('ENOTDIR', 'Not a directory');
      }
      return node;
    }
    const parent = this.parentDir(path);
    const name = basename(path);
    if (name in parent.children) throw new ShellError('EEXIST', 'File exists');
    this.checkWrite(dirname(path));
    parent.children[name] = makeDir(mtime);
    return parent.children[name];
  }

  writeFile(path, content, { append = false, mtime = this.now, mode } = {}) {
    const parent = this.parentDir(path, true);
    const name = basename(path);
    const existing = parent.children[name];
    if (existing && existing.type === 'dir') throw new ShellError('EISDIR', 'Is a directory');
    if (existing) {
      existing.content = append ? existing.content + content : content;
      existing.mtime = mtime;
      existing.size = null;
      if (mode !== undefined) existing.mode = mode;
      return existing;
    }
    parent.children[name] = makeFile(content, mtime, mode);
    return parent.children[name];
  }

  readFile(path) {
    const node = this.get(path);
    if (!node) throw new ShellError('ENOENT', 'No such file or directory');
    if (node.type === 'dir') throw new ShellError('EISDIR', 'Is a directory');
    return node.content;
  }

  remove(path) {
    const parent = this.parentDir(path, true);
    const name = basename(path);
    if (!(name in parent.children)) throw new ShellError('ENOENT', 'No such file or directory');
    delete parent.children[name];
  }

  // Attach an existing node (used by cp and mv).
  put(path, node) {
    const parent = this.parentDir(path, true);
    parent.children[basename(path)] = node;
  }

  list(path) {
    const node = this.get(path);
    if (!node) throw new ShellError('ENOENT', 'No such file or directory');
    if (node.type !== 'dir') throw new ShellError('ENOTDIR', 'Not a directory');
    return Object.keys(node.children).sort((a, b) => a.localeCompare(b));
  }

  // Walk every node under a path, depth first, sorted by name.
  *walk(path, depth = 0) {
    const node = this.get(path);
    if (!node) return;
    yield { path, node, depth };
    if (node.type !== 'dir') return;
    for (const name of Object.keys(node.children).sort()) {
      yield* this.walk(path === '/' ? '/' + name : path + '/' + name, depth + 1);
    }
  }

  static sizeOf(node) {
    if (node.type === 'dir') return 4096;
    return node.size ?? new TextEncoder().encode(node.content).length;
  }

  static clone(node) {
    return structuredClone(node);
  }
}
