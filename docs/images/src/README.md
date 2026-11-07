# README graphics

`hero.html`, `how-it-works.html`, `a-day.html` and `phone.html` are the sources of the PNGs one folder up. They embed the screenshots in `docs/images/` (see `docs/PUBLISHING.md` §5), so re-render them after retaking screenshots. Render at 2× from the repository root:

```sh
npx -y playwright screenshot --device "Desktop Chrome HiDPI" --viewport-size 1200,580 "file://$PWD/docs/images/src/hero.html" docs/images/hero.png
npx -y playwright screenshot --device "Desktop Chrome HiDPI" --viewport-size 1200,600 "file://$PWD/docs/images/src/how-it-works.html" docs/images/how-it-works.png
npx -y playwright screenshot --device "Desktop Chrome HiDPI" --viewport-size 1200,500 "file://$PWD/docs/images/src/a-day.html" docs/images/a-day.png
npx -y playwright screenshot --device "Desktop Chrome HiDPI" --viewport-size 1200,640 "file://$PWD/docs/images/src/phone.html" docs/images/phone.png
```

The viewport height is the `body` height in each file. Fonts: Inter (falls back to the system sans).
