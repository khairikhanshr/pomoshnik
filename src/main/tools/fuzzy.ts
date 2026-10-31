// Fuzzy name matching for apps (and anything else picked by a spoken name): case and diacritics
// insensitive, Cyrillic transliterated to Latin, then compared on a rough phonetic key.

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '',
  ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ё: 'e', й: 'y',
  // Kazakh / Ukrainian letters (Cyrillic users in KZ / UA)
  ә: 'a', ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i', ї: 'i', є: 'e', ґ: 'g'
}

/** Removes invisible bidi / zero-width marks some apps put in their names ("\u200eWhatsApp"). */
export function cleanDisplayName(text: string): string {
  return text.replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim()
}

/** Lower-case, no diacritics (ё -> е, й -> и), no extension, punctuation -> single spaces. */
export function normalizeName(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\.(app|exe|lnk|url|appref-ms)$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function transliterate(text: string): string {
  let out = ''
  for (const ch of text) out += TRANSLIT[ch] ?? ch
  return out
}

/** Rough sound-alike key: "дискорд" and "discord" -> "diskord", "фотошоп" and "photoshop" -> "fotoshop". */
export function phoneticKey(text: string): string {
  return transliterate(normalizeName(text))
    .replace(/\s+/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/kh/g, 'h')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/[cq]/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/w/g, 'v')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1')
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length)
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest
}

interface Prepared {
  norm: string
  words: string[]
  key: string
  wordKeys: string[]
}

function prepare(text: string): Prepared {
  const norm = normalizeName(text)
  const words = norm.split(' ').filter(Boolean)
  return { norm, words, key: phoneticKey(norm), wordKeys: words.map((w) => phoneticKey(w)) }
}

/** Below this a candidate is not considered a match at all. */
export const MATCH_THRESHOLD = 60

/** 0..100: how well `candidate` matches the spoken / typed `query`. */
export function scoreName(query: string, candidate: string): number {
  return scorePrepared(prepare(query), prepare(candidate))
}

function scorePrepared(q: Prepared, c: Prepared): number {
  if (!q.norm || !c.norm) return 0
  if (q.norm === c.norm) return 100
  if (q.key && q.key === c.key) return 96
  if (c.norm.startsWith(`${q.norm} `)) return 90
  if (q.words.every((w) => c.words.includes(w))) return 86
  if (q.key.length >= 3 && c.key.startsWith(q.key)) return 80
  if (c.key.length >= 3 && q.key.startsWith(c.key)) return 76
  if (q.wordKeys.every((qk) => qk.length >= 2 && c.wordKeys.some((ck) => ck.startsWith(qk)))) return 72
  if (q.key.length >= 4 && c.key.includes(q.key)) return 66
  const whole = similarity(q.key, c.key)
  const perWord = q.words.length === 1 ? Math.max(0, ...c.wordKeys.map((ck) => similarity(q.key, ck))) : 0
  const sim = Math.max(whole, perWord)
  if (sim >= 0.75) return Math.round(40 + sim * 30)
  return Math.round(sim * 50)
}

export interface Candidate<T> {
  item: T
  /** Every name the item is known by (display name, file name, localized name…). */
  names: readonly string[]
}

export interface Ranked<T> {
  item: T
  score: number
  /** The candidate name that matched best. */
  name: string
}

/** Best score of each candidate over all query variants (original text + alias expansions). */
export function rankCandidates<T>(queries: readonly string[], candidates: readonly Candidate<T>[]): Ranked<T>[] {
  const prepared = queries.map((q) => prepare(q)).filter((q) => q.norm)
  const ranked: Ranked<T>[] = []
  for (const cand of candidates) {
    let best = 0
    let bestName = cand.names[0] ?? ''
    for (const name of cand.names) {
      const c = prepare(name)
      for (const q of prepared) {
        const s = scorePrepared(q, c)
        if (s > best) {
          best = s
          bestName = name
        }
      }
    }
    if (best > 0) ranked.push({ item: cand.item, score: best, name: bestName })
  }
  return ranked.sort((a, b) => b.score - a.score || a.name.length - b.name.length)
}

export type MatchOutcome<T> =
  | { kind: 'match'; best: Ranked<T>; ranked: Ranked<T>[] }
  | { kind: 'ambiguous'; ranked: Ranked<T>[] }
  | { kind: 'none'; ranked: Ranked<T>[] }

/** A clear winner, several near-equal candidates, or nothing good enough. */
export function decideMatch<T>(ranked: Ranked<T>[]): MatchOutcome<T> {
  const [best, second] = ranked
  if (!best || best.score < MATCH_THRESHOLD) return { kind: 'none', ranked }
  if (best.score >= 96 || !second || second.score < best.score - 3) return { kind: 'match', best, ranked }
  return { kind: 'ambiguous', ranked }
}
