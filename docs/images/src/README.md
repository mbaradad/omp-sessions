# README graphics

`hero.html`, `how-it-works.html`, `a-day.html`, `phone.html` and `setup.html` are the sources of the PNGs one folder up (the README shows `hero.png` and `a-day.png`); `og.html` is the website's link preview, `site/assets/og.png`, rendered at 1×. Most embed the screenshots in `docs/images/` (see `docs/PUBLISHING.md` §5), so re-render them after retaking screenshots. `hero.html` crops `chat.png` to the editor area. `approval.png` (used by `a-day.html`) and `connect-phone.png` (used by `phone.html`, QR code blurred) are crops of screenshots of the extension's approval card and *Connect Phone* panel. Render at 2× from the repository root:

```sh
npx -y playwright screenshot --device "Desktop Chrome HiDPI" --viewport-size 1200,580 "file://$PWD/docs/images/src/hero.html" docs/images/hero.png
npx -y playwright screenshot --device "Desktop Chrome HiDPI" --viewport-size 1200,600 "file://$PWD/docs/images/src/how-it-works.html" docs/images/how-it-works.png
npx -y playwright screenshot --device "Desktop Chrome HiDPI" --viewport-size 1200,500 "file://$PWD/docs/images/src/a-day.html" docs/images/a-day.png
npx -y playwright screenshot --device "Desktop Chrome HiDPI" --viewport-size 1200,640 "file://$PWD/docs/images/src/phone.html" docs/images/phone.png
npx -y playwright screenshot --device "Desktop Chrome HiDPI" --viewport-size 1200,640 "file://$PWD/docs/images/src/setup.html" docs/images/setup.png
npx -y playwright screenshot --viewport-size 1200,630 "file://$PWD/docs/images/src/og.html" site/assets/og.png
```

The viewport height is the `body` height in each file. Fonts: Inter (falls back to the system sans).
