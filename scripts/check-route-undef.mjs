#!/usr/bin/env node
/**
 * Catch unbound call/new identifiers in @ts-nocheck route files.
 *
 * tsc honors @ts-nocheck, so missing imports become runtime ReferenceErrors.
 * This walks the TS AST with a block/function scope model (including nested
 * function declarations inside try/if blocks) and fails on bare calls like
 * loadTicketBaseGeometry(...) when the name is not imported or declared.
 *
 * Usage: npm run check:route-undef
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'cloudflare', 'deploy', 'package.json'));
const ts = require('typescript');

const scanRoots = [join(root, 'cloudflare', 'deploy', 'src', 'routes')];

const GLOBALS = new Set([
  'AbortController', 'AbortSignal', 'AggregateError', 'Array', 'ArrayBuffer', 'Atomics',
  'BigInt', 'BigInt64Array', 'BigUint64Array', 'Blob', 'Boolean', 'Buffer', 'DataView',
  'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Float32Array', 'Float64Array',
  'FormData', 'Function', 'Headers', 'Infinity', 'Int16Array', 'Int32Array', 'Int8Array',
  'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError',
  'ReadableStream', 'ReferenceError', 'Reflect', 'RegExp', 'Request', 'Response', 'Set',
  'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TextDecoder', 'TextEncoder',
  'TransformStream', 'TypeError', 'URIError', 'URL', 'URLSearchParams', 'Uint16Array',
  'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakRef', 'WeakSet',
  'WebSocket', 'WritableStream', 'atob', 'btoa', 'caches', 'clearImmediate',
  'clearInterval', 'clearTimeout', 'console', 'crypto', 'decodeURI', 'decodeURIComponent',
  'encodeURI', 'encodeURIComponent', 'escape', 'eval', 'fetch', 'global', 'globalThis',
  'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'performance', 'process', 'queueMicrotask',
  'require', 'setImmediate', 'setInterval', 'setTimeout', 'structuredClone', 'undefined',
  'unescape', 'self', 'addEventListener', 'removeEventListener', 'dispatchEvent',
]);

const KEYWORDS_AS_IDENT = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
  'throw', 'try', 'catch', 'finally', 'new', 'delete', 'typeof', 'void', 'yield', 'await',
  'async', 'function', 'class', 'const', 'let', 'var', 'import', 'export', 'default',
  'from', 'of', 'in', 'instanceof', 'with', 'debugger', 'super', 'this', 'true', 'false',
  'null', 'as', 'satisfies', 'type', 'interface', 'enum', 'namespace', 'module', 'declare',
  'abstract', 'readonly', 'public', 'private', 'protected', 'static', 'override', 'get',
  'set', 'extends', 'implements',
]);

function walkDir(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkDir(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(ent.name)) out.push(p);
  }
  return out;
}

function hasTsNocheck(text) {
  return /\/\/\s*@ts-nocheck\b/.test(text) || /\/\*\s*@ts-nocheck\b/.test(text);
}

function stripNocheck(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\/\/\s*@ts-nocheck[^\n]*/g, '')
    .replace(/\/\*\s*@ts-nocheck\b[\s\S]*?\*\//g, '');
}

function addBinding(scope, name) {
  if (name && !KEYWORDS_AS_IDENT.has(name)) scope.add(name);
}

function collectBindingNames(nameNode, into) {
  if (!nameNode) return;
  if (ts.isIdentifier(nameNode)) {
    addBinding(into, nameNode.text);
    return;
  }
  if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.elements) {
      if (ts.isOmittedExpression(el)) continue;
      if (ts.isBindingElement(el)) collectBindingNames(el.name, into);
    }
  }
}

function collectImportBindings(sf, scope) {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (stmt.importClause?.isTypeOnly) continue;
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name) addBinding(scope, clause.name.text);
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      addBinding(scope, bindings.name.text);
    } else if (ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.isTypeOnly) continue;
        addBinding(scope, el.name.text);
      }
    }
  }
}

function collectModuleLevelBindings(sf, scope) {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) addBinding(scope, stmt.name.text);
    if (ts.isClassDeclaration(stmt) && stmt.name) addBinding(scope, stmt.name.text);
    if (ts.isEnumDeclaration(stmt) && stmt.name) addBinding(scope, stmt.name.text);
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        collectBindingNames(decl.name, scope);
      }
    }
  }
}

function hoistBlockBindings(block, scope) {
  if (!block || !ts.isBlock(block)) return;
  for (const stmt of block.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) addBinding(scope, stmt.name.text);
    if (ts.isClassDeclaration(stmt) && stmt.name) addBinding(scope, stmt.name.text);
    if (ts.isVariableStatement(stmt)) {
      // Approximate: treat all block-level bindings as visible for call resolution
      for (const decl of stmt.declarationList.declarations) {
        collectBindingNames(decl.name, scope);
      }
    }
  }
}

function resolveName(name, stack) {
  if (GLOBALS.has(name) || KEYWORDS_AS_IDENT.has(name)) return true;
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].has(name)) return true;
  }
  return false;
}

function reportUnbound(expr, sf, stack, problems) {
  if (!ts.isIdentifier(expr)) return;
  const name = expr.text;
  if (resolveName(name, stack)) return;
  const { line, character } = sf.getLineAndCharacterOfPosition(expr.getStart(sf));
  problems.push({ name, line: line + 1, character: character + 1 });
}

function visit(node, stack, problems, sf) {
  if (!node) return;

  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const scope = new Set();
    stack.push(scope);
    if (
      (ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) &&
      node.name
    ) {
      addBinding(scope, node.name.text);
    }
    for (const p of node.parameters || []) {
      collectBindingNames(p.name, scope);
      if (p.initializer) visit(p.initializer, stack, problems, sf);
    }
    if (node.body) {
      if (ts.isBlock(node.body)) {
        hoistBlockBindings(node.body, scope);
        for (const stmt of node.body.statements) visit(stmt, stack, problems, sf);
      } else {
        visit(node.body, stack, problems, sf);
      }
    }
    stack.pop();
    return;
  }

  if (ts.isBlock(node)) {
    const scope = new Set();
    stack.push(scope);
    hoistBlockBindings(node, scope);
    for (const stmt of node.statements) visit(stmt, stack, problems, sf);
    stack.pop();
    return;
  }

  if (ts.isCatchClause(node)) {
    const scope = new Set();
    stack.push(scope);
    if (node.variableDeclaration) collectBindingNames(node.variableDeclaration.name, scope);
    if (node.block) {
      hoistBlockBindings(node.block, scope);
      for (const stmt of node.block.statements) visit(stmt, stack, problems, sf);
    }
    stack.pop();
    return;
  }

  if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const scope = new Set();
    stack.push(scope);
    const init = node.initializer;
    if (init && ts.isVariableDeclarationList(init)) {
      for (const d of init.declarations) {
        collectBindingNames(d.name, scope);
        if (d.initializer) visit(d.initializer, stack, problems, sf);
      }
    } else if (init) {
      visit(init, stack, problems, sf);
    }
    if (ts.isForStatement(node)) {
      if (node.condition) visit(node.condition, stack, problems, sf);
      if (node.incrementor) visit(node.incrementor, stack, problems, sf);
    } else {
      visit(node.expression, stack, problems, sf);
    }
    if (node.statement) visit(node.statement, stack, problems, sf);
    stack.pop();
    return;
  }

  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    if (node.name) addBinding(stack[stack.length - 1], node.name.text);
    const scope = new Set();
    stack.push(scope);
    for (const member of node.members) visit(member, stack, problems, sf);
    stack.pop();
    return;
  }

  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    reportUnbound(node.expression, sf, stack, problems);
  }

  if (ts.isTaggedTemplateExpression(node)) {
    reportUnbound(node.tag, sf, stack, problems);
  }

  // VariableStatement: visit initializers; names already hoisted in block
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (decl.initializer) visit(decl.initializer, stack, problems, sf);
    }
    return;
  }

  // FunctionDeclaration statements: already hoisted; still visit body via function branch
  // (handled at top when we recurse into the declaration node)

  ts.forEachChild(node, (c) => visit(c, stack, problems, sf));
}

function checkFile(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const text = stripNocheck(raw);
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const moduleScope = new Set();
  collectImportBindings(sf, moduleScope);
  collectModuleLevelBindings(sf, moduleScope);
  const problems = [];
  const stack = [moduleScope];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) continue;
    visit(stmt, stack, problems, sf);
  }
  return problems;
}

const files = [];
for (const dir of scanRoots) {
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory()) walkDir(dir, files);
}

let failed = false;
let checked = 0;
let problemCount = 0;

for (const file of files) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  checked++;
  const problems = checkFile(file);
  if (problems.length) {
    failed = true;
    const rel = relative(root, file).split('\\').join('/');
    for (const p of problems) {
      problemCount++;
      console.error(`[check:route-undef] ${rel}:${p.line}:${p.character} unbound call/new '${p.name}'`);
    }
  }
}

if (failed) {
  console.error(
    `[check:route-undef] FAILED — ${problemCount} unbound identifier(s) in ${checked} route file(s).`
  );
  console.error(
    'This usually means a removed/missing import still used by a sibling handler. Restore the import or fix the call.'
  );
  process.exit(1);
}

console.log(
  `[check:route-undef] OK — ${checked} route file(s) scanned, no unbound call/new identifiers.`
);
process.exit(0);
