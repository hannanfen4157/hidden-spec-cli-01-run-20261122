// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A,
// JSON edits), finds the lines each edit names at the first of three matching
// tiers, and writes every change or none, printing what it changed or why it
// failed. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of an old/new pair: ctx lines are in both, the rest only in one. */
type Seg = { text: string; ctx: boolean; oIndex: number };
/** One body line of a hunk or chunk: empty marks a zero-length patch line. */
type BodyItem = { kind: 'ctx' | 'old' | 'new' | 'backslash'; text: string; empty: boolean };

function buildON(items: BodyItem[]): { o: Seg[]; n: Seg[] } {
  const o: Seg[] = [];
  const n: Seg[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      const idx = o.length;
      o.push({ text: it.text, ctx: true, oIndex: idx });
      n.push({ text: it.text, ctx: true, oIndex: idx });
    } else if (it.kind === 'old') {
      o.push({ text: it.text, ctx: false, oIndex: -1 });
    } else if (it.kind === 'new') {
      n.push({ text: it.text, ctx: false, oIndex: -1 });
    }
  }
  return { o, n };
}

/** A file's lines, its line break, and whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function renderFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** A line as a matching tier sees it. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const n = o.length;
  if (n === 0) return out;
  const no = o.map((l) => norm(l, tier));
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (norm(lines[i + j]!, tier) !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, with every occurrence there, or null. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrences(lines, o, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** The lines N writes over O at position `at`: context lines are the file's own. */
function buildReplacement(fileLines: string[], at: number, oSegs: Seg[], nSegs: Seg[], tier: number): string[] {
  let p = '';
  let f = '';
  if (tier === 2 && oSegs.length > 0) {
    p = leadingWs(oSegs[0]!.text);
    f = leadingWs(fileLines[at] ?? '');
  }
  return nSegs.map((s) => {
    if (s.ctx) return fileLines[at + s.oIndex]!;
    if (tier === 2) return reindent(s.text, p, f);
    return s.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** --- Unified diffs (SPEC section 6) --- */

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;

interface Hunk {
  a: number;
  o: Seg[];
  n: Seg[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinal: boolean;
  /** A `\` line follows the hunk's last `+` line, and it has one. */
  plusNoFinal: boolean;
  hasPlus: boolean;
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  /** From a `---`/`+++` pair; undefined when no pair named it. '\0' is /dev/null. */
  oldPath: string | undefined;
  newPath: string | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  hasPair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names, '\0' for /dev/null. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return '\0';
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let phase: 'outside' | 'header' | 'body' | 'after' = 'outside';
  let body: BodyItem[] = [];
  let hunkA = 0;

  const blankSection = (): UniSection => ({
    gitOld: null,
    gitNew: null,
    oldPath: undefined,
    newPath: undefined,
    renameFrom: null,
    renameTo: null,
    hasPair: false,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });

  function flushHunk(): void {
    if (phase !== 'body' || cur === null) return;
    while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
    let noFinal = false;
    let plusNoFinal = false;
    let hasPlus = false;
    for (let j = body.length - 1; j >= 0; j--) {
      if (body[j]!.kind === 'ctx' || body[j]!.kind === 'new') {
        noFinal = body[j + 1]?.kind === 'backslash';
        break;
      }
    }
    for (let j = body.length - 1; j >= 0; j--) {
      if (body[j]!.kind === 'new') {
        hasPlus = true;
        plusNoFinal = body[j + 1]?.kind === 'backslash';
        break;
      }
    }
    const { o, n } = buildON(body.filter((b) => b.kind !== 'backslash'));
    cur.hunks.push({ a: hunkA, o, n, noFinal, plusNoFinal, hasPlus });
    body = [];
    phase = 'after';
  }

  function startSection(s: UniSection): void {
    flushHunk();
    if (cur !== null) sections.push(cur);
    cur = s;
    phase = 'header';
  }

  function startHunk(lineNo: number, line: string): void {
    const m = HUNK_RE.exec(line);
    if (m === null) throw new Exit2(`error: parse ${lineNo}`);
    hunkA = Number(m[1]);
    body = [];
    phase = 'body';
  }

  /** A `--- ` line with a `+++ ` line after it, as a path pair, or null. */
  function tryPair(i: number): { oldP: string; newP: string } | null {
    const a = lines[i]!;
    const b = lines[i + 1];
    if (b === undefined || !b.startsWith('+++ ')) return null;
    return { oldP: headerPath(a), newP: headerPath(b) };
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (phase === 'outside') {
      if (line.startsWith('diff --git ')) {
        const m = DIFF_GIT_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${lineNo}`);
        const s = blankSection();
        s.gitOld = m[1]!;
        s.gitNew = m[2]!;
        startSection(s);
        i++;
      } else if (line.startsWith('--- ')) {
        const pair = tryPair(i);
        if (pair === null) {
          i++;
        } else {
          const s = blankSection();
          s.oldPath = pair.oldP;
          s.newPath = pair.newP;
          s.hasPair = true;
          startSection(s);
          i += 2;
        }
      } else if (line.startsWith('@@')) {
        throw new Exit2(`error: parse ${lineNo}`);
      } else {
        i++;
      }
      continue;
    }
    if (phase === 'header') {
      if (line.startsWith('diff --git ')) {
        const m = DIFF_GIT_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${lineNo}`);
        const s = blankSection();
        s.gitOld = m[1]!;
        s.gitNew = m[2]!;
        startSection(s);
        i++;
      } else if (line.startsWith('--- ')) {
        const pair = tryPair(i);
        if (pair === null) throw new Exit2(`error: parse ${lineNo + 1}`);
        if (cur!.hasPair) {
          const s = blankSection();
          s.oldPath = pair.oldP;
          s.newPath = pair.newP;
          s.hasPair = true;
          startSection(s);
        } else {
          cur!.oldPath = pair.oldP;
          cur!.newPath = pair.newP;
          cur!.hasPair = true;
        }
        i += 2;
      } else if (line.startsWith('+++ ')) {
        cur!.newPath = headerPath(line);
        i++;
      } else if (line.startsWith('@@')) {
        startHunk(lineNo, line);
        i++;
      } else if (line.startsWith('rename from ')) {
        const p = line.slice(12).trim();
        cur!.renameFrom = p === '/dev/null' ? '\0' : p;
        i++;
      } else if (line.startsWith('rename to ')) {
        const p = line.slice(10).trim();
        cur!.renameTo = p === '/dev/null' ? '\0' : p;
        i++;
      } else if (line.startsWith('new file mode')) {
        cur!.newFile = true;
        i++;
      } else if (line.startsWith('deleted file mode')) {
        cur!.deletedFile = true;
        i++;
      } else {
        i++;
      }
      continue;
    }
    if (phase === 'body') {
      if (line.startsWith('diff --git ')) {
        const m = DIFF_GIT_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${lineNo}`);
        const s = blankSection();
        s.gitOld = m[1]!;
        s.gitNew = m[2]!;
        startSection(s);
        i++;
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const pair = tryPair(i)!;
        const s = blankSection();
        s.oldPath = pair.oldP;
        s.newPath = pair.newP;
        s.hasPair = true;
        startSection(s);
        i += 2;
      } else if (line.startsWith('@@')) {
        flushHunk();
        startHunk(lineNo, line);
        i++;
      } else if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        if (line.startsWith('\\') && body.length === 0) throw new Exit2(`error: parse ${lineNo}`);
        if (line === '') body.push({ kind: 'ctx', text: '', empty: true });
        else if (line.startsWith(' ')) body.push({ kind: 'ctx', text: line.slice(1), empty: false });
        else if (line.startsWith('-')) body.push({ kind: 'old', text: line.slice(1), empty: false });
        else if (line.startsWith('+')) body.push({ kind: 'new', text: line.slice(1), empty: false });
        else body.push({ kind: 'backslash', text: line.slice(1), empty: false });
        i++;
      } else {
        flushHunk();
      }
      continue;
    }
    // phase === 'after'
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      const s = blankSection();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      startSection(s);
      i++;
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const pair = tryPair(i)!;
      const s = blankSection();
      s.oldPath = pair.oldP;
      s.newPath = pair.newP;
      s.hasPair = true;
      startSection(s);
      i += 2;
    } else if (line.startsWith('@@')) {
      startHunk(lineNo, line);
      i++;
    } else {
      i++;
    }
  }
  flushHunk();
  if (cur !== null) sections.push(cur);
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  const oldRaw = s.oldPath ?? s.renameFrom ?? s.gitOld ?? '\0';
  const newRaw = s.newPath ?? s.renameTo ?? s.gitNew ?? '\0';
  const oldP: string | null = oldRaw === '\0' ? null : oldRaw;
  const newP: string | null = newRaw === '\0' ? null : newRaw;
  const isCreate = oldP === null || s.newFile;
  const isDelete = !isCreate && (newP === null || s.deletedFile);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  return (tree: Tree): void => {
    if (isCreate) {
      const p = newP;
      if (p === null) return;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noFinal = false;
      for (const h of s.hunks) {
        for (const seg of h.n) if (!seg.ctx) plus.push(seg.text);
        if (h.hasPlus) noFinal = h.plusNoFinal;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = oldP!;
    const q = isMove ? newP! : oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (isMove && !safe(q)) throw new Fail('unsafe', q);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(q) !== null) throw new Fail('exists', q);
    const f = splitFile(before);
    let fileLines = f.lines;
    let finalBr = f.final;
    let d = 0;
    for (const h of s.hunks) {
      if (h.o.length === 0) {
        const idx = Math.min(Math.max(h.a + d, 0), fileLines.length);
        const atEnd = idx === fileLines.length;
        const ins = h.n.map((seg) => seg.text);
        fileLines = [...fileLines.slice(0, idx), ...ins, ...fileLines.slice(idx)];
        if (atEnd) finalBr = !h.noFinal;
        d += h.n.length;
      } else {
        const found = findTier(fileLines, h.o.map((seg) => seg.text), strict);
        if (found === null) throw new Fail('no-match', p);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of found.positions) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const atEnd = best + h.o.length === fileLines.length;
        const repl = buildReplacement(fileLines, best, h.o, h.n, found.tier);
        fileLines = [...fileLines.slice(0, best), ...repl, ...fileLines.slice(best + h.o.length)];
        if (atEnd) finalBr = !h.noFinal;
        d += h.n.length - h.o.length;
      }
    }
    const text = renderFile(fileLines, f.br, finalBr);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(q, text);
      tree.moves.push([p, q]);
    } else {
      tree.now.set(p, text);
    }
  };
}

/** --- SEARCH/REPLACE blocks (SPEC section 7) --- */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const oSegs = oldLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const nSegs = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const repl = buildReplacement(f.lines, pos, oSegs, nSegs, found.tier);
    const lines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + oldLines.length)];
    tree.now.set(path, renderFile(lines, f.br, f.final));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** --- V4A patches (SPEC section 8) --- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: Seg[];
  n: Seg[];
}

function v4aEdit(kind: 'add' | 'delete' | 'update', path: string, raw: Array<{ text: string; no: number }>, updateLineNo: number, strict: boolean): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const { text, no } of raw) {
      if (text.startsWith('+')) fileLines.push(text.slice(1));
      else if (text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${no}`);
    }
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (const { no } of raw) throw new Exit2(`error: parse ${no}`);
    return (tree: Tree): void => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // update: parse the move line and the chunks
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; items: BodyItem[] } | null = null;
  let started = false;
  let firstLine = true;
  const finishChunk = (): void => {
    if (cur === null) return;
    const { o, n } = buildON(cur.items.filter((b) => b.kind !== 'backslash'));
    chunks.push({ anchor: cur.anchor === '' ? null : cur.anchor, eof: cur.eof, o, n });
    cur = null;
  };
  for (const { text: line, no } of raw) {
    if (firstLine && line.startsWith('*** Move to: ')) {
      moveTo = line.slice(13).trim();
      firstLine = false;
      continue;
    }
    firstLine = false;
    if (line.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${no}`);
    if (line === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      finishChunk();
      continue;
    }
    if (line.startsWith('@@')) {
      finishChunk();
      cur = { anchor: line.slice(2).trim(), eof: false, items: [] };
      started = true;
      continue;
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (cur === null) {
        if (!started) {
          cur = { anchor: null, eof: false, items: [] };
          started = true;
        } else if (blank(line)) {
          continue;
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      if (line === '') cur.items.push({ kind: 'ctx', text: '', empty: true });
      else if (line.startsWith(' ')) cur.items.push({ kind: 'ctx', text: line.slice(1), empty: false });
      else if (line.startsWith('-')) cur.items.push({ kind: 'old', text: line.slice(1), empty: false });
      else cur.items.push({ kind: 'new', text: line.slice(1), empty: false });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  finishChunk();
  if (moveTo === null && chunks.length === 0) throw new Exit2(`error: parse ${updateLineNo}`);
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let fileLines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundIdx = -1;
        for (let t = 0; t <= 2 && foundIdx < 0; t++) {
          if (strict && t > 0) break;
          for (let k = cursor; k < fileLines.length; k++) {
            if (norm(fileLines[k]!, t) === norm(ch.anchor, t)) {
              foundIdx = k;
              break;
            }
          }
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      const oTexts = ch.o.map((s) => s.text);
      if (oTexts.length === 0) {
        const idx = ch.eof ? fileLines.length : cursor;
        const ins = ch.n.map((s) => s.text);
        fileLines = [...fileLines.slice(0, idx), ...ins, ...fileLines.slice(idx)];
        cursor = idx + ins.length;
      } else {
        let found: { tier: number; pos: number } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const pos = occurrences(fileLines, oTexts, t).filter((p) => p >= cursor && (!ch.eof || p + oTexts.length === fileLines.length));
          if (pos.length > 0) {
            found = { tier: t, pos: pos[0]! };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', path);
        const repl = buildReplacement(fileLines, found.pos, ch.o, ch.n, found.tier);
        fileLines = [...fileLines.slice(0, found.pos), ...repl, ...fileLines.slice(found.pos + oTexts.length)];
        cursor = found.pos + repl.length;
      }
    }
    const text = renderFile(fileLines, f.br, f.final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const m = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1] === 'Add' ? 'add' : m[1] === 'Delete' ? 'delete' : 'update';
    const path = m[2]!.trim();
    const updateLineNo = i + 1;
    const raw: Array<{ text: string; no: number }> = [];
    i++;
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, no: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(v4aEdit(kind, path, raw, updateLineNo, strict));
  }
  return edits;
}

/** --- JSON edits (SPEC section 9) --- */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(lines, f.br, f.final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** --- Running the patch (SPEC sections 1, 2 and 10) --- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const moved = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      moved.add(oldP);
      moved.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    const deleted: string[] = [];
    const written: string[] = [];
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) deleted.push(p);
      else written.push(p);
    }
    for (const p of deleted) rmSync(p, { force: true });
    for (const p of written) {
      try {
        if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
      } catch {
        // not there, or not a directory: write it below
      }
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, tree.now.get(p)!);
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
