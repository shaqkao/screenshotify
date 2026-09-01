# Privacy Policy — Screenshotify

Screenshotify has no backend, no accounts, and no telemetry. This document
covers the only place any of your data goes: the AI endpoint you configure
yourself. For what the app does generally, see the [README](../README.md).

## What gets sent, and where

When Screenshotify needs a filename suggestion, it sends **one screenshot at
a time** to the base URL you entered under **Settings → AI provider** —
nowhere else. The image is downscaled locally first (1024 px longest edge,
by default) before it ever leaves your machine.

That endpoint is entirely your choice: a commercial API such as OpenAI or
OpenRouter, or a fully local server such as Ollama or LM Studio running on
your own machine, in which case no image leaves the machine at all. Because
you choose the endpoint, Screenshotify has no relationship with whichever
provider you pick and no visibility into what that provider does with the
image once it receives it — refer to that provider's own privacy policy for
how they handle it.

## Your API key

Your API key is stored in the operating system's own credential store — the
Windows Credential Manager on Windows, the macOS Keychain on macOS — never in
a plain settings file. It is never handed to the app's UI layer; requests
that need it are made from the Rust backend process directly. You can inspect
or delete it at any time through Credential Manager / Keychain Access.

## What stays on your device

Your settings (watched folders, naming preferences, provider configuration)
and the rename history that powers Undo are stored locally on your machine,
in the app's own data directory. None of it is transmitted anywhere by
Screenshotify.

## No telemetry, analytics, accounts, or Screenshotify-run servers

Screenshotify does not collect usage analytics, does not require or support
creating an account, and has no server of its own — there is nothing running
that Screenshotify's developers could use to see your screenshots, filenames,
or API key even if they wanted to.

## Changes to this policy

This file is versioned in the project's public git history alongside the
rest of the source, so any change to it is visible in
[the repository's commit history](https://github.com/shaqkao/screenshotify/commits/master/docs/PRIVACY.md).

## Contact

Questions about this policy or the app's data handling: open an issue at
[github.com/shaqkao/screenshotify/issues](https://github.com/shaqkao/screenshotify/issues).

*Last updated: 2026-09-01.*
