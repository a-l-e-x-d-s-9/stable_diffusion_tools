# Civitai Rating Highlighter

Install [`civitai_rating_highlighter.user.js`](../civitai_rating_highlighter.user.js)
in Tampermonkey or Violentmonkey, then reload Civitai. The script runs on
`https://civitai.com/*`, `https://civitai.red/*`, and `https://civitai.green/*`.

Open **Ratings: Off** in the bottom-right corner and turn on **Enable rating
highlighter**. The same panel is available from the userscript manager's
**Rating highlighter settings** command.

Click **Hide settings panel** to hide the entire panel, including its Ratings
toggle, while highlighting, blinking, and enabled keyboard shortcuts keep
working. Reopen it through the userscript manager's **Rating highlighter
settings** menu command. Panel visibility is remembered across reloads and does
not change whether the script is enabled.

- **Red frame for unrated media:** adds an 8-pixel red foreground border around
  your image/video cards without a recognized rating badge. The border appears
  above images and videos and does not intercept clicks.
- **Slow blinking red frame:** fades only the border down and back up over a
  2.4-second cycle. Off by default; requires red frames to be enabled.
- **Color rating badges and filters:** colors rating badges on your media and
  browsing-level filter chips. PG is green, PG-13 lime, R yellow, X orange, and
  XXX red. Filter checkmarks remain intact; unchecked chips have dashed borders.

The master switch defaults to off on first installation. Red frames and rating
colors are preselected, work independently, and take effect immediately when enabled.
Preferences, including the master switch, are saved by the userscript manager.
Disabling removes the script's frames and colors, stops watching for changes,
and disables navigation buttons and keyboard shortcuts. Updating from version
1.0 retains existing preferences.

Use **Previous** and **Next** in the settings panel to scroll between loaded
unrated cards in visual order. Navigation works even with red frames switched
off. At either end, a message explains that no further loaded match exists;
scroll to load more cards. Navigation does not wrap or fetch the entire library.

Turn on **Enable keyboard shortcuts** to use **Alt+ArrowUp** for previous and
**Alt+ArrowDown** for next. Shortcuts default to off. To change a shortcut, click
its field and press the desired key combination; it is saved immediately and
persists across reloads. Backspace or Delete clears a binding, Escape leaves the
field, and Tab moves focus normally. Each direction needs a different shortcut.
Shortcuts are ignored while typing in input fields or editable content, and only
work while the highlighter and keyboard shortcuts are both enabled. Choose a
different combination if the browser or operating system reserves your choice.

The script handles newly loaded cards, changing rating badges, and gallery
replacement during navigation without requiring a reload. It recognizes the
gallery and post-detail card layouts in the supplied examples and also colors
ImageGuard rating badges on cards confirmed as yours. Filter chips remain colored
regardless of card ownership.

“Unrated” means the card has no PG, PG-13, R, X, or XXX badge in its HTML. This
does not verify the rating in Civitai's database: if Civitai omits a badge, that
card will be marked. The script checks your signed-in session and, when a card
has no creator link, uses the image API to confirm ownership. These checks are limited to four concurrent
requests. It does not change ratings or browsing-level selections. Counts cover currently loaded cards confirmed as yours, not your entire library.

Verified in headless Chrome using the original four HTML examples and the
additional Paper card example, including
independent toggles, all five colors, late/removed/changed ratings, added/removed
cards, gallery replacement, foreground border rendering, optional blinking,
previous/next scrolling, custom shortcut capture, typing exclusions, saved
settings, and disabling cleanup.
Live authenticated galleries were not tested.
