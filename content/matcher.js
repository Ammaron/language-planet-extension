/**
 * VocabMatcher — Aho-Corasick automaton for O(T+Z) word matching.
 *
 * Replaces the previous O(T*W) indexOf-per-term approach.
 * Builds a trie with failure links for multi-pattern matching in a single
 * left-to-right pass through the text.
 */

class TrieNode {
  constructor() {
    this.children = new Map(); // char → TrieNode
    this.fail = null;          // suffix/failure link
    this.output = [];          // { word, key }[] that end at this node
    this.depth = 0;
  }
}

class VocabMatcher {
  constructor(words) {
    this.root = new TrieNode();
    this.wordMap = new Map(); // lowercaseKey → VocabWord[] (for disambiguation)
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

      for (const key of keys) {
        if (key) {
          this.insertWord(key, word);
        }
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

    // Initialize depth-1 nodes: their fail links point to root
    for (const child of this.root.children.values()) {
      child.fail = this.root;
      queue.push(child);
    }

    // BFS to build failure links
    while (queue.length > 0) {
      const current = queue.shift();

      for (const [ch, child] of current.children) {
        queue.push(child);

        // Walk up failure links to find the longest proper suffix
        let failNode = current.fail;
        while (failNode && !failNode.children.has(ch)) {
          failNode = failNode.fail;
        }
        child.fail = failNode ? failNode.children.get(ch) : this.root;

        // Don't point to self
        if (child.fail === child) {
          child.fail = this.root;
        }

        // Merge output lists along failure chain (dictionary suffix links)
        if (child.fail.output.length > 0) {
          child.output = child.output.concat(child.fail.output);
        }
      }
    }
  }

  // ─── Search Phase ──────────────────────────────

  /**
   * Find all vocab matches in a text string.
   * Returns { singles: Match[], phrases: PhraseCandidate[] }.
   *
   * singles — matches that have no adjacent neighbor (current behavior).
   * phrases — groups of ≥2 adjacent matched words with glue-only gaps.
   */
  findMatches(text) {
    const lowerText = text.toLowerCase();
    const rawMatches = [];

    // Single-pass Aho-Corasick scan
    let node = this.root;
    for (let i = 0; i < lowerText.length; i++) {
      const ch = lowerText[i];

      while (node && !node.children.has(ch)) {
        node = node.fail;
      }
      node = node ? node.children.get(ch) : this.root;

      // Collect all matches ending at position i
      if (node.output.length > 0) {
        for (const entry of node.output) {
          const termLen = entry.key.length;
          const start = i - termLen + 1;
          rawMatches.push({ start, end: i + 1, entry });
        }
      }
    }

    // Post-process: word boundaries, disambiguation, overlap resolution
    const resolved = this.postProcess(rawMatches, text);

    // Group adjacent matches into phrase candidates
    return this.groupAdjacentMatches(resolved, text);
  }

  postProcess(rawMatches, text) {
    // Filter by word boundary
    const bounded = rawMatches.filter(m => this.isWordBoundary(text, m.start, m.end - m.start, m.entry.key));

    // Sort: by start position, then longest first for overlap resolution
    bounded.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

    // Greedy longest-first overlap resolution
    const result = [];
    const used = new Set();

    for (const match of bounded) {
      let overlap = false;
      for (let i = match.start; i < match.end; i++) {
        if (used.has(i)) { overlap = true; break; }
      }
      if (overlap) continue;

      // Disambiguation for homonyms
      const key = match.entry.key;
      const candidates = this.wordMap.get(key);
      const resolved = this.disambiguate(candidates, text, match.start);
      if (!resolved) continue;

      // Mark positions as used
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

  /**
   * Group adjacent matches into phrase candidates.
   * Walks the sorted match list left-to-right, merging matches whose
   * gap contains only whitespace and/or glue words.
   *
   * @param {Array} matches - Sorted matches from postProcess
   * @param {string} text - The original text
   * @returns {{ singles: Match[], phrases: PhraseCandidate[] }}
   */
  groupAdjacentMatches(matches, text) {
    if (matches.length === 0) return { singles: [], phrases: [] };

    const { isGlueGap, MAX_GAP_CHARS, MIN_PHRASE_WORDS } = window.GrammarRules || {};

    // If grammar-rules.js isn't loaded, fall back to all-singles
    if (!isGlueGap) return { singles: matches, phrases: [] };

    // Detect source language from the first match's search data
    const sourceLang = this.detectSourceLanguage(matches);

    const groups = []; // Array of arrays of matches
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

  /**
   * Detect the source language from vocab word metadata.
   * Falls back to 'en' if no search_language data is available.
   */
  detectSourceLanguage(matches) {
    for (const m of matches) {
      if (m.word && m.word.search_language) return m.word.search_language;
    }
    return 'en';
  }

  /**
   * Check word boundaries — match must be surrounded by
   * whitespace, punctuation, or string boundaries.
   */
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

  /**
   * Disambiguate when multiple vocab entries share the same source-page form.
   * Examines ~50 chars of surrounding context for keyword overlap with context_hint.
   *
   * When multiple candidates exist, the chosen word is decorated with
   * disambiguation metadata (_isAmbiguous, _candidateIds, etc.) so the
   * content script can request async spaCy-based disambiguation from the backend.
   */
  disambiguate(candidates, text, matchIdx) {
    if (!candidates || candidates.length === 1) return candidates ? candidates[0] : null;

    const withHints = candidates.filter(c => c.context_hint);

    let bestScore = 0;
    let bestCandidate = null;

    if (withHints.length > 0) {
      const contextStart = Math.max(0, matchIdx - 50);
      const contextEnd = Math.min(text.length, matchIdx + 50);
      const surrounding = text.substring(contextStart, contextEnd).toLowerCase();

      for (const candidate of candidates) {
        if (!candidate.context_hint) continue;

        const keywords = candidate.context_hint.toLowerCase().split(/[\s,;/]+/).filter(k => k.length > 2);
        let score = 0;

        for (const keyword of keywords) {
          if (surrounding.includes(keyword)) score++;
        }

        if (score > bestScore) {
          bestScore = score;
          bestCandidate = candidate;
        }
      }
    }

    const chosen = bestScore > 0 ? bestCandidate : candidates[0];

    // Mark as ambiguous so the content script can request backend disambiguation
    if (candidates.length >= 2) {
      const { sentence, offset } = this._extractSentence(text, matchIdx);
      chosen._isAmbiguous = true;
      chosen._candidateIds = candidates.map(c => c.id);
      chosen._sentenceContext = sentence;
      chosen._matchOffset = offset;
    }

    return chosen;
  }

  /**
   * Extract the containing sentence around a character position.
   * Splits on sentence-ending punctuation (.!?\n) and returns
   * { sentence, offset } where offset is matchIdx relative to sentence start.
   */
  _extractSentence(text, position) {
    // Find sentence start: scan backward for sentence boundary
    let start = position;
    while (start > 0 && !/[.!?\n]/.test(text[start - 1])) {
      start--;
    }
    // Skip any leading whitespace
    while (start < position && /\s/.test(text[start])) {
      start++;
    }

    // Find sentence end: scan forward for sentence boundary
    let end = position;
    while (end < text.length && !/[.!?\n]/.test(text[end])) {
      end++;
    }
    // Include the punctuation mark
    if (end < text.length) end++;

    const sentence = text.substring(start, end).trim();
    const offset = position - start;

    return { sentence, offset: Math.max(0, offset) };
  }
}

// Export for content.js
if (typeof window !== 'undefined') {
  window.VocabMatcher = VocabMatcher;
}
