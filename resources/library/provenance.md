# Bundled library assets

The ten city disaster-prevention SVG icons originate from the project owner's previously authorized icon set. The canonical, MIT-licensed SVG files are in `icon-pack/`; the application copies them byte for byte to `resources/library/icons/`. Source and bundled SHA-256 hashes are recorded in `hashes.json`.

The three reference images reuse the application's existing `resources/references` files and stable IDs: `pastel-method`, `algorithm-flow`, and `voltage-control`. The large reference images are not duplicated here.

The PNG files in `thumbs` are 400 × 320 transparent previews rendered locally with Electron. The library retains the original SVG/PNG as the asset; previews are never substituted for the originals.

Rebuild with `node scripts/prepare-library-assets.mjs`.
