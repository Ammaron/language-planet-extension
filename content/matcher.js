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
    this.output = [];          // VocabWord[] that end at this node
    this.depth = 0;
  }
}

class VocabMatcher {
  constructor(words) {
    this.root = new TrieNode();
    this.wordMap = new Map(); // lowercaseTerm → VocabWord[] (for disambiguation)
    this.buildTrie(words);
    this.buildFailureLinks();
  }

  // ─── Build Phase ────────────────────────────────

  buildTrie(words) {
    this.wordMap.clear();

    for (const word of words) {
      // Search pages for the English translation, replace with target-language term
      const key = word.translation.toLowerCase();

      // Track in wordMap for disambiguation
      if (!this.wordMap.has(key)) {
        this.wordMap.set(key, []);
      }
      this.wordMap.get(key).push(word);

      // Insert into trie
      let node = this.root;
      for (const ch of key) {
        if (!node.children.has(ch)) {
          const child = new TrieNode();
          child.depth = node.depth + 1;
          node.children.set(ch, child);
        }
        node = node.children.get(ch);
      }
      // Store word at terminal node
      if (!node.output.some(w => w.id === word.id)) {
        node.output.push(word);
      }
    }
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
   * Returns array of { start, end, original, word } objects, sorted by position.
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
        for (const word of node.output) {
          const termLen = word.translation.length;
          const start = i - termLen + 1;
          rawMatches.push({ start, end: i + 1, word });
        }
      }
    }

    // Post-process: word boundaries, disambiguation, overlap resolution
    return this.postProcess(rawMatches, text);
  }

  postProcess(rawMatches, text) {
    // Filter by word boundary
    const bounded = rawMatches.filter(m => this.isWordBoundary(text, m.start, m.end - m.start));

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
      const term = match.word.translation.toLowerCase();
      const candidates = this.wordMap.get(term);
      const resolved = this.disambiguate(candidates, text, match.start);
      if (!resolved) continue;

      // Mark positions as used
      for (let i = match.start; i < match.end; i++) used.add(i);

      result.push({
        start: match.start,
        end: match.end,
        original: text.substring(match.start, match.end),
        word: resolved,
      });
    }

    return result.sort((a, b) => a.start - b.start);
  }

  /**
   * Check word boundaries — match must be surrounded by
   * whitespace, punctuation, or string boundaries.
   */
  isWordBoundary(text, start, length) {
    const end = start + length;
    const boundaryRe = /[\s.,;:!?'"()\[\]{}\-\/\\<>@#$%^&*+=|~`\u2014\u2013]/;

    if (start > 0 && !boundaryRe.test(text[start - 1])) return false;
    if (end < text.length && !boundaryRe.test(text[end])) return false;

    return true;
  }

  /**
   * Disambiguate when multiple translations exist for the same English term.
   * Examines ~50 chars of surrounding context for keyword overlap with context_hint.
   */
  disambiguate(candidates, text, matchIdx) {
    if (!candidates || candidates.length === 1) return candidates ? candidates[0] : null;

    const withHints = candidates.filter(c => c.context_hint);
    if (withHints.length === 0) return candidates[0];

    const contextStart = Math.max(0, matchIdx - 50);
    const contextEnd = Math.min(text.length, matchIdx + 50);
    const surrounding = text.substring(contextStart, contextEnd).toLowerCase();

    let bestScore = 0;
    let bestCandidate = null;

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

    return bestScore > 0 ? bestCandidate : candidates[0];
  }
}

// Export for content.js
if (typeof window !== 'undefined') {
  window.VocabMatcher = VocabMatcher;
}
