// The jest matchers reconcile.test.js uses, on node:assert, so the tests run with `node --test` and no install.
const assert = require("node:assert");

function matchesObject(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchesObject(actual[i], e));
  }
  if (expected && typeof expected === "object") {
    return actual !== null && typeof actual === "object" && Object.keys(expected).every((k) => matchesObject(actual[k], expected[k]));
  }
  return Object.is(actual, expected);
}

function matchers(actual, negate) {
  const check = (pass, message) => assert.ok(negate ? !pass : pass, message);
  return {
    toBe: (expected) => check(Object.is(actual, expected), `expected ${JSON.stringify(actual)} ${negate ? "not " : ""}to be ${JSON.stringify(expected)}`),
    toEqual: (expected) => (negate ? assert.notDeepStrictEqual : assert.deepStrictEqual)(actual, expected),
    toBeUndefined: () => check(actual === undefined, `expected ${JSON.stringify(actual)} ${negate ? "not " : ""}to be undefined`),
    toContain: (item) => check(actual.includes(item), `expected ${JSON.stringify(actual)} ${negate ? "not " : ""}to contain ${JSON.stringify(item)}`),
    toHaveLength: (length) => check(actual.length === length, `expected length ${actual.length} ${negate ? "not " : ""}to be ${length}`),
    toMatchObject: (expected) => check(matchesObject(actual, expected), `expected ${JSON.stringify(actual)} ${negate ? "not " : ""}to match ${JSON.stringify(expected)}`),
    toThrow: (pattern) => (negate ? assert.doesNotThrow(actual) : assert.throws(actual, pattern)),
  };
}

function expect(actual) {
  return {
    ...matchers(actual, false),
    not: matchers(actual, true),
    rejects: { toThrow: (pattern) => assert.rejects(actual, pattern) },
  };
}

module.exports = { expect };
