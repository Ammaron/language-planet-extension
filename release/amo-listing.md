# AMO listing copy — Langsly Vocab Pass 0.2.0

## Summary

Learn from the websites you already read. Langsly Vocab Pass highlights words and phrases from your synchronized Langsly vocabulary, provides contextual meaning and audio, and records trusted learning interactions.

## Description

Vocab Pass connects to your Langsly account through a short-lived device code. Once connected, it synchronizes your vocabulary, difficulty, and theme, then highlights learned terms on supported websites. Tap a highlight for translation, phrase meaning, contextual disambiguation, audio, and feedback controls. Site controls let you pause or block Vocab Pass, and an offline cache preserves recently synchronized vocabulary.

Vocab Pass automatically avoids browser-internal and Langsly pages, pages with password fields, and baseline authentication, banking, payment, government, health, and legal pages. Those baseline protections cannot be disabled.

Automatic processing may send the current domain, matched phrases, or a short bounded piece of visible sentence context to Langsly and, when translation or disambiguation needs it, OpenRouter. Vocab Pass does not send complete pages, form values, hidden text, or full URLs. See Langsly's privacy policy before connecting.

## Compatibility

- Firefox Desktop 140.0 or later
- Firefox for Android 142.0 or later
- One add-on ID: `vocabpass@languageplanet.app`

## Release notes

First public Firefox release. Adds desktop/Android parity, device-code account connection, automatic phrase and contextual disambiguation, audio fallback, themes, difficulty controls, per-site controls, encounter tracking, offline synchronization, mobile layouts, and hardened sensitive-page protections.

## Required AMO data declarations

- `authenticationInfo`: short-lived device authorization and Langsly account tokens.
- `browsingActivity`: the current hostname and site-block state used for activation controls and abuse limits.
- `websiteActivity`: trusted taps and automatic highlight exposures used for learning analytics.
- `websiteContent`: matched phrases or bounded visible sentence context used for translation and disambiguation.

The extension does not sell data. The privacy policy must name Langsly and OpenRouter as applicable recipients and describe automatic processing before submission.
