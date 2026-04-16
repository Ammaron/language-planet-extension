/**
 * VocabMatcher — Aho-Corasick automaton for O(T+Z) word matching.
 *
 * Replaces O(T*W) indexOf-per-term scans with a single multi-pattern pass.
 */

class TrieNode {
  constructor() {
    this.children = new Map();
    this.fail = null;
    this.output = [];
    this.depth = 0;
  }
}

class VocabMatcher {
  constructor(words, options = {}) {
    this.root = new TrieNode();
    this.wordMap = new Map(); // lowercaseKey -> VocabWord[]
    this.rotationSalt = options.rotationSalt || '';
    this.buildTrie(words);
    this.buildFailureLinks();
  }

  // ─── Build Phase ────────────────────────────────

  buildTrie(words) {
    this.wordMap.clear();

    for (const word of words) {
      const keys = new Set();
      keys.add(this.normalizeKey(word.translation));

      if (Array.isArray(word.searchable_forms)) {
        for (const form of word.searchable_forms) {
          keys.add(this.normalizeKey(form));
        }
      }

      if (Array.isArray(word.source_forms)) {
        for (const form of word.source_forms) {
          keys.add(this.normalizeKey(form));
        }
      }

      for (const key of keys) {
        if (key) this.insertWord(key, word);
      }
    }
  }

  insertWord(key, word) {
    if (!this.wordMap.has(key)) {
      this.wordMap.set(key, []);
    }
    const candidates = this.wordMap.get(key);
    if (!candidates.some(candidate => candidate.id === word.id)) {
      candidates.push(word);
    }

    let node = this.root;
    for (const ch of key) {
      if (!node.children.has(ch)) {
        const child = new TrieNode();
        child.depth = node.depth + 1;
        node.children.set(ch, child);
      }
      node = node.children.get(ch);
    }

    if (!node.output.some(entry => entry.word.id === word.id && entry.key === key)) {
      node.output.push({ word, key });
    }
  }

  normalizeKey(value) {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase();
  }

  buildFailureLinks() {
    const queue = [];

    for (const child of this.root.children.values()) {
      child.fail = this.root;
      queue.push(child);
    }

    while (queue.length > 0) {
      const current = queue.shift();

      for (const [ch, child] of current.children) {
        queue.push(child);

        let failNode = current.fail;
        while (failNode && !failNode.children.has(ch)) {
          failNode = failNode.fail;
        }
        child.fail = failNode ? failNode.children.get(ch) : this.root;

        if (child.fail === child) {
          child.fail = this.root;
        }

        if (child.fail.output.length > 0) {
          child.output = child.output.concat(child.fail.output);
        }
      }
    }
  }

  // ─── Search Phase ──────────────────────────────

  findMatches(text) {
    const lowerText = text.toLowerCase();
    const rawMatches = [];

    let node = this.root;
    for (let i = 0; i < lowerText.length; i++) {
      const ch = lowerText[i];

      while (node && !node.children.has(ch)) {
        node = node.fail;
      }
      node = node ? node.children.get(ch) : this.root;

      if (node.output.length > 0) {
        for (const entry of node.output) {
          const termLen = entry.key.length;
          const start = i - termLen + 1;
          rawMatches.push({ start, end: i + 1, entry });
        }
      }
    }

    const resolved = this.postProcess(rawMatches, text);
    return this.groupAdjacentMatches(resolved, text);
  }

  postProcess(rawMatches, text) {
    const bounded = rawMatches.filter(m => this.isWordBoundary(text, m.start, m.end - m.start, m.entry.key));

    // Prefer longer multi-word source keys over overlapping single words.
    bounded.sort((a, b) => (
      a.start - b.start
      || this.countKeyWords(b.entry.key) - this.countKeyWords(a.entry.key)
      || (b.end - b.start) - (a.end - a.start)
    ));

    const result = [];
    const used = new Set();

    for (const match of bounded) {
      let overlap = false;
      for (let i = match.start; i < match.end; i++) {
        if (used.has(i)) { overlap = true; break; }
      }
      if (overlap) continue;

      const key = match.entry.key;
      const candidates = this.wordMap.get(key);
      const resolved = this.disambiguate(candidates, text, match.start);
      if (!resolved) continue;

      for (let i = match.start; i < match.end; i++) used.add(i);

      result.push({
        start: match.start,
        end: match.end,
        original: text.substring(match.start, match.end),
        matchedForm: key,
        word: resolved,
      });
    }

    return result.sort((a, b) => a.start - b.start);
  }

  countKeyWords(key) {
    const matches = String(key || '').match(/\S+/g);
    return matches ? matches.length : 0;
  }

  groupAdjacentMatches(matches, text) {
    if (matches.length === 0) return { singles: [], phrases: [] };

    const { isGlueGap, MAX_GAP_CHARS, MIN_PHRASE_WORDS } = window.GrammarRules || {};
    if (!isGlueGap) return { singles: matches, phrases: [] };

    const sourceLang = this.detectSourceLanguage(matches);

    const groups = [];
    let currentGroup = [matches[0]];

    for (let i = 1; i < matches.length; i++) {
      const prev = currentGroup[currentGroup.length - 1];
      const curr = matches[i];
      const gapText = text.substring(prev.end, curr.start);

      const isAdjacent = gapText.length <= MAX_GAP_CHARS && isGlueGap(gapText, sourceLang);

      if (isAdjacent) {
        currentGroup.push(curr);
      } else {
        groups.push(currentGroup);
        currentGroup = [curr];
      }
    }
    groups.push(currentGroup);

    const singles = [];
    const phrases = [];

    for (const group of groups) {
      if (group.length >= (MIN_PHRASE_WORDS || 2)) {
        phrases.push({
          matches: group,
          sourceText: text.substring(group[0].start, group[group.length - 1].end),
          start: group[0].start,
          end: group[group.length - 1].end,
        });
      } else {
        singles.push(...group);
      }
    }

    return { singles, phrases };
  }

  detectSourceLanguage(matches) {
    for (const m of matches) {
      if (m.word && m.word.search_language) return m.word.search_language;
    }
    return 'en';
  }

  isWordBoundary(text, start, length, key = '') {
    if (this.isBoundarylessScript(key)) {
      return true;
    }

    const end = start + length;
    const boundaryRe = /[\s.,;:!?'"()\[\]{}\-\/\\<>@#$%^&*+=|~`\u2014\u2013\u00a1\u00bf]/;

    if (start > 0 && !boundaryRe.test(text[start - 1])) return false;
    if (end < text.length && !boundaryRe.test(text[end])) return false;

    return true;
  }

  isBoundarylessScript(text) {
    return /[\u0e00-\u0e7f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(text);
  }

  disambiguate(candidates, text, matchIdx) {
    if (!candidates || candidates.length === 0) return null;

    if (candidates.length === 1) {
      return this.cloneCandidate(candidates[0]);
    }

    const { sentence, offset } = this._extractSentence(text, matchIdx);
    const sentenceHash = String(this._stableHash(sentence));
    const surrounding = text.substring(Math.max(0, matchIdx - 60), Math.min(text.length, matchIdx + 60)).toLowerCase();

    const scored = candidates.map(candidate => {
      let hintScore = 0;
      const hint = (candidate.context_hint || '').toLowerCase();
      if (hint) {
        const keywords = hint.split(/[\s,;/]+/).filter(k => k.length > 2);
        for (const keyword of keywords) {
          if (surrounding.includes(keyword)) hintScore += 1;
        }
      }

      let domainScore = 0;
      if (Array.isArray(candidate.domain_tags)) {
        for (const tag of candidate.domain_tags) {
          if (typeof tag === 'string' && tag.length > 1 && surrounding.includes(tag.toLowerCase())) {
            domainScore += 1;
          }
        }
      }

      const total = hintScore + Math.min(4, domainScore);
      return {
        candidate,
        score: total,
        hintScore,
      };
    });

    const groups = new Map();
    for (const row of scored) {
      const meaningKey = row.candidate.meaning_key || `mk_${row.candidate.id}`;
      if (!groups.has(meaningKey)) {
        groups.set(meaningKey, {
          meaningKey,
          maxScore: -1,
          sumScore: 0,
          hintScore: 0,
          rows: [],
        });
      }
      const group = groups.get(meaningKey);
      group.maxScore = Math.max(group.maxScore, row.score);
      group.sumScore += row.score;
      group.hintScore += row.hintScore;
      group.rows.push(row);
    }

    const sortedGroups = [...groups.values()].sort((a, b) => (
      b.maxScore - a.maxScore
      || b.sumScore - a.sumScore
      || b.hintScore - a.hintScore
      || a.meaningKey.localeCompare(b.meaningKey)
    ));

    const bestGroup = sortedGroups[0];
    if (!bestGroup || bestGroup.rows.length === 0) {
      const fallback = this.cloneCandidate(candidates[0]);
      fallback._isAmbiguous = true;
      fallback._candidateIds = candidates.map(c => c.id);
      fallback._sentenceContext = sentence;
      fallback._matchOffset = offset;
      return fallback;
    }

    const chosenCandidate = this._selectWeightedVariant(bestGroup.rows, bestGroup.meaningKey, sentenceHash);
    const chosen = this.cloneCandidate(chosenCandidate);

    const sortedByScore = scored
      .slice()
      .sort((a, b) => b.score - a.score || String(a.candidate.id).localeCompare(String(b.candidate.id)));
    const topScore = sortedByScore[0] ? sortedByScore[0].score : 0;
    const alternatives = sortedByScore.slice(0, 3).map(row => ({
      id: row.candidate.id,
      term: row.candidate.term,
      meaning_key: row.candidate.meaning_key || `mk_${row.candidate.id}`,
      confidence: topScore > 0 ? Number((row.score / topScore).toFixed(3)) : 0,
    }));

    chosen._isAmbiguous = true;
    chosen._candidateIds = candidates.map(c => c.id);
    chosen._sentenceContext = sentence;
    chosen._matchOffset = offset;
    chosen._localMeaningKey = bestGroup.meaningKey;
    chosen._alternatives = alternatives;
    chosen._localConfidence = topScore > 0 ? Number((Math.min(1, topScore / 8)).toFixed(3)) : 0;
    chosen._localMethod = 'local';

    return chosen;
  }

  _selectWeightedVariant(rows, meaningKey, sentenceHash) {
    if (!rows || rows.length === 0) return null;
    if (rows.length === 1) return rows[0].candidate;

    const weekBucket = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    const seedText = `${this.rotationSalt}|${meaningKey}|${sentenceHash}|${weekBucket}`;
    const seed = this._stableHash(seedText);

    const weighted = rows.map(row => ({
      candidate: row.candidate,
      weight: Math.min(1000, Math.max(1, parseInt(row.candidate.variant_weight || 100, 10) || 100)),
    }));

    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) return rows[0].candidate;

    let pick = (seed % totalWeight) + 1;
    for (const item of weighted) {
      pick -= item.weight;
      if (pick <= 0) return item.candidate;
    }

    return weighted[weighted.length - 1].candidate;
  }

  cloneCandidate(candidate) {
    return {
      ...candidate,
      source_forms: Array.isArray(candidate.source_forms) ? [...candidate.source_forms] : [],
      domain_tags: Array.isArray(candidate.domain_tags) ? [...candidate.domain_tags] : [],
    };
  }

  _stableHash(input) {
    const str = String(input || '');
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  _extractSentence(text, position) {
    let start = position;
    while (start > 0 && !/[.!?\n]/.test(text[start - 1])) {
      start--;
    }
    while (start < position && /\s/.test(text[start])) {
      start++;
    }

    let end = position;
    while (end < text.length && !/[.!?\n]/.test(text[end])) {
      end++;
    }
    if (end < text.length) end++;

    const sentence = text.substring(start, end).trim();
    const offset = position - start;

    return { sentence, offset: Math.max(0, offset) };
  }
}

if (typeof window !== 'undefined') {
  window.VocabMatcher = VocabMatcher;
}
