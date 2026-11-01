# Civitai Media Analytics Overlay

Install [civitai_media_analytics.user.js](../civitai_media_analytics.user.js) in
Tampermonkey or Violentmonkey. Allow its request permission for
`creator-studio.civitai.com`, then reload Civitai. The script runs on
`civitai.com`, `civitai.red`, and `civitai.green`.

- Hover the graph button at the **bottom center** of an image or video to
  show its analytics over the media. Move away from the button and hover it again
  to hide the panel. Moving away from the media keeps the panel open.
- The panel stacks **Views over time**, **Reactions over time**, and
  **Feed impressions over time** vertically, with all three shown together.
  Small media cards allow scrolling when needed. Move the pointer across any
  graph to highlight the same date on all three graphs, with a vertical reference
  line and highlighted points. Each graph has a large-number column on its left:
  the month's total on top, with the hovered date and daily count below. The
  column fits its text with zero spacing before the chart. The
  daily count shows a dash until you hover a date. Missing values
  show “No data”; zero counts show zero. Moving out of the graphs clears the
  markers. These are daily counts, not cumulative counts.
- The selected month is saved and shared across every overlay, browser tab, and
  supported Civitai domain using the same userscript installation. Changing it
  anywhere immediately updates all month fields and reloads all open graphs.
  Closed panels and newly loaded media use that month when opened. It survives
  page reloads and browser restarts; the initial default is the current month.
- Click or tap the graph button to toggle without hover. With a mouse, entering
  the button already toggles it; clicking immediately afterward keeps that state.
  Tab to the button and press Enter or Space for keyboard use. Escape closes it.
- **↻** refreshes the data; **Studio ↗** opens that media's analytics for the
  selected month in a new tab.

Gallery cards, model carousels, linked post media, direct image/video viewers,
and viewers using an `imageId` query parameter are handled. The script follows
newly loaded and recycled cards without relying on Civitai's changing CSS module
names. It uses numeric media IDs from image/video links, `data-image-id`, or the
active viewer URL; it does not guess numeric IDs from CDN filenames. Avatars are
excluded. Videos use the same Creator Studio `/analytics/content/image/ID` route
as still images, as in the supplied saved pages.

The graphs use the actual daily series embedded in Creator Studio's HTML.
Analytics availability depends on the signed-in account and Creator Studio's
access rules. Other creators' private analytics cannot be displayed. If a panel
reports an access or sign-in error, use **Studio ↗**, sign in to the account that
owns the media, then refresh the overlay. Depending on browser and userscript
manager cookie restrictions, cross-domain requests may require an active Studio
session. Missing data is shown as unavailable rather than invented zero counts.

Requests run when opening a panel, refreshing it, or changing the shared month
while that panel is open. The
script shares in-progress requests and caches successful results in memory for
two minutes, up to 100 completed media/month results. Only the month preference
is saved persistently. It does not store tokens
or analytic history, download chart libraries, or run JavaScript from Studio's
response. If Studio changes its embedded data format, the parser may need an
update.

Browser verification:

```bash
node --check civitai_media_analytics.user.js
node tests/test_civitai_media_analytics.cjs
```

The integration test needs Node.js and Google Chrome (`CHROME=/path/to/chrome`
can override the executable). It runs a local fixture server, blocks media CDN
requests, and mocks authenticated Studio transport using the exact daily series
from the supplied saved page. It checks the centered button, three stacked graphs,
pointer re-entry, mouse clicks, synchronized reference dates and values across
all graphs, large monthly/daily values to the left of each graph, missing and zero
counts, totals, persistent month selection, live updates
across open panels and tabs, reload persistence, caching, errors, safe parsing, lazy cards,
viewer navigation, and delayed responses. Live authenticated Studio access must
be verified in the installed browser session.
