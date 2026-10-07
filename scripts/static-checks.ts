/**
 * Project-specific static checks (Phase 15). Runs with the TypeScript compiler API only, so it works
 * offline and in CI next to ESLint; it does not replace ESLint, it adds rules ESLint does not know:
 *
 *   sql/dynamic          every `${…}` inside SQL passed to `.prepare()` is either a constant or a
 *                        reviewed fragment listed in scripts/sql-fragments.json (a ratchet: new dynamic
 *                        SQL fails until someone reviews it and runs with --update-sql-baseline)
 *   sql/request-input    never allowed in SQL text, even when listed: body / request / params / query …
 *   dom/raw-html         innerHTML, outerHTML, insertAdjacentHTML, document.write, dangerouslySetInnerHTML
 *   js/eval              eval(), new Function(), string arguments to setTimeout / setInterval
 *   log/client-console   console.log / console.debug in the browser bundle
 *   log/structured       worker console.* calls must log JSON.stringify({...}) (no free-form strings)
 *   secret/literal       things that look like real credentials in source or wrangler.jsonc vars
 *   jsx/blank-target     target="_blank" without rel="noopener" / "noreferrer"
 *   jsx/img-alt          <img> without alt
 *   jsx/button-type      <button> without an explicit type
 *   react/hooks-order    hooks called after an early return, or inside a condition / loop (rules of hooks)
 *   ts/strict-extra      worker + shared compile with noUnusedLocals / noUnusedParameters / noImplicitReturns
 *
 * Usage: npx tsx scripts/static-checks.ts [--update-sql-baseline]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..");
const BASELINE = join(ROOT, "scripts", "sql-fragments.json");
const update = process.argv.includes("--update-sql-baseline");

interface Finding { rule: string; file: string; line: number; text: string }
const findings: Finding[] = [];

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

const report = (rule: string, sf: ts.SourceFile, node: ts.Node, text: string) => {
  findings.push({ rule, file: relative(ROOT, sf.fileName), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
};

/** Constant-looking expressions: UPPER_CASE names, Class.UPPER_CASE, UPPER_CASE("literal", …), numbers, literals. */
function isConstant(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return /^[A-Z][A-Z0-9_]*$/.test(e.text);
  if (ts.isPropertyAccessExpression(e)) return /^[A-Z][A-Z0-9_]*$/.test(e.name.text) && (ts.isIdentifier(e.expression) || isConstant(e.expression as ts.Expression));
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && /^[A-Z][A-Z0-9_]*$/.test(e.expression.text)) return e.arguments.every((a) => ts.isStringLiteral(a));
  if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isConditionalExpression(e)) return isConstant(e.whenTrue) && isConstant(e.whenFalse);
  if (ts.isParenthesizedExpression(e)) return isConstant(e.expression);
  return false;
}

const REQUEST_INPUT = /\b(body|request|req|ctx|params|searchParams|query|headers|cookies?|formData|payload|rawBody)\b/;

const sqlSeen: Record<string, string[]> = {};
const baseline: Record<string, string[]> = (() => {
  try { return JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, string[]>; } catch { return {}; }
})();

function checkFile(path: string) {
  const isClient = path.includes(`${join("src", "client")}`);
  const isWorker = path.includes(`${join("src", "worker")}`);
  const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rel = relative(ROOT, path);

  // ---------------------------------------------------------------- rules of hooks (components and hooks)
  const isFn = (x: ts.Node): x is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x) || ts.isArrowFunction(x) || ts.isMethodDeclaration(x);
  const fnName = (f: ts.FunctionLikeDeclaration): string => {
    if (ts.isFunctionDeclaration(f) && f.name) return f.name.text;
    if (ts.isVariableDeclaration(f.parent) && ts.isIdentifier(f.parent.name)) return f.parent.name.text;
    return "";
  };
  const isHookCall = (x: ts.Node) => ts.isCallExpression(x) && ts.isIdentifier(x.expression) && /^use[A-Z]/.test(x.expression.text);
  /** Hook calls in `node`, not looking into nested functions; `conditional` = inside if / loop / ?: / && / ||. */
  const hookCalls = (node: ts.Node, conditional: boolean, out: { node: ts.Node; conditional: boolean }[]) => {
    if (isFn(node)) return;
    if (isHookCall(node)) out.push({ node, conditional });
    const cond = conditional || ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isForStatement(node) || ts.isForOfStatement(node)
      || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSwitchStatement(node)
      || (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind));
    ts.forEachChild(node, (c) => hookCalls(c, cond, out));
  };
  const hasReturn = (node: ts.Node): boolean => !isFn(node) && (ts.isReturnStatement(node) || (ts.forEachChild(node, hasReturn) ?? false));
  const checkHooks = (f: ts.FunctionLikeDeclaration) => {
    if (!/^(use[A-Z]|[A-Z])/.test(fnName(f)) || !f.body || !ts.isBlock(f.body)) return;
    let returned = false;
    for (const st of f.body.statements) {
      const calls: { node: ts.Node; conditional: boolean }[] = [];
      hookCalls(st, false, calls);
      for (const c of calls) {
        if (returned) report("react/hooks-order", sf, c.node, `${c.node.getText(sf).slice(0, 40)} after an early return in ${fnName(f)}`);
        else if (c.conditional) report("react/hooks-order", sf, c.node, `${c.node.getText(sf).slice(0, 40)} called conditionally in ${fnName(f)}`);
      }
      if (hasReturn(st)) returned = true;
    }
  };

  const visit = (n: ts.Node): void => {
    if (path.endsWith(".tsx") || isClient) if (isFn(n)) checkHooks(n);
    // ---------------------------------------------------------------- SQL
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "prepare" && n.arguments.length === 1
      && /(^|\.)(db|DB|raw)$/.test(n.expression.expression.getText(sf))) {
      const arg = n.arguments[0]!;
      const spans = ts.isTemplateExpression(arg) ? arg.templateSpans.map((s) => s.expression) : ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? [] : [arg];
      for (const e of spans) {
        if (isConstant(e)) continue;
        const text = e.getText(sf).replace(/\s+/g, " ");
        if (REQUEST_INPUT.test(text)) report("sql/request-input", sf, e, text);
        (sqlSeen[rel] ??= []).push(text);
        if (!update && !(baseline[rel] ?? []).includes(text)) report("sql/dynamic", sf, e, `${text} (new dynamic SQL: review it, then run with --update-sql-baseline)`);
      }
    }
    // ---------------------------------------------------------------- DOM / eval
    if (ts.isPropertyAccessExpression(n) && ["innerHTML", "outerHTML", "insertAdjacentHTML"].includes(n.name.text)) report("dom/raw-html", sf, n, n.getText(sf));
    if (ts.isPropertyAccessExpression(n) && n.name.text === "write" && n.expression.getText(sf) === "document") report("dom/raw-html", sf, n, "document.write");
    if (ts.isJsxAttribute(n) && n.name.getText(sf) === "dangerouslySetInnerHTML") report("dom/raw-html", sf, n, "dangerouslySetInnerHTML");
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "eval") report("js/eval", sf, n, "eval()");
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "Function") report("js/eval", sf, n, "new Function()");
    if (ts.isCallExpression(n) && /(^|\.)(setTimeout|setInterval)$/.test(n.expression.getText(sf)) && n.arguments[0] && (ts.isStringLiteral(n.arguments[0]) || ts.isTemplateExpression(n.arguments[0]))) {
      report("js/eval", sf, n, "string passed to a timer");
    }
    // ---------------------------------------------------------------- logging
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText(sf) === "console") {
      const method = n.expression.name.text;
      if (isClient && (method === "log" || method === "debug")) report("log/client-console", sf, n, `console.${method}`);
      if (isWorker) {
        const first = n.arguments[0];
        const structured = first && ts.isCallExpression(first) && first.expression.getText(sf) === "JSON.stringify";
        if (!structured) report("log/structured", sf, n, `console.${method}(${first ? first.getText(sf).slice(0, 40) : ""})`);
      }
    }
    // ---------------------------------------------------------------- secrets
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && looksLikeSecret(n.text)) report("secret/literal", sf, n, `${n.text.slice(0, 12)}…`);
    // ---------------------------------------------------------------- JSX
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf);
      const attrs = new Map<string, string | true>();
      for (const p of n.attributes.properties) {
        if (!ts.isJsxAttribute(p)) { attrs.set("...spread", true); continue; }
        const v = p.initializer;
        attrs.set(p.name.getText(sf), v && ts.isStringLiteral(v) ? v.text : v ? v.getText(sf) : true);
      }
      if (attrs.get("target") === "_blank" && !/noopener|noreferrer/.test(String(attrs.get("rel") ?? ""))) report("jsx/blank-target", sf, n, `<${tag} target="_blank">`);
      if (tag === "img" && !attrs.has("alt") && !attrs.has("...spread")) report("jsx/img-alt", sf, n, "<img> without alt");
      if (tag === "button" && !attrs.has("type") && !attrs.has("...spread")) report("jsx/button-type", sf, n, "<button> without type");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

function looksLikeSecret(s: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}/.test(s)
    || /\bEAA[A-Za-z0-9]{40,}\b/.test(s) // Meta access tokens
    || /\bya29\.[A-Za-z0-9_-]{30,}/.test(s) // Google OAuth tokens
    || /\bAKIA[0-9A-Z]{16}\b/.test(s)
    || /\b(sk|rk)_live_[A-Za-z0-9]{20,}/.test(s)
    || /\bxox[abps]-[A-Za-z0-9-]{20,}/.test(s)
    || /\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(s);
}

// ------------------------------------------------------------------ run
for (const f of [...files(join(ROOT, "src"), /\.(ts|tsx)$/), ...files(join(ROOT, "scripts"), /\.ts$/)]) checkFile(f);

// wrangler.jsonc: no secret-looking variable with a value in "vars".
const wrangler = readFileSync(join(ROOT, "wrangler.jsonc"), "utf8");
for (const m of wrangler.matchAll(/"([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE)[A-Z0-9_]*)"\s*:\s*"([^"]+)"/g)) {
  findings.push({ rule: "secret/wrangler-var", file: "wrangler.jsonc", line: wrangler.slice(0, m.index).split("\n").length, text: `${m[1]} has a value — use wrangler secret put` });
}

// Extra compiler strictness for the backend.
const cfg = ts.getParsedCommandLineOfConfigFile(join(ROOT, "tsconfig.worker.json"), {
  noUnusedLocals: true, noUnusedParameters: true, noImplicitReturns: true, noFallthroughCasesInSwitch: true, noEmit: true,
}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
if (cfg) {
  const program = ts.createProgram(cfg.fileNames, cfg.options);
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
    findings.push({ rule: "ts/strict-extra", file: d.file ? relative(ROOT, d.file.fileName) : "?", line: pos ? pos.line + 1 : 0, text: ts.flattenDiagnosticMessageText(d.messageText, " ") });
  }
}

if (update) {
  const sorted = Object.fromEntries(Object.entries(sqlSeen).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...new Set(v)].sort()]));
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`SQL fragment baseline written (${Object.values(sorted).flat().length} reviewed fragments).`);
}

const total = Object.values(sqlSeen).flat().length;
if (findings.length) {
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.text}`);
  console.log(`\n${findings.length} problem(s).`);
  process.exit(1);
}
console.log(`static checks passed (${total} reviewed dynamic SQL fragments, 0 problems)`);
