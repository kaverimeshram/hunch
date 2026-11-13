# Hunch design notes

Hunch is a prediction market for claims that nobody can settle by consensus. The interface borrows the proven market anatomy (a large chance figure, Yes and No priced in cents, a probability chart, a side trade ticket) and adds what only Hunch has: every resolution is backed by an attested arbiter quote that the Sworn registry verifies on NEAR. `web/src/style.css` implements everything below.

## Principles

1. **Price first.** Every card and claim page leads with the YES share as a large figure, with Yes and No buttons priced in cents. Every number comes from the contract or from chain history.
2. **Trust is a first-class section.** The brass seal marks everything attested. "Quote verified" and "Flipped quote refused" links sit in the home hero, in the claim header and in "How this resolves".
3. **Real history only.** The chart is a step line over actual stake transactions read from NearBlocks and reconciled to the contract's pools. Each point is a transaction with a link.
4. **Evidence stays separate from price.** Market share, source stance and the arbiter's verdict each have their own section and wording.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--paper` | `#eef1f6` | Page canvas |
| `--surface` | `#ffffff` | Cards, ticket, panels |
| `--ink` / `--body` / `--muted` | `#14171f` / `#3b4150` / `#676c78` | Text tiers |
| `--line` / `--line-soft` | `#d3d9e4` / `#e4e8f0` | Borders and rules |
| `--navy` | `#17233d` | Primary controls, resolved chip, chart line |
| `--brass` | `#7a5200` | The seal: attested badges and proof panels |
| `--yes` / `--no` | `#0b7a53` / `#b3261e` | YES and NO only: price buttons, side toggle, stake tags, trade button |

## Type

- Newsreader for claims and section headings, Schibsted Grotesk for interface text, IBM Plex Mono for every number, amount, account and hash (tabular figures).
- Scale: 11 / 12 / 14 / 15 / 20 / 24 / 38 / 76 px. The chance figure is the largest element on every page.

## Layout

- Home: proof band, totals row, status filters (Open, Awaiting resolution, Resolved, Void), three-column card grid with a stake-history sparkline per card.
- Claim: header with chance figure and stats, trade ticket pinned to the right on desktop and directly under the header on phones, chart with stake history, How this resolves, Evidence room.
- Radius 14 px for cards, 9 px for controls. Focus rings are 3 px and visible on every control. Motion respects `prefers-reduced-motion`.

## Trade ticket

Yes and No toggle with live cents, NEAR amount with quick amounts, and a preview that applies the contract's own `payout_for` math to the pools after the stake: YES share after, payout if the chosen side wins, profit. The wallet signs the transaction.
