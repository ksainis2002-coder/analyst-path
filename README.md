# The Analyst Path (v2)

Static web app: no backend, no build step, no dependencies.

## Run it locally
From this folder:

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Any static server works (`npx serve`, VS Code Live Server, …).
Opening `index.html` by double-clicking will NOT work: browsers block ES modules and
`fetch()` on `file://` pages.

Useful URL flag (before the `#`):
- `http://localhost:8000/?nostorage`: runs with memory-only progress (what happens when localStorage is blocked)

There is no developer panel in the app any more (it was removed in Phase 9). Browser tests that need a learner
"further along" write passes tagged `source: "dev"` straight into `localStorage` (`analystPath.progress.v2`);
those unlock levels for testing but the readiness report never counts them as evidence.

## Publish on GitHub Pages (free)
The app is plain static files with hash routing (`#/level-1/...`), so it needs no server config, no 404 page and no build.

1. Create a new **public** repository on GitHub, e.g. `analyst-path` (no README, no .gitignore).
2. From this folder (the one containing `index.html`, `.nojekyll`, `css/`, `js/`, `content/`, `assets/`):
   ```
   git init
   git add -A
   git commit -m "The Analyst Path v2"
   git branch -M main
   git remote add origin https://github.com/<your-user>/analyst-path.git
   git push -u origin main
   ```
   Or, without git: on the empty repo page choose **uploading an existing file** and drag in the *contents* of this
   folder (not the folder itself). Hidden files are easy to miss: make sure `.nojekyll` is uploaded.
3. On GitHub: **Settings ▸ Pages ▸ Build and deployment ▸ Source: Deploy from a branch ▸ Branch: `main` ▸ `/ (root)` ▸ Save**.
4. Wait a minute or two (the **Actions** tab shows "pages build and deployment"). The site is at
   `https://<your-user>.github.io/analyst-path/`.
5. Share previews: in `index.html`, change `og:image` from `assets/og-image.png` to the absolute URL
   `https://<your-user>.github.io/analyst-path/assets/og-image.png` (link previews on most sites need an absolute URL), and
   optionally add `<meta property="og:url" content="https://<your-user>.github.io/analyst-path/">`. Commit and push.

Why `.nojekyll`: it tells GitHub Pages to serve the files as they are, instead of running them through Jekyll
(which ignores files and folders starting with `_`, such as `content/_generators/`).
Everything uses relative paths, so it works under the `/analyst-path/` sub-folder as well as at a domain root (tested).
Netlify works the same way: drag this folder onto app.netlify.com/drop.

`dev/` (the in-browser test runner and console demo) is harmless to publish and not linked from the app; delete it from
the published copy if you prefer. Learner progress lives in each visitor's browser (`localStorage`); nothing is sent anywhere.

## Offline
After the first visit the app fetches the rest of the course content in the background (never the answer keys), so
lessons, assignments, the case study, the report and the cheat-sheet keep working if the connection drops.
Answer keys need a connection, by design: they are fetched only after a submission.

## The cheat-sheet (`#/cheatsheet`)
`content/cheatsheet.json`, rendered by `js/ui/cheatsheet.js`, prints on one A4 or Letter page. Every formula on it is run
against the practice data by `js/content.test.js`.

## Developer pages (not linked from the app)
- `http://localhost:8000/dev/console.html`: the formula console demo (two independent consoles)
- `http://localhost:8000/dev/test.html`: runs every test suite in the browser, including the UI/DOM tests Node can't run

## Data
The course runs on **Aegean Supplies**, a generated 2025 order log (spec §6): 180 orders (A:H), products (J:N),
sales reps (P:T), volume-discount tiers (V:X), plus a messy copy of the orders for Level 3: the same orders with
11 documented defects of six kinds (duplicates, blank regions, inconsistent text, numbers stored as text, a typo'd
ProductID, a date in the wrong year). Cleaning it with the right moves gives back exactly the clean log (tested).
It's produced by a seeded generator, so it's reproducible:

```
node content/_generators/aegean.mjs          # regenerate js/data/aegean.generated.js
node content/_generators/aegean.mjs --check  # verify the shipped file matches (part of npm test)
```

Changing the data changes answers. `npm test` then shows every drill, task and quiz answer that moved,
and numbers quoted in lesson text use live `{{=FORMULA}}` templates, so they update themselves.

## Content
Lessons are JSON in `content/lessons/<id>.json`, listed by id in `content/curriculum.json` (`levels[].lessons`).
The schema is documented at the top of `js/content.js`. Level gates live in `content/assignments/`: the Level 0 checkpoint quiz and
Assignments 1–3. An assignment's solutions are in a separate `<id>.key.json` that the app only fetches after a submission attempt.
Adding or editing a lesson needs no code change, but every new drill needs an oracle entry in `js/content.test.js`
(the test fails until it has one), and every assignment task needs an oracle entry and at least one must-fail trap.
That's how "no wrong answers ship" is enforced.

### Level 3: the workbench
Level 3 lessons and Assignment 3 declare `"lab": { "panels": ["cleaning", "pivot", "chart"] }` instead of using the console:
- `js/ui/cleaning.js`: a working copy of the messy export with real moves (Remove Duplicates, Find blanks, formula fill-down
  pasted as values, Convert to Number, Find & Replace, Sort, edit a cell), each with its Excel and Sheets menu path.
  What's fixed is judged from the **data**, and a move that breaks good data is reported as damage.
- `js/ui/pivot.js`: a pivot builder (Rows / Columns / Values, Summarize By, Show Values As, Filter, date grouping) that,
  like Excel, reads a snapshot and only updates on **Refresh**.
- `js/ui/story.js`: a PivotChart (column / bar / line / pie, order, highlight), a title, and a fill-in insight sentence.
- `js/ui/workbench.js` chains them: pivot reads the cleaned data, chart reads the pivot.
Each has a pure half (tested in Node by `js/ui/models.test.js`) and a DOM half (tested in the browser by `js/ui/workbench.dom.test.js`).
A workbench drill's `solution` is data: `{ steps: [moves], pivot: {…}, story: {…} }`, replayed by the tests.

### The capstone and case studies
- `content/assignments/mock-test.json`: a **pool** of tasks, each tagged with the skill it tests (`slot`), and **variants**
  that pick one task per slot. Attempts alternate variants. Its key (`mock-test.key.json`) is fetched only after a submission.
- `js/ui/timer.js`: the countdown, anchored to the start timestamp (a reload doesn't reset it; there is no pause).
- `js/ui/mocktest.js`: start screen → 45-minute attempt (formulas on the clean log + the Level 3 workbench on the raw export)
  → one submission (automatic at 0:00) → results, then the key on request.
- `content/cases/case-a.json` + `js/ui/case.js`: a case study is ordered steps, each with its own check, on one workspace.
  Formula steps run on the learner's current working sheet; `{row:O1088}` in a solution means "that order's row now".
  Cases are listed in `curriculum.json` → `cases[]` and open at `#/cases/<id>`.

### The readiness report (`#/report`)
`js/ui/report.js` builds it from the progress store and `content/skills.json`, which maps each skill to the ONE thing that
proves it (a gate or a case) and its CV-safe wording. A skill shows as demonstrated only if that evidence was passed
without help; "with help" passes are listed apart and never reach the CV lines; test-seeded (`source: "dev"`) passes are never counted.
Drills and checkpoints are reported as practice (alone vs with help), never as proof. A later pass without help upgrades
a "with help" pass (`progress.js`). `js/ui/report.test.js` includes a 600-case property test that the CV lines never overstate.

## Tests
```
npm test          # engine, router, progress, grader, data, content (every answer vs an independent oracle),
                  # UI helpers, the cleaning / pivot / story models, and the readiness report
                  # DOM tests (console, lessons, assignments, workbench, timer, mock test, case, report): open dev/test.html
```
Needs Node 18+. `package.json` exists only to mark `.js` files as ES modules; there is nothing to install.
