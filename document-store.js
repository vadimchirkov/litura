import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

// A lock coordinates Litura processes. External editors do not participate;
// recheck immediately before rename and retain the previous disk copy.
export function documentStore(filename) {
  const resolved = path.resolve(filename);
  const file = fs.existsSync(resolved) ? fs.realpathSync(resolved) : path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  const historyDir = `${file}.litura-history`;
  function read() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (text !== undefined && Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) {
      throw new Error('Draft exceeds the 1 MB editing limit. Open a smaller document.');
    }
    return { text: text ?? '', exists: text !== undefined, revision: text === undefined ? 'missing' : hash(text), path: file, id: hash(file) };
  }
  function history() {
    let files;
    try { files = fs.readdirSync(historyDir); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return files.filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name)).sort().reverse().slice(0, 20)
      .map(name => JSON.parse(fs.readFileSync(path.join(historyDir, name), 'utf8')));
  }
  function write(text, revision) {
    if (typeof text !== 'string' || typeof revision !== 'string') throw Object.assign(new Error('text and revision are required strings'), { status: 400 });
    if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw Object.assign(new Error('Draft exceeds 1 MB'), { status: 413 });
    const lock = `${file}.litura-lock`;
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(new Error(`Another save is active. If Litura crashed, close its processes and remove ${lock}.`), { status: 423 });
      throw error;
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const before = read();
      if (before.revision !== revision) throw Object.assign(new Error('The file changed. Choose which copy to keep.'), { status: 409, current: before });
      if (before.exists && before.text === text) return before;
      if (before.exists) {
        fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(historyDir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ text: before.text, at: new Date().toISOString(), revision: before.revision }), { mode: 0o600 });
      }
      const mode = before.exists ? fs.statSync(file).mode & 0o777 : 0o600;
      const output = fs.openSync(temp, 'wx', mode);
      try { fs.writeFileSync(output, text, 'utf8'); fs.fsyncSync(output); }
      finally { fs.closeSync(output); }
      if (read().revision !== revision) throw Object.assign(new Error('The file changed during save.'), { status: 409, current: read() });
      fs.renameSync(temp, file);
      return read();
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  }
  return { read, write, history };
}
