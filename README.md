# media-name-parser
A service to parse filenames to pinpoint media content.

## Authentication

Two independent credentials, for two audiences.

**API keys** authenticate machine callers on `/api/v1/*`, as
`Authorization: Bearer mnp_…`. Mint one with
`npm run seed:key -- <email> [label]`; the secret prints once, to stdout, and
is not recoverable. The key belongs to a real user row.

**Sessions** authenticate people, via a magic link at `/sign-in`. GitHub
appears as an option only when `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`
are both set. `/admin` requires the `admin` role: grant it with
`npm run admin:promote -- <email>`, remove it with `--revoke`.

The two do not mix. An API key cannot reach `/admin`, and a session cannot
stand in for a key on `/api/v1/*`.

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Neon connection string |
| `BETTER_AUTH_SECRET` | yes | signs sessions; Better Auth will not start without it |
| `BETTER_AUTH_URL` | yes | the app's own origin, used to build magic-link URLs |
| `TMDB_READ_ACCESS_TOKEN` | yes | TMDB v4 read access token; the code also accepts the older `TMDB_API_KEY` name |
| `CRON_SECRET` | production | the bearer token Vercel Cron presents to the sweep route |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | no | enables GitHub sign-in when both are set |
| `MAGIC_LINK_SINK` | no | `1` collects magic links in memory instead of sending mail |

No mailer is configured. With `MAGIC_LINK_SINK` unset, requesting a magic link
logs that nothing was delivered rather than pretending to send it. Choosing a
mail provider is deliberately out of this plan's scope.
