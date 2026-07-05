# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-04

### Added

- Kernel: comment projection, W3C-selector re-anchoring, and byte-identical clean export — all three invariants proven in CI.
- `tether` CLI: `comment add/list/suggest/diff/accept/reject/resolve/remove`, `edit`, `export`, `status --check`.
- `tether mcp`: MCP server exposing the agent-safe surface.
- VS Code extension: native comment threads, diff-before-accept, clean export.
- Agent skill for comment-driven editing; 161 tests (including a fast-check property suite over the invariants) across the monorepo.
