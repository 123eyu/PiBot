// Which code a script run loads besides the
// file policy read. A pure verdict and a routine's pinned consent both describe one text; code
// that text pulls in from the workplace (a planted `json.py`, a `require("./lib")`) can change
// afterwards without changing the digest, so such runs are neither pure nor pinned.
import { builtinModules } from "node:module";
import { type PureLanguage, PYTHON_ZIP_END, pythonOtherCoding } from "./script-purity.ts";

/**
 * Python's standard library module names (3.8 to 3.14, `sys.stdlib_module_names` plus modules
 * removed since). Any of them, and any private `_name`, may be imported by an allowlisted module
 * on the way (`datetime` → `_strptime`, `"x".encode("idna")` → `stringprep`), so a file or
 * directory with such a name next to the script shadows code a pure script relies on.
 */
const PYTHON_STDLIB = new Set(
  (
    "abc aifc annotationlib antigravity argparse array ast asynchat asyncio asyncore atexit " +
    "audioop base64 bdb binascii binhex bisect builtins bz2 cProfile calendar cgi cgitb chunk " +
    "cmath cmd code codecs codeop collections colorsys compileall compression concurrent " +
    "configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses " +
    "datetime dbm decimal difflib dis distutils doctest dummy_threading email encodings " +
    "ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch formatter fractions " +
    "ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib " +
    "heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools " +
    "json keyword lib2to3 linecache locale logging lzma macpath mailbox mailcap marshal math " +
    "mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath " +
    "nturl2path numbers opcode operator optparse os ossaudiodev parser pathlib pdb pickle " +
    "pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats " +
    "pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline " +
    "reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil " +
    "signal site sitecustomize smtpd smtplib sndhdr socket socketserver spwd sqlite3 " +
    "sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct " +
    "subprocess sunau symbol symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile " +
    "termios test textwrap this threading time timeit tkinter token tokenize tomllib trace " +
    "traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib " +
    "usercustomize uu uuid venv warnings wave weakref webbrowser winreg winsound wsgiref " +
    "xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo"
  )
    .split(" ")
    .map((name) => name.toLowerCase()),
);
// Never imported by name: a script's own package marker, its bytecode cache and `__main__`
// (already in sys.modules).
const PYTHON_NOT_MODULES = new Set(["__pycache__", "__init__", "__main__"]);
// Standard modules that load or run other Python code by name or path (or native libraries).
const PYTHON_LOADERS = new Set([
  "importlib",
  "imp",
  "builtins",
  "runpy",
  "pkgutil",
  "zipimport",
  "site",
  "code",
  "codeop",
  "compileall",
  "py_compile",
  "modulefinder",
  "pydoc",
  "zipapp",
  "ctypes",
  "unittest",
  "doctest",
  "pdb",
  "bdb",
  "trace",
  "profile",
  "cprofile",
  "timeit",
  "test",
  "idlelib",
]);

/**
 * Whether an entry in the directory Python searches first could be imported in place of a
 * standard module: `json.py`, `json/`, `json.pyc`, `_json.cpython-312-darwin.so`, `json.pyd`.
 * Case is ignored so a case-insensitive file system cannot make `JSON.py` the answer.
 */
export function pythonShadowed(names: readonly string[]): boolean {
  return names.some((entry) => {
    const lower = entry.toLowerCase();
    const module = /\.(?:py|pyc|pyw|pyd|so)$/u.test(lower)
      ? lower.split(".")[0]
      : lower.includes(".")
        ? undefined
        : lower;
    if (!module || PYTHON_NOT_MODULES.has(module)) return false;
    return PYTHON_STDLIB.has(module) || module.startsWith("_");
  });
}

const PYTHON_IMPORT =
  /^[ \t]*(?:from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(?:\([^)]*\)|[^\n#;]+)|import[ \t]+([^\n#;]+))/gmu;
// The builtins that run text as code (not `re.compile` or `df.eval`), loader hooks, `sys.path`,
// and the reflection that reaches any of them by a computed name.
const PYTHON_DYNAMIC =
  /(?<![.\w])(?:exec|eval|compile|execfile|reload)\b|\b(?:__import__|__builtins__|__dict__|getattr|setattr|vars|globals|locals|path_hooks|meta_path|path_importer_cache)\b|\bsys\s*\.\s*path\b|\.pth\b/u;

function pythonLoads(code: string): boolean {
  if (pythonOtherCoding(code) || code.includes(PYTHON_ZIP_END) || PYTHON_DYNAMIC.test(code))
    return true;
  // Every `import` must sit in a statement read here (a line of its own, possibly a
  // parenthesised `from … import (…)`), naming only standard modules that load nothing else.
  const covered: [number, number][] = [];
  for (const match of code.matchAll(PYTHON_IMPORT)) {
    covered.push([match.index, match.index + match[0].length]);
    const names = match[1] !== undefined ? [match[1]] : (match[2] ?? "").split(",");
    for (const raw of names) {
      const top =
        raw
          .trim()
          .split(/\s+as\s+/u)[0]
          ?.split(".")[0] ?? "";
      if (!top || !PYTHON_STDLIB.has(top.toLowerCase()) || PYTHON_LOADERS.has(top.toLowerCase()))
        return true;
    }
  }
  for (const match of code.matchAll(/\bimport\b/gu))
    if (!covered.some(([start, end]) => match.index >= start && match.index < end)) return true;
  return false;
}

const NODE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));
/**
 * Every `require` / `import` must name a Node built-in by a plain string literal; anything else
 * resolves a file or package. Routes that reach a loader without spelling one (the CommonJS
 * wrapper's `arguments`, `module`, `process.mainModule`, constructors, `vm`, workers) count too.
 */
function javascriptLoads(code: string): boolean {
  if (
    /\b(?:module|arguments|mainModule|getBuiltinModule|createRequire|constructor|Function|eval|vm|Worker|fork|dlopen|binding|__proto__)\b|\b(?:process|globalThis|global|self|window)\s*\[/u.test(
      code,
    )
  )
    return true;
  const literal = /^(?:node:)?([\w/.-]+)$/u;
  const specifiers = [
    ...code.matchAll(/\brequire\s*\(\s*(['"])([^'"\n]*)\1\s*\)/gu),
    ...code.matchAll(/\bimport\s*\(\s*(['"])([^'"\n]*)\1\s*\)/gu),
    ...code.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*(['"])([^'"\n]*)\1/gu),
    ...code.matchAll(/\bimport\s*(['"])([^'"\n]*)\1/gu),
  ];
  const covered = specifiers.map((match) => [match.index, match.index + match[0].length]);
  for (const match of specifiers) {
    const name = literal.exec(match[2] ?? "")?.[1];
    if (!name || !NODE_BUILTINS.has(name)) return true;
  }
  for (const match of code.matchAll(/\b(?:require|import)\b/gu))
    if (!covered.some(([start = 0, end = 0]) => match.index >= start && match.index < end))
      return true;
  return false;
}

// Perl modules shipped with perl itself and pragmas; `use lib`, other modules, `require`, string
// `eval` and `do FILE` load other code.
const PERL_CORE =
  /^(?:strict|warnings|utf8|feature|constant|vars|integer|bytes|open|parent|POSIX|Carp|Cwd|Encode|Storable|Getopt::(?:Long|Std)|File::(?:Basename|Spec|Path|Temp|Copy|Find|stat)|List::Util|Scalar::Util|Data::Dumper|JSON::PP|Time::(?:Local|HiRes|Piece)|IO::(?:Handle|File)|Text::(?:Wrap|ParseWords)|MIME::Base64|Digest::(?:MD5|SHA))$/u;
function perlLoads(code: string): boolean {
  if (/\brequire\b|\bdo\b(?!\s*\{)|\beval\b(?!\s*\{)|@INC|%INC|\bUNIVERSAL\b/u.test(code))
    return true;
  for (const match of code.matchAll(/\b(?:use|no)\s+([\w:]+)/gu))
    if (!/^v?\d/u.test(match[1] ?? "") && !PERL_CORE.test(match[1] ?? "")) return true;
  return false;
}

const LOADERS: Partial<Record<PureLanguage, (code: string) => boolean>> = {
  python: pythonLoads,
  javascript: javascriptLoads,
  perl: perlLoads,
  lua: (code) =>
    /\b(?:require|dofile|loadfile|load|loadstring|package|module|_G|_ENV|getfenv|setfenv|debug)\b/u.test(
      code,
    ),
  php: (code) =>
    /\b(?:include|include_once|require|require_once|eval|assert|create_function|spl_autoload_register|__autoload|set_include_path|ini_set|dl)\b/iu.test(
      code,
    ),
  ruby: (code) =>
    /\b(?:require|require_relative|load|autoload|eval|instance_eval|class_eval|module_eval|instance_exec|class_exec|binding|send|public_send|__send__|method|define_method|const_get|Kernel|ObjectSpace|Gem|Bundler)\b|\$LOAD_PATH|\$:|\$LOADED_FEATURES|\$"/u.test(
      code,
    ),
  powershell: (code) =>
    /Import-Module|\bipmo\b|\busing\s+(?:module|assembly)\b|Add-Type|Invoke-Expression|\biex\b|Invoke-Command|\bicm\b|Start-Job|ScriptBlock|NewScriptBlock|InvokeScript|ExecutionContext|#requires|\.ps[dm]?1\b|\.dll\b|&|(?:^|[\s;({|])\.{1,2}[\\/]|(?:^|[\s;({|])\.[ \t]+\S/imu.test(
      code,
    ),
};

/**
 * Whether a script loads code from somewhere other than its own text and the
 * system interpreter's standard library. Such a script is not pinned for a routine: its digest
 * would keep matching after the loaded file changed. `pythonClean` says the directory Python
 * searches first holds nothing that shadows a standard module (or the run uses `-I` / `-P`).
 */
export function scriptLoadsCode(language: PureLanguage, code: string, pythonClean: boolean) {
  if (language === "python" && !pythonClean) return true;
  const loads = LOADERS[language];
  if (!loads) return true;
  if (loads(code)) return true;
  // Python folds identifiers with NFKC; the folded text must not load anything either.
  const folded = code.normalize("NFKC");
  return language === "python" && folded !== code && loads(folded);
}
