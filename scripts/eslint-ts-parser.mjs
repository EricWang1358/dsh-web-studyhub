/**
 * Zero-dependency TypeScript / TSX parser for ESLint 10 using the repo's
 * installed `typescript` compiler AST + `espree`.
 *
 * Erases TypeScript-only syntax in-place by replacing type ranges with ASCII
 * spaces while preserving `\r` and `\n`, keeping every byte offset, line, and
 * column 1:1 identical to the original source file so ESLint diagnostics,
 * `SourceCode.getText()`, and React Hooks rules point to exact locations.
 */
import * as espree from "espree";
import ts from "typescript";

const ERASE_MODIFIERS = new Set([
  ts.SyntaxKind.DeclareKeyword,
  ts.SyntaxKind.ReadonlyKeyword,
  ts.SyntaxKind.PublicKeyword,
  ts.SyntaxKind.PrivateKeyword,
  ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.OverrideKeyword,
  ts.SyntaxKind.AbstractKeyword,
]);

function eraseTypeScriptSyntax(code, fileName) {
  const isTsx = /\.tsx$/i.test(fileName) || /\.jsx$/i.test(fileName);
  const sf = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const chars = code.split("");

  const maskRange = (start, end) => {
    const s = Math.max(0, start);
    const e = Math.min(chars.length, end);
    for (let i = s; i < e; i += 1) {
      const ch = chars[i];
      if (ch !== "\n" && ch !== "\r") chars[i] = " ";
    }
  };

  const maskPrevChar = (beforePos, targetChar) => {
    for (let i = beforePos - 1; i >= 0; i -= 1) {
      const ch = code[i];
      if (ch === targetChar) {
        maskRange(i, i + 1);
        return i;
      }
      if (!/\s/.test(ch)) break;
    }
    return -1;
  };

  const maskNextChar = (afterPos, targetChar) => {
    for (let i = afterPos; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === targetChar) {
        maskRange(i, i + 1);
        return i;
      }
      if (!/\s/.test(ch)) break;
    }
    return -1;
  };

  const maskAngleBracketList = (list) => {
    if (!list || list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    let lt = first.getStart(sf) - 1;
    while (lt >= 0 && code[lt] !== "<") lt -= 1;
    let gt = last.getEnd();
    while (gt < code.length && code[gt] !== ">") gt += 1;
    if (lt >= 0 && gt < code.length) {
      maskRange(lt, gt + 1);
    }
  };

  const maskNamedSpecifiers = (elements) => {
    const typeOnlyIndices = [];
    for (let i = 0; i < elements.length; i += 1) {
      if (elements[i].isTypeOnly) typeOnlyIndices.push(i);
    }
    for (const idx of typeOnlyIndices) {
      const el = elements[idx];
      const start = el.getStart(sf);
      const end = el.getEnd();
      maskRange(start, end);
      // Remove a trailing comma if present, otherwise a leading comma.
      const trailing = maskNextChar(end, ",");
      if (trailing < 0) {
        maskPrevChar(start, ",");
      }
    }
  };

  const maskTypeAnnotation = (typeNode) => {
    if (!typeNode) return;
    const typeStart = typeNode.getStart(sf);
    const typeEnd = typeNode.getEnd();
    let colon = typeStart - 1;
    while (colon >= 0 && /\s/.test(code[colon])) colon -= 1;
    if (colon >= 0 && code[colon] === ":") {
      maskRange(colon, typeEnd);
    } else {
      maskRange(typeStart, typeEnd);
    }
  };

  const visit = (node) => {
    if (!node) return;

    // Whole TS-only declarations
    if (
      ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node)
      || ts.isModuleDeclaration(node)
    ) {
      maskRange(node.getStart(sf), node.getEnd());
      return;
    }

    // Ambient `declare ...` statements
    if (
      ts.canHaveModifiers(node)
      && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)
    ) {
      maskRange(node.getStart(sf), node.getEnd());
      return;
    }

    // Import declarations (`import type ...` or `import { type A, b } ...`)
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.isTypeOnly) {
        maskRange(node.getStart(sf), node.getEnd());
        return;
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const els = clause.namedBindings.elements;
        if (!clause.name && els.length > 0 && els.every((e) => e.isTypeOnly)) {
          maskRange(node.getStart(sf), node.getEnd());
          return;
        }
        maskNamedSpecifiers(els);
        // If named imports became empty while a default import still exists:
        if (clause.name && els.length > 0 && els.every((e) => e.isTypeOnly)) {
          const nbStart = clause.namedBindings.getStart(sf);
          const nbEnd = clause.namedBindings.getEnd();
          maskPrevChar(nbStart, ",");
          maskRange(nbStart, nbEnd);
        }
      }
      return;
    }

    // Export declarations (`export type ...` or `export { type A, b }`)
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) {
        maskRange(node.getStart(sf), node.getEnd());
        return;
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        const els = node.exportClause.elements;
        if (els.length > 0 && els.every((e) => e.isTypeOnly)) {
          maskRange(node.getStart(sf), node.getEnd());
          return;
        }
        maskNamedSpecifiers(els);
      }
      return;
    }

    // Class `implements ...` clauses
    if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) {
      maskRange(node.getStart(sf), node.getEnd());
      return;
    }

    // Function / method overload signatures without body
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node))
      && !node.body
    ) {
      maskRange(node.getStart(sf), node.getEnd());
      return;
    }

    // Modifiers (`readonly`, `private`, `override`, etc.)
    if (ts.canHaveModifiers(node)) {
      for (const mod of ts.getModifiers(node) ?? []) {
        if (ERASE_MODIFIERS.has(mod.kind)) {
          maskRange(mod.getStart(sf), mod.getEnd());
        }
      }
    }

    // `as Type` / `satisfies Type`
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      maskRange(node.expression.getEnd(), node.getEnd());
      visit(node.expression);
      return;
    }

    // Non-null assertion `expr!`
    if (ts.isNonNullExpression(node)) {
      maskRange(node.expression.getEnd(), node.getEnd());
      visit(node.expression);
      return;
    }

    // Angle-bracket type assertion `<Type>expr` (only in .ts, not .tsx)
    if (ts.isTypeAssertionExpression(node)) {
      maskRange(node.getStart(sf), node.expression.getStart(sf));
      visit(node.expression);
      return;
    }

    // Generic type parameters & call/JSX type arguments
    if ("typeParameters" in node && node.typeParameters?.length) {
      maskAngleBracketList(node.typeParameters);
    }
    if ("typeArguments" in node && node.typeArguments?.length) {
      maskAngleBracketList(node.typeArguments);
    }

    // Optional `?` and definite assignment `!` tokens on params/properties/vars
    if (
      (ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node))
      && node.questionToken
    ) {
      maskRange(node.questionToken.getStart(sf), node.questionToken.getEnd());
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node))
      && node.exclamationToken
    ) {
      maskRange(node.exclamationToken.getStart(sf), node.exclamationToken.getEnd());
    }

    // TypeScript `this` parameter in function/method signatures
    if (ts.isParameter(node) && node.name.kind === ts.SyntaxKind.ThisKeyword) {
      maskRange(node.getStart(sf), node.getEnd());
      maskNextChar(node.getEnd(), ",");
      return;
    }

    // Type annotations `: Type` on declarations and function return types
    if (
      (ts.isVariableDeclaration(node)
        || ts.isParameter(node)
        || ts.isPropertyDeclaration(node)
        || ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node))
      && node.type
    ) {
      maskTypeAnnotation(node.type);
    }

    ts.forEachChild(node, (child) => {
      // Do not descend into erased type nodes
      if ("type" in node && child === node.type) return;
      if ("typeParameters" in node && node.typeParameters?.includes?.(child)) return;
      if ("typeArguments" in node && node.typeArguments?.includes?.(child)) return;
      visit(child);
    });
  };

  visit(sf);
  return chars.join("");
}

export function parseForESLint(code, options = {}) {
  const fileName = options.filePath || "input.tsx";
  const masked = eraseTypeScriptSyntax(code, fileName);
  const ast = espree.parse(masked, {
    ecmaVersion: "latest",
    sourceType: "module",
    range: true,
    loc: true,
    tokens: true,
    comment: true,
    ecmaFeatures: { jsx: true },
  });
  return { ast };
}

export default {
  meta: { name: "studyhub-ts-espree-parser", version: "2.0.0" },
  parseForESLint,
};
