# DOCTRINE

Standing rules. Every phase, every feature, forever. A change that needs an
exception to one of these needs a rewrite instead.

1. **Sanitize at ingestion, no path exceptions.** ALL text entering a session
   card or leaving through any CLI or board surface - ring buffers, transcript
   turns, session titles, model output, message payloads, whatever comes next -
   passes through the shared control/ANSI/OSC sanitizer (`protocol.sanitizeText`)
   at the point of ingestion. Any new data source or output path must cite this
   rule in its commit message and add a test proving hostile input is stripped.
   This bug class was caught twice in adversarial review; it dies here.

2. **Mechanical truth is never displaced.** Status, exit codes, timers, and raw
   tail lines remain visible regardless of any AI-derived layer. Summaries and
   messages are annotations on top of the mechanics, never replacements and
   never inputs to status derivation.

3. **Dumb by default, smart by key.** No feature may require an API key to keep
   v1-era behavior working. Keyless tower is a complete product.

4. **The attention band must stay trustworthy.** Nothing lands in NEEDS YOU
   unless a reasonable user would want to act on it. Both directions matter:
   noise erodes the band, but a missed real failure is worse than occasional
   noise - genuine ambiguity errs toward attention.

5. **Scope creep goes to IDEAS.md**, not into the current branch.
