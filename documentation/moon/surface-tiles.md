# Moon surface color tiles

The moon's color texture is rendered from a Hapke photometrically normalized
mosaic — every pixel is rendered as if lit at `i=60deg, e=0deg, g=60deg`, so
no shadows are baked into the imagery. All visible illumination on the moon
in the running app comes from our own shader, using the live sun direction
and the displaced topography.

## Source

- **Dataset**: NASA SVS "CGI Moon Kit" 16K color TIFF, derived from the
  LROC team's Hapke-normalized WAC mosaic with polar caps filled by LDAM
  albedo.
- **URL**: <https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_16bit_srgb_16k.tif>
- **Size**: 909 MB, 16384 x 8192, 16-bit sRGB, equirectangular.
- **License**: NASA public domain.

A full-resolution variant (`lroc_color_16bit_srgb.tif`, 27360x13680, ~2.6 GB)
is available from the same directory. Using it would enable L6 tiles at
~1.2x upscale (vs 2x from 16K). Not currently in use because L5 already
exceeds LOLA DEM resolution on Trek's WMTS — the shading has no bump detail
above ~660 m/px. Swap if you ever upgrade the DEM source too.

## Tile pyramid

Sliced into 6 levels (0..5) of 256x256 JPEGs at
`client/public/moon-tiles/{level}/{y}/{x}.jpg`. Convention matches
`SlippyMapGlobe` equirectangular: `gx = 2 * 2^L` columns, `gy = 2^L` rows,
NW pixel origin. Level 5 (~760 m/px) reaches source-native resolution;
going higher would only upsample.

Total output: 2730 tiles, ~55 MB.

## Storage: Git LFS

Tiles are committed to the repo via git LFS (see `.gitattributes`). This
keeps the tiles versioned alongside the code that expects their URLs, while
LFS stores the binary blobs out-of-band so normal git pack size stays small.
Regenerating the pyramid produces identical bytes for unchanged regions,
which LFS deduplicates by content hash — repeated regens don't bloat repo
history.

First-time clone requires LFS:

```sh
brew install git-lfs   # or equivalent for your OS
git lfs install        # one-time, globally
git clone <repo>       # LFS fetch happens automatically
```

Cloudflare Pages pulls LFS blobs automatically during deploy.

## Regeneration

Only needed when bumping the source (e.g. swapping to the full-res TIFF) or
changing slicer parameters. Tiles do not auto-build on `dev` or `build` —
they're already in the repo.

```sh
rm -rf client/public/moon-tiles         # clear old output
npm --prefix client run build:moon-tiles
git add client/public/moon-tiles
git commit -m "Regenerate moon tiles (<reason>)"
```

The slicer writes `public/moon-tiles/.complete` on success. That file is
gitignored — it's dev-machine state, not repo content.

## Why local, not WMTS

No public WMTS exists for any Hapke-normalized lunar mosaic. Trek's
`LRO_WAC_Mosaic_Global_303ppd_v02` has solar illumination baked in,
which conflicts with the live sun-direction shading we apply over the
displaced surface (doubled shadows). The SVS CGI Moon Kit is the
most accessible packaging of an illumination-removed albedo map.
