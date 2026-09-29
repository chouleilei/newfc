/**
 * 安全行内公式解析引擎 (Safe Inline Formula Evaluator)
 * 采用词法分析 + 调度场算法 (Shunting-yard algorithm) / 逆波兰表达式 (RPN) 求值
 * 严禁使用 eval / Function，保障安全与确定性。
 */

export interface FormulaEvalResult {
  ok: boolean;
  value: number | null;
  display?: string;
  error?: string;
}

export function isFormula(text?: string | null): boolean {
  if (!text) return false;
  return text.trim().startsWith('=');
}

type TokenType = 'NUMBER' | 'OP' | 'LPAREN' | 'RPAREN';

interface Token {
  type: TokenType;
  value: string | number;
}

const PRECEDENCE: Record<string, number> = {
  '+': 1,
  '-': 1,
  '*': 2,
  '/': 2,
  'u-': 3, // unary minus
  'u+': 3, // unary plus
};

/**
 * 词法分析：将字符串切分为 Token 序列，支持百分比（13% -> 0.13）、千分位逗号去除、正负号识别
 */
function tokenize(expr: string): Token[] {
  const clean = expr.replace(/,/g, '').trim();
  const tokens: Token[] = [];
  let i = 0;
  let expectUnary = true; // 在表达式开头、左括号后或运算符后，遇到的 +/- 属于一元正负号

  while (i < clean.length) {
    const ch = clean[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: '(' });
      expectUnary = true;
      i++;
      continue;
    }

    if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ')' });
      expectUnary = false;
      i++;
      continue;
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      if (expectUnary && (ch === '+' || ch === '-')) {
        tokens.push({ type: 'OP', value: ch === '-' ? 'u-' : 'u+' });
      } else {
        tokens.push({ type: 'OP', value: ch });
      }
      expectUnary = true;
      i++;
      continue;
    }

    // 数字与小数、百分比识别
    if (/[0-9.]/.test(ch)) {
      let numStr = '';
      let hasDot = false;
      while (i < clean.length && /[0-9.]/.test(clean[i])) {
        if (clean[i] === '.') {
          if (hasDot) throw new Error('数字包含多个小数点');
          hasDot = true;
        }
        numStr += clean[i];
        i++;
      }

      let numVal = parseFloat(numStr);
      if (isNaN(numVal)) throw new Error(`无效数字: ${numStr}`);

      // 检查后续是否有百分号 %
      if (i < clean.length && clean[i] === '%') {
        numVal = numVal / 100;
        i++;
      }

      tokens.push({ type: 'NUMBER', value: numVal });
      expectUnary = false;
      continue;
    }

    throw new Error(`无法识别的字符: 「${ch}」`);
  }

  return tokens;
}

/**
 * 语法解析与求值（Shunting-yard 转换为 RPN 并即时计算）
 */
function evaluateTokens(tokens: Token[]): number {
  const outputQueue: (number | string)[] = [];
  const opStack: string[] = [];

  for (const t of tokens) {
    if (t.type === 'NUMBER') {
      outputQueue.push(t.value as number);
    } else if (t.type === 'OP') {
      const op = t.value as string;
      const p1 = PRECEDENCE[op] || 0;
      const isRightAssoc = op === 'u-' || op === 'u+';

      while (opStack.length > 0) {
        const top = opStack[opStack.length - 1];
        if (top === '(') break;
        const p2 = PRECEDENCE[top] || 0;
        if ((!isRightAssoc && p1 <= p2) || (isRightAssoc && p1 < p2)) {
          outputQueue.push(opStack.pop()!);
        } else {
          break;
        }
      }
      opStack.push(op);
    } else if (t.type === 'LPAREN') {
      opStack.push('(');
    } else if (t.type === 'RPAREN') {
      let foundLparen = false;
      while (opStack.length > 0) {
        const top = opStack.pop()!;
        if (top === '(') {
          foundLparen = true;
          break;
        }
        outputQueue.push(top);
      }
      if (!foundLparen) throw new Error('括号不匹配: 缺少左括号');
    }
  }

  while (opStack.length > 0) {
    const top = opStack.pop()!;
    if (top === '(' || top === ')') throw new Error('括号不匹配: 缺少右括号');
    outputQueue.push(top);
  }

  // RPN 求值
  const valStack: number[] = [];
  for (const item of outputQueue) {
    if (typeof item === 'number') {
      valStack.push(item);
    } else {
      if (item === 'u-') {
        if (valStack.length < 1) throw new Error('负号运算符缺少操作数');
        valStack.push(-valStack.pop()!);
      } else if (item === 'u+') {
        if (valStack.length < 1) throw new Error('正号运算符缺少操作数');
        // no-op
      } else {
        if (valStack.length < 2) throw new Error(`运算符 ${item} 缺少操作数`);
        const b = valStack.pop()!;
        const a = valStack.pop()!;
        let res = 0;
        switch (item) {
          case '+':
            res = a + b;
            break;
          case '-':
            res = a - b;
            break;
          case '*':
            res = a * b;
            break;
          case '/':
            if (Math.abs(b) < 1e-12) throw new Error('除数不能为 0');
            res = a / b;
            break;
          default:
            throw new Error(`未知运算符: ${item}`);
        }
        valStack.push(res);
      }
    }
  }

  if (valStack.length !== 1) {
    throw new Error('公式格式不完整');
  }

  const finalVal = valStack[0];
  if (!isFinite(finalVal) || isNaN(finalVal)) {
    throw new Error('计算结果非有效数值');
  }

  return finalVal;
}

/**
 * 外部主求值入口
 * @param input 支持 "=120*1.08+15" 或 "120*1.08+15"
 * @param decimals 小数位数，默认为 2
 */
export function evaluateFormula(input: string, decimals: number = 2): FormulaEvalResult {
  if (!input || !input.trim()) {
    return { ok: true, value: null, display: '' };
  }

  let expr = input.trim();
  if (expr.startsWith('=')) {
    expr = expr.substring(1).trim();
  }

  if (!expr) {
    return { ok: true, value: null, display: '' };
  }

  try {
    const tokens = tokenize(expr);
    if (tokens.length === 0) {
      return { ok: true, value: null, display: '' };
    }
    const val = evaluateTokens(tokens);
    const rounded = Number(val.toFixed(decimals));
    return {
      ok: true,
      value: rounded,
      display: rounded.toFixed(decimals),
    };
  } catch (err) {
    return {
      ok: false,
      value: null,
      error: err instanceof Error ? err.message : '公式错误',
    };
  }
}
