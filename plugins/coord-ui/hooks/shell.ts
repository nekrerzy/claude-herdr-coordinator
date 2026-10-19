// A small POSIX-ish shell tokenizer for the guardrails: enough of bash to find
// every simple command a Bash tool call would run, with its argv unquoted.
//
// Handles: ; && || | |& & and newlines, ( ) subshells and { } groups (flattened),
// $( ) and backtick substitutions and <( ) >( ) (their commands are listed too),
// '…', "…", $'…', backslash escapes, ${…}, # comments, NAME=value prefixes,
// redirections (their targets are not argv), heredocs (<<, <<-, quoted
// delimiters) and here-strings (<<<), whose text is kept as the command's stdin.
//
// Known limits: no alias, function or variable expansion ($VAR stays literal),
// no globbing, `case` patterns and arithmetic are read as words. It never
// throws on malformed input: an unterminated quote runs to the end.

export type Cmd = {
  /** The words, quotes removed; a substitution keeps its source text. */
  argv: string[]
  /** Leading NAME=value words. */
  assigns: string[]
  /** Heredoc bodies and here-strings fed to this command's stdin. */
  stdin: string[]
  /** Source text of the previous pipeline stage, when this one is piped into. */
  pipedFrom?: string
  /** Source text of this command, roughly (heredoc bodies excluded). */
  raw: string
  /** Directory a preceding `cd <dir>` in the same script moved to ('' = session cwd). */
  cwd: string
}

type Pending = { delim: string; strip: boolean; cmd: Cmd }

const KEYWORDS = new Set([
  '!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time',
])

class Parser {
  i = 0
  out: Cmd[] = []
  constructor(readonly src: string) {}

  /** Reads commands until `term` at command level (or the end); returns past it. */
  list(term: ')' | '`' | null): void {
    const s = this.src
    let cmd: Cmd | null = null
    let start = this.i
    let word: string | null = null
    let redirect = false
    let hereString = false
    let pending: Pending[] = []
    let prevRaw: string | undefined
    let piped = false
    let depth = 0 // subshells opened inside a $( ) that `)` closes first

    const current = (): Cmd => {
      if (!cmd) {
        cmd = { argv: [], assigns: [], stdin: [], raw: '', cwd: '' }
        if (piped && prevRaw !== undefined) cmd.pipedFrom = prevRaw
      }
      return cmd
    }
    const endWord = () => {
      if (word === null) return
      const c = current()
      if (hereString) c.stdin.push(word)
      else if (!redirect) {
        if (c.argv.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) c.assigns.push(word)
        else if (c.argv.length === 0 && KEYWORDS.has(word)) {
          /* reserved word: the command follows it */
        } else c.argv.push(word)
      }
      redirect = false
      hereString = false
      word = null
    }
    const endCmd = (op: string) => {
      endWord()
      const c = cmd as Cmd | null
      if (c && (c.argv.length > 0 || c.assigns.length > 0 || c.stdin.length > 0)) {
        c.raw = s.slice(start, this.i).trim()
        this.out.push(c)
        prevRaw = c.raw
      } else if (op !== '|') prevRaw = undefined
      piped = op === '|'
      cmd = null
    }
    const append = (text: string) => {
      word = (word ?? '') + text
    }
    const readHeredocs = () => {
      for (const p of pending) {
        const lines: string[] = []
        while (this.i < s.length) {
          let end = s.indexOf('\n', this.i)
          if (end < 0) end = s.length
          const line = s.slice(this.i, end)
          this.i = Math.min(end + 1, s.length)
          if ((p.strip ? line.replace(/^\t+/, '') : line) === p.delim) break
          lines.push(line)
        }
        p.cmd.stdin.push(lines.join('\n'))
      }
      pending = []
    }

    while (this.i < s.length) {
      const ch = s[this.i] as string
      const two = s.slice(this.i, this.i + 2)
      if (ch === '(' && term === ')') depth++
      else if (ch === ')' && depth > 0) depth--
      else if (term !== null && ch === term) {
        endCmd(';')
        this.i++
        return
      }
      if (ch === ' ' || ch === '\t') {
        endWord()
        this.i++
      } else if (ch === '\n') {
        endCmd(';')
        this.i++
        readHeredocs()
        start = this.i
      } else if (ch === '#' && word === null) {
        while (this.i < s.length && s[this.i] !== '\n') this.i++
      } else if (ch === '\\') {
        if (s[this.i + 1] === '\n') this.i += 2
        else {
          append(s[this.i + 1] ?? '')
          this.i += 2
        }
      } else if (ch === "'") {
        const end = s.indexOf("'", this.i + 1)
        const stop = end < 0 ? s.length : end
        append(s.slice(this.i + 1, stop))
        this.i = stop + 1
      } else if (two === "$'") {
        this.i += 2
        let text = ''
        while (this.i < s.length && s[this.i] !== "'") {
          if (s[this.i] === '\\') {
            const e = s[this.i + 1] ?? ''
            text += e === 'n' ? '\n' : e === 't' ? '\t' : e
            this.i += 2
          } else text += s[this.i++]
        }
        this.i++
        append(text)
      } else if (ch === '"') {
        this.i++
        append(this.doubleQuoted())
      } else if (two === '$(' || two === '<(' || two === '>(') {
        append(this.substitution(2, ')'))
      } else if (ch === '`') {
        append(this.substitution(1, '`'))
      } else if (two === '${') {
        const end = s.indexOf('}', this.i)
        const stop = end < 0 ? s.length : end + 1
        append(s.slice(this.i, stop))
        this.i = stop
      } else if (two === '&&' || two === '||' || two === '|&' || two === ';;') {
        endCmd(two === '|&' ? '|' : two)
        this.i += 2
        start = this.i
      } else if (two === '&>') {
        endWord()
        this.i += s[this.i + 2] === '>' ? 3 : 2
        redirect = true
      } else if (ch === ';' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
        endCmd(ch)
        this.i++
        start = this.i
      } else if (s.startsWith('<<<', this.i)) {
        endWord()
        this.i += 3
        hereString = true
      } else if (two === '<<') {
        endWord()
        this.i += 2
        const strip = s[this.i] === '-'
        if (strip) this.i++
        while (s[this.i] === ' ' || s[this.i] === '\t') this.i++
        const delim = this.delimiter()
        pending.push({ delim, strip, cmd: current() })
      } else if (ch === '>' || ch === '<') {
        // an all-digit word right before the operator is its fd number
        if (word !== null && /^\d+$/.test(word)) word = null
        endWord()
        this.i++
        while (s[this.i] === '>' || s[this.i] === '&' || s[this.i] === '|') this.i++
        redirect = true
        current()
      } else {
        append(ch)
        this.i++
      }
    }
    endCmd(';')
    readHeredocs()
  }

  /** The text of "…" (opening quote already consumed); listing its substitutions. */
  doubleQuoted(): string {
    const s = this.src
    let text = ''
    while (this.i < s.length && s[this.i] !== '"') {
      const two = s.slice(this.i, this.i + 2)
      if (s[this.i] === '\\' && '"\\$`\n'.includes(s[this.i + 1] ?? '')) {
        if (s[this.i + 1] !== '\n') text += s[this.i + 1]
        this.i += 2
      } else if (two === '$(') text += this.substitution(2, ')')
      else if (s[this.i] === '`') text += this.substitution(1, '`')
      else text += s[this.i++]
    }
    this.i++
    return text
  }

  /** Parses a substitution's commands into `out`; returns its source text. */
  substitution(open: number, close: ')' | '`'): string {
    const from = this.i
    this.i += open
    this.list(close)
    return this.src.slice(from, this.i)
  }

  /** A heredoc delimiter word, quotes removed. */
  delimiter(): string {
    const s = this.src
    let d = ''
    while (this.i < s.length && !' \t\n;&|<>()'.includes(s[this.i] as string)) {
      const ch = s[this.i] as string
      if (ch === "'" || ch === '"') {
        const end = s.indexOf(ch, this.i + 1)
        const stop = end < 0 ? s.length : end
        d += s.slice(this.i + 1, stop)
        this.i = stop + 1
      } else if (ch === '\\') {
        d += s[this.i + 1] ?? ''
        this.i += 2
      } else {
        d += ch
        this.i++
      }
    }
    return d
  }
}

/** Every simple command in `src`, in source order (a substitution's before its own). */
export function parse(src: string): Cmd[] {
  const p = new Parser(src)
  p.list(null)
  let cwd = ''
  for (const c of p.out) {
    c.cwd = cwd
    if (c.argv[0] === 'cd' && c.argv.length === 2 && c.argv[1] !== '-') cwd = joinPath(cwd, c.argv[1] as string)
  }
  return p.out
}

/** `base` joined with `path`; an absolute or ~ path replaces it. */
export function joinPath(base: string, path: string): string {
  if (path.startsWith('/') || path.startsWith('~') || base === '') return path
  return `${base.replace(/\/+$/, '')}/${path}`
}
