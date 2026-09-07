# Desktop app

The desktop entry lives in this directory. Shared Go packages remain under the
repository-level `internal/` directory so the move does not duplicate or split
the established domain implementation.

Run it from the repository root:

```bash
go run ./apps/desktop
```

Windows reads the desktop WeChat login state when available. macOS and Linux
use the manual Token flow in the embedded web UI.
