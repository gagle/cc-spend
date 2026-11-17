# Changelog

## [0.2.0](https://github.com/gagle/cc-spend/compare/v0.1.0...v0.2.0) (2026-11-17)


### ⚠ BREAKING CHANGES

* **coach:** `report --chart` is gone; the chart is the default.

### Features

* **calendar:** drop title from Pro/Max notice ([076f0f9](https://github.com/gagle/cc-spend/commit/076f0f92224863c6f0533a499c42abc6b2b55008))
* **calendar:** plain Pro/Max notice, no border box ([1d2ede4](https://github.com/gagle/cc-spend/commit/1d2ede464bbefafd615f36b116d27a516f2e14e2))
* **coach:** cache what-ifs: deep rewrites in R5, tool waits in R4, R13 1h cache ([c917209](https://github.com/gagle/cc-spend/commit/c9172094f97fffd52db069703e417fd54baffabe))
* **coach:** visual "how you're doing" in record, report and insights; advisor follows your trend ([d953e5b](https://github.com/gagle/cc-spend/commit/d953e5baff2801d302eb26e6a5000a456893a8de))
* **coach:** visual how-you're-doing, trend-driven advisor; README rewrite ([188a7ea](https://github.com/gagle/cc-spend/commit/188a7ea13c2d7680242a43b36e6271c302f10c45))
* **doctor:** warn when a busy day counted 0 prompts ([f501da8](https://github.com/gagle/cc-spend/commit/f501da819dacf415f8c887f5247f72eef9ffa9d0))
* **record:** habits week by week against a baseline ([655410e](https://github.com/gagle/cc-spend/commit/655410e940f7c8941ffaeac9bc77dfd7753c64ab))
* **statusline:** auto-compact action, Claude Code update notice; R5 fix ([61f53f4](https://github.com/gagle/cc-spend/commit/61f53f4ed780c1719da1d0f444990387e941e2ab))


### Bug Fixes

* **statusline:** cold-soon action leaves the countdown and $ to the cache part ([696e965](https://github.com/gagle/cc-spend/commit/696e9654e208d85624f8878f7634ac37b92153a7))
* **storage:** stop unbounded growth of the config dir ([780c13f](https://github.com/gagle/cc-spend/commit/780c13f64edf52b241a9ab68e0c295f96000b4f8))
* **usage:** name cc-spend in the user agent; drop limit-reset grants ([065268d](https://github.com/gagle/cc-spend/commit/065268d849cf7e90e35d6a365d07fef57070662b))
