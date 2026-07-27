# Docker setup

This Docker setup runs the existing batch application without changing its workflow logic.

## Files

Copy these files into the repository root:

```text
Dockerfile
docker-compose.yml
.dockerignore
batch.config.docker.json
docker/
  entrypoint.sh
  chrome-wrapper.sh
docs/
  docker.md
```

## Host folders

Create:

```bash
mkdir -p docker-data/input docker-data/output docker-data/state
```

Place the PDFs and `base_generator.py` in:

```text
docker-data/input/
```

The generated files are written to:

```text
docker-data/output/
```

Persistent Chrome login data, JSONL logs, diagnostics, and `summary.json` are stored in:

```text
docker-data/state/
```

## Configuration

Edit `batch.config.docker.json`.

All paths inside that file must be container paths:

```text
/workspace/input
/workspace/output
/workspace/workflow
```

The Compose file mounts the repository's `workflow/` directory at `/workspace/workflow`. Change that volume if your workflow directory has a different host path.

## Build

```bash
docker compose build
```

## First login

Start a shell session with the browser desktop:

```bash
docker compose run --service-ports --rm agentify-batch bash
```

Inside the container, start Chromium:

```bash
/app/docker/chrome-wrapper.sh \
  --user-data-dir="$HOME/.agentify-desktop/chrome-user-data" \
  --profile-directory=Default \
  https://chatgpt.com/
```

Open this URL on the host:

```text
http://localhost:6080/vnc.html
```

Log into ChatGPT. Close Chromium after login. The authenticated profile remains in `docker-data/state`.

Do not commit `docker-data/state`; it contains browser session data.

## Run the batch

```bash
docker compose run --service-ports --rm agentify-batch
```

Or:

```bash
docker compose up --abort-on-container-exit
```

## Tests

```bash
docker compose run --rm agentify-batch npm test
```

## Output and monitoring locations

Inside the container:

```text
/home/agentify/.agentify-desktop/runs/<runId>/
```

On the host:

```text
docker-data/state/runs/<runId>/
```

That directory contains the Requirement 1–7 monitoring artifacts, including:

```text
run.jsonl
summary.json
entries/... diagnostics
```

## Security notes

The noVNC endpoint has no password and is published only for local development. Do not expose port `6080` publicly.

The Chromium wrapper uses `--no-sandbox` because Chromium runs inside a container. Use the container with an unprivileged user, as configured by the Dockerfile.

Never commit:

```text
docker-data/state/
```
