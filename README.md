# Humaniser

Paste writing that sounds like a committee produced it. Get back something a person would say.

Humaniser runs as a small local web app on macOS or Linux. It scores your text against a house style, shows you exactly where the prose stiffens, and rewrites it two ways: with an offline rules engine that needs no account and no network, or with Claude when you want real judgement applied to rhythm and metaphor.

**No API key required.** The offline engine is the default and it needs nothing — no account, no key, no network. Claude is an optional extra for people who already have API access.

![two panes, a score, and a chart of sentence lengths](docs/screenshot.png)

Dark mode comes along for free, following whatever your Mac is set to: [see it](docs/screenshot-dark.png).

## Set it up

Node 18 or newer is the only thing you need, and macOS does not come with it. Check whether you already have it:

```bash
node -v
```

A version number means you are set. "command not found" means you need it, so pick one of these.

**macOS, no terminal required.** Go to [nodejs.org](https://nodejs.org), download the macOS installer for the LTS version, and double-click it. It is a small, ordinary `.pkg` — next, next, done. This is the path to take if you do not already use Homebrew, because Homebrew itself wants Xcode's command line tools first, which is a far bigger download than Node.

**macOS, if you already have [Homebrew](https://brew.sh):**

```bash
brew install node
```

**Linux.** Your distribution's package may be too old, so check the version after installing. If it is below 18, [nvm](https://github.com/nvm-sh/nvm) is the reliable way round it:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL
nvm install 22
```

Whichever route you took, close the terminal afterwards and open a fresh one, so the new `node` command is on your path. Then:

```bash
git clone https://github.com/AdilKhan1113/Humaniser.git
cd Humaniser
./start.sh
```

That installs the one dependency, starts the server and opens your browser at `http://127.0.0.1:8787`. On Linux it opens through `xdg-open`; if your box has no desktop session it just prints the address for you to open yourself. The first run takes a few seconds. Every run after that is instant.

Prefer to do it by hand? `npm install && npm start` does the same thing without opening a browser.

Cloning a *private* fork is the one case that needs more: GitHub has not accepted account passwords for Git since 2021, so run `gh auth login` first, or use a [personal access token](https://github.com/settings/tokens) with the `repo` scope in place of the password.

### Optional: turn on Claude

Skip this section entirely unless you have an Anthropic API key. Without one the Claude option stays greyed out and everything else works as normal.

A key is not the same thing as a Claude.ai subscription — it comes from the developer console and is billed per use. If you have one, drop it into a `.env` file:

```bash
cp .env.example .env
```

Open `.env` and paste your key from [console.anthropic.com](https://console.anthropic.com/settings/keys):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Restart the server. The Engine menu will switch to Claude, and calls are billed to your own account.

## How to use it

Paste your text on the left and press **Humanise**, or hit `⌘↵`. Three things then happen.

The rewrite appears on the right, streaming in as Claude writes it. A score out of 100 tells you how human the result reads, with the change from your original beside it. Below that sits the detail: six qualities scored separately, a chart of every sentence's length, a list of what is still wrong, and a list of every edit that was made.

Click any finding and it selects that exact phrase in your text. Click a bar in the chart and it jumps to that sentence.

**Strength** decides how far to go.

| Setting | What it touches |
| --- | --- |
| Light touch | Only the uncontroversial: stock phrases, inflated words, the comma rule |
| Balanced | The full style — active voice, shorter sentences, contractions, no padding |
| Bold | Same rules, harder. Shorter sentences, contractions wherever they fit |

**Thinking** appears in Claude mode and sets how hard the model works. Low is fast and surprisingly good. High is the default. Very high is for prose you really care about.

## The two engines, and why you would pick one

The **offline rules engine** is a set of transforms with a strict promise: when it cannot be certain, it does nothing. It flips "the cake was eaten by the dog" to "the dog ate the cake" because every piece of that is checkable. It refuses to flip "the window was broken" because nobody said who broke it, so it flags the sentence instead. Nothing leaves your machine, it costs nothing, and it finishes before you lift your finger off the key. What it cannot do is write. It swaps words and shuffles clauses; it will never think of a better metaphor.

The **Claude engine** rewrites properly. It varies sentence structure, reaches for a concrete example, and hears when a paragraph plods. It costs money per use and sends your text to the API. Use the offline engine for a quick clean-up and Claude when the writing matters.

A useful habit: run the offline engine first to see the mechanical problems listed out, then run Claude on the original.

## What the score measures

The headline number is a weighted blend of six qualities, each scored out of 100.

- **Rhythm** — how much sentence lengths vary. Machines write at one speed.
- **Active voice** — the share of sentences that name who is doing the thing.
- **Plain words** — freedom from stock phrases and corporate inflation.
- **Warmth** — contractions, and whether the writing ever addresses you.
- **Vocabulary** — range of words, and how often phrasing repeats.
- **Concision** — sentence length against the 6-to-20-word target, minus the padding.

Two of the numbers deserve a word of explanation, because they are named after ideas from language modelling and only approximate them.

**Burstiness** is honest: it is the coefficient of variation of sentence lengths, which is exactly what the term means. Higher is more varied. Below about 0.30 the writing reads like a metronome.

**Vocabulary** is a *proxy* for perplexity, not perplexity itself. Real perplexity needs a language model scoring every token. This score instead combines the type-token ratio, the share of words outside a common-word list, and how often word pairs repeat. It correlates with what perplexity captures, but do not read it as the same measurement. Short passages also inflate it, since a forty-word note can hardly repeat itself.

## The house style

Both engines work from the same rules.

Active voice over passive. Sentences of varied shape and varied length, mostly between 6 and 20 words. Plain words where a plain word will do. Contractions, but not wall to wall. Speak to the reader as "you". Concrete examples and analogies over another abstract sentence. Natural transitions like "However" or "For example". No padding, no self-references, no essay scaffolding, no lecturing.

One mechanical rule is worth stating plainly, because it surprises people: **no comma before and, but, for, or, nor, so, yet when both sides could stand alone as sentences.** So "I read the book but I disliked it", not "I read the book, but I disliked it". Lists keep their commas, and a comma stays when what follows cannot stand alone.

There is a tension inside these rules and it is deliberate. The style asks for simpler words *and* for uncommon terminology. Those pull in opposite directions, so Humaniser resolves it one way: **corporate padding goes, vivid precision stays.** "Utilize" becomes "use" every time. A word like "cantankerous" is left exactly where it is, because it is doing work no common word could do.

## What it will not do

It will not invent facts. Neither engine adds an example, a statistic or an anecdote that was not in your text, and the Claude prompt forbids it explicitly. If your draft is thin, the rewrite is thin — tighter, but thin.

It will not touch code. Fenced blocks, inline code, URLs, markdown links and email addresses are all masked before any rule runs and restored untouched afterwards.

It will not guess at grammar. English participles are irregular enough that a confident rewrite is often a wrong one, so the rewriter checks a verb table first and declines when the verb is unfamiliar in that tense. A missed fix shows up as a finding. A wrong fix would show up as a sentence you have to untangle, which is worse.

It is not a detector. A high score means the writing reads naturally. It is not a claim about what any particular detection tool will say, and the app never pretends otherwise.

## Project layout

```
server.js            HTTP server, routes, streaming. No framework.
lib/
  analyze.js         Scoring, metrics and every finding in the report
  rules.js           The offline rewriter and its pipeline
  passive.js         Passive detection and the active-voice flip
  verbs.js           Verb tables, so a flip does not invent a tense
  lexicon.js         Word lists: stock phrases, inflated words, contractions
  common-words.js    Frequency list, for the rare-word share and name detection
  prompt.js          The house style, written for Claude
  claude.js          The API call, streaming and error handling
  env.js             Reads .env without needing a newer Node
public/              The whole front end: one HTML file, one CSS, one JS
test/                64 tests, run with npm test
```

There is no build step. No bundler, no transpiler, no framework. `public/app.js` is the file the browser runs, which means you can change a line and just reload.

## Development

```bash
npm test          # the full suite
npm run dev       # restarts on file changes
PORT=3000 npm start
```

The server binds to `127.0.0.1`, so it is reachable from your machine and nowhere else. If port 8787 is busy it walks forward until it finds a free one and tells you which.

## Licence

MIT.
