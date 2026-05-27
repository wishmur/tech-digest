# Tech Digest

A daily AI/tech news digest. A scheduled GitHub Action pulls a set of feeds,
has Claude pick and tag the ~10 most relevant stories for a PM, and pushes them
into a Framer CMS collection ("AI Digest") that renders on shailvikumar.com/tech-digest.

## How it works
1. `index.js` fetches the RSS feeds in its CONFIG block.
2. Filters to the last 36 hours, dedupes, and runs a free keyword pre-filter.
3. One Claude call selects the top 10, writes a one-line "why it matters", and tags topic + company.
4. Pushes the 10 items into the Framer CMS via the Server API and publishes.

Runs daily at 10 AM ET. One model call per day, so cost is a few cents.

## One-time setup
Add three repository secrets (Settings -> Secrets and variables -> Actions -> New repository secret):

- `ANTHROPIC_API_KEY` - your key from console.anthropic.com
- `FRAMER_API_KEY` - from the Framer project: Settings -> API Keys
- `FRAMER_PROJECT_URL` - the editor URL of your project, e.g. `https://framer.com/projects/Your-Site--xxxxxxxx`
  (open the project in Framer and copy it from the browser address bar)

Your Framer CMS collection must be named **AI Digest** with fields:
Title, Date, Summary, Topic, Company, Source, Link.

## Test it
Go to the Actions tab -> Daily Tech Digest -> Run workflow. Watch the logs, then
check the AI Digest collection in Framer.

## Tweaking
- Feeds, priorities, item count, and model are all in the CONFIG block at the top of `index.js`.
- Cheaper model: change `MODEL` to `claude-haiku-4-5`.
