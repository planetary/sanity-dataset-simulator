# Meridian — a sanity-sim demo

A Next.js 16 site with an embedded Studio (`/studio`) for a fictional outdoor magazine and shop. It exists to exercise [sanity-sim](../../packages/sanity-sim) against as much of Sanity as one project reasonably can.

```bash
pnpm install --ignore-workspace
node ../../packages/sanity-sim/bin/sanity-sim.js --seed seed.tar.gz
```

Then open the site at http://localhost:3000, the Studio at http://localhost:3000/studio, and the simulator's dashboard at http://localhost:3939. `npx sanity-sim eject` removes the simulator's edits from `sanity.config.ts` and `src/sanity/client.ts`.

## What it covers

**Field types.** string (plain, radio, dropdown), text, number (precision, integer, ranges), boolean, date, datetime, url, email, slug, image (hotspot, crop, custom fields, metadata), file, geopoint, reference (single, multi-type, filtered, weak), arrays of strings (tags), objects, references and mixed types, nested objects with fieldsets and columns, field groups, conditional `hidden`, validation (errors and warnings), initial values, plus `code`, `color` and `table` from the official plugins, and `sanity.video` through Media Library.

**Structure.** A recursive navigation menu, a page builder with ten section types, nested arrays (event days → sessions, FAQ groups → items), a self-referencing category tree, localized fields, a settings singleton, a live-edited announcement, and rich text with every portable text feature: styles, nested lists, decorators, external and internal links, footnote annotations, inline product mentions, and figure, callout, code, table and video blocks.

**Document states.** Published documents, a draft over a published document, a draft-only article, and a scheduled release ("Autumn issue") with a new article in it.

**Studio.** A custom desk structure (singletons pinned, articles by category and by author, upcoming and past events), Presentation with routes and locations for every type, Vision, Media Library, and singleton-only document actions.

**Site.** Every type has a page; links resolve through references; images honor hotspot and crop; draft mode, `<SanityLive>` and `<VisualEditing>` drive Presentation; one list is fetched in the browser to show the client-side path too.

## Recording the demo video

With the demo running on its default ports, `node scripts/record-demo.mjs demo.webm` records a captioned tour (about four minutes) of the dashboard, the site, the Studio, Presentation, a dataset hot swap, Media Library and Vision, with Playwright. It creates the `winter-preview` dataset it swaps to if it is missing, and puts the data it edits back afterwards. `ffmpeg -i demo.webm -c:v libx264 -crf 18 -pix_fmt yuv420p demo.mp4` makes an MP4.

## The seed

`seed.tar.gz` is a `sanity dataset export`-style tarball built by `scripts/build-seed.mjs` (edit the content there and run it again). Photos come from [Picsum](https://picsum.photos) ([Unsplash License](https://unsplash.com/license)); the embedded video is *Big Buck Bunny* by the Blender Foundation (CC BY 3.0).
