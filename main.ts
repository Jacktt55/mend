// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md sections 1 to 10: the command line, output and exit codes, safe paths, format detection,
// three-tier line matching (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7),
// V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** Move pairs recorded by move edits that applied, for the R output lines (section 2). Reset per run. */
let movePairs: Array<[string, string]> = [];

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---------------------------------------------------------------------------
// Section 3 helpers: a file's line break, its lines, its final-break flag.
// ---------------------------------------------------------------------------

interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function serialize(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

// ---------------------------------------------------------------------------
// Section 5: three-tier line matching and building the replacement lines.
// ---------------------------------------------------------------------------

type Op = { kind: 'ctx' | 'del' | 'add'; text: string };

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineMatches(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** First tier (0, then 1, then 2; only 0 with --strict) at which O occurs at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = occurrences(lines, o, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/**
 * Build the lines N writes when O is replaced at position `pos` in `fileLines`.
 * Context lines are written as the file's own matched lines; at tier 2 every
 * other line of N is re-indented (P -> F, literally, including P empty).
 */
function buildReplacement(ops: Op[], fileLines: string[], pos: number, tier: number): string[] {
  const o: string[] = [];
  for (const op of ops) if (op.kind !== 'add') o.push(op.text);
  const f = o.length > 0 ? leadWs(fileLines[pos] ?? '') : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(fileLines[pos + oi] ?? op.text);
      oi += 1;
    } else if (op.kind === 'del') {
      oi += 1;
    } else {
      let t = op.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  ops: Op[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNL: boolean;
  hasPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  lastPlusNoNL: boolean;
}

interface Section {
  diffOld?: string;
  diffNew?: string;
  headerOld?: string | null;
  headerNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  inHeader: boolean;
}

/** Path from a `--- ` / `+++ ` header line: after 4 chars, up to first tab, trimmed; a/ b/ stripped. */
function headerPath(line: string): string | null {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  const s = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) return s.slice(2);
  return s;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( |$)/;

/** Parse one hunk starting at lines[h] (a valid header). Returns the hunk and the index after its body. */
function parseHunk(lines: string[], h: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[h]!)!;
  const a = Number(m[1]);
  const body: string[] = [];
  let j = h + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const ops: Op[] = [];
  for (const raw of body) {
    if (raw.startsWith('\\')) continue;
    if (raw === '') ops.push({ kind: 'ctx', text: '' });
    else if (raw[0] === ' ') ops.push({ kind: 'ctx', text: raw.slice(1) });
    else if (raw[0] === '-') ops.push({ kind: 'del', text: raw.slice(1) });
    else ops.push({ kind: 'add', text: raw.slice(1) });
  }
  // A `\` line follows the last context/`+` line, and the last `+` line.
  // Only the last such line in the body decides.
  let noNL = false;
  let lastPlusNoNL = false;
  let hasPlus = false;
  let lastCtxAdd = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k += 1) {
    const raw = body[k]!;
    if (raw === '' || raw[0] === ' ' || raw[0] === '+') lastCtxAdd = k;
    if (raw[0] === '+') {
      hasPlus = true;
      lastPlus = k;
    }
  }
  if (lastCtxAdd >= 0) noNL = lastCtxAdd + 1 < body.length && body[lastCtxAdd + 1]!.startsWith('\\');
  if (lastPlus >= 0) lastPlusNoNL = lastPlus + 1 < body.length && body[lastPlus + 1]!.startsWith('\\');
  return { hunk: { a, ops, noNL, hasPlus, lastPlusNoNL }, next: j };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1], diffNew: m[2], create: false, del: false, hunks: [], inHeader: true };
      sections.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.inHeader && cur.headerOld === undefined) {
        cur.headerOld = headerPath(l);
        cur.headerNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = { headerOld: headerPath(l), headerNew: headerPath(lines[i + 1]!), create: false, del: false, hunks: [], inHeader: true };
      sections.push(cur);
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && cur.inHeader && cur.headerOld === undefined) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      if (!HUNK_RE.test(l)) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      cur.inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Apply a section's hunks to a file's text; throws Fail('no-match', path) on a hunk that does not match. */
function applyUnifiedHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const { br, lines, final } = fileParts(before);
  let curLines = [...lines];
  let curFinal = final;
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    for (const op of h.ops) if (op.kind !== 'add') o.push(op.text);
    const nLen = h.ops.filter((op) => op.kind !== 'del').length;
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > curLines.length) pos = curLines.length;
      const atEnd = pos === curLines.length;
      const repl = buildReplacement(h.ops, curLines, pos, 0);
      curLines.splice(pos, 0, ...repl);
      if (atEnd) curFinal = !h.noNL;
      d += repl.length;
    } else {
      const found = findTier(curLines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(h.ops, curLines, best, found.tier);
      const atEnd = best + o.length === curLines.length;
      curLines.splice(best, o.length, ...repl);
      if (atEnd) curFinal = !h.noNL;
      d += repl.length - o.length;
    }
  }
  return serialize(curLines, br, curFinal);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    const oldRaw = sec.headerOld !== undefined ? sec.headerOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
    const newRaw = sec.headerNew !== undefined ? sec.headerNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
    const oldPath = oldRaw === undefined ? newRaw : oldRaw;
    const newPath = newRaw === undefined ? oldRaw : newRaw;
    const isCreate = sec.create || oldPath === null;
    const isDelete = !isCreate && (sec.del || newPath === null);
    if (isCreate) {
      const p = newPath ?? '';
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let hasPlus = false;
        let lastPlusNoNL = false;
        for (const h of sec.hunks) {
          for (const op of h.ops) if (op.kind === 'add') plus.push(op.text);
          if (h.hasPlus) {
            hasPlus = true;
            lastPlusNoNL = h.lastPlusNoNL;
          }
        }
        const finalBreak = !hasPlus || !lastPlusNoNL;
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      };
    }
    if (isDelete) {
      const p = oldPath ?? '';
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      };
    }
    if (oldPath !== newPath) {
      const oldP = oldPath ?? '';
      const newP = newPath ?? '';
      return (tree: Tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const out = applyUnifiedHunks(before, sec.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, out);
        movePairs.push([oldP, newP]);
      };
    }
    const p = oldPath ?? '';
    return (tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyUnifiedHunks(before, sec.hunks, strict, p));
    };
  });
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let path: string | undefined;
    for (let j = sIdx - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) {
      if (prevPath !== undefined) path = prevPath;
      else throw new Exit2(`error: parse ${sIdx + 1}`);
    }
    let sep = -1;
    for (let j = sIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const { br, lines: fileLines, final } = fileParts(before);
      const found = findTier(fileLines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const ops: Op[] = [
        ...oldLines.map((t): Op => ({ kind: 'del', text: t })),
        ...newLines.map((t): Op => ({ kind: 'add', text: t })),
      ];
      const repl = buildReplacement(ops, fileLines, pos, found.tier);
      const out = [...fileLines];
      out.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, serialize(out, br, final));
    });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  lines.forEach((l, idx) => {
    if (!blank(l)) last = idx;
  });
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    if (!isSectionStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j += 1;
    const body = lines.slice(i + 1, j);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    const lineNo = (k: number): number => i + 2 + k; // 1-based line of body[k]
    if (l.startsWith('*** Add File:')) {
      const p = l.slice('*** Add File:'.length).trim();
      const fileLines: string[] = [];
      body.forEach((bl, k) => {
        if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else if (blank(bl)) fileLines.push('');
        else throw new Exit2(`error: parse ${lineNo(k)}`);
      });
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (l.startsWith('*** Delete File:')) {
      const p = l.slice('*** Delete File:'.length).trim();
      body.forEach((bl, k) => {
        if (!blank(bl)) throw new Exit2(`error: parse ${lineNo(k)}`);
      });
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = l.slice('*** Update File:'.length).trim();
      let moveTo: string | undefined;
      let start = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to:')) {
        moveTo = body[0]!.slice('*** Move to:'.length).trim();
        start = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      const close = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (let k = start; k < body.length; k += 1) {
        const bl = body[k]!;
        if (bl.startsWith('@@')) {
          close();
          const anchor = bl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
          continue;
        }
        if (bl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${lineNo(k)}`);
          cur.eof = true;
          close();
          continue;
        }
        if (blank(bl)) {
          if (cur === null) cur = { anchor: null, eof: false, ops: [] };
          cur.ops.push({ kind: 'ctx', text: '' });
          continue;
        }
        if (bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (cur === null) cur = { anchor: null, eof: false, ops: [] };
          cur.ops.push({ kind: bl[0] === ' ' ? 'ctx' : bl[0] === '-' ? 'del' : 'add', text: bl.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${lineNo(k)}`);
      }
      close();
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${i + 1}`);
      const move = moveTo;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (move !== undefined && !safe(move)) throw new Fail('unsafe', move);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (move !== undefined && tree.get(move) !== null) throw new Fail('exists', move);
        const { br, lines: fileLines, final } = fileParts(before);
        const curLines = [...fileLines];
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const f = findTier(curLines, [ch.anchor], strict, cursor);
            if (f === null) throw new Fail('no-match', p);
            cursor = f.occ[0]! + 1;
          }
          const o: string[] = [];
          for (const op of ch.ops) if (op.kind !== 'add') o.push(op.text);
          if (o.length === 0) {
            const pos = ch.eof ? curLines.length : cursor;
            const repl = buildReplacement(ch.ops, curLines, pos, 0);
            curLines.splice(pos, 0, ...repl);
            cursor = pos + repl.length;
          } else {
            const f = findTier(curLines, o, strict, cursor);
            if (f === null) throw new Fail('no-match', p);
            let pos: number | undefined;
            if (ch.eof) {
              pos = f.occ.find((q) => q + o.length === curLines.length);
              if (pos === undefined) throw new Fail('no-match', p);
            } else {
              pos = f.occ[0]!;
            }
            const repl = buildReplacement(ch.ops, curLines, pos, f.tier);
            curLines.splice(pos, o.length, ...repl);
            cursor = pos + repl.length;
          }
        }
        const out = serialize(curLines, br, final);
        if (move !== undefined) {
          tree.now.set(p, null);
          tree.now.set(move, out);
          movePairs.push([p, move]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  movePairs = [];
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of movePairs) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      const di = rows.findIndex((r) => r.text === `D ${oldP}`);
      const ai = rows.findIndex((r) => r.text === `A ${newP}`);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
