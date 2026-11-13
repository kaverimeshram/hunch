# Hunch design notes

Hunch is a prediction market you play by swiping. Every claim has two outcomes, so the primary screen is one claim card at a time: right is YES, left is NO, up skips. `web/src/style.css` implements everything below.

## Principles

1. **One decision per screen.** The deck shows a single claim, its live YES share as the largest figure, a thin YES/NO bar and the NEAR staked. Nothing competes with the card.
2. **The swipe is the stake.** A swipe on an open market opens a bottom sheet with the amount, a payout preview from the contract's own `payout_for` math and one button that signs the transaction.
3. **Trust is a seal on the card.** The brass seal opens the Sworn proof: "Quote verified" and "Flipped quote refused" link to the transactions on NearBlocks.
4. **Evidence one tap away.** Tapping a card flips to the claim room: odds, stake history drawn from real transactions, how it resolves and the evidence room grouped by stance.
5. **Every number is read from the chain.** The deck loads from the contract alone; stake history is fetched only in the claim room and cached.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--felt` | `#14120f` | The table: page background |
| `--paper` / `--paper-hi` | `#efe7d4` / `#f7f1e2` | Claim cards, sheet, claim room |
| `--ink` / `--body` / `--muted` | `#1a1712` / `#463f31` / `#766d5a` | Text tiers on paper |
| `--felt-text` / `--felt-mute` | `#efe7d4` / `#9b927e` | Text on the table |
| `--brass` / `--brass-bg` | `#7d5f17` / `#ecdcab` | The seal and every attested surface |
| `--yes` / `--no` | `#12804c` / `#bf3a2e` | YES and NO only: stamps, bar, side tags, stake button |
| `--yes-hi` / `--no-hi` | `#2fbf7a` / `#f0675b` | The same two sides on the dark table |

## Type

- Gloock for claims and the percentage, Bricolage Grotesque for interface text, JetBrains Mono for numbers, accounts and hashes.
- The percentage scales with the card height through container query units, so the figure stays the largest element from a 390 px phone to a 1440 px desktop.

## Interaction

- Pointer events drive the drag, so mouse and touch behave the same. The card tilts up to 16 degrees, a YES or NO stamp fades in with the drag distance, and the card flies off past 28% of its width. Up skips.
- Arrow keys swipe, Enter opens the claim room, Escape closes the sheet or the room. With reduced motion the card does not fly and the buttons act directly.
- Closed or awaiting markets accept a swipe as an opinion and open the claim room at the evidence.
- When the stack is empty the screen lists each swipe with its status.

## Layout

- Phone: header (wordmark, NEAR testnet badge, wallet), the card, four controls (No, Skip, Details, Yes).
- Desktop: the same stack centred at 440 px with two cards fanned behind it, "No" and "Yes" cues on either side and a key legend under the controls.
- Radius 24 px for cards, 16 px for the sheet controls, pills for chips and the wallet button. Focus rings are 3 px and visible on every control.
