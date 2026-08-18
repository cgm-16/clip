# Clip — Design Agent Brief

**Purpose:** Give a visual/product designer enough functional context to create a minimum coherent design system and P0 UI without reopening settled product semantics.

The design agent should append rationale/outcomes to `04_ASSIGNMENT_CUMULATIVE_SNAPSHOT.md`.

---

## 1. Product character

Clip is a **quiet archival utility**, not a social feed.

Desired qualities:

- low-noise;
- trustworthy;
- deliberate;
- lightweight;
- legible;
- operational rather than playful-gamified;
- compatible with Discord communities without visually cloning Discord.

Avoid visual language that implies:

- popularity ranking;
- surveillance/logging;
- AI magic;
- “creator economy” hype;
- enterprise admin complexity.

The product should make a small, carefully scoped service look intentional rather than unfinished.

---

## 2. Minimum design-system deliverables

Define only what P0 actually needs:

- typography scale;
- spacing scale;
- container widths;
- radius/border conventions;
- semantic color tokens (background/surface/text/muted/accent/success/warning/error);
- focus/hover/disabled states;
- button variants;
- input/select/multi-role-selection treatment;
- compact status/feedback component;
- archive clip card;
- page header/navigation treatment;
- empty/loading/error/session-expired states;
- basic responsive breakpoints/rules.

A component library such as shadcn/ui may accelerate implementation, but its defaults should be normalized into a small explicit system rather than shipped unmodified.

Do not spend time on:

- illustration library;
- complex animation;
- marketing-site art direction;
- extensive dark/light theme matrix unless trivial;
- dozens of component variants;
- full brand identity.

---

## 3. P0 web screens

### Screen A — setup link invalid/expired

Purpose: clear recovery, no dead end.

Required content:

- concise explanation that admin link expired/was used;
- instruction to run `/setup` in Discord again.

### Screen B — setup/configuration

Required fields:

- guild/server identity display;
- archive destination choice:
  - create private archive;
  - use existing channel;
- existing-channel selector when chosen;
- allowed clipping roles multi-select;
- visible note that admins always retain implicit clipping permission;
- permission explanation for automatic channel creation;
- save action;
- validation/error states.

Design goal: the admin should understand the trust consequences without reading a security document.

### Screen C — setup complete

Show:

- archive channel;
- configured roles;
- one-line usage instruction: right-click message -> Apps -> Clip;
- link to read-only archive;
- if automatic creation used: note that `Manage Channels` is no longer required for ordinary operation.

### Screen D — archive list

Required:

- newest-first list;
- source-channel filter;
- pagination;
- archive card with:
  - author;
  - source channel;
  - original timestamp;
  - clipped timestamp;
  - forwarded/snapshot content;
  - reply provenance if present;
  - `Open original` / `Original unavailable`;
- loading state while Discord content is fetched;
- missing archive-message state if Discord-side content was manually removed.

This is read-only for clip content.

### Screen E — current config / destructive data action

May be combined with setup screen if implementation wants one admin page.

Required:

- current archive destination;
- allowed roles;
- `Delete Clip data` destructive action;
- explicit copy that deleting Clip data does not delete the Discord archive channel/messages.

---

## 4. Discord-side interaction copy

Keep responses extremely small.

Suggested copy:

- `✓ Clipped`
- `Already clipped`
- `✓ Unclipped`
- `You haven't clipped this message.`
- `You don't have permission to clip messages in this server.`
- `This message can't be clipped.`
- `Couldn't clip this message. Try again.`

Do not expose state-machine jargon such as canonical clip, clipper row, PENDING, tombstone, etc.

### Author DM

Tone should be informational, not alarming:

> A message you posted in **Server / #channel** was added to this server's Clip archive.

Actions:

- View original
- Remove from archive

Do not make “who clipped you” the focus unless later research shows that attribution is socially valuable.

---

## 5. Status marker

P0 source-message marker uses a bot-owned reaction (working symbol `📎`).

Design semantics:

> Marker presence from the bot means an archive exists.

Visible reaction count is **not** a popularity score. Users may add the same reaction; P0 ignores them.

Do not display reaction count in the web archive as a preservation/popularity metric.

---

## 6. Trust copy to surface in UI

Short statements worth considering:

- `Archived messages stay in your Discord server.`
- `Clip stores operational metadata, not copies of your message content.`
- `Admins always retain clipping access.`
- `Messages are archived as snapshots; authors can remove their archived messages.`

Do not overpromise “we store no user data.” The application stores Discord IDs, role configuration, preservation signals and operational metadata.

---

## 7. Visual hierarchy priorities

1. Source/author/context — what am I looking at?
2. Message content — the preserved thing.
3. Provenance — where/when did it come from?
4. Archive metadata — when was it clipped?
5. Controls — minimal because P0 archive is read-only.

The archive should not look like a social-media feed competing for attention.

---

## 8. Responsive requirements

Minimum:

- setup usable on mobile width;
- archive cards readable without horizontal scroll;
- long code/message text wraps sensibly;
- attachment/media previews do not overflow;
- channel filter/pagination remain usable at narrow widths.

No P0 requirement for native-mobile navigation patterns.

---

## 9. Accessibility minimum

- visible focus states;
- semantic labels for form controls;
- keyboard-usable setup form;
- sufficient contrast;
- status communicated by text, not color alone;
- destructive action confirmation with explicit consequence copy;
- loading/error states announced appropriately if implementation supports it.

---

## 10. Design decisions to append to cumulative snapshot

Record:

- visual direction considered and why chosen;
- component library/design-system choice;
- any rejected navigation/layout pattern;
- any product-scope issue discovered through design;
- any misleading copy corrected;
- accessibility issue found and resolved;
- screenshots/recordings used in final presentation;
- what remains intentionally unpolished due to deadline.

Do not claim future/P1 screens as implemented.
