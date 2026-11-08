# @logistack/cli

`logistack`, a single binary for the terminal and CI: `login`, `diff`, `apply`, `export`, `deploy`, `logs`, `exec`, each with `--json`. It talks to the REST API with an API key and validates manifests locally with the zod schemas in `@logistack/contracts`.

```sh
bun src/index.ts --help        # from source
bun run build                  # dist/logistack for this machine
```

Release builds (linux and darwin, amd64 and arm64) come from `.github/workflows/release.yml`. Darwin binaries are re-signed ad hoc (`codesign --force -s -`): without it, recent macOS kills them at start.

The API key never travels on argv: `login` reads it from a prompt or stdin, CI sets `LOGISTACK_API_KEY`. The saved login is `~/.config/logistack/config.json`, mode 0600.
