/** 轻量语法高亮：每种语言是一组按优先级排列的正则规则，合并成一个正则一次扫描完成。
 * 不依赖第三方库；规则内不能出现捕获分组（用 (?:) 代替），也不使用后行断言以兼容旧版 Safari。 */

export type TokenType = "comment" | "string" | "number" | "keyword" | "literal" | "type" | "function" | "attr" | "tag" | "meta" | "variable" | "inserted" | "deleted";
export type Token = { type: TokenType | null; text: string };
type Rule = [TokenType | null, string];
type Grammar = { rules: Rule[]; flags: string };

const words = (list: string) => `\\b(?:${list.trim().split(/\s+/).join("|")})\\b`;
const DQ = `"(?:\\\\[\\s\\S]|[^"\\\\\\n])*"`;
const SQ = `'(?:\\\\[\\s\\S]|[^'\\\\\\n])*'`;
const BT = "`(?:\\\\[\\s\\S]|[^`\\\\])*`";
const NUM = `\\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)[a-zA-Z]{0,3}\\b`;
const SLASH_COMMENTS: Rule[] = [["comment", "\\/\\/.*"], ["comment", "\\/\\*[\\s\\S]*?(?:\\*\\/|(?![\\s\\S]))"]];
const HASH_COMMENT: Rule = ["comment", "#.*"];
const FUNCTION: Rule = ["function", "\\b[A-Za-z_$][\\w$]*(?=\\s*\\()"];
const TYPE: Rule = ["type", "\\b[A-Z][A-Za-z0-9_]*\\b"];

function clike(keywords: string, literals: string, extra: { before?: Rule[]; strings?: Rule[]; after?: Rule[] } = {}): Rule[] {
  return [
    ...SLASH_COMMENTS,
    ...(extra.before ?? []),
    ...(extra.strings ?? [["string", DQ], ["string", SQ]]),
    ["keyword", words(keywords)],
    ["literal", words(literals)],
    ["number", NUM],
    ...(extra.after ?? []),
    FUNCTION,
    TYPE,
  ];
}

const JS_KEYWORDS = "async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return set static super switch this throw try typeof var void while with yield as type declare namespace abstract keyof satisfies infer is module require";
const JS_LITERALS = "true false null undefined NaN Infinity";

const PY_KEYWORDS = "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case";

const RULES: Record<string, Rule[]> = {
  js: clike(JS_KEYWORDS, JS_LITERALS, { strings: [["string", DQ], ["string", SQ], ["string", BT]] }),
  python: [
    HASH_COMMENT,
    ["string", `[rRbBfFuU]{0,2}(?:"""[\\s\\S]*?(?:"""|(?![\\s\\S]))|'''[\\s\\S]*?(?:'''|(?![\\s\\S])))`],
    ["string", `[rRbBfFuU]{0,2}(?:${DQ}|${SQ})`],
    ["meta", "@[A-Za-z_][\\w.]*"],
    ["keyword", words(PY_KEYWORDS)],
    ["literal", words("True False None self cls")],
    ["number", NUM],
    FUNCTION,
    TYPE,
  ],
  go: clike("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var", "true false nil iota", { strings: [["string", DQ], ["string", BT], ["string", `'(?:\\\\.|[^'\\\\\\n])+'`]] }),
  rust: clike("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while", "true false None Some Ok Err", {
    strings: [["string", DQ], ["string", `b?'(?:\\\\.|[^'\\\\\\n])'`]], before: [["meta", "#!?\\[[^\\]\\n]*\\]"]], after: [["function", "\\b[a-z_]\\w*!(?=\\s*[({\\[])"]],
  }),
  java: clike("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try var void volatile while record sealed permits yield", "true false null", { before: [["meta", "@[A-Za-z_]\\w*"]] }),
  csharp: clike("abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while record init get set where", "true false null", { before: [["meta", "^[ \\t]*#.*"]] }),
  kotlin: clike("abstract actual annotation as break by catch class companion const constructor continue crossinline data do dynamic else enum expect external final finally for fun get if import in infix init inline inner interface internal is lateinit noinline object open operator out override package private protected public reified return sealed set super suspend tailrec this throw try typealias val var vararg when where while", "true false null", { before: [["meta", "@[A-Za-z_]\\w*"]] }),
  swift: clike("actor as associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in indirect init inout internal is lazy let mutating nonmutating open operator override precedencegroup private protocol public repeat required rethrows return self Self static struct subscript super switch throw throws try typealias var weak where while", "true false nil", { before: [["meta", "@[A-Za-z_]\\w*"], ["meta", "^[ \\t]*#.*"]] }),
  c: clike("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override new delete this using try catch throw constexpr noexcept nullptr operator final explicit bool", "true false NULL nullptr", { before: [["meta", "^[ \\t]*#[ \\t]*\\w+(?:[ \\t]*<[^>\\n]*>)?"]] }),
  php: clike("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield", "true false null TRUE FALSE NULL", {
    before: [HASH_COMMENT, ["meta", "<\\?(?:php|=)?|\\?>"], ["variable", "\\$[A-Za-z_]\\w*"]],
  }),
  ruby: [
    HASH_COMMENT,
    ["comment", "^=begin[\\s\\S]*?^=end"],
    ["string", DQ], ["string", SQ],
    ["variable", "@{1,2}[A-Za-z_]\\w*|\\$[A-Za-z_]\\w*"],
    ["literal", ":[A-Za-z_]\\w*[?!]?"],
    ["keyword", words("alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative include extend attr_accessor attr_reader attr_writer private protected public lambda proc puts")],
    ["literal", words("true false nil")],
    ["number", NUM],
    FUNCTION,
    TYPE,
  ],
  shell: [
    HASH_COMMENT,
    ["string", DQ], ["string", SQ],
    ["variable", "\\$(?:\\w+|\\{[^}\\n]*\\}|\\([^)\\n]*\\)|[@#?*!$-])"],
    ["keyword", words("if then else elif fi for while until do done case esac in function select return exit break continue export local readonly declare unset shift source alias set trap eval exec")],
    ["function", "\\b(?:echo|cd|ls|cat|grep|sed|awk|find|mkdir|rm|cp|mv|chmod|chown|curl|wget|git|docker|npm|node|python3?|pip|make|tar|ssh|sudo|apt|apt-get|brew|systemctl|kill|test|printf|read)\\b"],
    ["attr", "(?:^|\\s)--?[A-Za-z][\\w-]*"],
    ["number", NUM],
  ],
  sql: [
    ["comment", "--.*"], ["comment", "\\/\\*[\\s\\S]*?(?:\\*\\/|(?![\\s\\S]))"],
    ["string", SQ], ["string", DQ], ["string", "`[^`\\n]*`"],
    ["keyword", words("select from where and or not in is null like between exists distinct as join inner outer left right full cross on group by order having limit offset union all insert into values update set delete create alter drop table index view database schema primary key foreign references unique default check constraint add column if begin commit rollback transaction case when then else end with returning asc desc cascade truncate grant revoke trigger procedure function replace pragma explain analyze vacuum")],
    ["type", words("int integer bigint smallint tinyint serial boolean bool text varchar char float double decimal numeric real date time timestamp datetime blob json jsonb uuid")],
    ["literal", words("true false")],
    ["number", NUM],
    FUNCTION,
  ],
  json: [
    ["attr", `${DQ}(?=\\s*:)`],
    ["string", DQ],
    ["literal", words("true false null")],
    ["number", "-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b"],
    ["comment", "\\/\\/.*"], ["comment", "\\/\\*[\\s\\S]*?(?:\\*\\/|(?![\\s\\S]))"],
  ],
  yaml: [
    HASH_COMMENT,
    ["meta", "^---|^\\.\\.\\."],
    ["string", DQ], ["string", SQ],
    ["meta", "[&*][\\w-]+"],
    ["attr", `[\\w./"'-]+(?=[ \\t]*:(?:[ \\t]|$))`],
    ["literal", words("true false null yes no on off ~")],
    ["number", NUM],
  ],
  toml: [
    ["comment", "[#;].*"],
    ["tag", "^[ \\t]*\\[\\[?[^\\]\\n]+\\]\\]?"],
    ["attr", `^[ \\t]*[\\w."-]+(?=[ \\t]*=)`],
    ["string", `"""[\\s\\S]*?(?:"""|(?![\\s\\S]))`], ["string", DQ], ["string", SQ],
    ["literal", words("true false")],
    ["number", NUM],
  ],
  xml: [
    ["comment", "<!--[\\s\\S]*?(?:-->|(?![\\s\\S]))"],
    ["meta", "<![A-Za-z][^>]*>|<\\?[\\s\\S]*?\\?>"],
    ["tag", "<\\/?[A-Za-z][\\w:.-]*|\\/?>"],
    ["string", `=\\s*(?:"[^"]*"|'[^']*')`],
    ["attr", "[A-Za-z_:@][\\w:.@-]*(?=\\s*=)"],
    ["meta", "&#?\\w+;"],
  ],
  css: [
    ["comment", "\\/\\*[\\s\\S]*?(?:\\*\\/|(?![\\s\\S]))"], ["comment", "\\/\\/.*"],
    ["string", DQ], ["string", SQ],
    ["keyword", "@[\\w-]+"],
    ["number", "#[0-9a-fA-F]{3,8}\\b"],
    ["number", "-?\\b\\d[\\d.]*(?:[a-zA-Z%]+)?"],
    ["variable", "\\$[\\w-]+|--[\\w-]+"],
    ["attr", "[\\w-]+(?=\\s*:[^{};\\n]*(?:;|\\}|\\n|$))"],
    ["type", "[.#][A-Za-z_][\\w-]*"],
    ["function", "[\\w-]+(?=\\()"],
  ],
  diff: [
    ["meta", "^(?:diff |index |--- |\\+\\+\\+ |@@).*"],
    ["inserted", "^\\+.*"],
    ["deleted", "^-.*"],
  ],
  docker: [
    HASH_COMMENT,
    ["string", DQ], ["string", SQ],
    ["keyword", "^[ \\t]*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\\b"],
    ["keyword", words("AS")],
    ["variable", "\\$(?:\\w+|\\{[^}\\n]*\\})"],
    ["number", NUM],
  ],
  make: [
    HASH_COMMENT,
    ["string", DQ], ["string", SQ],
    ["variable", "\\$[({][^)}\\n]*[)}]|\\$[@<^?*%]"],
    ["function", "^[\\w./%-]+(?=[ \\t]*:(?!=))"],
    ["keyword", "^[ \\t]*(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|export|define|endef|override)\\b"],
  ],
  markdown: [
    ["meta", "^ {0,3}(?:`{3,}|~{3,}).*"],
    ["keyword", "^ {0,3}#{1,6}(?:[ \\t].*)?"],
    ["comment", "^ {0,3}>.*"],
    ["string", "`[^`\\n]+`"],
    ["attr", "\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__"],
    ["function", "!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)"],
    ["meta", "^[ \\t]*(?:[-*+]|\\d+[.)])(?=[ \\t])"],
    ["number", "https?:\\/\\/[^\\s<>)]+"],
  ],
  ini: [
    ["comment", "[#;].*"],
    ["tag", "^[ \\t]*\\[[^\\]\\n]+\\]"],
    ["attr", "^[ \\t]*[\\w.-]+(?=[ \\t]*[=:])"],
    ["string", DQ], ["string", SQ],
    ["literal", words("true false yes no on off")],
    ["number", NUM],
  ],
};

const ALIASES: Record<string, string> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", javascript: "js", typescript: "js", vue: "xml", svelte: "xml",
  py: "python", python: "python", pyi: "python",
  go: "go", rs: "rust", rust: "rust",
  java: "java", scala: "java", groovy: "java", gradle: "java", dart: "java",
  cs: "csharp", csharp: "csharp", kt: "kotlin", kts: "kotlin", kotlin: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", hh: "c", m: "c", mm: "c", "c++": "c", objc: "c",
  php: "php", rb: "ruby", ruby: "ruby", rake: "ruby",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", fish: "shell", ps1: "shell", bat: "shell", cmd: "shell", console: "shell",
  sql: "sql", json: "json", jsonc: "json", json5: "json", geojson: "json",
  yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", conf: "ini", cfg: "ini", properties: "ini", env: "ini", editorconfig: "ini",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", xhtml: "xml", plist: "xml", xsl: "xml",
  css: "css", scss: "css", sass: "css", less: "css",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  diff: "diff", patch: "diff", dockerfile: "docker", docker: "docker", makefile: "make", make: "make", mk: "make",
};

/** 由代码围栏的语言标记或文件名推断语法；无法识别时返回 null（按纯文本显示）。 */
export function languageOf(nameOrTag: string): string | null {
  const lower = nameOrTag.trim().toLowerCase();
  if (!lower) return null;
  const base = lower.split("/").at(-1)!;
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "docker";
  if (base === "makefile" || base === "gnumakefile") return "make";
  if (base.startsWith(".env")) return "ini";
  const ext = base.includes(".") ? base.split(".").at(-1)! : base;
  const key = ALIASES[ext];
  return key ?? null;
}

const compiled = new Map<string, { regex: RegExp; types: (TokenType | null)[] }>();

function grammar(lang: string) {
  let entry = compiled.get(lang);
  if (!entry) {
    const rules = RULES[lang]!;
    const flags = "gm" + (lang === "sql" ? "i" : "");
    entry = { regex: new RegExp(rules.map(([, source]) => `(${source})`).join("|"), flags), types: rules.map(([type]) => type) };
    compiled.set(lang, entry);
  }
  return entry;
}

/** 把源码切成带类型的片段；拼接所有片段的 text 即得原文。 */
export function highlight(code: string, lang: string | null): Token[] {
  if (!lang || !RULES[lang]) return [{ type: null, text: code }];
  const { regex, types } = grammar(lang);
  const tokens: Token[] = [];
  regex.lastIndex = 0;
  let last = 0;
  for (let match = regex.exec(code); match; match = regex.exec(code)) {
    if (match[0] === "") { regex.lastIndex++; continue; }
    let group = 1;
    while (match[group] === undefined) group++;
    if (match.index > last) tokens.push({ type: null, text: code.slice(last, match.index) });
    tokens.push({ type: types[group - 1], text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < code.length) tokens.push({ type: null, text: code.slice(last) });
  return tokens;
}

/** 把片段按换行拆成行，跨行的注释和字符串会被拆开并保持各自的类型。 */
export function splitLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ type: token.type, text: part });
    });
  }
  return lines;
}
