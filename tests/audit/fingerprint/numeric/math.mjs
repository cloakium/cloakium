// Math surface: exactness, ULP-bounded identities and numeric accuracy.
//
// This does not look for a particular vendor tweak. It asserts properties that a
// genuine IEEE-754 Math implementation must have and that a perturbed one breaks:
// spec-fixed constants, exactly-representable results, tight ULP bounds on
// identities, numeric-integral accuracy, and bit-identical values across frames.

import { finish, prepare, recorder } from '../support/common.mjs';

const probe = {
  id: 'math-numeric',
  family: 'numeric',
  budgetMs: 15_000,
  contract: {
    origin: 'loopback',
    crossOrigin: 'not-used',
    routes: [],
    permissions: [],
    activation: 'none',
    viewport: 'any',
    notes: 'Pure computation; also verifies results do not drift between animation frames.',
    checks: [
      'math/constants-exact',
      'math/exact-results',
      'math/sin-cos-identity',
      'math/exp-log-identity',
      'math/pow-square-identity',
      'math/hypot-identity',
      'math/atan2-identity',
      'math/integral-accuracy',
      'math/deterministic-across-frames',
      'math/no-nan-leaks'
    ]
  },

  async run({ page, origin }) {
    const rec = recorder();
    await prepare(page, origin);

    const observed = await page.evaluate(async () => {
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      const bits = (value) => {
        view.setFloat64(0, value);
        return view.getBigUint64(0);
      };
      const hex = (value) => bits(value).toString(16).padStart(16, '0');
      const ulpDiff = (left, right) => {
        let a = bits(left);
        let b = bits(right);
        if (a < b) [a, b] = [b, a];
        return Number(a - b);
      };
      const ulpFrom = (value, target) => ulpDiff(value, target);

      const constants = {
        PI: hex(Math.PI),
        E: hex(Math.E),
        LN2: hex(Math.LN2),
        SQRT2: hex(Math.SQRT2)
      };

      const exact = {
        sqrt4: Math.sqrt(4),
        pow2_10: Math.pow(2, 10),
        pow3_0: Math.pow(3, 0),
        imulWrap: Math.imul(0xffffffff, 5),
        clz32One: Math.clz32(1),
        clz32Zero: Math.clz32(0),
        hypot34: Math.hypot(3, 4),
        cbrt27: Math.cbrt(27),
        exp0: Math.exp(0),
        log1: Math.log(1),
        log2Eight: Math.log2(8),
        sin0: Math.sin(0),
        cos0: Math.cos(0),
        tan0: Math.tan(0),
        froundThird: Math.fround(1 / 3),
        sqrt2SquaredUlp: ulpFrom(Math.sqrt(2) * Math.sqrt(2), 2),
        asin1Ulp: ulpFrom(Math.asin(1), Math.PI / 2),
        atan2PiUlp: ulpFrom(Math.atan2(0, -1), Math.PI),
        log10ThousandUlp: ulpFrom(Math.log10(1000), 3),
        log1pRelativeError: Math.abs(Math.log1p(1e-10) / 1e-10 - 1),
        expm1RelativeError: Math.abs(Math.expm1(1e-10) / 1e-10 - 1)
      };

      const samples = [];
      for (let index = 1; index <= 16; index++) samples.push(index / 17);
      const violations = { sinCos: [], expLog: [], powSquare: [], hypot: [], atan2: [] };
      for (const x of samples) {
        const s = Math.sin(x);
        const c = Math.cos(x);
        if (ulpFrom(s * s + c * c, 1) > 4) violations.sinCos.push(x);
        const logExp = Math.exp(Math.log(x));
        if (ulpFrom(logExp, x) > 8) violations.expLog.push(x);
        if (ulpFrom(Math.pow(x, 2), x * x) > 2) violations.powSquare.push(x);
        const y = 1 - x;
        if (ulpFrom(Math.hypot(x, y), Math.sqrt(x * x + y * y)) > 8) violations.hypot.push(x);
        if (ulpFrom(Math.atan2(s, c), x) > 8) violations.atan2.push(x);
      }

      const integral = (fn, from, to, steps) => {
        const step = (to - from) / steps;
        let sum = 0.5 * (fn(from) + fn(to));
        for (let index = 1; index < steps; index++) sum += fn(from + index * step);
        return sum * step;
      };
      const integrals = {
        sinPi: integral(Math.sin, 0, Math.PI, 10_000),
        expOne: integral(Math.exp, 0, 1, 10_000),
        sqrtOne: integral(Math.sqrt, 0, 1, 10_000)
      };

      const table = [];
      const snapshot = () => {
        const rows = [];
        for (let index = 0; index < 32; index++) {
          const x = 0.05 + index * 0.03;
          rows.push(
            `${hex(Math.sin(x))}:${hex(Math.cos(x))}:${hex(Math.exp(x))}:${hex(Math.log(x + 1))}:${hex(Math.atan2(x, 1))}`
          );
        }
        return rows.join('|');
      };
      const first = snapshot();
      const second = snapshot();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const third = snapshot();

      const probesForNan = [Math.sin(1), Math.cos(1), Math.exp(1), Math.log(2), Math.pow(2, 0.5), Math.atan2(1, 2)];
      return {
        constants,
        exact,
        violations,
        integrals: {
          sinPi: Number(integrals.sinPi.toFixed(12)),
          expOne: Number(integrals.expOne.toFixed(12)),
          sqrtOne: Number(integrals.sqrtOne.toFixed(12))
        },
        deterministic: first === second && second === third,
        snapshotDigest: hex(Math.sin(first.length) + first.length),
        nanFree: probesForNan.every((value) => typeof value === 'number' && !Number.isNaN(value))
      };
    });

    rec.expect(
      'math/constants-exact',
      observed.constants.PI === '400921fb54442d18' &&
        observed.constants.E === '4005bf0a8b145769' &&
        observed.constants.LN2 === '3fe62e42fefa39ef' &&
        observed.constants.SQRT2 === '3ff6a09e667f3bcd',
      observed.constants
    );

    const e = observed.exact;
    rec.expect(
      'math/exact-results',
      e.sqrt4 === 2 &&
        e.pow2_10 === 1024 &&
        e.pow3_0 === 1 &&
        e.imulWrap === -5 &&
        e.clz32One === 31 &&
        e.clz32Zero === 32 &&
        e.hypot34 === 5 &&
        e.cbrt27 === 3 &&
        e.exp0 === 1 &&
        e.log1 === 0 &&
        e.log2Eight === 3 &&
        e.sin0 === 0 &&
        e.cos0 === 1 &&
        e.tan0 === 0 &&
        e.froundThird === 0.3333333432674408 &&
        e.sqrt2SquaredUlp <= 2 &&
        e.asin1Ulp <= 1 &&
        e.atan2PiUlp <= 1 &&
        e.log10ThousandUlp <= 4 &&
        e.log1pRelativeError < 1e-8 &&
        e.expm1RelativeError < 1e-8,
      e
    );

    const bound = (name, list, key) => {
      if (list.length === 0) rec.expect(name, true);
      else rec.expect(name, false, { key, failures: list });
    };
    bound('math/sin-cos-identity', observed.violations.sinCos, 'x');
    bound('math/exp-log-identity', observed.violations.expLog, 'x');
    bound('math/pow-square-identity', observed.violations.powSquare, 'x');
    bound('math/hypot-identity', observed.violations.hypot, 'x');
    bound('math/atan2-identity', observed.violations.atan2, 'x');

    const target = { sinPi: 2, expOne: Math.E - 1, sqrtOne: 2 / 3 };
    const accuracy = observed.integrals;
    rec.expect(
      'math/integral-accuracy',
      Math.abs(accuracy.sinPi - target.sinPi) < 1e-6 &&
        Math.abs(accuracy.expOne - target.expOne) < 1e-6 &&
        Math.abs(accuracy.sqrtOne - target.sqrtOne) < 1e-6,
      accuracy
    );
    rec.expect('math/deterministic-across-frames', observed.deterministic === true);
    rec.expect('math/no-nan-leaks', observed.nanFree === true);

    return finish(rec, {
      constants: observed.constants,
      exact: observed.exact,
      violations: observed.violations,
      integrals: observed.integrals,
      deterministic: observed.deterministic,
      target
    });
  }
};

export const probes = [probe].map((entry) => ({
  ...entry,
  timeoutMs: entry.timeoutMs ?? entry.budgetMs,
  contextOptions: entry.contextOptions ?? {}
}));
