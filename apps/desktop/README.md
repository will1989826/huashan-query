# Desktop app

The desktop entry lives in this directory. Shared Go packages remain under the
repository-level `internal/` directory so the move does not duplicate or split
the established domain implementation.

Run it from the repository root:

```bash
go run ./apps/desktop
```

Windows and macOS read the desktop WeChat login state when available. Linux
uses the manual Token flow in the embedded web UI; every platform keeps that
flow as a fallback.
