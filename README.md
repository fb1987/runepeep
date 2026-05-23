# Rune Peep

Rune Peep is a mobile-first Diablo II: Resurrected companion that reads a rune stash tab photo and lists runewords the player can make.

## Current Flow

- Align the dedicated rune tab to the 9 x 5 grid.
- Tap `Peep`, or use `Photo` on local HTTP/mobile browsers.
- Rune identity is fixed by the tab's real slot layout from El through Zod, including the unused high-rune holes.
- Browser image processing finds the rune slot lattice, then OCR reads stack counts from the bottom-right number area only.
- Low-confidence reads can be corrected with the rune count steppers.
- Results show runeword name, rune recipe, compatible item types, craft count, and a details link.

## Data Source

Runeword data is generated from the D2R 3.0 JSON files in [blizzhackers/d2data](https://github.com/blizzhackers/d2data), which are extracted from the game data files. Regenerate with:

```bash
npm run data:generate
```

## Local Development

```bash
npm install
npm run dev
```

Vite prints a `Network` URL for phone testing. Live camera streams require HTTPS in normal mobile browsers, so the app always keeps a native `Photo` capture path available for local network testing.
