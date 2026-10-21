# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `GETTING-STARTED.md` tutorial and a runnable `src/examples/getting-started.ts` (`npm run example:getting-started`).
- Split reference docs out of the monolithic `README.md`: `ARCHITECTURE.md`, `MESSAGING.md`, `BELIEFS.md`, `MIDDLEWARE.md`, `DESIRES.md`, `EVENTS.md`, `TESTING.md`, `EXAMPLES.md`.
- `tests/getting-started.test.ts` mirroring the getting-started walkthrough.
- `CHANGELOG.md` entry for the docs split (this file).

### Changed
- `README.md` trimmed to intro/install/quick start/docs map and import layout; pointers updated to the new topical docs.
- Cross-references in `src/bus/types.ts`, `DELEGATION.md`, `PROXY.md`, `CONTRACT-NET.md` updated to the new doc structure.

## [1.6.0] - 2026-10-21
