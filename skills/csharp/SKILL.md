---
name: csharp
description: Use whenever writing or editing C# (.cs). Teaches Recommended Roslyn analyzer defaults (AnalysisMode Recommended + TreatWarningsAsErrors), .editorconfig style, and the common CA pitfalls that break those defaults — LoggerMessage (CA1848), cancellation (CA2016/CA1068), disposal (CA1001), nullability, and the perf/usage rules. a large .NET/TS monorepo is cited only as an optional example of what the defaults catch.
---

# C# — Recommended analyzers and style

Target: any .NET project that enables the Recommended analyzer set with warnings-as-errors (the usual modern setup: `AnalysisMode=Recommended`, `TreatWarningsAsErrors=true`, `Nullable` + `ImplicitUsings` on). Source of truth in any given repo is its `Directory.Build.props` / `.editorconfig` — follow those when they differ.

Under Recommended + TreatWarningsAsErrors, every Recommended CA rule is a build error unless the repo has baselined it as `suggestion` in `.editorconfig`. Prefer fixing the code over new `#pragma`, `NoWarn`, or baseline entries. A justified `[SuppressMessage(..., Justification = "...")]` is for the rare case where a fix would break a public contract.

## Rules of thumb (the classes that break Recommended builds)
- **Logging (CA1848, CA1873, CA1727):** no `logger.LogX("...")` calls. Use source-generated `[LoggerMessage]` on a `static partial` method in a `partial` class; PascalCase placeholders.
  ```cs
  // don't: _logger.LogInformation("Synced {count} panels", count);
  [LoggerMessage(Level = LogLevel.Information, Message = "Synced {Count} panels")]
  private static partial void LogSynced(ILogger logger, int count);
  ```
- **Cancellation (CA2016, CA1068):** forward the `CancellationToken` to every call that accepts one; `CancellationToken` is the last parameter.
- **Overrides/interfaces (CA1725):** parameter names match the base/interface declaration.
- **Disposal (CA1001, CA1816):** a type owning an `IDisposable` field is `IDisposable`; `Dispose()` calls `GC.SuppressFinalize(this)`.
- **Perf/usage (CA1859, CA1861, CA1822, CA1805, CA1826, CA1860, CA1865-71, CA1510):** concrete private return/local types instead of interfaces; constant arrays as `static readonly` fields; `static` for members not using instance state; no explicit default-value field init; `Count`/`Length` over `Any()`/`Count()` on collections; `char` overloads (`Split(',')`); `ArgumentNullException.ThrowIfNull(x)`.
- **Security (CA5351 etc.):** no MD5/SHA1/DES for security purposes.
- **Nullability:** no `!` to silence warnings; handle null or change the type.
- **Style (typical .editorconfig, enforced by `dotnet format`):** file-scoped namespaces, `using` outside the namespace, braces always, `var` when the type is apparent, pattern matching/switch expressions, `is null` checks, LF line endings. Defer to the repo's .editorconfig when it differs (e.g. primary constructors on/off).
- `ConfigureAwait(false)` is not needed in ASP.NET Core / most modern hosts; don't add it unless the repo requires it.

*Example (a large .NET/TS monorepo):* Recommended + TreatWarningsAsErrors with a short suggestion baseline (CA1000, CA1304/5/9/10/11, CA1862, CA1869, CA2211, CS0618, CS8632); existing CA1707 suppressions for HTTP query-string parameter names that are a public contract.

## Before finishing
1. `dotnet build` (or the solution) — 0 warnings/errors; analyzers run in the build.
2. `dotnet format <sln> --verify-no-changes --no-restore --severity warn --include <changed .cs files>` (many repos run this in CI on changed files). Fix with the same command minus `--verify-no-changes`.
3. `dotnet test` for the affected projects.
