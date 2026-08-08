# Pipeline configuration

`ci.yml` runs on every pull request and every push to `main`. Configure the
repository's `main` branch protection rule to require these checks before
merge:

- `API lint, typecheck, test, and build`
- `Frontend lint, typecheck, test, and build`
- `Validate container stack`

`cd.yml` only runs for pushes to `main`. Deployment is deliberately disabled
until the repository variable `ENABLE_SSH_DEPLOY` is set to `true`. The
production environment needs these GitHub Actions secrets:

| Secret | Purpose |
| --- | --- |
| `DEPLOY_HOST` | Poridhi VM hostname or IP |
| `DEPLOY_USER` | SSH user |
| `DEPLOY_SSH_KEY` | Private key accepted by the VM |
| `DEPLOY_PORT` | SSH port; optional, defaults to 22 |
| `DEPLOY_PATH` | Existing checkout directory on the VM |
| `DEPLOY_HEALTHCHECK_URL` | API health URL reachable from the VM |

The VM checkout must already track `origin/main`, and its user must be allowed
to run Docker Compose. Deployment uses a fast-forward-only pull so it will stop
instead of discarding unexpected changes on the server.

