# Hunch design notes

Hunch is a research surface for disputed claims, not a trading screen. The design exists to make evidence, market sentiment and the AI verdict easy to read and hard to confuse with each other. These notes describe what `web/src/style.css` implements today.

## Principles

1. **Evidence first.** Every fact page leads with the claim and a one-line evidence summary before the market. The Evidence Room is a full section, not a footnote.
2. **Keep the three signals apart.** Market sentiment ("26.1% staked on YES"), source classification (Supporting, Contradicting, Context, Unclassified) and the AI verdict each have their own section and wording. Odds are never called a probability; a stance never implies truth.
3. **Honest labels.** Unknown data is shown as unknown ("Not recorded", "Not reviewed"). Nothing is labelled "verified". Attestation copy always says what it proves (authenticity) and what it does not (correctness).
4. **Quiet and readable.** White canvas, one accent colour, thin rules instead of cards where possible. No gradients, no decorative illustrations, no colourful AI visuals.

## Colour tokens

| Token | Value | Use |
|---|---|---|
| `--color-ink` | `#0a0b0d` | Headings and primary text |
| `--color-body` | `#5b616e` | Body copy |
| `--color-muted` | `#7c828a` | Labels, metadata, help text |
| `--color-line` | `#dee1e6` | Section rules, borders |
| `--color-line-soft` | `#eef0f3` | Rules between list items |
| `--color-canvas` | `#ffffff` | Page background |
| `--color-soft` | `#f7f7f7` | Forms and highlighted panels |
| `--color-primary` | `#0052ff` | The single accent: primary buttons, links, focus ring |
| `--color-up` / `--color-down` | `#05b169` / `#cf202f` | YES / NO pool bars only; `down` also marks errors and rejected sources |

Green and red are reserved for the YES/NO split. They are never used to mean "true" or "false", and never as button backgrounds.

## Type

- System sans-serif for display and body; system monospace for numbers, amounts, account IDs, hashes and small labels.
- Display headings are large with tight tracking and moderate weight; body copy is 14 to 16 px with a 1.6 line height.
- All amounts and percentages use tabular figures.

## Layout and components

- Content column of 760 px for fact pages; 1184 px maximum page width. Phones get a 16 px side gutter and single-column layouts.
- Radius 4 px everywhere. One subtle shadow, on the market frame only.
- Buttons: solid primary blue for the main action; white outlined "secondary" buttons for wallet and lesser actions. Minimum touch height 36 to 44 px.
- Status and review badges are outlined, monochrome text, never filled colour blocks.

## Content rules

- Market heading: "N% staked on YES", or "No stakes yet".
- Evidence copy: "classified as supporting", "Submitter's note", "Not reviewed", "Reviewed" (with reviewer), "Rejected".
- Resolution: "Claim judged true / false", "Insufficient evidence", "Void · stakes refundable".
- Any AI-written text that is not attested is labelled "not attested".
