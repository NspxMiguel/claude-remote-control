# Design brief

Paste everything below the line into Claude (or any design tool). It is written
to be self-contained: it describes the product, the constraints, every screen,
and what specifically needs to get better.

---

I need you to redesign the interface of a real, working app. Give me concrete
CSS and HTML I can drop in, not mood boards or vague direction.

## What the app is

**Claude Remote Control** — a small daemon runs on my Mac and drives my coding
agent (Claude Code, Cursor or Google Antigravity). A PWA on my phone is the
interface. I chat with the agent, watch what it does to my files, and approve or
deny each dangerous action, from anywhere on my tailnet.

The closest reference is the Claude Code desktop app's transcript: narration
from the agent, interleaved with compact grey rows summarising runs of tool
calls, which expand to show the individual commands and their output.

## Hard constraints — a design that breaks these is unusable to me

- **No build step, no framework.** Vanilla HTML, CSS and ES modules served
  straight off disk. No Tailwind, no React, no npm packages, no CSS-in-JS. Plain
  `.css` with custom properties.
- **No external requests.** No Google Fonts, no CDN, no remote images. It runs
  on a LAN with no internet guarantee. System font stack only.
- **No emoji and no icon fonts.** Every icon is an inline SVG. I already have a
  small set; add to it in the same style (24×24 viewBox, `currentColor`,
  1.8 stroke, round caps).
- **Mobile first**, one-handed, thumb reachable. It also has to scale up to a
  desktop panel with a sidebar past 900px.
- **Dark and light**, both first class, driven by `prefers-color-scheme` plus
  `[data-theme]` overrides.
- **Safe areas** on iOS (notch and home indicator) via `env(safe-area-inset-*)`,
  and `100dvh` — the on-screen keyboard must never cover the composer.
- **The accent colour is dynamic.** It follows the agent in the current session:
  Claude orange `#e0855f`, Antigravity blue `#7aa5f0`, Cursor purple `#b98ce6`,
  set on `.app[data-agent="…"]`. Everything accented must derive from
  `var(--accent)` — never hard-code those hexes anywhere else.

## The current palette (dark)

```
--bg #0f0f10   --bg-raise #17171a   --bg-sunken #0a0a0b
--surface #1c1c20   --surface-hi #24242a
--border #2c2c33   --border-soft #232329
--text #ececf0   --text-dim #a1a1ad   --text-faint #6f6f7b
--accent #e0855f (dynamic)   --ok #6fbf8b   --warn #e0b95f
--danger #e0685f   --thinking #9a8ce0
```

Keep the neutral, near-black character. I do not want a colourful app; I want a
quiet one where the accent and the state colours carry all the meaning.

## Every screen, and what is on it

**1. Pairing gate** — first run. Logo, title, one input for a 6-digit code or a
token, a device-name field, one primary button. Currently a plain card; it is
the first thing anyone sees and deserves to look deliberate.

**2. Chat (the main screen)**

- Top bar: menu button, session title, working directory and agent name as a
  subtitle, an overflow button.
- The transcript, which contains:
  - my messages as accent-coloured bubbles, right aligned, with image previews
    above the text when I attached something
  - the agent's prose, rendered markdown: paragraphs, lists, headings,
    blockquotes, inline code and fenced code blocks with a copy button
  - collapsed "thinking" blocks
  - **runs of tool calls collapsed into one row** — this is the most important
    element in the app. It reads like
    `> Edited 3 files, ran grep -n    +24 −3    (4)`
    and expands into individual cards, each with an icon, a title, a mono
    subtitle, a status, and its own expandable body showing the command, a diff
    or the output. Nested content needs a clear but quiet hierarchy.
  - system notices (pill shaped, centred) and result rows (`2.4s · $0.0012 · 1 turn`)
  - error boxes with a title, an explanation and a hint. These have kinds:
    `quota`, `billing`, `rate`, `context` read as warnings; `auth` is tinted
    toward the accent; everything else is a real error.
- Composer: attach button, auto-growing textarea, send button that becomes a
  stop button while the agent works, staged image thumbnails above it, and a
  meta line (`Claude is working…` with a spinner, or the session cost).

**3. Permission sheet** — a bottom sheet that interrupts you. Badge, tool title,
subtitle, the exact command or diff in a scrollable code block, and three
actions: Allow once (primary), Always allow, Deny. Also renders a full markdown
plan when the agent asks to approve one. This has to be readable and decidable
in about two seconds, one-handed, possibly at night.

**4. New session sheet** — agent picker with a note about that agent's
limitations, a directory browser, model and permission-mode selects, and a
start button.

**5. Settings sheet** — the longest screen, currently the ugliest, and the one I
most want fixed. It stacks: host setup rows (Homebrew, Tailscale, agent
sign-in — each with a status dot, a state string and either a fix button or a
copyable command), a keep-the-Mac-awake toggle, project-folder chips, the list
of addresses the daemon answers on, paired devices with revoke links, per-agent
sign-in cards with a key field, and pairing controls. It badly needs grouping,
rhythm and hierarchy — right now it is one long undifferentiated column.

**6. Sign-in sheet** — a link to open, a code field, a confirm button.

**7. Session drawer** — off-canvas on mobile, fixed sidebar on desktop. "New
session" button, live sessions and mirrored desktop sessions as two groups, each
row with a status dot, title, metadata line and origin tag.

## What I want from you

1. A refined `styles.css` — the same custom-property architecture, better type
   scale, spacing rhythm, depth and states. Include `:focus-visible` throughout;
   it currently has none.
2. Any markup changes needed, as exact before/after snippets.
3. New SVG icons in the existing style if the design calls for them.
4. Motion: what animates, how long, easing. Everything must respect
   `prefers-reduced-motion`.
5. A short rationale — what you changed and why. I care about the reasoning.

Priorities, in order: **the tool-run rows and their expanded cards**, then
**Settings**, then the **permission sheet**, then everything else.

Do not add features, rename things, or restructure the JavaScript. This is a
visual and interaction pass over an app that already works.

## Reference

The full source is at https://github.com/NspxMiguel/claude-remote-control —
`web/styles.css`, `web/index.html`, `web/feed-view.js` and `web/icons.js` are
the files in question. A screenshot of the current state is in
`docs/screenshot-ios.png`.
