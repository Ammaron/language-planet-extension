/**
 * Grammar Rules — glue words, composition rules, and phrase reordering.
 *
 * Provides per-language constants for phrase detection (glue words that can
 * appear between matched vocab and still count as "adjacent") and composition
 * rules that reorder/adjust target-language output for short phrases.
 */

// ─── Glue Words (gap fillers between matched vocab) ──
// Words that can appear between two matched vocab words and the group
// still counts as a single phrase candidate.

const GLUE_WORDS = {
  en: new Set([
    'the', 'a', 'an',
    'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by',
    'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being',
    'and', 'or', 'but', 'not', 'no',
    'this', 'that', 'these', 'those',
    'my', 'your', 'his', 'her', 'its', 'our', 'their',
    'very', 'so', 'too', 'quite', 'really',
  ]),
  es: new Set([
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
    'de', 'del', 'en', 'a', 'al', 'con', 'por', 'para', 'sin',
    'es', 'son', 'está', 'están', 'era', 'eran', 'fue', 'ser', 'estar',
    'y', 'o', 'pero', 'ni', 'no',
    'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
    'mi', 'tu', 'su', 'nuestro', 'nuestra', 'sus',
    'muy', 'tan', 'más', 'menos',
  ]),
};

// Maximum character gap between two matches for them to be "adjacent"
// (measured as the text between end of match A and start of match B)
const MAX_GAP_CHARS = 30;

// Minimum matched words to form a phrase candidate
const MIN_PHRASE_WORDS = 2;

// ─── Composition Rules ──────────────────────────────
// Each rule: { match(words) → bool, apply(words) → {translation, confidence} }
// `words` is an array of { word, pos, term, original, matchedForm }
// `pos` is part_of_speech from the vocab data.

/**
 * Spanish composition rules — applied when target language is Spanish.
 * Handles adjective–noun reordering and article agreement.
 */
const SPANISH_RULES = [
  // ADJ + NOUN → NOUN + ADJ  ("red cat" → "gato rojo")
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'adjective'
        && words[1].pos === 'noun';
    },
    apply(words) {
      const adj = words[0].term;
      const noun = words[1].term;
      return { translation: `${noun} ${adj}`, confidence: 0.9 };
    },
  },

  // NOUN + ADJ — already correct order in Spanish, just join
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'noun'
        && words[1].pos === 'adjective';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.85 };
    },
  },

  // ARTICLE + NOUN (the cat → el gato) — the article is a glue word,
  // but if it got matched as vocab we compose it
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'article'
        && words[1].pos === 'noun';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.9 };
    },
  },

  // ARTICLE + ADJ + NOUN → ARTICLE + NOUN + ADJ
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'article'
        && words[1].pos === 'adjective'
        && words[2].pos === 'noun';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[2].term} ${words[1].term}`,
        confidence: 0.85,
      };
    },
  },

  // ARTICLE + NOUN + ADJ — already correct Spanish order
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'article'
        && words[1].pos === 'noun'
        && words[2].pos === 'adjective';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[1].term} ${words[2].term}`,
        confidence: 0.9,
      };
    },
  },

  // NOUN + VERB — preserve order ("cat sleeps" → "gato duerme")
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'noun'
        && words[1].pos === 'verb';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.8 };
    },
  },

  // VERB + NOUN — preserve order ("eat food" → "comer comida")
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'verb'
        && words[1].pos === 'noun';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.8 };
    },
  },

  // ADJ + NOUN + VERB → NOUN + ADJ + VERB ("big cat sleeps" → "gato grande duerme")
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'adjective'
        && words[1].pos === 'noun'
        && words[2].pos === 'verb';
    },
    apply(words) {
      return {
        translation: `${words[1].term} ${words[0].term} ${words[2].term}`,
        confidence: 0.75,
      };
    },
  },

  // VERB + ADV — preserve order ("runs quickly" → "corre rápidamente")
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'verb'
        && words[1].pos === 'adverb';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.85 };
    },
  },

  // ADV + ADJ — preserve order ("very big" → "muy grande")
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'adverb'
        && words[1].pos === 'adjective';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.9 };
    },
  },

  // PRONOUN + VERB — preserve order ("I eat" → "yo como")
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'pronoun'
        && words[1].pos === 'verb';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.9 };
    },
  },

  // NOUN + PREP + NOUN — preserve order ("cat on table" → "gato en mesa")
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'noun'
        && words[1].pos === 'preposition'
        && words[2].pos === 'noun';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[1].term} ${words[2].term}`,
        confidence: 0.85,
      };
    },
  },

  // NOUN + CONJ + NOUN — preserve order ("cat and dog" → "gato y perro")
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'noun'
        && words[1].pos === 'conjunction'
        && words[2].pos === 'noun';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[1].term} ${words[2].term}`,
        confidence: 0.9,
      };
    },
  },

  // PRONOUN + ADJ + NOUN → PRONOUN + NOUN + ADJ ("my red cat" → "mi gato rojo")
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'pronoun'
        && words[1].pos === 'adjective'
        && words[2].pos === 'noun';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[2].term} ${words[1].term}`,
        confidence: 0.8,
      };
    },
  },

  // PRONOUN + NOUN + ADJ — already correct Spanish order ("mi gato rojo")
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'pronoun'
        && words[1].pos === 'noun'
        && words[2].pos === 'adjective';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[1].term} ${words[2].term}`,
        confidence: 0.85,
      };
    },
  },
];

/**
 * English composition rules — applied when target language is English.
 * Reverses Spanish patterns for learners browsing Spanish pages.
 */
const ENGLISH_RULES = [
  // NOUN + ADJ → ADJ + NOUN  ("gato rojo" → "red cat")
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'noun'
        && words[1].pos === 'adjective';
    },
    apply(words) {
      return { translation: `${words[1].term} ${words[0].term}`, confidence: 0.9 };
    },
  },

  // ADJ + NOUN — already correct English order, just join
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'adjective'
        && words[1].pos === 'noun';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.85 };
    },
  },

  // ARTICLE + NOUN + ADJ → ARTICLE + ADJ + NOUN
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'article'
        && words[1].pos === 'noun'
        && words[2].pos === 'adjective';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[2].term} ${words[1].term}`,
        confidence: 0.85,
      };
    },
  },

  // ARTICLE + ADJ + NOUN — already correct English order
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'article'
        && words[1].pos === 'adjective'
        && words[2].pos === 'noun';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[1].term} ${words[2].term}`,
        confidence: 0.9,
      };
    },
  },

  // NOUN + VERB — preserve order
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'noun'
        && words[1].pos === 'verb';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.8 };
    },
  },

  // VERB + NOUN — preserve order
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'verb'
        && words[1].pos === 'noun';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.8 };
    },
  },

  // VERB + ADV — preserve order ("corre rápidamente" → "runs quickly")
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'verb'
        && words[1].pos === 'adverb';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.85 };
    },
  },

  // ADV + ADJ — preserve order ("muy grande" → "very big")
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'adverb'
        && words[1].pos === 'adjective';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.9 };
    },
  },

  // PRONOUN + VERB — preserve order ("yo como" → "I eat")
  {
    match(words) {
      return words.length === 2
        && words[0].pos === 'pronoun'
        && words[1].pos === 'verb';
    },
    apply(words) {
      return { translation: `${words[0].term} ${words[1].term}`, confidence: 0.9 };
    },
  },

  // NOUN + PREP + NOUN — preserve order ("gato en mesa" → "cat on table")
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'noun'
        && words[1].pos === 'preposition'
        && words[2].pos === 'noun';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[1].term} ${words[2].term}`,
        confidence: 0.85,
      };
    },
  },

  // NOUN + CONJ + NOUN — preserve order ("gato y perro" → "cat and dog")
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'noun'
        && words[1].pos === 'conjunction'
        && words[2].pos === 'noun';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[1].term} ${words[2].term}`,
        confidence: 0.9,
      };
    },
  },

  // PRONOUN + NOUN + ADJ → PRONOUN + ADJ + NOUN ("mi gato rojo" → "my red cat")
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'pronoun'
        && words[1].pos === 'noun'
        && words[2].pos === 'adjective';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[2].term} ${words[1].term}`,
        confidence: 0.8,
      };
    },
  },

  // PRONOUN + ADJ + NOUN — already correct English order ("my red cat")
  {
    match(words) {
      return words.length === 3
        && words[0].pos === 'pronoun'
        && words[1].pos === 'adjective'
        && words[2].pos === 'noun';
    },
    apply(words) {
      return {
        translation: `${words[0].term} ${words[1].term} ${words[2].term}`,
        confidence: 0.85,
      };
    },
  },
];

const COMPOSITION_RULES = {
  es: SPANISH_RULES,
  en: ENGLISH_RULES,
};

// Confidence threshold — below this, defer to backend LLM
const CONFIDENCE_THRESHOLD = 0.7;

// ─── Composition Engine ─────────────────────────────

/**
 * Attempt to compose a grammatically correct translation from matched words.
 *
 * @param {Array} matchedWords - Array of { word, pos, term, original, matchedForm }
 * @param {string} targetLang - Target language code (e.g. 'es', 'en')
 * @returns {{ translation: string, confidence: number, source: string } | null}
 *   Returns null if no rule matches or confidence is below threshold.
 */
function composePhrase(matchedWords, targetLang) {
  const rules = COMPOSITION_RULES[targetLang];
  if (!rules) return null;

  // Only apply rules to short phrases (2-4 words)
  if (matchedWords.length < 2 || matchedWords.length > 4) return null;

  for (const rule of rules) {
    if (rule.match(matchedWords)) {
      const result = rule.apply(matchedWords);
      if (result.confidence >= CONFIDENCE_THRESHOLD) {
        return { ...result, source: 'rules' };
      }
      // Low confidence — still return but caller decides whether to use
      return { ...result, source: 'rules_low' };
    }
  }

  // No rule matched — fallback: just join terms in order
  // Only for 2-word combos where POS data is missing
  if (matchedWords.length === 2 && matchedWords.every(w => !w.pos)) {
    return {
      translation: matchedWords.map(w => w.term).join(' '),
      confidence: 0.5,
      source: 'rules_fallback',
    };
  }

  return null;
}

/**
 * Check if a text gap between two matches contains only whitespace and glue words.
 *
 * @param {string} gapText - The text between two matches
 * @param {string} sourceLang - Source language code
 * @returns {boolean}
 */
function isGlueGap(gapText, sourceLang) {
  const trimmed = gapText.trim();
  if (trimmed === '') return true; // pure whitespace

  const glueSet = GLUE_WORDS[sourceLang] || GLUE_WORDS.en;
  const tokens = trimmed.toLowerCase().split(/\s+/);
  return tokens.every(token => glueSet.has(token));
}

// ─── Exports ────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.GrammarRules = {
    GLUE_WORDS,
    MAX_GAP_CHARS,
    MIN_PHRASE_WORDS,
    CONFIDENCE_THRESHOLD,
    composePhrase,
    isGlueGap,
  };
}
