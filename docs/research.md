# Research and coverage boundaries

Research date: 2026-11-13. References informed design; reference implementations
are not copied into Cloakium.

## Primary references

| Reference | Why it matters |
| --- | --- |
| [Playwright releases](https://github.com/microsoft/playwright/releases) | Driver/browser compatibility and API changes; 1.65.0 also tests stable Chrome 157. |
| [Chromium source](https://github.com/chromium/chromium) | Native browser behavior and original patch targets. |
| [nixpkgs Chromium](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/applications/networking/browsers/chromium) | Source hashes, dependencies, toolchain, sandbox and wrapper wiring. |
| [ungoogled-chromium design](https://github.com/ungoogled-software/ungoogled-chromium/blob/master/docs/design.md) | Privacy patch maintenance and source processing. |
| [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) | Trade-offs of lazy CDP execution contexts, bindings, workers and console behavior. |
| [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) | Observable protocol behavior and execution-world trade-offs. |
| [fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium) | Fingerprint configuration surfaces and the risk of version lag. |
| [Chromium Linux build instructions](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md) | Builder memory and disk requirements. |
| [GitHub self-hosted runner security](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions) | Isolating native builds from untrusted PRs. |

## Coherence matters more than a long flag list

A Windows UA on Linux does not provide Windows font rasterization, codecs,
graphics drivers or TLS behavior. Randomly changing every value can make a
browser more distinctive, not less. Defaults should retain the real platform and
native browser behavior; profile settings must agree across HTTP, JavaScript,
screen geometry, locale and timezone.

Noise must be stable for the chosen identity and must not accumulate by mutating
the underlying canvas/audio buffers. Repeated reads, worker contexts and iframe
behavior need regression tests, not just a screenshot of a detector score.

Removing `Runtime.enable` blindly breaks execution-context discovery, workers,
bindings and selectors. Changing a utility-world name does not by itself remove
all DevTools observability. Source replay verifies patch applicability; only a
real browser run can verify runtime behavior.

## Deliberate non-claims

* There is no guarantee of human identity, invisibility, CAPTCHA completion or
  acceptance by a third-party site. IP reputation, account history and server-side
  correlation are outside a browser patch's control.
* WebDriver flags, rendering fingerprints, TLS, HTTP/2, fonts, codecs, GPU output,
  accessibility, interaction timing and IP/locale consistency are different
  surfaces. One fix is not evidence that the others are solved.
* JavaScript polyfills that overwrite every navigator property are not a native
  fingerprint implementation. Unsupported switches must not be advertised as
  working simply because Chromium ignores them.
* CDP-generated input is browser input, not physical hardware input. Input pacing
  is an ergonomic/replay option, not proof of a person.
* No detector service or protected third-party site is used as a substitute for
  local regression tests. Published evidence must identify what actually ran.

See [native patch details](native-patches.md), [driver patch details](playwright-patches.md)
and [the API](api.md) for the implemented surfaces and limitations.
