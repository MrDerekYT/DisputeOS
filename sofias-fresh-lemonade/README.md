# Sofia's Fresh Lemonade

A one-page site for Sofia's Fresh Lemonade, the family-owned stand from Miami-Dade
(a mom and her daughters). Its job is to get people who run markets, school events
and parties to book the stand, and to show the story and flavors on the way.

This folder is self-contained. It does not use or depend on anything else in the
repository it lives in.

## What's here

| File | What it is |
| --- | --- |
| `index.html` | All the words, links and structure |
| `css/styles.css` | The look: colors, lettering, layout, motion |
| `js/main.js` | Flavor cup, booking message builder, video loading |
| `media/` | Photos, clips and the logo |
| `fonts/` | Sansita Swashed and Figtree, with their licenses |
| `vercel.json` | Hosting settings (clean URLs, caching) |

There is no build step. Open `index.html` through any static server and it runs:

```
npx serve .
```

## Changing things

- **Phone number**: search for `7542099503` and `754-209-9503` in `index.html`, and
  `PHONE` at the top of `js/main.js`.
- **Sizes and prices**: left off the page on purpose. Their own flyer and banner
  artwork in the photos and clips still shows the cup sizes.
- **Flavors**: each flavor is one line in the "Choose your flavor" list in
  `index.html`. `data-liquid` and `data-deep` are the drink colors, `data-straw` is
  the straw, `data-note` is the short description. Add, remove or reorder lines freely.
- **Event types**: the checklist under "Perfect for any event".
- **Instagram / TikTok links**: search for `sofias_fresh_lemonade` and
  `sofiasfreshlemonade`.
- **Web address**: if the site moves to its own domain, update the four
  `https://sofias-fresh-lemonade.vercel.app` addresses near the top of `index.html`.

## Where the content came from

Everything on the page comes from the business's own public posts and flyers
(Instagram `@sofias_fresh_lemonade`), plus a family photo supplied for the site:

- The story quote is the caption from their "Our story" post, word for word.
- Flavors, event types, the delivery line and the booking number are taken from
  their menu banner and flyers.
- Clips were trimmed, muted and compressed for the web. Photos were cropped and
  resized. The logo was enlarged from the profile picture.

Nothing here claims a license, permit, award or review. If any of that should be
on the site, add it with the real details.

## Hosting

Live at https://sofias-fresh-lemonade.vercel.app as the Vercel project
`sofias-fresh-lemonade`. The project is standalone: it is not connected to a Git
repository, so pushing here does not change the live site. To publish a change,
deploy this folder again (for example `vercel deploy --prod` from inside it).
`README.md` is left out of the upload.

## Credits

Typefaces: [Sansita Swashed](https://fonts.google.com/specimen/Sansita+Swashed) by
Omnibus-Type and [Figtree](https://fonts.google.com/specimen/Figtree) by Erik Kennedy,
both under the SIL Open Font License (see `fonts/`).
