# Review: dashboard expand/copy inline script (FEAT-410 follow-up)

**Reviewer:** independent adversarial review (security + correctness)
**Scope:** src/server/routes/dashboard-html.ts, src/server/routes/dashboard.ts (header comment only), tests/server/dashboard-html.test.ts, tests/server/dashboard.test.ts
**Verdict: PASS**

## Summary

This introduces the first `<script>` into a previously zero-JS dashboard: each
INFO cell in the Recent activity/errors feed becomes a `<details>` disclosure
(`renderExpandable()`, dashboard-html.ts:337-344) showing an escaped preview
and an escaped full-text `<pre>`, plus a `copy` button. A single static,
delegated `<script>` block (`COPY_SCRIPT`, dashboard-html.ts:406-420) reads
`.textContent` off the sibling `<pre>` at click time and calls
`navigator.clipboard.writeText()`. Memory/error text is attacker-influenced
(ingested transcript content) and is the right thing to have scrutinized hard.

## 1. XSS — verified safe

Traced every place `job.last_error` / `mem.text` reach the template:
- `renderExpandable()` (dashboard-html.ts:337-344): `preview = esc(truncate(fullText, 90))`, `full = esc(fullText)`. Both land purely as **element text content** (`<summary class="trunc">${preview}</summary>`, `<pre class="full-text">${full}</pre>`) — never inside an attribute value, an inline event handler, a `javascript:` URL, or the `<script>` body.
- `esc()` (dashboard-html.ts:29-35) escapes `&`, `<`, `>`, `"` in the correct order (`&` first, preventing double-escape bypass). For a text-node context that's sufficient — `'` doesn't need escaping there, and I confirmed no single-quoted attribute anywhere in this file carries dynamic data (every attribute in the template is double-quoted and static, e.g. `class="trunc"`, `type="button"`).
- Truncation happens on the **raw** string before `esc()` is applied (`esc(truncate(fullText, INFO_PREVIEW_MAX))`), so truncation can't split an entity in half. (It can split a UTF-16 surrogate pair, but that's a cosmetic replacement-glyph issue, not a security one.)
- Tried the requested breakout payloads mentally and via the test suite's own adversarial case (`a <script>alert("x")</script> & \`backtick\` "quoted" text`, tests/server/dashboard-html.test.ts:199-217): `</pre>`, `</summary>`, `</details>`, `"><img src=x onerror=...>`, backticks, `${...}`, and pre-encoded entities (`&lt;script&gt;`) all get neutralized — `<`/`>` become `&lt;`/`&gt;` (blocking every tag-breakout attempt) and pre-existing `&`-based entity syntax gets double-escaped into inert literal text, not decoded twice.
- `COPY_SCRIPT` is a **static template literal** with zero interpolation of any per-row data — confirmed by reading dashboard-html.ts:406-420 and by the test at tests/server/dashboard-html.test.ts:232-247, which asserts the script body never contains the memory text strings.

No path allows breakout. This is the correct, minimal-surface way to add clipboard support to an otherwise-static page.

## 2. Script integrity — verified

- No external `src`, no `eval`/`Function`, no per-row inline `onclick=` — confirmed by direct read and by the test's negative assertions (tests/server/dashboard-html.test.ts:173-175).
- Delegated listener uses `e.target.closest('.copy-btn')` then `btn.previousElementSibling`. Because memory text can only ever appear as escaped text content (never as parsed markup), attacker text can never produce a real DOM element with `class="copy-btn"` — it can only *visually resemble* one as inert text. `closest()` cannot be tricked into matching text that was never parsed into an element. Safe.

## 3. Zero-JS assertion pinning — mostly solid, one minor gap (LOW, non-blocking)

`tests/server/dashboard-html.test.ts:164-178` and `tests/server/dashboard.test.ts:113-119` assert `html.match(/<script>/g).length === 1`, no `src=`, no `onclick=`, no `eval(`, no `https?://`. This correctly fails if someone adds a second **attribute-free** `<script>` tag or an external-`src` script.

**Gap:** the count regex `/<script>/g` requires an exact zero-attribute tag. A future addition like `<script nonce="x">...</script>` or `<script type="text/javascript">...</script>` would not increment the match count (silently staying at 1) and isn't caught by the other assertions either, since those only check for `src=`/`onclick=`/`eval(`/bare URLs, not "any second script tag with attributes." This is a test-robustness note, not an exploitable issue in the current diff — flagging so it doesn't quietly rot if a nonce-based CSP script gets added later. Non-blocking.

## 4. Clipboard API availability — mostly graceful, one real edge case (LOW, non-blocking)

`127.0.0.1`/`localhost` are treated as secure contexts by all mainstream browsers, so `navigator.clipboard` is present in the realistic deployment target. However, reading dashboard-html.ts:412 literally:

```js
navigator.clipboard.writeText(pre.textContent).then(...).catch(function () {
  btn.textContent = 'copy failed';
});
```

If `navigator.clipboard` is `undefined` (older browser, Clipboard API disabled via permissions policy, non-secure-context edge case, etc.), `navigator.clipboard.writeText` throws a **synchronous** `TypeError` before any Promise exists — `.catch()` never runs because it was never attached. The click handler throws uncaught; the button doesn't flip to "copy failed" and the rest of the page keeps working (other delegated clicks are unaffected since `addEventListener` isolates listener exceptions), but this specific interaction fails silently apart from a console error. Recommend (not blocking): guard with `if (!navigator.clipboard) { btn.textContent = 'copy failed'; return; }` before the call. Real-world impact is low given the deployment target, but the code comments imply full graceful degradation and this one branch doesn't quite deliver it.

## 5. Correctness — verified

- Full untruncated text reaches the DOM unconditionally (it's always rendered inside `<pre class="full-text">`; only CSS/`<details>` state hides it), satisfying the operator's original ask. Verified via tests/server/dashboard-html.test.ts:183-197 and by reading the CSS: `details[open]>summary` removes the `max-width`/`nowrap` clamp, and `.full-text{max-height:240px;overflow:auto}` gives the full block an internal scrollbar rather than growing the page.
- Long single-word blobs: `.full-text` has both `white-space:pre-wrap` and `word-break:break-word`, so an unbroken long token wraps inside the 640px-max-width wrapper instead of overflowing. No layout break expected.
- `.trunc{max-width:460px}` truncation width matches the request; confirmed by test at tests/server/dashboard-html.test.ts:249-252.

## 6. Real command output

```
bunx tsc --noEmit -p .          -> clean, no output, exit 0
bunx vitest run <6 dashboard suites> -> Test Files 6 passed (6) | Tests 80 passed (80)
```//
(dashboard-consolidation-html.test.ts, dashboard-html.test.ts, dashboard-jobs.test.ts, dashboard-search-html.test.ts, dashboard-subpages.test.ts, dashboard.test.ts — matches the builder's claimed 6 files / 80 tests.)

## Verdict

**PASS.** No XSS or script-integrity issue found; the "never embed memory text into the script" design holds up under adversarial reading of every interpolation site. Two LOW, non-blocking notes left for optional follow-up: (1) tighten the "exactly one script" test to also reject a second script tag that carries attributes, (2) guard `navigator.clipboard` being `undefined` so the `.catch()` path is actually reachable in that edge case.
